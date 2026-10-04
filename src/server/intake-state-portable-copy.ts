import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentTransactionToken, type Database } from './database.ts';
import {
  prepareProductionIntakeStateCopyRows,
  type IntakeStateCopyPlan,
} from './intake-state-bootstrap.ts';
import { IntakeStateManifest } from './intake-state-manifest.ts';
import { invalid } from './intake-state-evidence.ts';
import { profilePaths } from './profile-storage.ts';
import { hasContributorAuthority } from './contributor-record-storage.ts';
import { assertContributorCopyCoherence } from './contributor-durability.ts';
import {
  openPortableRows,
  personalDurabilityStatus,
  type PortableRows,
  type PortableRow,
} from './portable.ts';

const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';
const disposableTable = (name: string): boolean => name.startsWith('__record_');
const bookkeeping = (key: unknown): boolean =>
  typeof key === 'string' &&
  [
    'personal_dirty',
    'personal_persisted_revision',
    'personal_last_error',
    'personal_conflict',
    'curation_revision',
  ].includes(key);
const rowKey = (row: PortableRow): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.keys(row)
        .sort()
        .map((key) => [key, row[key]]),
    ),
  );

function assertSelectedRows(db: Database, portable: PortableRows): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String(row.name))
    .filter((table) => !disposableTable(table));
  const expected = portable.tableNames().filter((table) => !disposableTable(table));
  if (tables.sort().join('\0') !== expected.sort().join('\0'))
    invalid('portable copy table inventory');
  const spool = new IntakeStateManifest();
  try {
    spool.db.exec('CREATE TABLE comparison(row TEXT PRIMARY KEY,count INTEGER NOT NULL)');
    for (const table of tables) {
      spool.db.exec('DELETE FROM comparison');
      for (let row of portable.rows(table)) {
        if (table === 'app_meta') {
          if (bookkeeping(row.key)) continue;
          if (row.key === 'revision')
            row = { ...row, value: String(portable.personal.value.revision) };
          if (row.key === 'clinical_review_revision')
            row = {
              ...row,
              value: String(
                portable.personal.value.clinicalReviewRevision ?? portable.personal.value.revision,
              ),
            };
        }
        spool.db
          .prepare(
            'INSERT INTO comparison VALUES(?,1) ON CONFLICT(row) DO UPDATE SET count=count+1',
          )
          .run(rowKey(row));
      }
      for (const row of db.prepare(`SELECT * FROM ${quote(table)}`).iterate()) {
        if (table === 'app_meta' && bookkeeping(row.key)) continue;
        const key = rowKey(row);
        if (
          !spool.db.prepare('UPDATE comparison SET count=count-1 WHERE row=? AND count>0').run(key)
            .changes
        )
          invalid('portable copy unpublished/conflicting table: ' + table);
      }
      if (spool.db.prepare('SELECT 1 FROM comparison WHERE count<>0 LIMIT 1').get())
        invalid('portable copy unpublished/conflicting table: ' + table);
    }
  } finally {
    spool.close();
  }
}

/** Read-only certification of current selected portable authority; caller holds its writer lease. */
export function assertPortableCopyCoherence(
  db: Database,
  root: string,
  profileId: string,
): PortableRows | null {
  if (hasContributorAuthority(root, profileId)) {
    assertContributorCopyCoherence(db, root, profileId);
    return null;
  }
  if (!db.isOpen || db.isTransaction || currentTransactionToken(db))
    invalid('portable copy source transaction/closed');
  const status = personalDurabilityStatus(db);
  if (status.dirty || status.conflicted || status.lastError)
    invalid('portable copy source recovery required');
  if (existsSync(resolve(profilePaths(root, profileId).personal, 'pending.json')))
    invalid('portable copy source pending publication');
  const portable = openPortableRows(root, profileId);
  try {
    assertSelectedRows(db, portable);
    return portable;
  } catch (error) {
    portable.close();
    throw error;
  }
}

/** Certify the selected source and its coherent backup before any owner/path changes. */
export function preparePortableIntakeCopy(
  sourceDb: Database,
  backupDb: Database,
  root: string,
  sourceProfileId: string,
  targetProfileId: string,
): IntakeStateCopyPlan {
  if (hasContributorAuthority(root, sourceProfileId)) {
    assertContributorCopyCoherence(sourceDb, root, sourceProfileId, backupDb);
    return prepareProductionIntakeStateCopyRows(backupDb, sourceProfileId, targetProfileId);
  }
  const portable = assertPortableCopyCoherence(sourceDb, root, sourceProfileId);
  try {
    if (!backupDb.isOpen || backupDb.isTransaction || currentTransactionToken(backupDb))
      invalid('portable copy backup transaction/closed');
    assertSelectedRows(backupDb, portable!);
    return prepareProductionIntakeStateCopyRows(backupDb, sourceProfileId, targetProfileId);
  } finally {
    portable?.close();
  }
}
