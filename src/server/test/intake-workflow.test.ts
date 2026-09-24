import { fictionalModel } from './fictional-model.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError, openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import * as intake from '../intake.ts';
import { indexIntakeEvidence } from '../intake-evidence.ts';
import { createBackup } from '../recovery.ts';
import { rebuildProfile } from '../portable.ts';
import { previewMappingChange } from '../clinical-import.ts';
import { applyMappingChange } from '../mapping-actions.ts';
import type { IntakeClinicalMapping } from '../../shared/intake.ts';
import type { IntakeWithWorkflow } from '../intake-continuation.ts';

type TestIntake = IntakeWithWorkflow;
interface FixtureCall {
  (name: 'reviewIntake', ...args: unknown[]): ReturnType<typeof intake.reviewIntake>;
  (name: 'getIntakeOriginal', ...args: unknown[]): ReturnType<typeof intake.getIntakeOriginal>;
  (name: 'readIntakeUnit', ...args: unknown[]): ReturnType<typeof intake.readIntakeUnit>;
  (name: 'createIntakePlan', ...args: unknown[]): Promise<TestIntake>;
  (
    name:
      | 'answerIntakeQuestion'
      | 'askIntakeQuestion'
      | 'getIntake'
      | 'importIntake'
      | 'saveIntakeReviewDraft'
      | 'submitIntakeBatch',
    ...args: unknown[]
  ): TestIntake;
}

const envelope = (
  id: string,
  locator = 'page 1',
  clinical: Partial<IntakeClinicalMapping> = {},
) => ({
  format: 'health-record-v1',
  id,
  kind: 'record',
  payload: { literal: '12.00', unknownField: true },
  provenance: {
    capturedVia: 'Fictional delivery',
    sourceSystem: 'Fictional issuer',
    sourceRecordId: id,
    evidenceClass: 'provider_export',
    locator,
  },
  coverage: { status: 'complete_response', notes: [] },
  clinical: {
    kind: 'observation',
    subject: 'self',
    testLabel: 'Example',
    valueText: '12.00',
    unit: 'mg',
    date: '2026-09',
    ...clinical,
  },
});
function fixture(t: TestContext) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'health-intake-workflow-')),
    profileId = 'cookie-dough';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  const call = ((name: keyof typeof intake, ...args: unknown[]) => {
    const fn = intake[name] as unknown as (...values: unknown[]) => unknown;
    return fn(db, root, profileId, ...args);
  }) as FixtureCall;
  return {
    root,
    profileId,
    db,
    call,
    upload(bytes: Buffer, filename = 'records.jsonl'): TestIntake {
      return intake.uploadIntake(db, root, profileId, {
        filename,
        bytes,
        newProviderName: 'Fictional clinic',
      }) as TestIntake;
    },
  };
}
function pdf() {
  const objects = [
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>',
  ];
  for (let i = 0; i < 3; i++) {
    const stream = `BT /F1 12 Tf 72 720 Td (Fictional page ${i + 1}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  let text = '%PDF-1.4\n',
    offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(text));
    text += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
const accept = (
  f: ReturnType<typeof fixture>,
  item: TestIntake,
  recordIndices: number[],
  proposalId: string | null = null,
  mapping: Partial<IntakeClinicalMapping> = {},
) => {
  const review = f.call('reviewIntake', item.id, proposalId);
  return f.call('importIntake', item.id, {
    version: review.version,
    proposalId,
    reviewToken: review.reviewToken,
    decisions: recordIndices.map((i) => ({
      recordId: review.records[i]!.id,
      action: 'accept',
      mapping,
    })),
  });
};

test('record questions, independently reviewed acceptance and answer history survive SQLite loss', async (t) => {
  const f = fixture(t),
    bytes = Buffer.from(
      [
        envelope('resolved'),
        envelope('uncertain', 'page 2', { uncertainties: ['Confirm the source unit'], unit: '' }),
      ]
        .map((value) => JSON.stringify(value))
        .join('\n'),
    );
  let item = f.upload(bytes);
  assert.equal(item.workflow.questions.length, 1);
  assert.equal(item.needsReview, true);
  let review = f.call('reviewIntake', item.id);
  assert.equal(review.records[1]!.questions?.length, 1);
  assert.throws(
    () => accept(f, item, [1]),
    (e: unknown) => e instanceof HttpError && e.code === 'QUESTIONS_PENDING',
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
  item = accept(f, item, [0]);
  assert.equal(item.state, 'needs_review');
  assert.equal(item.pendingCount, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  const q = item.workflow.questions[0],
    answer = {
      version: item.version,
      operationId: 'answer-one',
      questionId: q.id,
      answer: 'The printed heading says mg',
      mapping: { unit: 'mg' },
    };
  item = f.call('answerIntakeQuestion', item.id, answer);
  assert.equal(item.workflow.questions[0].status, 'answered');
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  assert.equal(f.call('answerIntakeQuestion', item.id, answer).version, item.version);
  assert.throws(
    () => f.call('answerIntakeQuestion', item.id, { ...answer, answer: 'Changed' }),
    (e: unknown) => e instanceof HttpError && e.code === 'OPERATION_CONFLICT',
  );
  assert.throws(
    () => accept(f, item, [1]),
    (e: unknown) => e instanceof HttpError && e.code === 'ANSWER_REVIEW_REQUIRED',
  );
  item = accept(f, item, [1], null, { unit: 'mg' });
  assert.equal(item.workflow.questions[0].status, 'resolved');
  assert.equal(item.pendingCount, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
  const backup = await createBackup(f.db, f.root, f.profileId),
    target = join(f.root, 'rebuilt'),
    rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
    db = openDatabase(rebuilt.database, f.profileId);
  try {
    const saved = intake.getIntake(db, target, f.profileId, item.id);
    assert.deepEqual(saved.workflow, item.workflow);
    assert.deepEqual(intake.getIntakeOriginal(db, target, f.profileId, item.id).bytes, bytes);
  } finally {
    db.close();
  }
});
test('omitted decisions never accept other records and old review tokens cannot answer newer questions', (t) => {
  const f = fixture(t);
  let item = f.upload(
      Buffer.from([envelope('a'), envelope('b')].map((value) => JSON.stringify(value)).join('\n')),
    ),
    review = f.call('reviewIntake', item.id);
  item = f.call('importIntake', item.id, {
    version: item.version,
    reviewToken: review.reviewToken,
    decisions: [],
  });
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
  assert.equal(item.pendingCount, 2);
  review = f.call('reviewIntake', item.id);
  const ask = {
    version: item.version,
    key: 'stable',
    candidateId: review.records[0].candidateId,
    prompt: 'Which specimen?',
    locator: 'page 1',
  };
  item = f.call('askIntakeQuestion', item.id, ask);
  assert.equal(f.call('askIntakeQuestion', item.id, ask).workflow.questions.length, 1);
  assert.throws(
    () =>
      f.call('importIntake', item.id, {
        version: review.version,
        reviewToken: review.reviewToken,
        decisions: [{ recordId: review.records[0].id, action: 'accept' }],
      }),
    (e: unknown) => e instanceof HttpError && e.code === 'VERSION_CONFLICT',
  );
  assert.throws(
    () =>
      intake.answerIntakeQuestion(f.db, f.root, 'cedar', item.id, {
        version: item.version,
        operationId: 'bad',
        questionId: item.workflow.questions[0].id,
        answer: 'No',
      }),
    (e: unknown) => e instanceof HttpError && e.code === 'PROFILE_BOUNDARY',
  );
});
test('individual classification exception wins over later general rules and repeated deliveries', (t) => {
  const f = fixture(t),
    value = envelope('procedure', 'page 1', {
      kind: 'procedure',
      procedureLabel: 'Example procedure',
      procedureCategory: 'clinical_procedure',
    });
  let item = f.upload(Buffer.from(JSON.stringify(value)));
  item = accept(f, item, [0], null, { procedureCategory: 'laboratory' });
  const rule: Parameters<typeof previewMappingChange>[2] = {
      match: { kind: 'procedure', label: 'Example procedure' },
      set: { procedureCategory: 'surgery' },
    },
    preview = previewMappingChange(f.db, item.providerId, rule);
  assert.equal(preview.count, 0);
  applyMappingChange(f.db, f.root, f.profileId, {
    providerId: item.providerId,
    rule,
    previewToken: preview.token,
    version: preview.version,
    operationId: 'general-rule',
  });
  const repeated = f.upload(Buffer.from(JSON.stringify(value)), 'copy.jsonl'),
    review = f.call('reviewIntake', repeated.id);
  assert.equal(review.records[0].mapping.procedureCategory, 'laboratory');
  assert.ok('recordException' in review.records[0]! && review.records[0].recordException);
  accept(f, repeated, [0]);
  assert.equal(f.db.prepare('SELECT count(*) n FROM procedures').get()!.n, 1);
  assert.equal(f.db.prepare('SELECT category FROM procedures').get()!.category, 'laboratory');
});
test('three-page overlapping extraction resumes idempotently and keeps later accepted-record evidence separate', async (t) => {
  const f = fixture(t),
    bytes = pdf();
  let item = f.upload(bytes, 'three.pdf');
  item = await f.call('createIntakePlan', item.id, {
    version: item.version,
    unitSize: 2,
    overlap: 1,
  });
  const plan = item.workflow.plans[0];
  assert.deepEqual(
    plan.units.map((u) => u.pages),
    [
      [1, 2],
      [2, 3],
    ],
  );
  const batch = {
    version: item.version,
    planId: plan.id,
    operationId: 'batch-a',
    jsonlText: JSON.stringify(envelope('a', 'pages 1–2')),
    summary: 'First artifact',
    coverage: [
      { unitId: plan.units[0]!.id, kind: 'extracted', notes: 'Artifact A; page 2 shared context' },
    ],
  };
  item = f.call('submitIntakeBatch', item.id, batch);
  assert.equal(f.call('submitIntakeBatch', item.id, batch).version, item.version);
  assert.equal(item.workflow.plans[0].batches.length, 1);
  assert.equal(item.pendingWorkCount, 1);
  let review = f.call('reviewIntake', item.id, item.proposals[0].id);
  const reviewRecord = review.records[0]!;
  const identity = reviewRecord.issues?.find((issue) => issue.kind === 'identity');
  assert.ok(identity);
  item = f.call('saveIntakeReviewDraft', item.id, {
    version: item.version,
    operationId: 'confirm-batch-a-self',
    proposalId: item.proposals[0].id,
    recordId: reviewRecord.id,
    candidateVersionId: reviewRecord.candidateVersionId,
    resolutions: [{ issueId: identity.id, outcome: 'this_is_me', mapping: { subject: 'self' } }],
  });
  item = accept(f, item, [0], item.proposals[0].id);
  const batchB = {
    ...batch,
    version: item.version,
    operationId: 'batch-b',
    jsonlText: JSON.stringify(envelope('b', 'pages 2–3')),
    summary: 'Second artifact',
    coverage: [
      { unitId: plan.units[1].id, kind: 'extracted', notes: 'Artifact B; page 2 shared context' },
    ],
  };
  item = f.call('submitIntakeBatch', item.id, batchB);
  assert.equal(item.workflow.candidates.length, 2);
  assert.equal(item.pendingWorkCount, 0);
  assert.equal(item.pendingCount, 1);
  const backup = await createBackup(f.db, f.root, f.profileId),
    target = join(f.root, 'resumed'),
    rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
    db = openDatabase(rebuilt.database, f.profileId);
  try {
    assert.deepEqual(intake.getIntake(db, target, f.profileId, item.id).workflow, item.workflow);
    assert.deepEqual(intake.getIntakeOriginal(db, target, f.profileId, item.id).bytes, bytes);
  } finally {
    db.close();
  }
  item = f.call('submitIntakeBatch', item.id, {
    ...batch,
    version: item.version,
    operationId: 'batch-a-more',
    jsonlText: JSON.stringify(envelope('a', 'pages 1–2', { valueText: '12.000' })),
    summary: 'Later evidence',
  });
  const candidate = item.workflow.candidates.find((c) => c.envelopeId === 'a');
  assert.ok(candidate);
  assert.deepEqual(
    candidate.versions.map((v) => v.status),
    ['accepted', 'pending'],
  );
  assert.equal(f.db.prepare('SELECT value_text FROM observations').get()!.value_text, '12.00');
});
test('default PDF units retain dense partial batches and exact cross-boundary report context', async (t) => {
  const f = fixture(t),
    bytes = pdf();
  let item = f.upload(bytes, 'fictional-default-windows.pdf');
  item = await f.call('createIntakePlan', item.id, { version: item.version });
  const plan = item.workflow.plans[0]!;
  assert.deepEqual(
    plan.units.map((unit) => unit.pages),
    [[1, 2], [3]],
  );

  const context = {
    format: 'health-record-v1',
    id: 'context:fictional-report-fc-27',
    kind: 'context',
    payload: {
      contextId: 'fictional-report-fc-27',
      text: 'Fictional Clinic\nReport FC-27\nPrinted for Fictional Rowan Example',
    },
    provenance: {
      capturedVia: 'Fictional PDF',
      sourceSystem: 'Fictional issuer',
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator: 'page 1 report heading',
    },
    coverage: { status: 'complete_response', notes: [] },
    report: {
      key: 'fictional-report-fc-27',
      title: 'Fictional report FC-27',
      anchor: { locator: 'page 1 report heading', text: 'Report FC-27' },
      subject: { locator: 'page 1 patient', text: 'Fictional Rowan Example' },
    },
  };
  item = f.call('submitIntakeBatch', item.id, {
    version: item.version,
    planId: plan.id,
    operationId: 'fictional-dense-part-1',
    jsonlText: JSON.stringify(context),
    summary: 'Part 1 retains exact context while more supported rows remain.',
    coverage: [
      {
        unitId: plan.units[0]!.id,
        kind: 'inspected',
        notes: 'The target pages still have supported rows to retain.',
      },
    ],
  });
  assert.equal(item.workflow.plans[0]!.units[0]!.status, 'partial');
  assert.equal(item.pendingWorkCount, 2);

  const linked = (id: string, page: number) => ({
    ...envelope(id, `page ${page} result ${id}`),
    payload: { contextId: 'fictional-report-fc-27', literal: `${id}: 12.00 mg` },
    report: context.report,
  });
  item = f.call('submitIntakeBatch', item.id, {
    version: item.version,
    planId: plan.id,
    operationId: 'fictional-dense-part-2',
    jsonlText: [context, linked('fictional-page-two', 2)]
      .map((value) => JSON.stringify(value))
      .join('\n'),
    summary: 'Part 2 finishes the first exact target unit.',
    coverage: [
      {
        unitId: plan.units[0]!.id,
        kind: 'extracted',
        notes: 'All target pages and cursors in this unit are accounted for.',
      },
    ],
  });
  assert.equal(item.workflow.plans[0]!.units[0]!.status, 'completed');
  assert.deepEqual(item.workflow.plans[0]!.units[0]!.attempts, [
    'fictional-dense-part-1',
    'fictional-dense-part-2',
  ]);
  assert.equal(item.pendingWorkCount, 1);

  item = f.call('submitIntakeBatch', item.id, {
    version: item.version,
    planId: plan.id,
    operationId: 'fictional-boundary-part',
    jsonlText: [
      context,
      linked('fictional-page-three-linked', 3),
      envelope('fictional-page-three-unlinked', 'page 3 independent result'),
    ]
      .map((value) => JSON.stringify(value))
      .join('\n'),
    summary: 'The later unit repeats only the exact context its linked result references.',
    coverage: [
      {
        unitId: plan.units[1]!.id,
        kind: 'extracted',
        notes: 'The separate page target and its exact evidence are accounted for.',
      },
    ],
  });
  assert.equal(item.pendingWorkCount, 0);
  assert.equal(item.workflow.candidates.length, 3);
  assert.equal(item.workflow.reportGroups!.length, 2, 'adjacency never groups the unlinked row');
  const linkedGroup = item.workflow.reportGroups!.find(
    (group) => group.basis === 'report_anchor' && group.versions.at(-1)!.members.length === 2,
  );
  assert.ok(linkedGroup);
  const linkedCandidateIds = new Set(
    item.workflow.candidates
      .filter((candidate) =>
        ['fictional-page-two', 'fictional-page-three-linked'].includes(candidate.envelopeId),
      )
      .map((candidate) => candidate.id),
  );
  assert.deepEqual(
    new Set(linkedGroup.versions.at(-1)!.members.map((member) => member.candidateId)),
    linkedCandidateIds,
  );
  assert.equal(linkedGroup.versions.at(-1)!.context?.status, 'linked');
  assert.equal(linkedGroup.versions.at(-1)!.context?.contextId, 'fictional-report-fc-27');
  assert.equal(linkedGroup.report!.anchor.locator, 'page 1 report heading');

  const backup = await createBackup(f.db, f.root, f.profileId),
    target = join(f.root, 'default-window-resumed'),
    rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
    db = openDatabase(rebuilt.database, f.profileId);
  try {
    const recovered = intake.getIntake(db, target, f.profileId, item.id);
    assert.deepEqual(recovered.workflow, item.workflow);
    assert.deepEqual(recovered.workflow!.plans[0]!.units, item.workflow.plans[0]!.units);
    assert.deepEqual(intake.getIntakeOriginal(db, target, f.profileId, item.id).bytes, bytes);
  } finally {
    db.close();
  }
});
test('HTML windows retain literal rows, shared headings, surrounding text and missing dependencies without fetching', async (t) => {
  const f = fixture(t),
    html =
      '<html><script>fetch("https://never.example")</script><p>Before table</p><table><tr><th>Value (mg)</th></tr>' +
      Array.from({ length: 5 }, (_, i) => `<tr><td data-id="${i}">${i}.000</td></tr>`).join('') +
      '</table><p>After table</p><img src="missing.png"></html>';
  let item = f.upload(Buffer.from(html), 'report.html');
  const index = await indexIntakeEvidence({
    db: f.db,
    root: f.root,
    profileId: f.profileId,
    id: item.id,
  });
  assert.equal(index.kind, 'html');
  assert.ok(index.missingAssets && index.sections);
  assert.equal(index.missingAssets[0].status, 'not_supplied');
  assert.equal(index.sections.length, 3);
  item = await f.call('createIntakePlan', item.id, {
    version: item.version,
    unitSize: 3,
    overlap: 1,
  });
  type RowUnit = (typeof item.workflow.plans)[number]['units'][number] & {
    rows: number[];
  };
  const units = item.workflow.plans[0]!.units.filter(
    (candidate): candidate is RowUnit => 'rows' in candidate && Array.isArray(candidate.rows),
  );
  assert.equal(units[0]!.rows.at(-1), units[1]!.rows[0]);
  const unit = f.call('readIntakeUnit', item.id, units[1]!.id);
  assert.ok(typeof unit.text === 'string');
  assert.ok(unit.sharedHeadings);
  assert.match(unit.text, /2\.000/);
  assert.match(unit.sharedHeadings[0].text, /Value \(mg\)/);
  assert.deepEqual(f.call('getIntakeOriginal', item.id).bytes, Buffer.from(html));
});
test('batch failures preserve plan progress and changed mappings require an explicit replacement', async (t) => {
  const f = fixture(t);
  let item = f.upload(pdf(), 'guarded.pdf');
  item = await f.call('createIntakePlan', item.id, { version: item.version });
  const plan = item.workflow.plans[0],
    base = {
      version: item.version,
      planId: plan.id,
      operationId: 'batch-guard',
      jsonlText: JSON.stringify(envelope('a')),
      summary: 'Fictional',
      coverage: [{ unitId: plan.units[0].id, kind: 'extracted', notes: 'Read' }],
    };
  assert.throws(
    () => f.call('submitIntakeBatch', item.id, { ...base, jsonlText: 'not JSONL' }),
    (e: unknown) => e instanceof HttpError && e.code === 'INVALID_JSONL',
  );
  assert.equal(f.call('getIntake', item.id).workflow.plans[0].batches.length, 0);
  assert.throws(
    () =>
      f.call('submitIntakeBatch', item.id, {
        ...base,
        coverage: [{ unitId: 'foreign-unit', kind: 'extracted', notes: 'No' }],
      }),
    (e: unknown) => e instanceof HttpError && e.code === 'BATCH_COVERAGE',
  );
  item = f.call('submitIntakeBatch', item.id, base);
  base.version = item.version;
  const completed = structuredClone(item.workflow.plans[0]);
  const rule: Parameters<typeof previewMappingChange>[2] = {
      match: { kind: 'observation', label: 'Example' },
      set: { testLabel: 'Reviewed example' },
    },
    p = previewMappingChange(f.db, item.providerId, rule);
  applyMappingChange(f.db, f.root, f.profileId, {
    providerId: item.providerId,
    rule,
    previewToken: p.token,
    version: p.version,
    operationId: 'new-rule',
  });
  assert.throws(
    () => f.call('submitIntakeBatch', item.id, { ...base, operationId: 'after-config-change' }),
    (e: unknown) => e instanceof HttpError && e.code === 'EXTRACTION_CONFIG_CHANGED',
  );
  await assert.rejects(
    f.call('createIntakePlan', item.id, { version: item.version }),
    (e: unknown) => e instanceof HttpError && e.code === 'PLAN_CHANGED',
  );
  item = await f.call('createIntakePlan', item.id, {
    version: item.version,
    replacePlanId: plan.id,
  });
  assert.equal(item.workflow.plans.length, 2);
  assert.deepEqual(item.workflow.plans[0], { ...completed, status: 'superseded' });
  const backup = await createBackup(f.db, f.root, f.profileId),
    target = join(f.root, 'restored-plans'),
    rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
    db = openDatabase(rebuilt.database, f.profileId);
  try {
    const recovered = intake.getIntake(db, target, f.profileId, item.id);
    assert.deepEqual(recovered.workflow, item.workflow);
    assert.equal(recovered.proposals.length, 1);
    assert.deepEqual(intake.getIntakeOriginal(db, target, f.profileId, item.id).bytes, pdf());
  } finally {
    db.close();
  }
});
test('HTML evidence resolves only supplied sibling images and bounded long-row reads preserve offsets', async (t) => {
  const f = fixture(t),
    parent = f.upload(Buffer.from('Fictional archive parent'), 'parent.txt');
  const html =
    '<table><tr><th>mg</th></tr><tr><td>' +
    '12.000 '.repeat(6000) +
    '</td></tr></table><img src="image.png"><img src="https://never.example/absent.png">';
  const children = intake.retainIntakeChildren(f.db, f.root, f.profileId, parent.id, [
    { filename: 'report.html', locator: 'ZIP member report.html', bytes: Buffer.from(html) },
    {
      filename: 'image.png',
      locator: 'ZIP member image.png',
      bytes: Buffer.from('fictional image bytes'),
    },
  ]);
  let item = f.call('getIntake', children[0].id);
  assert.equal(item.parentSourceFileId, parent.id);
  const roots = intake.listIntakes(f.db, f.profileId, { rootOnly: true });
  assert.deepEqual(
    roots.data.map((file) => file.id),
    [parent.id],
  );
  assert.equal(roots.total, 1);
  assert.equal(intake.listIntakes(f.db, f.profileId).total, 3);
  const index = await indexIntakeEvidence({
    db: f.db,
    root: f.root,
    profileId: f.profileId,
    id: item.id,
  });
  assert.ok(index.missingAssets);
  assert.equal(index.missingAssets[0].status, 'supplied_uninspected');
  assert.equal(index.missingAssets[1].status, 'not_supplied');
  item = await f.call('createIntakePlan', item.id, { version: item.version });
  const unit = item.workflow.plans[0].units[0],
    first = f.call('readIntakeUnit', item.id, unit.id),
    next = f.call('readIntakeUnit', item.id, unit.id, { offset: first.nextOffset });
  assert.ok(typeof first.text === 'string' && typeof next.text === 'string');
  assert.equal(first.text.length, 24000);
  assert.equal(first.complete, false);
  assert.equal(first.text + next.text, html.slice(unit.start, unit.end));
});
test('question and plan API returns durable scoped workflow through existing response envelopes', async (t) => {
  const f = fixture(t),
    { createApp } = await import('../index.ts'),
    app = createApp({ root: f.root, databases: new Map([[f.profileId, f.db]]) });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => app.server.close(() => resolve())));
  let item = f.upload(Buffer.from(JSON.stringify(envelope('http'))));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/${f.profileId}/intakes/${encodeURIComponent(item.id)}`;
  const post = async (action: string, body: unknown): Promise<TestIntake> => {
    const response = await fetch(base + '/' + action, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return (await response.json()).data as TestIntake;
  };
  item = await post('questions', {
    version: item.version,
    key: 'http-question',
    candidateId: item.workflow.candidates[0].id,
    prompt: 'Confirm evidence?',
    locator: 'page 1',
  });
  assert.equal(item.needsReview, true);
  item = await post('answers', {
    version: item.version,
    operationId: 'http-answer',
    questionId: item.workflow.questions[0].id,
    answer: 'Checked against the original',
  });
  assert.equal(item.workflow.questions[0].status, 'answered');
  item = await post('plan', { version: item.version });
  const plan = (await (await fetch(base + '/plan')).json()).data;
  assert.equal(plan.intakeId, item.id);
  assert.equal(plan.plans[0].id, item.workflow.plans[0].id);
});
