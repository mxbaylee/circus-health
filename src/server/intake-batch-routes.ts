import { HttpError } from './database.ts';
import type { IncomingMessage } from 'node:http';
import type { IntakeBatchManager } from './intake-batches.ts';

interface IntakeBatchRouteContext {
  resource?: string;
  id?: string;
  action?: string;
  method: string;
  req: IncomingMessage;
  profileId: string;
  respond: (data: unknown, options?: Record<string, unknown>, status?: number) => void;
  jsonBody: (req: IncomingMessage) => Promise<unknown>;
  intakeBatches: IntakeBatchManager;
}

export async function handleIntakeBatchRoute({
  resource,
  id,
  action,
  method,
  req,
  profileId,
  respond,
  jsonBody,
  intakeBatches,
}: IntakeBatchRouteContext): Promise<boolean> {
  if (resource !== 'intake-batches') return false;
  if (method === 'GET' && !id) respond(intakeBatches.list(profileId));
  else if (method === 'GET' && id && !action) respond(intakeBatches.get(profileId, id));
  else if (method === 'POST' && !id)
    respond(
      intakeBatches.create(
        profileId,
        (await jsonBody(req)) as Parameters<IntakeBatchManager['create']>[1],
      ),
      {},
      201,
    );
  else if (method === 'POST' && id && action === 'stop') {
    await jsonBody(req);
    respond(intakeBatches.stop(profileId, id));
  } else if (method === 'POST' && id && action === 'resume') {
    await jsonBody(req);
    respond(intakeBatches.resume(profileId, id));
  } else throw new HttpError(404, 'NOT_FOUND', 'Reading batch action not found');
  return true;
}
