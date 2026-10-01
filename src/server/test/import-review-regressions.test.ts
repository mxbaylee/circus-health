import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import * as intake from '../intake.ts';
import { vaultFixture, newProfile } from './helpers/vault-fixture.ts';
import type { TestContext } from 'node:test';
import type { Database } from '../database.ts';

type IntakeFunctionName = {
  [K in keyof typeof intake]: (typeof intake)[K] extends (...args: never[]) => unknown ? K : never;
}[keyof typeof intake];
type IntakeFunction<K extends IntakeFunctionName> = Extract<
  (typeof intake)[K],
  (...args: never[]) => unknown
>;
type BoundArguments<F> = F extends (
  db: Database,
  root: string,
  profileId: string,
  ...args: infer Arguments
) => unknown
  ? Arguments
  : never;
type BoundIntakeCall = <K extends IntakeFunctionName>(
  name: K,
  ...args: BoundArguments<IntakeFunction<K>>
) => ReturnType<IntakeFunction<K>>;
const bindIntake = (db: () => Database, root: () => string, profileId: string): BoundIntakeCall =>
  ((name: IntakeFunctionName, ...args: unknown[]) => {
    const fn = intake[name] as (...parameters: unknown[]) => unknown;
    return fn(db(), root(), profileId, ...args);
  }) as BoundIntakeCall;

function fixture(
  t: TestContext,
  clinical: Record<string, unknown> = {},
  envelope: Record<string, unknown> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'circus-review-regression-'));
  const profileId = 'cookie-dough';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = bindIntake(
    () => db,
    () => root,
    profileId,
  );
  const item = call('uploadIntake', {
    filename: 'fictional.jsonl',
    bytes: Buffer.from(
      JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-report',
        kind: 'document',
        payload: { text: 'Fictional eye report' },
        coverage: { status: 'partial', notes: [] },
        provenance: {
          capturedVia: 'Fictional export',
          sourceSystem: null,
          sourceRecordId: null,
          evidenceClass: 'transcription',
          locator: 'page 1',
        },
        clinical: {
          kind: 'document',
          subject: 'self',
          documentTitle: 'Fictional report',
          documentDate: '2026-08-01',
          ...clinical,
        },
        ...envelope,
      }),
    ),
  });
  function save(
    item: { id: string; version: number },
    record: ReturnType<typeof intake.reviewIntake>['records'][number],
    extra: Record<string, unknown> = {},
  ) {
    assert.ok(record.candidateVersionId);
    return call('saveIntakeReviewDraft', item.id, {
      version: item.version,
      operationId: 'draft-' + item.version,
      proposalId: null,
      recordId: record.id,
      candidateVersionId: record.candidateVersionId,
      ...extra,
    });
  }
  return { call, item, save, db };
}

test('an optical review draft accepts equivalent mapping values after a browser JSON round trip', (t) => {
  const opticalPrescription = {
    type: 'spectacle',
    eyes: [
      { side: 'right', sph: { valueText: '-1.00' } },
      { side: 'left', sph: { valueText: '-1.25' } },
    ],
  };
  const f = fixture(t, { opticalPrescription });
  let review = f.call('reviewIntake', f.item.id);
  const firstRecord = review.records[0];
  assert.ok(firstRecord);
  const item = f.save(f.item, firstRecord, { mapping: firstRecord.mapping });
  review = f.call('reviewIntake', item.id);
  const request = JSON.parse(
    JSON.stringify({
      version: review.version,
      reviewToken: review.reviewToken,
      proposalId: null,
      decisions: [{ recordId: firstRecord.id, action: 'accept', mapping: firstRecord.mapping }],
    }),
  );
  const changed = structuredClone(request);
  changed.decisions[0].mapping.opticalPrescription.eyes[0].sph.valueText = '-9.00';
  assert.throws(() => f.call('importIntake', item.id, changed), {
    code: 'ANSWER_REVIEW_REQUIRED',
  });
  const accepted = f.call('importIntake', item.id, request);
  assert.equal(accepted.pendingCount, 0);
  assert.deepEqual(
    JSON.parse(String(f.db.prepare('SELECT extra_json FROM documents').get()?.extra_json)).import
      .acceptedMapping.opticalPrescription,
    opticalPrescription,
  );
});

test('autosaving a hydrated resolution does not duplicate earlier answers or resolution history', (t) => {
  const f = fixture(t, { uncertainties: ['Confirm the printed title'] });
  let review = f.call('reviewIntake', f.item.id);
  const initialRecord = review.records[0];
  assert.ok(initialRecord);
  const issue = initialRecord.issues?.find((i) => i.questionId);
  assert.ok(issue);
  let item = f.save(f.item, initialRecord, {
    resolutions: [{ issueId: issue.id, outcome: 'confirmed' }],
  });
  for (let index = 0; index < 8; index++) {
    review = f.call('reviewIntake', item.id);
    const record = review.records[0];
    assert.ok(record?.draft);
    item = f.save(item, record, {
      mapping: { documentTitle: 'Reviewed title ' + index },
      resolutions: JSON.parse(JSON.stringify(record.draft.resolutions)),
    });
  }
  review = f.call('reviewIntake', item.id);
  assert.equal(review.records[0]?.draft?.resolutions.length, 1);
  assert.equal(item.workflow?.questions[0]?.answers.length, 1);
});

test('reloaded unconfirmed dates remain saveable, and changed resolutions retain their history', (t) => {
  const f = fixture(t);
  let record = f.call('reviewIntake', f.item.id).records[0];
  assert.ok(record?.candidateVersionId);
  assert.ok(record.evidence[0]);
  let item = f.call('askIntakeQuestion', f.item.id, {
    version: f.item.version,
    key: 'explicit-printed-date',
    prompt: 'Confirm the printed date',
    field: 'date',
    candidateId: record.candidateId,
    candidateVersionId: record.candidateVersionId,
    locator: record.evidence[0].locator,
  });
  record = f.call('reviewIntake', item.id).records[0];
  assert.ok(record);
  const issue = record.issues?.find((i) => i.questionId);
  assert.ok(issue);
  item = f.save(item, record, {
    resolutions: [{ issueId: issue.id, outcome: 'unknown' }],
  });
  record = f.call('reviewIntake', item.id).records[0];
  assert.ok(record?.draft);
  item = f.save(item, record, { resolutions: record.draft.resolutions });
  record = f.call('reviewIntake', item.id).records[0];
  assert.ok(record?.draft);
  assert.equal(record.draft.resolutions.length, 1);
  assert.equal(record.mapping.documentDate, '');
  item = f.save(item, record, {
    resolutions: [
      { issueId: issue.id, outcome: 'corrected', mapping: { documentDate: '2026-08-02' } },
    ],
  });
  record = f.call('reviewIntake', item.id).records[0];
  assert.ok(record?.draft);
  assert.deepEqual(
    record.draft.resolutions.map((r) => r.outcome),
    ['unknown', 'corrected'],
  );
  item = f.save(item, record, {
    resolutions: record.draft.resolutions,
    mapping: { documentDate: '2026-08-03' },
  });
  record = f.call('reviewIntake', item.id).records[0];
  assert.ok(record?.draft);
  assert.equal(
    record.mapping.documentDate,
    '2026-08-03',
    'old corrections are not reapplied over newer edits',
  );
  assert.equal(record.draft.resolutions.length, 2);
  assert.equal(item.workflow?.questions[0]?.answers.length, 1);
  assert.equal(
    record.issues?.find((candidate) => candidate.id === issue.id)?.status,
    'unresolved',
    'the old answer cannot approve a newer corrected date',
  );
  assert.equal(
    record.questions?.find((question) => question.id === issue.id)?.status,
    'unanswered',
  );
});

test('This is me retains a top-level document payload through reviewed acceptance', (t) => {
  const payload = { text: 'Fictional literal reading 01.00', extra: 'Unmapped source detail' };
  const f = fixture(t, {}, { clinical: undefined, subject: 'unknown', payload });
  let record = f.call('reviewIntake', f.item.id).records[0];
  assert.ok(record);
  assert.equal(record.mapping.text, JSON.stringify(payload));
  const item = f.save(f.item, record, {
    resolutions: (record.issues ?? [])
      .filter((i) => i.kind === 'identity')
      .map((i) => ({ issueId: i.id, outcome: 'this_is_me' })),
  });
  const review = f.call('reviewIntake', item.id);
  f.call('importIntake', item.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: record.id, action: 'accept', mapping: {} }],
  });
  assert.equal(
    f.db.prepare('SELECT text_content FROM documents').get()?.text_content,
    JSON.stringify(payload),
  );
});

test('a rebuilt encrypted optical draft remains editable and accepts without losing source attribution', async (t) => {
  const f = vaultFixture(t);
  const { profile, recoveryKit } = await newProfile(f.manager, 'Fictional optical review');
  let state = f.manager.opened.get(profile.id);
  const opened = () => {
    if (!state) throw new Error('Expected the fictional profile to be open');
    return state;
  };
  const call = bindIntake(
    () => opened().db,
    () => opened().root,
    profile.id,
  );
  const opticalPrescription = {
    type: 'spectacle',
    eyes: [{ side: 'right', sph: { valueText: '+01.00' } }],
  };
  const bytes = Buffer.from(
    JSON.stringify({
      format: 'health-record-v1',
      id: 'fictional-optical',
      kind: 'document',
      payload: 'Fictional optical source',
      clinical: {
        kind: 'document',
        subject: 'self',
        documentTitle: 'Fictional optical report',
        opticalPrescription,
        uncertainties: ['Confirm the printed date'],
      },
      provenance: {
        capturedVia: 'Fictional acquisition',
        sourceSystem: null,
        sourceRecordId: null,
        evidenceClass: 'transcription',
        locator: 'page 1',
      },
      coverage: { status: 'partial', notes: [] },
    }),
  );
  let item: { id: string; version: number } = call('uploadIntake', {
    filename: 'fictional-optical.jsonl',
    bytes,
  });
  item = call('updateIntakeMetadata', item.id, {
    version: item.version,
    operationId: 'reviewed-issuer',
    metadata: { source: 'Fictional Optical Issuer' },
  });
  let review = call('reviewIntake', item.id);
  let record = review.records[0];
  assert.ok(record?.candidateVersionId);
  item = call('saveIntakeReviewDraft', item.id, {
    version: item.version,
    operationId: 'optical-draft',
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId,
    disposition: 'review_later',
    mapping: record.mapping,
    resolutions: (record.issues ?? [])
      .filter((i) => i.kind === 'date')
      .map((i) => ({ issueId: i.id, outcome: 'unknown' })),
  });
  const rebuild = () => {
    f.manager.lock(profile.id);
    rmSync(join(f.dataDirectory, 'profiles', profile.id, 'cache'), {
      recursive: true,
      force: true,
    });
    f.manager.unlock(profile.id, recoveryKit);
    state = f.manager.opened.get(profile.id);
    assert.equal(opened().metrics.cacheHit, false);
  };
  rebuild();
  review = call('reviewIntake', item.id);
  record = review.records[0];
  assert.ok(record?.draft);
  assert.equal(record.draft.disposition, 'review_later');
  item = call(
    'saveIntakeReviewDraft',
    item.id,
    JSON.parse(
      JSON.stringify({
        version: review.version,
        operationId: 'resume-optical',
        proposalId: null,
        recordId: record.id,
        candidateVersionId: record.candidateVersionId,
        mapping: record.mapping,
        resolutions: record.draft.resolutions,
      }),
    ),
  );
  review = call('reviewIntake', item.id);
  call(
    'importIntake',
    item.id,
    JSON.parse(
      JSON.stringify({
        version: review.version,
        reviewToken: review.reviewToken,
        decisions: [{ recordId: record.id, action: 'accept', mapping: review.records[0]?.mapping }],
      }),
    ),
  );
  const before = opened().db.prepare('SELECT * FROM documents').get();
  assert.ok(before);
  assert.equal(typeof before.extra_json, 'string');
  assert.equal(
    JSON.parse(String(before.extra_json)).import.reviewedSourceMetadata.source,
    'Fictional Optical Issuer',
  );
  assert.equal(call('getIntake', item.id).acquisition?.provider, 'Unknown source');
  rebuild();
  assert.deepEqual(opened().db.prepare('SELECT * FROM documents').get(), before);
  assert.deepEqual(call('getIntakeOriginal', item.id).bytes, bytes);
  assert.deepEqual(
    call('reviewIntake', item.id).records[0]?.draft?.resolutions,
    review.records[0]?.draft?.resolutions,
  );
});
