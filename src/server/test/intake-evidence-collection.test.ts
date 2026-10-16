import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake, retainIntakeChildren, ensureNativeIntakeSchema } from '../intake.ts';
import { readIntakeEvidence, indexIntakeEvidence } from '../intake-evidence.ts';
import {
  evidenceSuppliedTarget,
  evidenceRelativeSuppliedTarget,
  exactEvidenceInventoryMember,
} from '../intake-evidence-collection.ts';
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
import { zipFixture } from '../../tests/fixtures/zip.ts';
import { buildDurablePackageInventory } from '../intake-package-state.ts';
import { evidenceRelativeFilename } from '../intake-evidence-filename.ts';

test('inventory UTF8 buckets skip surrogate replacement decoys before an exact canonical name', () => {
  const candidates = [
    { id: 'fictional-replacement-decoy', filename: 'fictional-\ufffd/notes.txt' },
    { id: 'fictional-low-decoy', filename: 'fictional-\udfff/notes.txt' },
    { id: 'fictional-exact', filename: 'fictional-\ud800/notes.txt' },
  ];
  const name = evidenceRelativeFilename([JSON.stringify('fictional-\ud800/report.html')], () => {});
  try {
    const target = name.resolve('notes.txt');
    for (const candidate of candidates)
      assert.equal(
        Buffer.from(candidate.filename).toString('hex'),
        Buffer.from(candidates[0]!.filename).toString('hex'),
      );
    assert.equal(exactEvidenceInventoryMember(candidates, target.hash)?.id, 'fictional-exact');
    assert.equal(exactEvidenceInventoryMember(candidates.slice(0, 2), target.hash), undefined);
  } finally {
    name.close();
  }
});

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

test('long-directory HTML references use exact raw and compact sibling names and refuse root decoys', async (t) => {
  const f = fixture(t),
    directory = 'fictional-\ud800' + 'x'.repeat(17000) + '\udfff';
  const [report, sibling] = retainIntakeChildren(f.db, f.root, f.profileId, f.parent.id, [
    {
      filename: directory + '/report.html',
      locator: 'fictional long directory report',
      bytes: Buffer.from(
        '<html><body><a href="notes.txt">Fictional note</a><a href="missing.txt">Absent sibling</a><a href="#here">Same report</a></body></html>',
      ),
    },
    {
      filename: directory + '/notes.txt',
      locator: 'fictional exact long directory note',
      bytes: Buffer.from('Fictional exact sibling'),
    },
    {
      filename: directory.replace(/[\ud800\udfff]/g, '\ufffd') + '/notes.txt',
      locator: 'fictional replacement-character decoy',
      bytes: Buffer.from('Fictional different Unicode directory'),
    },
    {
      filename: 'notes.txt',
      locator: 'fictional root note decoy',
      bytes: Buffer.from('Fictional unrelated root note'),
    },
    {
      filename: 'missing.txt',
      locator: 'fictional root missing decoy',
      bytes: Buffer.from('Fictional unrelated root missing'),
    },
  ]);
  await ensureNativeIntakeSchema(f.db, f.profileId, report!.id);
  await assert.rejects(
    indexIntakeEvidence({
      ...f,
      id: report!.id,
      pagedContext: true,
      assertRunning: () => {
        throw Error('Fictional navigation cancelled');
      },
    }),
    /navigation cancelled/,
  );
  let checks = 0;
  await assert.rejects(
    indexIntakeEvidence({
      ...f,
      id: report!.id,
      pagedContext: true,
      assertRunning: () => {
        if (++checks === 8) throw Error('Fictional filename preparation cancelled');
      },
    }),
    /preparation cancelled/,
  );
  for (const compact of [false, true]) {
    if (compact) await ensureNativeIntakeSchema(f.db, f.profileId, sibling!.id);
    clearIntakeStateCache(f.db);
    const initialBytes = intakeWorkCounters(f.db);
    const before = { ...intakeWorkCounters(f.db).warm };
    const indexed = await indexIntakeEvidence({ ...f, id: report!.id, pagedContext: true });
    assert.equal(indexed.references?.[0]?.sourceFileId, sibling!.id);
    assert.equal(indexed.references?.[1]?.status, 'not_supplied');
    assert.equal(indexed.references?.[1]?.sourceFileId, undefined);
    assert.equal(indexed.references?.[2]?.sourceFileId, report!.id);
    unchangedHydrations(f.db, before);
    const finalBytes = intakeWorkCounters(f.db);
    const readBytes =
      finalBytes.warm.collectionByteChunkReadBytes +
      finalBytes.reconstruction.collectionByteChunkReadBytes -
      initialBytes.warm.collectionByteChunkReadBytes -
      initialBytes.reconstruction.collectionByteChunkReadBytes;
    assert.ok(
      readBytes <= 4 * Buffer.byteLength(directory) + 65536,
      'exact directory reads stay within the selected name pages and fixed metadata overhead',
    );
  }
  const lookup = evidenceRelativeSuppliedTarget(f.db, f.root, f.profileId, report!.id);
  try {
    f.db.prepare('UPDATE source_files SET details_json=details_json WHERE id=?').run(report!.id);
    assert.throws(() => lookup.resolve('notes.txt'), /filename source changed/);
  } finally {
    lookup.close();
  }
});

test('long-directory references retain exact legacy and durable inventory lookup without root decoys', async (t) => {
  const f = fixture(t),
    directory = 'fictional-' + 'x'.repeat(17000),
    filename = directory + '/notes.txt';
  const parent = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-exact-inventory.zip',
    bytes: zipFixture([
      { name: filename, data: 'Fictional exact package note' },
      { name: 'notes.txt', data: 'Fictional root package note' },
      { name: 'missing.txt', data: 'Fictional root missing decoy' },
    ]),
  });
  const [report] = retainIntakeChildren(f.db, f.root, f.profileId, parent.id, [
    {
      filename: directory + '/report.html',
      locator: 'fictional inventory report',
      bytes: Buffer.from(
        '<html><body><a href="notes.txt">Fictional note</a><a href="missing.txt">Absent sibling</a></body></html>',
      ),
    },
  ]);
  const previous = readIntakeEnvelopeMaterialized(f.db, { id: parent.id }).value;
  writeIntakeFixtureEnvelope(f.db, parent.id, {
    ...previous,
    intake: {
      ...(previous.intake as object),
      workflow: {
        format: 'health-intake-workflow-v1',
        candidates: [],
        questions: [],
        reportGroups: [],
        plans: [
          {
            id: 'fictional-inventory-plan',
            status: 'active',
            index: {
              inventoryVersion: 1,
              members: [
                { memberId: 'fictional-exact-member', filename },
                { memberId: 'fictional-root-decoy', filename: 'notes.txt' },
                { memberId: 'fictional-missing-decoy', filename: 'missing.txt' },
              ],
            },
          },
        ],
      },
    },
  });
  await ensureNativeIntakeSchema(f.db, f.profileId, parent.id);
  await ensureNativeIntakeSchema(f.db, f.profileId, report!.id);
  await buildVerifiedWorkflowSummary(
    f.db,
    { id: parent.id },
    { mappingVersion: 'fictional', isSourceContextVersion: () => false },
  );
  const legacy = await indexIntakeEvidence({ ...f, id: report!.id, pagedContext: true });
  assert.equal(legacy.references?.[0]?.memberId, 'fictional-exact-member');
  assert.equal(legacy.references?.[1]?.status, 'not_supplied');
  const { inventory } = await buildDurablePackageInventory({
    ...f,
    id: parent.id,
    rawDomainVersion: 1,
  });
  const durable = await indexIntakeEvidence({ ...f, id: report!.id, pagedContext: true });
  assert.equal(durable.references?.[0]?.memberId, inventory.byExactName(filename)!.memberId);
  assert.equal(durable.references?.[1]?.status, 'not_supplied');
});

test('supplied-target lookup binds the last duplicate parent and preserves first sibling precedence', (t) => {
  const f = fixture(t),
    otherParent = 'fictional-other-parent';
  const register = (id: string, filename: string, first: string | null, last: string | null) =>
    registerRawIntakeFixture(
      f.db,
      id,
      JSON.stringify({
        intake: { originalName: filename, parentSourceFileId: first, version: 1 },
      }).replace('"version"', '"parentSourceFileId":' + JSON.stringify(last) + ',"version"'),
    );
  register('fictional-wrong-parent', 'wrong-parent.txt', f.parent.id, otherParent);
  register('fictional-right-parent', 'right-parent.txt', otherParent, f.parent.id);
  register('fictional-later-sibling', 'notes.txt', otherParent, f.parent.id);
  register('fictional-null-parent', 'null-parent.txt', f.parent.id, null);
  register('fictional-null-first', 'null-first.txt', null, f.parent.id);
  clearIntakeStateCache(f.db);
  const before = { ...intakeWorkCounters(f.db).warm },
    lookup = evidenceSuppliedTarget(f.db, f.root, f.profileId, f.child.id);
  assert.equal(lookup('wrong-parent.txt'), undefined);
  assert.deepEqual(lookup('right-parent.txt'), { id: 'fictional-right-parent' });
  assert.deepEqual(lookup('notes.txt'), { id: f.sibling.id });
  assert.equal(lookup('null-parent.txt'), undefined);
  assert.deepEqual(lookup('null-first.txt'), { id: 'fictional-null-first' });
  unchangedHydrations(f.db, before);
});

test('supplied-target lookup selects the last intake object before its parent and filename', (t) => {
  const f = fixture(t);
  for (const matches of [false, true]) {
    const id = 'fictional-duplicate-intake-' + matches,
      filename = 'duplicate-intake-' + matches + '.txt',
      first = JSON.stringify({
        version: 1,
        originalName: matches ? 'earlier.txt' : filename,
        parentSourceFileId: matches ? 'fictional-other-parent' : f.parent.id,
      }),
      last = JSON.stringify({
        version: 1,
        originalName: filename,
        parentSourceFileId: matches ? f.parent.id : 'fictional-other-parent',
      });
    registerRawIntakeFixture(f.db, id, '{"intake":' + first + ',"\\u0069ntake":' + last + '}');
  }
  registerRawIntakeFixture(
    f.db,
    'fictional-scalar-first',
    '{"intake":false,"intake":' +
      JSON.stringify({
        version: 1,
        originalName: 'scalar-first.txt',
        parentSourceFileId: f.parent.id,
      }) +
      '}',
  );
  clearIntakeStateCache(f.db);
  const before = { ...intakeWorkCounters(f.db).warm },
    lookup = evidenceSuppliedTarget(f.db, f.root, f.profileId, f.child.id);
  assert.equal(lookup('duplicate-intake-false.txt'), undefined);
  assert.deepEqual(lookup('duplicate-intake-true.txt'), { id: 'fictional-duplicate-intake-true' });
  assert.equal(lookup('earlier.txt'), undefined);
  assert.deepEqual(lookup('scalar-first.txt'), { id: 'fictional-scalar-first' });
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
