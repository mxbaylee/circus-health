import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';
import { rebuildRecordDatabase } from '../record-versions.ts';
import {
  uploadIntake,
  reviewIntake,
  reviewIntakeRead,
  workflowMutation,
  saveIntakeReviewDraftRead,
} from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { readReviewDraftHistoryPage } from '../intake-review-draft-state.ts';
import type { IntakeReviewDraft, IntakeReviewRecord } from '../../shared/intake.ts';
import { fictionalModel } from './fictional-model.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';

async function qualify(t: test.TestContext, size: number) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-draft-growth-')),
    profileId = 'fictional',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId),
    authority = memoryRecordAuthority(db),
    opened = [db];
  t.after(() => {
    for (const connection of opened) {
      clearIntakeStateCache(connection);
      connection.close();
    }
    rmSync(root, { recursive: true, force: true });
  });
  let acceptedBytes = 0,
    acceptedObjects = 0,
    headPublications = 0;
  const write = authority.storage.writeImmutable,
    publish = authority.storage.publishHead;
  authority.storage.writeImmutable = (name, bytes) => {
    acceptedBytes += bytes.length;
    acceptedObjects++;
    write(name, bytes);
  };
  authority.storage.publishHead = (bytes) => {
    acceptedBytes += bytes.length;
    headPublications++;
    publish(bytes);
  };
  const snapshot = () => ({
    acceptedBytes,
    acceptedObjects,
    headPublications,
    nodes: intakeWorkCounters(db).warm.collectionNodesWritten,
    nodeBytes: intakeWorkCounters(db).warm.collectionWrittenBytes,
    catalogChanges: intakeWorkCounters(db).warm.reportSnapshotCheckpointChanges,
    envelopeHydrations: intakeWorkCounters(db).warm.envelopeHydrations,
    sourceDTOHydrations: intakeWorkCounters(db).warm.sourceDTOHydrations,
  });
  const delta = (before: ReturnType<typeof snapshot>) =>
    Object.fromEntries(
      Object.entries(snapshot()).map(([key, value]) => [
        key,
        value - before[key as keyof typeof before],
      ]),
    ) as ReturnType<typeof snapshot>;
  const start = snapshot();
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(
      JSON.stringify({
        format: 'health-record-v1',
        id: 'record',
        kind: 'record',
        payload: { literal: 'Fictional document' },
        clinical: { kind: 'document', subject: 'self', documentTitle: 'Fictional history' },
        provenance: {
          sourceSystem: 'Fictional',
          sourceRecordId: 'record',
          capturedVia: null,
          evidenceClass: 'provider_export',
          locator: 'line 1',
        },
        coverage: { status: 'complete_response', notes: [] },
      }),
    ),
  });
  const original = reviewIntake(db, root, profileId, source.id).records[0]!;
  const draft: IntakeReviewDraft = {
    id: 'historical',
    proposalId: null,
    recordId: original.id,
    candidateId: original.candidateId!,
    candidateVersionId: original.candidateVersionId!,
    mapping: {},
    disposition: 'pending',
    at: '2026-01-01',
    resolutions: [],
    corrections: Array.from({ length: size }, (_, index) => ({
      operationId: 'old-' + index,
      at: '2026-01-01',
      reason: ('Fictional retained correction ' + index + ' 🌿 ').padEnd(2048, '.'),
      before: { documentTitle: 'Fictional prior ' + index },
      after: { documentTitle: 'Fictional corrected ' + index },
    })),
  };
  // One actual supported legacy write seeds the retained audit, without N autosaves.
  workflowMutation(
    db,
    root,
    profileId,
    source.id,
    { version: source.version, operationId: 'seed-history' },
    (flow) => {
      flow.reviewDrafts.push(draft);
    },
  );
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  const review = async (connection = db) => {
    const page = await reviewIntakeRead(connection, root, profileId, source.id);
    assert.ok('format' in page && page.format === 'health-intake-clinical-review-page-v2');
    if (
      !('format' in page) ||
      page.format !== 'health-intake-clinical-review-page-v2' ||
      page.items[0]?.kind !== 'value'
    )
      throw Error('Expected native review record');
    return { page, record: page.items[0].value as IntakeReviewRecord };
  };
  let current = await review();
  const seeded = delta(start),
    beforeConversion = snapshot();
  const command = (index: number) => ({
    version: current.page.version,
    operationId: 'native-save-' + index,
    proposalId: null,
    recordId: current.record.id,
    candidateVersionId: current.record.candidateVersionId!,
    mapping: { documentTitle: 'Fictional native ' + index },
    correctionPatch: { documentTitle: 'Fictional native ' + index },
    correctionReason: 'Fictional new correction',
    disposition: 'review_later' as const,
  });
  await saveIntakeReviewDraftRead(db, root, profileId, source.id, command(1));
  current = await review();
  const firstHistory = current.record.draft!.history!;
  assert.equal(firstHistory.corrections, size + 1);
  db.exec(`CREATE TEMP TABLE draft_growth_writes(key TEXT,value TEXT);
    CREATE TEMP TRIGGER draft_growth_insert AFTER INSERT ON main.app_meta
      BEGIN INSERT INTO draft_growth_writes VALUES(NEW.key,NEW.value); END;
    CREATE TEMP TRIGGER draft_growth_update AFTER UPDATE ON main.app_meta
      BEGIN INSERT INTO draft_growth_writes VALUES(NEW.key,NEW.value); END;`);
  const conversion = delta(beforeConversion),
    beforeWarm = snapshot(),
    next = command(2);
  const saved = await saveIntakeReviewDraftRead(db, root, profileId, source.id, next);
  const warm = delta(beforeWarm);
  // Counts alone could conceal a retained payload copy inside otherwise large
  // checkpoint overhead. Count existing bounded inline cells carried by AVL
  // path copies separately; unchanged native history byte leaves are shared.
  let retainedPayloadCopies = 0,
    retainedPayloadBytes = 0;
  const copiedCorrections = new Set<string>();
  for (const row of db.prepare('SELECT key,value FROM draft_growth_writes').all()) {
    const raw = String(row.value);
    if (!raw.startsWith('{')) continue;
    const node = JSON.parse(raw);
    if (node.format === 'health-intake-node-v4') {
      if (node.value.includes('Fictional retained correction')) {
        const cell = JSON.parse(node.value);
        assert.equal(cell.kind, 'inline', 'retained text is a bounded AVL cell');
        assert.ok(Buffer.byteLength(node.value) <= 8192);
        retainedPayloadCopies++;
        retainedPayloadBytes += Buffer.byteLength(node.value);
        for (const match of node.value.matchAll(/Fictional retained correction (\d+)/g))
          copiedCorrections.add(match[1]);
      }
      assert.ok(
        !Buffer.from(node.value, 'base64').toString().includes('Fictional retained correction'),
        'native autosave must reuse old correction byte leaves',
      );
    }
  }
  db.exec(
    'DROP TRIGGER draft_growth_insert; DROP TRIGGER draft_growth_update; DROP TABLE draft_growth_writes',
  );
  assert.equal(saved.version, next.version + 1);
  assert.equal(warm.envelopeHydrations, 0);
  assert.equal(warm.sourceDTOHydrations, 0);
  current = await review();
  const history = current.record.draft!.history!;
  assert.equal(history.corrections, size + 2);
  assert.equal(current.record.draft!.corrections!.length, 1);
  const exactHistory = (connection: typeof db, reference = history) => {
    const values: unknown[] = [];
    for (let offset = 0; offset < reference.corrections; offset += 8) {
      const page = readReviewDraftHistoryPage(connection, { id: source.id }, reference, {
        section: 'corrections',
        offset,
        limit: 8,
      });
      assert.equal(page.total, reference.corrections);
      values.push(
        ...page.items.map((entry) => {
          assert.ok('value' in entry);
          return 'value' in entry ? entry.value : undefined;
        }),
      );
    }
    return values;
  };
  const expected = exactHistory(db);
  assert.deepEqual(expected.slice(0, size), draft.corrections);
  assert.deepEqual(exactHistory(db, firstHistory), expected.slice(0, size + 1));
  const recoveredPath = join(root, 'recovered.sqlite');
  rebuildRecordDatabase(recoveredPath, { profileId, storage: authority.storage });
  const recovered = openDatabase(recoveredPath, profileId);
  opened.push(recovered);
  authority.attach(recovered);
  assert.deepEqual(exactHistory(recovered), expected);
  assert.deepEqual(exactHistory(recovered, firstHistory), expected.slice(0, size + 1));
  const beforeReplay = snapshot();
  const replay = await saveIntakeReviewDraftRead(recovered, root, profileId, source.id, next);
  assert.equal(replay.version, saved.version);
  assert.equal(
    delta(beforeReplay).acceptedBytes,
    0,
    'cache-loss replay writes no accepted objects',
  );
  assert.deepEqual((await review(recovered)).record.draft, current.record.draft);
  const retainedPaths = {
    retainedPayloadCopies,
    retainedPayloadBytes,
    distinctCopiedCorrections: copiedCorrections.size,
  };
  t.diagnostic(
    JSON.stringify({
      size,
      seeded,
      conversion,
      warm,
      retainedPaths,
      retainedCorrections: expected.length,
    }),
  );
  return { ...warm, ...retainedPaths };
}

test(
  'native draft autosave retains exact growing audit with bounded catalog and accepted-journal writes',
  { timeout: 120000 },
  async (t) => {
    fictionalModel(t);
    const small = await qualify(t, 8),
      large = await qualify(t, 128);
    // A sixteen-fold audit increase permits authenticated tree-path growth,
    // but not copying the complete retained history at the next autosave.
    for (const key of [
      'acceptedBytes',
      'acceptedObjects',
      'headPublications',
      'nodes',
      'nodeBytes',
    ] as const)
      assert.ok(large[key] <= small[key] * 3, `${key}: ${small[key]} -> ${large[key]}`);
    assert.equal(large.catalogChanges, small.catalogChanges);
    // Which retained inline keys act as separators depends on the changed
    // paths, so that subset has no fixed ratio to the small fixture. Its
    // measured copies must still cover less than half the large old corpus.
    assert.ok(large.distinctCopiedCorrections < 128 / 2);
    assert.ok(large.retainedPayloadBytes < (128 * 2048) / 2);
  },
);

test('tiny Unicode producer pieces coalesce into bounded leaves and publication checks', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-snapshot-coalescing-')),
    db = openDatabase(join(root, 'cache.sqlite'), 'fictional'),
    source = { id: 'fictional-source' };
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  registerRawIntakeFixture(
    db,
    source.id,
    JSON.stringify({
      intake: {
        version: 1,
        originalName: 'fictional.zip',
        workflow: { format: 'health-intake-workflow-v1', candidates: [] },
      },
    }),
  );
  await buildIntakeCollectionEnvelope(db, source);
  const catalog = createReportSnapshotCatalog(db, source),
    writer = await catalog.fork();
  const expected = 'a'.repeat(1023) + '🌿' + 'Ω'.repeat(19000) + '🌿';
  // Deliberately split both surrogate pairs at producer boundaries; the first
  // pair also crosses the 1,024-code-unit leaf boundary.
  function* pieces() {
    for (let at = 0; at < expected.length; at++) yield expected[at]!;
  }
  const beforeTiny = intakeWorkCounters(db).warm.collectionNodeReads;
  await writer.putText('text', pieces());
  const tiny = intakeWorkCounters(db).warm.collectionNodeReads - beforeTiny;
  const beforeWhole = intakeWorkCounters(db).warm.collectionNodeReads;
  await writer.putText('whole', [expected]);
  const whole = intakeWorkCounters(db).warm.collectionNodeReads - beforeWhole;
  t.diagnostic(
    JSON.stringify({
      textCodeUnits: expected.length,
      tinyPieceNodeReads: tiny,
      wholePieceNodeReads: whole,
    }),
  );
  assert.ok(
    tiny < expected.length,
    'selected-tree guards are batched, not repeated per producer code unit',
  );
  for (const key of ['text', 'whole']) {
    const value = writer.get(key);
    assert.ok(value && typeof value === 'object' && 'chunks' in value);
    assert.ok(value.chunks <= Math.ceil(expected.length / 1023) + 1);
    assert.equal([...writer.chunks(key)].join(''), expected);
  }
  await catalog.publish('retained', writer);
  await writer.putText('text', ['replacement']);
  assert.equal([...catalog.open('retained')!.chunks('text')].join(''), expected);
  const store = selectedEnvelopeStore(db, source).collections,
    id = randomUUID();
  const prepared = store.prepare(store.openView(), {
    operationId: id,
    requestDigest: createHash('sha256').update(id).digest('hex'),
    domainVersion: 1,
    changes: await catalog.finalChanges(),
  });
  transaction(db, () => store.stage(prepared));
  clearIntakeStateCache(db);
  assert.equal(
    [...createReportSnapshotCatalog(db, source).open('retained')!.chunks('text')].join(''),
    expected,
  );
});
