/** Private disposable UTF-16 evidence indexes. A selected source and unchanged
 * physical witness authorize reuse; scratch is never portable authority. */
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  fstatSync,
  statSync,
  rmSync,
  constants,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { HttpError, type Database } from './database.ts';
import { assertIntakeOwner } from './intake.ts';
import { profileOriginal } from './profile-storage.ts';
import { recordIntakeFileWork } from './intake-file-work.ts';
const CHUNK = 64 * 1024,
  MAX_SESSIONS = 8,
  MAX_PREPARATIONS = 2;
type Original = { path: string; sha256: string; bytes: number };
type Session = {
  db: Database;
  profileId: string;
  id: string;
  original: Original;
  witness: string;
  directory: string;
  fd: number;
  characters: number;
  used: number;
};
const sessions = new Set<Session>();
const epochs = new WeakMap<Database, number>();
let allEpoch = 0;
let preparations = 0,
  clock = 0;
function physical(path: string) {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile())
    throw new HttpError(409, 'SOURCE_CHANGED', 'The retained original is not a regular file');
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
function resolveOriginal(db: Database, root: string, profileId: string, id: string): Original {
  assertIntakeOwner(db, profileId);
  const row = db
    .prepare("SELECT path,sha256,bytes FROM source_files WHERE id=? AND kind='intake_original'")
    .get(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Source intake not found');
  if (
    typeof row.path !== 'string' ||
    typeof row.sha256 !== 'string' ||
    typeof row.bytes !== 'number'
  )
    throw Error('Invalid retained original metadata');
  return { path: profileOriginal(root, row.path, profileId), sha256: row.sha256, bytes: row.bytes };
}
function same(a: Original, b: Original) {
  return a.path === b.path && a.sha256 === b.sha256 && a.bytes === b.bytes;
}
function dispose(session: Session) {
  sessions.delete(session);
  try {
    closeSync(session.fd);
  } finally {
    rmSync(session.directory, { recursive: true, force: true });
  }
}
export function clearIntakeLiteralSessions(db?: Database): void {
  if (db) epochs.set(db, (epochs.get(db) || 0) + 1);
  else allEpoch++;
  for (const session of sessions) if (!db || session.db === db) dispose(session);
}
export async function readIntakeLiteralWindowIndexed(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  options: {
    offset?: number;
    limit?: number;
    expectedHash?: string;
    assertRunning?: () => void;
  } = {},
) {
  options.assertRunning?.();
  const epoch = epochs.get(db) || 0,
    globalEpoch = allEpoch;
  const original = resolveOriginal(db, root, profileId, id),
    witness = physical(original.path);
  if (options.expectedHash !== undefined && options.expectedHash !== original.sha256)
    throw new HttpError(409, 'PLAN_SOURCE', 'The unit does not match the retained original');
  const assertCurrent = () => {
    options.assertRunning?.();
    if (epoch !== (epochs.get(db) || 0) || globalEpoch !== allEpoch)
      throw new HttpError(
        409,
        'SOURCE_PREPARATION_CANCELLED',
        'The source literal session was closed',
      );
    if (
      !same(original, resolveOriginal(db, root, profileId, id)) ||
      physical(original.path) !== witness
    )
      throw new HttpError(
        409,
        'SOURCE_CHANGED',
        'The retained original changed while preparing its literal window',
      );
  };
  let session: Session | undefined;
  for (const candidate of sessions)
    if (candidate.db === db && candidate.profileId === profileId && candidate.id === id) {
      if (same(candidate.original, original) && candidate.witness === witness) {
        session = candidate;
        break;
      }
      dispose(candidate);
    }
  if (!session) {
    if (preparations >= MAX_PREPARATIONS)
      throw new HttpError(
        503,
        'SOURCE_PREPARATION_BUSY',
        'Retry this literal window after current source preparation finishes',
      );
    preparations++;
    let directory: string | undefined, sourceFd: number | undefined, scratchFd: number | undefined;
    try {
      directory = mkdtempSync(join(tmpdir(), 'health-intake-literal-'));
      scratchFd = openSync(join(directory, 'utf16'), 'wx+', 0o600);
      sourceFd = openSync(original.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(sourceFd, { bigint: true });
      if (
        !stat.isFile() ||
        [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') !== witness
      )
        throw new HttpError(
          409,
          'SOURCE_CHANGED',
          'The retained original changed before inspection',
        );
      const chunk = Buffer.allocUnsafe(CHUNK),
        hash = createHash('sha256'),
        decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0,
        characters = 0;
      const append = (value: string) => {
        const encoded = Buffer.from(value, 'utf16le');
        recordIntakeFileWork('inspectionBufferBytes', encoded.byteLength);
        let offset = 0;
        while (offset < encoded.length) {
          recordIntakeFileWork('writeAttempts');
          const count = writeSync(scratchFd!, encoded, offset, encoded.length - offset);
          if (!count) throw Error('Literal scratch write did not advance');
          offset += count;
          recordIntakeFileWork('writes');
          recordIntakeFileWork('writeBytes', count);
        }
        characters += value.length;
      };
      while (true) {
        assertCurrent();
        recordIntakeFileWork('streamReadAttempts');
        const count = readSync(sourceFd, chunk, 0, chunk.length, null);
        recordIntakeFileWork('streamReadCalls');
        recordIntakeFileWork('streamReadBytes', count);
        if (!count) break;
        size += count;
        hash.update(chunk.subarray(0, count));
        recordIntakeFileWork('streamHashCalls');
        recordIntakeFileWork('streamHashBytes', count);
        append(decoder.decode(chunk.subarray(0, count), { stream: true }));
        await setImmediate();
      }
      append(decoder.decode());
      if (size !== original.bytes || hash.digest('hex') !== original.sha256)
        throw new HttpError(
          409,
          'SOURCE_CHANGED',
          'The retained original no longer matches its hash',
        );
      assertCurrent();
      session = {
        db,
        profileId,
        id,
        original,
        witness,
        directory,
        fd: scratchFd,
        characters,
        used: ++clock,
      };
      scratchFd = undefined;
      directory = undefined;
      while (sessions.size >= MAX_SESSIONS) {
        let oldest: Session | undefined;
        for (const candidate of sessions)
          if (!oldest || candidate.used < oldest.used) oldest = candidate;
        if (oldest) dispose(oldest);
      }
      sessions.add(session);
    } finally {
      preparations--;
      if (sourceFd !== undefined) closeSync(sourceFd);
      if (scratchFd !== undefined) closeSync(scratchFd);
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  } else recordIntakeFileWork('verificationCacheHits');
  session.used = ++clock;
  assertCurrent();
  const offset = Math.max(0, Math.trunc(Number(options.offset)) || 0),
    limit = Math.min(32000, Math.max(1, Math.trunc(Number(options.limit)) || 12000)),
    end = Math.min(session.characters, offset + limit),
    length = Math.max(0, end - offset) * 2,
    bytes = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    recordIntakeFileWork('streamReadAttempts');
    const count = readSync(session.fd, bytes, read, length - read, offset * 2 + read);
    recordIntakeFileWork('streamReadCalls');
    recordIntakeFileWork('streamReadBytes', count);
    if (!count) throw Error('Literal scratch index ended unexpectedly');
    read += count;
  }
  assertCurrent();
  return {
    text: bytes.toString('utf16le'),
    offset,
    nextOffset: end < session.characters ? end : null,
    totalCharacters: session.characters,
    complete: offset === 0 && end === session.characters,
  };
}
