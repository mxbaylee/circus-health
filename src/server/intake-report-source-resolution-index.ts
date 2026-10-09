import { finishClinicalReviewWork } from './clinical-review-work.ts';
/** Owned point indexes for complete source receipt resolution. No scratch result grants authority. */
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import type {
  ReportSnapshotCatalog,
  ReportSnapshotMapReader,
  ReportSnapshotMapWriter,
} from './intake-report-snapshot-catalog.ts';
import { schemaKey, schemaOrdinal } from './intake-envelope-schema.ts';
import { hashIntakeJsonScalar } from './intake-json-scalar.ts';
import {
  prepareIntakeJsonCanonical,
  intakeJsonCanonicalWorkObserver,
} from './intake-json-canonical.ts';
import type { Database } from './database.ts';
import type { ReportSourceMemberHeader } from './intake-collection-report-source.ts';
export type SourceMemberIdentity = Pick<
  ReportSourceMemberHeader,
  'candidateId' | 'candidateVersionId'
>;
export interface SourceResolutionScope extends SourceMemberIdentity {
  groupId: string;
}
export interface SourceOccurrenceQuery {
  proposalId: string | null | undefined;
  recordId: string;
  batchId?: string | null;
  locatorHash?: string;
}
export interface SourceCoverageTarget extends SourceResolutionScope {
  groupVersionId: string;
  contextId: string;
  id: string;
  extensionId?: string;
  extensionOrdinal: number;
  entryOrdinal: number;
}
export interface SourceExtensionTarget {
  id: string;
  groupVersionId: string;
  contextId: string;
  ordinal: number;
}
const memberKey = (m: SourceMemberIdentity) =>
  'm:' + schemaKey(m.candidateId, m.candidateVersionId);
const tagged = (value: unknown) => (value === undefined ? ['missing'] : ['value', value]);
export function sourceCoverageLookupKeys(
  scope: SourceResolutionScope & { groupVersionId: string },
  query: SourceOccurrenceQuery,
): { base: string; batch: string; locator: string; full: string } {
  const prefix = [
    scope.groupId,
    scope.groupVersionId,
    scope.candidateId,
    scope.candidateVersionId,
    tagged(query.proposalId),
    query.recordId,
  ];
  return {
    base: schemaKey(...prefix),
    batch: schemaKey(...prefix, 'batch', tagged(query.batchId)),
    locator: schemaKey(...prefix, 'locator', tagged(query.locatorHash)),
    full: schemaKey(
      ...prefix,
      'batch',
      tagged(query.batchId),
      'locator',
      tagged(query.locatorHash),
    ),
  };
}
const json = <T>(map: ReportSnapshotMapReader, key: string): T | undefined => {
  const value = map.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 65536)
    throw Error('Invalid source resolution index value');
  return JSON.parse(value) as T;
};
const required = (map: ReportSnapshotMapReader, name: string) => {
  const value = map.reference(name);
  if (!value) throw Error('Incomplete source resolution index');
  return value;
};
export async function createSourceResolutionIndex(
  catalog: ReportSnapshotCatalog,
  old?: ReportSnapshotMapReader,
) {
  const map = old ? await catalog.forkReference(old) : await catalog.fork(),
    members = old
      ? await catalog.forkReference(required(old, 'originalMembers'))
      : await catalog.fork(),
    coverage = old ? await catalog.forkReference(required(old, 'coverage')) : await catalog.fork(),
    scopes = old ? await catalog.forkReference(required(old, 'scopes')) : await catalog.fork(),
    newScopes = await catalog.fork();
  // Consecutive extensions share one private writer; attached roots remain immutable.
  let lastVersion: { key: string; writer: ReportSnapshotMapWriter } | undefined;
  const addScope = async (scope: SourceResolutionScope) => {
    const key = 's:' + schemaKey(scope.groupId, scope.candidateId, scope.candidateVersionId),
      value = JSON.stringify({
        groupId: scope.groupId,
        candidateId: scope.candidateId,
        candidateVersionId: scope.candidateVersionId,
      }),
      existing = scopes.get(key);
    if (existing !== undefined) {
      if (existing !== value) throw Error('Source resolution scope collision');
      return;
    }
    await scopes.put(key, value);
    await newScopes.put(key, value);
  };
  return {
    map,
    newScopes,
    async originalMember(groupId: string, member: SourceMemberIdentity) {
      const key = memberKey(member);
      if (members.get(key) === undefined) await members.put(key, '1');
      await addScope({ groupId, ...member });
    },
    async memberScope(groupId: string, member: SourceMemberIdentity) {
      await addScope({ groupId, ...member });
    },
    async extension(target: SourceExtensionTarget, lookup: ReportSnapshotMapWriter) {
      const key = 'v:' + schemaKey(target.groupVersionId);
      let version = lastVersion?.key === key ? lastVersion.writer : undefined;
      if (!version) {
        const previous = map.reference(key);
        version = previous ? await catalog.forkReference(previous) : await catalog.fork();
        lastVersion = { key, writer: version };
      }
      await version.putMany(
        [{ key: 'e:' + schemaOrdinal(target.ordinal), value: JSON.stringify(target) }],
        [{ key: 'm:' + schemaOrdinal(target.ordinal), child: lookup }],
      );
      await map.attach('v:' + schemaKey(target.groupVersionId), version);
    },
    async coverage(input: SourceCoverageTarget, query: SourceOccurrenceQuery) {
      const {
        groupId,
        groupVersionId,
        contextId,
        candidateId,
        candidateVersionId,
        id,
        extensionOrdinal,
        entryOrdinal,
        extensionId,
      } = input;
      const target: SourceCoverageTarget = {
        groupId,
        groupVersionId,
        contextId,
        candidateId,
        candidateVersionId,
        id,
        extensionOrdinal,
        entryOrdinal,
        ...(extensionId ? { extensionId } : {}),
      };
      const keys = sourceCoverageLookupKeys(target, query),
        prefix = target.extensionOrdinal < 0 ? 'o:' : 'e:';
      for (const key of Object.values(keys)) {
        const old = json<SourceCoverageTarget>(coverage, prefix + key);
        if (
          old &&
          (old.extensionOrdinal > target.extensionOrdinal ||
            (old.extensionOrdinal === target.extensionOrdinal &&
              old.entryOrdinal <= target.entryOrdinal))
        )
          continue;
        await coverage.put(prefix + key, JSON.stringify(target));
      }
      await addScope(target);
    },
    async finish() {
      await map.putMany(
        [{ key: 'format', value: 'health-intake-source-resolution-index-v1' }],
        [
          { key: 'originalMembers', child: members },
          { key: 'coverage', child: coverage },
          { key: 'scopes', child: scopes },
        ],
      );
      return map;
    },
  };
}
export type SourceResolutionIndexBuilder = Awaited<ReturnType<typeof createSourceResolutionIndex>>;
export function readSourceResolutionIndex(map: ReportSnapshotMapReader) {
  if (map.get('format') !== 'health-intake-source-resolution-index-v1')
    throw Error('Incomplete source resolution policy');
  const members = required(map, 'originalMembers'),
    coverage = required(map, 'coverage');
  return {
    originalMember: (member: SourceMemberIdentity) => members.get(memberKey(member)) === '1',
    extension(versionId: string, member: SourceMemberIdentity) {
      return finishClinicalReviewWork(this.extensionWork(versionId, member));
    },
    *extensionWork(
      versionId: string,
      member: SourceMemberIdentity,
    ): Generator<void, SourceExtensionTarget | undefined, void> {
      const version = map.reference('v:' + schemaKey(versionId));
      if (!version) return undefined;
      let before = 'f';
      do {
        yield;
        const row = version.preceding(before);
        if (!row || !row.key.startsWith('e:')) return undefined;
        before = row.key;
        const result = json<SourceExtensionTarget>(version, row.key);
        if (
          !result ||
          result.groupVersionId !== versionId ||
          row.key !== 'e:' + schemaOrdinal(result.ordinal)
        )
          throw Error('Source resolution version mismatch');
        if (required(version, 'm:' + schemaOrdinal(result.ordinal)).get(memberKey(member)) === '1')
          return result;
      } while (true);
    },
    coverage(
      scope: SourceResolutionScope & { groupVersionId: string },
      query: SourceOccurrenceQuery,
    ) {
      const keys = sourceCoverageLookupKeys(scope, query),
        key =
          query.locatorHash !== undefined
            ? query.batchId !== undefined
              ? keys.full
              : keys.locator
            : query.batchId !== undefined
              ? keys.batch
              : keys.base;
      return {
        original: json<SourceCoverageTarget>(coverage, 'o:' + key),
        extension: json<SourceCoverageTarget>(coverage, 'e:' + key),
      };
    },
  };
}
const value = (view: IntakeCollectionEnvelopeReader, row: IntakeEnvelopeRecord, name: string) => {
  const item = view.field(row, name, { bytes: 65536 });
  if (item.kind === 'fragmented')
    throw Error('Source resolution requires selected scalar identity: ' + name);
  return item.kind === 'value' ? item.value : undefined;
};
const text = (view: IntakeCollectionEnvelopeReader, row: IntakeEnvelopeRecord, name: string) => {
  const selected = value(view, row, name);
  if (typeof selected !== 'string') throw Error('Invalid source resolution identity: ' + name);
  return selected;
};
export function selectedSourceCoverage(
  view: IntakeCollectionEnvelopeReader,
  entry: IntakeEnvelopeRecord,
  extensionOrdinal: number,
  entryOrdinal: number,
  extensionId?: string,
  db?: Database,
) {
  const ref = view.child(entry, 'sourceRef'),
    occurrence = view.child(entry, 'occurrence');
  if (!ref || !occurrence) throw Error('Source resolution needs selected coverage records');
  const proposalId = value(view, occurrence, 'proposalId'),
    batchId = value(view, occurrence, 'batchId');
  if (
    (proposalId !== undefined && proposalId !== null && typeof proposalId !== 'string') ||
    (batchId !== undefined && batchId !== null && typeof batchId !== 'string')
  )
    throw Error('Invalid source occurrence identity');
  const target: SourceCoverageTarget = {
    groupId: text(view, ref, 'groupId'),
    groupVersionId: text(view, ref, 'groupVersionId'),
    contextId: text(view, ref, 'contextId'),
    candidateId: text(view, entry, 'candidateId'),
    candidateVersionId: text(view, entry, 'candidateVersionId'),
    id: text(view, entry, 'id'),
    extensionOrdinal,
    entryOrdinal,
    ...(extensionId ? { extensionId } : {}),
  };
  const locatorHash = view.has(occurrence, 'locator')
    ? hashSourceScalar(db, view.fieldChunks(occurrence, 'locator')).hash
    : undefined;
  return {
    target,
    query: { proposalId, recordId: text(view, occurrence, 'recordId'), batchId, locatorHash },
  };
}
export async function canonicalSourceOccurrenceQuery(
  db: Database | undefined,
  pieces: Iterable<string>,
  assertRunning: () => void,
): Promise<SourceOccurrenceQuery> {
  const parsed = await prepareIntakeJsonCanonical(pieces, {
    assertRunning,
    onWork: db ? intakeJsonCanonicalWorkObserver(db, 'warm') : undefined,
  });
  try {
    if (parsed.kind(parsed.root) !== 'object') throw Error('Invalid source occurrence');
    const small = (name: string) => {
      const child = parsed.field(parsed.root, name);
      if (!child) return undefined;
      let result = '';
      for (const piece of parsed.pieces(child)) {
        if (Buffer.byteLength(result) + Buffer.byteLength(piece) > 65536)
          throw Error('Source occurrence identity exceeds supported grammar');
        result += piece;
      }
      return JSON.parse(result) as unknown;
    };
    const proposalId = small('proposalId'),
      recordId = small('recordId'),
      batchId = small('batchId'),
      locator = parsed.field(parsed.root, 'locator');
    if (
      typeof recordId !== 'string' ||
      (proposalId !== undefined && proposalId !== null && typeof proposalId !== 'string') ||
      (batchId !== undefined && batchId !== null && typeof batchId !== 'string')
    )
      throw Error('Invalid source occurrence identity');
    return {
      proposalId,
      recordId,
      batchId,
      locatorHash: locator ? hashSourceScalar(db, parsed.pieces(locator)).hash : undefined,
    };
  } finally {
    parsed.close();
  }
}
export function hashSourceScalar(
  db: Database | undefined,
  pieces: Iterable<string>,
  leading: readonly (string | null)[] = [],
  onStringUnit?: (unit: string) => void,
) {
  const result = hashIntakeJsonScalar(pieces, leading, onStringUnit);
  if (db)
    withIntakeWork(db, 'warm', () => {
      recordIntakeWork('hashCalls');
      recordIntakeWork('hashedBytes', result.bytes);
    });
  return result;
}
export function sourceLocatorHash(locator: string, db?: Database) {
  function* pieces() {
    yield '"';
    for (let at = 0; at < locator.length;) {
      let end = Math.min(at + 2048, locator.length);
      if (end < locator.length && /^[\uD800-\uDBFF]$/.test(locator[end - 1]!)) end--;
      yield JSON.stringify(locator.slice(at, end)).slice(1, -1);
      at = end;
    }
    yield '"';
  }
  return hashSourceScalar(db, pieces()).hash;
}
