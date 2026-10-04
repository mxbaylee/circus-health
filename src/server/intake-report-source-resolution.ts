/** Complete selected source receipt resolution; read paths never build missing authority indexes. */
import type { Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import { openIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
import {
  createReportSnapshotCatalog,
  type ReportSnapshotMapReader,
} from './intake-report-snapshot-catalog.ts';
import {
  openReportSourceState,
  type ReportSourceStateReference,
} from './intake-report-source-state.ts';
import {
  readSourceResolutionIndex,
  sourceLocatorHash,
  hashSourceScalar,
  type SourceOccurrenceQuery,
  type SourceCoverageTarget,
  type SourceExtensionTarget,
} from './intake-report-source-resolution-index.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { schemaKey } from './intake-envelope-schema.ts';
import type { ReportSourceConfirmationHeader } from './intake-collection-report-source.ts';
export interface NativeSourceCoverage {
  groupVersionId: string;
  contextId: string;
  extensionId?: string;
  coverageEntryId?: string;
}
export interface ResolvedNativeReportSource {
  format: 'health-intake-report-source-resolution-v1';
  confirmation: ReportSourceConfirmationHeader;
  confirmationHash: string;
  coverage: NativeSourceCoverage;
}
declare const locatorBrand: unique symbol;
export interface NativeReportSourceLocator {
  readonly [locatorBrand]: true;
  readonly format: 'health-intake-report-source-locator-v1';
}
const locators = new WeakMap<
  NativeReportSourceLocator,
  { db: Database; intakeId: string; logical: string; hash: string }
>();
/** The caller supplies an address in this selected source's envelope, never an asserted digest. */
export function selectNativeReportSourceLocator(
  db: Database,
  source: IntakeEnvelopeSource,
  recordAddress: string,
): NativeReportSourceLocator {
  const view = openIntakeCollectionEnvelope(db, source),
    record = view.resolve(recordAddress);
  if (record.kind !== 'occurrence') throw Error('Source locator requires a selected occurrence');
  const selected = hashSourceScalar(db, view.fieldChunks(record, 'locator'));
  if (selected.kind !== 'string') throw Error('Source locator is not text');
  const result = Object.freeze({
    format: 'health-intake-report-source-locator-v1',
  }) as NativeReportSourceLocator;
  locators.set(result, {
    db,
    intakeId: source.id,
    logical: JSON.stringify(view.logical),
    hash: selected.hash,
  });
  return result;
}
export interface NativeReportSourceRequest {
  candidateId: string;
  candidateVersionId: string;
  references: () => Iterable<{ groupId: string; groupVersionId: string }>;
  occurrence?: {
    proposalId: string | null | undefined;
    recordId: string;
    batchId?: string | null;
    locator?: string | NativeReportSourceLocator;
  };
}
const required = (map: ReportSnapshotMapReader, name: string) => {
  const value = map.reference(name);
  if (!value) throw Error('Source resolution index is incomplete');
  return value;
};
const read = <T>(map: ReportSnapshotMapReader, key: string): T => {
  const value = map.get(key);
  if (typeof value !== 'string' || Buffer.byteLength(value) > 65536)
    throw Error('Source resolution selected value is unavailable');
  return JSON.parse(value) as T;
};
function resolveSelectedReportSource(
  db: Database,
  source: IntakeEnvelopeSource,
  input: NativeReportSourceRequest,
  providerId?: string,
): ResolvedNativeReportSource | null {
  const view = openIntakeCollectionEnvelope(db, source),
    intake = view.child(view.root(), 'intake'),
    workflow = intake && view.child(intake, 'workflow');
  if (!intake) throw Error('Source resolution intake is unavailable');
  if (view.has(intake, 'workflow') && !workflow)
    throw Error('Source resolution workflow is malformed');
  if (!workflow) return null;
  const confirmationRecords = view.child(workflow, 'reportSourceConfirmations');
  if (
    view.has(workflow, 'reportSourceConfirmations') &&
    (!confirmationRecords || view.info(confirmationRecords).shape !== 'array')
  )
    throw Error('Source resolution confirmations are malformed');
  const confirmationCount = view.childCount(workflow, 'reportSourceConfirmations');
  if (!confirmationCount) return null;
  const raw = view.field(workflow, 'reportSourceIndex', { bytes: 65536 });
  if (raw.kind !== 'value') throw Error('Source resolution index is pending');
  const ref = raw.value as {
      format: string;
      snapshotId: string;
      confirmationCount: number;
      confirmationsRecordAddress: string;
    },
    collection = view.child(workflow, 'reportSourceConfirmations');
  if (
    !ref ||
    ref.format !== 'health-intake-report-source-index-v1' ||
    ref.confirmationCount !== confirmationCount ||
    !collection ||
    ref.confirmationsRecordAddress !== view.address(collection)
  )
    throw Error('Source resolution index is stale');
  const catalog = createReportSnapshotCatalog(db, source),
    index = catalog.open(ref.snapshotId);
  if (!index || JSON.stringify(read(index, 'meta')) !== JSON.stringify(ref))
    throw Error('Source resolution index is unavailable');
  let occurrence: SourceOccurrenceQuery | undefined;
  if (input.occurrence) {
    const { locator, ...identity } = input.occurrence;
    let locatorHash: string | undefined;
    if (typeof locator === 'string') locatorHash = sourceLocatorHash(locator, db);
    else if (locator) {
      const selected = locators.get(locator);
      if (
        !selected ||
        selected.db !== db ||
        selected.intakeId !== source.id ||
        selected.logical !== JSON.stringify(view.logical)
      )
        throw Error('Source locator selection is stale or foreign');
      locatorHash = selected.hash;
    }
    occurrence = { ...identity, locatorHash };
  }
  const spool = disposableSqlite('circus-source-scope-');
  try {
    spool.db.exec(
      'CREATE TABLE refs(group_id TEXT NOT NULL,version_id TEXT NOT NULL,PRIMARY KEY(group_id,version_id)) WITHOUT ROWID',
    );
    const add = spool.db.prepare('INSERT OR IGNORE INTO refs VALUES(?,?)');
    for (const ref of input.references()) {
      catalog.assertCurrent();
      add.run(ref.groupId, ref.groupVersionId);
    }
    const refs = () =>
      spool.db.prepare('SELECT group_id,version_id FROM refs').iterate() as Iterable<{
        group_id: string;
        version_id: string;
      }>;
    const hasRef = (groupId: string, versionId: string) =>
      !!spool.db
        .prepare('SELECT 1 FROM refs WHERE group_id=? AND version_id=?')
        .get(groupId, versionId);
    const select = (
      header: ReportSourceConfirmationHeader,
      state: ReportSnapshotMapReader,
    ): NativeSourceCoverage | undefined => {
      const lookup = readSourceResolutionIndex(required(state, 'resolution'));
      if (header.basis === 'explicit_current_members' && occurrence) {
        let original: SourceCoverageTarget | undefined, extension: SourceCoverageTarget | undefined;
        for (const ref of refs()) {
          const selected = lookup.coverage(
            {
              groupId: ref.group_id,
              groupVersionId: ref.version_id,
              candidateId: input.candidateId,
              candidateVersionId: input.candidateVersionId,
            },
            occurrence,
          );
          if (
            selected.original &&
            (!original || selected.original.entryOrdinal < original.entryOrdinal)
          )
            original = selected.original;
          if (
            selected.extension &&
            (!extension ||
              selected.extension.extensionOrdinal > extension.extensionOrdinal ||
              (selected.extension.extensionOrdinal === extension.extensionOrdinal &&
                selected.extension.entryOrdinal < extension.entryOrdinal))
          )
            extension = selected.extension;
        }
        const found = original ?? extension;
        return found
          ? {
              groupVersionId: found.groupVersionId,
              contextId: found.contextId,
              ...(found.extensionId ? { extensionId: found.extensionId } : {}),
              coverageEntryId: found.id,
            }
          : undefined;
      }
      if (hasRef(header.groupId, header.groupVersionId) && lookup.originalMember(input))
        return { groupVersionId: header.groupVersionId, contextId: header.contextId };
      let extension: SourceExtensionTarget | undefined;
      for (const ref of spool.db
        .prepare('SELECT version_id FROM refs WHERE group_id=?')
        .iterate(header.groupId) as Iterable<{ version_id: string }>) {
        const found = lookup.extension(ref.version_id, input);
        if (found && (!extension || found.ordinal > extension.ordinal)) extension = found;
      }
      return extension
        ? {
            groupVersionId: extension.groupVersionId,
            contextId: extension.contextId,
            extensionId: extension.id,
          }
        : undefined;
    };
    let best: { ordinal: number; result: ResolvedNativeReportSource } | undefined;
    for (const group of spool.db
      .prepare('SELECT DISTINCT group_id FROM refs')
      .iterate() as Iterable<{ group_id: string }>) {
      const pointers = index.reference(
        'r:' + schemaKey(group.group_id, input.candidateId, input.candidateVersionId),
      );
      if (!pointers) continue;
      let before = 'd';
      do {
        catalog.assertCurrent();
        const pointer = pointers.preceding(before);
        if (!pointer || !pointer.key.startsWith('c:')) break;
        before = pointer.key;
        const ordinal = Number(pointer.key.slice(2));
        if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= confirmationCount)
          throw Error('Invalid source confirmation ordinal');
        if (best && ordinal <= best.ordinal) break;
        const indexed = read<{ address: string; state: ReportSourceStateReference }>(
            index,
            pointer.key,
          ),
          record = view.childAt(workflow, 'reportSourceConfirmations', ordinal);
        if (
          !record ||
          typeof pointer.value !== 'string' ||
          indexed.address !== pointer.value ||
          view.address(record) !== indexed.address
        )
          throw Error('Source resolution receipt binding mismatch');
        const confirmation = openReportSourceState(catalog, view, record, indexed.state),
          state = catalog.open(indexed.state.snapshotId)!,
          coverage = select(confirmation.header, state);
        if (
          !coverage ||
          (providerId !== undefined && confirmation.header.sourceProviderId !== providerId)
        )
          continue;
        const confirmationHash = state.get('confirmationHash');
        if (typeof confirmationHash !== 'string' || !/^[a-f0-9]{64}$/.test(confirmationHash))
          throw Error('Source confirmation hash is pending');
        best = {
          ordinal,
          result: {
            format: 'health-intake-report-source-resolution-v1',
            confirmation: confirmation.header,
            confirmationHash,
            coverage,
          },
        };
        break;
      } while (true);
    }
    catalog.assertCurrent();
    return best?.result ?? null;
  } finally {
    spool.close();
  }
}

export function resolveNativeReportSource(
  db: Database,
  source: IntakeEnvelopeSource,
  input: NativeReportSourceRequest,
): ResolvedNativeReportSource | null {
  return resolveSelectedReportSource(db, source, input);
}
/** Every prior explicit receipt remains an eligible authorization at its own retained prefix. */
export function hasHistoricalReportSourceProvider(
  db: Database,
  source: IntakeEnvelopeSource,
  input: NativeReportSourceRequest,
  providerId: string,
): boolean {
  return resolveSelectedReportSource(db, source, input, providerId) !== null;
}
