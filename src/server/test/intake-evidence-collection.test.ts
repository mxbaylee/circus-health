import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake, retainIntakeChildren } from '../intake.ts';
import { readIntakeEvidence, indexIntakeEvidence } from '../intake-evidence.ts';
import { evidenceSuppliedTarget } from '../intake-evidence-collection.ts';
import { readIntakeEnvelopeMaterialized } from '../intake-authority.ts';
import {
  memoryRecordAuthority,
  writeIntakeFixtureEnvelope,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import {
  getIntakeSourceText,
  intakeSourceTextInterpretationRevisionId,
} from '../intake-source-text.ts';
import { buildVerifiedWorkflowSummary } from '../intake-workflow-state.ts';
import { navigateCollectionEvidence } from '../intake-evidence-navigation.ts';
import { navigateIntakeEvidence } from '../intake-evidence.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-bounded-evidence-')),
    profileId = 'cookie-dough';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const parent = uploadIntake(db, root, profileId, {
    filename: 'fictional-container.txt',
    newProviderName: 'Fictional provider',
    bytes: Buffer.from('Fictional retained container'),
  });
  const [child, sibling] = retainIntakeChildren(db, root, profileId, parent.id, [
    {
      filename: 'page.html',
      locator: 'fictional HTML',
      bytes: Buffer.from(
        '<html><body><a href="notes.txt">Fictional note</a><p>Fictional 1.00 mg</p></body></html>',
      ),
    },
    {
      filename: 'notes.txt',
      locator: 'fictional note',
      bytes: Buffer.from('Fictional exact note'),
    },
  ]);
  for (const id of [parent.id, child!.id]) {
    const previous = readIntakeEnvelopeMaterialized(db, { id }).value;
    writeIntakeFixtureEnvelope(db, id, {
      ...previous,
      intake: {
        ...(previous.intake as object),
        workflow: {
          format: 'health-intake-workflow-v1',
          candidates: [],
          plans: [],
          decisions: [],
          questions: [],
          operations: Array.from({ length: 65 }, (_, i) => ({
            id: 'operation-' + i,
            at: '2026-01-01',
            fingerprint: 'fictional-' + i,
          })),
        },
      },
    });
  }
  return { db, root, profileId, parent, child: child!, sibling: sibling! };
}
function unchangedHydrations(
  db: ReturnType<typeof openDatabase>,
  before: ReturnType<typeof intakeWorkCounters>['warm'],
) {
  const after = intakeWorkCounters(db).warm;
  assert.equal(after.materializationReads, before.materializationReads);
  assert.equal(after.sourceDTOHydrations, before.sourceDTOHydrations);
  assert.equal(after.envelopeHydrations, before.envelopeHydrations);
}

test('paged evidence reads retained legacy and selected native child originals without hydrating history', async (t) => {
  const f = fixture(t);
  clearIntakeStateCache(f.db);
  let before = { ...intakeWorkCounters(f.db).warm };
  const legacy = await readIntakeEvidence({
    ...f,
    id: f.child.id,
    pagedContext: true,
    modelContext: true,
    captureSourceText: false,
  });
  assert.ok('intake' in legacy && 'original' in legacy);
  assert.equal(legacy.intake.format, 'health-intake-model-evidence-pending-v1');
  assert.ok(
    'text' in legacy.original && String(legacy.original.text).includes('Fictional 1.00 mg'),
  );
  unchangedHydrations(f.db, before);
  await buildIntakeCollectionEnvelope(f.db, { id: f.child.id });
  clearIntakeStateCache(f.db);
  before = { ...intakeWorkCounters(f.db).warm };
  const selected = await readIntakeEvidence({
    ...f,
    id: f.child.id,
    pagedContext: true,
    modelContext: true,
    captureSourceText: false,
  });
  assert.ok('intake' in selected);
  assert.equal(selected.intake.format, 'health-intake-model-evidence-context-v2');
  assert.ok(!('workflow' in selected.intake));
  unchangedHydrations(f.db, before);
});

test('native HTML supplied-target lookup preserves sibling precedence and JSON last duplicate names without parent hydration', async (t) => {
  const f = fixture(t);
  registerRawIntakeFixture(
    f.db,
    'fictional-raw-alias',
    JSON.stringify({
      intake: { originalName: 'wrong.txt', parentSourceFileId: f.parent.id, version: 1 },
    }).replace('"parentSourceFileId"', '"originalName":"last-name.txt","parentSourceFileId"'),
  );
  clearIntakeStateCache(f.db);
  const before = { ...intakeWorkCounters(f.db).warm };
  const lookup = evidenceSuppliedTarget(f.db, f.root, f.profileId, f.child.id);
  assert.deepEqual(lookup('notes.txt'), { id: f.sibling.id });
  assert.deepEqual(lookup('last-name.txt'), { id: 'fictional-raw-alias' });
  assert.equal(lookup('wrong.txt'), undefined);
  const indexed = await indexIntakeEvidence({ ...f, id: f.child.id, pagedContext: true });
  assert.equal(indexed.references?.[0]?.sourceFileId, f.sibling.id);
  unchangedHydrations(f.db, before);
});

test('paged automatic source capture precedes the returned pin and respects retain-only policy', async (t) => {
  const f = fixture(t),
    transitions: unknown[] = [];
  clearIntakeStateCache(f.db);
  const result = await readIntakeEvidence({
    ...f,
    id: f.child.id,
    pagedContext: true,
    modelContext: true,
    onSourceTextCaptured: (transition) => transitions.push(transition),
  });
  assert.ok('sourceText' in result);
  assert.equal(
    result.sourceText.revisionId,
    getIntakeSourceText(f.db, f.root, f.profileId, f.child.id).revision?.id,
  );
  assert.equal(transitions.length, 1);
  const beforeRevisionRead = { ...intakeWorkCounters(f.db).warm };
  assert.equal(
    intakeSourceTextInterpretationRevisionId(f.db, f.profileId, f.child.id),
    result.sourceText.revisionId,
  );
  unchangedHydrations(f.db, beforeRevisionRead);
  const retained = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional.dcm',
    bytes: Buffer.from('Fictional opaque source'),
  });
  await assert.rejects(
    readIntakeEvidence({
      ...f,
      id: retained.id,
      pagedContext: true,
      modelContext: true,
      captureSourceText: false,
    }),
    { code: 'INTAKE_RETAIN_ONLY' },
  );
});

test('native navigation pages complete selected sections, preserves duplicate-anchor ambiguity, and rejects stale or foreign cursors', async (t) => {
  const f = fixture(t),
    source = { id: f.child.id };
  const previous = readIntakeEnvelopeMaterialized(f.db, source).value;
  writeIntakeFixtureEnvelope(f.db, f.child.id, {
    ...previous,
    intake: {
      ...(previous.intake as object),
      workflow: {
        format: 'health-intake-workflow-v1',
        candidates: [],
        questions: [],
        decisions: [],
        plans: [
          {
            id: 'plan',
            status: 'active',
            units: [],
            batches: [],
            index: {
              kind: 'html',
              sections: Array.from({ length: 17 }, (_, i) => ({
                id: 'section-' + i,
                locator: 'fictional section ' + i,
                start: 0,
                end: 200,
              })),
              references: [
                { id: 'self-reference', sourceFileId: f.child.id, fragment: 'same' },
                { id: 'external', source: 'https://never.example/' },
              ],
              anchors: [
                { name: 'same', start: 0, locator: 'first anchor' },
                { name: 'same', start: 10, locator: 'second anchor' },
              ],
            },
          },
        ],
      },
    },
  });
  await buildIntakeCollectionEnvelope(f.db, source);
  const context = { ...f, id: f.child.id };
  const pending = await navigateCollectionEvidence(context, {
    format: 'health-intake-navigation-request-v2',
    action: 'search',
    query: 'fictional',
  });
  assert.ok('state' in pending);
  assert.equal(pending.state, 'pending');
  await buildVerifiedWorkflowSummary(f.db, source, {
    mappingVersion: 'fictional',
    isSourceContextVersion: () => false,
  });
  clearIntakeStateCache(f.db);
  const before = { ...intakeWorkCounters(f.db).warm };
  let cursor: string | undefined,
    matches = 0,
    calls = 0;
  do {
    const result = await navigateCollectionEvidence(context, {
      format: 'health-intake-navigation-request-v2',
      action: 'search',
      query: 'fictional',
      cursor,
    });
    assert.ok('results' in result);
    assert.ok(result.scannedSections <= 8);
    matches += result.results.length;
    calls++;
    if (calls === 1)
      await assert.rejects(
        navigateCollectionEvidence(context, {
          format: 'health-intake-navigation-request-v2',
          action: 'search',
          query: 'different',
          cursor: result.nextCursor!,
        }),
        { code: 'NAVIGATION_CHANGED' },
      );
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(matches, 17);
  assert.equal(calls, 3);
  const followed = await navigateCollectionEvidence(context, {
    format: 'health-intake-navigation-request-v2',
    action: 'follow',
    referenceId: 'self-reference',
  });
  assert.ok('reason' in followed);
  assert.equal(followed.reason, 'Ambiguous duplicate anchor');
  await assert.rejects(
    navigateCollectionEvidence(context, {
      format: 'health-intake-navigation-request-v2',
      action: 'follow',
      referenceId: 'foreign',
    }),
    { code: 'REFERENCE_NOT_FOUND' },
  );
  await assert.rejects(
    navigateIntakeEvidence({
      ...context,
      pagedContext: true,
      action: 'search',
      query: 'fictional',
      offset: 8,
    }),
    { code: 'NAVIGATION_CURSOR' },
  );
  unchangedHydrations(f.db, before);
});
