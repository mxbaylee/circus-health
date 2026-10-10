import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentTransactionToken, type Database } from './database.ts';
import {
  prepareProductionIntakeStateCopyRows,
  prepareProductionIntakeStateCopyRowsSteps,
  disposeIntakeStateCopyPlan,
  type IntakeRecoveryTraversalOptions,
  type IntakeStateCopyPlan,
} from './intake-state-bootstrap.ts';
import { IntakeStateManifest } from './intake-state-manifest.ts';
import { invalid } from './intake-state-evidence.ts';
import { profilePaths } from './profile-storage.ts';
import { hasContributorAuthority } from './contributor-record-storage.ts';
import {
  assertContributorCopyCoherence,
  prepareContributorCopyCertification,
  contributorCopySourceTextInventory,
  disposeContributorCopyCertification,
  assertContributorCopyCertificationCurrent,
  verifyContributorCopyCertificationForPublication,
  consumeContributorCopyPublicationSeal,
  type ContributorCopyPublicationSeal,
  type ContributorCopyCertification,
} from './contributor-durability.ts';
import { intakeCopyRowKeySteps } from './intake-copy-json.ts';
import {
  finishIntakeCopySteps,
  finishIntakeCopyStepsAsync,
  captureIntakeCopyReadInterval,
  intakeCopyNativeSelect,
} from './intake-copy-work.ts';
import { openPortableRows, personalDurabilityStatus, type PortableRows } from './portable.ts';

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
function assertSelectedRows(db: Database, portable: PortableRows): void {
  finishIntakeCopySteps(assertSelectedRowsSteps(db, portable));
}
function* assertSelectedRowsSteps(db: Database, portable: PortableRows): Generator<void, void> {
  const tables = intakeCopyNativeSelect(
    db,
    "SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  )
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
        yield;
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
          .run(yield* intakeCopyRowKeySteps(row));
      }
      for (const row of intakeCopyNativeSelect(
        db,
        `SELECT * FROM main.${quote(table)}`,
      ).iterate()) {
        yield;
        if (table === 'app_meta' && bookkeeping(row.key)) continue;
        const key = yield* intakeCopyRowKeySteps(row);
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

const copyCertifications = new WeakMap<IntakeStateCopyPlan, ContributorCopyCertification>();
const copyIntervals = new WeakMap<
  IntakeStateCopyPlan,
  {
    source: Database;
    backup: Database;
    sourceCurrent: () => void;
    backupCurrent: (transaction?: object) => void;
    staged: boolean;
  }
>();
export async function preparePortableIntakeCopyAsync(
  sourceDb: Database,
  backupDb: Database,
  root: string,
  sourceProfileId: string,
  targetProfileId: string,
  options: IntakeRecoveryTraversalOptions = {},
): Promise<IntakeStateCopyPlan> {
  let certification: ContributorCopyCertification | undefined,
    plan: IntakeStateCopyPlan | undefined,
    portable: PortableRows | undefined,
    retained = false;
  try {
    const backupCurrent = captureIntakeCopyReadInterval(backupDb, sourceProfileId);
    const sourceCurrent = captureIntakeCopyReadInterval(sourceDb, sourceProfileId);
    if (hasContributorAuthority(root, sourceProfileId))
      certification = await prepareContributorCopyCertification(
        sourceDb,
        root,
        sourceProfileId,
        backupDb,
        options.signal,
      );
    else {
      if (!sourceDb.isOpen || sourceDb.isTransaction || currentTransactionToken(sourceDb))
        invalid('portable copy source transaction/closed');
      const status = personalDurabilityStatus(sourceDb);
      if (
        status.dirty ||
        status.conflicted ||
        status.lastError ||
        existsSync(resolve(profilePaths(root, sourceProfileId).personal, 'pending.json'))
      )
        invalid('portable copy source recovery required');
      portable = openPortableRows(root, sourceProfileId);
      await finishIntakeCopyStepsAsync(assertSelectedRowsSteps(sourceDb, portable), options.signal);
      if (!backupDb.isOpen || backupDb.isTransaction || currentTransactionToken(backupDb))
        invalid('portable copy backup transaction/closed');
      await finishIntakeCopyStepsAsync(assertSelectedRowsSteps(backupDb, portable), options.signal);
    }
    plan = await finishIntakeCopyStepsAsync(
      prepareProductionIntakeStateCopyRowsSteps(
        backupDb,
        sourceProfileId,
        targetProfileId,
        options,
      ),
      options.signal,
    );
    backupCurrent();
    sourceCurrent();
    if (certification) {
      assertContributorCopyCertificationCurrent(certification);
      copyCertifications.set(plan, certification);
    }
    copyIntervals.set(plan, {
      source: sourceDb,
      backup: backupDb,
      sourceCurrent,
      backupCurrent,
      staged: false,
    });
    retained = true;
    return plan;
  } finally {
    portable?.close();
    if (plan && !retained) disposeIntakeStateCopyPlan(plan);
    if (certification && !retained) disposeContributorCopyCertification(certification);
  }
}

/** Consume the original whole-backup interval before the first authorized owner
 * rewrite. Only the application's exact live transaction may enter this step. */
export function beginPortableIntakeCopyStaging(
  plan: IntakeStateCopyPlan,
  source: Database,
  backup: Database,
): void {
  const interval = copyIntervals.get(plan),
    token = currentTransactionToken(backup);
  if (
    !interval ||
    interval.source !== source ||
    interval.backup !== backup ||
    interval.staged ||
    !token
  )
    invalid('copy original staging interval');
  interval.sourceCurrent();
  interval.backupCurrent(token);
  const certification = copyCertifications.get(plan);
  if (certification) assertContributorCopyCertificationCurrent(certification);
  interval.sourceCurrent();
  interval.backupCurrent(token);
  interval.staged = true;
}

export function portableCopySourceTextInventory(
  plan: IntakeStateCopyPlan,
  source: Database,
  root: string,
  profileId: string,
  signal?: AbortSignal,
): ReturnType<typeof contributorCopySourceTextInventory> | undefined {
  const certification = copyCertifications.get(plan);
  return certification
    ? contributorCopySourceTextInventory(certification, source, root, profileId, signal)
    : undefined;
}

/** The target may advance through authorized staging; the source interval may not. */
export function assertPortableIntakeCopySourceCurrent(
  plan: IntakeStateCopyPlan,
  source: Database,
): void {
  const interval = copyIntervals.get(plan),
    certification = copyCertifications.get(plan);
  if (!interval || interval.source !== source || !interval.staged || !certification)
    invalid('copy original contributor publication proof');
  interval.sourceCurrent();
  assertContributorCopyCertificationCurrent(certification);
  interval.sourceCurrent();
}

export async function verifyPortableIntakeCopySourceForPublication(
  plan: IntakeStateCopyPlan,
  source: Database,
  signal?: AbortSignal,
): Promise<ContributorCopyPublicationSeal> {
  assertPortableIntakeCopySourceCurrent(plan, source);
  return verifyContributorCopyCertificationForPublication(copyCertifications.get(plan)!, signal);
}

export function consumePortableIntakeCopyPublicationSeal(
  plan: IntakeStateCopyPlan,
  source: Database,
  seal: ContributorCopyPublicationSeal,
): void {
  const interval = copyIntervals.get(plan),
    certification = copyCertifications.get(plan);
  if (!interval || interval.source !== source || !interval.staged || !certification)
    invalid('copy original contributor publication proof');
  consumeContributorCopyPublicationSeal(seal, certification);
}

export function disposePortableIntakeCopyPlan(plan: IntakeStateCopyPlan): void {
  const certification = copyCertifications.get(plan);
  copyCertifications.delete(plan);
  copyIntervals.delete(plan);
  try {
    if (certification) disposeContributorCopyCertification(certification);
  } finally {
    disposeIntakeStateCopyPlan(plan);
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
