import { AsyncLocalStorage } from 'node:async_hooks';
import {
  copyFileSync,
  fsyncSync,
  readFileSync,
  renameSync,
  writeFileSync,
  type PathLike,
  type PathOrFileDescriptor,
} from 'node:fs';
import { beginManagedPhysicalMutation } from './clinical-review-physical-epoch.ts';
import type { PackageTraversalWork } from './intake-package-protocol.ts';

/** Filesystem API payload work for the calling intake APIs, not physical disk
 * traffic. Fixed numeric totals only; no paths, identities or file contents.
 * Stream reads/hashes are separate from whole-buffer reads/hashes. Candidate
 * version hashes have separate counters for actual serialized semantic input.
 * A failed writeFileSync may have partially written bytes: attempts and failures expose
 * that uncertainty; successful payload bytes are not a total for failed writes.
 * Bounded package-worker totals use separately named fields and count validated
 * worker reports, not parent I/O. Interrupted workers may have unreported work.
 * Metadata syscalls, allocator/string copies, encrypted-vault/HTTP upload receiver
 * I/O and unrelated consumers are outside these hooks. */
export function createIntakeFileWorkCounters() {
  return {
    readAttempts: 0,
    reads: 0,
    readBytes: 0,
    writeAttempts: 0,
    writes: 0,
    writeBytes: 0,
    writeFailures: 0,
    inspectionBufferBytes: 0,
    streamReadAttempts: 0,
    streamReadCalls: 0,
    streamReadBytes: 0,
    streamHashCalls: 0,
    streamHashBytes: 0,
    bufferHashCalls: 0,
    bufferHashBytes: 0,
    textHashCalls: 0,
    textHashBytes: 0,
    candidateVersionHashCalls: 0,
    candidateVersionHashBytes: 0,
    verificationCacheHits: 0,
    fsyncAttempts: 0,
    fsyncCalls: 0,
    renameAttempts: 0,
    renames: 0,
    publications: 0,
    copyAttempts: 0,
    copies: 0,
    copyRequestedBytes: 0,
    packageWorkerAttempts: 0,
    packageWorkerIncomplete: 0,
    packageWorkerCentralDeclarations: 0,
    packageWorkerDescriptorReads: 0,
    packageWorkerMemberReadBytes: 0,
    packageWorkerHashBytes: 0,
    packageWorkerCrcBytes: 0,
    packageWorkerWrittenBytes: 0,
    packageWorkerPeakChunkBytes: 0,
    packageWorkerMembersVerified: 0,
    packageWorkerMembersReused: 0,
    packageWorkerReusedPayloadBytes: 0,
  };
}
type FileWork = ReturnType<typeof createIntakeFileWorkCounters>;
const scope = new AsyncLocalStorage<FileWork>();
export function withIntakeFileWork<T>(counters: FileWork, run: () => T): T {
  return scope.run(counters, run);
}
export function recordIntakeFileWork(metric: keyof FileWork, amount = 1): void {
  const counters = scope.getStore();
  if (counters) counters[metric] += amount;
}
/** Aggregate once per worker, including its last validated report on failure. */
export function recordIntakePackageWorkerWork(work: PackageTraversalWork, completed: boolean) {
  const counters = scope.getStore();
  if (!counters) return;
  if (!completed) counters.packageWorkerIncomplete++;
  counters.packageWorkerCentralDeclarations += work.centralDeclarations;
  counters.packageWorkerDescriptorReads += work.descriptorReads;
  counters.packageWorkerMemberReadBytes += work.memberReadBytes;
  counters.packageWorkerHashBytes += work.hashBytes;
  counters.packageWorkerCrcBytes += work.crcBytes;
  counters.packageWorkerWrittenBytes += work.writtenBytes;
  counters.packageWorkerPeakChunkBytes = Math.max(
    counters.packageWorkerPeakChunkBytes,
    work.peakChunkBytes,
  );
  counters.packageWorkerMembersVerified += work.membersVerified;
  counters.packageWorkerMembersReused += work.membersReused;
  counters.packageWorkerReusedPayloadBytes += work.reusedPayloadBytes;
}
export function recordIntakeFileHash(value: string | Uint8Array): void {
  const counters = scope.getStore();
  if (!counters) return;
  if (typeof value === 'string') {
    counters.textHashCalls++;
    counters.textHashBytes += Buffer.byteLength(value);
  } else {
    counters.bufferHashCalls++;
    counters.bufferHashBytes += value.byteLength;
  }
}
/** Newly instrumented semantic version hashes; separate from existing file/text
 * digest counters so their before/after meaning remains unchanged. */
export function recordIntakeCandidateVersionHash(input: string): void {
  const counters = scope.getStore();
  if (!counters) return;
  counters.candidateVersionHashCalls++;
  counters.candidateVersionHashBytes += Buffer.byteLength(input);
}
export function readIntakeFileSync(path: PathOrFileDescriptor): Buffer {
  recordIntakeFileWork('readAttempts');
  const bytes = readFileSync(path);
  recordIntakeFileWork('reads');
  recordIntakeFileWork('readBytes', bytes.length);
  return bytes;
}
export function writeIntakeFileSync(fd: number, bytes: Uint8Array): void {
  const finishMutation = beginManagedPhysicalMutation();
  recordIntakeFileWork('writeAttempts');
  try {
    writeFileSync(fd, bytes);
    recordIntakeFileWork('writes');
    recordIntakeFileWork('writeBytes', bytes.byteLength);
  } catch (error) {
    recordIntakeFileWork('writeFailures');
    throw error;
  } finally {
    finishMutation();
  }
}
export function fsyncIntakeFileSync(fd: number): void {
  const finishMutation = beginManagedPhysicalMutation();
  try {
    recordIntakeFileWork('fsyncAttempts');
    fsyncSync(fd);
    recordIntakeFileWork('fsyncCalls');
  } finally {
    finishMutation();
  }
}
export function renameIntakeFileSync(from: PathLike, to: PathLike): void {
  const finishMutation = beginManagedPhysicalMutation();
  try {
    recordIntakeFileWork('renameAttempts');
    renameSync(from, to);
    recordIntakeFileWork('renames');
  } finally {
    finishMutation();
  }
}
export function copyIntakeFileSync(
  from: PathLike,
  to: PathLike,
  flags: number,
  requestedBytes: number,
): void {
  const finishMutation = beginManagedPhysicalMutation();
  try {
    recordIntakeFileWork('copyAttempts');
    recordIntakeFileWork('copyRequestedBytes', requestedBytes);
    copyFileSync(from, to, flags);
    recordIntakeFileWork('copies');
  } finally {
    finishMutation();
  }
}
