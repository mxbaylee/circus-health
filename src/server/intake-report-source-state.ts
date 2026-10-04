import { createReportSnapshotCatalog as createReportSnapshotCatalogForReceipt } from './intake-report-snapshot-catalog.ts';
import {
  openReportSourceSnapshot,
  reportSourceSnapshotRows,
} from './intake-report-source-snapshot.ts';
import type {
  IntakeReportSourceMembersReference,
  IntakeReportSourceCoverageReference,
} from '../shared/intake-report-source-reference.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { IntakeReportSourceCoverageEntry, IntakeReportSourceScope } from '../shared/intake.ts';
import type { IntakeReportSourceExtensionV2 } from '../shared/intake-report-source-reference.ts';
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import type {
  ReportSnapshotCatalog,
  ReportSnapshotMapReader,
  ReportSnapshotMapWriter,
} from './intake-report-snapshot-catalog.ts';
import {
  createSourceResolutionIndex,
  selectedSourceCoverage,
  canonicalSourceOccurrenceQuery,
  sourceLocatorHash,
  hashSourceScalar,
  type SourceResolutionScope,
} from './intake-report-source-resolution-index.ts';
import type { Database } from './database.ts';
import { hashCanonicalReportSourceConfirmation } from './intake-report-source-canonical.ts';
import { schemaKey, schemaOrdinal } from './intake-envelope-schema.ts';
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';
import { openIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
import type { NativeReportExtensionInput } from './intake-collection-proposals.ts';
import type { IntakeEnvelopeMutation } from './intake-envelope-mutation.ts';
import {
  prepareIntakeJsonCanonical,
  intakeJsonCanonicalWorkObserver,
} from './intake-json-canonical.ts';
import { canonicalLiteral } from './intake-format.ts';
import {
  reportSourceExtensionEvents,
  pendingUnacceptedSourceMember,
  type ReportSourceExtensionEvent,
  type ReportSourceConfirmationHeader,
  type SelectedReportSourceConfirmation,
  type ReportSourceExtensionInput,
  type ReportSourceMemberHeader,
  type ReportSourceGroupAuthority,
} from './intake-collection-report-source.ts';

export interface ReportSourceStateReference {
  format: 'health-intake-report-source-state-v1';
  snapshotId: string;
  operationId: string;
  recordAddress: string;
}
const hash = (value: unknown) => createHash('sha256').update(canonicalLiteral(value)).digest('hex');
const memberIdentity = (
  member: Pick<ReportSourceMemberHeader, 'candidateId' | 'candidateVersionId'>,
) => [member.candidateId, member.candidateVersionId];
const occurrenceIdentity = (
  entry: Pick<IntakeReportSourceCoverageEntry, 'candidateId' | 'candidateVersionId' | 'occurrence'>,
) => [
  canonicalLiteral(memberIdentity(entry)),
  schemaKey(
    entry.occurrence.proposalId,
    entry.occurrence.recordId,
    entry.occurrence.batchId,
    entry.occurrence.locator,
  ),
];
const order = (ordinal: number) => 'm:' + String(ordinal).padStart(16, '0');
const checkedJson = <T>(map: ReportSnapshotMapReader, key: string): T => {
  const value = map.get(key);
  if (typeof value !== 'string' || Buffer.byteLength(value) > 65536)
    throw Error('Report source selected value is unavailable: ' + key);
  return JSON.parse(value) as T;
};
function* rows(map: ReportSnapshotMapReader, prefix: string) {
  let after = prefix;
  do {
    const page = map.range({ after, items: 64, bytes: 128 * 1024 });
    for (const item of page.items) {
      if (!item.key.startsWith(prefix)) return;
      yield item;
    }
    if (page.complete) return;
    if (!page.after || page.after === after) throw Error('Report source snapshot did not advance');
    after = page.after;
  } while (true);
}
const requiredReference = (map: ReportSnapshotMapReader, key: string) => {
  const result = map.reference(key);
  if (!result) throw Error('Missing report source owned scope: ' + key);
  return result;
};
const field = (
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
  optional = false,
): unknown => {
  const result = view.field(record, name, { bytes: 65536 });
  if (result.kind === 'missing' && optional) return undefined;
  if (result.kind !== 'value') throw Error('Report source field is unavailable: ' + name);
  return result.value;
};
const text = (
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
  optional = false,
) => {
  const value = field(view, record, name, optional);
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string') throw Error('Invalid report source field: ' + name);
  return value;
};
/** Unknown scope fields make the old exact canonical comparison unequal. Never project them away into a compatible authority. */
function compatibleScopeHeader(
  view: IntakeCollectionEnvelopeReader,
  scope: IntakeEnvelopeRecord | undefined,
): IntakeReportSourceScope | undefined {
  if (!scope || view.info(scope).shape !== 'object' || view.info(scope).count !== 3)
    return undefined;
  const read = (name: string) => {
    const selected = view.field(scope, name, { bytes: 256 });
    return selected.kind === 'value' ? selected.value : undefined;
  };
  const kind = read('kind'),
    reportFingerprint = read('reportFingerprint'),
    contextFingerprint = read('contextFingerprint');
  if (
    kind !== 'anchored_report' ||
    typeof reportFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(reportFingerprint) ||
    (contextFingerprint !== null &&
      (typeof contextFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(contextFingerprint)))
  )
    return undefined;
  return { kind, reportFingerprint, contextFingerprint };
}
export function readReportSourceConfirmationHeader(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
): ReportSourceConfirmationHeader {
  const header: ReportSourceConfirmationHeader = {
    operationId: text(view, record, 'operationId')!,
    groupId: text(view, record, 'groupId')!,
    groupVersionId: text(view, record, 'groupVersionId')!,
    contextId: text(view, record, 'contextId')!,
    source: text(view, record, 'source')!,
    sourceProviderId: text(view, record, 'sourceProviderId')!,
    at: text(view, record, 'at')!,
  };
  const basis = text(view, record, 'basis', true);
  if (basis !== undefined) {
    if (
      !['manual_report_label', 'explicit_current_members', 'suggested_report_label'].includes(basis)
    )
      throw Error('Invalid source confirmation basis');
    header.basis = basis as ReportSourceConfirmationHeader['basis'];
  }
  const scope = compatibleScopeHeader(view, view.child(record, 'scope'));
  if (scope) header.scope = scope;
  return header;
}
function* children(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
) {
  if (view.has(record, name) && !view.child(record, name))
    throw Error('Report source history requires selected structured records');
  let after: string | undefined;
  do {
    const page = view.children(record, name, { after, items: 64, bytes: 128 * 1024 });
    for (const row of page.records) yield row;
    if (page.complete) return;
    if (!page.after || page.after === after) throw Error('Report source history did not advance');
    after = page.after;
  } while (true);
}
const selectedMember = (view: IntakeCollectionEnvelopeReader, record: IntakeEnvelopeRecord) => ({
  candidateId: text(view, record, 'candidateId')!,
  candidateVersionId: text(view, record, 'candidateVersionId')!,
});
function selectedCoverageIdentity(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  db?: Database,
) {
  const nested = view.child(record, 'occurrence');
  if (!nested) throw Error('Source coverage requires a selected occurrence record');
  const proposalId = field(view, nested, 'proposalId'),
    recordId = field(view, nested, 'recordId'),
    batchId = field(view, nested, 'batchId');
  if (
    (proposalId !== null && typeof proposalId !== 'string') ||
    typeof recordId !== 'string' ||
    (batchId !== null && typeof batchId !== 'string')
  )
    throw Error('Invalid source occurrence identity');
  const locator = hashSourceScalar(db, view.fieldChunks(nested, 'locator'), [
    proposalId,
    recordId,
    batchId,
  ]);
  if (locator.kind !== 'string') throw Error('Invalid source occurrence locator');
  return [canonicalLiteral(memberIdentity(selectedMember(view, record))), locator.hash];
}
function sourceReference(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: 'members' | 'coverageEntries',
) {
  const format = view.field(record, 'format', { bytes: 256 });
  if (
    format.kind !== 'value' ||
    ![
      'health-intake-report-source-confirmation-v2',
      'health-intake-report-source-extension-v2',
    ].includes(String(format.value)) ||
    view.child(record, name) ||
    !view.has(record, name)
  )
    return undefined;
  const ref = field(view, record, name) as
    IntakeReportSourceMembersReference | IntakeReportSourceCoverageReference;
  if (
    !ref ||
    ref.format !==
      (name === 'members'
        ? 'health-intake-report-source-members-v1'
        : 'health-intake-report-source-coverage-v1')
  )
    throw Error('Invalid native source scope');
  return ref;
}
function counts(view: IntakeCollectionEnvelopeReader, record: IntakeEnvelopeRecord) {
  const members = sourceReference(view, record, 'members') as
      IntakeReportSourceMembersReference | undefined,
    coverage = sourceReference(view, record, 'coverageEntries') as
      IntakeReportSourceCoverageReference | undefined;
  return {
    memberCount: members?.memberCount ?? view.childCount(record, 'members'),
    coverageCount: coverage?.entryCount ?? view.childCount(record, 'coverageEntries'),
    extensionCount: view.childCount(record, 'extensions'),
  };
}
async function putSame(map: ReportSnapshotMapWriter, key: string, value: string) {
  const old = map.get(key);
  if (old === value) return;
  await map.put(key, value);
}

/** Explicit cold traversal; never invoked by a negative interactive lookup. */
export async function prepareLegacyReportSourceState(
  catalog: ReportSnapshotCatalog,
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  db?: Database,
): Promise<ReportSourceStateReference> {
  const header = readReportSourceConfirmationHeader(view, record),
    coveredMembers = await catalog.fork(),
    coveredOccurrences = await catalog.fork(),
    extensions = await catalog.fork(),
    authorities = await catalog.fork(),
    latestMembers = await catalog.fork(),
    latestMemberLookup = await catalog.fork(),
    resolution = await createSourceResolutionIndex(catalog);
  const addMembers = async (
    parent: IntakeEnvelopeRecord,
    lookup?: ReportSnapshotMapWriter,
    original = false,
  ) => {
    const reference = sourceReference(view, parent, 'members');
    const native = reference
      ? openReportSourceSnapshot(
          catalog,
          reference,
          header.operationId,
          text(view, parent, 'groupVersionId')!,
          'members',
        )
      : undefined;
    function* selectedMembers() {
      if (!native) {
        for (const member of children(view, parent, 'members')) yield selectedMember(view, member);
        return;
      }
      let seen = 0;
      for (const row of reportSourceSnapshotRows(native.map, 'members')) {
        if (typeof row.value !== 'string') throw Error('Invalid source member identity');
        const value = JSON.parse(row.value) as { candidateId: string; candidateVersionId: string };
        if (typeof value.candidateId !== 'string' || typeof value.candidateVersionId !== 'string')
          throw Error('Invalid source member identity');
        seen++;
        yield value;
      }
      if (seen !== native.count) throw Error('Source member count mismatch');
    }
    for (const selected of selectedMembers()) {
      const identity = memberIdentity(selected);
      if (original) await resolution.originalMember(header.groupId, selected);
      else await resolution.memberScope(header.groupId, selected);
      if (lookup) await putSame(lookup, 'm:' + schemaKey(...identity), '1');
      await putSame(coveredMembers, 'm:' + hash(identity), canonicalLiteral(identity));
    }
  };
  const addCoverage = async (
    parent: IntakeEnvelopeRecord,
    original: boolean,
    extensionOrdinal = -1,
    extensionId?: string,
  ) => {
    let entryOrdinal = 0;
    const reference = sourceReference(view, parent, 'coverageEntries');
    if (reference) {
      const native = openReportSourceSnapshot(
        catalog,
        reference,
        header.operationId,
        text(view, parent, 'groupVersionId')!,
        'coverage',
      );
      for (const row of reportSourceSnapshotRows(native.map, 'coverage')) {
        const parsed = await prepareIntakeJsonCanonical(native.map.chunks(row.key), {
          assertRunning: catalog.assertCurrent,
          onWork: db ? intakeJsonCanonicalWorkObserver(db, 'warm') : undefined,
        });
        try {
          const small = (name: string) => {
            const handle = parsed.field(parsed.root, name);
            if (!handle) throw Error('Missing source coverage identity');
            let raw = '';
            for (const piece of parsed.pieces(handle)) {
              if (Buffer.byteLength(raw) + Buffer.byteLength(piece) > 65536)
                throw Error('Invalid source coverage identity');
              raw += piece;
            }
            return JSON.parse(raw);
          };
          const member = {
              candidateId: small('candidateId') as string,
              candidateVersionId: small('candidateVersionId') as string,
            },
            ref = small('sourceRef') as IntakeReportSourceCoverageEntry['sourceRef'],
            id = small('id') as string;
          const occurrence = parsed.field(parsed.root, 'occurrence');
          if (!occurrence) throw Error('Missing source coverage occurrence');
          const query = await canonicalSourceOccurrenceQuery(
              db,
              parsed.pieces(occurrence),
              catalog.assertCurrent,
            ),
            locator = parsed.field(occurrence, 'locator');
          if (!locator) throw Error('Missing source coverage locator');
          const sourceIdentity = hashSourceScalar(db, parsed.pieces(locator), [
            query.proposalId ?? null,
            query.recordId,
            query.batchId ?? null,
          ]).hash;
          await resolution.coverage(
            {
              ...member,
              groupId: ref.groupId,
              groupVersionId: ref.groupVersionId,
              contextId: ref.contextId,
              id,
              extensionOrdinal,
              entryOrdinal: entryOrdinal++,
              ...(extensionId ? { extensionId } : {}),
            },
            query,
          );
          const identity = [canonicalLiteral(memberIdentity(member)), sourceIdentity];
          await putSame(coveredOccurrences, 'o:' + hash(identity), canonicalLiteral(identity));
          if (original && ref.extensionScope) {
            const scope = ref.extensionScope;
            if (
              Object.keys(scope).sort().join(',') === 'contextFingerprint,kind,reportFingerprint' &&
              scope.kind === 'anchored_report'
            ) {
              const key = 's:' + hash(scope),
                old = authorities.get(key);
              if (old !== undefined && typeof old !== 'string')
                throw Error('Invalid source authority index');
              if (old === undefined || id < JSON.parse(old as string))
                await authorities.put(key, JSON.stringify(id));
            }
          }
        } finally {
          parsed.close();
        }
      }
      if (entryOrdinal !== native.count) throw Error('Source coverage count mismatch');
      return;
    }
    for (const entry of children(view, parent, 'coverageEntries')) {
      const selected = selectedSourceCoverage(
        view,
        entry,
        extensionOrdinal,
        entryOrdinal++,
        extensionId,
        db,
      );
      await resolution.coverage(selected.target, selected.query);
      const identity = selectedCoverageIdentity(view, entry, db);
      await putSame(coveredOccurrences, 'o:' + hash(identity), canonicalLiteral(identity));
      if (original) {
        const ref = view.child(entry, 'sourceRef'),
          scope = compatibleScopeHeader(view, ref ? view.child(ref, 'extensionScope') : undefined);
        if (scope) {
          const { kind, reportFingerprint, contextFingerprint } = scope;
          const key = 's:' + hash({ kind, reportFingerprint, contextFingerprint }),
            id = text(view, entry, 'id')!,
            old = authorities.get(key);
          if (old !== undefined && typeof old !== 'string')
            throw Error('Invalid explicit source authority index');
          if (old === undefined || id < (JSON.parse(old) as string))
            await authorities.put(key, JSON.stringify(id));
        }
      }
    }
  };
  await addMembers(record, undefined, true);
  await addCoverage(record, true);
  let extensionOrdinal = 0;
  for (const extension of children(view, record, 'extensions')) {
    const lookup = await catalog.fork(),
      extensionId = text(view, extension, 'id')!;
    await addMembers(extension, lookup);
    await addCoverage(extension, false, extensionOrdinal, extensionId);
    await resolution.extension(
      {
        id: extensionId,
        groupVersionId: text(view, extension, 'groupVersionId')!,
        contextId: text(view, extension, 'contextId')!,
        ordinal: extensionOrdinal++,
      },
      lookup,
    );
    const id = text(view, extension, 'groupVersionId')!;
    await putSame(extensions, 'v:' + hash(id), JSON.stringify(id));
  }
  const partition = await catalog.fork(),
    snapshotId = 'source-state:' + randomUUID();
  const reference: ReportSourceStateReference = {
    format: 'health-intake-report-source-state-v1',
    snapshotId,
    operationId: header.operationId,
    recordAddress: view.address(record),
  };
  await partition.put(
    'meta',
    JSON.stringify({
      format: reference.format,
      operationId: header.operationId,
      recordAddress: reference.recordAddress,
      headerHash: hash(header),
      ...counts(view, record),
    }),
  );
  await partition.put(
    'confirmationHash',
    await hashCanonicalReportSourceConfirmation(db, view, record, catalog),
  );
  await partition.attach('coveredMembers', coveredMembers);
  await partition.attach('coveredOccurrences', coveredOccurrences);
  await partition.attach('extensions', extensions);
  await partition.attach('authorities', authorities);
  await partition.attach('latestMembers', latestMembers);
  await partition.attach('latestMemberLookup', latestMemberLookup);
  await partition.attach('resolution', await resolution.finish());
  await catalog.publish(snapshotId, partition);
  return reference;
}

export function openReportSourceState(
  catalog: ReportSnapshotCatalog,
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  reference: ReportSourceStateReference,
): SelectedReportSourceConfirmation {
  const map = catalog.open(reference.snapshotId);
  if (!map || reference.format !== 'health-intake-report-source-state-v1')
    throw Error('Missing selected source confirmation state');
  const header = readReportSourceConfirmationHeader(view, record),
    meta = checkedJson<{
      format: string;
      operationId: string;
      recordAddress: string;
      headerHash: string;
      memberCount: number;
      coverageCount: number;
      extensionCount: number;
    }>(map, 'meta');
  if (
    meta.format !== reference.format ||
    meta.operationId !== reference.operationId ||
    meta.operationId !== header.operationId ||
    meta.recordAddress !== reference.recordAddress ||
    meta.recordAddress !== view.address(record) ||
    meta.headerHash !== hash(header) ||
    meta.memberCount !== counts(view, record).memberCount ||
    meta.coverageCount !== counts(view, record).coverageCount ||
    meta.extensionCount !== view.childCount(record, 'extensions')
  )
    throw Error('Stale source confirmation state');
  const members = requiredReference(map, 'coveredMembers'),
    occurrences = requiredReference(map, 'coveredOccurrences'),
    extensions = requiredReference(map, 'extensions'),
    authorities = requiredReference(map, 'authorities');
  const has = (scope: ReportSnapshotMapReader, key: string, expected: unknown) => {
    const found = scope.get(key);
    if (found === undefined) return false;
    if (found !== canonicalLiteral(expected))
      throw Error('Source scope identity index disagreement');
    return true;
  };
  return {
    header,
    hasExtension: (id) => has(extensions, 'v:' + hash(id), id),
    hasMember: (member) => {
      const identity = memberIdentity(member);
      return has(members, 'm:' + hash(identity), identity);
    },
    hasOccurrence: (member, occurrence) => {
      const identity = occurrenceIdentity({ ...member, occurrence });
      return has(occurrences, 'o:' + hash(identity), identity);
    },
    hasOccurrenceIdentity: (member, sourceIdentity) => {
      const identity = [canonicalLiteral(memberIdentity(member)), sourceIdentity];
      return has(occurrences, 'o:' + hash(identity), identity);
    },
    authorityEntry: (scope) => {
      const found = authorities.get('s:' + hash(scope));
      if (found === undefined) return undefined;
      if (typeof found !== 'string') throw Error('Invalid explicit source authority');
      return JSON.parse(found) as string;
    },
  };
}

/** Stages only differences into owned snapshots; the caller atomically appends the descriptor and selects catalog.finalChanges(). */
export async function prepareReportSourceExtension(
  catalog: ReportSnapshotCatalog,
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  reference: ReportSourceStateReference,
  input: Omit<ReportSourceExtensionInput, 'confirmation'>,
  work: <T>(run: () => T) => T = (run) => run(),
  db?: Database,
): Promise<
  { extension: IntakeReportSourceExtensionV2; state: ReportSourceStateReference } | undefined
> {
  const confirmation = openReportSourceState(catalog, view, record, reference),
    events = reportSourceExtensionEvents({ ...input, confirmation });
  const first = work(() => events.next());
  if (first.done) return undefined;
  const old = catalog.open(reference.snapshotId)!,
    coveredMembers = await catalog.forkReference(requiredReference(old, 'coveredMembers')),
    coveredOccurrences = await catalog.forkReference(requiredReference(old, 'coveredOccurrences')),
    extensions = await catalog.forkReference(requiredReference(old, 'extensions')),
    authorities = await catalog.forkReference(requiredReference(old, 'authorities')),
    latestMembers = await catalog.forkReference(requiredReference(old, 'latestMembers')),
    latestMemberLookup = await catalog.forkReference(requiredReference(old, 'latestMemberLookup')),
    resolution = await createSourceResolutionIndex(catalog, requiredReference(old, 'resolution')),
    coverage = await catalog.fork();
  // Retained noncumulative legacy snapshots can omit old members; preserve the exact current intersection.
  for (const item of rows(latestMembers, 'm:')) {
    if (typeof item.value !== 'string') throw Error('Invalid source member identity');
    const member = JSON.parse(item.value) as { candidateId: string; candidateVersionId: string };
    const ordinal = Number(item.key.slice(2));
    const current = input.current.memberAt
      ? input.current.memberAt(ordinal)
      : input.current.member(member.candidateId, member.candidateVersionId);
    if (
      !current ||
      order(current.ordinal) !== item.key ||
      current.candidateId !== member.candidateId ||
      current.candidateVersionId !== member.candidateVersionId
    ) {
      await latestMembers.delete(item.key);
      if (!input.current.member(member.candidateId, member.candidateVersionId))
        await latestMemberLookup.delete(
          'm:' + schemaKey(member.candidateId, member.candidateVersionId),
        );
    }
  }
  let next: IteratorResult<ReportSourceExtensionEvent> = first;
  let coverageCount = 0;
  do {
    const event = next.value!;
    if (event.kind === 'member') {
      const identity = memberIdentity(event.member);
      await putSame(latestMemberLookup, 'm:' + schemaKey(...identity), '1');
      await resolution.memberScope(confirmation.header.groupId, event.member);
      await putSame(coveredMembers, 'm:' + hash(identity), canonicalLiteral(identity));
      await putSame(
        latestMembers,
        order(event.member.ordinal),
        canonicalLiteral({
          candidateId: event.member.candidateId,
          candidateVersionId: event.member.candidateVersionId,
        }),
      );
    } else if (event.kind === 'coverage') {
      const occurrence = event.entry.occurrence;
      await resolution.coverage(
        {
          ...event.entry,
          ...event.entry.sourceRef,
          extensionOrdinal: view.childCount(record, 'extensions'),
          extensionId: event.extensionId,
          entryOrdinal: coverageCount,
        },
        {
          proposalId: occurrence.proposalId,
          recordId: occurrence.recordId,
          batchId: occurrence.batchId,
          locatorHash: sourceLocatorHash(occurrence.locator, db),
        },
      );
      const identity = occurrenceIdentity(event.entry);
      await putSame(coveredOccurrences, 'o:' + hash(identity), canonicalLiteral(identity));
      await coverage.putText('e:' + String(coverageCount++).padStart(16, '0'), [
        canonicalLiteral(event.entry),
      ]);
    } else if (event.kind === 'coverage-reference') {
      await resolution.coverage(
        {
          ...event.entry,
          ...event.entry.sourceRef,
          extensionOrdinal: view.childCount(record, 'extensions'),
          extensionId: event.extensionId,
          entryOrdinal: coverageCount,
        },
        await canonicalSourceOccurrenceQuery(db, event.canonicalOccurrence(), input.assertCurrent),
      );
      const identity = [
        canonicalLiteral(memberIdentity(event.entry)),
        event.occurrence.sourceIdentity,
      ];
      await putSame(coveredOccurrences, 'o:' + hash(identity), canonicalLiteral(identity));
      const entry = event.entry;
      await coverage.putText(
        'e:' + String(coverageCount++).padStart(16, '0'),
        (function* () {
          yield '{"candidateId":' +
            canonicalLiteral(entry.candidateId) +
            ',"candidateVersionId":' +
            canonicalLiteral(entry.candidateVersionId) +
            ',"id":' +
            canonicalLiteral(entry.id) +
            ',"occurrence":';
          yield* event.canonicalOccurrence();
          yield ',"sourceRef":' + canonicalLiteral(entry.sourceRef) + '}';
        })(),
      );
    } else {
      const extensionSnapshot = await catalog.fork(),
        snapshotId = 'source-extension:' + randomUUID();
      await extensionSnapshot.put(
        'meta',
        JSON.stringify({
          format: 'health-intake-report-source-extension-snapshot-v1',
          memberCount: event.memberCount,
          coverageEntryCount: event.coverageEntryCount,
          operationId: confirmation.header.operationId,
          groupVersionId: input.version.id,
        }),
      );
      await resolution.extension(
        {
          id: event.header.id,
          groupVersionId: event.header.groupVersionId,
          contextId: event.header.contextId,
          ordinal: view.childCount(record, 'extensions'),
        },
        latestMemberLookup,
      );
      await extensionSnapshot.attach('newResolutionScopes', resolution.newScopes);
      await extensionSnapshot.attach('members', latestMembers);
      await extensionSnapshot.attach('coverage', coverage);
      await catalog.publish(snapshotId, extensionSnapshot);
      const extension: IntakeReportSourceExtensionV2 = {
        format: 'health-intake-report-source-extension-v2',
        ...event.header,
        members: {
          format: 'health-intake-report-source-members-v1',
          snapshotId,
          memberCount: event.memberCount,
        },
        ...(event.coverageEntryCount
          ? {
              coverageEntries: {
                format: 'health-intake-report-source-coverage-v1',
                snapshotId,
                entryCount: event.coverageEntryCount,
              },
            }
          : {}),
      };
      await putSame(extensions, 'v:' + hash(input.version.id), JSON.stringify(input.version.id));
      const partition = await catalog.forkReference(old),
        state = { ...reference, snapshotId: 'source-state:' + randomUUID() };
      await partition.put(
        'meta',
        JSON.stringify({
          format: state.format,
          operationId: confirmation.header.operationId,
          recordAddress: state.recordAddress,
          headerHash: hash(confirmation.header),
          ...counts(view, record),
          extensionCount: view.childCount(record, 'extensions') + 1,
        }),
      );
      await partition.attach('coveredMembers', coveredMembers);
      await partition.attach('coveredOccurrences', coveredOccurrences);
      await partition.attach('extensions', extensions);
      await partition.attach('authorities', authorities);
      await partition.attach('latestMembers', latestMembers);
      await partition.attach('latestMemberLookup', latestMemberLookup);
      await partition.attach('resolution', await resolution.finish());
      await catalog.publish(state.snapshotId, partition);
      if (coverageCount !== event.coverageEntryCount)
        throw Error('Source coverage checkpoint count mismatch');
      return { extension, state };
    }
    next = work(() => events.next());
  } while (!next.done);
  throw Error('Incomplete source extension preparation');
}

interface ReportSourceIndexReference {
  format: 'health-intake-report-source-index-v1';
  snapshotId: string;
  confirmationCount: number;
  confirmationsRecordAddress: string;
}
interface IndexedConfirmation {
  address: string;
  state: ReportSourceStateReference;
}
async function groupAuthority(
  input: NativeReportExtensionInput,
): Promise<ReportSourceGroupAuthority> {
  const { view, group: record, db } = input,
    id = text(view, record, 'id')!,
    basis = text(view, record, 'basis');
  if (basis !== 'report_anchor' && basis !== 'candidate_fallback')
    throw Error('Invalid report source group basis');
  const nullable = (name: string) => {
    const value = field(view, record, name);
    if (value !== null && typeof value !== 'string')
      throw Error('Invalid report source group ' + name);
    return value;
  };
  const sourceFileId = nullable('sourceFileId'),
    sourceHash = nullable('sourceHash'),
    sourceSystem = nullable('sourceSystem'),
    memberId = nullable('memberId'),
    report = view.child(record, 'report');
  const fingerprint = createHash('sha256');
  withIntakeWork(db, 'warm', () => recordIntakeWork('hashCalls'));
  const update = (piece: string) => {
    withIntakeWork(db, 'warm', () => recordIntakeWork('hashedBytes', Buffer.byteLength(piece)));
    fingerprint.update(piece);
  };
  update(
    '[' +
      canonicalLiteral(id) +
      ',' +
      canonicalLiteral(sourceFileId) +
      ',' +
      canonicalLiteral(sourceHash) +
      ',' +
      canonicalLiteral(sourceSystem) +
      ',' +
      canonicalLiteral(memberId) +
      ',',
  );
  const fieldFingerprint = async (name: string) => {
    if (!report || !view.has(report, name)) {
      update('null');
      return false;
    }
    const child = view.child(report, name),
      prepared = await prepareIntakeJsonCanonical(
        child ? view.recordChunks(child) : view.fieldChunks(report, name),
        { assertRunning: input.assertCurrent, onWork: intakeJsonCanonicalWorkObserver(db, 'warm') },
      );
    try {
      const kind = prepared.kind(prepared.root);
      let truthy = true;
      if (kind === 'null') truthy = false;
      else if (kind === 'string') {
        let prefix = '';
        for (const piece of prepared.chunks()) {
          prefix += piece.slice(0, 3 - prefix.length);
          if (prefix.length >= 3) break;
        }
        truthy = prefix !== '""';
      } else if (kind === 'boolean' || kind === 'number') {
        let scalar = '';
        for (const piece of prepared.chunks()) {
          if (scalar.length + piece.length > 128)
            throw Error('Canonical scalar exceeds numeric grammar');
          scalar += piece;
        }
        truthy = !!JSON.parse(scalar);
      }
      if (truthy)
        for (const piece of prepared.chunks()) {
          input.assertCurrent();
          update(piece);
        }
      else update('null');
      return truthy;
    } finally {
      prepared.close();
    }
  };
  const anchored = await fieldFingerprint('anchor');
  update(',');
  await fieldFingerprint('subject');
  update(']');
  const reportFingerprint = fingerprint.digest('hex');
  const exactHash = (value: unknown) =>
    withIntakeWork(db, 'warm', () => {
      const serialized = canonicalLiteral(value);
      recordIntakeWork('hashCalls');
      recordIntakeWork('hashedBytes', Buffer.byteLength(serialized));
      return createHash('sha256').update(serialized).digest('hex');
    });
  const scope: ReportSourceGroupAuthority['scope'] = (version, confirmationBasis) => {
    if (
      basis !== 'report_anchor' ||
      !sourceFileId ||
      !sourceHash ||
      !anchored ||
      version.contextState === 'mixed'
    )
      return null;
    const contextFingerprint =
      confirmationBasis === 'manual_report_label'
        ? version.context
          ? exactHash(version.context)
          : null
        : version.context?.status === 'linked' && version.context.sourceSuggestion
          ? exactHash(version.context)
          : null;
    if (confirmationBasis !== 'manual_report_label' && !contextFingerprint) return null;
    return { kind: 'anchored_report', reportFingerprint, contextFingerprint };
  };
  return {
    format: 'health-intake-report-source-group-authority-v1',
    id,
    scope,
    reference(version) {
      const extensionScope = scope(version, 'manual_report_label');
      return {
        groupId: id,
        groupVersionId: version.id,
        contributionId: version.contributionId,
        contextId: version.context?.contextId || version.id,
        fingerprint: exactHash([
          reportFingerprint,
          version.id,
          version.contributionId,
          version.contextState || 'none',
          version.context || null,
        ]),
        ...(extensionScope ? { extensionScope } : {}),
      };
    },
  };
}
async function registerResolutionScopes(
  catalog: ReportSnapshotCatalog,
  index: ReportSnapshotMapWriter,
  scopes: ReportSnapshotMapReader,
  ordinalKey: string,
  address: string,
) {
  for (const row of rows(scopes, 's:')) {
    if (typeof row.value !== 'string') throw Error('Invalid selected source resolution scope');
    const scope = JSON.parse(row.value) as SourceResolutionScope,
      key = 'r:' + schemaKey(scope.groupId, scope.candidateId, scope.candidateVersionId),
      old = index.reference(key);
    if (old?.get(ordinalKey) === address) continue;
    const pointer = old ? await catalog.forkReference(old) : await catalog.fork();
    await pointer.put(ordinalKey, address);
    await index.attach(key, pointer);
  }
}
async function sourceIndex(
  input: Pick<
    NativeReportExtensionInput,
    'db' | 'source' | 'view' | 'workflow' | 'catalog' | 'assertCurrent'
  >,
): Promise<{
  reference: ReportSourceIndexReference;
  map: ReportSnapshotMapReader;
  initialized: boolean;
}> {
  const { view, workflow, catalog } = input,
    collection = view.child(workflow, 'reportSourceConfirmations');
  if (!collection || view.info(collection).shape !== 'array')
    throw Error('Missing report source confirmation collection');
  const count = view.childCount(workflow, 'reportSourceConfirmations'),
    address = view.address(collection),
    raw = field(view, workflow, 'reportSourceIndex', true);
  if (raw !== undefined) {
    const ref = raw as ReportSourceIndexReference;
    if (
      !ref ||
      ref.format !== 'health-intake-report-source-index-v1' ||
      ref.confirmationCount !== count ||
      ref.confirmationsRecordAddress !== address ||
      typeof ref.snapshotId !== 'string'
    )
      throw Error('Incomplete or stale report source group index');
    const map = catalog.open(ref.snapshotId);
    if (!map || canonicalLiteral(checkedJson(map, 'meta')) !== canonicalLiteral(ref))
      throw Error('Missing selected report source group index');
    return { reference: ref, map, initialized: false };
  }
  // One explicit first-use migration of retained v1 confirmations. Only one record/page is decoded.
  // Native writers must maintain this selected index with every confirmation append or identity edit.
  const index = await catalog.fork();
  let ordinal = 0;
  for (const record of children(view, workflow, 'reportSourceConfirmations')) {
    input.assertCurrent();
    const header = readReportSourceConfirmationHeader(view, record),
      key = 'g:' + schemaKey(header.groupId),
      old = index.reference(key),
      group = old ? await catalog.forkReference(old) : await catalog.fork(),
      state = await prepareLegacyReportSourceState(catalog, view, record, input.db);
    const ordinalKey = 'c:' + schemaOrdinal(ordinal++),
      address = view.address(record),
      encoded = JSON.stringify({ address, state } satisfies IndexedConfirmation);
    await group.put(ordinalKey, encoded);
    await index.put(ordinalKey, encoded);
    const operationKey = 'o:' + schemaKey(header.operationId);
    if (index.get(operationKey) === undefined) await index.put(operationKey, address);
    const resolution = requiredReference(catalog.open(state.snapshotId)!, 'resolution');
    await registerResolutionScopes(
      catalog,
      index,
      requiredReference(resolution, 'scopes'),
      ordinalKey,
      address,
    );
    await index.attach(key, group);
  }
  if (ordinal !== count) throw Error('Report source group index count mismatch');
  const reference: ReportSourceIndexReference = {
    format: 'health-intake-report-source-index-v1',
    snapshotId: 'source-index:' + randomUUID(),
    confirmationCount: count,
    confirmationsRecordAddress: address,
  };
  await index.put('meta', JSON.stringify(reference));
  await catalog.publish(reference.snapshotId, index);
  return { reference, map: catalog.open(reference.snapshotId)!, initialized: true };
}

/** Complete native automatic extension hook. All new snapshots stay auxiliary until the host's one atomic catalog/envelope publication. */
export async function* prepareNativeReportSourceExtensions(
  input: NativeReportExtensionInput,
): AsyncGenerator<IntakeEnvelopeMutation> {
  const { db, source, view, workflow, catalog } = input;
  input.assertCurrent();
  if (!view.childCount(workflow, 'reportSourceConfirmations')) return;
  const index = await sourceIndex(input),
    header = await groupAuthority(input),
    groupKey = 'g:' + schemaKey(header.id),
    selected = index.map.reference(groupKey);
  let nextIndex: ReportSnapshotMapWriter | undefined,
    nextGroup: ReportSnapshotMapWriter | undefined;
  const decisionView = openIntakeCollectionEnvelope(db, source);
  if (selected)
    for (const item of rows(selected, 'c:')) {
      input.assertCurrent();
      if (typeof item.value !== 'string') throw Error('Invalid indexed source confirmation');
      const indexed = JSON.parse(item.value) as IndexedConfirmation,
        record = view.resolve(indexed.address),
        confirmation = readReportSourceConfirmationHeader(view, record);
      if (confirmation.groupId !== header.id || record.kind !== 'reportSourceConfirmation')
        throw Error('Report source group index target mismatch');
      const prepared = await prepareReportSourceExtension(
        catalog,
        view,
        record,
        indexed.state,
        {
          group: header,
          version: input.version,
          current: input.current,
          prior: input.prior,
          contributed: (member) =>
            input.contributed.has(schemaKey(member.candidateId, member.candidateVersionId)),
          pendingUnaccepted: (member) =>
            pendingUnacceptedSourceMember(view, workflow, member, decisionView),
          assertCurrent: input.assertCurrent,
        },
        (run) => withIntakeWork(db, 'warm', run),
        db,
      );
      if (!prepared) continue;
      yield {
        op: 'append',
        record,
        field: 'extensions',
        jsonText: JSON.stringify(prepared.extension),
      };
      const updated = await catalog.forkReference(catalog.open(prepared.state.snapshotId)!);
      await updated.put(
        'confirmationHash',
        await hashCanonicalReportSourceConfirmation(db, view, record, catalog),
      );
      prepared.state = { ...prepared.state, snapshotId: 'source-state:' + randomUUID() };
      await catalog.publish(prepared.state.snapshotId, updated);
      nextIndex ??= await catalog.forkReference(index.map);
      nextGroup ??= await catalog.forkReference(selected);
      const encoded = JSON.stringify({
        address: indexed.address,
        state: prepared.state,
      } satisfies IndexedConfirmation);
      await nextGroup.put(item.key, encoded);
      await nextIndex.put(item.key, encoded);
      await registerResolutionScopes(
        catalog,
        nextIndex,
        requiredReference(
          catalog.open(prepared.extension.members.snapshotId)!,
          'newResolutionScopes',
        ),
        item.key,
        indexed.address,
      );
    }
  if (nextIndex && nextGroup) {
    await nextIndex.attach(groupKey, nextGroup);
    const reference = { ...index.reference, snapshotId: 'source-index:' + randomUUID() };
    await nextIndex.put('meta', JSON.stringify(reference));
    await catalog.publish(reference.snapshotId, nextIndex);
    yield {
      op: 'set',
      record: workflow,
      field: 'reportSourceIndex',
      jsonText: JSON.stringify(reference),
    };
  } else if (index.initialized)
    yield {
      op: 'set',
      record: workflow,
      field: 'reportSourceIndex',
      jsonText: JSON.stringify(index.reference),
    };
  input.assertCurrent();
}

/** Explicit cold preparation for selected clinical source lookup; never called by the resolver itself. */
export async function* prepareNativeReportSourceIndex(
  input: Pick<
    NativeReportExtensionInput,
    'db' | 'source' | 'view' | 'workflow' | 'catalog' | 'assertCurrent'
  >,
): AsyncGenerator<IntakeEnvelopeMutation> {
  if (!input.view.childCount(input.workflow, 'reportSourceConfirmations')) return;
  const index = await sourceIndex(input);
  if (index.initialized)
    yield {
      op: 'set',
      record: input.workflow,
      field: 'reportSourceIndex',
      jsonText: JSON.stringify(index.reference),
    };
}

/** Capture the complete prior index before appending; finish updates only the new receipt's pointers. */
export async function prepareReportSourceIndexAppend(
  input: Pick<
    NativeReportExtensionInput,
    'db' | 'source' | 'view' | 'workflow' | 'catalog' | 'assertCurrent'
  >,
) {
  const prior = await sourceIndex(input);
  let finished = false;
  return async function* finish(
    record: IntakeEnvelopeRecord,
  ): AsyncGenerator<IntakeEnvelopeMutation> {
    if (finished) throw Error('Source confirmation append already prepared');
    finished = true;
    input.assertCurrent();
    const { view, workflow, catalog, db } = input,
      count = view.childCount(workflow, 'reportSourceConfirmations');
    if (
      count !== prior.reference.confirmationCount + 1 ||
      view.address(view.childAt(workflow, 'reportSourceConfirmations', count - 1)!) !==
        view.address(record)
    )
      throw Error('Source confirmation append changed its selected boundary');
    const header = readReportSourceConfirmationHeader(view, record),
      state = await prepareLegacyReportSourceState(catalog, view, record, db),
      index = await catalog.forkReference(prior.map),
      groupKey = 'g:' + schemaKey(header.groupId),
      oldGroup = index.reference(groupKey),
      group = oldGroup ? await catalog.forkReference(oldGroup) : await catalog.fork(),
      ordinalKey = 'c:' + schemaOrdinal(count - 1),
      address = view.address(record),
      encoded = JSON.stringify({ address, state } satisfies IndexedConfirmation);
    await group.put(ordinalKey, encoded);
    await index.put(ordinalKey, encoded);
    const operationKey = 'o:' + schemaKey(header.operationId);
    if (index.get(operationKey) === undefined) await index.put(operationKey, address);
    await index.attach(groupKey, group);
    await registerResolutionScopes(
      catalog,
      index,
      requiredReference(requiredReference(catalog.open(state.snapshotId)!, 'resolution'), 'scopes'),
      ordinalKey,
      address,
    );
    const reference: ReportSourceIndexReference = {
      ...prior.reference,
      snapshotId: 'source-index:' + randomUUID(),
      confirmationCount: count,
    };
    await index.put('meta', JSON.stringify(reference));
    await catalog.publish(reference.snapshotId, index);
    yield {
      op: 'set',
      record: workflow,
      field: 'reportSourceIndex',
      jsonText: JSON.stringify(reference),
    };
  };
}

/** Bounded exact-retry receipt projection; no members or coverage arrays are synthesized. */
export function readNativeReportSourceReceipt(
  db: Database,
  source: import('./intake-authority.ts').IntakeEnvelopeSource,
  operationId: string,
): import('../shared/intake-report-source-reference.ts').IntakeReportSourceReceiptV2 {
  const view = openIntakeCollectionEnvelope(db, source),
    intake = view.child(view.root(), 'intake'),
    workflow = intake && view.child(intake, 'workflow');
  if (!workflow) throw Error('Source confirmation workflow is missing');
  const reference = field(view, workflow, 'reportSourceIndex') as ReportSourceIndexReference,
    catalog = createReportSnapshotCatalogForReceipt(db, source),
    index = reference && catalog.open(reference.snapshotId);
  if (
    !index ||
    reference.format !== 'health-intake-report-source-index-v1' ||
    reference.confirmationCount !== view.childCount(workflow, 'reportSourceConfirmations') ||
    reference.confirmationsRecordAddress !==
      view.address(view.child(workflow, 'reportSourceConfirmations')!) ||
    canonicalLiteral(checkedJson(index, 'meta')) !== canonicalLiteral(reference)
  )
    throw Error('Source confirmation receipt index is incomplete');
  const address = index.get('o:' + schemaKey(operationId));
  if (typeof address !== 'string') throw Error('Report source confirmation was not retained');
  const record = view.resolve(address),
    header = readReportSourceConfirmationHeader(view, record),
    selected = counts(view, record);
  if (record.kind !== 'reportSourceConfirmation' || header.operationId !== operationId)
    throw Error('Source confirmation receipt index mismatch');
  const scopeToken = text(view, record, 'scopeToken', true),
    queueView = text(view, record, 'view', true);
  if (queueView !== undefined && !['active', 'deferred', 'all'].includes(queueView))
    throw Error('Invalid source receipt view');
  return {
    ...header,
    ...(scopeToken ? { scopeToken } : {}),
    ...(queueView ? { view: queueView as 'active' | 'deferred' | 'all' } : {}),
    format: 'health-intake-report-source-receipt-v2',
    memberCount: selected.memberCount,
    coverageEntryCount: selected.coverageCount,
    extensionCount: selected.extensionCount,
    evidence: { intakeId: source.id, address, logicalPin: JSON.stringify(view.logical) },
  };
}
