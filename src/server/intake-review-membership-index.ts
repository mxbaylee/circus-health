/** Complete report membership reverse joins, prepared from authenticated selected records. */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { HttpError } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  intakeEnvelopeRecordOrder,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { createEnvelopeBuildWriter } from './intake-envelope-build.ts';
import { createReportSnapshotCatalog } from './intake-report-snapshot-catalog.ts';
import { openReportMemberSnapshot } from './intake-report-member-state.ts';
import { intakeReviewChildren, readIntakeReviewValue } from './intake-review-collection.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import { workflowHash } from './intake-workflow.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import type { IntakeReportMembersReference } from '../shared/intake-report-version.ts';
import { recordIntakeWork, withIntakeWork } from './intake-work-accounting.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import type { IntakeEnvelopeDerivedPreparation } from './intake-envelope-mutation.ts';
import type { NativeProposalAffected } from './intake-collection-proposals.ts';

const POLICY = 'health-intake-clinical-membership-v2';
const indexName = (view: IntakeCollectionEnvelopeReader) =>
  'clinical.membership.' + workflowHash(view.logical);
const field = <T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): T | undefined => {
  const child = view.child(record, name);
  if (child) return readIntakeReviewValue<T>(view, child, 16384);
  const value = view.field(record, name, { bytes: 16384 });
  if (value.kind === 'fragmented') throw Error('Report membership identity requires preparation');
  return value.kind === 'value' ? (value.value as T) : undefined;
};
export interface CollectionReviewMembership {
  covered(candidateId: string, versionId: string): boolean;
  member(
    version: IntakeEnvelopeRecord,
    candidateId: string,
    versionId: string,
  ): IntakeEnvelopeRecord | undefined;
  contains(
    version: IntakeEnvelopeRecord,
    candidateId: string,
    versionId: string,
    recordId: string,
    proposalId: string | null,
  ): boolean;
  references(
    candidateId: string,
    versionId: string,
    recordId: string,
    proposalId: string | null,
  ): Iterable<{ groupId: string; groupVersionId: string }>;
}
export function readCollectionReviewMembership(
  db: DatabaseSync,
  source: IntakeEnvelopeSource,
  selectedView?: IntakeCollectionEnvelopeReader,
): CollectionReviewMembership {
  const view = selectedView || openIntakeCollectionEnvelope(db, source),
    store = selectedEnvelopeStore(db, source).collections,
    name = indexName(view);
  const intake = view.child(view.root(), 'intake')!,
    workflow = view.child(intake, 'workflow');
  const current = () => {
    view.address(view.root());
  };
  if (!workflow || !view.childCount(workflow, 'reportGroups'))
    return {
      covered: () => {
        current();
        return false;
      },
      member: () => {
        current();
        return undefined;
      },
      contains: () => {
        current();
        return false;
      },
      references: () => {
        current();
        return [];
      },
    };
  const get = (key: string) => {
    current();
    const raw = store.get(store.openView(), 'builds', name, key);
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') throw Error('Invalid report membership index');
    return JSON.parse(raw);
  };
  if (get('complete') !== POLICY)
    throw new HttpError(
      409,
      'INTAKE_REVIEW_MEMBERSHIP_PENDING',
      'Prepare complete retained report membership before clinical review',
    );
  const versionGet = (version: IntakeEnvelopeRecord, key: string) => {
    current();
    const reference = store.getCollectionReference(
      store.openView(),
      'builds',
      name,
      '$version:' + view.address(version),
    );
    if (!reference) throw Error('Incomplete report version membership proof');
    const raw = store.getReferenced(reference, key);
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') throw Error('Invalid report version membership');
    return JSON.parse(raw);
  };
  return {
    covered: (c, v) => get('covered:' + workflowHash([c, v])) === true,
    member(version, c, v) {
      if (field(view, version, 'format') === 'health-intake-report-group-version-v2')
        return undefined;
      const address = versionGet(version, 'member:' + workflowHash([c, v]));
      return typeof address === 'string' ? view.resolve(address) : undefined;
    },
    contains: (version, c, v, r, p) =>
      versionGet(version, 'occurrence:' + workflowHash([c, v, r, p])) === true,
    *references(c, v, r, p) {
      current();
      const prefix = 'reference:' + workflowHash([c, v, r, p]) + ':';
      let after: string | undefined = prefix;
      while (true) {
        current();
        const page = store.range(store.openView(), 'builds', name, {
          after,
          items: 64,
          bytes: 32768,
        });
        for (const entry of page.items) {
          if (!entry.key.startsWith(prefix)) return;
          if (typeof entry.value !== 'string') throw Error('Invalid clinical membership reference');
          yield JSON.parse(entry.value) as { groupId: string; groupVersionId: string };
        }
        if (page.complete) return;
        if (!page.after || page.after === after)
          throw Error('Clinical membership index did not advance');
        after = page.after;
      }
    },
  };
}

/** Closed proposal compiler effects append cumulative report versions. Each new
 * version shares its predecessor map and adds only this command's occurrences. */
export async function prepareCollectionReviewMembershipDerived(
  db: DatabaseSync,
  source: IntakeEnvelopeSource,
  input: IntakeEnvelopeDerivedPreparation & {
    affected: NativeProposalAffected;
    assertRunning?: () => void;
    onCheckpoint?: () => void | Promise<void>;
  },
): Promise<IntakeCollectionChange[]> {
  const before = openIntakeCollectionEnvelope(db, source),
    after = input.reader;
  const collections = selectedEnvelopeStore(db, source).collections;
  const oldName = indexName(before),
    nextName = 'clinical.membership.' + workflowHash(input.logical);
  const oldFlow = before.child(before.child(before.root(), 'intake')!, 'workflow');
  const flow = after.child(after.child(after.root(), 'intake')!, 'workflow');
  const oldCount = oldFlow ? before.childCount(oldFlow, 'reportGroups') : 0;
  const complete =
    collections.get(collections.openView(), 'builds', oldName, 'complete') ===
    JSON.stringify(POLICY);
  if (!complete && oldCount) return [];
  const events = input.affected.reportVersionChanges ?? [];
  const byVersion = new Map(events.map((event) => [event.versionAddress, event]));
  let appended = 0,
    appendedGroups = 0;
  for (const address of new Set(input.affected.reportGroupAddresses)) {
    const group = after.resolve(address),
      ordinal = intakeEnvelopeRecordOrder(after, group).at(-1)!;
    const oldGroup =
      ordinal < oldCount && oldFlow ? before.childAt(oldFlow, 'reportGroups', ordinal) : undefined;
    if (oldGroup && before.address(oldGroup) !== address)
      throw Error('Report membership group order changed');
    const oldVersions = oldGroup ? before.childCount(oldGroup, 'versions') : 0;
    if (!oldGroup) appendedGroups++;
    const count = after.childCount(group, 'versions');
    if (count < oldVersions) throw Error('Report versions were removed by an append compiler');
    for (let i = oldVersions; i < count; i++) {
      const version = after.childAt(group, 'versions', i)!,
        event = byVersion.get(after.address(version));
      if (
        !event ||
        event.groupAddress !== address ||
        event.previousVersionAddress !==
          (i ? after.address(after.childAt(group, 'versions', i - 1)!) : undefined)
      )
        throw Error('Report membership append effects are incomplete');
      appended++;
    }
  }
  if (
    appended !== events.length ||
    (flow ? after.childCount(flow, 'reportGroups') : 0) !== oldCount + appendedGroups
  )
    throw Error('Report membership effect scope conflicts');
  const build = 'clinical.update.' + randomUUID();
  const current = () => {
    input.assertRunning?.();
    before.address(before.root());
  };
  const checkpoint = async (changes: IntakeCollectionChange[]) => {
    current();
    if (changes.length) {
      const operationId = randomUUID();
      collections.commitMaintenance(
        collections.prepare(collections.openView(), {
          operationId,
          requestDigest: workflowHash(operationId),
          domainVersion: before.logical.domainVersion,
          changes,
        }),
      );
    }
    await input.onCheckpoint?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    current();
  };
  await checkpoint(
    complete
      ? [
          {
            area: 'builds',
            collection: build,
            op: 'adoptCollection',
            fromArea: 'builds',
            fromCollection: oldName,
          },
        ]
      : [
          {
            area: 'builds',
            collection: build,
            op: 'put',
            key: 'complete',
            value: JSON.stringify(POLICY),
          },
        ],
  );
  for (const event of events) {
    const version = after.resolve(event.versionAddress),
      group = after.resolve(event.groupAddress);
    if (
      field(after, version, 'format') !== 'health-intake-report-group-version-v2' ||
      JSON.stringify(field(after, version, 'members')) !== JSON.stringify(event.members)
    )
      throw Error('Report membership snapshot effect conflicts');
    const groupId = field<string>(after, group, 'id')!,
      groupVersionId = field<string>(after, version, 'id')!;
    const ordinal = intakeEnvelopeRecordOrder(after, group).at(-1)!;
    const versionName = 'clinical.version.' + randomUUID();
    const previous = event.previousVersionAddress
      ? collections.getCollectionReference(
          collections.openView(),
          'builds',
          build,
          '$version:' + event.previousVersionAddress,
        )
      : undefined;
    if (event.previousVersionAddress && !previous)
      throw Error('Previous report membership proof is unavailable');
    await checkpoint(
      previous
        ? [
            {
              area: 'builds',
              collection: versionName,
              op: 'adoptReferenced',
              value: previous,
            },
          ]
        : [
            {
              area: 'builds',
              collection: versionName,
              op: 'put',
              key: 'complete',
              value: JSON.stringify(POLICY),
            },
          ],
    );
    for (const change of event.changed) {
      current();
      const { candidateId: c, candidateVersionId: v, occurrence } = change;
      const r = occurrence.recordId,
        p = occurrence.proposalId ?? null;
      if (
        typeof c !== 'string' ||
        typeof v !== 'string' ||
        typeof r !== 'string' ||
        (p !== null && typeof p !== 'string')
      )
        throw Error('Invalid report membership occurrence identity');
      const identity = workflowHash([c, v, r, p]);
      const referenceKey = 'reference:' + identity + ':' + String(ordinal).padStart(16, '0');
      const changes: IntakeCollectionChange[] = [
        {
          area: 'builds',
          collection: build,
          op: 'put',
          key: 'covered:' + workflowHash([c, v]),
          value: 'true',
        },
        {
          area: 'builds',
          collection: versionName,
          op: 'put',
          key: 'member:' + workflowHash([c, v]),
          value: 'true',
        },
        {
          area: 'builds',
          collection: versionName,
          op: 'put',
          key: 'occurrence:' + identity,
          value: 'true',
        },
      ];
      if (collections.get(collections.openView(), 'builds', build, referenceKey) === undefined)
        changes.push({
          area: 'builds',
          collection: build,
          op: 'put',
          key: referenceKey,
          value: JSON.stringify({ groupId, groupVersionId }),
        });
      recordIntakeWork('clinicalReviewMembershipRecords');
      await checkpoint(changes);
    }
    await checkpoint([
      {
        area: 'builds',
        collection: build,
        op: 'putCollection',
        key: '$version:' + event.versionAddress,
        fromArea: 'builds',
        fromCollection: versionName,
      },
    ]);
  }
  current();
  return [
    {
      area: 'builds',
      collection: nextName,
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: build,
    },
  ];
}
/** Explicit cold operation; completed proof is published only after the complete source walk. */
export async function prepareCollectionReviewMembership(
  db: DatabaseSync,
  source: IntakeEnvelopeSource,
  options: { assertRunning?: () => void } = {},
) {
  const view = openIntakeCollectionEnvelope(db, source),
    store = selectedEnvelopeStore(db, source).collections,
    name = indexName(view),
    current = intakeSourceVersion(db, source.id),
    intake = view.child(view.root(), 'intake')!,
    workflow = view.child(intake, 'workflow');
  if (store.get(store.openView(), 'builds', name, 'complete') === JSON.stringify(POLICY)) return;
  const assertCurrent = () => {
    options.assertRunning?.();
    if (intakeSourceVersion(db, source.id).logicalBinding !== current.logicalBinding)
      throw new HttpError(
        409,
        'INTAKE_REVIEW_CHANGED',
        'Report membership changed during preparation',
      );
  };
  const writer = createEnvelopeBuildWriter(db, source, name, current.rawVersion, {
      assertRunning: assertCurrent,
    }),
    scratch = disposableSqlite('circus-review-membership-'),
    catalog = createReportSnapshotCatalog(db, source);
  try {
    scratch.db.exec(
      'CREATE TABLE firstReferences(identity TEXT,groupOrdinal INTEGER,value TEXT,PRIMARY KEY(identity,groupOrdinal));CREATE TABLE firstMembers(identity TEXT PRIMARY KEY)',
    );
    let groupOrdinal = 0;
    for (const group of intakeReviewChildren(view, workflow, 'reportGroups')) {
      const groupId = field<string>(view, group, 'id')!;
      for (const version of intakeReviewChildren(view, group, 'versions')) {
        const groupVersionId = field<string>(view, version, 'id')!,
          address = view.address(version);
        const versionName = 'clinical.version.' + randomUUID();
        const versionWriter = createEnvelopeBuildWriter(
          db,
          source,
          versionName,
          current.rawVersion,
          { assertRunning: assertCurrent },
        );
        await versionWriter.put('complete', JSON.stringify(POLICY));
        const add = async (c: string, v: string, r: string, p: string | null) => {
          withIntakeWork(db, 'reconstruction', () =>
            recordIntakeWork('clinicalReviewMembershipRecords'),
          );
          const identity = workflowHash([c, v, r, p]);
          await versionWriter.put('occurrence:' + identity, 'true');
          scratch.db
            .prepare('INSERT OR IGNORE INTO firstReferences VALUES(?,?,?)')
            .run(identity, groupOrdinal, JSON.stringify({ groupId, groupVersionId }));
        };
        if (field(view, version, 'format') === 'health-intake-report-group-version-v2') {
          const snapshot = openReportMemberSnapshot(
            catalog,
            field<IntakeReportMembersReference>(view, version, 'members')!,
          );
          for (let ordinal = 0; ordinal < snapshot.reference.memberCount; ordinal++) {
            const member = snapshot.memberAt(ordinal)!;
            await versionWriter.put(
              'member:' + workflowHash([member.candidateId, member.candidateVersionId]),
              'true',
            );
            await writer.put(
              'covered:' + workflowHash([member.candidateId, member.candidateVersionId]),
              'true',
            );
            let after: string | undefined;
            do {
              const page = snapshot.occurrenceDescriptors(member, {
                after,
                items: 64,
                bytes: 32768,
              });
              for (const occurrence of page.occurrences) {
                if (occurrence.recordId === null)
                  throw Error('Report occurrence has no record identity');
                await add(
                  member.candidateId,
                  member.candidateVersionId,
                  occurrence.recordId,
                  occurrence.proposalId,
                );
              }
              if (page.complete) break;
              if (!page.after || page.after === after)
                throw Error('Report occurrences did not advance');
              after = page.after;
            } while (true);
          }
        } else
          for (const member of intakeReviewChildren(view, version, 'members')) {
            const c = field<string>(view, member, 'candidateId')!,
              v = field<string>(view, member, 'candidateVersionId')!,
              identity = workflowHash([c, v]);
            await writer.put('covered:' + identity, 'true');
            const memberKey = address + ':' + identity;
            if (
              scratch.db.prepare('INSERT OR IGNORE INTO firstMembers VALUES(?)').run(memberKey)
                .changes
            )
              await versionWriter.put('member:' + identity, JSON.stringify(view.address(member)));
            for (const occurrence of intakeReviewChildren(view, member, 'occurrences'))
              await add(
                c,
                v,
                field<string>(view, occurrence, 'recordId')!,
                field<string | null>(view, occurrence, 'proposalId') ?? null,
              );
          }
        await versionWriter.flush();
        await writer.flush();
        assertCurrent();
        const operationId = randomUUID();
        store.commitMaintenance(
          store.prepare(store.openView(), {
            operationId,
            requestDigest: workflowHash(operationId),
            domainVersion: current.rawVersion,
            changes: [
              {
                area: 'builds',
                collection: name,
                op: 'putCollection',
                key: '$version:' + address,
                fromArea: 'builds',
                fromCollection: versionName,
              },
            ],
          }),
        );
      }
      groupOrdinal++;
    }
    for (const row of scratch.db
      .prepare(
        'SELECT identity,groupOrdinal,value FROM firstReferences ORDER BY identity,groupOrdinal',
      )
      .iterate())
      await writer.put(
        'reference:' + row.identity + ':' + String(row.groupOrdinal).padStart(16, '0'),
        String(row.value),
      );
    await writer.flush();
    assertCurrent();
    await writer.put('complete', JSON.stringify(POLICY));
    await writer.flush();
    assertCurrent();
  } finally {
    scratch.close();
  }
}
