import { createHash } from 'node:crypto';
import { HttpError, json, now, revision, type Database, type SqliteRow } from './database.ts';
import type { SQLInputValue } from 'node:sqlite';
import type {
  CorrectionSupportingEvidence,
  CorrectionSupportingReference,
} from '../shared/record-correction.ts';
import { getIntake, reviewIntake } from './intake.ts';
import { verifyIntakeFileHash } from './intake-files.ts';
import { profileOriginal } from './profile-storage.ts';
import { validClinicalFieldValue } from './optical-prescription.ts';
import {
  clinicalFields,
  checkClinicalMapping,
  clinicalVersion,
  clinicalSourceVersion,
  conceptId,
  conceptKey,
  datePrecision,
} from './clinical-import.ts';

import { clinicalTables, type ClinicalKind } from './clinical-references.ts';
import { projectObservationNumber } from './observation-number.ts';
export { clinicalTables, resolveClinicalReference } from './clinical-references.ts';
type ClinicalMapping = Parameters<typeof checkClinicalMapping>[0];
export interface RecordCorrectionInput {
  kind: unknown;
  recordId: unknown;
  set?: unknown;
  reason?: unknown;
  [key: string]: unknown;
}
export interface CorrectionEvidenceContext {
  root: string;
  profileId: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function retainedOriginal(db: Database, context: CorrectionEvidenceContext, sourceFileId: string) {
  const file = db
    .prepare('SELECT path,sha256,bytes,details_json FROM source_files WHERE id=?')
    .get(sourceFileId);
  if (!file)
    throw new HttpError(
      404,
      'CORRECTION_EVIDENCE',
      'Supporting original is not retained in this profile',
    );
  verifyIntakeFileHash(profileOriginal(context.root, file.path, context.profileId), {
    sha256: file.sha256 as string,
    bytes: file.bytes as number,
  });
  const details = json(file.details_json) as {
    intake?: { originalName?: string; parentSourceFileId?: string; locator?: string };
  };
  return { sha256: String(file.sha256), path: String(file.path), details };
}

function sourceRoot(db: Database, id: string): string {
  const seen = new Set<string>();
  while (!seen.has(id) && seen.size < 10) {
    seen.add(id);
    const row = db
      .prepare(
        "SELECT json_extract(details_json,'$.intake.parentSourceFileId') parent FROM source_files WHERE id=?",
      )
      .get(id);
    if (!row?.parent) return id;
    id = String(row.parent);
  }
  throw new HttpError(409, 'CORRECTION_EVIDENCE', 'Supporting source ancestry is invalid');
}

function supportingOriginals(
  db: Database,
  input: unknown,
  context?: CorrectionEvidenceContext,
): CorrectionSupportingEvidence[] {
  if (input === undefined) return [];
  if (!context || !Array.isArray(input) || input.length > 8)
    throw new HttpError(
      400,
      'CORRECTION_EVIDENCE',
      'Choose at most eight scoped supporting originals',
    );
  const seen = new Set<string>();
  return input.map((value) => {
    const keys = [
      'intakeId',
      'proposalId',
      'recordId',
      'candidateId',
      'candidateVersionId',
      'originalSourceFileId',
    ];
    if (
      !object(value) ||
      Object.keys(value).some((key) => !keys.includes(key)) ||
      keys.some((key) =>
        key === 'proposalId'
          ? value[key] !== null &&
            (typeof value[key] !== 'string' || !value[key] || value[key].length > 500)
          : typeof value[key] !== 'string' || !value[key] || value[key].length > 500,
      )
    )
      throw new HttpError(
        400,
        'CORRECTION_EVIDENCE',
        'Supply the exact incoming candidate, proposal and original reference',
      );
    const ref = value as unknown as CorrectionSupportingReference;
    const key = JSON.stringify(keys.map((key) => value[key]));
    if (seen.has(key))
      throw new HttpError(400, 'CORRECTION_EVIDENCE', 'Choose each supporting occurrence once');
    seen.add(key);
    const intake = getIntake(db, context.root, context.profileId, ref.intakeId);
    const candidate = intake.workflow?.candidates.find(
      (candidate) => candidate.id === ref.candidateId,
    );
    if (candidate?.versions.at(-1)?.id !== ref.candidateVersionId)
      throw new HttpError(
        409,
        'CORRECTION_EVIDENCE_CHANGED',
        'Review the current incoming candidate before using its original',
      );
    const review = reviewIntake(db, context.root, context.profileId, ref.intakeId, ref.proposalId);
    const record = review.records.find(
      (record) =>
        record.id === ref.recordId &&
        record.candidateId === ref.candidateId &&
        record.candidateVersionId === ref.candidateVersionId,
    );
    if (!record)
      throw new HttpError(
        409,
        'CORRECTION_EVIDENCE_CHANGED',
        'The supporting record does not belong to this exact proposal',
      );
    const contentUrl = `/api/sources/${encodeURIComponent(ref.originalSourceFileId)}/content`;
    const evidence = record.evidence.find((evidence) => evidence.contentUrl === contentUrl);
    const file = retainedOriginal(db, context, ref.originalSourceFileId);
    let memberId: string | null = null;
    const group = intake.workflow?.reportGroups?.find(
      (group) =>
        group.memberId &&
        group.versions.some((version) =>
          version.members.some(
            (member) =>
              member.candidateId === ref.candidateId &&
              member.candidateVersionId === ref.candidateVersionId,
          ),
        ),
    );
    const member =
      group &&
      intake
        .workflow!.plans.flatMap((plan) => plan.index.members || [])
        .find((member) => member.memberId === group.memberId);
    const exactMember =
      member &&
      file.details.intake?.parentSourceFileId === intake.id &&
      file.details.intake.locator === member.locator &&
      file.sha256 === member.sourceHash;
    if (
      (!evidence && !exactMember) ||
      sourceRoot(db, ref.originalSourceFileId) !== sourceRoot(db, ref.intakeId)
    )
      throw new HttpError(
        409,
        'CORRECTION_EVIDENCE',
        'The original is not evidence of this selected incoming occurrence',
      );
    if (intake.mimeType === 'application/zip' && ref.originalSourceFileId === intake.id)
      throw new HttpError(
        409,
        'CORRECTION_EVIDENCE',
        'Choose the exact retained package member, not the outer delivery',
      );
    if (exactMember) memberId = member.memberId;
    return {
      ...ref,
      intakeVersion: intake.version,
      originalSourceHash: String(file.sha256),
      filename: file.details.intake?.originalName || String(file.path).split('/').at(-1)!,
      contentUrl,
      locator: exactMember ? member.locator : evidence!.locator,
      memberId,
      title: record.title,
    };
  });
}
interface RecordException extends Record<string, unknown> {
  id: string;
  set: Partial<ClinicalMapping>;
}
interface ImportMetadata extends Record<string, unknown> {
  acceptedMapping: ClinicalMapping;
  originalMapping: ClinicalMapping;
  recordException?: RecordException;
  identity: string;
  intakeId: string;
  version: string;
}
interface ClinicalExtra extends Record<string, unknown> {
  import: ImportMetadata;
  recordCorrections?: unknown[];
  reclassifiedRows?: Partial<Record<ClinicalKind, Record<string, unknown>>>;
  sourceFields?: Record<string, unknown>;
}
interface ClinicalRow extends SqliteRow {
  id: string;
  source_record_id: string;
  provider_id: string;
  person_id: string | null;
  test_type_id: string | null;
  extra_json: string;
}
export interface ClinicalEvidence extends Record<string, unknown> {
  sourceRecordId: string;
  sourceFileId: string;
  acquiringSource: string | null;
  contentUrl: string;
}
export interface ClinicalRecord {
  table: string;
  row: ClinicalRow;
  extra: ClinicalExtra;
  mapping: ClinicalMapping;
  evidence: ClinicalEvidence[];
}
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function clinicalRecord(db: Database, kind: unknown, id: unknown): ClinicalRecord {
  const table = clinicalTables[kind as ClinicalKind];
  if (!Object.hasOwn(clinicalTables, kind as PropertyKey))
    throw new HttpError(400, 'CORRECTION_KIND', 'Choose a supported clinical kind');
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id as SQLInputValue) as
    ClinicalRow | undefined;
  if (!row)
    throw new HttpError(404, 'RECORD_NOT_FOUND', 'Clinical record not found in this profile');
  const extra = json(row.extra_json) as ClinicalExtra;
  if (!extra.import?.acceptedMapping)
    throw new HttpError(
      400,
      'CORRECTION_EVIDENCE',
      'This entry has no reviewed import mapping; review its source in Imports first',
    );
  const evidence = db
    .prepare(
      `SELECT e.source_record_id,s.source_file_id,s.locator_json,s.raw_json,p.name AS acquiring_source FROM evidence e JOIN source_records s ON s.id=e.source_record_id LEFT JOIN providers p ON p.id=s.provider_id WHERE e.entity_type=? AND e.entity_id=? ORDER BY e.id`,
    )
    .all(kind as SQLInputValue, id as SQLInputValue)
    .map((item): ClinicalEvidence => ({
      sourceRecordId: item.source_record_id as string,
      sourceFileId: item.source_file_id as string,
      locator: json(item.locator_json),
      original: json(item.raw_json),
      acquiringSource: item.acquiring_source as string | null,
      contentUrl: `/api/sources/${encodeURIComponent(
        ((json(item.locator_json) as Record<string, unknown>).originalSourceFileId ||
          item.source_file_id) as string,
      )}/content`,
    }));
  return { table, row, extra, mapping: extra.import.acceptedMapping, evidence };
}
export function previewRecordCorrection(
  db: Database,
  input: RecordCorrectionInput,
  context?: CorrectionEvidenceContext,
) {
  const { kind, recordId, set } = input,
    record = clinicalRecord(db, kind, recordId);
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 4000)
    throw new HttpError(
      400,
      'CORRECTION_REASON',
      'Explain the correction using retained original evidence',
    );
  const targetKind = ((set as Record<string, unknown> | null)?.kind || kind) as ClinicalKind;
  if (
    targetKind !== kind &&
    db
      .prepare(
        "SELECT 1 FROM evidence WHERE entity_type=? AND entity_id=? AND role='same_event_occurrence' LIMIT 1",
      )
      .get(kind as SQLInputValue, recordId as SQLInputValue)
  )
    throw new HttpError(
      409,
      'OCCURRENCE_ATTACHMENT_ACTIVE',
      'Withdraw reviewed source-occurrence attachments before changing this record’s clinical kind',
    );
  if (!Object.hasOwn(clinicalTables, targetKind))
    throw new HttpError(
      400,
      'CORRECTION_KIND',
      'Choose observation, medication, procedure or document',
    );
  if (targetKind !== kind && [kind, targetKind].includes('medication'))
    throw new HttpError(
      400,
      'CORRECTION_KIND',
      'Medication kind changes require a separate review of personal medication-use history; supported reclassifications are observations, procedures and documents',
    );
  if (
    !set ||
    typeof set !== 'object' ||
    Array.isArray(set) ||
    !Object.keys(set).length ||
    Object.entries(set).some(
      ([key, value]) =>
        !clinicalFields[targetKind].includes(key as keyof ClinicalMapping) ||
        key === 'subject' ||
        !validClinicalFieldValue(key as Parameters<typeof validClinicalFieldValue>[0], value),
    )
  )
    throw new HttpError(
      400,
      'CORRECTION_FIELDS',
      'Choose supported fields on this record; original identity and subject remain unchanged',
    );
  const after = { ...record.mapping, ...(set as Partial<ClinicalMapping>) },
    problem = checkClinicalMapping(after);
  if (problem) throw new HttpError(400, 'CORRECTION_MAPPING', problem);
  const supportingEvidence = supportingOriginals(db, input.supportingEvidence, context);
  if (context)
    for (const evidence of record.evidence) {
      const originalId = /^\/api\/sources\/([^/]+)\/content$/.exec(evidence.contentUrl)?.[1];
      if (!originalId)
        throw new HttpError(
          409,
          'CORRECTION_EVIDENCE',
          'Saved evidence has no retained original link',
        );
      retainedOriginal(db, context, decodeURIComponent(originalId));
    }
  return {
    token: digest([
      revision(db),
      input,
      record,
      ...(input.supportingEvidence === undefined ? [] : [supportingEvidence]),
    ]),
    version: revision(db),
    kind,
    recordId,
    before: record.mapping,
    after,
    evidence: record.evidence,
    supportingEvidence,
    scope: 'record',
    targetKind,
    reclassification: targetKind !== kind,
    supportedTargetKinds:
      kind === 'medication' ? ['medication'] : ['observation', 'procedure', 'document'],
    sourceUnchanged: true,
  };
}
// SQLite is the current projection. exportCuration publishes these complete row
// versions and the decision journal atomically through the existing durable store.
export function correctClinicalRecord(
  db: Database,
  input: RecordCorrectionInput,
  operationId: string,
  context?: CorrectionEvidenceContext,
) {
  const { kind, recordId, set } = input;
  const preview = previewRecordCorrection(db, input, context);
  const { table, row, extra, mapping, evidence } = clinicalRecord(db, kind, recordId);
  const targetKind = preview.targetKind;
  const personId =
    kind === 'document'
      ? typeof extra.import.personId === 'string'
        ? extra.import.personId
        : 'patient'
      : row.person_id || 'patient';
  extra.import.personId = personId;
  const accepted = { ...mapping, ...(set as Partial<ClinicalMapping>) },
    prior = extra.import.recordException;
  const exception = {
    id: 'exception:assistant:' + operationId,
    scope: 'record',
    recordId,
    identityKey: extra.import.identity,
    sourceVersion: clinicalSourceVersion(extra.import.originalMapping),
    set: { ...(prior?.set || {}), ...(set as Partial<ClinicalMapping>), kind: accepted.kind },
    ...(targetKind !== kind
      ? { reclassification: { recordId, fromKind: kind, toKind: targetKind, operationId } }
      : {}),
    previousDecisionId: prior?.id || null,
    sourceFileId: extra.import.intakeId,
    evidence,
    ...(preview.supportingEvidence.length
      ? { supportingEvidence: preview.supportingEvidence }
      : {}),
    reason: input.reason,
    at: now(),
    sequence: Number(
      db
        .prepare(
          "SELECT COALESCE(MAX(json_extract(coverage_json,'$.recordException.sequence')),0)+1 AS n FROM manual_batches",
        )
        .get()!.n,
    ),
  };
  db.prepare(
    "INSERT INTO manual_batches(id,title,status,created_at,verified_at,notes,coverage_json) VALUES(?,'Import record exception','verified',?,?,?,?)",
  ).run(
    exception.id,
    exception.at,
    exception.at,
    (input.reason || 'Reviewed individual correction; original evidence retained.') as string,
    JSON.stringify({ recordException: exception }),
  );
  extra.import.recordException = exception;
  extra.import.acceptedMapping = accepted;
  extra.import.version = clinicalVersion(accepted);
  extra.recordCorrections = [
    ...(extra.recordCorrections || []),
    {
      operationId,
      before: mapping,
      after: accepted,
      evidence,
      reason: input.reason,
      ...(preview.supportingEvidence.length
        ? { supportingEvidence: preview.supportingEvidence }
        : {}),
      at: exception.at,
    },
  ];
  const values: Record<string, SQLInputValue> = { extra_json: JSON.stringify(extra) };
  if (targetKind !== kind) {
    // Keep incompatible columns as explicit retained projection metadata too.
    extra.reclassifiedRows = {
      ...(extra.reclassifiedRows || {}),
      [kind as ClinicalKind]: { ...row, extra_json: undefined },
    };
    values.extra_json = JSON.stringify(extra);
  }
  if (targetKind === 'observation') {
    const testId = conceptId(db, accepted),
      original = db.prepare('SELECT * FROM test_types WHERE id=?').get(row.test_type_id || null);
    db.prepare(
      'INSERT OR IGNORE INTO test_types(id,label,category,unit,codes_json,extra_json) VALUES(?,?,?,?,?,?)',
    ).run(
      testId,
      accepted.testLabel,
      accepted.observationCategory || original?.category || 'Unspecified',
      accepted.unit || null,
      JSON.stringify(accepted.code ? [{ system: accepted.codeSystem, code: accepted.code }] : []),
      JSON.stringify({
        specimen: accepted.specimen,
        method: accepted.method,
        importConcept: conceptKey(accepted),
      }),
    );
    const number = projectObservationNumber(accepted.valueText, accepted.unit);
    Object.assign(values, {
      test_type_id: testId,
      label: accepted.testLabel,
      effective_at: accepted.date || null,
      date_precision: datePrecision(accepted.date),
      value_text: accepted.valueText,
      value_numeric: number?.numeric ?? null,
      comparator: number?.comparator ?? null,
      unit: accepted.unit || null,
      reference_json: JSON.stringify({ text: accepted.referenceText }),
      status: accepted.status || null,
    });
  } else if (targetKind === 'medication') {
    extra.sourceFields = {
      ...extra.sourceFields,
      recordedDate: accepted.dateRole === 'recorded' ? accepted.date : null,
    };
    Object.assign(values, {
      label: accepted.medicationName,
      kind: accepted.medicationKind,
      dose_text: accepted.doseText || null,
      route: accepted.route || null,
      frequency: accepted.frequency || null,
      status: accepted.status || null,
      start_at: accepted.startDate || (accepted.dateRole === 'start' ? accepted.date : null),
      end_at: accepted.endDate || null,
      extra_json: JSON.stringify(extra),
    });
  } else if (targetKind === 'procedure')
    Object.assign(values, {
      label: accepted.procedureLabel,
      category: accepted.procedureCategory,
      effective_at: accepted.date || null,
      status: accepted.status || null,
    });
  else
    Object.assign(values, {
      title: accepted.documentTitle,
      effective_at: accepted.documentDate || accepted.date || null,
      text_content: accepted.text,
    });
  if (targetKind !== kind) {
    const target = clinicalTables[targetKind],
      retained = extra.reclassifiedRows?.[targetKind] || {};
    const next = {
      ...retained,
      id: recordId,
      source_record_id: row.source_record_id,
      provider_id: row.provider_id,
      ...(targetKind !== 'document' ? { person_id: personId } : {}),
      ...values,
    } as Record<string, SQLInputValue>;
    const keys = Object.keys(next);
    db.prepare(
      `INSERT INTO ${target}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
    ).run(...keys.map((key) => next[key] ?? null));
    db.prepare('UPDATE evidence SET entity_type=? WHERE entity_type=? AND entity_id=?').run(
      targetKind,
      kind as SQLInputValue,
      recordId as SQLInputValue,
    );
    db.prepare('UPDATE attachments SET owner_type=? WHERE owner_type=? AND owner_id=?').run(
      targetKind,
      kind as SQLInputValue,
      recordId as SQLInputValue,
    );
    // Finished-note links and prior visibility events remain immutable; readers
    // resolve their original kind through the accepted transition journal.
    const visibility = db
      .prepare(
        'SELECT * FROM visibility_events WHERE target_type=? AND target_id=? ORDER BY version DESC LIMIT 1',
      )
      .get(kind as SQLInputValue, recordId as SQLInputValue);
    if (visibility) {
      const nextVersion = Number(
        db
          .prepare(
            'SELECT COALESCE(MAX(version),0)+1 n FROM visibility_events WHERE target_type=? AND target_id=?',
          )
          .get(targetKind, recordId as SQLInputValue)!.n,
      );
      db.prepare('INSERT INTO visibility_events VALUES(?,?,?,?,?,?,?)').run(
        'visibility:reclassification:' + operationId,
        targetKind,
        recordId as SQLInputValue,
        visibility.archived,
        nextVersion,
        exception.at,
        'Reviewed reclassification',
      );
    }
    // This removes only the current projection. The durable store appends a
    // tombstone containing the complete previous row and retains its history.
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(recordId as SQLInputValue);
  } else
    db.prepare(
      `UPDATE ${table} SET ${Object.keys(values)
        .map((key) => key + '=?')
        .join(',')} WHERE id=?`,
    ).run(...Object.values(values), recordId as SQLInputValue);
  return {
    kind: targetKind,
    previousKind: kind,
    recordId,
    exceptionId: exception.id,
    before: mapping,
    after: accepted,
    reason: input.reason,
    ...(preview.supportingEvidence.length
      ? { supportingEvidence: preview.supportingEvidence }
      : {}),
    sourceUnchanged: true,
  };
}
