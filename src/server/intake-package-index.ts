import { DatabaseSync } from 'node:sqlite';
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { PackageInspectionError, runBoundedPackageWorker } from './intake-package-worker.ts';
import {
  validPackageDescriptor,
  type PackageCentralDescriptor,
  type PackageSourceBinding,
  type PackageTraversalSummary,
  type VerifiedPackageDescriptor,
} from './intake-package-protocol.ts';
import type { PackageSourceLease } from './intake-package-source-lease.ts';

export interface PackageMetadataChunk {
  ordinal: number;
  offset: number;
  data: Uint8Array;
  last: boolean;
  recordHash: string;
}
interface Row {
  ordinal: number | null;
  value: string;
  verified: string | null;
}
declare const prefixBrand: unique symbol;
export interface CheckedPackagePrefix {
  readonly [prefixBrand]: true;
}
const prefixes = new WeakMap<
  CheckedPackagePrefix,
  {
    binding: PackageSourceBinding;
    count: number;
    read: (ordinal: number) => VerifiedPackageDescriptor;
    assertAuthority: () => void;
  }
>();
/** Domain-only mint after checking the retained selected attempt's roots. */
export function authorizePackageVerifiedPrefix(input: {
  binding: PackageSourceBinding;
  count: number;
  read: (ordinal: number) => VerifiedPackageDescriptor;
  assertAuthority: () => void;
}): CheckedPackagePrefix {
  if (!Number.isSafeInteger(input.count) || input.count < 0)
    throw new PackageInspectionError('Invalid retained prefix count', 'PACKAGE_PROTOCOL');
  input.assertAuthority();
  const value = Object.freeze({}) as CheckedPackagePrefix;
  prefixes.set(value, { ...input, binding: { ...input.binding } });
  return value;
}
function storageError(error: unknown): never {
  if (error instanceof PackageInspectionError) throw error;
  const e = error as NodeJS.ErrnoException & { errcode?: number };
  if (['ENOSPC', 'EDQUOT'].includes(e.code || '') || e.errcode === 13)
    throw new PackageInspectionError(
      'Inventory staging storage is full; free runtime space and retry.',
      'PACKAGE_STORAGE_FULL',
    );
  if (
    ['EIO', 'EROFS', 'EACCES', 'EBADF'].includes(e.code || '') ||
    [8, 10, 14].includes(e.errcode || 0)
  )
    throw new PackageInspectionError(
      'Inventory staging storage is unavailable; restore writable storage and retry.',
      'PACKAGE_STORAGE',
    );
  throw error;
}
function spoolOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    return storageError(error);
  }
}
function summaryValue(value: unknown): value is PackageTraversalSummary {
  return (
    !!value &&
    typeof value === 'object' &&
    ['entries', 'members', 'expandedBytes'].every((key) => {
      const count = (value as Record<string, unknown>)[key];
      return Number.isSafeInteger(count) && (count as number) >= 0;
    })
  );
}
const sum = (left: number, right: number) => {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new PackageInspectionError(
      'ZIP metadata count is outside the integer range',
      'PACKAGE_SIZE',
    );
  return value;
};

/** Host-owned disposable preparation. No successful method on this object is
 * authority for a durable member, completed plan, or absence after recovery. */
export async function buildPackageIndex({
  lease,
  scratchRoot,
  onVerifiedBatch,
  verifiedPrefix,
}: {
  lease: PackageSourceLease;
  scratchRoot: string;
  verifiedPrefix?: CheckedPackagePrefix;
  onVerifiedBatch?: (batch: {
    chunks: PackageMetadataChunk[];
    encodedBytes: number;
    assertRunning: () => void;
  }) => Promise<void>;
}) {
  lease.assertCurrent();
  const prefix = verifiedPrefix && prefixes.get(verifiedPrefix);
  if (
    verifiedPrefix &&
    (!prefix || JSON.stringify(prefix.binding) !== JSON.stringify(lease.binding))
  )
    throw new PackageInspectionError(
      'Retained prefix belongs to another source',
      'PACKAGE_SELECTION',
    );
  const parent = realpathSync(scratchRoot),
    root = resolve(parent, '.package-index-staging');
  let directory: string | undefined, db: DatabaseSync | undefined;
  let closed = false,
    complete = false;
  const io = {
    metadataWrittenBytes: 0,
    metadataReadBytes: 0,
    nameHashBytes: 0,
    verifiedHashBytes: 0,
    peakBatchBytes: 0,
    peakRecordBytes: 0,
  };
  try {
    spoolOperation(() => mkdirSync(root, { recursive: true, mode: 0o700 }));
    if (
      realpathSync(root) !== root ||
      !lstatSync(root).isDirectory() ||
      (lstatSync(root).mode & 0o777) !== 0o700
    )
      throw new PackageInspectionError(
        'Invalid private inventory staging directory',
        'PACKAGE_SOURCE',
      );
    directory = spoolOperation(() => mkdtempSync(join(root, 'inventory-')));
    const path = join(directory, 'index.sqlite');
    spoolOperation(() => closeSync(openSync(path, 'wx', 0o600)));
    db = spoolOperation(() => new DatabaseSync(path));
    spoolOperation(() =>
      db!.exec(
        'PRAGMA synchronous=OFF; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA journal_mode=DELETE; CREATE TABLE central(central INTEGER PRIMARY KEY, ordinal INTEGER UNIQUE, filename TEXT UNIQUE NOT NULL, name_hash TEXT NOT NULL, value TEXT NOT NULL, verified TEXT); CREATE INDEX names ON central(name_hash,filename); CREATE TABLE digests(digest TEXT NOT NULL, ordinal INTEGER NOT NULL, PRIMARY KEY(digest,ordinal));',
      ),
    );
    let entries = 0,
      members = 0,
      expandedBytes = 0,
      nextVerified = 0,
      centralComplete = false;
    let announced: PackageTraversalSummary | undefined;
    let requested: PackageCentralDescriptor | undefined;
    let requestedReuse: VerifiedPackageDescriptor | undefined;
    const read = (row: Row | undefined) => {
      if (!row)
        throw new PackageInspectionError(
          'Inventory spool has a missing ordinal',
          'PACKAGE_PROTOCOL',
        );
      io.metadataReadBytes += Buffer.byteLength(row.value);
      const d: unknown = JSON.parse(row.value);
      if (!validPackageDescriptor(d))
        throw new PackageInspectionError(
          'Inventory spool declaration is invalid',
          'PACKAGE_PROTOCOL',
        );
      return d;
    };
    const insert = db.prepare(
      'INSERT INTO central(central,ordinal,filename,name_hash,value) VALUES(?,?,?,?,?)',
    );
    const member = db.prepare('SELECT ordinal,value,verified FROM central WHERE ordinal=?');
    const result = await runBoundedPackageWorker({
      lease,
      onRecord: async (record, controls) => {
        lease.assertCurrent();
        if (record.type === 'declaration') {
          const d = record.descriptor;
          if (
            centralComplete ||
            !validPackageDescriptor(d) ||
            d.centralOrdinal !== entries ||
            d.ordinal !== (d.directory ? null : members)
          )
            throw new PackageInspectionError(
              'ZIP central declaration order is invalid',
              'PACKAGE_PROTOCOL',
            );
          const value = JSON.stringify(d),
            bytes = Buffer.byteLength(value);
          io.peakRecordBytes = Math.max(io.peakRecordBytes, bytes);
          const nameHash = createHash('sha256').update(d.filename).digest('hex');
          io.nameHashBytes += Buffer.byteLength(d.filename);
          // Hash routes lookup; exact decoded spelling decides uniqueness.
          if (
            db!
              .prepare('SELECT 1 FROM central WHERE name_hash=? AND filename=?')
              .get(nameHash, d.filename)
          )
            throw new PackageInspectionError(
              'Unsafe or duplicate ZIP member',
              'PACKAGE_METADATA',
              d.filename,
              d.ordinal ?? undefined,
            );
          spoolOperation(() =>
            insert.run(d.centralOrdinal, d.ordinal, d.filename, nameHash, value),
          );
          io.metadataWrittenBytes += bytes;
          entries++;
          if (!d.directory) {
            members++;
            expandedBytes = sum(expandedBytes, d.bytes);
          }
          return { type: 'ack', sequence: d.centralOrdinal };
        }
        if (record.type === 'central_complete') {
          if (
            centralComplete ||
            !summaryValue(record.summary) ||
            record.summary.entries !== entries ||
            record.summary.members !== members ||
            record.summary.expandedBytes !== expandedBytes ||
            (prefix?.count ?? 0) > members
          )
            throw new PackageInspectionError(
              'ZIP central completion disagrees with staged declarations',
              'PACKAGE_PROTOCOL',
            );
          announced = record.summary;
          centralComplete = true;
          return { type: 'ack', sequence: entries };
        }
        if (record.type === 'need_descriptor') {
          if (
            !centralComplete ||
            requested ||
            record.ordinal !== nextVerified ||
            nextVerified >= members
          )
            throw new PackageInspectionError(
              'ZIP verification requested an invalid ordinal',
              'PACKAGE_PROTOCOL',
            );
          requested = read(member.get(nextVerified) as unknown as Row | undefined);
          if (prefix && nextVerified < prefix.count) {
            prefix.assertAuthority();
            requestedReuse = prefix.read(nextVerified);
            const { sourceHash, duplicateOrdinal: _duplicate, ...retained } = requestedReuse;
            if (
              !validPackageDescriptor(retained) ||
              !/^[a-f0-9]{64}$/.test(sourceHash) ||
              JSON.stringify(retained) !== JSON.stringify(requested)
            )
              throw new PackageInspectionError(
                'Retained prefix differs from the current ZIP declaration',
                'PACKAGE_PREFIX_CHANGED',
                requested.filename,
                nextVerified,
              );
            prefix.assertAuthority();
            lease.assertCurrent();
            return { type: 'verified_descriptor', descriptor: requested, sourceHash };
          }
          return { type: 'descriptor', descriptor: requested };
        }
        if (record.type === 'member_verified' || record.type === 'member_reused') {
          if (
            !requested ||
            (record.type === 'member_reused') !== !!requestedReuse ||
            JSON.stringify(record.descriptor) !== JSON.stringify(requested) ||
            record.descriptor == null ||
            typeof record.sourceHash !== 'string' ||
            !/^[a-f0-9]{64}$/.test(record.sourceHash)
          )
            throw new PackageInspectionError(
              'ZIP verified member disagrees with staged declaration',
              'PACKAGE_PROTOCOL',
            );
          const previous = db!
            .prepare('SELECT ordinal FROM digests WHERE digest=? ORDER BY ordinal LIMIT 1')
            .get(record.sourceHash) as { ordinal: number } | undefined;
          const verified: VerifiedPackageDescriptor = {
            ...requested,
            ordinal: nextVerified,
            sourceHash: record.sourceHash,
            duplicateOrdinal: previous?.ordinal ?? null,
          };
          if (requestedReuse) {
            prefix!.assertAuthority();
            if (JSON.stringify(requestedReuse) !== JSON.stringify(verified))
              throw new PackageInspectionError(
                'Retained prefix digest or duplicate identity changed',
                'PACKAGE_PREFIX_CHANGED',
                requested.filename,
                nextVerified,
              );
          }
          const value = JSON.stringify(verified),
            bytes = Buffer.from(value);
          const recordHash = createHash('sha256').update(bytes).digest('hex');
          io.verifiedHashBytes += bytes.length;
          io.peakRecordBytes = Math.max(io.peakRecordBytes, bytes.length);
          spoolOperation(() =>
            db!
              .prepare('UPDATE central SET verified=? WHERE ordinal=? AND verified IS NULL')
              .run(value, nextVerified),
          );
          spoolOperation(() =>
            db!
              .prepare('INSERT INTO digests(digest,ordinal) VALUES(?,?)')
              .run(verified.sourceHash, nextVerified),
          );
          io.metadataWrittenBytes += bytes.length;
          if (onVerifiedBatch) {
            for (let batchStart = 0; batchStart < bytes.length; batchStart += 32768) {
              const chunks: PackageMetadataChunk[] = [];
              let encodedBytes = 0;
              for (
                let offset = batchStart;
                offset < Math.min(bytes.length, batchStart + 32768);
                offset += 4096
              ) {
                const data = Buffer.from(
                  bytes.subarray(offset, Math.min(bytes.length, offset + 4096)),
                );
                encodedBytes += data.length;
                chunks.push({
                  ordinal: nextVerified,
                  offset,
                  data,
                  last: offset + data.length === bytes.length,
                  recordHash,
                });
              }
              io.peakBatchBytes = Math.max(io.peakBatchBytes, encodedBytes);
              lease.assertCurrent();
              await onVerifiedBatch({
                chunks,
                encodedBytes,
                assertRunning: controls.assertRunning,
              });
              lease.assertCurrent();
            }
          }
          if (requestedReuse) prefix!.assertAuthority();
          const sequence = nextVerified;
          nextVerified++;
          requested = undefined;
          requestedReuse = undefined;
          return { type: 'ack', sequence };
        }
        if (record.type === 'complete') {
          if (
            !announced ||
            requested ||
            nextVerified !== members ||
            !summaryValue(record.summary) ||
            JSON.stringify(record.summary) !== JSON.stringify(announced)
          )
            throw new PackageInspectionError('ZIP inventory is incomplete', 'PACKAGE_INCOMPLETE');
          return;
        }
        throw new PackageInspectionError(
          'ZIP inventory received an unexpected frame',
          'PACKAGE_PROTOCOL',
        );
      },
    });
    lease.assertCurrent();
    if (
      !announced ||
      result.work.centralDeclarations !== entries ||
      result.work.membersVerified + result.work.membersReused !== members ||
      result.work.descriptorReads !== result.work.membersVerified ||
      result.work.membersReused !== (prefix?.count ?? 0)
    )
      throw new PackageInspectionError(
        'ZIP verified inventory counts disagree',
        'PACKAGE_PROTOCOL',
      );
    complete = true;
    const binding = Object.freeze({ ...lease.binding });
    const usable = () => {
      if (closed || !complete)
        throw new PackageInspectionError(
          'Disposable inventory is closed or incomplete',
          'PACKAGE_INCOMPLETE',
        );
    };
    const get = (ordinal: number): VerifiedPackageDescriptor | undefined => {
      usable();
      if (!Number.isSafeInteger(ordinal) || ordinal < 0)
        throw new PackageInspectionError('Invalid member ordinal', 'PACKAGE_SELECTION');
      const row = member.get(ordinal) as unknown as Row | undefined;
      if (!row?.verified) return undefined;
      io.metadataReadBytes += Buffer.byteLength(row.verified);
      const value = JSON.parse(row.verified) as VerifiedPackageDescriptor;
      if (
        !validPackageDescriptor(value) ||
        value.ordinal !== ordinal ||
        !/^[a-f0-9]{64}$/.test(value.sourceHash)
      )
        throw new PackageInspectionError('Inventory cache is corrupt', 'PACKAGE_PROTOCOL');
      return value;
    };
    return {
      binding,
      summary: Object.freeze({ ...announced }),
      work: result.work,
      io,
      member: get,
      // Explicit continuation within a large legal metadata record. Page bytes
      // remain bounded even when a single escaped filename exceeds the budget.
      readPage({
        ordinal = 0,
        byteOffset = 0,
        byteBudget = 32768,
      }: { ordinal?: number; byteOffset?: number; byteBudget?: number } = {}) {
        usable();
        if (
          !Number.isSafeInteger(ordinal) ||
          ordinal < 0 ||
          !Number.isSafeInteger(byteOffset) ||
          byteOffset < 0 ||
          !Number.isInteger(byteBudget) ||
          byteBudget < 1 ||
          byteBudget > 32768
        )
          throw new PackageInspectionError(
            'Invalid bounded inventory continuation',
            'PACKAGE_SELECTION',
          );
        const chunks: PackageMetadataChunk[] = [];
        let encodedBytes = 0;
        while (ordinal < members && encodedBytes < byteBudget) {
          const value = get(ordinal)!;
          const bytes = Buffer.from(JSON.stringify(value));
          if (byteOffset >= bytes.length)
            throw new PackageInspectionError(
              'Invalid inventory record offset',
              'PACKAGE_SELECTION',
            );
          const recordHash = createHash('sha256').update(bytes).digest('hex');
          io.verifiedHashBytes += bytes.length;
          while (byteOffset < bytes.length && encodedBytes < byteBudget) {
            const data = Buffer.from(
              bytes.subarray(
                byteOffset,
                Math.min(bytes.length, byteOffset + 4096, byteOffset + byteBudget - encodedBytes),
              ),
            );
            chunks.push({
              ordinal,
              offset: byteOffset,
              data,
              last: byteOffset + data.length === bytes.length,
              recordHash,
            });
            byteOffset += data.length;
            encodedBytes += data.length;
          }
          if (byteOffset === bytes.length) {
            ordinal++;
            byteOffset = 0;
          }
        }
        io.peakBatchBytes = Math.max(io.peakBatchBytes, encodedBytes);
        return { chunks, encodedBytes, next: ordinal < members ? { ordinal, byteOffset } : null };
      },
      *range({ offset = 0, limit = 50 }: { offset?: number; limit?: number } = {}) {
        usable();
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 200
        )
          throw new PackageInspectionError('Invalid bounded inventory window', 'PACKAGE_SELECTION');
        for (let ordinal = offset; ordinal < Math.min(members, offset + limit); ordinal++)
          yield get(ordinal)!;
      },
      *membersByExactName(filename: string) {
        usable();
        const hash = createHash('sha256').update(filename).digest('hex');
        const row = db!
          .prepare('SELECT ordinal FROM central WHERE name_hash=? AND filename=?')
          .get(hash, filename) as { ordinal: number | null } | undefined;
        if (row?.ordinal != null) yield get(row.ordinal)!;
      },
      *membersByDigest(sourceHash: string, afterOrdinal = -1, limit = 50) {
        usable();
        if (
          !/^[a-f0-9]{64}$/.test(sourceHash) ||
          !Number.isSafeInteger(afterOrdinal) ||
          afterOrdinal < -1 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 200
        )
          throw new PackageInspectionError('Invalid content candidate window', 'PACKAGE_SELECTION');
        for (const row of db!
          .prepare(
            'SELECT ordinal FROM digests WHERE digest=? AND ordinal>? ORDER BY ordinal LIMIT ?',
          )
          .iterate(sourceHash, afterOrdinal, limit))
          yield get(Number(row.ordinal))!;
      },
      close() {
        if (!closed) {
          closed = true;
          db!.close();
          rmSync(directory!, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* Preserve the producer or authority failure. */
    }
    try {
      if (directory) rmSync(directory, { recursive: true, force: true });
    } catch {
      /* Scratch is disposable and cannot replace the primary error. */
    }
    throw error;
  }
}

// Only the domain authority adapter may mint this capability after checking a
// complete selected inventory path. A disposable index alone cannot mint it.
export interface CheckedPackageMember {
  readonly inventoryRoot: string;
}
const authorized = new WeakMap<
  CheckedPackageMember,
  {
    binding: PackageSourceBinding;
    descriptor: VerifiedPackageDescriptor;
    assertAuthority: () => void;
  }
>();
export function authorizeCheckedPackageMember({
  binding,
  descriptor,
  inventoryRoot,
  assertAuthority,
}: {
  binding: PackageSourceBinding;
  descriptor: VerifiedPackageDescriptor;
  inventoryRoot: string;
  assertAuthority: () => void;
}): CheckedPackageMember {
  assertAuthority();
  if (
    !validPackageDescriptor(descriptor) ||
    descriptor.directory ||
    descriptor.ordinal === null ||
    !/^[a-f0-9]{64}$/.test(descriptor.sourceHash) ||
    !/^[a-f0-9]{64}$/.test(inventoryRoot)
  )
    throw new PackageInspectionError('Invalid checked inventory member', 'PACKAGE_SELECTION');
  const capability = Object.freeze({ inventoryRoot });
  authorized.set(capability, {
    binding: { ...binding },
    descriptor: { ...descriptor },
    assertAuthority,
  });
  return capability;
}
export async function extractCheckedPackageMember({
  lease,
  member,
  outputFd,
}: {
  lease: Pick<PackageSourceLease, 'sourceFd' | 'binding' | 'assertCurrent'>;
  member: CheckedPackageMember;
  outputFd: number;
}) {
  const checked = authorized.get(member);
  if (!checked || JSON.stringify(checked.binding) !== JSON.stringify(lease.binding))
    throw new PackageInspectionError(
      'Selected member belongs to another source',
      'PACKAGE_SELECTION',
    );
  checked.assertAuthority();
  lease.assertCurrent();
  let verified = false;
  const { sourceHash, duplicateOrdinal: _duplicate, ...descriptor } = checked.descriptor;
  const result = await runBoundedPackageWorker({
    lease: {
      ...lease,
      assertCurrent() {
        lease.assertCurrent();
        checked.assertAuthority();
      },
    },
    outputFd,
    selected: { descriptor, sourceHash },
    onRecord: async (record) => {
      if (record.type === 'selected_verified') {
        if (
          verified ||
          JSON.stringify(record.descriptor) !== JSON.stringify(descriptor) ||
          record.sourceHash !== checked.descriptor.sourceHash
        )
          throw new PackageInspectionError(
            'Selected output disagrees with checked descriptor',
            'PACKAGE_PROTOCOL',
          );
        verified = true;
        return { type: 'ack', sequence: 0 };
      }
      if (record.type !== 'complete' || !verified)
        throw new PackageInspectionError('Selected output did not complete', 'PACKAGE_PROTOCOL');
    },
  });
  if (
    result.work.centralDeclarations !== 0 ||
    result.work.descriptorReads !== 1 ||
    result.work.membersVerified !== 1 ||
    result.work.writtenBytes !== checked.descriptor.bytes ||
    fstatSync(outputFd).size !== checked.descriptor.bytes
  )
    throw new PackageInspectionError(
      'Selected member repeated central inventory work',
      'PACKAGE_PROTOCOL',
    );
  checked.assertAuthority();
  lease.assertCurrent();
  return result;
}
