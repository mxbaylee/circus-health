import {
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { encryptObject, decryptObject, type VaultKey } from './vault-crypto.ts';
import { isVaultDiagnosticWriter, type VaultDiagnosticWriter } from './vault-store.ts';
import { withManagedPhysicalMutation } from './clinical-review-physical-epoch.ts';
import { diagnosticChunkLimits, type DiagnosticChunkLimits } from './diagnostic-chunk-limits.ts';
export { diagnosticChunkLimits, type DiagnosticChunkLimits } from './diagnostic-chunk-limits.ts';
export interface DiagnosticChunkInventory {
  chunks: { sequence: number; encryptedBytes: number }[];
  nextSequence: number;
  encryptedBytes: number;
  missingChunksWithinInventory: number;
  /** Deletion, eviction and pre-store history cannot be reconstructed from retained chunks. */
  omittedBeforeInventory: null;
  completeness: 'not_established';
}
export interface DiagnosticChunkStore {
  inventory(): DiagnosticChunkInventory;
  read(sequence: number): Buffer;
  /** Only nextSequence or an identical retry of a still-retained sequence is accepted. */
  append(sequence: number, bytes: Uint8Array): 'appended' | 'replayed';
  work(): {
    indexScans: number;
    chunkReads: number;
    chunkWrites: number;
    plaintextBytesWritten: number;
    evictions: number;
  };
  close(): void;
}

/** Single writer, held by the existing unlocked vault. This is never record recovery authority. */
export function openDiagnosticChunkStore(options: {
  directory: string;
  profileId: string;
  key: VaultKey;
  guard?: () => void;
  limits?: Partial<DiagnosticChunkLimits>;
  writer?: VaultDiagnosticWriter;
}): DiagnosticChunkStore {
  const { profileId, guard: authorize } = options;
  const limits = { ...diagnosticChunkLimits, ...options.limits };
  for (const key of ['maxChunkBytes', 'maxChunks', 'maxBytes'] as const)
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > diagnosticChunkLimits[key]
    )
      throw Error('Invalid diagnostic chunk limits');
  if (limits.maxBytes < limits.maxChunkBytes + 4096)
    throw Error('Diagnostic retention must fit one bounded chunk');
  const directory = resolve(options.directory);
  const writer = options.writer;
  if (writer && !isVaultDiagnosticWriter(writer, directory, profileId))
    throw Error('Invalid vault diagnostic writer');
  let key: VaultKey | null = options.key;
  let chunks: DiagnosticChunkInventory['chunks'] | null = null;
  let nextSequence = 1;
  const work = {
    indexScans: 0,
    chunkReads: 0,
    chunkWrites: 0,
    plaintextBytesWritten: 0,
    evictions: 0,
  };
  const pattern = /^([0-9]{16})\.enc$/;
  const pending = /^[0-9]{16}\.enc\.pending-[0-9a-f]{24}$/;
  const guard = () => {
    authorize?.();
    if (!key) throw Error('Diagnostic store is closed');
  };
  const validSequence = (sequence: number) => {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER)
      throw Error('Invalid diagnostic chunk sequence');
  };
  const path = (sequence: number) =>
    resolve(directory, String(sequence).padStart(16, '0') + '.enc');
  const purpose = (sequence: number) => `diagnostic-events-v1:${sequence}`;
  const remove = (path: string) => {
    guard();
    if (writer) rmSync(path);
    else withManagedPhysicalMutation(() => rmSync(path));
  };
  const syncDirectory = () => {
    const fd = openSync(directory, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const encryptedBytes = () => chunks!.reduce((sum, chunk) => sum + chunk.encryptedBytes, 0);
  const trim = () => {
    while (chunks!.length > limits.maxChunks || encryptedBytes() > limits.maxBytes) {
      const oldest = chunks![0]!;
      remove(path(oldest.sequence));
      chunks!.shift();
      work.evictions++;
      syncDirectory();
    }
  };
  const initialize = () => {
    guard();
    if (chunks) {
      trim();
      return;
    }
    work.indexScans++;
    const found: DiagnosticChunkInventory['chunks'] = [];
    const interrupted: string[] = [];
    if (existsSync(directory) && !lstatSync(directory).isDirectory())
      throw Error('Invalid diagnostic directory');
    const names = existsSync(directory) ? readdirSync(directory) : [];
    // One completed append plus one interrupted temporary file is the crash allowance.
    if (names.length > limits.maxChunks + 2)
      throw Error('Diagnostic inventory exceeds recovery allowance');
    for (const name of names) {
      const file = resolve(directory, name);
      const stat = lstatSync(file);
      if (!stat.isFile()) throw Error('Invalid diagnostic chunk file');
      if (pending.test(name)) {
        interrupted.push(file);
        continue;
      }
      const match = pattern.exec(name);
      if (!match) throw Error('Invalid diagnostic chunk identity');
      const sequence = Number(match[1]);
      validSequence(sequence);
      if (stat.size > limits.maxChunkBytes + 4096)
        throw Error('Diagnostic chunk exceeds read bound');
      found.push({ sequence, encryptedBytes: stat.size });
    }
    if (found.length > limits.maxChunks + 1 || interrupted.length > 1)
      throw Error('Diagnostic inventory exceeds recovery allowance');
    for (const file of interrupted) {
      remove(file);
      syncDirectory();
    }
    found.sort((a, b) => a.sequence - b.sequence);
    chunks = found;
    nextSequence = (found.at(-1)?.sequence || 0) + 1;
    trim();
  };
  const read = (sequence: number) => {
    initialize();
    validSequence(sequence);
    if (!chunks!.some((chunk) => chunk.sequence === sequence))
      throw Error('Diagnostic chunk is not retained');
    const stat = lstatSync(path(sequence));
    if (!stat.isFile() || stat.size > limits.maxChunkBytes + 4096)
      throw Error('Invalid diagnostic chunk size');
    work.chunkReads++;
    return decryptObject(
      path(sequence),
      key!,
      profileId,
      purpose(sequence),
      undefined,
      limits.maxChunkBytes,
    );
  };
  return {
    inventory() {
      initialize();
      return {
        chunks: chunks!.map((chunk) => ({ ...chunk })),
        nextSequence,
        encryptedBytes: encryptedBytes(),
        missingChunksWithinInventory: chunks!.length
          ? chunks!.at(-1)!.sequence - chunks![0]!.sequence + 1 - chunks!.length
          : 0,
        omittedBeforeInventory: null,
        completeness: 'not_established',
      };
    },
    read,
    append(sequence, bytes) {
      initialize();
      validSequence(sequence);
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength === 0 ||
        bytes.byteLength > limits.maxChunkBytes
      )
        throw Error('Invalid diagnostic chunk size');
      if (sequence < nextSequence) {
        if (!read(sequence).equals(bytes))
          throw Error('Diagnostic chunk retry conflicts with retained bytes');
        trim();
        return 'replayed';
      }
      if (sequence !== nextSequence) throw Error('Diagnostic chunk sequence conflict');
      if (existsSync(path(sequence))) {
        // Atomic rename may have succeeded before a directory-sync error reached the caller.
        const stat = lstatSync(path(sequence));
        if (!stat.isFile() || stat.size > limits.maxChunkBytes + 4096)
          throw Error('Invalid diagnostic chunk size');
        work.chunkReads++;
        const retained = decryptObject(
          path(sequence),
          key!,
          profileId,
          purpose(sequence),
          undefined,
          limits.maxChunkBytes,
        );
        if (!retained.equals(bytes))
          throw Error('Diagnostic chunk retry conflicts with retained bytes');
        chunks!.push({ sequence, encryptedBytes: stat.size });
        nextSequence++;
        trim();
        return 'replayed';
      }
      // Atomic authenticated publication writes this payload only, without any medical manifest/head.
      if (writer) writer(sequence, bytes);
      else encryptObject(path(sequence), bytes, key!, profileId, purpose(sequence));
      work.chunkWrites++;
      work.plaintextBytesWritten += bytes.byteLength;
      chunks!.push({ sequence, encryptedBytes: lstatSync(path(sequence)).size });
      nextSequence++;
      trim();
      return 'appended';
    },
    work() {
      guard();
      return { ...work };
    },
    close() {
      key = null;
      chunks = null;
    },
  };
}
