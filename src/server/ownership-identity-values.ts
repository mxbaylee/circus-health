import { finishClinicalReviewWork } from './clinical-review-work.ts';
import { registerLiteralSharedValue } from './intake-format.ts';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { disposableSqlite } from './disposable-sqlite.ts';
import { selectedSequence } from './intake-selected-sequence.ts';
import { registerReviewRecordField } from './intake-review-selected-record.ts';
import type { OwnershipIdentityBlockersReference } from '../shared/ownership-identity-values.ts';

/** Complete ordering/deduplication uses private scratch, closed even on early predicate exit. */
export function ownershipSortedValues(read: () => Iterable<string>, unique = false) {
  return selectedSequence(function* () {
    const scratch = disposableSqlite('circus-ownership-identity-');
    try {
      scratch.db.exec(
        `CREATE TABLE values_(ordinal INTEGER PRIMARY KEY,value TEXT NOT NULL${unique ? ' UNIQUE' : ''}); CREATE INDEX sorted ON values_(value,ordinal);`,
      );
      const put = scratch.db.prepare('INSERT OR IGNORE INTO values_(value) VALUES(?)');
      for (const value of read()) put.run(value);
      for (const row of scratch.db
        .prepare('SELECT value FROM values_ ORDER BY value,ordinal')
        .iterate())
        yield String(row.value);
    } finally {
      scratch.close();
    }
  });
}

/** Fill a private sort cooperatively; point reads and keyset replay never suspend a live iterator. */
export async function prepareOwnershipSortedValues<T>(
  read: {
    readonly length: number;
    at(ordinal: number): T | undefined;
    revision?(): string | undefined;
  },
  valueOf: (value: T) => string | undefined,
  assertCurrent: () => void,
) {
  const scratch = disposableSqlite('circus-ownership-identity-');
  let closed = false;
  try {
    scratch.db.exec(
      'CREATE TABLE values_(ordinal INTEGER PRIMARY KEY,value TEXT NOT NULL); CREATE INDEX sorted ON values_(value,ordinal);',
    );
    const put = scratch.db.prepare('INSERT INTO values_(value) VALUES(?)');
    assertCurrent();
    const count = read.length;
    const revision = read.revision?.();
    const assertValid = () => {
      assertCurrent();
      if (read.length !== count || read.revision?.() !== revision)
        throw Error('Ownership identity issue policy changed during preparation');
    };
    for (let ordinal = 0; ordinal < count; ordinal++) {
      assertValid();
      const issue = read.at(ordinal);
      if (issue === undefined)
        throw Error('Ownership identity issue policy changed during preparation');
      const value = valueOf(issue);
      if (value !== undefined) put.run(value);
      if ((ordinal + 1) % 16 === 0) {
        await setImmediate();
        assertValid();
      }
    }
    if (!count) {
      await setImmediate();
      assertValid();
    }
    assertValid();
    const first = scratch.db.prepare(
      'SELECT ordinal,value FROM values_ ORDER BY value,ordinal LIMIT 1',
    );
    const next = scratch.db.prepare(
      'SELECT ordinal,value FROM values_ WHERE (value,ordinal)>(?,?) ORDER BY value,ordinal LIMIT 1',
    );
    const nextDistinct = scratch.db.prepare(
      'SELECT ordinal,value FROM values_ WHERE value>? ORDER BY value,ordinal LIMIT 1',
    );
    const sequence = (distinct: boolean) =>
      selectedSequence(function* () {
        if (closed) throw Error('Closed ownership identity sort');
        assertValid();
        let row = first.get() as { ordinal: number; value: string } | undefined;
        while (row) {
          assertValid();
          yield row.value;
          if (closed) throw Error('Closed ownership identity sort');
          assertValid();
          row = (distinct ? nextDistinct.get(row.value) : next.get(row.value, row.ordinal)) as
            { ordinal: number; value: string } | undefined;
        }
        assertValid();
      });
    return {
      assertCurrent: assertValid,
      values() {
        return sequence(false);
      },
      distinctValues() {
        return sequence(true);
      },
      close() {
        if (closed) return;
        closed = true;
        scratch.close();
      },
    };
  } catch (error) {
    scratch.close();
    throw error;
  }
}
export function ownershipDistinctValues(read: () => Iterable<string>) {
  return selectedSequence(function* () {
    const scratch = disposableSqlite('circus-ownership-blockers-');
    try {
      scratch.db.exec(
        'CREATE TABLE values_(ordinal INTEGER PRIMARY KEY,value TEXT NOT NULL UNIQUE)',
      );
      const put = scratch.db.prepare('INSERT OR IGNORE INTO values_(value) VALUES(?)');
      for (const value of read()) if (put.run(value).changes) yield value;
    } finally {
      scratch.close();
    }
  });
}
const blockers = new WeakMap<OwnershipIdentityBlockersReference, () => Iterable<string>>();
const heldMessages = new WeakMap<object, () => Iterable<string>>();
export function selectedOwnershipBlockers(reference: OwnershipIdentityBlockersReference) {
  const values = blockers.get(reference);
  if (!values) throw Error('Unbound ownership blocker reference');
  return selectedSequence(values);
}
function* messageChunks(read: () => Iterable<string>) {
  yield '"';
  let first = true;
  for (const value of read()) {
    if (!first) yield ' ';
    first = false;
    yield JSON.stringify(value).slice(1, -1);
  }
  yield '"';
}
/** Exact prior joined-message commitment, with an explicitly separate bounded presentation. */
export function ownershipHoldMessage(read: () => Iterable<string>, bytes = 64 * 1024) {
  return finishClinicalReviewWork(ownershipHoldMessageWork(read, bytes));
}
export function* ownershipHoldMessageWork(read: () => Iterable<string>, bytes = 64 * 1024) {
  let message = '',
    count = 0,
    size = 0,
    inline = true;
  const hash = createHash('sha256');
  for (const part of messageChunks(read)) {
    hash.update(part);
    yield;
  }
  for (const value of read()) {
    yield;
    if (count++) size++;
    size += Buffer.byteLength(value);
    if (size > bytes) {
      inline = false;
      message = '';
    }
    if (inline) message += (count > 1 ? ' ' : '') + value;
  }
  if (inline) return { message };
  const reference: OwnershipIdentityBlockersReference = Object.freeze({
    format: 'health-ownership-identity-blockers-v1',
    count,
    bytes: size,
    digest: hash.digest('hex'),
  });
  blockers.set(reference, read);
  registerLiteralSharedValue(reference);
  return {
    message: `Review ${count} report identity requirements before changing person.`,
    ownershipBlockers: reference,
  };
}
export function bindOwnershipHoldMessage(value: object, read: () => Iterable<string>) {
  heldMessages.set(value, read);
  registerReviewRecordField(value, 'message', 'ownershipBlockers', () => messageChunks(read));
  Object.freeze(value);
  registerLiteralSharedValue(value);
}
export function copyOwnershipHoldMessage(source: object, target: object) {
  const read = heldMessages.get(source);
  if (read) bindOwnershipHoldMessage(target, read);
}
