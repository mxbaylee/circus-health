import type { Database } from './database.ts';
import { hasIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
import { readStoredIntakeDetails } from './intake-state-access.ts';
import {
  openIntakeCollectionEnvelope,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { createReportSnapshotCatalog } from './intake-report-snapshot-catalog.ts';
import { openReportMemberSnapshot } from './intake-report-member-state.ts';
import type { IntakeReportMembersReference } from '../shared/intake-report-version.ts';

/** Only group identity/subject are retained; versions and member occurrences stream. */
export function* ownershipIntakeScopes(
  db: Database,
  intakeId: string,
  recordId: string,
  options: {
    latestOnly?: boolean;
    exactGroups?: Pick<ReadonlySet<string>, 'has'>;
    subject?: boolean;
    version?: boolean;
  } = {},
): Generator<{ id: string; subjectText: string; versionId?: string }> {
  const source = db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(intakeId);
  if (!source) return;
  // Saved evidence can come from ordinary source imports as well as intake.
  // Only intake originals have a selected intake authority to inspect.
  if (
    source.kind !== 'intake_original' ||
    !hasIntakeCollectionEnvelope(db, source as { id: string })
  ) {
    for (const group of readStoredIntakeDetails(db, intakeId)?.workflow?.reportGroups || []) {
      const versions = options.latestOnly ? group.versions.slice(-1) : group.versions;
      if (
        options.exactGroups
          ? options.exactGroups.has(group.id)
          : versions.some((version) =>
              version.members.some((member) =>
                member.occurrences.some((occurrence) => occurrence.recordId === recordId),
              ),
            )
      )
        yield {
          id: group.id,
          subjectText: options.subject === false ? '' : group.report?.subject?.text || '',
          ...(options.version ? { versionId: group.versions.at(-1)?.id } : {}),
        };
    }
    return;
  }
  // Ownership's reportGroups was a JS reader: retain LAST properties here.
  const view = openIntakeCollectionEnvelope(db, source as { id: string });
  const intake = view.child(view.root(), 'intake');
  const workflow = intake && view.child(intake, 'workflow');
  if (!workflow) return;
  let catalog: ReturnType<typeof createReportSnapshotCatalog> | undefined;
  const text = (record: IntakeEnvelopeRecord, name: string): string => {
    const field = view.field(record, name, { bytes: 64 * 1024 });
    if (field.kind === 'fragmented')
      throw Error('Ownership name field requires addressed consumption');
    if (field.kind === 'missing' || field.value == null) return '';
    if (typeof field.value !== 'string') throw Error('Ownership name field is malformed');
    return field.value;
  };
  function* children(
    record: IntakeEnvelopeRecord,
    name: string,
    required = true,
  ): Generator<IntakeEnvelopeRecord> {
    const collection = view.child(record, name);
    if (!collection) {
      const selected = view.field(record, name, { bytes: 64 * 1024 });
      if (
        !required &&
        (selected.kind === 'missing' || (selected.kind === 'value' && !selected.value))
      )
        return;
      throw Error('Ownership occurrence collection is unavailable');
    }
    if (view.info(collection).shape !== 'array')
      throw Error('Ownership occurrence collection is malformed');
    let after: string | undefined;
    while (true) {
      const page = view.children(record, name, { after, items: 32, bytes: 128 * 1024 });
      yield* page.records;
      if (page.complete) return;
      if (!page.after || page.after === after)
        throw Error('Ownership scope traversal did not advance');
      after = page.after;
    }
  }
  const contains = (group: IntakeEnvelopeRecord): boolean => {
    const versionsRecord = view.child(group, 'versions');
    if (!versionsRecord || view.info(versionsRecord).shape !== 'array')
      throw Error('Ownership group versions are unavailable');
    const total = options.latestOnly ? view.childCount(group, 'versions') : 0;
    const latest =
      options.latestOnly && total ? view.childAt(group, 'versions', total - 1) : undefined;
    const versions = options.latestOnly ? (latest ? [latest] : []) : children(group, 'versions');
    let found = false;
    // Drain the entire checked relevant group, even after a match, so missing
    // late occurrence evidence cannot be mistaken for a complete ownership scope.
    for (const version of versions) {
      if (text(version, 'format') === 'health-intake-report-group-version-v2') {
        const members = view.child(version, 'members');
        if (!members || view.info(members).shape !== 'object')
          throw Error('Ownership member snapshot reference is unavailable');
        const number = (name: string) => {
          const value = view.field(members, name, { bytes: 65536 });
          if (value.kind !== 'value' || typeof value.value !== 'number')
            throw Error('Ownership member snapshot count is unavailable');
          return value.value;
        };
        const reference: IntakeReportMembersReference = {
          format: text(members, 'format') as IntakeReportMembersReference['format'],
          snapshotId: text(members, 'snapshotId'),
          memberCount: number('memberCount'),
          occurrenceCount: number('occurrenceCount'),
        };
        catalog ??= createReportSnapshotCatalog(db, source as { id: string });
        const snapshot = openReportMemberSnapshot(catalog, reference);
        for (let ordinal = 0; ordinal < reference.memberCount; ordinal++) {
          const member = snapshot.memberAt(ordinal);
          if (!member) throw Error('Ownership report member is unavailable');
          for (let occurrence = 0; occurrence < member.occurrenceCount; occurrence++)
            if (snapshot.occurrenceRecordId(member, occurrence) === recordId) found = true;
        }
        snapshot.assertCurrent();
      } else
        for (const member of children(version, 'members'))
          for (const occurrence of children(member, 'occurrences'))
            if (text(occurrence, 'recordId') === recordId) found = true;
    }
    return found;
  };
  for (const group of children(workflow, 'reportGroups', false)) {
    const id = text(group, 'id');
    if (!(options.exactGroups ? options.exactGroups.has(id) : contains(group))) continue;
    const versions = options.version ? view.childCount(group, 'versions') : 0;
    const last = versions ? view.childAt(group, 'versions', versions - 1) : undefined;
    const version = options.version ? { versionId: last ? text(last, 'id') : undefined } : {};
    if (options.subject === false) {
      yield {
        id,
        subjectText: '',
        ...version,
      };
      continue;
    }
    const report = view.child(group, 'report');
    const subject = report && view.child(report, 'subject');
    let subjectText = subject ? text(subject, 'text') : '';
    if (!report) {
      const selected = view.field(group, 'report', { bytes: 64 * 1024 });
      if (selected.kind === 'fragmented')
        throw Error('Ownership report requires addressed consumption');
      if (selected.kind === 'value') {
        const retained = selected.value as { subject?: { text?: string } } | null;
        subjectText = retained?.subject?.text || '';
      }
    } else if (!subject) {
      const selected = view.field(report, 'subject', { bytes: 64 * 1024 });
      if (selected.kind === 'fragmented')
        throw Error('Ownership subject requires addressed consumption');
      if (selected.kind === 'value')
        subjectText = (selected.value as { text?: string } | null)?.text || '';
    }
    yield { id, subjectText, ...version };
  }
  view.address(view.root());
}

/** Cold complete scope join for an explicitly prepared native ownership action. */
export function* ownershipIntakeScopeOccurrences(
  db: Database,
  intakeId: string,
): Generator<{
  groupOrdinal: number;
  id: string;
  versionId: string;
  recordId: string | null;
  latest: boolean;
  subjectText: string;
}> {
  const source = db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(intakeId);
  if (!source || !hasIntakeCollectionEnvelope(db, source as { id: string }))
    throw Error('Addressed ownership scope index requires a native original');
  const view = openIntakeCollectionEnvelope(db, source as { id: string }),
    intake = view.child(view.root(), 'intake'),
    workflow = intake && view.child(intake, 'workflow');
  if (!workflow) return;
  const read = (record: IntakeEnvelopeRecord, field: string) => {
    const value = view.field(record, field, { bytes: 65536 });
    if (value.kind === 'fragmented')
      throw Error('Ownership scope header requires addressed consumption');
    return value.kind === 'value' ? value.value : undefined;
  };
  const text = (record: IntakeEnvelopeRecord, field: string) => {
    const value = read(record, field);
    if (typeof value !== 'string') throw Error('Ownership scope identity is unavailable');
    return value;
  };
  const count = (parent: IntakeEnvelopeRecord, field: string, optional = false) => {
    const collection = view.child(parent, field);
    if (!collection) {
      const value = read(parent, field);
      if (optional && !value) return 0;
      throw Error('Ownership scope collection is unavailable');
    }
    if (view.info(collection).shape !== 'array')
      throw Error('Ownership scope collection is malformed');
    return view.childCount(parent, field);
  };
  let catalog: ReturnType<typeof createReportSnapshotCatalog> | undefined;
  for (let g = 0, groups = count(workflow, 'reportGroups', true); g < groups; g++) {
    const group = view.childAt(workflow, 'reportGroups', g)!;
    if (!group) throw Error('Missing ownership report group');
    const id = text(group, 'id'),
      report = view.child(group, 'report'),
      subject = report && view.child(report, 'subject'),
      subjectText = subject ? (read(subject, 'text') as string) || '' : '';
    for (let v = 0, versions = count(group, 'versions'); v < versions; v++) {
      const version = view.childAt(group, 'versions', v);
      if (!version) throw Error('Missing ownership report version');
      const versionId = text(version, 'id'),
        latest = v === versions - 1;
      yield { groupOrdinal: g, id, versionId, recordId: null, latest, subjectText };
      if (read(version, 'format') === 'health-intake-report-group-version-v2') {
        const members = view.child(version, 'members');
        if (!members) throw Error('Ownership member reference is unavailable');
        const reference = {
          format: read(members, 'format'),
          snapshotId: read(members, 'snapshotId'),
          memberCount: read(members, 'memberCount'),
          occurrenceCount: read(members, 'occurrenceCount'),
        } as IntakeReportMembersReference;
        catalog ??= createReportSnapshotCatalog(db, source as { id: string });
        const snapshot = openReportMemberSnapshot(catalog, reference);
        for (let m = 0; m < reference.memberCount; m++) {
          const member = snapshot.memberAt(m);
          if (!member) throw Error('Missing ownership report member');
          for (let o = 0; o < member.occurrenceCount; o++) {
            const recordId = snapshot.occurrenceRecordId(member, o);
            if (typeof recordId !== 'string')
              throw Error('Ownership member lacks a record identity');
            yield { groupOrdinal: g, id, versionId, recordId, latest, subjectText };
          }
        }
        snapshot.assertCurrent();
      } else
        for (let m = 0, members = count(version, 'members'); m < members; m++) {
          const member = view.childAt(version, 'members', m);
          if (!member) throw Error('Missing ownership report member');
          for (let o = 0, occurrences = count(member, 'occurrences'); o < occurrences; o++) {
            const occurrence = view.childAt(member, 'occurrences', o);
            if (!occurrence) throw Error('Missing ownership report occurrence');
            yield {
              groupOrdinal: g,
              id,
              versionId,
              recordId: text(occurrence, 'recordId'),
              latest,
              subjectText,
            };
          }
        }
    }
  }
  view.address(view.root());
}
