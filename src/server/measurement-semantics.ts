import { createHash } from 'node:crypto';
import { HttpError, json, now, revision, transaction, type Database } from './database.ts';
import {
  duplicateRecord,
  intakePairReference,
  verifyDuplicateOriginals,
} from './duplicate-review.ts';
import { exportCuration } from './portable.ts';
import { MEASUREMENT_RULE_VERSION, resolveMeasurementUnit } from '../shared/measurement-units.ts';
import {
  parseMeasurementLiteral,
  sameMeasurementReference,
  validMeasurementPrecision,
  validMeasurementSemantics,
  deriveMeasurement,
} from '../shared/measurement.ts';
import type { MeasurementInput, MeasurementReference } from '../shared/measurement.ts';
import type {
  AcceptedMeasurement,
  MeasurementSemanticApplyRequest,
  MeasurementSemanticApplyResult,
  MeasurementSemanticDecision,
  MeasurementSemanticPreview,
  MeasurementSemanticRequest,
} from '../shared/measurement-semantics.ts';
const title = 'Measurement semantic decision';
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
function owner(db: Database, profileId: string): void {
  if (
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !== profileId
  )
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'Measurement semantics belong to another profile');
}
function request(
  value: unknown,
  apply = false,
): MeasurementSemanticRequest | MeasurementSemanticApplyRequest {
  const keys = [
    'kind',
    'recordId',
    'semantics',
    'precision',
    'reason',
    ...(apply ? ['reference', 'rulesVersion', 'version', 'previewToken', 'operationId'] : []),
  ];
  if (
    !object(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    !['observation', 'procedure'].includes(String(value.kind)) ||
    typeof value.recordId !== 'string' ||
    !value.recordId ||
    value.recordId.length > 500 ||
    (value.semantics !== null && !validMeasurementSemantics(value.semantics)) ||
    (value.precision !== null && !validMeasurementPrecision(value.precision)) ||
    (value.semantics === null && value.precision !== null) ||
    typeof value.reason !== 'string' ||
    !value.reason.trim() ||
    value.reason.length > 4000
  )
    throw new HttpError(
      400,
      'MEASUREMENT_SEMANTICS_INPUT',
      'Choose an accepted measurement, complete reviewed semantics and reason; precision requires explicit evidence',
    );
  if (
    apply &&
    (!object(value.reference) ||
      !Number.isSafeInteger(value.version) ||
      (value.version as number) < 0 ||
      value.rulesVersion !== MEASUREMENT_RULE_VERSION ||
      typeof value.operationId !== 'string' ||
      !value.operationId ||
      value.operationId.length > 200 ||
      typeof value.previewToken !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.previewToken))
  )
    throw new HttpError(
      400,
      'MEASUREMENT_SEMANTICS_INPUT',
      'Apply requires the exact reviewed reference, rules, version, token and operation ID',
    );
  return stable(value) as unknown as MeasurementSemanticRequest | MeasurementSemanticApplyRequest;
}
function latest(
  db: Database,
  profileId: string,
  kind: string,
  recordId: string,
): MeasurementSemanticDecision | null {
  const row = db
    .prepare(
      `SELECT coverage_json FROM manual_batches WHERE title=?
    AND json_extract(coverage_json,'$.measurementSemantics.reference.profileId')=?
    AND json_extract(coverage_json,'$.measurementSemantics.reference.kind')=?
    AND json_extract(coverage_json,'$.measurementSemantics.reference.recordId')=?
    ORDER BY CAST(json_extract(coverage_json,'$.measurementSemantics.sequence') AS INTEGER) DESC LIMIT 1`,
    )
    .get(title, profileId, kind, recordId);
  return row
    ? (json(row.coverage_json) as { measurementSemantics: MeasurementSemanticDecision })
        .measurementSemantics
    : null;
}
function current(
  db: Database,
  root: string,
  profileId: string,
  kind: string,
  recordId: string,
  verifiedOriginals: Set<string>,
) {
  owner(db, profileId);
  if (!['observation', 'procedure'].includes(kind))
    throw new HttpError(
      400,
      'MEASUREMENT_KIND',
      'Choose an accepted scalar observation or procedure',
    );
  const record = duplicateRecord(db, kind, recordId),
    mapping = record.mapping;
  if (
    mapping.subject !== 'self' ||
    typeof mapping.valueText !== 'string' ||
    !record.evidence.length ||
    mapping.opticalPrescription
  )
    throw new HttpError(
      409,
      'MEASUREMENT_SOURCE',
      'The measurement needs an accepted Self scalar mapping and retained originals',
    );
  verifyDuplicateOriginals(db, root, profileId, record, verifiedOriginals);
  const reference: MeasurementReference = {
    ...intakePairReference(db, record),
    profileId,
    recordId,
  };
  const comparator =
    kind === 'observation'
      ? db.prepare('SELECT comparator FROM observations WHERE id=?').get(recordId)?.comparator
      : 'comparator' in mapping
        ? mapping.comparator
        : null;
  const source: MeasurementInput['source'] = {
    valueText: mapping.valueText,
    ...(typeof comparator === 'string' ? { comparator } : {}),
    unit: typeof mapping.unit === 'string' ? mapping.unit : null,
    date: typeof mapping.date === 'string' ? mapping.date : null,
  };
  return {
    reference,
    source,
    subject: 'self',
    evidence: record.evidence.map(({ sourceRecordId, contentUrl, label, locator }) => ({
      sourceRecordId,
      contentUrl,
      label,
      locator,
    })),
  };
}
function projectAcceptedMeasurement(
  db: Database,
  root: string,
  profileId: string,
  kind: string,
  recordId: string,
  verifiedOriginals: Set<string>,
): AcceptedMeasurement {
  const measurement = current(db, root, profileId, kind, recordId, verifiedOriginals),
    decision = latest(db, profileId, kind, recordId);
  const semanticStatus = !decision
    ? 'none'
    : !sameMeasurementReference(decision.reference, measurement.reference) ||
        decision.rulesVersion !== MEASUREMENT_RULE_VERSION
      ? 'stale'
      : decision.semantics === null
        ? 'revoked'
        : 'current';
  return {
    reference: measurement.reference,
    source: measurement.source,
    semanticStatus,
    lastDecision: decision,
    binding:
      semanticStatus === 'current' && decision?.semantics
        ? {
            decisionId: decision.id,
            reference: decision.reference,
            rulesVersion: decision.rulesVersion,
            subject: decision.subject,
            semantics: decision.semantics,
            precision: decision.precision,
          }
        : null,
  };
}
export function acceptedMeasurement(
  db: Database,
  root: string,
  profileId: string,
  kind: string,
  recordId: string,
): AcceptedMeasurement {
  return projectAcceptedMeasurement(db, root, profileId, kind, recordId, new Set());
}
/** One synchronous bounded read. Its physical-source verification cache never escapes this call. */
export function acceptedMeasurements(
  db: Database,
  root: string,
  profileId: string,
  records: { kind: 'observation' | 'procedure'; recordId: string }[],
) {
  owner(db, profileId);
  if (
    !Array.isArray(records) ||
    records.length > 256 ||
    records.some(
      (record) =>
        !object(record) ||
        !['observation', 'procedure'].includes(record.kind) ||
        typeof record.recordId !== 'string' ||
        !record.recordId ||
        record.recordId.length > 500,
    )
  )
    throw new HttpError(
      413,
      'MEASUREMENT_BATCH_LIMIT',
      'Request at most 256 explicit accepted measurement references',
    );
  const verifiedOriginals = new Set<string>(),
    version = revision(db);
  const measurements = records.map(({ kind, recordId }) =>
    projectAcceptedMeasurement(db, root, profileId, kind, recordId, verifiedOriginals),
  );
  if (revision(db) !== version)
    throw new HttpError(
      409,
      'MEASUREMENT_SCOPE_CHANGED',
      'The accepted archive changed during this measurement read',
    );
  return {
    measurements,
    count: measurements.length,
    complete: true as const,
    verifiedOriginalCount: verifiedOriginals.size,
    version,
  };
}
export function previewMeasurementSemantics(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
): MeasurementSemanticPreview {
  owner(db, profileId);
  const selected = request(input) as MeasurementSemanticRequest,
    measurement = current(db, root, profileId, selected.kind, selected.recordId, new Set());
  if (selected.semantics) {
    const unit = resolveMeasurementUnit(measurement.source.unit);
    if (
      unit.status !== 'supported' ||
      unit.unit.dimension !== selected.semantics.dimension ||
      !parseMeasurementLiteral(
        measurement.source.valueText,
        measurement.source.comparator,
        measurement.source.unit,
      )
    )
      throw new HttpError(
        409,
        'MEASUREMENT_UNSUPPORTED',
        'The literal and units must be supported and match the reviewed quantity dimension',
      );
    const projected = deriveMeasurement(
      {
        ...measurement,
        binding: {
          decisionId: 'preview',
          rulesVersion: MEASUREMENT_RULE_VERSION,
          reference: measurement.reference,
          subject: measurement.subject,
          semantics: selected.semantics,
          precision: selected.precision,
        },
      },
      unit.unit.code,
    );
    if (projected.status !== 'converted')
      throw new HttpError(
        409,
        'MEASUREMENT_PRECISION',
        'The explicitly known precision must match the reported decimal grid',
      );
  }
  const preview: Omit<MeasurementSemanticPreview, 'previewToken'> = {
    request: selected,
    ...measurement,
    rulesVersion: MEASUREMENT_RULE_VERSION,
    previousDecisionId: latest(db, profileId, selected.kind, selected.recordId)?.id || null,
    version: revision(db),
  };
  return { ...preview, previewToken: hash(preview) };
}
/** Append only to the existing accepted journal. Clinical source/row bytes are not modified. */
export function applyMeasurementSemantics(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
  { exportFn = exportCuration }: { exportFn?: typeof exportCuration } = {},
): MeasurementSemanticApplyResult {
  owner(db, profileId);
  const selected = request(input, true) as MeasurementSemanticApplyRequest;
  const { operationId, previewToken, version, reference, rulesVersion, ...reviewed } = selected;
  if (reference.profileId !== profileId)
    throw new HttpError(
      403,
      'PROFILE_BOUNDARY',
      'The reviewed measurement belongs to another profile',
    );
  const id = 'measurement-semantics:' + operationId,
    fingerprint = hash({ ...reviewed, reference, rulesVersion });
  const existing = db.prepare('SELECT coverage_json FROM manual_batches WHERE id=?').get(id);
  let result: MeasurementSemanticApplyResult;
  if (existing) {
    const receipt = json(existing.coverage_json) as {
      requestFingerprint: string;
      measurementSemantics: MeasurementSemanticDecision;
    };
    if (receipt.requestFingerprint !== fingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'This operation belongs to another semantic decision',
      );
    result = { replayed: true, decision: receipt.measurementSemantics };
  } else {
    if (version !== revision(db))
      throw new HttpError(
        409,
        'MEASUREMENT_SCOPE_CHANGED',
        'Review the current accepted measurement and semantic history',
      );
    const preview = previewMeasurementSemantics(db, root, profileId, reviewed);
    if (preview.previewToken !== previewToken || hash(preview.reference) !== hash(reference))
      throw new HttpError(
        409,
        'MEASUREMENT_SCOPE_CHANGED',
        'The accepted measurement, evidence or reviewed semantics changed',
      );
    const decision: MeasurementSemanticDecision = {
      id,
      operationId,
      reference: preview.reference,
      source: preview.source,
      subject: preview.subject,
      rulesVersion,
      semantics: reviewed.semantics,
      precision: reviewed.precision,
      reason: reviewed.reason,
      previousDecisionId: preview.previousDecisionId,
      at: now(),
      sequence: revision(db) + 1,
    };
    transaction(db, () => {
      db.prepare(
        "INSERT INTO manual_batches(id,title,status,created_at,verified_at,notes,coverage_json) VALUES(?,?,'verified',?,?,?,?)",
      ).run(
        id,
        title,
        decision.at,
        decision.at,
        decision.reason,
        JSON.stringify({ requestFingerprint: fingerprint, measurementSemantics: decision }),
      );
    });
    result = { replayed: false, decision };
  }
  try {
    exportFn(db, root, profileId);
  } catch (error) {
    return { ...result, durability: { pending: true, error: (error as Error).message } };
  }
  return result;
}
