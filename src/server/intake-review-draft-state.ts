/** Immutable review history shares old entries across subsequent draft saves. */
import { randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import { HttpError } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { selectedEnvelopeStore } from './intake-collection-envelope.ts';
import { schemaKey, schemaOrdinal } from './intake-envelope-schema.ts';
import {
  createReportSnapshotCatalog,
  reportSnapshotInlineTextFits,
  type ReportSnapshotCatalog,
  type ReportSnapshotMapReader,
  type ReportSnapshotMapWriter,
} from './intake-report-snapshot-catalog.ts';
import { readIntakeReviewValue, IntakeReviewFragmentRequired } from './intake-review-collection.ts';
import type {
  IntakeReviewDraft,
  IntakeReviewDraftHistory,
  IntakeNativeReviewDraftHistory,
  IntakeIssueResolution,
  IntakeImportCorrection,
} from '../shared/intake.ts';
import { openIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
import { canonicalLiteral, parseLiteralJSON } from './intake-format.ts';
import {
  createLegacyDraftHistoryReference,
  checkLegacyDraftHistoryReference,
  readLegacyDraftHistoryPage,
} from './intake-draft-history-legacy.ts';
import { readLegacyDraftPolicyWitnesses } from './intake-draft-policy-index.ts';
import {
  bindReviewDraftResolutions,
  type ReviewDraftResolutionPolicy,
} from './intake-review-draft-selection.ts';
import { disposableSqlite } from './disposable-sqlite.ts';

const FORMAT = 'health-intake-review-draft-history-v1';
const PREFIX = { resolutions: 'r:', corrections: 'c:' } as const;
function scalar<T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): T | undefined {
  const value = view.field(record, name, { bytes: 65536 });
  if (value.kind === 'fragmented')
    throw new IntakeReviewFragmentRequired({
      format: 'health-intake-review-fragment-v1',
      logical: view.logical,
      address: view.address(record),
      field: name,
    });
  return value.kind === 'value' ? (value.value as T) : undefined;
}
function checked(
  catalog: ReportSnapshotCatalog,
  reference: IntakeReviewDraftHistory,
): ReportSnapshotMapReader {
  if (
    reference.format !== FORMAT ||
    !Number.isSafeInteger(reference.resolutions) ||
    reference.resolutions < 0 ||
    !Number.isSafeInteger(reference.corrections) ||
    reference.corrections < 0
  )
    throw Error('Invalid selected review history reference');
  const reader = catalog.open(reference.snapshotId);
  if (
    !reader ||
    reader.get('$format') !== FORMAT ||
    reader.get('$counts') !== JSON.stringify([reference.resolutions, reference.corrections]) ||
    reader.get('$source') !== JSON.stringify([reference.intakeId, reference.sourceHash])
  )
    throw Error('Selected review history is unavailable or incomplete');
  return reader;
}

/** Only the exact selected draft can attach correction history to acceptance. */
export function checkedAcceptedReviewDraftHistory(
  db: Database,
  source: IntakeEnvelopeSource,
  draft: IntakeReviewDraft | null | undefined,
  expected: {
    proposalId: string | null;
    recordId: string;
    candidateId: string;
    candidateVersionId: string;
  },
): IntakeReviewDraftHistory | undefined {
  if (!draft || (!draft.history && draft.format !== 'health-intake-review-draft-v2'))
    return undefined;
  const store = selectedEnvelopeStore(db, source),
    view = openIntakeCollectionEnvelope(db, source);
  const reference = draft.history;
  if (
    !reference ||
    reference.intakeId !== source.id ||
    reference.sourceHash !== store.source.sha256 ||
    Object.entries(expected).some(([key, value]) => draft[key as keyof typeof expected] !== value)
  )
    throw new HttpError(
      409,
      'REVIEW_HISTORY_CHANGED',
      'Refresh the exact review draft before accepting',
    );
  const selected = view.lookup('draft-record-version-last', [
    expected.proposalId || '',
    expected.recordId,
    expected.candidateVersionId,
  ]);
  if (
    !selected ||
    scalar(view, selected, 'id') !== draft.id ||
    scalar(view, selected, 'candidateId') !== expected.candidateId
  )
    throw new HttpError(409, 'REVIEW_HISTORY_CHANGED', 'The selected correction history changed');
  if (reference.format === 'health-intake-review-draft-legacy-history-v1') {
    const retained = checkLegacyDraftHistoryReference(db, source, reference);
    if (retained.view.address(retained.draft) !== view.address(selected))
      throw new HttpError(409, 'REVIEW_HISTORY_CHANGED', 'The selected correction history changed');
  } else {
    if (canonicalLiteral(scalar(view, selected, 'history')) !== canonicalLiteral(reference))
      throw new HttpError(409, 'REVIEW_HISTORY_CHANGED', 'The selected correction history changed');
    checked(createReportSnapshotCatalog(db, source, { catalog: 'review.snapshots' }), reference);
  }
  return structuredClone(reference);
}
function value<T>(reader: ReportSnapshotMapReader, key: string, bytes: number): T {
  let size = 0;
  const pieces: string[] = [];
  for (const piece of reader.chunks(key)) {
    size += Buffer.byteLength(piece);
    if (size > bytes)
      throw new HttpError(
        409,
        'REVIEW_HISTORY_FRAGMENT',
        'Inspect this review history entry in bounded fragments',
      );
    pieces.push(piece);
  }
  if (!pieces.length) throw Error('Missing review history entry');
  return parseLiteralJSON(pieces.join('')) as T;
}
async function indexResolution(
  writer: Pick<ReportSnapshotMapWriter, 'putMany'>,
  ordinal: number,
  resolution: Pick<IntakeIssueResolution, 'issueId' | 'outcome'>,
) {
  if (typeof resolution.issueId !== 'string' || typeof resolution.outcome !== 'string')
    throw Error('Invalid retained review resolution');
  const position = schemaOrdinal(ordinal),
    key = schemaKey(resolution.issueId);
  const changes = [{ key: 'latest:' + key, value: position }];
  if (resolution.outcome !== 'unknown') changes.push({ key: 'known:' + key, value: position });
  if (resolution.outcome === 'this_is_me') changes.push({ key: '$self', value: position });
  await writer.putMany(changes);
}

/** Small immutable entries share bounded checkpoints; large literal entries
 * retain their streamed byte representation without a whole-value buffer. */
function draftHistoryWriter(writer: ReportSnapshotMapWriter) {
  let pending: Array<{ key: string; value: string }> = [],
    bytes = 0;
  const flush = async () => {
    if (!pending.length) return;
    await writer.putMany(pending);
    pending = [];
    bytes = 0;
  };
  const put = async (key: string, value: string) => {
    const size = Buffer.byteLength(key) + Buffer.byteLength(value);
    if (pending.length && (pending.length === 16 || bytes + size > 65536)) await flush();
    pending.push({ key, value });
    bytes += size;
  };
  return {
    flush,
    async putMany(entries: readonly { key: string; value: string }[]) {
      for (const entry of entries) await put(entry.key, entry.value);
    },
    async putText(key: string, source: Iterable<string>) {
      const iterator = source[Symbol.iterator](),
        pieces: string[] = [];
      let size = 0,
        completed = false;
      try {
        while (true) {
          const next = iterator.next();
          if (next.done) {
            completed = true;
            const text = pieces.join('');
            if (reportSnapshotInlineTextFits(text)) await put(key, text);
            else {
              await flush();
              await writer.putText(key, pieces);
            }
            return;
          }
          size += Buffer.byteLength(next.value);
          if (size <= 16384) {
            pieces.push(next.value);
            continue;
          }
          await flush();
          await writer.putText(
            key,
            (function* () {
              yield* pieces;
              yield next.value;
              while (true) {
                const tail = iterator.next();
                if (tail.done) {
                  completed = true;
                  return;
                }
                yield tail.value;
              }
            })(),
          );
          return;
        }
      } finally {
        if (!completed) iterator.return?.();
      }
    },
  };
}

export async function prepareNativeDraftHistory(
  db: Database,
  source: IntakeEnvelopeSource,
  view: IntakeCollectionEnvelopeReader,
  previous: IntakeEnvelopeRecord | undefined,
  draft: IntakeReviewDraft,
  options: {
    assertRunning?: () => void;
    catalog?: ReportSnapshotCatalog;
    resolutionOperationId?: string;
    newResolutions?: Iterable<IntakeIssueResolution>;
  } = {},
) {
  const catalog =
    options.catalog ??
    createReportSnapshotCatalog(db, source, {
      assertRunning: options.assertRunning,
      catalog: 'review.snapshots',
    });
  const stored = selectedEnvelopeStore(db, source).source;
  const prior =
    previous && scalar(view, previous, 'format') === 'health-intake-review-draft-v2'
      ? scalar<IntakeNativeReviewDraftHistory>(view, previous, 'history')
      : undefined;
  if (prior && (prior.intakeId !== source.id || prior.sourceHash !== stored.sha256))
    throw Error('Review history source binding changed');
  if (prior) checked(catalog, prior);
  const writer = await catalog.fork(prior?.snapshotId);
  const entries = draftHistoryWriter(writer);
  let resolutions = prior?.resolutions ?? 0,
    corrections = prior?.corrections ?? 0;
  if (!prior) {
    await writer.put('$format', FORMAT);
    await writer.put('$source', JSON.stringify([source.id, stored.sha256]));
    if (previous) {
      for (const section of ['resolutions', 'corrections'] as const) {
        const count = view.childCount(previous, section);
        for (let ordinal = 0; ordinal < count; ordinal++) {
          options.assertRunning?.();
          const record = view.childAt(previous, section, ordinal)!;
          await entries.putText(
            PREFIX[section] + schemaOrdinal(ordinal),
            view.recordChunks(record),
          );
          if (section === 'resolutions')
            await indexResolution(entries, ordinal, {
              issueId: scalar<string>(view, record, 'issueId')!,
              outcome: scalar<IntakeIssueResolution['outcome']>(view, record, 'outcome')!,
            });
        }
        if (section === 'resolutions') resolutions = count;
        else corrections = count;
      }
    }
  }
  const changedResolutions =
    options.newResolutions ||
    draft.resolutions.filter(
      (entry) => entry.operationId === (options.resolutionOperationId ?? draft.id),
    );
  const changedCorrections = (draft.corrections ?? []).filter(
    (entry) => entry.operationId === draft.id,
  );
  for (const resolution of changedResolutions) {
    await entries.putText('r:' + schemaOrdinal(resolutions), [JSON.stringify(resolution)]);
    await indexResolution(entries, resolutions++, resolution);
  }
  for (const correction of changedCorrections)
    await entries.putText('c:' + schemaOrdinal(corrections++), [JSON.stringify(correction)]);
  await entries.flush();
  await writer.put('$counts', JSON.stringify([resolutions, corrections]));
  const snapshotId = 'draft:' + randomUUID();
  await catalog.publish(snapshotId, writer);
  const history: IntakeReviewDraftHistory = {
    format: FORMAT,
    intakeId: source.id,
    sourceHash: stored.sha256!,
    snapshotId,
    resolutions,
    corrections,
  };
  const { resolutionScope: _scope, resolutionsReference: _reference, ...header } = draft;
  return {
    draft: {
      ...header,
      format: 'health-intake-review-draft-v2' as const,
      history,
      resolutions: options.newResolutions ? [] : (changedResolutions as IntakeIssueResolution[]),
      corrections: changedCorrections,
    },
    changes: options.catalog ? [] : await catalog.finalChanges(),
    assertCurrent: catalog.assertCurrent,
  };
}

/** Existing policy asks latest per issue, any nonunknown per issue and last Self
 * confirmation. Preserve all three witnesses and their original relative order. */
export function readNativeReviewDraft(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  catalog: ReportSnapshotCatalog,
  bytes: number,
  context?: { db: Database; source: IntakeEnvelopeSource },
): IntakeReviewDraft {
  const native = scalar(view, record, 'format') === 'health-intake-review-draft-v2';
  if (!native && !context) return readIntakeReviewValue<IntakeReviewDraft>(view, record, bytes);
  const tooLarge = () =>
    new IntakeReviewFragmentRequired({
      format: 'health-intake-review-fragment-v1' as const,
      logical: view.logical,
      address: view.address(record),
    });
  // Read current policy fields, with the complete cumulative arrays represented
  // separately by an immutable history reference.
  const chunks: string[] = ['{'];
  let headerBytes = 2,
    first = true;
  const append = (text: string) => {
    headerBytes += Buffer.byteLength(text);
    if (headerBytes > bytes) throw tooLarge();
    chunks.push(text);
  };
  for (const name of [
    'format',
    'id',
    'proposalId',
    'recordId',
    'candidateId',
    'candidateVersionId',
    'mapping',
    'disposition',
    'decision',
    'answers',
    'at',
    ...(native ? ['corrections'] : []),
  ]) {
    if (!view.has(record, name)) continue;
    append((first ? '' : ',') + JSON.stringify(name) + ':');
    first = false;
    const child = view.child(record, name);
    for (const piece of child ? view.recordChunks(child) : view.fieldChunks(record, name))
      append(piece);
  }
  chunks.push('}');
  const draft = parseLiteralJSON(chunks.join('')) as IntakeReviewDraft;
  if (!native) {
    const history = createLegacyDraftHistoryReference(context!.db, context!.source, view, record);
    const policy = readLegacyDraftPolicyWitnesses(context!.db, context!.source, view, record, {
      bytes: Math.max(0, bytes - headerBytes),
    });
    return bindReviewDraftResolutions(
      { ...draft, history, resolutions: [], resolutionScope: 'policy_witnesses' },
      policy.policy,
      Math.max(0, bytes - headerBytes),
    );
  }
  // History counts are host metadata. The clinical literal decoder deliberately
  // preserves numeric source lexemes as raw JSON objects; use the addressed
  // ordinary metadata field for this checked capability instead.
  draft.history = scalar<IntakeReviewDraftHistory>(view, record, 'history');
  if (!draft.history) throw Error('Missing native review history');
  const history = checked(catalog, draft.history);
  const ordinal = (raw: unknown) => {
    if (typeof raw !== 'string' || !/^\d{16}$/.test(raw))
      throw Error('Invalid review history policy index');
    return raw;
  };
  const read = (position: string) => {
    try {
      return value<IntakeIssueResolution>(history, 'r:' + position, 256 * 1024);
    } catch (error) {
      if (error instanceof HttpError && error.code === 'REVIEW_HISTORY_FRAGMENT') throw tooLarge();
      throw error;
    }
  };
  const point = (key: string) => {
    const raw = history.get(key);
    return raw === undefined ? undefined : read(ordinal(raw));
  };
  const policy: ReviewDraftResolutionPolicy = {
    *values() {
      history.assertCurrent();
      const scratch = disposableSqlite('intake-native-draft-witnesses-');
      try {
        scratch.db.exec('CREATE TABLE selected(ordinal TEXT PRIMARY KEY)');
        const put = scratch.db.prepare('INSERT INTO selected VALUES(?) ON CONFLICT DO NOTHING');
        for (const prefix of ['known:', 'latest:']) {
          let after = prefix;
          outer: while (true) {
            const page = history.range({ after, items: 32, bytes: 8192 });
            for (const entry of page.items) {
              if (!entry.key.startsWith(prefix)) break outer;
              put.run(ordinal(entry.value));
            }
            if (page.complete) break;
            if (!page.after || page.after === after)
              throw Error('Review history index did not advance');
            after = page.after;
          }
        }
        const self = history.get('$self');
        if (self !== undefined) put.run(ordinal(self));
        for (const row of scratch.db
          .prepare('SELECT ordinal FROM selected ORDER BY ordinal')
          .iterate())
          yield read(String(row.ordinal));
      } finally {
        scratch.close();
      }
    },
    latest: (issueId) => point('latest:' + schemaKey(issueId)),
    known: (issueId) => point('known:' + schemaKey(issueId)),
    self: () => point('$self'),
  };
  return bindReviewDraftResolutions(
    { ...draft, resolutions: [], resolutionScope: 'policy_witnesses' },
    policy,
    Math.max(0, bytes - headerBytes),
  );
}

export function readReviewDraftHistoryPage(
  db: Database,
  source: IntakeEnvelopeSource,
  reference: IntakeReviewDraftHistory,
  input: { section: 'resolutions' | 'corrections'; offset?: number; limit?: number },
) {
  if (reference.format === 'health-intake-review-draft-legacy-history-v1')
    return readLegacyDraftHistoryPage(db, source, reference, input);
  const stored = selectedEnvelopeStore(db, source).source;
  if (reference.intakeId !== source.id || reference.sourceHash !== stored.sha256)
    throw new HttpError(
      409,
      'REVIEW_HISTORY_CHANGED',
      'This review history belongs to different source evidence',
    );
  const offset = input.offset ?? 0,
    limit = input.limit ?? 20;
  if (
    !['resolutions', 'corrections'].includes(input.section) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new HttpError(400, 'REVIEW_HISTORY_WINDOW', 'Choose a bounded review history window');
  const reader = checked(
    createReportSnapshotCatalog(db, source, { catalog: 'review.snapshots' }),
    reference,
  );
  const total = reference[input.section],
    items: Array<
      | { ordinal: number; value: IntakeIssueResolution | IntakeImportCorrection }
      | { ordinal: number; reference: IntakeReviewDraftHistory; section: typeof input.section }
    > = [];
  let used = 0;
  for (let ordinal = offset; ordinal < Math.min(total, offset + limit); ordinal++) {
    try {
      const entry = value<IntakeIssueResolution | IntakeImportCorrection>(
        reader,
        PREFIX[input.section] + schemaOrdinal(ordinal),
        Math.max(0, 65536 - used),
      );
      used += Buffer.byteLength(JSON.stringify(entry));
      items.push({ ordinal, value: entry });
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'REVIEW_HISTORY_FRAGMENT') throw error;
      items.push({ ordinal, reference, section: input.section });
    }
  }
  return {
    format: 'health-intake-review-history-page-v1' as const,
    reference,
    section: input.section,
    items,
    total,
    complete: offset + items.length >= total,
    nextOffset: offset + items.length < total ? offset + items.length : null,
  };
}

/** Addressed byte cursor; later windows never scan an earlier text prefix. */
export function readReviewDraftHistoryFragment(
  db: Database,
  source: IntakeEnvelopeSource,
  reference: IntakeNativeReviewDraftHistory,
  input: { section: 'resolutions' | 'corrections'; ordinal: number; cursor?: string },
) {
  const store = selectedEnvelopeStore(db, source);
  if (reference.intakeId !== source.id || reference.sourceHash !== store.source.sha256)
    throw new HttpError(
      409,
      'REVIEW_HISTORY_CHANGED',
      'This history belongs to different source evidence',
    );
  if (
    !['resolutions', 'corrections'].includes(input.section) ||
    !Number.isSafeInteger(input.ordinal) ||
    input.ordinal < 0 ||
    input.ordinal >= reference[input.section]
  )
    throw new HttpError(400, 'REVIEW_HISTORY_WINDOW', 'Select an existing history entry');
  const reader = checked(
    createReportSnapshotCatalog(db, source, { catalog: 'review.snapshots' }),
    reference,
  );
  const selected = reader.get(PREFIX[input.section] + schemaOrdinal(input.ordinal));
  if (selected === undefined) throw Error('Selected review history entry is missing');
  const binding = JSON.stringify([reference.snapshotId, input.section, input.ordinal]);
  let position: string | number | undefined;
  if (input.cursor) {
    try {
      if (input.cursor.length > 2048) throw Error();
      const value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()) as unknown[];
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        value[0] !== binding ||
        !['string', 'number'].includes(typeof value[1])
      )
        throw Error();
      position = value[1] as string | number;
    } catch {
      throw new HttpError(409, 'REVIEW_HISTORY_CURSOR', 'Reload this selected history entry');
    }
  }
  let data: Buffer, complete: boolean, next: string | number | null;
  if (typeof selected === 'string') {
    const bytes = Buffer.from(selected),
      offset = position ?? 0;
    if (
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > bytes.length
    )
      throw new HttpError(409, 'REVIEW_HISTORY_CURSOR', 'Reload this selected history entry');
    data = bytes.subarray(offset, offset + 32768);
    complete = offset + data.length >= bytes.length;
    next = complete ? null : offset + data.length;
  } else {
    if (position !== undefined && typeof position !== 'string')
      throw new HttpError(409, 'REVIEW_HISTORY_CURSOR', 'Reload this selected history entry');
    const page = store.collections.readBytes(selected, { after: position, items: 8, bytes: 32768 });
    data = Buffer.concat(page.chunks);
    complete = page.complete;
    next = page.after;
  }
  return {
    format: 'health-intake-review-history-fragment-v1' as const,
    encoding: 'base64' as const,
    data: data.toString('base64'),
    complete,
    nextCursor:
      next === null ? null : Buffer.from(JSON.stringify([binding, next])).toString('base64url'),
  };
}
