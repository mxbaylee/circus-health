import { readNativeAssistantSourceHeader } from '../assistant-intake-header.ts';
import { nativeAssistantConversion } from '../assistant-intake-native.ts';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { intakeNamespace } from '../intake-state-evidence.ts';
import { createIntakeTree } from '../intake-state-tree.ts';
import { schemaKey } from '../intake-envelope-schema.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, HttpError } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  uploadIntake,
  createIntakePlanRead,
  createIntakePlan,
  workflowMutation,
  getIntakeRead,
  updateIntakeMetadataRead,
} from '../intake.ts';
import { fictionalModel } from './fictional-model.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  createPagedDirectPlan,
  prepareDirectPlanAccess,
  readDirectPlanScope,
  readDirectPlanHeader,
} from '../intake-direct-plan.ts';
import { extractionUnits, type EvidenceIndex } from '../intake-plan.ts';
import { workflowHash } from '../intake-workflow.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { clearPackageSourceSession } from '../intake-package-session.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { iterateIntakeEnvelopeText, selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import { buildFictionalDexaSources } from '../../tests/fixtures/fictional-dexa-source-generator.ts';
import { isIntakeSummary } from '../../shared/intake-summary.ts';
import { readIntakeUnitRead } from '../intake-unit-read.ts';
import { readDirectUnitMetadataFragment } from '../intake-direct-plan.ts';
import { nativePacketReadingGaps } from '../packet-reading-gaps-native.ts';

async function fixture(
  t: test.TestContext,
  filename: string,
  text: string | Buffer,
  migrate = true,
) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-direct-plan-')),
    profileId = 'cookie-dough',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearPackageSourceSession(db);
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const intake = uploadIntake(db, root, profileId, {
    filename,
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(text),
  });
  const file = db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(intake.id)!;
  if (migrate) await buildIntakeCollectionEnvelope(db, file as never);
  return { db, root, profileId, id: intake.id, file, intake };
}

test('direct text plan preserves exact identities, implicit pending units, source-index reuse and replay', async (t) => {
  const f = await fixture(t, 'fictional.txt', 'Independently fictional text.\n'.repeat(2200));
  const input = { version: f.intake.version, operationId: 'direct-plan-first' },
    result = await createPagedDirectPlan(f.db, f.root, f.profileId, f.id, input);
  assert.ok('plan' in result);
  const scope = readDirectPlanScope(f.db, f.profileId, f.id)!;
  const index = JSON.parse([...scope.sourceIndexChunks()].join('')) as EvidenceIndex,
    expected = extractionUnits(index);
  assert.equal(scope.unitCount, expected.length);
  const gaps = nativePacketReadingGaps(f.db, f.id);
  assert.deepEqual(
    gaps,
    expected.map((unit) => ({ locator: unit.locator || unit.id, reason: 'not yet read' })),
  );
  for (let ordinal = 0; ordinal < expected.length; ordinal++) {
    const unit = scope.unitAt(ordinal)!;
    assert.equal(unit.id, expected[ordinal]!.id);
    assert.equal(unit.attemptCount, 0);
    assert.equal('attempts' in unit, false);
    const { id: _id, status: _status, attempts: _attempts, ...value } = expected[ordinal]!;
    assert.deepEqual(JSON.parse([...scope.unitMetadataChunks(ordinal)].join('')), value);
  }
  assert.equal(
    result.plan.id,
    'plan:' + workflowHash([f.id, result.plan.pins, expected.map((unit) => unit.id)]),
  );
  const full = JSON.parse([...iterateIntakeEnvelopeText(f.db, f.file as never)].join(''));
  assert.equal(full.intake.workflow.plans[0].units, undefined);
  assert.equal(full.intake.workflow.plans[0].index, undefined);
  const before = intakeWorkCounters(f.db).warm;
  const idsBefore = before.packagePlanUnitIds,
    readsBefore = before.envelopeHydrations;
  clearIntakeStateCache(f.db);
  assert.deepEqual(nativePacketReadingGaps(f.db, f.id), gaps);
  const replay = await createPagedDirectPlan(f.db, f.root, f.profileId, f.id, input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.version, result.version);
  assert.equal(intakeWorkCounters(f.db).warm.packagePlanUnitIds, idsBefore);
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, readsBefore);
  await assert.rejects(
    createPagedDirectPlan(f.db, f.root, f.profileId, f.id, { ...input, overlap: 0 }),
    (error: unknown) => error instanceof HttpError && error.code === 'OPERATION_CONFLICT',
  );
  const repeated = await createPagedDirectPlan(f.db, f.root, f.profileId, f.id, {
    ...input,
    version: result.version,
    operationId: 'direct-plan-again',
  });
  assert.ok('plan' in repeated);
  assert.equal(repeated.plan.id, result.plan.id);
  assert.equal(intakeWorkCounters(f.db).warm.packagePlanUnitIds, idsBefore);
  const collections = selectedEnvelopeStore(f.db, f.file as never).collections;
  assert.equal(
    collections.collection(collections.openView(), 'logical', 'plan.indexes')!.root!.count,
    2,
  );
});

test('native public PDF plan uses exact page units and source-bound addressed reads', async (t) => {
  const generated = mkdtempSync(join(tmpdir(), 'fictional-direct-pdf-'));
  t.after(() => rmSync(generated, { recursive: true, force: true }));
  const pdf = buildFictionalDexaSources(generated).dexa;
  // Exercise the public compatibility entrypoint without a test-only schema
  // conversion: existing unfinished originals enter the native plan path.
  const f = await fixture(t, 'fictional.pdf', pdf, false);
  const result = await createIntakePlanRead(f.db, f.root, f.profileId, f.id, {
    version: f.intake.version,
    operationId: 'direct-pdf',
  });
  assert.ok(isIntakeSummary(result));
  if (!isIntakeSummary(result)) throw Error('Expected direct summary');
  assert.equal(result.activePlan.state, 'exact');
  const scope = readDirectPlanScope(f.db, f.profileId, f.id)!;
  const index = JSON.parse([...scope.sourceIndexChunks()].join('')) as EvidenceIndex;
  const expected = extractionUnits(index);
  assert.equal(result.activePlan.plan!.unitCount, expected.length);
  for (let ordinal = 0; ordinal < expected.length; ordinal++) {
    assert.equal(scope.unitAt(ordinal)!.id, expected[ordinal]!.id);
    assert.deepEqual(scope.unitAt(ordinal)!.pages, expected[ordinal]!.pages);
  }
  const last = scope.unitAt(scope.unitCount - 1)!;
  const read = await readIntakeUnitRead(f.db, f.root, f.profileId, f.id, last.id);
  assert.ok('metadataReference' in read);
  assert.equal(read.unit.id, last.id);
  const fragment = readDirectUnitMetadataFragment(f.db, f.profileId, f.id, last.metadata, {
    section: 'sourceIndex',
  });
  assert.equal(fragment.complete, true);
  assert.deepEqual(JSON.parse(fragment.text), index);
  await assert.rejects(readIntakeUnitRead(f.db, f.root, 'foreign', f.id, last.id));
});

test('direct HTML plans share heading metadata and keep replacement/no-reactivation semantics', async (t) => {
  const html =
    '<html><h1>Fictional table</h1><table>' +
    Array.from(
      { length: 12 },
      (_, n) => `<tr><${n % 3 ? 'td' : 'th'}>Fictional ${n}</${n % 3 ? 'td' : 'th'}></tr>`,
    ).join('') +
    '</table></html>';
  const f = await fixture(t, 'fictional.html', html);
  const first = await createPagedDirectPlan(f.db, f.root, f.profileId, f.id, {
    version: f.intake.version,
    operationId: 'html-first',
    unitSize: 2,
  });
  assert.ok('plan' in first);
  const scope = readDirectPlanScope(f.db, f.profileId, f.id)!;
  const index = JSON.parse([...scope.sourceIndexChunks()].join('')) as EvidenceIndex;
  const expected = extractionUnits(index, { unitSize: 2 });
  assert.equal(scope.unitCount, expected.length);
  for (let ordinal = 0; ordinal < expected.length; ordinal++)
    assert.equal(scope.unitAt(ordinal)!.id, expected[ordinal]!.id);
  assert.equal(scope.unitAt(0)!.sharedHeadings?.state, 'referenced');
  const second = await createPagedDirectPlan(f.db, f.root, f.profileId, f.id, {
    version: first.version,
    operationId: 'html-second',
    unitSize: 3,
    replacePlanId: first.plan.id,
  });
  assert.ok('plan' in second);
  assert.notEqual(second.plan.id, first.plan.id);
  const third = await createPagedDirectPlan(f.db, f.root, f.profileId, f.id, {
    version: second.version,
    operationId: 'html-back',
    unitSize: 2,
    replacePlanId: second.plan.id,
  });
  assert.ok('plan' in third);
  assert.equal(third.plan.id, first.plan.id);
  assert.equal(third.plan.status, 'superseded');
  assert.equal(readDirectPlanScope(f.db, f.profileId, f.id)!.planId, second.plan.id);
  clearIntakeStateCache(f.db);
  await prepareDirectPlanAccess(f.db, f.profileId, f.id, { planId: first.plan.id });
  assert.equal(
    readDirectPlanScope(f.db, f.profileId, f.id, { planId: first.plan.id })!.unitById(
      expected.at(-1)!.id,
    )!.id,
    expected.at(-1)!.id,
  );
});

test('native direct plan collision retains the exact old plan and receipts through migration and replay', async (t) => {
  const f = await fixture(t, 'fictional.txt', 'Fictional direct evidence.\n'.repeat(500), false);
  const request = { version: f.intake.version, operationId: 'old-direct-plan' };
  const created = await createIntakePlan(f.db, f.root, f.profileId, f.id, request);
  const changed = workflowMutation(
    f.db,
    f.root,
    f.profileId,
    f.id,
    { version: created.version, operationId: 'old-reading' },
    (workflow) => {
      const plan = workflow.plans[0]!;
      Object.assign(plan, {
        fictionalUnknown: { number: 'retained', meaning: 'not a generated replacement' },
      });
      const unit = plan.units[0]!;
      unit.attempts = ['old-batch'];
      unit.status = 'partial';
      unit.coverage = { unitId: unit.id, kind: 'context', notes: 'Fictional retained inspection' };
      plan.batches.push({
        id: 'old-batch',
        proposalId: 'old-proposal',
        coverage: [unit.coverage],
        at: '2026-01-01T00:00:00Z',
      });
    },
  );
  const expected = structuredClone(changed.workflow!.plans);
  await buildIntakeCollectionEnvelope(f.db, { id: f.id });
  const before = { ...intakeWorkCounters(f.db).warm },
    version = intakeSourceVersion(f.db, f.id);
  const replay = await createPagedDirectPlan(f.db, f.root, f.profileId, f.id, request);
  assert.equal(replay.replayed, true);
  assert.deepEqual(intakeSourceVersion(f.db, f.id), version);
  const collision = await createPagedDirectPlan(f.db, f.root, f.profileId, f.id, {
    version: changed.version,
    operationId: 'new-direct-same-shape',
  });
  assert.equal(collision.format, 'health-intake-retained-plan-result-v1');
  const actual = JSON.parse([...iterateIntakeEnvelopeText(f.db, { id: f.id })].join(''));
  assert.deepEqual(actual.intake.workflow.plans, expected);
  assert.equal(readDirectPlanScope(f.db, f.profileId, f.id), undefined);
  clearIntakeStateCache(f.db);
  const hashes = intakeWorkCounters(f.db).warm.packagePlanHashBytes;
  const retried = await createPagedDirectPlan(f.db, f.root, f.profileId, f.id, {
    version: changed.version,
    operationId: 'new-direct-same-shape',
  });
  assert.equal(retried.replayed, true);
  assert.equal(intakeWorkCounters(f.db).warm.packagePlanHashBytes, hashes);
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
  assert.equal(intakeWorkCounters(f.db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
});

test(
  'large direct heading metadata uses stable bounded cursors and survives cache loss',
  { timeout: 120000 },
  async (t) => {
    const html =
      '<table>' +
      '<caption>Fictional naïve 🧪</caption>'.repeat(9000) +
      '<tr><td>Fictional 1</td></tr><tr><td>Fictional 2</td></tr></table>';
    const f = await fixture(t, 'fictional.html', html);
    await createPagedDirectPlan(f.db, f.root, f.profileId, f.id, {
      version: f.intake.version,
      operationId: 'many-headings',
      unitSize: 1,
    });
    const scope = readDirectPlanScope(f.db, f.profileId, f.id)!,
      unit = scope.unitAt(0)!;
    assert.equal(unit.sharedHeadings?.state, 'referenced');
    const expected = JSON.parse([...scope.unitMetadataChunks(0)].join('')).sharedHeadings;
    assert.equal(expected.length, 9000);
    const before = intakeWorkCounters(f.db).warm;
    let cursor: string | undefined,
      text = '',
      windows = 0,
      root: string | undefined;
    do {
      const page = readDirectUnitMetadataFragment(f.db, f.profileId, f.id, unit.metadata, {
        section: 'sharedHeadings',
        cursor,
        bytes: 8192,
      });
      assert.ok(Buffer.byteLength(page.text) <= 8192);
      assert.equal(page.valueRoot, root ?? page.valueRoot);
      root = page.valueRoot;
      text += page.text;
      windows++;
      if (page.complete) {
        assert.equal(page.nextCursor, null);
        break;
      }
      assert.ok(page.nextCursor && page.nextCursor !== cursor);
      cursor = page.nextCursor;
      if (windows === 2) clearIntakeStateCache(f.db);
    } while (windows < 1000);
    assert.ok(windows > 3 && windows < 1000);
    assert.deepEqual(JSON.parse(text), expected);
    const after = intakeWorkCounters(f.db).warm;
    assert.equal(after.packagePlanHashBytes, before.packagePlanHashBytes);
    assert.equal(after.envelopeHydrations, before.envelopeHydrations);
    assert.equal(after.sourceDTOHydrations, before.sourceDTOHydrations);
    assert.throws(
      () =>
        readDirectUnitMetadataFragment(
          f.db,
          f.profileId,
          f.id,
          { ...unit.metadata, version: unit.metadata.version + 1 },
          { section: 'sharedHeadings' },
        ),
      { code: 'PLAN_CHANGED' },
    );
  },
);

test('snapshot namespaces reject foreign writers without selecting unfinished indexes', async (t) => {
  const f = await fixture(t, 'fictional.txt', 'Fictional'),
    before = intakeSourceVersion(f.db, f.id);
  const reports = createReportSnapshotCatalog(f.db, f.file as never),
    plans = createReportSnapshotCatalog(f.db, f.file as never, { catalog: 'plan.indexes' });
  const writer = await plans.fork();
  await writer.put('fictional', 'true');
  await assert.rejects(reports.publish('wrong-owner', writer), /Foreign report snapshot writer/);
  assert.equal(plans.open('wrong-owner'), undefined);
  assert.equal(reports.open('wrong-owner'), undefined);
  assert.equal(intakeSourceVersion(f.db, f.id).logicalBinding, before.logicalBinding);
});

test('direct plan headers reuse bounded immutable context and reject changed, external and rolled-back authority', async (t) => {
  const f = await fixture(t, 'fictional-cache.txt', 'Independently fictional small source.');
  const planned = await createPagedDirectPlan(f.db, f.root, f.profileId, f.id, {
    version: f.intake.version,
    operationId: 'fictional-header-cache',
  });
  assert.ok('plan' in planned);
  const read = () => readDirectPlanHeader(f.db, f.profileId, f.id)!;
  clearIntakeStateCache(f.db);
  let before = intakeWorkCounters(f.db).warm.collectionNodeReads;
  const first = read();
  const coldReads = intakeWorkCounters(f.db).warm.collectionNodeReads - before;
  before = intakeWorkCounters(f.db).warm.collectionNodeReads;
  assert.deepEqual(read(), first);
  const warmReads = intakeWorkCounters(f.db).warm.collectionNodeReads - before;
  assert.ok(
    warmReads < coldReads / 4,
    'an unchanged header does not decode all scalar fields again',
  );
  t.diagnostic(JSON.stringify({ coldReads, warmReads }));
  assert.throws(() => {
    first.pins.mappingVersion = 'fictional-poisoned-pin';
  }, TypeError);
  const scope = readDirectPlanScope(f.db, f.profileId, f.id)!;
  assert.throws(() => {
    scope.plan.unitCount = 999;
  }, TypeError);
  assert.throws(() => Object.assign(scope.reader.logical, { domainVersion: -1 }), TypeError);
  assert.throws(
    () => Object.assign(scope.reader, { field: scope.reader.field.bind(scope.reader) }),
    TypeError,
  );
  assert.equal(read().pins.mappingVersion, planned.plan.pins.mappingVersion);
  clearIntakeStateCache(f.db);
  before = intakeWorkCounters(f.db).warm.collectionNodeReads;
  assert.deepEqual(read(), first);
  assert.ok(
    intakeWorkCounters(f.db).warm.collectionNodeReads - before > warmReads * 4,
    'cache invalidation rebuilds the decoded context from authority',
  );
  const { identity, collections } = selectedEnvelopeStore(f.db, { id: f.id });
  const view = collections.openView();
  const currentScope = readDirectPlanScope(f.db, f.profileId, f.id)!;
  const targetRaw = collections.get(
    view,
    'logical',
    'envelope.data',
    'f:' + currentScope.reader.address(currentScope.record) + ':' + schemaKey('unitCount'),
  );
  assert.equal(typeof targetRaw, 'string');
  const target = JSON.parse(String(targetRaw));
  assert.equal(target.type, 'cell');
  const cell = 'c:' + target.id;
  let key = '';
  const tree = createIntakeTree(
    identity,
    (hash) => {
      const rowKey = intakeNamespace(identity) + 'node:' + hash;
      const raw = f.db.prepare('SELECT value FROM app_meta WHERE key=?').get(rowKey)?.value;
      assert.equal(typeof raw, 'string');
      if (JSON.parse(String(raw)).key === cell) key = rowKey;
      return raw;
    },
    new Map(),
  );
  const data = collections.collection(view, 'logical', 'envelope.data')!;
  assert.ok(tree.get(data.root, cell));
  assert.ok(key, 'the selected plan scalar has an actual authenticated storage node');
  const original = String(f.db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)!.value);
  const change = f.db.prepare('UPDATE app_meta SET value=? WHERE key=?');
  change.run('{}', key);
  assert.equal(
    currentScope.reader.childCount(currentScope.record, 'batches'),
    0,
    'the warm header accessor does not visit this decoded plan-value node',
  );
  assert.throws(
    read,
    /schema|tree|collection/,
    'local scalar corruption invalidates the decoded header',
  );
  change.run(original, key);
  assert.deepEqual(read(), first);
  const peer = new DatabaseSync(String(f.db.prepare('PRAGMA database_list').get()!.file));
  try {
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{}', key);
    assert.throws(read, /schema|tree|collection/, 'external changes invalidate the decoded header');
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(original, key);
    assert.deepEqual(read(), first);
  } finally {
    peer.close();
  }
  change.run('{}', key);
  f.db.exec('SAVEPOINT fictional_direct_header_repair');
  try {
    change.run(original, key);
    assert.deepEqual(read(), first, 'a transaction can inspect temporarily repaired authority');
    const changes = f.db.prepare('SELECT total_changes() AS count').get()!.count;
    f.db.exec('ROLLBACK TO fictional_direct_header_repair; RELEASE fictional_direct_header_repair');
    assert.equal(f.db.prepare('SELECT total_changes() AS count').get()!.count, changes);
    assert.throws(
      read,
      /schema|tree|collection/,
      'a rolled-back repair cannot seed the header cache',
    );
  } finally {
    if (f.db.isTransaction)
      f.db.exec(
        'ROLLBACK TO fictional_direct_header_repair; RELEASE fictional_direct_header_repair',
      );
    change.run(original, key);
  }
  assert.deepEqual(read(), first);
  f.db.exec('SAVEPOINT fictional_direct_source');
  try {
    f.db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('f'.repeat(64), f.id);
    assert.throws(read, /source|collection|envelope|identity|head/i);
  } finally {
    f.db.exec('ROLLBACK TO fictional_direct_source; RELEASE fictional_direct_source');
  }
  assert.deepEqual(read(), first);
  f.db.exec('SAVEPOINT fictional_direct_owner');
  try {
    change.run('fictional-other-profile', 'owner_profile_id');
    assert.throws(read, /profile|owner/i);
  } finally {
    f.db.exec('ROLLBACK TO fictional_direct_owner; RELEASE fictional_direct_owner');
  }
  assert.deepEqual(read(), first);
});

test('internal assistant source headers preserve selected facts without constructing public collection summaries', async (t) => {
  const f = await fixture(t, 'fictional-assistant-header.txt', 'Independently fictional source.');
  const planned = await createPagedDirectPlan(f.db, f.root, f.profileId, f.id, {
    version: f.intake.version,
    operationId: 'fictional-assistant-header',
  });
  assert.ok('plan' in planned);
  const read = () => readNativeAssistantSourceHeader(f.db, f.root, f.profileId, f.id)!;
  const summary = getIntakeRead(f.db, f.root, f.profileId, f.id);
  assert.ok(isIntakeSummary(summary));
  const header = read();
  assert.equal(header.format, 'health-intake-assistant-source-v1');
  assert.equal('collections' in header, false);
  for (const key of [
    'id',
    'sha256',
    'version',
    'providerId',
    'activePlan',
    'durability',
    'filename',
  ] as const)
    assert.deepEqual(header[key], summary[key]);
  assert.equal(header.candidateCount, summary.collections.candidates.total);
  assert.equal(
    nativeAssistantConversion(f.db, f.root, f.profileId, 'fictional-session', header)
      .candidateCount,
    summary.collections.candidates.total,
  );
  assert.throws(
    () =>
      Reflect.apply(nativeAssistantConversion, undefined, [
        f.db,
        f.root,
        f.profileId,
        'fictional-session',
        { ...header, format: 'fictional-unknown-source' },
      ]),
    { code: 'CONVERSION_SOURCE_UNAVAILABLE' },
  );
  let before = intakeWorkCounters(f.db).warm.collectionNodeReads;
  getIntakeRead(f.db, f.root, f.profileId, f.id);
  const publicReads = intakeWorkCounters(f.db).warm.collectionNodeReads - before;
  before = intakeWorkCounters(f.db).warm.collectionNodeReads;
  read();
  const internalReads = intakeWorkCounters(f.db).warm.collectionNodeReads - before;
  assert.ok(
    internalReads < publicReads / 3,
    'internal model events read only their actual source, plan and candidate-count fields',
  );
  t.diagnostic(JSON.stringify({ publicReads, internalReads }));
  const changed = await updateIntakeMetadataRead(f.db, f.root, f.profileId, f.id, {
    version: header.version,
    operationId: 'fictional-header-metadata',
    metadata: { source: 'Fictional corrected provider' },
  });
  assert.ok(isIntakeSummary(changed));
  assert.equal(read().version, changed.version);
  assert.equal(read().providerId, changed.providerId);
  assert.deepEqual(read().activePlan, changed.activePlan);
  assert.throws(
    () => readNativeAssistantSourceHeader(f.db, f.root, 'fictional-foreign-profile', f.id),
    { code: 'PROFILE_BOUNDARY' },
  );
  f.db.exec('SAVEPOINT fictional_assistant_source_change');
  try {
    f.db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('0'.repeat(64), f.id);
    assert.throws(read, /source|collection|envelope|identity|head/i);
  } finally {
    f.db.exec(
      'ROLLBACK TO fictional_assistant_source_change; RELEASE fictional_assistant_source_change',
    );
  }
  assert.equal(read().version, changed.version);
});
