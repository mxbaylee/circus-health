import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { attachPersonalDurability } from '../portable.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import { fictionalModel } from './fictional-model.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError, openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import * as intake from '../intake.ts';
import {
  indexIntakeEvidence,
  navigateIntakeEvidence as navigateIntakeEvidenceRaw,
} from '../intake-evidence.ts';
import { createBackup } from '../recovery.ts';
import { rebuildProfile } from '../portable.ts';
import { readPlannedIntakeUnit } from '../intake-navigation.ts';
import { readIntakePackageMember } from '../intake-package.ts';
import type { IntakeWithWorkflow } from '../intake-continuation.ts';

type PlannedPlan = Parameters<typeof readPlannedIntakeUnit>[0]['plan'];
type PlannedIntake = IntakeWithWorkflow & {
  workflow: IntakeWithWorkflow['workflow'] & { plans: PlannedPlan[] };
};
type SearchResult = {
  results: { snippet: string; locator: string; sectionId: string; start: number; end: number }[];
  nextOffset: number | null;
};
type FollowResult = {
  followed: boolean;
  text: string;
  start: number;
  reference: { status: string };
  kind: string;
  coverage: string;
};
type NavigationContext = Parameters<typeof navigateIntakeEvidenceRaw>[0];
function navigateIntakeEvidence(
  context: NavigationContext & { action: 'search' },
): Promise<SearchResult>;
function navigateIntakeEvidence(
  context: NavigationContext & { action: 'follow' },
): Promise<FollowResult>;
function navigateIntakeEvidence(
  context: NavigationContext & { action: 'search' | 'follow' },
): Promise<SearchResult | FollowResult> {
  return navigateIntakeEvidenceRaw(context) as Promise<SearchResult | FollowResult>;
}
const createIntakePlan = async (
  ...args: Parameters<typeof intake.createIntakePlan>
): Promise<PlannedIntake> => (await intake.createIntakePlan(...args)) as PlannedIntake;
const getIntake = (...args: Parameters<typeof intake.getIntake>): IntakeWithWorkflow =>
  intake.getIntake(...args) as IntakeWithWorkflow;
const submitIntakeBatch = (
  ...args: Parameters<typeof intake.submitIntakeBatch>
): IntakeWithWorkflow => intake.submitIntakeBatch(...args) as IntakeWithWorkflow;

function fixture(t: TestContext) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'circus-source-navigation-')),
    profileId = 'cookie-dough';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId: profileId });
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return {
    db,
    root,
    profileId,
    upload(bytes: Buffer, filename: string): IntakeWithWorkflow {
      return intake.uploadIntake(db, root, profileId, {
        bytes,
        filename,
        newProviderName: 'Fictional clinic',
      }) as IntakeWithWorkflow;
    },
  };
}
function archive(entries: Record<string, string | Buffer>) {
  return zipFixture(Object.entries(entries).map(([name, data]) => ({ name, data })));
}
const html =
  '<html><h2>Fictional chemistry (mg/dL)</h2><table><caption>Specimen A — literal values</caption><tr><th>Measure</th><th>Value (mg/dL)</th></tr>' +
  Array.from({ length: 5 }, (_, i) => `<tr><td>Fictional ${i}</td><td>${i}.000</td></tr>`).join(
    '',
  ) +
  '</table><a href="detail.html#method">Method</a><img src="photo.png"><img src="absent.png"><a href="https://never.example/report">Remote</a><script>fetch("https://never.example/forbidden")</script></html>';
const record = {
  format: 'health-record-v1',
  id: 'fictional-event',
  kind: 'record',
  payload: { literal: '1.000' },
  provenance: {
    capturedVia: 'Fictional ZIP',
    sourceSystem: 'Fictional issuer',
    sourceRecordId: 'fictional-event',
    evidenceClass: 'provider_export',
    locator: 'ZIP member folder/report.html; table 1 rows 1–3',
  },
  coverage: { status: 'complete_response', notes: [] },
  clinical: {
    kind: 'observation',
    subject: 'self',
    testLabel: 'Fictional',
    valueText: '1.000',
    unit: 'mg/dL',
    date: '2026-09',
  },
};

test('ZIP-wide units pin each original, preserve shared headings and resume partial coverage after SQLite loss', async (t) => {
  const f = fixture(t),
    bytes = archive({
      'folder/report.html': html,
      'folder/copy.html': html,
      'folder/detail.html': '<h1 id="method">Method literal</h1>',
      'folder/photo.png': Buffer.from('89504e470d0a1a0a', 'hex'),
      'unknown.bin': Buffer.from([0xff, 0xfe]),
      'empty.txt': '',
      'nested.zip': Buffer.from('504b0304', 'hex'),
    });
  let item = f.upload(bytes, 'delivery.zip');
  item = await createIntakePlan(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    unitSize: 3,
    overlap: 1,
  });
  const plan = item.workflow.plans[0];
  assert.ok(plan.index.members);
  assert.equal(plan.index.kind, 'zip');
  assert.equal(plan.index.members.length, 7);
  assert.equal(plan.units.length, 7);
  assert.ok(plan.units.every((unit) => unit.kind === 'package_member'));
  const units = plan.units;
  assert.equal(new Set(units.map((unit) => unit.id)).size, 7);
  const read = intake.readIntakeUnit(f.db, f.root, f.profileId, item.id, units[1].id);
  assert.equal(read.memberId, units[1].memberId);
  const member = plan.index.members.find((member) => member.filename === 'folder/report.html');
  assert.ok(member);
  const materialized = await readIntakePackageMember({
    ...f,
    id: item.id,
    memberId: member.memberId,
  });
  assert.ok(materialized.sourceFileId);
  const child = getIntake(f.db, f.root, f.profileId, materialized.sourceFileId);
  const childPlan = await createIntakePlan(f.db, f.root, f.profileId, child.id, {
    version: child.version,
    unitSize: 3,
    overlap: 1,
  });
  type RowUnit = (typeof childPlan.workflow.plans)[number]['units'][number] & { rows: number[] };
  const rows = childPlan.workflow.plans[0].units.filter(
    (unit): unit is RowUnit => 'rows' in unit && Array.isArray(unit.rows),
  );
  assert.equal(rows[0]!.rows.at(-1), rows[1]!.rows[0]);
  const literal = intake.readIntakeUnit(f.db, f.root, f.profileId, child.id, rows[1]!.id);
  assert.ok(typeof literal.text === 'string');
  assert.ok(literal.sharedHeadings && literal.missingAssets);
  assert.match(literal.text, /2\.000/);
  assert.ok(literal.sharedHeadings.some((heading) => /Value \(mg\/dL\)/.test(heading.text)));
  assert.ok(literal.sharedHeadings.some((heading) => /Specimen A/.test(heading.text)));
  assert.ok(
    literal.missingAssets.some(
      (asset) => asset.source === 'photo.png' && asset.status === 'supplied_uninspected',
    ),
  );
  assert.ok(
    literal.missingAssets.some(
      (asset) => asset.source === 'absent.png' && asset.status === 'not_supplied',
    ),
  );
  const batch: Parameters<typeof intake.submitIntakeBatch>[4] = {
    version: item.version,
    planId: plan.id,
    operationId: 'member-batch',
    summary: 'Fictional member interpretation',
    jsonlText: JSON.stringify(record),
    coverage: [
      {
        unitId: units[0].id,
        kind: 'extracted' as const,
        notes: 'All literal member content inspected; related member occurrences remain pending',
      },
    ],
  };
  item = submitIntakeBatch(f.db, f.root, f.profileId, item.id, batch);
  assert.equal(submitIntakeBatch(f.db, f.root, f.profileId, item.id, batch).version, item.version);
  assert.equal(item.pendingWorkCount, plan.units.length - 1);
  const backup = await createBackup(f.db, f.root, f.profileId),
    target = join(f.root, 'resumed'),
    rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
    db = openDatabase(rebuilt.database, f.profileId);
  attachPersonalDurability(db, { root: target, profileId: f.profileId });
  try {
    const recovered = getIntake(db, target, f.profileId, item.id);
    assert.deepEqual(recovered.workflow, item.workflow);
    assert.deepEqual(intake.getIntakeOriginal(db, target, f.profileId, item.id).bytes, bytes);
    assert.deepEqual(intake.readIntakeUnit(db, target, f.profileId, item.id, units[1].id), read);
    const retried = await createIntakePlan(db, target, f.profileId, item.id, {
      version: recovered.version,
      unitSize: 3,
      overlap: 1,
    });
    assert.equal(retried.workflow.plans.length, 1);
    assert.equal(retried.pendingWorkCount, recovered.pendingWorkCount);
    assert.deepEqual(retried.workflow.plans[0].batches, recovered.workflow.plans[0].batches);
  } finally {
    db.close();
  }
});

test('section search and reference following remain scoped, literal, bounded and never fetch dependencies', async (t) => {
  const f = fixture(t),
    item = f.upload(
      archive({
        'folder/report.html': html,
        'folder/detail.html':
          '<h1 id="method">Method literal</h1><p>Fictional assay</p><a id="duplicate"></a><p id="duplicate">Ambiguous</p>',
        'folder/photo.png': Buffer.from('89504e470d0a1a0a', 'hex'),
      }),
      'navigation.zip',
    );
  const packagePlan = await createIntakePlan(f.db, f.root, f.profileId, item.id, {
    version: item.version,
  });
  const members = packagePlan.workflow.plans[0].index.members;
  assert.ok(members);
  for (const member of members.filter((member) => member.filename.endsWith('.html')))
    await readIntakePackageMember({ ...f, id: item.id, memberId: member.memberId });
  intake.retainIntakeChildren(f.db, f.root, f.profileId, item.id, [
    {
      filename: 'folder/photo.png',
      locator: 'ZIP member folder/photo.png',
      bytes: Buffer.from('89504e470d0a1a0a', 'hex'),
    },
  ]);
  const sourceId = intake
    .listIntakes(f.db, f.profileId, {}, f.root)
    .data.find(
      (entry) =>
        JSON.parse(readIntakeEnvelopeText(f.db, { id: entry.id })!).intake.originalName ===
        'folder/report.html',
    )!.id;
  const child = getIntake(f.db, f.root, f.profileId, sourceId);
  const planned = await createIntakePlan(f.db, f.root, f.profileId, sourceId, {
    version: child.version,
  });
  const before = structuredClone(getIntake(f.db, f.root, f.profileId, item.id).workflow),
    context = { ...f, id: sourceId };
  const savedFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw Error('Source navigation must never fetch');
  };
  t.after(() => {
    globalThis.fetch = savedFetch;
  });
  const search = await navigateIntakeEvidence({
    ...context,
    action: 'search',
    query: 'Fictional 2',
  });
  assert.equal(search.results.length, 1);
  assert.match(search.results[0].snippet, /2\.000/);
  assert.match(search.results[0].locator, /table 1/);
  assert.equal(
    (await navigateIntakeEvidence({ ...context, action: 'search', query: 'forbidden' })).results
      .length,
    0,
    'scripts are excluded from search',
  );
  const references = planned.workflow.plans[0].index.references;
  assert.ok(references);
  const followed = await navigateIntakeEvidence({
    ...context,
    action: 'follow',
    referenceId: references.find((reference) => reference.source === 'detail.html#method')!.id,
  });
  assert.equal(followed.followed, true);
  assert.match(followed.text, /Method literal/);
  assert.equal(followed.start, 0);
  // A retained legacy source may point to a sibling that has since entered the
  // native path. Following the link needs its header, never a whole DTO.
  const targetReference = references.find(
    (reference) => reference.source === 'detail.html#method',
  )!;
  assert.ok(targetReference.sourceFileId);
  await intake.ensureNativeIntakeSchema(f.db, f.profileId, targetReference.sourceFileId);
  const mixed = await navigateIntakeEvidence({
    ...context,
    action: 'follow',
    referenceId: targetReference.id,
  });
  assert.equal(mixed.followed, true);
  assert.equal(mixed.text, followed.text);
  assert.equal(mixed.start, followed.start);
  const remote = await navigateIntakeEvidence({
    ...context,
    action: 'follow',
    referenceId: references.find((reference) => reference.source.startsWith('https:'))!.id,
  });
  assert.equal(remote.followed, false);
  assert.equal(remote.reference.status, 'not_supplied');
  const image = await navigateIntakeEvidence({
    ...context,
    action: 'follow',
    referenceId: references.find((reference) => reference.source === 'photo.png')!.id,
  });
  assert.equal(image.kind, 'image');
  assert.equal(image.coverage, 'uninspected');
  await assert.rejects(
    navigateIntakeEvidence({ ...context, action: 'follow', referenceId: 'foreign-reference' }),
    (error: unknown) => error instanceof HttpError && error.code === 'REFERENCE_NOT_FOUND',
  );
  await assert.rejects(
    navigateIntakeEvidence({
      ...context,
      profileId: 'another-profile',
      action: 'search',
      query: 'Fictional',
    }),
    (error: unknown) => error instanceof HttpError && error.code === 'PROFILE_BOUNDARY',
  );
  assert.deepEqual(
    getIntake(f.db, f.root, f.profileId, item.id).workflow,
    before,
    'reads never mark extraction complete or change reviewed decisions',
  );
  // Selecting the parent does not require old extracted children to migrate.
  // Their reference resolver must use the parent's complete paged inventory.
  await intake.createIntakePlanRead(f.db, f.root, f.profileId, item.id, {
    version: intake.getIntakeRead(f.db, f.root, f.profileId, item.id).version,
    operationId: 'fictional-parent-native-plan',
  });
  assert.ok(!('format' in intake.getIntakeRead(f.db, f.root, f.profileId, sourceId)));
  const mixedParentIndex = await indexIntakeEvidence(context);
  assert.equal(
    mixedParentIndex.references?.find((r) => r.source === 'detail.html#method')?.sourceFileId,
    targetReference.sourceFileId,
  );
  const mixedParentFollow = await navigateIntakeEvidence({
    ...context,
    action: 'follow',
    referenceId: targetReference.id,
  });
  assert.equal(mixedParentFollow.text, followed.text);
  assert.equal(mixedParentFollow.start, followed.start);
});

test('interrupted ZIP indexing retries retained children without duplicate originals or recursive expansion', async (t) => {
  const f = fixture(t),
    item = f.upload(
      archive({
        'one.txt': 'Fictional one',
        'two.txt': 'Fictional two',
        'nested.zip': Buffer.from('504b0304', 'hex'),
      }),
      'interrupted.zip',
    );
  let checkpoints = 0;
  await assert.rejects(
    createIntakePlan(f.db, f.root, f.profileId, item.id, {
      version: item.version,
      assertRunning() {
        if (++checkpoints === 3) throw Error('Synthetic cancellation');
      },
    }),
    /Synthetic cancellation/,
  );
  assert.equal(getIntake(f.db, f.root, f.profileId, item.id).workflow.plans.length, 0);
  const count = f.db
    .prepare("SELECT count(*) n FROM source_files WHERE kind='intake_original'")
    .get()!.n;
  const resumed = await createIntakePlan(f.db, f.root, f.profileId, item.id, {
    version: item.version,
  });
  assert.equal(resumed.workflow.plans[0].units.length, 3);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM source_files WHERE kind='intake_original'").get()!.n,
    count,
  );
  assert.equal(count, 1, 'inventory and cancellation retain no eager children');
  const plan = resumed.workflow.plans[0],
    unit = plan.units.find((unit) => unit.kind === 'package_member');
  assert.ok(unit);
  assert.throws(
    () =>
      readPlannedIntakeUnit({
        ...f,
        id: item.id,
        plan,
        unit: { ...unit, sourceHash: 'wrong-pin' } as unknown as Parameters<
          typeof readPlannedIntakeUnit
        >[0]['unit'],
      }),
    (error: unknown) => error instanceof HttpError && error.code === 'PLAN_SOURCE',
  );
});

test('HTML anchors reject ambiguous/missing targets, external schemes and encoded traversal outside supplied members', async (t) => {
  const f = fixture(t),
    text =
      '<h1 id="same">One</h1><h2 id="same">Two</h2><a href="#same">Ambiguous</a><a href="#missing">Missing</a><a href="javascript:alert(1)">Unsafe scheme</a><a href="%2F%2Fnever.example/x">Encoded remote</a><a href="../../absent.txt">Outside</a><a href="#value">Value</a><p id="value">7.000 mg/dL</p>';
  const item = f.upload(Buffer.from(text), 'anchors.html'),
    context = { ...f, id: item.id },
    index = await indexIntakeEvidence(context);
  assert.ok(index.references);
  for (const source of [
    '#same',
    '#missing',
    'javascript:alert(1)',
    '%2F%2Fnever.example/x',
    '../../absent.txt',
  ]) {
    const result: FollowResult = await navigateIntakeEvidence({
      ...context,
      action: 'follow',
      referenceId: index.references.find((reference) => reference.source === source)!.id,
    });
    assert.equal(result.followed, false);
  }
  const result = await navigateIntakeEvidence({
    ...context,
    action: 'follow',
    referenceId: index.references.find((reference) => reference.source === '#value')!.id,
  });
  assert.equal(result.followed, true);
  assert.equal(result.text, '<p id="value">7.000 mg/dL</p>');
});

test('section search pagination stays bounded and retains literal offsets', async (t) => {
  const f = fixture(t),
    text = Array.from(
      { length: 31 },
      (_, i) => `<table><tr><td>Fictional needle ${i}.000</td></tr></table>`,
    ).join('');
  const item = f.upload(Buffer.from(text), 'many.html'),
    context = { ...f, id: item.id, action: 'search' as const, query: 'needle' };
  const first = await navigateIntakeEvidence(context),
    second = await navigateIntakeEvidence({ ...context, offset: first.nextOffset });
  assert.equal(first.results.length, 20);
  assert.equal(second.results.length, 11);
  assert.equal(second.nextOffset, null);
  assert.equal(
    new Set([...first.results, ...second.results].map((result) => result.sectionId)).size,
    31,
  );
  for (const result of [...first.results, ...second.results])
    assert.equal(text.slice(result.start, result.end), result.snippet);
  await assert.rejects(
    navigateIntakeEvidence({ ...context, query: '' }),
    (error: unknown) => error instanceof HttpError && error.code === 'SEARCH_INPUT',
  );
});
