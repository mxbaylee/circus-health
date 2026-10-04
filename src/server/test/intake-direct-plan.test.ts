import test from 'node:test';
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
} from '../intake.ts';
import { fictionalModel } from './fictional-model.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  createPagedDirectPlan,
  prepareDirectPlanAccess,
  readDirectPlanScope,
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
