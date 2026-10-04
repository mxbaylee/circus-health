/** Bounded private byte windows over exact selected collection evidence. */
import { setImmediate } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './database.ts';
import { assertIntakeOwner, verifyIntakeOriginal } from './intake.ts';
import { openIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { withIntakeWork, recordIntakeWork, recordIntakePeak } from './intake-work-accounting.ts';
import type { IntakeReviewFragmentReference } from './intake-review-collection.ts';

type Spool = {
  db: DatabaseSync;
  key: string;
  scratch: ReturnType<typeof disposableSqlite>;
  bytes: number;
  used: number;
};
const spools = new Set<Spool>(),
  epochs = new WeakMap<DatabaseSync, number>();
let clock = 0,
  allEpoch = 0,
  preparations = 0;
const MAX_SPOOLS = 8,
  CHUNK = 8192;
function dispose(spool: Spool) {
  spools.delete(spool);
  spool.scratch.close();
}
export function clearIntakeCollectionEvidenceFragments(db?: DatabaseSync) {
  if (db) epochs.set(db, (epochs.get(db) || 0) + 1);
  else allEpoch++;
  for (const spool of spools) if (!db || spool.db === db) dispose(spool);
}
export async function readIntakeCollectionEvidenceFragment(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  input: {
    reference: IntakeReviewFragmentReference;
    offset?: number;
    bytes?: number;
    assertRunning?: () => void;
  },
) {
  assertIntakeOwner(db, profileId);
  const reference = input.reference,
    offset = input.offset ?? 0,
    limit = input.bytes ?? 32768;
  if (
    !reference ||
    reference.format !== 'health-intake-review-fragment-v1' ||
    typeof reference.address !== 'string' ||
    (reference.field !== undefined && typeof reference.field !== 'string') ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 65536
  )
    throw new HttpError(
      400,
      'REVIEW_WINDOW',
      'Choose a valid evidence reference and bounded byte window',
    );
  const file = db
    .prepare(
      "SELECT id,kind,sha256,details_json FROM source_files WHERE id=? AND kind='intake_original'",
    )
    .get(intakeId) as
    { id: string; kind: string; sha256: string; details_json: string } | undefined;
  if (!file) throw new HttpError(404, 'NOT_FOUND', 'Source intake not found');
  const view = openIntakeCollectionEnvelope(db, file),
    epoch = epochs.get(db) || 0,
    globalEpoch = allEpoch;
  if (JSON.stringify(reference.logical) !== JSON.stringify(view.logical))
    throw new HttpError(409, 'INTAKE_REVIEW_CHANGED', 'Refresh this selected evidence');
  const selected = view.resolve(reference.address),
    key = JSON.stringify([profileId, intakeId, file.sha256, reference]);
  const assertCurrent = () => {
    input.assertRunning?.();
    assertIntakeOwner(db, profileId);
    if (epoch !== (epochs.get(db) || 0) || globalEpoch !== allEpoch)
      throw new HttpError(409, 'INTAKE_REVIEW_CHANGED', 'Refresh this selected evidence');
    view.address(selected);
    verifyIntakeOriginal(db, root, profileId, intakeId);
  };
  assertCurrent();
  let spool = [...spools].find((item) => item.db === db && item.key === key);
  if (!spool) {
    if (preparations >= 2)
      throw new HttpError(
        503,
        'REVIEW_PREPARATION_BUSY',
        'Other evidence windows are being prepared; retry this window',
      );
    preparations++;
    const scratch = disposableSqlite('circus-collection-evidence-');
    try {
      scratch.db.exec('CREATE TABLE chunks(offset INTEGER PRIMARY KEY,value BLOB NOT NULL)');
      const insert = scratch.db.prepare('INSERT INTO chunks VALUES(?,?)'),
        child = reference.field === undefined ? selected : view.child(selected, reference.field),
        pieces = child ? view.recordChunks(child) : view.fieldChunks(selected, reference.field!);
      let bytes = 0,
        untilYield = 0,
        carry = '';
      const append = (text: string) => {
        const raw = Buffer.from(text);
        for (let start = 0; start < raw.length; start += CHUNK) {
          const part = raw.subarray(start, Math.min(start + CHUNK, raw.length));
          insert.run(bytes, part);
          bytes += part.length;
          untilYield += part.length;
          withIntakeWork(db, 'reconstruction', () => {
            recordIntakeWork('collectionEvidenceFragmentInputBytes', part.length);
            recordIntakeWork('collectionEvidenceFragmentScratchWrittenBytes', part.length);
            recordIntakePeak(
              'collectionEvidenceFragmentPeakBufferBytes',
              Math.max(raw.length, part.length),
            );
          });
        }
      };
      for (const piece of pieces) {
        let text = carry + piece;
        carry = '';
        const last = text.charCodeAt(text.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) {
          carry = text.slice(-1);
          text = text.slice(0, -1);
        }
        append(text);
        if (untilYield >= 65536) {
          untilYield = 0;
          await setImmediate();
          assertCurrent();
        }
      }
      if (carry) append(carry);
      assertCurrent();
      const existing = [...spools].find((item) => item.db === db && item.key === key);
      if (existing) {
        scratch.close();
        spool = existing;
      } else {
        while (spools.size >= MAX_SPOOLS) {
          let oldest: Spool | undefined;
          for (const candidate of spools)
            if (!oldest || candidate.used < oldest.used) oldest = candidate;
          dispose(oldest!);
        }
        spool = { db, key, scratch, bytes, used: ++clock };
        spools.add(spool);
      }
    } catch (error) {
      scratch.close();
      throw error;
    } finally {
      preparations--;
    }
  }
  assertCurrent();
  spool.used = ++clock;
  if (offset > spool.bytes)
    throw new HttpError(409, 'REVIEW_CURSOR', 'Refresh this selected evidence');
  const end = Math.min(spool.bytes, offset + limit),
    value = Buffer.alloc(end - offset);
  let at = offset;
  while (at < end) {
    const row = spool.scratch.db
      .prepare('SELECT offset,value FROM chunks WHERE offset<=? ORDER BY offset DESC LIMIT 1')
      .get(at) as { offset: number; value: Uint8Array } | undefined;
    if (!row || at >= row.offset + row.value.length)
      throw Error('Evidence fragment spool is incomplete');
    const part = Buffer.from(row.value.buffer, row.value.byteOffset, row.value.byteLength),
      length = Math.min(end - at, part.length - (at - row.offset));
    part.copy(value, at - offset, at - row.offset, at - row.offset + length);
    at += length;
  }
  withIntakeWork(db, 'warm', () =>
    recordIntakeWork('collectionEvidenceFragmentReadBytes', value.length),
  );
  assertCurrent();
  return {
    encoding: 'base64' as const,
    data: value.toString('base64'),
    complete: end === spool.bytes,
    nextOffset: end === spool.bytes ? null : end,
    totalBytes: spool.bytes,
  };
}
