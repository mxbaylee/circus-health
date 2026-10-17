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
import { reportSnapshotInlineTextFits } from './intake-report-snapshot-catalog.ts';
import { INTAKE_TREE_KEY_BYTES } from './intake-state-tree.ts';

type Occurrence = IntakeReportGroupMember['occurrences'][number];
type MemberInput = { candidateId: string; candidateVersionId: string; section?: unknown };
type IncludeOptions = {
  retainDuplicate?: boolean;
  canonicalPrefix?: Iterable<string>;
  canonicalSuffix?: Iterable<string>;
  canonicalSection?: Iterable<string>;
};
type OccurrenceIdentity = { recordId: string | null; proposalId: string | null };
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
  /** The optional first member and occurrence were included by the eager fork. */
  readonly seededFirstOccurrence: boolean;
  reader(): ReportMemberSnapshotReader;
  /** New discovery. Legacy import can retain duplicate identities and exact extra fields around occurrences. */
  include(member: MemberInput, options?: IncludeOptions): Promise<ReportSourceMemberHeader>;
  /** Ordinary new member and its first bounded occurrence share one checkpoint. */
  includeOrdinaryOccurrence(
    member: MemberInput,
    value: Occurrence,
  ): Promise<ReportSourceMemberHeader>;
  /** Ordered discoveries, with bounded checkpoints and barriers for existing or streamed members. */
  includeOrdinaryOccurrences(
    items: Iterable<{ member: MemberInput; value: Occurrence }>,
  ): Promise<void>;
  occurrence(
    member: ReportSourceMemberHeader,
    value: Occurrence,
    options?: { retainDuplicate?: boolean },
  ): Promise<ReportSourceMemberHeader>;
  appendCanonicalOccurrence(
    member: ReportSourceMemberHeader,
    pieces: Iterable<string>,
    sourceIdentity: string,
    identity: OccurrenceIdentity,
  ): Promise<ReportSourceMemberHeader>;
  finish(): Promise<IntakeReportMembersReference>;
}
export async function createReportMemberSnapshot(
  catalog: ReportSnapshotCatalog,
  snapshotId: string,
  previous?: IntakeReportMembersReference,
  first?: { member: MemberInput; value: Occurrence },
): Promise<ReportMemberSnapshotWriter> {
  if (previous) openReportMemberSnapshot(catalog, previous);
  const planMember = (
    member: MemberInput,
    count: Counts,
    old: ReportSourceMemberHeader | undefined,
    options: IncludeOptions,
  ) => {
    const ordinal = count.memberCount,
      key = schemaKey(member.candidateId, member.candidateVersionId, ordinal);
    const item: ReportSourceMemberHeader = {
      key,
      ordinal,
      candidateId: member.candidateId,
      candidateVersionId: member.candidateVersionId,
      occurrenceCount: 0,
      sectionPresent: Object.hasOwn(member, 'section'),
    };
    const prefixText =
        '{"candidateId":' +
        canonicalLiteral(member.candidateId) +
        ',"candidateVersionId":' +
        canonicalLiteral(member.candidateVersionId) +
        ',"occurrences":',
      suffixText =
        (item.sectionPresent ? ',"section":' + canonicalLiteral(member.section) : '') + '}',
      sectionText = canonicalLiteral(member.section || null);
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
    const inline =
      options.canonicalPrefix === undefined &&
      options.canonicalSuffix === undefined &&
      options.canonicalSection === undefined &&
      [prefixText, suffixText, sectionText].every(reportSnapshotInlineTextFits);
    if (inline)
      entries.push(
        { key: 'p:' + key, value: prefixText },
        { key: 's:' + key, value: suffixText },
        { key: 'section:' + key, value: sectionText },
      );
    return { item, entries, inline, prefixText, suffixText, sectionText };
  };
  const occurrenceEntries = (
    member: ReportSourceMemberHeader,
    key: string,
    sourceIdentity: string,
    identity: OccurrenceIdentity,
    total: Counts,
    inline?: string,
  ) => {
    const updated = { ...member, occurrenceCount: member.occurrenceCount + 1 };
    const entries = [
      ...(inline !== undefined
        ? [{ key: 'a:' + member.key + ':' + schemaOrdinal(member.occurrenceCount), value: inline }]
        : []),
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
    ];
    return { updated, entries };
  };
  const planOrdinaryOccurrence = (member: MemberInput, value: Occurrence, total: Counts) => {
    const planned = planMember(member, total, undefined, {});
    if (!planned.inline) return undefined;
    const raw = canonicalLiteral(value);
    if (!reportSnapshotInlineTextFits(raw)) return undefined;
    const appended = occurrenceEntries(
      planned.item,
      occurrenceHash(raw),
      sourceOccurrence(value),
      { recordId: value.recordId ?? null, proposalId: value.proposalId ?? null },
      { ...total, memberCount: total.memberCount + 1 },
      raw,
    );
    const entries = [...planned.entries, ...appended.entries];
    if (
      entries.length > 64 ||
      entries.some(
        (entry) =>
          Buffer.byteLength(entry.key) > INTAKE_TREE_KEY_BYTES ||
          !reportSnapshotInlineTextFits(entry.value),
      )
    )
      return undefined;
    return { entries, updated: appended.updated };
  };
  const emptyCounts = { memberCount: 0, occurrenceCount: 0 };
  if (first && !previous) catalog.assertCurrent();
  const plannedFirst =
    !previous && first ? planOrdinaryOccurrence(first.member, first.value, emptyCounts) : undefined;
  const baseEntries = [
    { key: '$members', value: FORMAT },
    { key: '$counts', value: JSON.stringify(emptyCounts) },
  ];
  const seededFirst =
    plannedFirst && baseEntries.length + plannedFirst.entries.length <= 63
      ? plannedFirst
      : undefined;
  if (first && !previous) catalog.assertCurrent();
  const store: ReportSnapshotMapWriter = await catalog.fork(
    previous?.snapshotId,
    previous ? undefined : [...baseEntries, ...(seededFirst?.entries ?? [])],
  );
  let closed = false,
    bulkActive = false,
    ordinaryOperations = 0;
  const idle = () => {
    if (bulkActive) throw Error('Report member batch is pending');
  };
  const publicOperation =
    <Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      idle();
      ordinaryOperations++;
      try {
        return await operation(...args);
      } finally {
        ordinaryOperations--;
      }
    };
  const publicRead = <Result>(operation: () => Result): Result => {
    idle();
    ordinaryOperations++;
    try {
      return operation();
    } finally {
      ordinaryOperations--;
    }
  };
  const active = () => {
    catalog.assertCurrent();
    if (closed) throw Error('Report snapshot is complete');
  };
  const reader = () => reportMemberSnapshotReader(store, snapshotId);
  const publicReader = () =>
    new Proxy(reader(), {
      get(target, key, receiver) {
        idle();
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          idle();
          const result: unknown = publicRead(() => Reflect.apply(value, target, args));
          if (result && typeof result === 'object' && Symbol.iterator in result) {
            return (function* () {
              const iterator = (result as Iterable<unknown>)[Symbol.iterator]();
              try {
                while (true) {
                  const next = publicRead(() => iterator.next());
                  if (next.done) return;
                  yield next.value;
                }
              } finally {
                publicRead(() => iterator.return?.());
              }
            })();
          }
          return result;
        };
      },
    });
  const appendCanonicalOccurrence = async (
    member: ReportSourceMemberHeader,
    pieces: Iterable<string>,
    sourceIdentity: string,
    identity: OccurrenceIdentity,
    inline?: string,
  ) => {
    active();
    checked(store, member);
    if (!/^[a-f0-9]{64}$/.test(sourceIdentity)) throw Error('Invalid occurrence source identity');
    const hash = createHash('sha256'),
      occurrenceKey = 'a:' + member.key + ':' + schemaOrdinal(member.occurrenceCount),
      inlineOccurrence = inline !== undefined && reportSnapshotInlineTextFits(inline);
    if (inlineOccurrence) hash.update(inline);
    else
      await store.putText(
        occurrenceKey,
        (function* () {
          for (const piece of pieces) {
            hash.update(piece);
            yield piece;
          }
        })(),
      );
    const planned = occurrenceEntries(
      member,
      hash.digest('hex'),
      sourceIdentity,
      identity,
      counts(store),
      inlineOccurrence ? inline : undefined,
    );
    await store.putMany(planned.entries);
    return planned.updated;
  };
  const include: ReportMemberSnapshotWriter['include'] = async (member, options = {}) => {
    active();
    const old = reader().member(member.candidateId, member.candidateVersionId);
    if (old && !options.retainDuplicate) return old;
    const planned = planMember(member, counts(store), old, options);
    if (!planned.inline) {
      await store.putText('p:' + planned.item.key, options.canonicalPrefix ?? [planned.prefixText]);
      await store.putText('s:' + planned.item.key, options.canonicalSuffix ?? [planned.suffixText]);
      await store.putText(
        'section:' + planned.item.key,
        options.canonicalSection ?? [planned.sectionText],
      );
    }
    await store.putMany(planned.entries);
    return planned.item;
  };
  const occurrence: ReportMemberSnapshotWriter['occurrence'] = async (
    member,
    value,
    options = {},
  ) => {
    active();
    const current = checked(store, member),
      raw = canonicalLiteral(value),
      entryKey = 'e:' + member.key + ':' + occurrenceHash(raw);
    if (text(store, entryKey) !== undefined && !options.retainDuplicate) return current;
    return appendCanonicalOccurrence(
      member,
      [raw],
      sourceOccurrence(value),
      {
        recordId: value.recordId ?? null,
        proposalId: value.proposalId ?? null,
      },
      raw,
    );
  };
  const includeOrdinaryOccurrence: ReportMemberSnapshotWriter['includeOrdinaryOccurrence'] = async (
    member,
    value,
  ) => {
    active();
    const old = reader().member(member.candidateId, member.candidateVersionId),
      total = counts(store);
    if (!old) {
      const planned = planOrdinaryOccurrence(member, value, total);
      if (planned) {
        active();
        await store.putMany(planned.entries);
        return planned.updated;
      }
    }
    return occurrence(await include(member), value);
  };
  const includeOrdinaryOccurrences: ReportMemberSnapshotWriter['includeOrdinaryOccurrences'] =
    async (items) => {
      idle();
      if (ordinaryOperations) throw Error('Report member operation is pending');
      bulkActive = true;
      try {
        active();
        let pending: { key: string; value: string }[] = [],
          total = counts(store);
        const identities = new Set<string>();
        const flush = async () => {
          if (!pending.length) return;
          active();
          await store.putMany(pending);
          const stored = counts(store);
          if (
            stored.memberCount !== total.memberCount ||
            stored.occurrenceCount !== total.occurrenceCount
          )
            throw Error('Report member batch count mismatch');
          pending = [];
          identities.clear();
          total = stored;
        };
        for (const { member, value } of items) {
          active();
          const identity = schemaKey(member.candidateId, member.candidateVersionId);
          const planned =
            !identities.has(identity) &&
            !reader().member(member.candidateId, member.candidateVersionId)
              ? planOrdinaryOccurrence(member, value, total)
              : undefined;
          if (!planned) {
            await flush();
            await includeOrdinaryOccurrence(member, value);
            total = counts(store);
            continue;
          }
          if (pending.length + planned.entries.length > 64) {
            await flush();
            // Keep the already serialized item; external inputs may change during the await.
          }
          pending.push(...planned.entries);
          identities.add(identity);
          total = {
            memberCount: total.memberCount + 1,
            occurrenceCount: total.occurrenceCount + 1,
          };
        }
        await flush();
      } finally {
        bulkActive = false;
      }
    };
  return {
    seededFirstOccurrence: Boolean(seededFirst),
    reader() {
      return publicRead(publicReader);
    },
    appendCanonicalOccurrence: publicOperation(appendCanonicalOccurrence),
    include: publicOperation(include),
    includeOrdinaryOccurrence: publicOperation(includeOrdinaryOccurrence),
    includeOrdinaryOccurrences,
    occurrence: publicOperation(occurrence),
    finish: publicOperation(async () => {
      active();
      const reference = reader().reference;
      await catalog.publish(snapshotId, store);
      closed = true;
      return reference;
    }),
  };
}
