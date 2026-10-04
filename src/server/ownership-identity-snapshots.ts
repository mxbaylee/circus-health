import { ownershipIdentityIssues, ownershipSourceAuthority } from './record-ownership-authority.ts';
import { latestOwnershipDecision } from './ownership-journal.ts';
/** Ownership issue membership shares the checked immutable string-set codec. Its
 * wrapper identifies hashes as reviewed identity evidence, never source IDs. */
import { clinicalReviewRevision, type Database } from './database.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { iterateOwnershipStreamContributions } from './ownership-contribution-stream.ts';
import { prepareCollectionClinicalReview } from './intake-review-collection-host.ts';
import type { CollectionClinicalReviewSession } from './intake-review-collection-session.ts';
import {
  ownershipSourceSnapshotHas,
  type OwnershipSourceSnapshotReference,
  createOwnershipSourceSnapshotPreparation,
} from './ownership-source-snapshots.ts';
export interface OwnershipIdentityIssuesReference {
  format: 'health-ownership-identity-issues-v1';
  snapshot: OwnershipSourceSnapshotReference;
}
export type OwnershipIdentityIssues = string[] | OwnershipIdentityIssuesReference;
export function ownershipIdentityIssueIncluded(
  db: Database,
  value: OwnershipIdentityIssues | undefined,
  issue: string,
) {
  if (!value) return false;
  if (Array.isArray(value)) return value.includes(issue);
  if (value.format !== 'health-ownership-identity-issues-v1')
    throw Error('Invalid ownership identity issue authority');
  return ownershipSourceSnapshotHas(db, value.snapshot, issue);
}
export async function prepareOwnershipIdentityIssueSnapshot(
  factory: ReturnType<typeof createOwnershipSourceSnapshotPreparation>,
  values: () => Iterable<string>,
  previous?: OwnershipIdentityIssues,
) {
  const snapshot = await factory.prepareSplit({
    previous: previous && !Array.isArray(previous) ? previous.snapshot : undefined,
    sourceRecordIds: values,
    movingSourceRecordIds: () => [],
  });
  return { format: 'health-ownership-identity-issues-v1', snapshot: snapshot.remaining } as const;
}

export async function prepareOwnershipIdentitySnapshots(
  db: Database,
  sql: Database,
  input: {
    sources: Iterable<{ intakeId: string; recordId: string; identity?: string }>;
    record(
      intakeId: string,
      recordId: string,
    ): import('../shared/intake.ts').IntakeReviewRecord | undefined;
    factory(intakeId: string): ReturnType<typeof createOwnershipSourceSnapshotPreparation>;
    report?: { intakeId: string; groupId: string };
  },
) {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS ownership_identity_snapshots(intake TEXT,record TEXT,value TEXT,PRIMARY KEY(intake,record)); CREATE TABLE IF NOT EXISTS ownership_identity_union(value TEXT PRIMARY KEY); DELETE FROM ownership_identity_snapshots; DELETE FROM ownership_identity_union;',
  );
  for (const source of input.sources) {
    if (
      sql
        .prepare('SELECT 1 FROM ownership_identity_snapshots WHERE intake=? AND record=?')
        .get(source.intakeId, source.recordId)
    )
      continue;
    const record = input.record(source.intakeId, source.recordId);
    if (!record) throw Error('Ownership identity source is no longer reviewable');
    const previous = source.identity
      ? ownershipSourceAuthority(db, source.identity)?.identityIssues
      : undefined;
    const values = function* () {
      let previous: string | undefined;
      for (const hash of ownershipIdentityIssues(record)) {
        if (hash !== previous) {
          yield hash;
          previous = hash;
        }
      }
    };
    const reference = await prepareOwnershipIdentityIssueSnapshot(
      input.factory(source.intakeId),
      values,
      previous,
    );
    sql
      .prepare('INSERT INTO ownership_identity_snapshots VALUES(?,?,?)')
      .run(source.intakeId, source.recordId, JSON.stringify(reference));
    if (input.report)
      for (const value of values())
        sql.prepare('INSERT OR IGNORE INTO ownership_identity_union VALUES(?)').run(value);
  }
  let report: OwnershipIdentityIssuesReference | undefined;
  if (input.report) {
    const prior = latestOwnershipDecision<{ identityIssues?: OwnershipIdentityIssues }>(
      db,
      'Report ownership default',
      'groupId',
      input.report.groupId,
    )?.identityIssues;
    report = await prepareOwnershipIdentityIssueSnapshot(
      input.factory(input.report.intakeId),
      function* () {
        for (const row of sql
          .prepare('SELECT value FROM ownership_identity_union ORDER BY value')
          .iterate())
          yield String(row.value);
      },
      prior,
    );
  }
  return {
    forSource(intakeId: string, recordId: string): OwnershipIdentityIssuesReference {
      const value = sql
        .prepare('SELECT value FROM ownership_identity_snapshots WHERE intake=? AND record=?')
        .get(intakeId, recordId)?.value;
      if (!value)
        throw Error('Ownership identity snapshot was not prepared for this exact occurrence');
      return JSON.parse(String(value));
    },
    forReport() {
      if (!report) throw Error('No prepared report identity snapshot');
      return report;
    },
  };
}

/** Native selected-record commands prepare all immutable issue memberships before their clinical transaction. */
export async function prepareStandaloneOwnershipIdentitySnapshots(
  db: Database,
  root: string,
  profileId: string,
  records: Iterable<{ kind: import('./clinical-references.ts').ClinicalKind; recordId: string }>,
) {
  const scratch = disposableSqlite('circus-ownership-identity-plan-');
  const factories = new Map<string, ReturnType<typeof createOwnershipSourceSnapshotPreparation>>();
  const stages: Awaited<
    ReturnType<ReturnType<typeof createOwnershipSourceSnapshotPreparation>['finish']>
  >[] = [];
  let selected: CollectionClinicalReviewSession | undefined,
    key = '';
  const basis = clinicalReviewRevision(db),
    assertCurrent = () => {
      if (clinicalReviewRevision(db) !== basis) throw Error('Ownership identity evidence changed');
    };
  try {
    const values = await prepareOwnershipIdentitySnapshots(db, scratch.db, {
      sources: (function* () {
        for (const item of records)
          for (const c of iterateOwnershipStreamContributions(db, item.kind, item.recordId))
            yield { intakeId: c.intakeId, recordId: c.sourceRecordId, identity: c.identity };
      })(),
      factory(intakeId) {
        let result = factories.get(intakeId);
        if (!result) {
          result = createOwnershipSourceSnapshotPreparation(
            db,
            { id: intakeId },
            { assertRunning: assertCurrent },
          );
          factories.set(intakeId, result);
        }
        return result;
      },
      record(intakeId, recordId) {
        const proposal = recordId.replace(/:line:\d+$/, ''),
          next = JSON.stringify([intakeId, proposal]);
        if (next !== key) {
          selected?.close();
          const current = prepareCollectionClinicalReview(
            db,
            root,
            profileId,
            intakeId,
            proposal === intakeId ? null : proposal,
          );
          if (current.status !== 'ready')
            throw Error('Ownership identity source preparation required');
          selected = current.session;
          key = next;
        }
        return selected!.record(recordId);
      },
    });
    selected?.close();
    selected = undefined;
    for (const factory of factories.values()) stages.push(await factory.finish());
    return {
      ...values,
      assertCurrent,
      stage() {
        for (const stage of stages) stage.assertCurrent();
        for (const stage of stages) stage.apply();
      },
      close() {
        for (const stage of stages) stage.dispose();
        scratch.close();
      },
    };
  } catch (error) {
    selected?.close();
    for (const stage of stages) stage.dispose();
    scratch.close();
    throw error;
  }
}
export type OwnershipIdentitySnapshotPlan = Awaited<
  ReturnType<typeof prepareStandaloneOwnershipIdentitySnapshots>
>;
