import type { IncomingMessage } from 'node:http';
import { HttpError, json, type Database } from './database.ts';
import { previewRecordCorrection } from './record-corrections.ts';
import { applyClinicalDecision } from './mapping-actions.ts';
import { clinicalFields } from './clinical-import.ts';
import { clinicalNavigation, resolveClinicalReference } from './clinical-references.ts';
import {
  acceptedMeasurement,
  previewMeasurementSemantics,
  applyMeasurementSemantics,
} from './measurement-semantics.ts';
import type {
  RecordCorrectionRequest,
  RecordCorrectionApplyRequest,
  RecordCorrectionPreview,
  RecordCorrectionApplyResult,
  CorrectionSupportingReference,
} from '../shared/record-correction.ts';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function owner(db: Database, profileId: string): void {
  if (
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !== profileId
  )
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'Clinical correction belongs to another profile');
}
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
function request(
  value: unknown,
  apply = false,
): RecordCorrectionRequest | RecordCorrectionApplyRequest {
  const allowed = [
    'kind',
    'recordId',
    'set',
    'reason',
    'supportingEvidence',
    ...(apply ? ['operationId', 'version', 'previewToken'] : []),
  ];
  if (
    !object(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    !['observation', 'medication', 'procedure', 'document'].includes(String(value.kind)) ||
    typeof value.recordId !== 'string' ||
    !value.recordId ||
    value.recordId.length > 500 ||
    !object(value.set) ||
    Object.keys(value.set).length > 50 ||
    typeof value.reason !== 'string' ||
    !value.reason.trim() ||
    value.reason.length > 4000 ||
    (value.supportingEvidence !== undefined &&
      (!Array.isArray(value.supportingEvidence) || value.supportingEvidence.length > 8))
  )
    throw new HttpError(
      400,
      'CORRECTION_INPUT',
      'Supply one accepted record, supported changes, reason and bounded original references',
    );
  if (
    apply &&
    (typeof value.operationId !== 'string' ||
      !value.operationId ||
      value.operationId.length > 200 ||
      !Number.isSafeInteger(value.version) ||
      (value.version as number) < 0 ||
      typeof value.previewToken !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.previewToken))
  )
    throw new HttpError(
      400,
      'CORRECTION_INPUT',
      'Apply requires the reviewed version, token and a stable operation ID',
    );
  const result: RecordCorrectionRequest = {
    kind: value.kind as RecordCorrectionRequest['kind'],
    recordId: value.recordId,
    set: stable(value.set) as RecordCorrectionRequest['set'],
    reason: value.reason,
    ...(value.supportingEvidence !== undefined
      ? { supportingEvidence: stable(value.supportingEvidence) as CorrectionSupportingReference[] }
      : {}),
  };
  return apply
    ? {
        ...result,
        operationId: value.operationId as string,
        version: value.version as number,
        previewToken: value.previewToken as string,
      }
    : result;
}

export function previewDirectRecordCorrection(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
): RecordCorrectionPreview {
  owner(db, profileId);
  const selected = request(input);
  const preview = previewRecordCorrection(db, { ...selected }, { root, profileId });
  return {
    request: selected,
    version: preview.version,
    previewToken: preview.token,
    before: preview.before as RecordCorrectionPreview['before'],
    after: preview.after as RecordCorrectionPreview['after'],
    evidence: preview.evidence,
    supportingEvidence: preview.supportingEvidence,
    supportedTargetKinds:
      preview.supportedTargetKinds as RecordCorrectionPreview['supportedTargetKinds'],
    editableFields: clinicalFields[preview.targetKind].filter(
      (field) => field !== 'subject',
    ) as RecordCorrectionPreview['editableFields'],
    reclassification: preview.reclassification,
    destination: clinicalNavigation(preview.targetKind, selected.recordId)!,
    sourceUnchanged: true,
  };
}
export function applyDirectRecordCorrection(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
): RecordCorrectionApplyResult {
  owner(db, profileId);
  const selected = request(input, true) as RecordCorrectionApplyRequest;
  const receiptId = 'clinical_correction:' + selected.operationId;
  const replayed = !!db.prepare('SELECT 1 FROM manual_batches WHERE id=?').get(receiptId);
  // The existing accepted-operation engine handles stale previews, lost replies,
  // changed-request conflicts and portable publication. Never create another store.
  const result = applyClinicalDecision(db, root, profileId, 'clinical_correction', {
    ...selected,
  }) as RecordCorrectionApplyResult['receipt']['result'] &
    Pick<RecordCorrectionApplyResult, 'durability'>;
  const stored = json(
    db.prepare('SELECT coverage_json FROM manual_batches WHERE id=?').get(receiptId)!.coverage_json,
  ) as {
    appliedRevision: number;
    result: RecordCorrectionApplyResult['receipt']['result'];
  };
  const current = resolveClinicalReference(db, result.kind, result.recordId);
  if (!current)
    throw new HttpError(
      409,
      'CORRECTION_DESTINATION',
      'The saved correction has no current clinical destination',
    );
  return {
    operationId: selected.operationId,
    replayed,
    destination: clinicalNavigation(current.kind, current.recordId)!,
    sourceUnchanged: true,
    receipt: { id: receiptId, appliedRevision: stored.appliedRevision, result: stored.result },
    ...(result.durability ? { durability: result.durability } : {}),
  };
}
interface ClinicalReviewRouteContext {
  resource?: string;
  id?: string;
  action?: string;
  method: string;
  params?: URLSearchParams;
  req: IncomingMessage;
  db: Database;
  root: string;
  profileId: string;
  body: (req: IncomingMessage, max?: number) => Promise<Buffer>;
  respond: (data: unknown, options?: Record<string, unknown>, status?: number) => void;
}
/** Mount only inside index.ts's existing session/profile/origin-authorized dispatch. */
export async function handleClinicalReviewRoute(
  context: ClinicalReviewRouteContext,
): Promise<boolean> {
  const { resource, id, action, method, req, db, root, profileId, body, respond } = context;
  if (
    resource !== 'clinical-review' ||
    ![
      'correction-preview',
      'correction-apply',
      'measurement',
      'measurement-preview',
      'measurement-apply',
    ].includes(id || '')
  )
    return false;
  owner(db, profileId);
  if (id === 'measurement' && method === 'GET' && !action) {
    const kind = context.params?.get('kind'),
      recordId = context.params?.get('recordId');
    if (!kind || !recordId || recordId.length > 500)
      throw new HttpError(400, 'MEASUREMENT_INPUT', 'Choose one accepted measurement');
    respond(acceptedMeasurement(db, root, profileId, kind, recordId));
    return true;
  }
  if (method !== 'POST' || action)
    throw new HttpError(404, 'NOT_FOUND', 'Clinical correction action not found');
  if ((req.headers['content-type'] || '').split(';')[0] !== 'application/json')
    throw new HttpError(415, 'CONTENT_TYPE', 'Use application/json');
  let input: unknown;
  try {
    input = JSON.parse((await body(req, 256 * 1024)).toString('utf8'));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_JSON', 'Expected a JSON object');
  }
  if (id === 'correction-preview')
    respond(previewDirectRecordCorrection(db, root, profileId, input));
  else if (id === 'correction-apply')
    respond(applyDirectRecordCorrection(db, root, profileId, input));
  else if (id === 'measurement-preview')
    respond(previewMeasurementSemantics(db, root, profileId, input));
  else if (id === 'measurement-apply')
    respond(applyMeasurementSemantics(db, root, profileId, input));
  else throw new HttpError(404, 'NOT_FOUND', 'Clinical review action not found');
  return true;
}
