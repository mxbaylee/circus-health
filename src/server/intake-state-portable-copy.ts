import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentTransactionToken, type Database } from './database.ts';
import {
  captureIntakeStateCopySnapshot,
  prepareProductionIntakeStateCopySnapshot,
  type IntakeStateCopyPlan,
} from './intake-state-bootstrap.ts';
import { invalid } from './intake-state-evidence.ts';
import { profilePaths } from './profile-storage.ts';
import { hasContributorAuthority } from './contributor-record-storage.ts';
import { assertContributorCopyCoherence } from './contributor-durability.ts';
import {
  loadPortable,
  personalDurabilityStatus,
  type CompleteLoadedPortable,
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

function assertSelectedRows(db: Database, portable: CompleteLoadedPortable): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String(row.name))
    .filter((table) => !disposableTable(table));
  const expected = Object.keys(portable.rows).filter((table) => !disposableTable(table));
  if (tables.sort().join('\0') !== expected.sort().join('\0'))
    invalid('portable copy table inventory');
  for (const table of tables) {
    let selected = portable.rows[table];
    let actual: PortableRow[] = db.prepare(`SELECT * FROM ${quote(table)}`).all();
    if (table === 'app_meta') {
      selected = selected
        .filter((row) => !bookkeeping(row.key))
        .map((row) => {
          if (row.key === 'revision')
            return { ...row, value: String(portable.personal.value.revision) };
          if (row.key === 'clinical_review_revision')
            return {
              ...row,
              value: String(
                portable.personal.value.clinicalReviewRevision ?? portable.personal.value.revision,
              ),
            };
          return row;
        });
      actual = actual.filter((row) => !bookkeeping(row.key));
    }
    const left = selected.map(rowKey).sort(),
      right = actual.map(rowKey).sort();
    if (left.length !== right.length || left.some((row, index) => row !== right[index]))
      invalid('portable copy unpublished/conflicting table: ' + table);
  }
}

/** Read-only certification of current selected portable authority; caller holds its writer lease. */
export function assertPortableCopyCoherence(
  db: Database,
  root: string,
  profileId: string,
): CompleteLoadedPortable | null {
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
  const portable = loadPortable(root, profileId) as CompleteLoadedPortable;
  assertSelectedRows(db, portable);
  return portable;
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
    return prepareProductionIntakeStateCopySnapshot(
      captureIntakeStateCopySnapshot(backupDb, sourceProfileId),
      targetProfileId,
    );
  }
  const portable = assertPortableCopyCoherence(sourceDb, root, sourceProfileId);
  if (!backupDb.isOpen || backupDb.isTransaction || currentTransactionToken(backupDb))
    invalid('portable copy backup transaction/closed');
  assertSelectedRows(backupDb, portable!);
  return prepareProductionIntakeStateCopySnapshot(
    captureIntakeStateCopySnapshot(backupDb, sourceProfileId),
    targetProfileId,
  );
}
