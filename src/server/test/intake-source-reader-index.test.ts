import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import {
  uploadIntake,
  createIntakePlan,
  createIntakePlanRead,
  submitIntakeBatch,
  submitIntakeBatchRead,
} from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { createPagedDirectPlan, readDirectPlanScope } from '../intake-direct-plan.ts';
import {
  prepareCollectionReaderCoverage,
  readCollectionReaderCoverage,
} from '../intake-source-reader-index.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { workflowHash } from '../intake-workflow.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import {
  memoryRecordAuthority,
  writeIntakeFixtureEnvelope,
} from './helpers/intake-authority-fixture.ts';
import { fictionalModel } from './fictional-model.ts';
import { isIntakeSummary } from '../../shared/intake-summary.ts';
import {
  getIntakeSourceText,
  publishIntakeSourceText,
  reviewIntakeSourceText,
} from '../intake-source-text.ts';

const context = JSON.stringify({
  format: 'health-record-v1',
  id: 'fictional-context',
  kind: 'context',
  payload: { text: 'Fictional note' },
  provenance: {
    capturedVia: null,
    sourceSystem: null,
    sourceRecordId: null,
    evidenceClass: 'transcription',
    locator: 'Fictional source',
  },
  coverage: { status: 'partial', notes: [] },
});
function fixture(t: test.TestContext, durable = false) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-reader-index-')),
    profileId = 'fictional-reader',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  if (durable) attachPersonalDurability(db, { root, profileId });
  else memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, db };
}
test('reader invalidation coalesces real source review UPSERTs and preserves rename and rollback boundaries', async (t) => {
  const { db, root, profileId } = fixture(t, true);
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-review.txt',
    bytes: Buffer.from('Fictional source value 1.00'),
  });
  const initial = publishIntakeSourceText(db, root, profileId, source.id, {
    operationId: randomUUID(),
    sourceHash: source.sha256,
    expectedRevisionId: null,
    evidence: {
      adapter: { name: 'fictional-native', version: '1' },
      pages: [{ page: 1, disposition: 'extracted', inspected: false }],
      spans: [
        {
          id: 'fictional-span',
          text: 'Fictional source value 1.00',
          region: { page: 1 },
          provenance: 'native',
        },
      ],
      relations: [],
      issues: [],
    },
  }).revision!;
  await buildIntakeCollectionEnvelope(db, source);
  await prepareCollectionReaderCoverage(db, root, profileId, source.id);
  const read = () => {
    const { assertCurrent, ...value } = readCollectionReaderCoverage(db, profileId, source.id, {
      offset: 0,
      limit: 1,
    });
    assertCurrent();
    return value;
  };
  const generation = () =>
    Number(
      db.prepare('SELECT generation FROM __intake_reader_control WHERE singleton=1').get()!
        .generation,
    );
  const dirty = () =>
    db
      .prepare('SELECT key FROM __intake_reader_dirty ORDER BY key')
      .all()
      .map((row) => String(row.key));
  const before = generation();
  const corrected = reviewIntakeSourceText(
    db,
    root,
    profileId,
    source.id,
    {
      operationId: randomUUID(),
      sourceHash: source.sha256,
      expectedRevisionId: initial.id,
      action: 'correct',
      scope: { page: 1 },
      spans: [{ ...initial.spans[0]!, text: 'Fictional source value 2.00' }],
      relations: [],
    },
    'fictional-owner',
  ).revision!;
  assert.equal(corrected.parentRevisionId, initial.id);
  assert.equal(
    getIntakeSourceText(db, root, profileId, source.id).revision!.spans[0]!.text,
    'Fictional source value 2.00',
  );
  assert.ok(
    generation() > before,
    'actual changed page/span/source pins invalidate the cached observations',
  );
  assert.throws(read, { code: 'READER_COVERAGE_PENDING' });
  const pageKey = 'intake_source_page_hash:v1:' + source.id + ':1';
  assert.equal(dirty().filter((key) => key === 'meta:' + pageKey).length, 1);
  await prepareCollectionReaderCoverage(db, root, profileId, source.id);
  const current = read(),
    stableGeneration = generation(),
    stableDirty = dirty();
  const pageHash = String(db.prepare('SELECT value FROM app_meta WHERE key=?').get(pageKey)!.value);
  transaction(db, () =>
    db
      .prepare(
        'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(pageKey, pageHash),
  );
  assert.equal(generation(), stableGeneration, 'unchanged UPSERTs do not manufacture invalidation');
  assert.deepEqual(read(), current);
  assert.throws(
    () =>
      transaction(db, () => {
        const upsert = db.prepare(
          'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        );
        upsert.run(pageKey, 'b'.repeat(64));
        upsert.run(pageKey, 'c'.repeat(64));
        assert.equal(
          generation(),
          stableGeneration + 2,
          'coalescing does not suppress generations for distinct changes',
        );
        assert.equal(dirty().filter((key) => key === 'meta:' + pageKey).length, 1);
        const renamedPage = pageKey + ':renamed';
        db.prepare('UPDATE app_meta SET key=? WHERE key=?').run(renamedPage, pageKey);
        assert.ok(dirty().includes('meta:' + pageKey));
        assert.ok(dirty().includes('meta:' + renamedPage));
        const sourceUpsert = db.prepare(
          "INSERT INTO source_files SELECT * FROM source_files WHERE id=? ON CONFLICT(id) DO UPDATE SET details_json=excluded.details_json || ' '",
        );
        sourceUpsert.run(source.id);
        sourceUpsert.run(source.id);
        assert.equal(dirty().filter((key) => key === 'source:' + source.id).length, 1);
        const renamedId = source.id + ':renamed';
        db.prepare('UPDATE source_files SET id=? WHERE id=?').run(renamedId, source.id);
        assert.ok(dirty().includes('source:' + source.id));
        assert.ok(dirty().includes('source:' + renamedId));
        assert.equal(generation(), stableGeneration + 6);
        throw Error('fictional rollback');
      }),
    /fictional rollback/,
  );
  assert.equal(generation(), stableGeneration);
  assert.deepEqual(dirty(), stableDirty);
  assert.deepEqual(read(), current, 'rollback retains the previously verified reader observations');
});
test(
  'reader aggregate preserves exact occurrences and refreshes only changed dependency fanout',
  { timeout: 120000 },
  async (t) => {
    const { db, root, profileId } = fixture(t);
    const source = uploadIntake(db, root, profileId, {
      filename: 'fictional.txt',
      bytes: Buffer.from('Fictional evidence. '.repeat(100)),
      newProviderName: 'Fictional clinic',
    });
    const planned = await createIntakePlan(db, root, profileId, source.id, {
        version: source.version,
        operationId: 'fictional-reader-plan',
      }),
      plan = planned.workflow!.plans[0]!;
    const proposal = submitIntakeBatch(db, root, profileId, source.id, {
      version: planned.version,
      planId: plan.id,
      operationId: 'fictional-reader-batch',
      summary: 'Fictional reader context',
      jsonlText: context,
      coverage: [{ unitId: plan.units[0]!.id, kind: 'context', notes: '' }],
    });
    const raw = JSON.parse(readIntakeEnvelopeText(db, source)),
      old = raw.intake.workflow.plans[0],
      proposalId = proposal.proposals[0]!.id;
    raw.intake.proposals.push({ ...raw.intake.proposals[0], id: 'fictional-second-proposal' });
    old.units = Array.from({ length: 32 }, (_, n) => ({
      ...old.units[0],
      id: 'fictional-unit-' + n,
      status: n === 0 ? 'pending' : n === 2 || n === 3 ? 'partial' : 'completed',
      attempts: n === 0 ? [] : [n === 2 ? 'batch-b' : n === 3 ? 'missing-batch' : 'batch-a'],
      ...(n === 0
        ? { coverage: undefined }
        : {
            coverage: {
              unitId: 'fictional-unit-' + n,
              kind: n === 2 ? 'context' : n === 3 ? 'unreadable' : 'extracted',
              notes: n === 2 ? 'Fictional context note' : '',
            },
          }),
    }));
    old.batches = [
      {
        id: 'batch-a',
        proposalId,
        coverage: old.units
          .filter((u: { attempts: string[] }) => u.attempts[0] === 'batch-a')
          .map((u: { coverage: unknown }) => u.coverage),
      },
      { id: 'batch-b', proposalId: 'fictional-second-proposal', coverage: [old.units[2].coverage] },
    ];
    raw.intake.workflow.plans.push(
      { ...old, id: 'fictional-second-plan', units: [old.units[3]] },
      { ...old, id: 'fictional-inactive-plan', status: 'superseded' },
    );
    writeIntakeFixtureEnvelope(db, source.id, raw);
    const pageKey = 'intake_source_page_hash:v1:' + source.id + ':1';
    transaction(db, () => {
      db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(pageKey, 'a'.repeat(64));
      db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
        'intake_proposal_dependencies:v1:' + proposalId,
        JSON.stringify({
          format: 'intake-proposal-dependencies-v1',
          sources: [{ intakeId: source.id, pages: [{ page: 1, hash: 'a'.repeat(64) }] }],
        }),
      );
    });
    await buildIntakeCollectionEnvelope(db, source);
    await prepareCollectionReaderCoverage(db, root, profileId, source.id);
    const read = (offset = 0, limit = 50) =>
      readCollectionReaderCoverage(db, profileId, source.id, { offset, limit });
    const initial = read();
    assert.deepEqual(initial.summary, {
      units: 33,
      pending: 1,
      partial: 3,
      unreadable: 0,
      context: 1,
      stale: 2,
    });
    assert.deepEqual(
      initial.entries.map((entry) => [entry.planOrdinal, entry.unitOrdinal, entry.stale]),
      [
        [0, 0, false],
        [0, 2, false],
        [0, 3, true],
        [1, 0, true],
      ],
    );
    assert.equal(initial.total, 4);
    assert.deepEqual(read(2, 1).entries, [initial.entries[2]]);
    const before = { ...intakeWorkCounters(db).warm },
      cold = intakeWorkCounters(db).reconstruction.readerCoverageColdUnits;
    clearIntakeStateCache(db);
    await prepareCollectionReaderCoverage(db, root, profileId, source.id);
    assert.deepEqual(read().summary, initial.summary);
    assert.equal(intakeWorkCounters(db).reconstruction.readerCoverageColdUnits, cold);
    transaction(db, () =>
      db
        .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
        .run('intake_source_page_hash:v1:' + source.id + ':99', 'b'.repeat(64)),
    );
    await prepareCollectionReaderCoverage(db, root, profileId, source.id);
    assert.equal(
      intakeWorkCounters(db).warm.readerCoverageDependencyChecks,
      before.readerCoverageDependencyChecks,
    );
    assert.equal(
      intakeWorkCounters(db).warm.readerCoverageChangedUnits,
      before.readerCoverageChangedUnits,
    );
    transaction(db, () =>
      db.prepare('UPDATE app_meta SET value=? WHERE key=?').run('b'.repeat(64), pageKey),
    );
    assert.throws(read, { code: 'READER_COVERAGE_PENDING' });
    await prepareCollectionReaderCoverage(db, root, profileId, source.id);
    assert.equal(read().summary.stale, 31);
    assert.equal(read().total, 33);
    assert.equal(
      intakeWorkCounters(db).warm.readerCoverageDependencyChecks -
        before.readerCoverageDependencyChecks,
      1,
    );
    assert.equal(
      intakeWorkCounters(db).warm.readerCoverageChangedUnits - before.readerCoverageChangedUnits,
      29,
    );
    assert.equal(intakeWorkCounters(db).reconstruction.readerCoverageColdUnits, cold);
    transaction(db, () =>
      db.prepare('UPDATE app_meta SET value=? WHERE key=?').run('a'.repeat(64), pageKey),
    );
    await prepareCollectionReaderCoverage(db, root, profileId, source.id);
    assert.deepEqual(read().summary, initial.summary);
    const child = uploadIntake(db, root, profileId, {
      filename: 'fictional-child.txt',
      bytes: Buffer.from('Independent fictional member source'),
      newProviderName: 'Fictional other clinic',
    });
    const childPage = 'intake_source_page_hash:v1:' + child.id + ':1';
    transaction(db, () => {
      db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(childPage, 'c'.repeat(64));
      db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(
        JSON.stringify({
          format: 'intake-proposal-dependencies-v1',
          sources: [{ intakeId: child.id, pages: [{ page: 1, hash: 'c'.repeat(64) }] }],
        }),
        'intake_proposal_dependencies:v1:' + proposalId,
      );
    });
    await prepareCollectionReaderCoverage(db, root, profileId, source.id);
    assert.deepEqual(read().summary, initial.summary);
    const crossSourceBefore = { ...intakeWorkCounters(db).warm };
    transaction(db, () =>
      db.prepare('UPDATE app_meta SET value=? WHERE key=?').run('d'.repeat(64), childPage),
    );
    await prepareCollectionReaderCoverage(db, root, profileId, source.id);
    assert.equal(read().summary.stale, 31);
    assert.equal(
      intakeWorkCounters(db).warm.readerCoverageChangedUnits -
        crossSourceBefore.readerCoverageChangedUnits,
      29,
    );
    assert.equal(
      intakeWorkCounters(db).warm.readerCoverageDependencyChecks -
        crossSourceBefore.readerCoverageDependencyChecks,
      1,
    );
    transaction(db, () =>
      db.prepare('UPDATE app_meta SET value=? WHERE key=?').run('c'.repeat(64), childPage),
    );
    await prepareCollectionReaderCoverage(db, root, profileId, source.id);
    assert.deepEqual(read().summary, initial.summary);
    // An unrecognized authoritative change cannot silently carry the old aggregate.
    const view = openIntakeCollectionEnvelope(db, source),
      intake = view.child(view.root(), 'intake')!,
      operationId = randomUUID();
    const mutation = await prepareIntakeEnvelopeMutation(db, source, {
      reader: view,
      operationId,
      requestDigest: workflowHash(operationId),
      domainVersion: view.logical.domainVersion + 1,
      changes: [
        {
          op: 'set',
          record: intake,
          field: 'displayName',
          jsonText: JSON.stringify('Fictional changed source'),
        },
      ],
    });
    transaction(db, () => selectedEnvelopeStore(db, source).collections.stage(mutation.prepared!));
    assert.throws(read, { code: 'READER_COVERAGE_PENDING' });
    await assert.rejects(
      prepareCollectionReaderCoverage(db, root, profileId, source.id, {
        assertRunning() {
          throw Error('fictional stop');
        },
      }),
      /fictional stop/,
    );
    assert.throws(read, { code: 'READER_COVERAGE_PENDING' });
    await prepareCollectionReaderCoverage(db, root, profileId, source.id);
    assert.deepEqual(read().summary, initial.summary);
    assert.ok(intakeWorkCounters(db).reconstruction.readerCoverageColdUnits > cold);
    assert.equal(
      intakeWorkCounters(db).warm.envelopeHydrations,
      crossSourceBefore.envelopeHydrations,
    );
  },
);

test(
  'implicit native pending coverage and changed batch/replacement remain sparse',
  { timeout: 120000 },
  async (t) => {
    const { db, root, profileId } = fixture(t, true);
    const html =
      '<html><h1>Fictional table</h1><table>' +
      Array.from({ length: 96 }, (_, n) => `<tr><td>Fictional row ${n}</td></tr>`).join('') +
      '</table></html>';
    const source = uploadIntake(db, root, profileId, {
      filename: 'fictional.html',
      bytes: Buffer.from(html),
      newProviderName: 'Fictional clinic',
    });
    const first = await createIntakePlanRead(db, root, profileId, source.id, {
      version: source.version,
      operationId: 'fictional-reader-direct-first',
      unitSize: 1,
      overlap: 0,
    });
    assert.ok(isIntakeSummary(first), 'the real first public plan prepares native storage');
    await prepareCollectionReaderCoverage(db, root, profileId, source.id);
    const scope = readDirectPlanScope(db, profileId, source.id)!;
    const initial = readCollectionReaderCoverage(db, profileId, source.id, {
      offset: scope.unitCount - 2,
      limit: 2,
    });
    assert.equal(initial.summary.pending, scope.unitCount);
    assert.equal(initial.entries[1]!.unitOrdinal, scope.unitCount - 1);
    assert.equal(
      intakeWorkCounters(db).reconstruction.readerCoverageColdUnits,
      0,
      'implicit pending defaults need no unit fact traversal',
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM __intake_reader_units').get()!.n, 0);
    const before = { ...intakeWorkCounters(db).warm },
      unitId = scope.unitAt(0)!.id;
    await submitIntakeBatchRead(db, root, profileId, source.id, {
      version: first.version,
      planId: scope.planId,
      operationId: 'fictional-reader-direct-batch',
      summary: 'Fictional reader context',
      jsonlText: context,
      coverage: [{ unitId, kind: 'unreadable', notes: 'Fictional unreadable region' }],
    });
    await prepareCollectionReaderCoverage(db, root, profileId, source.id);
    const next = readCollectionReaderCoverage(db, profileId, source.id, { offset: 0, limit: 2 });
    assert.equal(next.summary.pending, scope.unitCount - 1);
    assert.equal(next.summary.partial, 1);
    assert.equal(next.summary.unreadable, 1);
    assert.equal(next.summary.stale, 0);
    assert.equal(intakeWorkCounters(db).reconstruction.readerCoverageColdUnits, 0);
    assert.equal(
      intakeWorkCounters(db).warm.readerCoverageChangedUnits - before.readerCoverageChangedUnits,
      2,
      'one changed unit plus its newly published proposal dependency check',
    );
    const second = await createPagedDirectPlan(db, root, profileId, source.id, {
      version: intakeSourceVersion(db, source.id).version,
      operationId: 'fictional-reader-direct-replace',
      unitSize: 3,
      overlap: 0,
      replacePlanId: scope.planId,
    });
    assert.ok('plan' in second);
    await prepareCollectionReaderCoverage(db, root, profileId, source.id);
    const replacement = readCollectionReaderCoverage(db, profileId, source.id, {
      offset: 0,
      limit: 2,
    });
    assert.equal(replacement.summary.units, second.plan.unitCount);
    assert.equal(replacement.summary.pending, second.plan.unitCount);
    assert.equal(replacement.summary.partial, 0);
    assert.equal(replacement.entries[0]!.planOrdinal, 1);
    assert.equal(intakeWorkCounters(db).reconstruction.readerCoverageColdUnits, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM __intake_reader_units').get()!.n, 0);
    assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.envelopeHydrations);
  },
);
