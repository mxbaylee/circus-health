import {
  prepareOwnershipIdentityIssues,
  ownershipSourceAuthority,
} from './record-ownership-authority.ts';
import { setImmediate } from 'node:timers/promises';
import { selectedEnvelopeStore } from './intake-collection-envelope.ts';
import { latestOwnershipDecision } from './ownership-journal.ts';
/** Ownership issue membership shares the checked immutable string-set codec. Its
 * wrapper identifies hashes as reviewed identity evidence, never source IDs. */
import { clinicalReviewRevision, type Database } from './database.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { iterateOwnershipStreamContributions } from './ownership-contribution-stream.ts';
import { prepareCollectionClinicalReviewAsync } from './intake-review-collection-host.ts';
import type { CollectionClinicalReviewSession } from './intake-review-collection-session.ts';
import {
  ownershipSourceSnapshotHas,
  assertOwnershipSourceSnapshot,
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
  options: { deferMaintenance?: boolean } = {},
) {
  const snapshot = await factory.prepareMembership({
    previous: previous && !Array.isArray(previous) ? previous.snapshot : undefined,
    sourceRecordIds: values,
  });
  if (!options.deferMaintenance) await factory.finishMaintenance();
  return { format: 'health-ownership-identity-issues-v1', snapshot } as const;
}

export async function prepareOwnershipIdentitySnapshots(
  db: Database,
  sql: Database,
  input: {
    sources: Iterable<{
      intakeId: string;
      recordId: string;
      identity?: string;
      reportMember?: boolean;
    }>;
    record(
      intakeId: string,
      recordId: string,
    ):
      | import('../shared/intake.ts').IntakeReviewRecord
      | undefined
      | Promise<import('../shared/intake.ts').IntakeReviewRecord | undefined>;
    factory(intakeId: string): ReturnType<typeof createOwnershipSourceSnapshotPreparation>;
    report?: { intakeId: string; groupId: string };
  },
) {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS ownership_identity_snapshots(intake TEXT,record TEXT,value TEXT,PRIMARY KEY(intake,record)); CREATE TABLE IF NOT EXISTS ownership_identity_union(value TEXT PRIMARY KEY); DELETE FROM ownership_identity_snapshots; DELETE FROM ownership_identity_union;',
  );
  // Inline empty evidence has no catalog reference to recheck. Retain its
  // original source and logical envelope while own build checkpoints advance.
  const sourceGuards = new Map<string, () => void>();
  const sourceGuard = (intakeId: string) => {
    let guard = sourceGuards.get(intakeId);
    if (!guard) {
      const initial = selectedEnvelopeStore(db, { id: intakeId }),
        sourceHash = initial.source.sha256,
        detailsJson = initial.source.details_json,
        logical = JSON.stringify(initial.collections.collectionState('logical', 'envelope.data'));
      guard = () => {
        const current = selectedEnvelopeStore(db, { id: intakeId });
        if (
          current.source.sha256 !== sourceHash ||
          current.source.details_json !== detailsJson ||
          JSON.stringify(current.collections.collectionState('logical', 'envelope.data')) !==
            logical
        )
          throw Error('Ownership identity source changed after preparation');
      };
      sourceGuards.set(intakeId, guard);
    }
    guard();
    return guard;
  };
  for (const source of input.sources) {
    const prepared = !!sql
      .prepare('SELECT 1 FROM ownership_identity_snapshots WHERE intake=? AND record=?')
      .get(source.intakeId, source.recordId);
    if (prepared && !source.reportMember) continue;
    const sourceCurrent = sourceGuard(source.intakeId);
    const record = await input.record(source.intakeId, source.recordId);
    sourceCurrent();
    if (!record) throw Error('Ownership identity source is no longer reviewable');
    const previous = source.identity
      ? ownershipSourceAuthority(db, source.identity)?.identityIssues
      : undefined;
    const factory = input.factory(source.intakeId);
    const sorted = await prepareOwnershipIdentityIssues(record, () => factory.assertCurrent());
    try {
      const values = () => sorted.distinctValues(),
        empty = values().at(0) === undefined;
      let reference: OwnershipIdentityIssues | undefined;
      if (!prepared) {
        if (empty && previous === undefined) {
          factory.assertCurrent();
          sourceCurrent();
          reference = [];
          factory.assertCurrent();
        }
        reference ??= await prepareOwnershipIdentityIssueSnapshot(factory, values, previous, {
          deferMaintenance: true,
        });
      }
      if (input.report && source.reportMember && source.intakeId === input.report.intakeId) {
        const put = sql.prepare('INSERT OR IGNORE INTO ownership_identity_union VALUES(?)');
        let inspected = 0;
        for (const value of values()) {
          factory.assertCurrent();
          put.run(value);
          if (++inspected % 16 === 0) {
            await setImmediate();
            factory.assertCurrent();
          }
        }
        factory.assertCurrent();
      }
      if (reference && !Array.isArray(reference)) await factory.finishMaintenance();
      const assertCurrent = () => {
        sourceCurrent();
        if (reference && !Array.isArray(reference))
          factory.assertPublishedCurrent(reference.snapshot);
        else factory.assertCurrent();
        sourceCurrent();
      };
      assertCurrent();
      sorted.assertSame(assertCurrent);
      if (reference) {
        sql
          .prepare('INSERT INTO ownership_identity_snapshots VALUES(?,?,?)')
          .run(source.intakeId, source.recordId, JSON.stringify(reference));
      }
    } finally {
      sorted.close();
    }
  }
  let report: OwnershipIdentityIssues | undefined;
  if (input.report) {
    const prior = latestOwnershipDecision<{ identityIssues?: OwnershipIdentityIssues }>(
      db,
      'Report ownership default',
      'groupId',
      input.report.groupId,
    )?.identityIssues;
    const sourceCurrent = sourceGuard(input.report.intakeId),
      factory = input.factory(input.report.intakeId);
    factory.assertCurrent();
    if (
      prior === undefined &&
      !sql.prepare('SELECT 1 FROM ownership_identity_union LIMIT 1').get()
    ) {
      report = [];
      sourceCurrent();
      factory.assertCurrent();
    }
    report ??= await prepareOwnershipIdentityIssueSnapshot(
      factory,
      function* () {
        let row = sql
          .prepare('SELECT value FROM ownership_identity_union ORDER BY value LIMIT 1')
          .get() as { value: string } | undefined;
        const next = sql.prepare(
          'SELECT value FROM ownership_identity_union WHERE value>? ORDER BY value LIMIT 1',
        );
        while (row) {
          yield row.value;
          row = next.get(row.value) as { value: string } | undefined;
        }
      },
      prior,
    );
  }
  return {
    forSource(intakeId: string, recordId: string): OwnershipIdentityIssues {
      const value = sql
        .prepare('SELECT value FROM ownership_identity_snapshots WHERE intake=? AND record=?')
        .get(intakeId, recordId)?.value;
      if (!value)
        throw Error('Ownership identity snapshot was not prepared for this exact occurrence');
      const parsed = JSON.parse(String(value)) as OwnershipIdentityIssues;
      if (Array.isArray(parsed) && parsed.length)
        throw Error('Invalid inline ownership identity evidence');
      return parsed;
    },
    assertCurrent() {
      for (const guard of sourceGuards.values()) guard();
      for (const row of sql
        .prepare('SELECT value FROM ownership_identity_snapshots ORDER BY intake,record')
        .iterate()) {
        const value = JSON.parse(String(row.value)) as OwnershipIdentityIssues;
        if (!Array.isArray(value)) assertOwnershipSourceSnapshot(db, value.snapshot);
        else if (value.length) throw Error('Invalid inline ownership identity evidence');
      }
      if (report && !Array.isArray(report)) assertOwnershipSourceSnapshot(db, report.snapshot);
      else if (report?.length) throw Error('Invalid inline ownership report identity evidence');
      for (const guard of sourceGuards.values()) guard();
    },
    forReport() {
      if (!report) throw Error('No prepared report identity snapshot');
      return Array.isArray(report) ? [...report] : report;
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
        return createOwnershipSourceSnapshotPreparation(
          db,
          { id: intakeId },
          { assertRunning: assertCurrent },
        );
      },
      async record(intakeId, recordId) {
        const proposal = recordId.replace(/:line:\d+$/, ''),
          next = JSON.stringify([intakeId, proposal]);
        if (next !== key) {
          selected?.close();
          const current = await prepareCollectionClinicalReviewAsync(
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
    return {
      ...values,
      assertCurrent,
      stage() {
        assertCurrent();
        values.assertCurrent();
      },
      close() {
        scratch.close();
      },
    };
  } catch (error) {
    selected?.close();
    scratch.close();
    throw error;
  }
}
export type OwnershipIdentitySnapshotPlan = Awaited<
  ReturnType<typeof prepareStandaloneOwnershipIdentitySnapshots>
>;
