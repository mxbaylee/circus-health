import { finishClinicalReviewWork } from './clinical-review-work.ts';
import { registerLiteralSharedValue } from './intake-format.ts';
import { createHash } from 'node:crypto';
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
