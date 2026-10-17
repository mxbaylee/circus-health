import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { uploadIntake, reviewIntake } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  prepareIntakeEnvelopeFieldMutation,
  stageIntakeEnvelopeFieldMutation,
} from '../intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { buildVerifiedWorkflowSummary } from '../intake-workflow-state.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import { readNativeReviewDraft } from '../intake-review-draft-state.ts';
import { reviewDraftResolutions } from '../intake-review-draft-selection.ts';
import { canonicalReviewValueChunks } from '../intake-review-question-state.ts';
import { selectionAuthority } from '../intake-selection-authority.ts';
import { canonicalLiteral } from '../intake-format.ts';
import { workflowHash } from '../intake-workflow.ts';

const hash = (value: unknown) => {
  const digest = createHash('sha256');
  for (const chunk of canonicalReviewValueChunks(value)) digest.update(chunk);
  return digest.digest('hex');
};

test('adopted legacy draft canonical evidence retains complete history and refuses same-count changes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-legacy-draft-canonical-')),
    profileId = 'fictional',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional.jsonl',
    bytes: Buffer.from(
      JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-record',
        kind: 'record',
        payload: { literal: 'Fictional complete draft history' },
        clinical: { kind: 'document', subject: 'self', documentTitle: 'Fictional history' },
        provenance: {
          sourceSystem: 'Fictional clinic',
          sourceRecordId: 'fictional-record',
          capturedVia: null,
          evidenceClass: 'provider_export',
          locator: 'line 1',
        },
        coverage: { status: 'complete_response', notes: [] },
      }),
    ),
  });
  const record = reviewIntake(db, root, profileId, source.id).records[0]!;
  const historical = {
    id: 'fictional-legacy-draft',
    proposalId: null,
    recordId: record.id,
    candidateId: record.candidateId!,
    candidateVersionId: record.candidateVersionId!,
    mapping: {},
    disposition: 'pending' as const,
    at: '2026-01-01',
    resolutions: ['confirmed', 'confirmed', 'unknown'].map((outcome, index) => ({
      issueId: 'fictional-issue',
      outcome,
      at: '2026-01-01',
      operationId: 'fictional-resolution-' + index,
      retainedReason: 'Fictional reason ' + index,
      retainedNumber: JSON.rawJSON('12.00'),
    })),
    corrections: [
      {
        operationId: 'fictional-correction',
        at: '2026-01-01',
        reason: 'Fictional corrected title',
        before: { documentTitle: 'Fictional old title' },
        after: { documentTitle: 'Fictional history' },
      },
    ],
    retainedUnknown: { number: JSON.rawJSON('1.200e+1'), note: 'Fictional unknown authority' },
  };
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  const initial = openIntakeCollectionEnvelope(db, { id: source.id }),
    operationId = randomUUID();
  const inserted = await prepareIntakeEnvelopeMutation(
    db,
    { id: source.id },
    {
      reader: initial,
      operationId,
      requestDigest: workflowHash(operationId),
      domainVersion: initial.logical.domainVersion,
      changes: [
        {
          op: 'append',
          record: initial.child(initial.child(initial.root(), 'intake')!, 'workflow')!,
          field: 'reviewDrafts',
          jsonText: JSON.stringify(historical),
        },
      ],
    },
  );
  transaction(db, () =>
    selectedEnvelopeStore(db, { id: source.id }).collections.stage(inserted.prepared!),
  );
  const read = async () => {
    await buildVerifiedWorkflowSummary(
      db,
      { id: source.id },
      {
        mappingVersion: 'fictional',
        isSourceContextVersion: () => false,
      },
    );
    const view = openIntakeCollectionEnvelope(db, { id: source.id }),
      flow = view.child(view.child(view.root(), 'intake')!, 'workflow')!,
      retained = view.childAt(flow, 'reviewDrafts', 0)!,
      draft = readNativeReviewDraft(
        view,
        retained,
        createReportSnapshotCatalog(db, { id: source.id }, { catalog: 'review.snapshots' }),
        8192,
        { db, source: { id: source.id } },
      );
    return { view, retained, draft };
  };
  let selected = await read();
  assert.equal(
    selected.draft.resolutions.length,
    2,
    'policy still uses only latest and last-known witnesses',
  );
  assert.equal(selected.draft.history!.resolutions, 3);
  assert.equal(selected.draft.history!.corrections, 1);
  assert.equal(
    selected.draft.corrections,
    undefined,
    'presentation is bounded independently of token history',
  );
  assert.equal(
    hash(selected.draft),
    hash(historical),
    'complete inline legacy canonical recipe remains exact',
  );
  const token = (draft: unknown) => selectionAuthority({ record: { draft } });
  assert.equal(token(selected.draft), token(historical));
  assert.match(canonicalLiteral(historical), /"retainedNumber":12\.00/);

  for (const mutation of ['nonwitness', 'witness', 'correction', 'unknown literal'] as const) {
    const before = selected,
      previousHash = hash(before.draft),
      previousToken = token(before.draft),
      policy = canonicalLiteral([...reviewDraftResolutions(before.draft)]),
      target =
        mutation === 'nonwitness' || mutation === 'witness'
          ? before.view.childAt(before.retained, 'resolutions', mutation === 'nonwitness' ? 0 : 1)!
          : mutation === 'correction'
            ? before.view.childAt(before.retained, 'corrections', 0)!
            : before.retained,
      field =
        mutation === 'nonwitness' || mutation === 'witness'
          ? 'retainedReason'
          : mutation === 'correction'
            ? 'reason'
            : 'retainedUnknown',
      jsonText =
        mutation === 'unknown literal'
          ? '{"number":12.00,"note":"Fictional unknown authority"}'
          : JSON.stringify('Fictional changed ' + mutation),
      changedId = randomUUID();
    const prepared = prepareIntakeEnvelopeFieldMutation(
      db,
      { id: source.id },
      {
        reader: before.view,
        record: target,
        field,
        jsonText,
        operationId: changedId,
        requestDigest: workflowHash(changedId),
        domainVersion: before.view.logical.domainVersion,
      },
    );
    transaction(db, () => stageIntakeEnvelopeFieldMutation(db, { id: source.id }, prepared));
    assert.throws(() => hash(before.draft), /changed|stale/i);
    selected = await read();
    assert.equal(selected.draft.history!.resolutions, 3);
    assert.equal(selected.draft.history!.corrections, 1);
    assert.notEqual(
      hash(selected.draft),
      previousHash,
      mutation + ' remains in complete review authority',
    );
    assert.notEqual(
      token(selected.draft),
      previousToken,
      mutation + ' requires fresh selected approval',
    );
    if (mutation !== 'witness')
      assert.equal(
        canonicalLiteral([...reviewDraftResolutions(selected.draft)]),
        policy,
        'unchanged policy witnesses cannot hide an edit to retained history',
      );
  }
});
