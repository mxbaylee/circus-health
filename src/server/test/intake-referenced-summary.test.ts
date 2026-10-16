import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { openDatabase, transaction } from '../database.ts';
import { attachRecordDurability } from '../record-versions.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import {
  encodeIntakeReferencedEnvelope,
  INTAKE_REFERENCED_ENVELOPE_FORMAT,
} from '../intake-compact-envelope.ts';
import { openVault } from '../vault-store.ts';
import { freshKey } from '../vault-crypto.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import { clearIntakeStateCache, createIntakeStateStorage } from '../intake-state-storage.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { prepareIntakeFilenameSummary } from '../intake-summary-name.ts';
import {
  captureReferencedEnvelopeRead,
  closeReferencedEnvelopeRead,
  referencedEnvelopeCurrentField,
  referencedEnvelopeCurrentSummaryStructure,
  referencedEnvelopeCurrentView,
} from '../intake-referenced-envelope-access.ts';
import { handleIntakeRoute } from '../intake-routes.ts';
import { parseSchemaControl } from '../intake-envelope-schema.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import type { IntakeFilenameFragment, IntakeSummaryV3 } from '../../shared/intake-summary.ts';

/** One fictional native original whose selected source row is a referenced V3
 * descriptor, read only through the public GET and filename-fragment routes. */
async function referencedFixture(
  t: TestContext,
  intake: Record<string, unknown>,
  options: { mimeType?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-referenced-summary-')),
    profileId = 'fictional-referenced-summary',
    intakeId = 'fictional-referenced-summary-intake',
    paths = ensureProfileDirectories(root, profileId),
    key = freshKey(),
    vault = openVault({ directory: paths.root, profileId, key, initialize: true }),
    db = openDatabase(paths.database, profileId);
  t.after(() => {
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    vault.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  });
  attachRecordDurability(db, { profileId, storage: vault.recordStorage() });
  const original = Buffer.from('Independently fictional referenced summary original.'),
    sourceHash = createHash('sha256').update(original).digest('hex'),
    path = profilePaths(root, profileId).relativeRoot + '/sources/fictional.pdf',
    identity = { profileId, intakeId, sourceHash };
  writeFileSync(join(root, path), original);
  vault.storeFile(path, original);
  vault.publish();
  const initial = prepareInitialIntakeEnvelope({
    intake: { version: 1, state: 'ready', createdAt: '2026-01-02T03:04:05.000Z', ...intake },
  });
  transaction(db, () => {
    db.prepare('INSERT INTO providers(id,name) VALUES(?,?)').run(
      'Fictional Provider',
      'Independently fictional provider',
    );
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,mime_type,provider_id,details_json) VALUES(?,?,?,?,?,?,?,?)',
    ).run(
      intakeId,
      path,
      sourceHash,
      original.length,
      'intake_original',
      options.mimeType ?? 'application/pdf',
      'Fictional Provider',
      initial.detailsJson,
    );
    createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
  });
  await buildIntakeCollectionEnvelope(db, { id: intakeId, sha256: sourceHash });
  await prepareIntakeFilenameSummary(db, { id: intakeId, sha256: sourceHash });
  const collections = selectedEnvelopeStore(db, { id: intakeId, sha256: sourceHash }).collections,
    before = collections.binding(collections.openView())!,
    mode = parseSchemaControl(
      collections.get(collections.openView(), 'logical', 'envelope.control', 'representation'),
    ).mode;
  assert.ok(before.logical.root);
  const descriptor = encodeIntakeReferencedEnvelope({
    intakeAuthority: {
      format: INTAKE_REFERENCED_ENVELOPE_FORMAT,
      identity,
      mode,
      storageSequence: before.storageSequence,
      logicalRoot: before.logical.root,
      sourceLabel: { kind: 'missing' },
    },
  });
  transaction(db, () => {
    db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(descriptor, intakeId);
    db.prepare('UPDATE app_meta SET value=value WHERE key=?').run(
      intakeNamespace(identity) + 'head',
    );
  });
  const route = async (input: {
    action?: string;
    method: 'GET' | 'POST';
    body?: unknown;
  }): Promise<unknown> => {
    let response: unknown;
    assert.equal(
      await handleIntakeRoute({
        resource: 'intakes',
        id: intakeId,
        action: input.action,
        method: input.method,
        params: new URLSearchParams(),
        req: Object.assign(new IncomingMessage(new Socket()), {
          headers: { 'content-type': 'application/json' },
        }),
        db,
        root,
        profileId,
        respond: (value) => {
          response = value;
        },
        list: () => assert.fail('unexpected list'),
        body: async () => Buffer.from(JSON.stringify(input.body ?? {})),
        assistant: {} as never,
      }),
      true,
    );
    return response;
  };
  const sourceVersionId = String(
    db
      .prepare('SELECT version_id FROM __record_current WHERE entity=? AND record_id=?')
      .get('source_files', JSON.stringify([intakeId]))!.version_id,
  );
  return { db, intakeId, identity, sourceVersionId, route };
}

test('referenced summary structural read closes one owner window around unchanged counts', async (t) => {
  const fixture = await referencedFixture(t, {
    originalName: 'fictional-counts.pdf',
    metadata: { source: null, careArea: null, documentType: null, topics: [] },
    workflow: {
      format: 'health-intake-workflow-v1',
      candidates: [{ id: 'fictional-candidate', versions: [] }],
      questions: [],
      plans: [],
      reportGroups: [],
    },
  });
  let checks = 0;
  let rewriteAt = 0;
  let rewritten = false;
  let canceled = false;
  const scope = await captureReferencedEnvelopeRead(
    fixture.db,
    fixture.identity,
    fixture.sourceVersionId,
    () => {
      if (canceled) throw Error('Fictional summary cancelled');
      checks++;
      if (rewriteAt && checks === rewriteAt) {
        rewritten = true;
        transaction(fixture.db, () => {
          fixture.db
            .prepare('UPDATE app_meta SET value=value WHERE key=?')
            .run(intakeNamespace(fixture.identity) + 'head');
        });
      }
    },
    'current',
  );
  try {
    const work = createRecordVersionWorkCounters();
    await withRecordVersionWork(work, async () => {
      const before = work.operation.headReadCalls;
      const view = referencedEnvelopeCurrentView(scope),
        intake = view.child(view.root(), 'intake'),
        workflow = intake && view.child(intake, 'workflow');
      assert.ok(intake);
      referencedEnvelopeCurrentField(scope, 'intake.state');
      referencedEnvelopeCurrentField(scope, 'intake.createdAt');
      referencedEnvelopeCurrentField(scope, 'intake.parentSourceFileId');
      for (const [record, names] of [
        [intake, ['proposals', 'importHistory', 'packageFailures']],
        [workflow, ['reportGroups', 'candidates', 'questions', 'plans']],
      ] as const)
        for (const name of names) {
          if (record && view.has(record, name)) view.child(record, name);
          if (record) view.childCount(record, name);
        }
      const ordinaryReads = work.operation.headReadCalls - before;
      const optimizedBefore = work.operation.headReadCalls;
      const structure = referencedEnvelopeCurrentSummaryStructure(scope);
      const optimizedReads = work.operation.headReadCalls - optimizedBefore;
      assert.equal(structure.state, 'ready');
      assert.equal(structure.counts.proposals, 0);
      assert.equal(structure.counts.candidates, 1);
      assert.ok(optimizedReads > 0, 'closing owner proof still reads the selected HEAD');
      assert.ok(
        optimizedReads < ordinaryReads,
        `structural span reduces actual HEAD reads (${optimizedReads} < ${ordinaryReads})`,
      );
    });
    canceled = true;
    try {
      assert.throws(() => referencedEnvelopeCurrentSummaryStructure(scope), /summary cancelled/);
    } finally {
      canceled = false;
    }
    checks = 0;
    referencedEnvelopeCurrentSummaryStructure(scope);
    rewriteAt = checks;
    checks = 0;
    assert.throws(() => referencedEnvelopeCurrentSummaryStructure(scope));
    assert.equal(rewritten, true, 'same-byte selected HEAD changed inside the structural span');
  } finally {
    if (rewritten) assert.throws(() => closeReferencedEnvelopeRead(scope));
    else closeReferencedEnvelopeRead(scope);
  }
});

test('public V3 summary presents giant BOM/NUL Unicode names compactly with exact fragments and accepted metadata', async (t) => {
  const prefix = '﻿fictional-\u0000-';
  const name =
    prefix +
    'x'.repeat(4096 - Buffer.byteLength(JSON.stringify(prefix)) + 1) +
    '\ufeff' +
    '🌿'.repeat(6000) +
    '\u0000.pdf';
  const metadata = {
    source: 'Fictional Clinic',
    sourceProviderId: 'Fictional Provider',
    careArea: 'Fictional care',
    documentType: 'Fictional report',
    topics: ['fictional-topic', '﻿fictional\u0000topic'],
  };
  const fixture = await referencedFixture(t, {
    originalName: name,
    metadata,
    acquisition: { providerId: 'Fictional Provider', provider: 'Independently fictional provider' },
  });
  const summary = (await fixture.route({ method: 'GET' })) as IntakeSummaryV3;
  assert.equal(summary.format, 'health-intake-summary-v3');
  assert.equal(summary.retainOnly, false);
  assert.equal(summary.packageSource, false);
  // The giant name is never coerced into a display string or a serialized summary.
  assert.equal(summary.filename, undefined);
  assert.equal(summary.filenameTruncated, true);
  assert.ok(summary.filenamePreview.startsWith('﻿fictional-\u0000-'));
  assert.ok(summary.filenamePreview.length <= 240);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 16 * 1024);
  assert.equal('mimeType' in summary, false);
  assert.equal('providerId' in summary, false);
  // Accepted current metadata and acquisition are exact when they fit the field budget.
  assert.equal(summary.metadataState, 'complete');
  assert.deepEqual(summary.metadata, metadata);
  assert.deepEqual(summary.acquisition, {
    state: 'exact',
    providerId: { kind: 'value', value: 'Fictional Provider' },
    provider: 'Independently fictional provider',
  });
  assert.deepEqual(summary.source.mimeType, { kind: 'value', value: 'application/pdf' });
  assert.deepEqual(summary.source.mimePredicates, {
    pdf: true,
    image: false,
    previewableImage: false,
    packageMime: false,
  });
  // Selections outside the accepted envelope are not claimed.
  assert.deepEqual(summary.review, { state: 'pending', counts: null });
  assert.deepEqual(summary.activePlan, { state: 'pending', plan: null });
  assert.deepEqual(summary.source.providerName, { state: 'unloaded' });
  // The exact source-bound fragments reproduce the BOM, NUL and astral scalars.
  const reference = summary.filenameReference;
  assert.equal(reference.format, 'health-intake-filename-reference-v2');
  const pages: string[] = [];
  let cursor: string | undefined;
  for (let count = 0; ; count++) {
    assert.ok(count < 64, 'bounded fragment count');
    const page = (await fixture.route({
      method: 'POST',
      action: 'filename-fragment',
      body: { reference, cursor, limit: 4096 },
    })) as IntakeFilenameFragment;
    assert.deepEqual(page.reference, reference);
    assert.ok(Buffer.byteLength(page.text) <= 4096);
    pages.push(page.text);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(pages.join(''), JSON.stringify(name));
  assert.equal(JSON.parse(pages.join('')), name);
  // A reference from another selection is refused rather than served.
  await assert.rejects(
    fixture.route({
      method: 'POST',
      action: 'filename-fragment',
      body: { reference: { ...reference, scalarHash: '0'.repeat(64) }, limit: 4096 },
    }),
    { code: 'INTAKE_FILENAME_CHANGED' },
  );
});

test('public V3 summary leaves giant accepted metadata and acquisition unloaded instead of refusing', async (t) => {
  const giant = '﻿' + 'Fictional Clinic \u0000 ' + 'ü'.repeat(12_000);
  const fixture = await referencedFixture(t, {
    originalName: 'fictional-small.pdf',
    metadata: { source: giant, careArea: null, documentType: null, topics: [] },
    acquisition: { providerId: 'Fictional Provider', provider: giant },
  });
  const summary = (await fixture.route({ method: 'GET' })) as IntakeSummaryV3;
  assert.equal(summary.format, 'health-intake-summary-v3');
  assert.equal(summary.filename, 'fictional-small.pdf');
  assert.equal(summary.metadataState, 'unloaded');
  assert.equal(summary.metadata, undefined);
  assert.deepEqual(summary.acquisition, { state: 'unloaded' });
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 16 * 1024);
});

test('public V3 summary keeps absent metadata exact and absent acquisition unloaded', async (t) => {
  const fixture = await referencedFixture(t, { originalName: 'fictional-plain.pdf' });
  const summary = (await fixture.route({ method: 'GET' })) as IntakeSummaryV3;
  assert.equal(summary.metadataState, 'complete');
  assert.deepEqual(summary.metadata, {
    source: null,
    careArea: null,
    documentType: null,
    topics: [],
  });
  // The fallback acquisition is the provider row, which this scope does not prove.
  assert.deepEqual(summary.acquisition, { state: 'unloaded' });
});
