import type { DatabaseSync } from 'node:sqlite';
import {
  observeTransactionOutcome,
  observeTransactionStart,
  type TransactionOutcome,
} from './database.ts';

/** Instances remain lexical to each actual issuer. Creating another instance
 * cannot enroll a callback into any module's read-only identity predicate. */
function issuer<T>(register: (db: DatabaseSync, callback: (value: T) => void) => () => void) {
  const issued = new WeakMap<DatabaseSync, WeakSet<(value: T) => void>>();
  return Object.freeze({
    observe(db: DatabaseSync, callback: (value: T) => void): () => void {
      let callbacks = issued.get(db);
      if (!callbacks) issued.set(db, (callbacks = new WeakSet()));
      callbacks.add(callback);
      const remove = register(db, callback);
      return () => {
        callbacks!.delete(callback);
        remove();
      };
    },
    recognizes(db: DatabaseSync, callback: unknown): boolean {
      return (
        typeof callback === 'function' && !!issued.get(db)?.has(callback as (value: T) => void)
      );
    },
  });
}
export const createTransactionOutcomeIssuer = () =>
  issuer<TransactionOutcome>(observeTransactionOutcome);
export const createTransactionStartIssuer = () => issuer<object>(observeTransactionStart);
