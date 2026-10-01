import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profilePaths } from './profile-storage.ts';
import { profileDefinition, validProfileId } from './profiles.ts';
import { readDatabaseOwner } from './profile-ownership.ts';
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const LATEST_SCHEMA_VERSION = 6;
export type Database = DatabaseSync;
export type SqliteRow = Record<string, SQLOutputValue>;

export const databaseSchemaVersion = (db: DatabaseSync): number => {
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
  return Number(row?.version ?? 0);
};

export function openDatabase(path?: string | null, profileId?: string): DatabaseSync {
  if (profileId === undefined) {
    if (!path) throw new Error('Choose an explicit profile and database path');
    profileId = readDatabaseOwner(path);
  }
  if (!validProfileId(profileId)) throw new Error('Unknown profile');
  path ??= profilePaths(REPO_ROOT, profileId).database;
  if (existsSync(path) && statSync(path).size > 0 && readDatabaseOwner(path) !== profileId)
    throw new Error('Database belongs to a different profile');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  let inTransaction = false;
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    const fresh = !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    if (fresh)
      db.exec(readFileSync(new URL('./migrations/001-initial.sql', import.meta.url), 'utf8'));
    const versions = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => Number(row.version));
    if (
      !versions.length ||
      versions.length > LATEST_SCHEMA_VERSION ||
      versions.some((version, index) => version !== index + 1)
    )
      throw new Error('Unsupported or inconsistent database schema version');
    const owner = db
      .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
      .get()?.value;
    if (!fresh && owner === undefined)
      throw new Error(
        'Database has no verified profile owner; explicit ownership recovery is required',
      );
    if (owner !== undefined && owner !== profileId)
      throw new Error('Database belongs to a different profile');
    db.prepare("INSERT OR IGNORE INTO app_meta(key,value) VALUES('owner_profile_id',?)").run(
      profileId,
    );
    if (databaseSchemaVersion(db) < 2)
      db.exec(
        readFileSync(new URL('./migrations/002-procedure-categories.sql', import.meta.url), 'utf8'),
      );
    if (fresh)
      db.prepare("UPDATE people SET display_name=? WHERE id='patient'").run(
        profileDefinition(profileId).defaultName,
      );
    if (databaseSchemaVersion(db) < 3)
      db.exec(
        readFileSync(new URL('./migrations/003-note-series-links.sql', import.meta.url), 'utf8'),
      );
    if (databaseSchemaVersion(db) < 4)
      db.exec(
        readFileSync(
          new URL('./migrations/004-personal-medication-status.sql', import.meta.url),
          'utf8',
        ),
      );
    if (databaseSchemaVersion(db) < 5)
      db.exec(
        readFileSync(new URL('./migrations/005-note-text-formats.sql', import.meta.url), 'utf8'),
      );
    if (databaseSchemaVersion(db) < 6)
      db.exec(
        readFileSync(new URL('./migrations/006-visibility-events.sql', import.meta.url), 'utf8'),
      );
    db.exec('COMMIT');
    inTransaction = false;
    return db;
  } catch (error) {
    if (inTransaction) db.exec('ROLLBACK');
    db.close();
    throw error;
  }
}
export function json(source: unknown, fallback: unknown = null): unknown {
  try {
    // JSON.parse performs the same ToString coercion at runtime. The assertion
    // models that built-in boundary without claiming parsed storage is trusted.
    return JSON.parse(source as string) as unknown;
  } catch {
    return fallback;
  }
}
// SQLite datetime('now') values in app-managed metadata are UTC. Only adapt
// their exact timestamp shape for API presentation; never use this helper on
// provider clinical dates, event dates, or stored source evidence.
export function managedTimestamp<T>(value: T): T | string {
  if (typeof value !== 'string') return value;
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(value);
  return match ? `${match[1]}T${match[2]}Z` : value;
}
export const now = () => new Date().toISOString();
export const revision = (db: DatabaseSync): number =>
  Number(db.prepare("SELECT value FROM app_meta WHERE key='revision'").get()?.value || 0);
/** Clinical review authority excludes source-text-only journal revisions. */
export const clinicalReviewRevision = (db: DatabaseSync): number =>
  Number(
    db.prepare("SELECT value FROM app_meta WHERE key='clinical_review_revision'").get()?.value ??
      revision(db),
  );

export interface TransactionOperation {
  operationId?: unknown;
  fingerprint?: unknown;
  expectedRevision?: unknown;
  [key: string]: unknown;
}

export interface TransactionRetry<T = unknown> {
  replayed: boolean;
  result: T;
}

export interface TransactionDurabilityHooks<Capture = unknown, Result = unknown> {
  begin?(operation: TransactionOperation): TransactionRetry<Result> | void;
  capture?(): Capture;
  release?(captured: Capture | undefined): void;
  markDirty?(): void;
  prepare(
    captured: Capture | undefined,
    context: { operation: TransactionOperation; result: Result },
  ): void;
  flush?(): void;
}

const durabilityHooks = new WeakMap<DatabaseSync, TransactionDurabilityHooks>();
export function registerTransactionDurability<Capture, Result>(
  db: DatabaseSync,
  hooks: TransactionDurabilityHooks<Capture, Result> | null | undefined,
): void {
  if (hooks) durabilityHooks.set(db, hooks as TransactionDurabilityHooks);
  else durabilityHooks.delete(db);
}
export function transaction<T>(
  db: DatabaseSync,
  fn: () => T,
  operation: TransactionOperation = {},
): T {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  const hooks = durabilityHooks.get(db);
  let captured;
  try {
    const retry = hooks?.begin?.(operation);
    if (retry?.replayed) {
      db.exec('COMMIT');
      committed = true;
      return retry.result as T;
    }
    captured = hooks?.capture?.();
    const result = fn();
    db.prepare(
      "INSERT OR IGNORE INTO app_meta(key,value) VALUES('clinical_review_revision',(SELECT value FROM app_meta WHERE key='revision'))",
    ).run();
    if (operation.actor !== 'source-text')
      db.exec(
        "UPDATE app_meta SET value=CAST(value AS INTEGER)+1 WHERE key='clinical_review_revision'",
      );
    db.exec("UPDATE app_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
    hooks?.markDirty?.();
    // The recoverable intent must reach durable profile storage before an
    // ephemeral SQLite COMMIT can be acknowledged.
    hooks?.prepare(captured, { operation, result });
    db.exec('COMMIT');
    committed = true;
    // Publication may be retried from the durable intent, even after losing
    // this database and its WAL entirely.
    hooks?.flush?.();
    return result;
  } catch (error) {
    if (!committed) db.exec('ROLLBACK');
    throw error;
  } finally {
    hooks?.release?.(captured);
  }
}
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}
export function required<T>(value: T, message = 'Resource not found'): NonNullable<T> {
  if (!value) throw new HttpError(404, 'NOT_FOUND', message);
  return value as NonNullable<T>;
}
export function safeText(value: unknown, name: string, max = 1000000): string {
  if (typeof value !== 'string' || value.length > max)
    throw new HttpError(400, 'INVALID_INPUT', `${name} must be text of at most ${max} characters`);
  return value;
}
export function optionalText(value: unknown, name: string, max = 10000): string | null {
  return value == null || value === '' ? null : safeText(value, name, max);
}
