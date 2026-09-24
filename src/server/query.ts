import { fork } from 'node:child_process';
import type { QueryData, QueryReply } from './query-contract.ts';
import { HttpError } from './database.ts';
let activeWorkers = 0;
const MAX_QUERY_WORKERS = 2;
export function readQuery(
  path: string,
  input: { sql?: unknown; params?: unknown; limit?: unknown },
  { timeoutMs = 2500 } = {},
) {
  if (typeof input.sql !== 'string' || !input.sql.trim() || input.sql.length > 32768)
    throw new HttpError(400, 'INVALID_QUERY', 'SQL must contain 1–32768 characters');
  const params = input.params ?? [];
  if (
    !Array.isArray(params) ||
    params.length > 100 ||
    params.some((p) => p !== null && !['string', 'number'].includes(typeof p))
  )
    throw new HttpError(
      400,
      'INVALID_QUERY',
      'Use an array of string, number or null bound parameters',
    );
  const limit = Math.min(2000, Math.max(1, Number(input.limit) || 500));
  if (activeWorkers >= MAX_QUERY_WORKERS)
    throw new HttpError(
      429,
      'QUERY_BUSY',
      'Two SQL queries are already running; try again after one completes',
    );
  return new Promise<QueryData>((resolve, reject) => {
    const child = fork(new URL('./query-worker.ts', import.meta.url), [], {
      execArgv: ['--max-old-space-size=64'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    activeWorkers++;
    let done = false;
    const finish = (err: Error | null, data?: QueryData) => {
      if (done) return;
      done = true;
      activeWorkers--;
      clearTimeout(timer);
      child.kill('SIGKILL');
      err ? reject(err) : resolve(data!);
    };
    const timer = setTimeout(
      () =>
        finish(new HttpError(408, 'QUERY_TIMEOUT', 'The read-only query exceeded its time limit')),
      timeoutMs,
    );
    child.on('message', (payload) => {
      const message = payload as QueryReply;
      return message.error
        ? finish(new HttpError(400, 'QUERY_REJECTED', message.error))
        : finish(null, message.data);
    });
    child.on('error', () => finish(new HttpError(500, 'QUERY_FAILED', 'Query process failed')));
    child.on('exit', () => {
      if (!done)
        finish(
          new HttpError(
            400,
            'QUERY_FAILED',
            'Query exceeded its resource limits or could not complete',
          ),
        );
    });
    child.send({ path, sql: input.sql, params, limit });
  });
}
