import { spawn } from 'node:child_process';
import { fstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { recordIntakeFileWork, recordIntakePackageWorkerWork } from './intake-file-work.ts';

export interface InspectedPackageMember {
  ordinal: number;
  filename: string;
  bytes: number;
  compressedBytes: number;
  sourceHash: string;
}
export interface PackageInspectionWork {
  /** Expanded member payload only; ZIP headers, compressed source reads,
   * parent verification, encryption and allocator/RSS totals are separate. */
  memberReadBytes: number;
  hashBytes: number;
  crcBytes: number;
  writtenBytes: number;
  peakChunkBytes: number;
  memberChunks: number;
  membersVerified: number;
  entries: number;
}
export const emptyPackageInspectionWork = (): PackageInspectionWork => ({
  memberReadBytes: 0,
  hashBytes: 0,
  crcBytes: 0,
  writtenBytes: 0,
  peakChunkBytes: 0,
  memberChunks: 0,
  membersVerified: 0,
  entries: 0,
});
export class PackageInspectionError extends Error {
  readonly reasonCode: string;
  readonly filename?: string;
  readonly ordinal?: number;
  readonly work?: PackageInspectionWork;
  readonly traversalWork?: import('./intake-package-protocol.ts').PackageTraversalWork;
  constructor(
    message: string,
    reasonCode = 'PACKAGE_INSPECTION',
    filename?: string,
    ordinal?: number,
    work?: PackageInspectionWork,
    traversalWork?: import('./intake-package-protocol.ts').PackageTraversalWork,
  ) {
    super(message);
    this.reasonCode = reasonCode;
    this.filename = filename;
    this.ordinal = ordinal;
    this.work = work;
    this.traversalWork = traversalWork;
  }
}
const script = fileURLToPath(new URL('./intake-package-inspector.ts', import.meta.url));
const MAX_FRAME_BYTES = 32 * 1024;
const identity = (fd: number) => {
  const stat = fstatSync(fd, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
};
const safeName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 4000 &&
  !/[\x00-\x1f\x7f\\:]/.test(value) &&
  !value.startsWith('/') &&
  !value.split('/').some((part) => ['', '.', '..'].includes(part));
const workValue = (value: unknown): value is PackageInspectionWork => {
  if (!value || typeof value !== 'object') return false;
  return Object.keys(emptyPackageInspectionWork()).every((key) => {
    const count = (value as Record<string, unknown>)[key];
    return Number.isSafeInteger(count) && (count as number) >= 0;
  });
};
/** Inherits only caller-opened descriptors. The caller retains ownership and fsyncs
 * successful output before publication; neither paths nor payload bytes cross IPC. */
export async function inspectPackageFile({
  sourceFd,
  selectedOrdinal,
  outputFd,
  assertRunning = () => {},
}: {
  sourceFd: number;
  selectedOrdinal?: number;
  outputFd?: number;
  assertRunning?: () => void;
}): Promise<{ members: InspectedPackageMember[]; work: PackageInspectionWork }> {
  assertRunning();
  const source = fstatSync(sourceFd);
  if (!source.isFile()) throw new PackageInspectionError('ZIP source is not a regular file');
  if (
    (selectedOrdinal === undefined) !== (outputFd === undefined) ||
    (selectedOrdinal !== undefined &&
      (!Number.isSafeInteger(selectedOrdinal) || selectedOrdinal < 0))
  )
    throw new PackageInspectionError(
      'ZIP selection requires an ordinal and private output descriptor',
    );
  if (outputFd !== undefined) {
    const output = fstatSync(outputFd);
    if (
      !output.isFile() ||
      output.size !== 0 ||
      (source.dev === output.dev && source.ino === output.ino)
    )
      throw new PackageInspectionError('ZIP output must be an empty private regular file');
  }
  const initialIdentity = identity(sourceFd);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--max-old-space-size=128',
        script,
        ...(selectedOrdinal === undefined ? [] : [String(selectedOrdinal)]),
      ],
      {
        stdio: [
          'ignore',
          'pipe',
          'ignore',
          sourceFd,
          ...(outputFd === undefined ? [] : [outputFd]),
        ],
        env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C' },
      },
    );
    const members: InspectedPackageMember[] = [];
    let pending = Buffer.alloc(0),
      namesBytes = 0,
      lastProgress = Date.now();
    let work = emptyPackageInspectionWork(),
      complete = false,
      settled = false;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ||= error;
      child.kill('SIGKILL');
    };
    const poll = setInterval(() => {
      try {
        assertRunning();
      } catch (error) {
        stop(error instanceof Error ? error : Error('ZIP inspection cancelled'));
      }
      if (Date.now() - lastProgress > 30_000)
        stop(
          new PackageInspectionError(
            'ZIP inspection stopped making progress; original retained',
            'PACKAGE_STALLED',
            undefined,
            undefined,
            work,
          ),
        );
    }, 100);
    const frame = (raw: Buffer) => {
      const message = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      if (complete) throw Error('Unexpected frame after completion');
      if (message.type === 'progress' && workValue(message.work)) {
        const next = message.work;
        if (
          Object.keys(work).some(
            (key) =>
              next[key as keyof PackageInspectionWork] < work[key as keyof PackageInspectionWork],
          )
        )
          throw Error('Invalid progress');
        if (
          Object.keys(work).some(
            (key) =>
              next[key as keyof PackageInspectionWork] > work[key as keyof PackageInspectionWork],
          )
        )
          lastProgress = Date.now();
        work = next;
      } else if (message.type === 'member') {
        const member = message.member as InspectedPackageMember;
        if (
          !member ||
          !safeName(member.filename) ||
          !Number.isSafeInteger(member.ordinal) ||
          member.ordinal < 0 ||
          !Number.isSafeInteger(member.bytes) ||
          member.bytes < 0 ||
          !Number.isSafeInteger(member.compressedBytes) ||
          member.compressedBytes < 0 ||
          !/^[a-f0-9]{64}$/.test(member.sourceHash) ||
          (selectedOrdinal === undefined
            ? member.ordinal !== members.length
            : member.ordinal !== selectedOrdinal || members.length !== 0)
        )
          throw Error('Invalid member');
        namesBytes += Buffer.byteLength(member.filename);
        if (members.length >= 5000 || namesBytes > 2 * 1024 * 1024)
          throw Error('Inventory overflow');
        members.push({
          ordinal: member.ordinal,
          filename: member.filename,
          bytes: member.bytes,
          compressedBytes: member.compressedBytes,
          sourceHash: member.sourceHash,
        });
        lastProgress = Date.now();
      } else if (message.type === 'complete' && workValue(message.work)) {
        work = message.work;
        complete = true;
      } else if (
        message.type === 'error' &&
        typeof message.message === 'string' &&
        message.message.length <= 500 &&
        typeof message.reasonCode === 'string' &&
        /^PACKAGE_[A-Z_]+$/.test(message.reasonCode)
      ) {
        throw new PackageInspectionError(
          message.message,
          message.reasonCode,
          safeName(message.filename) ? message.filename : undefined,
          Number.isSafeInteger(message.ordinal) && (message.ordinal as number) >= 0
            ? (message.ordinal as number)
            : undefined,
          workValue(message.work) ? message.work : work,
        );
      } else throw Error('Invalid worker frame');
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      if (failure) return;
      try {
        // Only the unfinished frame is retained, irrespective of transport chunk size.
        let offset = 0;
        while (offset < chunk.length) {
          const end = chunk.indexOf(10, offset);
          const piece = chunk.subarray(offset, end < 0 ? chunk.length : end);
          if (pending.length + piece.length > MAX_FRAME_BYTES) throw Error('Frame overflow');
          pending = pending.length ? Buffer.concat([pending, piece]) : Buffer.from(piece);
          if (end < 0) break;
          frame(pending);
          pending = Buffer.alloc(0);
          offset = end + 1;
        }
      } catch (error) {
        stop(
          error instanceof PackageInspectionError
            ? error
            : new PackageInspectionError(
                'ZIP inspector returned invalid metadata',
                'PACKAGE_PROTOCOL',
                undefined,
                undefined,
                work,
              ),
        );
      }
    });
    child.on('error', () =>
      stop(new PackageInspectionError('ZIP inspection worker unavailable', 'PACKAGE_WORKER')),
    );
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      try {
        if (failure) throw failure;
        assertRunning();
        if (
          code !== 0 ||
          !complete ||
          pending.length ||
          (selectedOrdinal !== undefined && members.length !== 1)
        )
          throw new PackageInspectionError(
            'ZIP inspection did not finish; original retained',
            'PACKAGE_INCOMPLETE',
            undefined,
            undefined,
            work,
          );
        if (identity(sourceFd) !== initialIdentity)
          throw new PackageInspectionError(
            'ZIP source changed during inspection',
            'PACKAGE_CHANGED',
          );
        if (outputFd !== undefined && fstatSync(outputFd).size !== members[0]!.bytes)
          throw new PackageInspectionError(
            'ZIP output size does not match verified member',
            'PACKAGE_CHANGED',
          );
        resolve({ members, work });
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Explicit new metadata traversal transport. No result-array compatibility
 * adapter is installed here: callers supply an awaited bounded disk/page sink. */
export async function runBoundedPackageWorker({
  lease,
  outputFd,
  selected,
  onRecord,
}: {
  lease: Pick<
    import('./intake-package-source-lease.ts').PackageSourceLease,
    'sourceFd' | 'binding' | 'assertCurrent'
  >;
  outputFd?: number;
  selected?: {
    descriptor: import('./intake-package-protocol.ts').PackageCentralDescriptor;
    sourceHash: string;
  };
  onRecord: (
    record: Record<string, unknown>,
    controls: { assertRunning: () => void },
  ) => Promise<Record<string, unknown> | void>;
}): Promise<{
  work: import('./intake-package-protocol.ts').PackageTraversalWork;
  summary?: import('./intake-package-protocol.ts').PackageTraversalSummary;
}> {
  const { readPackageRecords, writePackageRecord, emptyPackageTraversalWork, safePackageFilename } =
    await import('./intake-package-protocol.ts');
  lease.assertCurrent();
  if ((selected === undefined) !== (outputFd === undefined))
    throw new PackageInspectionError(
      'Selected extraction requires a private output descriptor',
      'PACKAGE_SELECTION',
    );
  if (outputFd !== undefined) {
    const output = fstatSync(outputFd),
      source = fstatSync(lease.sourceFd);
    if (
      !output.isFile() ||
      output.size !== 0 ||
      (output.ino === source.ino && output.dev === source.dev)
    )
      throw new PackageInspectionError(
        'Output must be an empty private regular file',
        'PACKAGE_SELECTION',
      );
  }
  recordIntakeFileWork('packageWorkerAttempts');
  const child = spawn(
    process.execPath,
    ['--max-old-space-size=128', script, selected ? '--checked-member' : '--bounded-inventory'],
    {
      stdio: [
        'pipe',
        'pipe',
        'ignore',
        lease.sourceFd,
        ...(outputFd === undefined ? [] : [outputFd]),
      ],
      env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C' },
    },
  );
  let failure: Error | undefined,
    complete = false,
    accepted = false,
    waitingHost = false,
    lastProgress = Date.now();
  let work = emptyPackageTraversalWork();
  let summary: import('./intake-package-protocol.ts').PackageTraversalSummary | undefined;
  let rejectFailure!: (error: Error) => void;
  const failureSignal = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  void failureSignal.catch(() => {});
  const assertRunning = () => {
    if (failure) throw failure;
    lease.assertCurrent();
  };
  const fail = (error: unknown) => {
    failure ||= error instanceof Error ? error : Error('Package operation failed');
    rejectFailure(failure);
    child.kill('SIGKILL');
  };
  child.on('error', () =>
    fail(new PackageInspectionError('ZIP worker is unavailable', 'PACKAGE_WORKER')),
  );
  child.stdin!.on('error', () =>
    fail(new PackageInspectionError('ZIP worker command transport failed', 'PACKAGE_PROTOCOL')),
  );
  const closed = new Promise<number | null>((resolve) =>
    child.once('close', (code) => resolve(code)),
  );
  const poll = setInterval(() => {
    try {
      lease.assertCurrent();
    } catch (error) {
      fail(error);
    }
    if (!waitingHost && Date.now() - lastProgress > 30_000)
      fail(new PackageInspectionError('ZIP worker stopped making progress', 'PACKAGE_STALLED'));
  }, 100);
  try {
    await writePackageRecord(child.stdin!, {
      type: 'begin',
      mode: selected ? 'selected' : 'inventory',
      bytes: lease.binding.bytes,
    });
    if (selected) await writePackageRecord(child.stdin!, { type: 'selected', ...selected });
    for await (const record of readPackageRecords(child.stdout!)) {
      if (failure) throw failure;
      lease.assertCurrent();
      if (complete)
        throw new PackageInspectionError(
          'ZIP worker sent facts after completion',
          'PACKAGE_PROTOCOL',
        );
      let advanced = false;
      if (record.work !== undefined) {
        if (
          !record.work ||
          typeof record.work !== 'object' ||
          Object.keys(record.work).length !== Object.keys(work).length ||
          Object.keys(work).some((key) => {
            const value = (record.work as Record<string, unknown>)[key];
            return (
              !Number.isSafeInteger(value) || (value as number) < work[key as keyof typeof work]
            );
          })
        )
          throw new PackageInspectionError(
            'ZIP worker work counts are invalid',
            'PACKAGE_PROTOCOL',
          );
        advanced = Object.keys(work).some(
          (key) => (record.work as Record<string, number>)[key] > work[key as keyof typeof work],
        );
        work = { ...record.work } as typeof work;
      }
      if (record.type === 'error') {
        if (
          typeof record.reasonCode !== 'string' ||
          !/^PACKAGE_[A-Z_]+$/.test(record.reasonCode) ||
          typeof record.message !== 'string' ||
          record.message.length > 500
        )
          throw new PackageInspectionError(
            'ZIP worker failure frame is invalid',
            'PACKAGE_PROTOCOL',
          );
        throw new PackageInspectionError(
          record.message,
          record.reasonCode,
          safePackageFilename(record.filename) ? record.filename : undefined,
          Number.isSafeInteger(record.ordinal) && (record.ordinal as number) >= 0
            ? (record.ordinal as number)
            : undefined,
          undefined,
          { ...work },
        );
      }
      if (
        ![
          'declaration',
          'central_complete',
          'need_descriptor',
          'member_verified',
          'member_reused',
          'selected_verified',
          'progress',
          'complete',
        ].includes(String(record.type))
      )
        throw new PackageInspectionError('ZIP worker frame is invalid', 'PACKAGE_PROTOCOL');
      if (record.type === 'progress') {
        if (record.work === undefined)
          throw new PackageInspectionError('ZIP progress has no work counts', 'PACKAGE_PROTOCOL');
        if (advanced) lastProgress = Date.now();
        continue;
      }
      waitingHost = true;
      let reply: Record<string, unknown> | void;
      try {
        reply = await Promise.race([onRecord(record, { assertRunning }), failureSignal]);
      } finally {
        waitingHost = false;
        lastProgress = Date.now();
      }
      lease.assertCurrent();
      if (reply) await writePackageRecord(child.stdin!, reply);
      if (record.type === 'complete') {
        complete = true;
        if (record.summary !== undefined) summary = record.summary as typeof summary;
        child.stdin!.end();
      }
    }
    child.stdin!.end();
    const code = await closed;
    if (failure) throw failure;
    lease.assertCurrent();
    if (code !== 0 || !complete)
      throw new PackageInspectionError('ZIP operation did not complete', 'PACKAGE_INCOMPLETE');
    accepted = true;
    return { work, summary };
  } catch (error) {
    fail(
      error instanceof Error &&
        (error.message === 'PACKAGE_PROTOCOL' || error instanceof SyntaxError)
        ? new PackageInspectionError('ZIP transport metadata is invalid', 'PACKAGE_PROTOCOL')
        : error,
    );
    await closed;
    throw failure;
  } finally {
    clearInterval(poll);
    recordIntakePackageWorkerWork(work, accepted);
  }
}
