import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Asset, Note, NoteHistory, Observation } from '../shared/api.ts';
import type {
  HealthRecordEnvelope,
  IntakeReview,
  IntakeReportAcceptanceResult,
} from '../shared/intake.ts';
import type { IntakeRead } from '../shared/intake-summary.ts';
import { isIntakeSummary } from '../shared/intake-summary.ts';
import { readQualificationReview } from './qualification-intake-read.ts';
import type { IntakeBatch } from '../shared/intake-batch.ts';
import type { OwnershipPreview, OwnershipReceipt } from '../shared/record-ownership.ts';
import type {
  RecordCorrectionApplyResult,
  RecordCorrectionPreview,
} from '../shared/record-correction.ts';
import type { RecoveryKit } from '../server/vault-crypto.ts';
import type { PersonalDurabilityStatus } from '../server/portable.ts';
import type { clinicalRecordHistory } from '../server/clinical-history.ts';

/** The adapter unwraps API data and maintains only its installation's HTTP session. */
export interface ArchiveRestoreRequest {
  <T>(
    path: string,
    options?: {
      method?: string;
      json?: unknown;
      bytes?: Buffer;
      headers?: Record<string, string>;
      binary?: boolean;
    },
  ): Promise<T>;
}

type PublishedNoteHistory = NoteHistory & { durability: PersonalDurabilityStatus };
type ClinicalHistory = ReturnType<typeof clinicalRecordHistory>;
interface OriginalExpectation {
  contentUrl: string;
  bytesBase64: string;
  sha256: string;
  bytes: number;
}

/** Independently fictional, bounded evidence. Keep this and the kit outside Git/logs. */
export interface ArchiveRestoreOracle {
  format: 'circus-fictional-archive-restore-v2';
  profileId: string;
  self: Note;
  person: Note;
  note: Note;
  noteHistory: PublishedNoteHistory;
  observations: Observation[];
  histories: ClinicalHistory[];
  originals: OriginalExpectation[];
  acceptedIntakes: IntakeRead[];
  ownershipReceipt: OwnershipReceipt;
  fieldCorrection: RecordCorrectionApplyResult;
  acceptanceReceipts: IntakeReportAcceptanceResult['receipt'][];
  pending: { intake: IntakeRead; review: IntakeReview };
  stopped: { intake: IntakeRead; batch: IntakeBatch };
}

function check(condition: unknown, message: string): asserts condition {
  // Avoid assertion libraries' actual/expected dumps of private recovery evidence.
  if (!condition) throw new Error('Fictional archive restore: ' + message);
}
function equal(actual: unknown, expected: unknown, message: string) {
  check(isDeepStrictEqual(actual, expected), message);
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const encoded = encodeURIComponent;
const pathFor = (profileId: string) => '/api/profiles/' + encoded(profileId);
const isoTime = (value: string) => Number.isFinite(Date.parse(value));

function envelope(id: string, label: string, value: string): HealthRecordEnvelope {
  return {
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: { literal: value },
    clinical: {
      kind: 'observation',
      subject: 'self',
      testLabel: label,
      valueText: value,
      unit: 'cm',
      date: '2026-01-12',
    },
    provenance: {
      capturedVia: null,
      sourceSystem: 'Fictional Restore Clinic',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'Fictional restore row ' + id,
    },
    coverage: { status: 'complete_response', notes: [] },
  };
}

function originalExpectation(contentUrl: string, bytes: Buffer): OriginalExpectation {
  return {
    contentUrl,
    bytesBase64: bytes.toString('base64'),
    bytes: bytes.length,
    sha256: digest(bytes),
  };
}

function noteHistoryAuthority(history: PublishedNoteHistory) {
  const { currentRevision: _currentRevision, durability, ...authority } = history;
  check(
    durability.configured &&
      !durability.dirty &&
      !durability.conflicted &&
      durability.lastError === null,
    'note history has been durably published',
  );
  // The installation revision and publication status are live diagnostics.
  // Entry revisions, generation IDs, actors, values and lineage remain exact.
  return authority;
}

function reviewAuthority(review: IntakeReview) {
  const { reviewToken: _reviewToken, records, ...authority } = review;
  // Request tokens certify a live command against the installation revision.
  // Compare every retained candidate, draft and pair-context field separately.
  return {
    ...authority,
    records: records.map((record) => ({
      ...record,
      ...(record.comparisons
        ? {
            comparisons: record.comparisons.map((comparison) => {
              if (comparison.scope?.format !== 'intake-pair-scope-v2') return comparison;
              const {
                requestRevision: _requestRevision,
                token: _token,
                ...scope
              } = comparison.scope;
              return { ...comparison, scope };
            }),
          }
        : {}),
    })),
  };
}

function intakeAuthority(intake: IntakeRead) {
  const { durability, ...authority } = intake;
  // These are installation-wide publication counters, not source history. A
  // later read can publish another prepared index without changing this intake.
  check(
    !durability.pending &&
      durability.error === null &&
      durability.persistedRevision >= durability.mutationRevision,
    'intake authority has been durably published',
  );
  return authority;
}

function batchAuthority(batch: IntakeBatch): IntakeBatch {
  return {
    ...batch,
    // queuedAt is runtime queue-delay diagnostics, reconstructed on hydration.
    // Stop intent, source identity, activity history and accepted timestamps remain exact.
    items: batch.items.map(({ queuedAt: _queuedAt, ...item }) => item),
  };
}

/** Uses public APIs only; the caller must provide an unavailable, unpaid model route. */
export async function seedArchiveRestoreFixture(request: ArchiveRestoreRequest) {
  const setup = await request<{ setupId: string; profileId: string; recoveryKit: RecoveryKit }>(
    '/api/profile-setups',
    {
      method: 'POST',
      json: {
        name: 'Fictional Restore Cedar',
        fullName: 'Fictional Restore Cedar',
        birthDate: '1982-04-17',
        placebo: false,
      },
    },
  );
  const profile = await request<{ id: string }>(
    '/api/profile-setups/' + encoded(setup.setupId) + '/verify',
    { method: 'POST', json: { acknowledged: true, recovery: setup.recoveryKit } },
  );
  equal(profile.id, setup.profileId, 'fresh verified profile identity');
  const path = pathFor(profile.id);
  const originals: OriginalExpectation[] = [];
  const upload = async (filename: string, bytes: Buffer, mimeType = 'application/x-ndjson') => {
    const intake = await request<IntakeRead>(path + '/intakes', {
      method: 'POST',
      bytes,
      headers: {
        'Content-Type': mimeType,
        'X-Filename': encoded(filename),
        'X-Source-Name': encoded('Fictional Restore Clinic'),
      },
    });
    equal(intake.sha256, digest(bytes), 'uploaded original hash');
    originals.push(originalExpectation(intake.contentUrl, bytes));
    // Uploads also retain automatic enqueue intent. Stop it before fixture edits;
    // never ask the unavailable route to process independently authored JSONL.
    for (const batch of await request<IntakeBatch[]>(path + '/intake-batches'))
      if (batch.status !== 'stopped')
        await request(path + '/intake-batches/' + encoded(batch.id) + '/stop', {
          method: 'POST',
          json: {},
        });
    return intake;
  };
  const person = await request<Note>(path + '/notes', {
    method: 'POST',
    json: {
      kind: 'person',
      title: 'Fictional Restore Robin',
      person: { fullName: 'Fictional Restore Robin', birthDate: '1990-03-21' },
    },
  });
  check(
    person.personId && person.personId !== 'patient',
    'managed person has independent identity',
  );
  const accepted = [] as IntakeRead[];
  const observations = [] as Observation[];
  const acceptanceReceipts: IntakeReportAcceptanceResult['receipt'][] = [];
  for (const [id, label, value] of [
    ['self', 'Fictional Self reach', '12.00'],
    ['managed', 'Fictional Managed reach', '18.00'],
  ]) {
    const intake = await upload(
      'fictional-' + id + '.jsonl',
      Buffer.from(JSON.stringify(envelope(id!, label!, value!)) + '\n'),
    );
    const review = await readQualificationReview(
      request,
      path + '/intakes/' + encoded(intake.id) + '/review',
    );
    equal(review.records.length, 1, 'exact authored candidate count');
    equal(review.records[0]!.mapping.valueText, value, 'candidate original literal');
    const selected = review.records[0]!;
    check(selected.candidateId && selected.candidateVersionId, 'candidate version is explicit');
    const imported = await request<IntakeReportAcceptanceResult>(
      path + '/intakes/report-acceptance',
      {
        method: 'POST',
        json: {
          operationId: randomUUID(),
          blocks: [
            {
              intakeId: intake.id,
              proposalId: review.proposalId,
              intakeVersion: review.version,
              reviewToken: review.reviewToken,
              selections: [
                {
                  recordId: selected.id,
                  candidateId: selected.candidateId,
                  candidateVersionId: selected.candidateVersionId,
                  mapping: {},
                },
              ],
            },
          ],
        },
      },
    );
    equal(imported.receipt.acceptedCount, 1, 'explicit acceptance adds one observation');
    equal(imported.receipt.receipts.length, 1, 'one source acceptance receipt');
    const acceptedRecord = imported.receipt.receipts[0]!.records[0];
    check(
      acceptedRecord?.kind === 'observation' && acceptedRecord.outcome === 'added',
      'new accepted observation receipt',
    );
    const entityId = acceptedRecord.entityId;
    acceptanceReceipts.push(imported.receipt);
    check(entityId, 'accepted record identity returned');
    const observation = await request<Observation>(path + '/tests/' + encoded(entityId));
    equal(observation.personId, 'patient', 'initial acceptance belongs to Self');
    equal(observation.label, label, 'accepted label');
    equal(observation.valueText, value, 'accepted original literal');
    equal(observation.unit, 'cm', 'accepted original unit');
    equal(observation.date, '2026-01-12', 'accepted original date');
    accepted.push(await request<IntakeRead>(path + '/intakes/' + encoded(intake.id)));
    observations.push(observation);
  }
  const managed = observations[1]!;
  const ownershipReason = 'Fictional source belongs to the managed person.';
  const ownershipPreview = await request<OwnershipPreview>(path + '/record-ownership/preview', {
    method: 'POST',
    json: {
      selection: { type: 'records', records: [{ kind: 'observation', recordId: managed.id }] },
      destination: { noteId: person.id, expectedVersion: person.version },
      reason: ownershipReason,
    },
  });
  equal(ownershipPreview.blockers, [], 'ownership review has no blockers');
  const ownershipReceipt = await request<OwnershipReceipt>(path + '/record-ownership', {
    method: 'POST',
    json: {
      operationId: randomUUID(),
      request: ownershipPreview.request,
      version: ownershipPreview.version,
      scopeToken: ownershipPreview.scopeToken,
    },
  });
  equal(ownershipReceipt.moved, 1, 'one explicitly moved accepted record');
  equal(ownershipReceipt.destinationPersonId, person.personId, 'move destination');
  check(isoTime(ownershipReceipt.at), 'ownership receipt records time');
  const correctionReason = 'Fictional source supports the literal 19.00 cm.';
  const correctionPreview = await request<RecordCorrectionPreview>(
    path + '/clinical-review/correction-preview',
    {
      method: 'POST',
      json: {
        kind: 'observation',
        recordId: managed.id,
        set: { valueText: '19.00' },
        reason: correctionReason,
      },
    },
  );
  equal(correctionPreview.before.valueText, '18.00', 'field correction pins prior literal');
  equal(correctionPreview.after.valueText, '19.00', 'field correction pins accepted literal');
  check(
    correctionPreview.evidence.some((entry) => entry.sourceFileId === accepted[1]!.id),
    'field correction retains original source',
  );
  const fieldCorrection = await request<RecordCorrectionApplyResult>(
    path + '/clinical-review/correction-apply',
    {
      method: 'POST',
      json: {
        ...correctionPreview.request,
        operationId: randomUUID(),
        version: correctionPreview.version,
        previewToken: correctionPreview.previewToken,
      },
    },
  );
  equal(fieldCorrection.sourceUnchanged, true, 'correction preserves source authority');
  equal(
    fieldCorrection.receipt.result.reason,
    correctionReason,
    'field correction reason retained',
  );
  const note = await request<Note>(path + '/notes', {
    method: 'POST',
    json: {
      title: 'Fictional restore context',
      content: 'Fictional note before correction.',
      links: [
        { targetType: 'person', targetId: person.personId },
        { targetType: 'observation', targetId: managed.id },
      ],
    },
  });
  await request(path + '/notes/' + encoded(note.id), {
    method: 'PUT',
    json: {
      ...note,
      content: 'Fictional note after correction.',
      links: note.links.map((link) => ({
        targetType: link.targetType,
        targetId: link.targetId,
        relation: link.relation,
      })),
    },
  });
  const attachmentBytes = Buffer.from(
    '%PDF-1.4\nFictional restore attachment: retained text only.\n%%EOF\n',
  );
  const asset = await request<Asset>(path + '/assets', {
    method: 'POST',
    bytes: attachmentBytes,
    headers: {
      'Content-Type': 'application/pdf',
      'X-Filename': encoded('fictional-restore-attachment.pdf'),
    },
  });
  equal(asset.sha256, digest(attachmentBytes), 'attachment original hash');
  originals.push(originalExpectation(asset.contentUrl, attachmentBytes));
  const editedNote = await request<Note>(path + '/notes/' + encoded(note.id));
  await request(path + '/attachments', {
    method: 'POST',
    json: {
      assetId: asset.id,
      ownerType: 'note',
      ownerId: note.id,
      version: editedNote.version,
      caption: 'Fictional retained attachment',
      personId: person.personId,
    },
  });
  const pending = await upload(
    'fictional-review-later.jsonl',
    Buffer.from(JSON.stringify(envelope('pending', 'Fictional Pending reach', '23.00')) + '\n'),
  );
  const pendingReview = await readQualificationReview(
    request,
    path + '/intakes/' + encoded(pending.id) + '/review',
  );
  equal(pendingReview.records.length, 1, 'one pending candidate');
  equal(pendingReview.records[0]!.mapping.valueText, '23.00', 'pending literal');
  check(pendingReview.records[0]!.candidateVersionId, 'pending candidate pins version');
  await request(path + '/intakes/' + encoded(pending.id) + '/review-draft', {
    method: 'POST',
    json: {
      version: pendingReview.version,
      operationId: randomUUID(),
      proposalId: pendingReview.proposalId,
      recordId: pendingReview.records[0]!.id,
      candidateVersionId: pendingReview.records[0]!.candidateVersionId,
      mapping: { valueText: '23.00' },
      disposition: 'review_later',
    },
  });
  const stopped = await upload(
    'fictional-explicit-stop.txt',
    Buffer.from('Fictional stopped original. No clinical acceptance or inference requested.\n'),
    'text/plain',
  );
  const batch = await request<IntakeBatch>(path + '/intake-batches', {
    method: 'POST',
    json: { operationId: randomUUID(), intakeIds: [stopped.id] },
  });
  await request(path + '/intake-batches/' + encoded(batch.id) + '/stop', {
    method: 'POST',
    json: {},
  });
  const oracle: ArchiveRestoreOracle = {
    format: 'circus-fictional-archive-restore-v2',
    profileId: profile.id,
    self: await request<Note>(path + '/notes/patient'),
    person: await request<Note>(path + '/notes/' + encoded(person.id)),
    note: await request<Note>(path + '/notes/' + encoded(note.id)),
    noteHistory: await request<PublishedNoteHistory>(
      path + '/notes/' + encoded(note.id) + '/history',
    ),
    observations: await Promise.all(
      observations.map((row) => request<Observation>(path + '/tests/' + encoded(row.id))),
    ),
    histories: await Promise.all(
      observations.map((row) =>
        request<ClinicalHistory>(
          path +
            '/record-history?' +
            new URLSearchParams({ kind: 'observation', recordId: row.id }),
        ),
      ),
    ),
    originals,
    ownershipReceipt,
    fieldCorrection,
    acceptanceReceipts,
    acceptedIntakes: await Promise.all(
      accepted.map((item) => request<IntakeRead>(path + '/intakes/' + encoded(item.id))),
    ),
    pending: {
      intake: await request<IntakeRead>(path + '/intakes/' + encoded(pending.id)),
      review: await readQualificationReview(
        request,
        path + '/intakes/' + encoded(pending.id) + '/review',
      ),
    },
    stopped: {
      intake: await request<IntakeRead>(path + '/intakes/' + encoded(stopped.id)),
      batch: batchAuthority(
        await request<IntakeBatch>(path + '/intake-batches/' + encoded(batch.id)),
      ),
    },
  };
  checkSeededOracle(oracle, ownershipReason);
  await verifyArchiveRestoreFixture(request, oracle);
  return { profileId: profile.id, recoveryKit: setup.recoveryKit, oracle };
}

function checkSeededOracle(oracle: ArchiveRestoreOracle, ownershipReason: string) {
  equal(oracle.self.person.fullName, 'Fictional Restore Cedar', 'Self full name');
  equal(oracle.self.person.birthDate, '1982-04-17', 'Self birth date');
  equal(oracle.person.person.fullName, 'Fictional Restore Robin', 'managed full name');
  equal(oracle.observations[0]!.personId, 'patient', 'accepted Self attribution');
  equal(oracle.observations[0]!.valueText, '12.00', 'unchanged Self literal');
  equal(oracle.observations[1]!.personId, oracle.person.personId, 'corrected person attribution');
  equal(oracle.observations[1]!.valueText, '19.00', 'corrected managed literal');
  equal(oracle.note.content, 'Fictional note after correction.', 'note content');
  equal(oracle.note.attachments.length, 1, 'one retained note attachment');
  equal(oracle.note.attachments[0]!.caption, 'Fictional retained attachment', 'attachment caption');
  check(
    oracle.note.links.some((link) => link.targetId === oracle.person.personId),
    'note links managed person',
  );
  check(
    oracle.note.links.some((link) => link.targetId === oracle.observations[1]!.id),
    'note links accepted record',
  );
  check(oracle.noteHistory.entries.length >= 3, 'note edit and attachment history retained');
  const history = oracle.histories[1]!;
  const ownership = history.ownershipCorrections[0];
  check(ownership, 'ownership correction history retained');
  equal(ownership.actor, 'profile-user', 'ownership correction actor');
  equal(ownership.reason, ownershipReason, 'ownership correction reason');
  equal(
    ownership.operationId,
    oracle.ownershipReceipt.operationId,
    'ownership receipt history identity',
  );
  equal(ownership.fromPersonId, 'patient', 'prior ownership');
  equal(ownership.toPersonId, oracle.person.personId, 'corrected ownership');
  check(isoTime(ownership.at), 'correction history time');
  check(
    history.entries.some(
      (entry) => entry.contents.value_text === '18.00' && entry.contents.person_id === 'patient',
    ),
    'original accepted version retained',
  );
  const correction = history.entries.find((entry) =>
    entry.changes.some(
      (change) =>
        change.field === 'value_text' &&
        change.before.present &&
        change.before.value === '18.00' &&
        change.after.present &&
        change.after.value === '19.00',
    ),
  );
  check(
    correction && correction.previousVersion && isoTime(correction.recordedAt),
    'field correction version and timestamp retained',
  );
  equal(correction.actor, 'profile-user', 'field correction actor');
  equal(correction.origin, 'clinical-correction', 'field correction origin');
  const correctedExtra = JSON.parse(String(correction.contents.extra_json)) as {
    recordCorrections: {
      operationId: string;
      before: { valueText: string };
      after: { valueText: string };
      at: string;
      evidence: { sourceFileId: string }[];
    }[];
  };
  const explicitCorrection = correctedExtra.recordCorrections.find(
    (entry) => entry.operationId === oracle.fieldCorrection.operationId,
  );
  check(explicitCorrection, 'field correction receipt history identity');
  equal(explicitCorrection.before.valueText, '18.00', 'field correction receipt prior literal');
  equal(explicitCorrection.after.valueText, '19.00', 'field correction receipt accepted literal');
  check(isoTime(explicitCorrection.at), 'field correction receipt time');
  check(
    explicitCorrection.evidence.some(
      (entry) => entry.sourceFileId === oracle.acceptedIntakes[1]!.id,
    ),
    'field correction receipt original source',
  );
  check(
    history.entries.every(
      (entry) => entry.contents.source_record_id === oracle.observations[1]!.sourceRecordId,
    ),
    'prior versions retain source attribution',
  );
  equal(
    isIntakeSummary(oracle.pending.intake)
      ? oracle.pending.intake.collections.importHistory.total
      : oracle.pending.intake.imported,
    isIntakeSummary(oracle.pending.intake) ? 0 : null,
    'pending review never accepted',
  );
  equal(
    oracle.pending.review.records[0]!.draft?.disposition,
    'review_later',
    'pending review disposition',
  );
  equal(
    isIntakeSummary(oracle.stopped.intake)
      ? oracle.stopped.intake.collections.importHistory.total
      : oracle.stopped.intake.imported,
    isIntakeSummary(oracle.stopped.intake) ? 0 : null,
    'stopped original never accepted',
  );
  equal(oracle.stopped.batch.status, 'stopped', 'explicit Stop retained');
  equal(oracle.stopped.batch.reason, 'stopped', 'explicit Stop reason');
  const stopped = oracle.stopped.batch.items.find(
    (item) => item.intakeId === oracle.stopped.intake.id,
  );
  check(
    stopped && stopped.reason === 'stopped' && stopped.automaticRun === false,
    'stopped item cannot automatically resume',
  );
}

/** Read-only checks against the independent oracle, after recovery-kit unlock. */
export async function verifyArchiveRestoreFixture(
  request: ArchiveRestoreRequest,
  oracle: ArchiveRestoreOracle,
) {
  const path = pathFor(oracle.profileId);
  equal(oracle.format, 'circus-fictional-archive-restore-v2', 'oracle format');
  for (const original of oracle.originals) {
    const bytes = await request<Buffer>(original.contentUrl, { binary: true });
    equal(bytes.length, original.bytes, 'exact original length after restore');
    equal(digest(bytes), original.sha256, 'exact original hash after restore');
    equal(bytes.toString('base64'), original.bytesBase64, 'exact original bytes after restore');
  }
  for (const expected of [oracle.self, oracle.person, oracle.note])
    equal(
      await request(path + '/notes/' + encoded(expected.id)),
      expected,
      'exact person/note/attachment after restore',
    );
  equal(
    noteHistoryAuthority(
      await request<PublishedNoteHistory>(path + '/notes/' + encoded(oracle.note.id) + '/history'),
    ),
    noteHistoryAuthority(oracle.noteHistory),
    'exact prior note versions after restore',
  );
  for (const expected of oracle.observations)
    equal(
      await request(path + '/tests/' + encoded(expected.id)),
      expected,
      'exact accepted clinical row and attribution after restore',
    );
  // Lists are person scoped: pending/stopped sources must not become accepted rows.
  const selfRows = await request<Observation[]>(path + '/tests?personId=patient');
  const personRows = await request<Observation[]>(
    path + '/tests?' + new URLSearchParams({ personId: oracle.person.personId! }),
  );
  equal(
    selfRows.map((row) => row.id),
    [oracle.observations[0]!.id],
    'only the explicitly accepted Self row',
  );
  equal(
    personRows.map((row) => row.id),
    [oracle.observations[1]!.id],
    'only the explicitly accepted managed row',
  );
  for (const expected of oracle.histories)
    equal(
      await request(
        path +
          '/record-history?' +
          new URLSearchParams({ kind: 'observation', recordId: expected.recordId }),
      ),
      expected,
      'exact correction actor/time/source and prior versions after restore',
    );
  for (const receipt of oracle.acceptanceReceipts) {
    const retained = await request<IntakeReportAcceptanceResult>(
      path + '/intakes/report-acceptance/' + encoded(receipt.operationId),
    );
    equal(retained.receipt, receipt, 'exact explicit acceptance receipt after restore');
  }
  for (const expected of oracle.acceptedIntakes)
    equal(
      intakeAuthority(await request<IntakeRead>(path + '/intakes/' + encoded(expected.id))),
      intakeAuthority(expected),
      'explicit acceptance history after restore',
    );
  equal(
    intakeAuthority(
      await request<IntakeRead>(path + '/intakes/' + encoded(oracle.pending.intake.id)),
    ),
    intakeAuthority(oracle.pending.intake),
    'pending intake after restore',
  );
  equal(
    reviewAuthority(
      await readQualificationReview(
        request,
        path + '/intakes/' + encoded(oracle.pending.intake.id) + '/review',
      ),
    ),
    reviewAuthority(oracle.pending.review),
    'exact pending candidate and review-later draft after restore',
  );
  equal(
    intakeAuthority(
      await request<IntakeRead>(path + '/intakes/' + encoded(oracle.stopped.intake.id)),
    ),
    intakeAuthority(oracle.stopped.intake),
    'stopped retained original after restore',
  );
  equal(
    batchAuthority(
      await request<IntakeBatch>(path + '/intake-batches/' + encoded(oracle.stopped.batch.id)),
    ),
    oracle.stopped.batch,
    'explicit Stop and revoked automatic intent after restore',
  );
  return {
    people: 2,
    acceptedObservations: 2,
    originals: oracle.originals.length,
    notes: 1,
    attachments: 1,
    pendingReviews: 1,
    stoppedImports: 1,
  };
}
