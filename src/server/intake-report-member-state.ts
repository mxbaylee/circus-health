/** Report members retain discovery order while versions share immutable tree pages. */
import { canonicalLiteral } from './intake-format.ts';
import { createHash } from 'node:crypto';
import { schemaKey, schemaOrdinal } from './intake-envelope-schema.ts';
import type { IntakeReportGroupMember } from '../shared/intake.ts';
import type { IntakeReportMembersReference } from '../shared/intake-report-version.ts';
import type {
  ReportSourceMemberHeader,
  ReportSourceMemberSnapshot,
} from './intake-collection-report-source.ts';
import type {
  ReportSnapshotCatalog,
  ReportSnapshotMapReader,
  ReportSnapshotMapWriter,
} from './intake-report-snapshot-catalog.ts';

type Occurrence = IntakeReportGroupMember['occurrences'][number];
const occurrenceHash = (raw: string) => createHash('sha256').update(raw).digest('hex');
interface Counts {
  memberCount: number;
  occurrenceCount: number;
}
const FORMAT = 'health-intake-report-members-map-v1';
const text = (store: ReportSnapshotMapReader, key: string): string | undefined => {
  const value = store.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw Error('Fragmented report member header');
  return value;
};
const counts = (store: ReportSnapshotMapReader): Counts => {
  if (text(store, '$members') !== FORMAT) throw Error('Invalid report member snapshot');
  const value = JSON.parse(text(store, '$counts') ?? 'null') as Counts;
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'memberCount,occurrenceCount' ||
    !Number.isSafeInteger(value.memberCount) ||
    value.memberCount < 0 ||
    !Number.isSafeInteger(value.occurrenceCount) ||
    value.occurrenceCount < 0
  )
    throw Error('Invalid report member counts');
  return value;
};
const sourceOccurrence = (value: Occurrence) =>
  schemaKey(value.proposalId, value.recordId, value.batchId, value.locator);
const header = (raw: string): ReportSourceMemberHeader => {
  const value = JSON.parse(raw) as ReportSourceMemberHeader;
  if (
    !value ||
    typeof value.key !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.key) ||
    typeof value.candidateId !== 'string' ||
    typeof value.candidateVersionId !== 'string' ||
    !Number.isSafeInteger(value.ordinal) ||
    value.ordinal < 0 ||
    !Number.isSafeInteger(value.occurrenceCount) ||
    value.occurrenceCount < 0 ||
    typeof value.sectionPresent !== 'boolean'
  )
    throw Error('Invalid report member header');
  return value;
};
function checked(
  store: ReportSnapshotMapReader,
  value: ReportSourceMemberHeader,
): ReportSourceMemberHeader {
  const raw = text(store, 'm:' + value.key);
  if (!raw) throw Error('Foreign report member');
  const current = header(raw);
  if (JSON.stringify(current) !== JSON.stringify(value)) throw Error('Stale report member header');
  return current;
}
function budget(options: { items: number; bytes: number }) {
  if (
    !Number.isSafeInteger(options.items) ||
    options.items < 1 ||
    options.items > 100 ||
    !Number.isSafeInteger(options.bytes) ||
    options.bytes < 1 ||
    options.bytes > 256 * 1024
  )
    throw Error('Invalid report member page budget');
}
export interface ReportMemberSnapshotReader extends ReportSourceMemberSnapshot {
  readonly reference: IntakeReportMembersReference;
  memberAt(ordinal: number): ReportSourceMemberHeader | undefined;
  hasSourceOccurrence(member: ReportSourceMemberHeader, occurrence: Occurrence): boolean;
  occurrenceChunks(member: ReportSourceMemberHeader, ordinal: number): Iterable<string>;
  occurrenceRecordId(member: ReportSourceMemberHeader, ordinal: number): string | null;
  occurrenceDescriptors(
    member: ReportSourceMemberHeader,
    options: { after?: string; items: number; bytes: number },
  ): { occurrences: ReportMemberOccurrence[]; complete: boolean; after: string | null };
  canonicalOccurrence(occurrence: ReportMemberOccurrence): Iterable<string>;
  hasSourceOccurrenceIdentity(member: ReportSourceMemberHeader, identity: string): boolean;
  hasAnySourceOccurrenceIdentity(
    candidateId: string,
    candidateVersionId: string,
    identity: string,
  ): boolean;
  canonicalMembers(): Iterable<string>;
  /** Exact canonical section || null, independent of cumulative occurrences. */
  canonicalSection(member: ReportSourceMemberHeader): Iterable<string>;
  assertCurrent(): void;
}
declare const occurrenceBrand: unique symbol;
export interface ReportMemberOccurrence {
  readonly [occurrenceBrand]: true;
  readonly ordinal: number;
  readonly key: string;
  readonly sourceIdentity: string;
  readonly recordId: string | null;
  readonly proposalId: string | null;
}
export function reportMemberSnapshotReader(
  store: ReportSnapshotMapReader,
  snapshotId: string,
): ReportMemberSnapshotReader {
  const total = counts(store),
    reference: IntakeReportMembersReference = {
      format: 'health-intake-report-members-v1',
      snapshotId,
      ...total,
    };
  const descriptors = new WeakMap<
    ReportMemberOccurrence,
    { member: ReportSourceMemberHeader; ordinal: number }
  >();
  const result: ReportMemberSnapshotReader = {
    reference,
    assertCurrent: () => store.assertCurrent(),
    memberAt(ordinal) {
      if (!Number.isSafeInteger(ordinal) || ordinal < 0)
        throw Error('Invalid report member ordinal');
      if (ordinal >= total.memberCount) return undefined;
      const key = text(store, 'o:' + schemaOrdinal(ordinal)),
        raw = key && text(store, 'm:' + key);
      if (!raw) throw Error('Missing ordered report member');
      const item = header(raw);
      if (item.ordinal !== ordinal) throw Error('Mismatched report member order');
      return item;
    },
    member(candidateId, candidateVersionId) {
      const key = text(store, 'k:' + schemaKey(candidateId, candidateVersionId));
      if (!key) return undefined;
      const raw = text(store, 'm:' + key);
      if (!raw) throw Error('Missing indexed report member');
      const item = header(raw);
      if (item.candidateId !== candidateId || item.candidateVersionId !== candidateVersionId)
        throw Error('Mismatched report member identity');
      return item;
    },
    members(options) {
      budget(options);
      const start = options.after === undefined ? 0 : Number(options.after) + 1;
      if (!Number.isSafeInteger(start) || start < 0 || start > total.memberCount)
        throw Error('Invalid report member cursor');
      const members: ReportSourceMemberHeader[] = [];
      let bytes = 0,
        index = start;
      for (; index < total.memberCount && members.length < options.items; index++) {
        const key = text(store, 'o:' + schemaOrdinal(index)),
          raw = key && text(store, 'm:' + key);
        if (!raw) throw Error('Missing ordered report member');
        const item = header(raw);
        if (item.ordinal !== index) throw Error('Mismatched report member order');
        const size = Buffer.byteLength(raw);
        if (bytes + size > options.bytes) break;
        members.push(item);
        bytes += size;
      }
      if (index < total.memberCount && !members.length)
        throw Error('Report member header requires fragment access');
      return {
        members,
        complete: index === total.memberCount,
        after: index === total.memberCount ? null : String(index - 1),
      };
    },
    occurrences(member, options) {
      budget(options);
      const current = checked(store, member),
        start = options.after === undefined ? 0 : Number(options.after) + 1;
      if (!Number.isSafeInteger(start) || start < 0 || start > current.occurrenceCount)
        throw Error('Invalid occurrence cursor');
      const occurrences: Occurrence[] = [];
      let bytes = 0,
        index = start;
      for (; index < current.occurrenceCount && occurrences.length < options.items; index++) {
        let raw = '';
        for (const piece of result.occurrenceChunks(current, index)) {
          if (bytes + Buffer.byteLength(raw) + Buffer.byteLength(piece) > options.bytes) {
            raw = '';
            break;
          }
          raw += piece;
        }
        if (!raw) break;
        bytes += Buffer.byteLength(raw);
        occurrences.push(JSON.parse(raw) as Occurrence);
      }
      if (index < current.occurrenceCount && !occurrences.length)
        throw Error('Report occurrence requires fragment access');
      return {
        occurrences,
        complete: index === current.occurrenceCount,
        after: index === current.occurrenceCount ? null : String(index - 1),
      };
    },
    hasOccurrence(member, occurrence) {
      checked(store, member);
      return (
        text(store, 'e:' + member.key + ':' + occurrenceHash(canonicalLiteral(occurrence))) !==
        undefined
      );
    },
    hasSourceOccurrence(member, occurrence) {
      checked(store, member);
      return text(store, 'v:' + member.key + ':' + sourceOccurrence(occurrence)) !== undefined;
    },
    hasSourceOccurrenceIdentity(member, identity) {
      checked(store, member);
      if (!/^[a-f0-9]{64}$/.test(identity)) throw Error('Invalid source occurrence identity');
      return text(store, 'v:' + member.key + ':' + identity) !== undefined;
    },
    hasAnySourceOccurrenceIdentity(candidateId, candidateVersionId, identity) {
      if (!/^[a-f0-9]{64}$/.test(identity)) throw Error('Invalid source occurrence identity');
      return (
        text(store, 'vu:' + schemaKey(candidateId, candidateVersionId) + ':' + identity) !==
        undefined
      );
    },
    occurrenceRecordId(member, ordinal) {
      checked(store, member);
      if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= member.occurrenceCount)
        throw Error('Invalid occurrence ordinal');
      const raw = text(store, 'q:' + member.key + ':' + schemaOrdinal(ordinal));
      if (!raw) throw Error('Missing occurrence descriptor');
      const value = JSON.parse(raw) as { recordId?: unknown };
      if (
        !Object.hasOwn(value, 'recordId') ||
        (value.recordId !== null && typeof value.recordId !== 'string')
      )
        throw Error('Occurrence identity descriptor requires complete preparation');
      return value.recordId as string | null;
    },
    occurrenceDescriptors(member, options) {
      budget(options);
      checked(store, member);
      let ordinal = options.after === undefined ? 0 : Number(options.after) + 1;
      if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > member.occurrenceCount)
        throw Error('Invalid occurrence cursor');
      const occurrences: ReportMemberOccurrence[] = [];
      let bytes = 0;
      for (; ordinal < member.occurrenceCount && occurrences.length < options.items; ordinal++) {
        const raw = text(store, 'q:' + member.key + ':' + schemaOrdinal(ordinal));
        if (!raw) throw Error('Missing occurrence descriptor');
        const value = JSON.parse(raw) as {
          key: string;
          sourceIdentity: string;
          recordId: string | null;
          proposalId: string | null;
        };
        if (
          !Object.hasOwn(value, 'recordId') ||
          !Object.hasOwn(value, 'proposalId') ||
          ![value.recordId, value.proposalId].every((id) => id === null || typeof id === 'string')
        )
          throw Error('Occurrence identity descriptor requires complete preparation');
        if (!/^[a-f0-9]{64}$/.test(value.key) || !/^[a-f0-9]{64}$/.test(value.sourceIdentity))
          throw Error('Invalid occurrence descriptor');
        const item = Object.freeze({ ordinal, ...value }) as ReportMemberOccurrence;
        const size = Buffer.byteLength(JSON.stringify(item));
        if (bytes + size > options.bytes) break;
        bytes += size;
        descriptors.set(item, { member, ordinal });
        occurrences.push(item);
      }
      if (ordinal < member.occurrenceCount && !occurrences.length)
        throw Error('Occurrence descriptor page too small');
      return {
        occurrences,
        complete: ordinal === member.occurrenceCount,
        after: ordinal === member.occurrenceCount ? null : String(ordinal - 1),
      };
    },
    canonicalOccurrence(value) {
      const item = descriptors.get(value);
      if (!item) throw Error('Foreign report occurrence descriptor');
      return result.occurrenceChunks(item.member, item.ordinal);
    },
    occurrenceChunks(member, ordinal) {
      checked(store, member);
      if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= member.occurrenceCount)
        throw Error('Invalid report occurrence ordinal');
      return store.chunks('a:' + member.key + ':' + schemaOrdinal(ordinal));
    },
    *canonicalMember(member) {
      checked(store, member);
      yield* store.chunks('p:' + member.key);
      yield '[';
      for (let i = 0; i < member.occurrenceCount; i++) {
        if (i) yield ',';
        yield* result.occurrenceChunks(member, i);
      }
      yield ']';
      yield* store.chunks('s:' + member.key);
    },
    canonicalSection(member) {
      checked(store, member);
      return store.chunks('section:' + member.key);
    },
    *canonicalMembers() {
      yield '[';
      let after: string | undefined,
        emitted = 0;
      do {
        const page = result.members({ after, items: 64, bytes: 65536 });
        for (const member of page.members) {
          if (emitted++) yield ',';
          yield* result.canonicalMember(member);
        }
        if (page.complete) break;
        after = page.after!;
      } while (true);
      yield ']';
    },
  };
  return result;
}
export function openReportMemberSnapshot(
  catalog: ReportSnapshotCatalog,
  reference: IntakeReportMembersReference,
): ReportMemberSnapshotReader {
  if (reference.format !== 'health-intake-report-members-v1')
    throw Error('Invalid report member reference');
  const store = catalog.open(reference.snapshotId);
  if (!store) throw Error('Missing selected report member snapshot');
  const result = reportMemberSnapshotReader(store, reference.snapshotId);
  if (
    result.reference.memberCount !== reference.memberCount ||
    result.reference.occurrenceCount !== reference.occurrenceCount
  )
    throw Error('Report member reference count mismatch');
  return result;
}
export interface ReportMemberSnapshotWriter {
  reader(): ReportMemberSnapshotReader;
  /** New discovery. Legacy import can retain duplicate identities and exact extra fields around occurrences. */
  include(
    member: { candidateId: string; candidateVersionId: string; section?: unknown },
    options?: {
      retainDuplicate?: boolean;
      canonicalPrefix?: Iterable<string>;
      canonicalSuffix?: Iterable<string>;
      canonicalSection?: Iterable<string>;
    },
  ): Promise<ReportSourceMemberHeader>;
  occurrence(
    member: ReportSourceMemberHeader,
    value: Occurrence,
    options?: { retainDuplicate?: boolean },
  ): Promise<ReportSourceMemberHeader>;
  appendCanonicalOccurrence(
    member: ReportSourceMemberHeader,
    pieces: Iterable<string>,
    sourceIdentity: string,
    identity: { recordId: string | null; proposalId: string | null },
  ): Promise<ReportSourceMemberHeader>;
  finish(): Promise<IntakeReportMembersReference>;
}
export async function createReportMemberSnapshot(
  catalog: ReportSnapshotCatalog,
  snapshotId: string,
  previous?: IntakeReportMembersReference,
): Promise<ReportMemberSnapshotWriter> {
  if (previous) openReportMemberSnapshot(catalog, previous);
  const store: ReportSnapshotMapWriter = await catalog.fork(previous?.snapshotId);
  if (!previous)
    await store.putMany([
      { key: '$members', value: FORMAT },
      { key: '$counts', value: JSON.stringify({ memberCount: 0, occurrenceCount: 0 }) },
    ]);
  let closed = false;
  const active = () => {
    catalog.assertCurrent();
    if (closed) throw Error('Report snapshot is complete');
  };
  const reader = () => reportMemberSnapshotReader(store, snapshotId);
  const appendCanonicalOccurrence = async (
    member: ReportSourceMemberHeader,
    pieces: Iterable<string>,
    sourceIdentity: string,
    identity: { recordId: string | null; proposalId: string | null },
  ) => {
    active();
    checked(store, member);
    if (!/^[a-f0-9]{64}$/.test(sourceIdentity)) throw Error('Invalid occurrence source identity');
    const hash = createHash('sha256');
    await store.putText(
      'a:' + member.key + ':' + schemaOrdinal(member.occurrenceCount),
      (function* () {
        for (const piece of pieces) {
          hash.update(piece);
          yield piece;
        }
      })(),
    );
    const key = hash.digest('hex'),
      updated = { ...member, occurrenceCount: member.occurrenceCount + 1 },
      total = counts(store);
    await store.putMany([
      { key: 'e:' + member.key + ':' + key, value: String(member.occurrenceCount) },
      { key: 'v:' + member.key + ':' + sourceIdentity, value: String(member.occurrenceCount) },
      {
        key:
          'vu:' + schemaKey(member.candidateId, member.candidateVersionId) + ':' + sourceIdentity,
        value: '1',
      },
      {
        key: 'q:' + member.key + ':' + schemaOrdinal(member.occurrenceCount),
        value: JSON.stringify({
          key,
          sourceIdentity,
          recordId: identity.recordId,
          proposalId: identity.proposalId,
        }),
      },
      { key: 'm:' + member.key, value: JSON.stringify(updated) },
      {
        key: '$counts',
        value: JSON.stringify({ ...total, occurrenceCount: total.occurrenceCount + 1 }),
      },
    ]);
    return updated;
  };
  return {
    reader,
    appendCanonicalOccurrence,
    async include(member, options = {}) {
      active();
      const old = reader().member(member.candidateId, member.candidateVersionId);
      if (old && !options.retainDuplicate) return old;
      const count = counts(store),
        ordinal = count.memberCount,
        key = schemaKey(member.candidateId, member.candidateVersionId, ordinal);
      const item: ReportSourceMemberHeader = {
        key,
        ordinal,
        candidateId: member.candidateId,
        candidateVersionId: member.candidateVersionId,
        occurrenceCount: 0,
        sectionPresent: Object.hasOwn(member, 'section'),
      };
      const prefix = options.canonicalPrefix ?? [
        '{"candidateId":' +
          canonicalLiteral(member.candidateId) +
          ',"candidateVersionId":' +
          canonicalLiteral(member.candidateVersionId) +
          ',"occurrences":',
      ];
      const suffix = options.canonicalSuffix ?? [
        (item.sectionPresent ? ',"section":' + canonicalLiteral(member.section) : '') + '}',
      ];
      await store.putText('p:' + key, prefix);
      await store.putText('s:' + key, suffix);
      await store.putText(
        'section:' + key,
        options.canonicalSection ?? [canonicalLiteral(member.section || null)],
      );
      const entries = [
        { key: 'm:' + key, value: JSON.stringify(item) },
        { key: 'o:' + schemaOrdinal(ordinal), value: key },
        { key: '$counts', value: JSON.stringify({ ...count, memberCount: ordinal + 1 }) },
      ];
      if (!old)
        entries.push({
          key: 'k:' + schemaKey(member.candidateId, member.candidateVersionId),
          value: key,
        });
      await store.putMany(entries);
      return item;
    },
    async occurrence(member, value, options = {}) {
      active();
      const current = checked(store, member),
        raw = canonicalLiteral(value),
        entryKey = 'e:' + member.key + ':' + occurrenceHash(raw);
      if (text(store, entryKey) !== undefined && !options.retainDuplicate) return current;
      return appendCanonicalOccurrence(member, [raw], sourceOccurrence(value), {
        recordId: value.recordId ?? null,
        proposalId: value.proposalId ?? null,
      });
    },
    async finish() {
      active();
      const reference = reader().reference;
      await catalog.publish(snapshotId, store);
      closed = true;
      return reference;
    },
  };
}
