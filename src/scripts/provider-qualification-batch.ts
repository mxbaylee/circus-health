import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hasPausedIntakeReading, type IntakeBatch } from '../shared/intake-batch.ts';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}

export function summarizeQualificationBatch(batch: IntakeBatch) {
  const item = batch.items[0];
  return {
    passed:
      batch.status === 'complete' &&
      batch.reason === null &&
      batch.items.length === 1 &&
      item?.status === 'review_ready' &&
      !hasPausedIntakeReading(item) &&
      item.readingJob?.extensions === 0 &&
      item.reading?.remainingUnits === 0 &&
      item.reading.pendingReadWindows === 0,
    batchId: batch.id,
    status: batch.status,
    reason: batch.reason,
    itemStatus: item?.status ?? null,
    itemReason: item?.reason ?? null,
    chatId: item?.chatId ?? null,
    reading: item?.reading ?? null,
    readingJob: item?.readingJob ?? null,
  };
}

/** Use the same single create request as normal Import. A chat can be idle
 * between productive server-managed slices while its coordinator is running.
 * Only that coordinator can declare the whole job terminal; this harness never
 * sends a convert, retry, resume or budget-extension request. */
export async function runQualificationBatch(options: {
  prefix: string;
  profileId: string;
  intakeId: string;
  operationId?: string;
  timeoutMs: number;
  signal: AbortSignal;
  request: <T>(path: string, input: unknown | undefined, signal: AbortSignal) => Promise<T>;
  onSnapshot: (batch: IntakeBatch) => void;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}) {
  const now = options.now ?? Date.now;
  const wait =
    options.wait ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]);
  const deadline = now() + options.timeoutMs;
  const operationId = options.operationId ?? randomUUID();
  check(
    options.prefix === `/api/profiles/${options.profileId}`,
    'Qualification batch scope is invalid.',
  );
  const path = options.prefix + '/intake-batches';
  signal.throwIfAborted();
  let batch = await options.request<IntakeBatch>(
    path,
    {
      operationId,
      intakeIds: [options.intakeId],
      appendToRunning: true,
    },
    signal,
  );
  const batchId = batch.id;
  const sourceHash = batch.items[0]?.sourceHash;
  for (;;) {
    signal.throwIfAborted();
    check(
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(batch.id) &&
        batch.id === batchId &&
        batch.profileId === options.profileId &&
        batch.operationId === operationId &&
        batch.items.length === 1 &&
        batch.items[0].intakeId === options.intakeId &&
        batch.items[0].sourceHash === sourceHash,
      'Qualification batch scope changed.',
    );
    options.onSnapshot(batch);
    if (batch.status !== 'running') return summarizeQualificationBatch(batch);
    check(now() < deadline, 'Autonomous batch conversion did not complete within its bound.');
    await wait(Math.min(5_000, deadline - now()), signal);
    check(now() < deadline, 'Autonomous batch conversion did not complete within its bound.');
    batch = await options.request<IntakeBatch>(
      path + `/${encodeURIComponent(batchId)}`,
      undefined,
      signal,
    );
  }
}
