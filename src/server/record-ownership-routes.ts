import type { IncomingMessage } from 'node:http';
import { HttpError, type Database } from './database.ts';
import {
  previewRecordOwnership,
  commitRecordOwnership,
  getRecordOwnershipReceipt,
  ownershipPeople,
  prepareOwnershipEvidence,
} from './record-ownership.ts';

/** Mounted only after the existing unlocked-profile, session and origin checks. */
export async function handleRecordOwnershipRoute(context: {
  resource?: string;
  id?: string;
  action?: string;
  method: string;
  req: IncomingMessage;
  db: Database;
  root: string;
  profileId: string;
  body: (req: IncomingMessage, max?: number) => Promise<Buffer>;
  respond: (data: unknown, options?: Record<string, unknown>, status?: number) => void;
}): Promise<boolean> {
  const { resource, id, action, method, req, db, root, profileId, body, respond } = context;
  if (resource !== 'record-ownership') return false;
  if (method === 'GET' && id === 'people' && !action) {
    respond(ownershipPeople(db, profileId));
    return true;
  }
  if (method === 'GET' && id && !action && id !== 'preview') {
    respond(getRecordOwnershipReceipt(db, profileId, id));
    return true;
  }
  if (method !== 'POST' || action || (id && id !== 'preview'))
    throw new HttpError(404, 'NOT_FOUND', 'Ownership correction action not found');
  if ((req.headers['content-type'] || '').split(';')[0] !== 'application/json')
    throw new HttpError(415, 'CONTENT_TYPE', 'Use application/json');
  let input: unknown;
  try {
    input = JSON.parse((await body(req, 1024 * 1024)).toString('utf8'));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_JSON', 'Expected a JSON object');
  }
  // Replays resolve before any original read; this also works after the source was archived.
  if (id !== 'preview' && input && typeof input === 'object' && 'operationId' in input) {
    try {
      getRecordOwnershipReceipt(db, profileId, String(input.operationId));
      respond(commitRecordOwnership(db, root, profileId, input));
      return true;
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'OWNERSHIP_NOT_FOUND') throw error;
    }
  }
  await prepareOwnershipEvidence(
    db,
    root,
    profileId,
    id === 'preview' ? input : (input as { request?: unknown })?.request,
  );
  respond(
    id === 'preview'
      ? previewRecordOwnership(db, root, profileId, input)
      : commitRecordOwnership(db, root, profileId, input),
  );
  return true;
}
