import type { IncomingMessage } from 'node:http';
import { HttpError, type Database } from './database.ts';
import {
  previewClinicalRelationship,
  applyClinicalRelationship,
  getClinicalRelationshipReceipt,
  clinicalRelationshipProjection,
  clinicalRelationshipHistory,
  readClinicalRelationshipPair,
} from './clinical-relationships.ts';
import type { ClinicalRelationshipRecord } from '../shared/clinical-relationships.ts';

/** Called only within the existing authorized profile/session/origin dispatch. */
export async function handleClinicalRelationshipRoute(context: {
  resource?: string;
  id?: string;
  action?: string;
  method: string;
  params: URLSearchParams;
  req: IncomingMessage;
  db: Database;
  root: string;
  profileId: string;
  body: (req: IncomingMessage, max?: number) => Promise<Buffer>;
  respond: (data: unknown, options?: Record<string, unknown>, status?: number) => void;
}): Promise<boolean> {
  const { resource, id, action, method, params, req, db, root, profileId, body, respond } = context;
  if (resource !== 'clinical-relationships') return false;
  if (method === 'GET' && id === 'pair' && !action) {
    respond(
      readClinicalRelationshipPair(
        db,
        root,
        profileId,
        {
          kind: params.get('leftKind'),
          recordId: params.get('leftRecordId'),
        } as ClinicalRelationshipRecord,
        {
          kind: params.get('rightKind'),
          recordId: params.get('rightRecordId'),
        } as ClinicalRelationshipRecord,
      ),
    );
    return true;
  }
  if (method === 'GET' && id === 'operations' && action) {
    respond(getClinicalRelationshipReceipt(db, profileId, action));
    return true;
  }
  if (method === 'GET' && !action && (!id || id === 'history')) {
    const kind = params.get('kind'),
      recordId = params.get('recordId');
    if (
      !['observation', 'procedure', 'medication', 'document'].includes(kind || '') ||
      !recordId ||
      recordId.length > 500
    )
      throw new HttpError(400, 'RELATIONSHIP_INPUT', 'Choose one accepted record');
    const record = { kind, recordId } as ClinicalRelationshipRecord;
    if (id === 'history') {
      const window: { beforeSequence?: number; limit?: number } = {};
      for (const key of ['beforeSequence', 'limit'] as const) {
        const value = params.get(key);
        if (value === null) continue;
        if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
          throw new HttpError(400, 'RELATIONSHIP_INPUT', 'Choose a bounded history page');
        window[key] = Number(value);
      }
      respond(clinicalRelationshipHistory(db, profileId, record, window));
    } else respond(clinicalRelationshipProjection(db, profileId, record));
    return true;
  }
  if (method !== 'POST' || action || !['preview', 'apply'].includes(id || ''))
    throw new HttpError(404, 'NOT_FOUND', 'Clinical relationship action not found');
  if ((req.headers['content-type'] || '').split(';')[0] !== 'application/json')
    throw new HttpError(415, 'CONTENT_TYPE', 'Use application/json');
  let input: unknown;
  try {
    input = JSON.parse((await body(req, 256 * 1024)).toString('utf8'));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_JSON', 'Expected a JSON object');
  }
  respond(
    id === 'preview'
      ? previewClinicalRelationship(db, root, profileId, input)
      : applyClinicalRelationship(db, root, profileId, input),
  );
  return true;
}
