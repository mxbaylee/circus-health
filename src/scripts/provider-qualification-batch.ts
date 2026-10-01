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
  // Upload publication now atomically enqueues the original. The POST above
  // can therefore reconcile that already-owned automatic batch instead of
  // creating one under our operation ID. Pin the returned receipt only after
  // verifying it contains exactly this new profile's selected original.
  check(
    batch.profileId === options.profileId &&
      batch.items.length === 1 &&
      batch.items[0]?.intakeId === options.intakeId &&
      batch.automaticRun === true &&
      typeof batch.operationId === 'string' &&
      batch.operationId.length > 0,
    'Qualification batch scope changed at creation.',
  );
  const batchOperationId = batch.operationId;
  const sourceHash = batch.items[0]?.sourceHash;
  for (;;) {
    signal.throwIfAborted();
    const invalidScope = [
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(batch.id) && 'id_shape',
      batch.id !== batchId && 'batch_id',
      batch.profileId !== options.profileId && 'profile_id',
      batch.operationId !== batchOperationId && 'operation_id',
      batch.items.length !== 1 && 'item_count',
      batch.items[0]?.intakeId !== options.intakeId && 'intake_id',
      batch.items[0]?.sourceHash !== sourceHash && 'source_hash',
    ].filter(Boolean);
    check(
      invalidScope.length === 0,
      `Qualification batch scope changed: ${invalidScope.join(',')}.`,
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
