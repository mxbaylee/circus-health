import { HttpError, type Database } from './database.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IntakeBatchManager } from './intake-batches.ts';
import { currentClinicalOperation, runExclusiveClinicalOperation } from './clinical-operation.ts';
import { intakeIdentityRequestLifetime } from './intake-identity-request.ts';
import { assertIntakeOwner } from './intake.ts';
import { currentVaultCompactAuthorization } from './vault-app.ts';

interface IntakeBatchRouteContext {
  resource?: string;
  id?: string;
  action?: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  db: Database;
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
  res,
  db,
  profileId,
  respond,
  jsonBody,
  intakeBatches,
}: IntakeBatchRouteContext): Promise<boolean> {
  if (resource !== 'intake-batches') return false;
  const lifetime = intakeIdentityRequestLifetime(req, res);
  try {
    let work: () => unknown | Promise<unknown>;
    let status = 200;
    if (method === 'GET' && !id) work = () => intakeBatches.list(profileId);
    else if (method === 'GET' && id && !action) work = () => intakeBatches.get(profileId, id);
    else if (method === 'POST' && !id) {
      const input = (await jsonBody(req)) as Parameters<IntakeBatchManager['createPrepared']>[1];
      work = () => intakeBatches.createPrepared(profileId, input);
      status = 201;
    } else if (method === 'POST' && id && action === 'stop') {
      await jsonBody(req);
      work = () => intakeBatches.stop(profileId, id);
    } else if (method === 'POST' && id && action === 'resume') {
      await jsonBody(req);
      work = () => intakeBatches.resume(profileId, id);
    } else if (method === 'POST' && id && action === 'retry-exceptions') {
      await jsonBody(req);
      work = () => intakeBatches.retryExceptions(profileId, id);
    } else throw new HttpError(404, 'NOT_FOUND', 'Reading batch action not found');
    const assertRunning = () => {
      lifetime.signal.throwIfAborted();
      currentVaultCompactAuthorization(db, profileId);
      assertIntakeOwner(db, profileId);
    };
    // Even reads can recover a batch journal. Admit host work after receiving
    // the request body so it cannot invalidate a concurrent upload's proof.
    await runExclusiveClinicalOperation(
      db,
      async () => {
        const result = await work();
        assertRunning();
        respond(result, {}, status);
      },
      { operation: currentClinicalOperation(db), signal: lifetime.signal, assertRunning },
    );
    return true;
  } finally {
    lifetime.dispose();
  }
}
