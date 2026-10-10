/** Disposable copy projections. Complete JSON remains authenticated even when
 * only bounded eligibility fields are decoded. */
import { createHash } from 'node:crypto';
import {
  prepareIntakeJsonCanonicalSteps,
  type PreparedIntakeJsonCanonical,
  type IntakeJsonCanonicalHandle,
} from './intake-json-canonical.ts';
import { iterateSerializedIntakeJson, type IntakeJson } from './intake-state-codec.ts';
import type { ManualSourceRecordReceipt } from '../shared/intake-manual-source-record.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { finishIntakeCopySteps } from './intake-copy-work.ts';

export function* intakeCopyTextPieces(text: string): Generator<string> {
  for (let at = 0; at < text.length;) {
    let end = Math.min(at + 4096, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    yield text.slice(at, end);
    at = end;
  }
}

export function intakeCopyJsonTree(pieces: Iterable<string>): PreparedIntakeJsonCanonical {
  return finishIntakeCopySteps(prepareIntakeJsonCanonicalSteps(pieces));
}

export function intakeCopyJsonHash(
  tree: PreparedIntakeJsonCanonical,
  value: IntakeJsonCanonicalHandle = tree.root,
): string {
  return finishIntakeCopySteps(intakeCopyJsonHashSteps(tree, value));
}

export function* intakeCopyJsonHashSteps(
  tree: PreparedIntakeJsonCanonical,
  value: IntakeJsonCanonicalHandle = tree.root,
): Generator<void, string> {
  const hash = createHash('sha256');
  for (const piece of tree.pieces(value)) {
    hash.update(piece);
    yield;
  }
  return hash.digest('hex');
}

export function intakeCopyJsonString(
  tree: PreparedIntakeJsonCanonical,
  value: IntakeJsonCanonicalHandle | undefined,
  max = 4096,
): string | undefined {
  if (!value || tree.kind(value) !== 'string') return undefined;
  let text = '';
  for (const piece of tree.pieces(value)) {
    if (text.length + piece.length > max) return undefined;
    text += piece;
  }
  return JSON.parse(text) as string;
}

export function intakeCopyEncodedBytes(value: unknown): number {
  return finishIntakeCopySteps(intakeCopyEncodedBytesSteps(value));
}

export function* intakeCopyEncodedBytesSteps(value: unknown): Generator<void, number> {
  let bytes = 0;
  for (const piece of iterateSerializedIntakeJson(value as IntakeJson)) {
    bytes += Buffer.byteLength(piece);
    yield;
  }
  return bytes;
}

export function intakeCopyEncodedPieces(value: unknown): Iterable<string> {
  return iterateSerializedIntakeJson(value as IntakeJson);
}

/** Exact previous JSON.stringify row grammar, compared as a multiplicity-bound
 * cryptographic key rather than retaining a giant encoded row/sort buffer. */
export function* intakeCopyRowKeySteps(row: Record<string, unknown>): Generator<void, string> {
  const hash = createHash('sha256');
  let bytes = 0;
  for (const piece of intakeCopyEncodedPieces(
    Object.fromEntries(
      Object.keys(row)
        .sort()
        .map((name) => [name, row[name]]),
    ),
  )) {
    hash.update(piece);
    bytes += Buffer.byteLength(piece);
    yield;
  }
  return `${bytes}:${hash.digest('hex')}`;
}

/** Defer a possible trailing whitespace run on disk, so trimming never retains
 * a whitespace-only suffix proportional to the selected value. */
export function* intakeCopyTrimmedPieces(pieces: Iterable<string>): Generator<string> {
  for (const piece of intakeCopyTrimmedPieceSteps(pieces))
    if (typeof piece === 'string') yield piece;
}

export function* intakeCopyTrimmedPieceSteps(pieces: Iterable<string>): Generator<string | void> {
  let started = false,
    scratch: ReturnType<typeof disposableSqlite> | undefined;
  const pending = () => {
    if (!scratch) {
      scratch = disposableSqlite('intake-copy-whitespace-');
      scratch.db.exec(
        'CREATE TABLE pieces(ordinal INTEGER PRIMARY KEY,value TEXT NOT NULL); BEGIN',
      );
    }
    return scratch.db;
  };
  try {
    for (const input of pieces)
      for (const piece of intakeCopyTextPieces(input)) {
        yield;
        const part = started ? piece : piece.trimStart();
        if (!part) continue;
        const trimmed = part.trimEnd();
        if (trimmed) {
          if (scratch) {
            for (const row of scratch.db
              .prepare('SELECT value FROM pieces ORDER BY ordinal')
              .iterate())
              yield String(row.value);
            scratch.db.exec('DELETE FROM pieces');
          }
          started = true;
          yield trimmed;
        }
        const tail = part.slice(trimmed.length);
        if (tail && started) pending().prepare('INSERT INTO pieces(value) VALUES(?)').run(tail);
      }
  } finally {
    scratch?.close();
  }
}

/** Parser input iterators cannot yield control themselves. Stage their bounded
 * output first so scanning skipped giant fields/whitespace stays cooperative. */
export function* prepareIntakeCopyPieceSpoolSteps(
  pieces: Iterable<string | void>,
): Generator<void, { pieces(): Iterable<string>; close(): void }> {
  const scratch = disposableSqlite('intake-copy-piece-spool-');
  let retained = false;
  try {
    scratch.db.exec('CREATE TABLE pieces(ordinal INTEGER PRIMARY KEY,value TEXT NOT NULL); BEGIN');
    const put = scratch.db.prepare('INSERT INTO pieces(value) VALUES(?)');
    for (const piece of pieces) {
      yield;
      if (typeof piece === 'string')
        for (const part of intakeCopyTextPieces(piece)) {
          put.run(part);
          yield;
        }
    }
    retained = true;
    return {
      *pieces() {
        for (const row of scratch.db.prepare('SELECT value FROM pieces ORDER BY ordinal').iterate())
          yield String(row.value);
      },
      close() {
        scratch.close();
      },
    };
  } finally {
    if (!retained) scratch.close();
  }
}

export function intakeCopyManualReceipt(
  pieces: Iterable<string>,
): { receipt: ManualSourceRecordReceipt; hash: string } | undefined {
  return finishIntakeCopySteps(intakeCopyManualReceiptSteps(pieces));
}

export function* intakeCopyManualReceiptSteps(
  pieces: Iterable<string>,
): Generator<void, { receipt: ManualSourceRecordReceipt; hash: string } | undefined> {
  const tree = yield* prepareIntakeJsonCanonicalSteps(pieces);
  try {
    if (tree.kind(tree.root) !== 'object') return undefined;
    const projected: Record<string, unknown> = {};
    for (const name of [
      'actor',
      'operationId',
      'fingerprint',
      'profileId',
      'intakeId',
      'sourceHash',
      'sourceTextRevisionId',
    ])
      projected[name] = intakeCopyJsonString(tree, tree.field(tree.root, name));
    const person = tree.field(tree.root, 'person');
    if (person && tree.kind(person) === 'object') {
      const note = tree.field(person, 'noteId'),
        id = tree.field(person, 'personId');
      // Eligibility checks only the types here; the hash binds their complete
      // values together with every retained unknown receipt field.
      if (note && id && tree.kind(note) === 'string' && tree.kind(id) === 'string')
        projected.person = { noteId: '', personId: '' };
    }
    return {
      receipt: projected as unknown as ManualSourceRecordReceipt,
      hash: yield* intakeCopyJsonHashSteps(tree),
    };
  } finally {
    tree.close();
  }
}
