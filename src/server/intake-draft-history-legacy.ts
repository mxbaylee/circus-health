/** References to the unchanged retained event remain valid through later appends
 * and schema maintenance, without pretending old arrays are native snapshots. */
import { HttpError, type Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  intakeEnvelopeRecordOrder,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import type {
  IntakeLegacyReviewDraftHistory,
  IntakeImportCorrection,
  IntakeIssueResolution,
} from '../shared/intake.ts';
import { readIntakeReviewValue, IntakeReviewFragmentRequired } from './intake-review-collection.ts';
import { readIntakeCollectionEvidenceFragment } from './intake-evidence-fragment.ts';

const FORMAT = 'health-intake-review-draft-legacy-history-v1';
const changed = () =>
  new HttpError(409, 'REVIEW_HISTORY_CHANGED', 'Reload this retained review history');
const flow = (view: IntakeCollectionEnvelopeReader) => {
  const intake = view.child(view.root(), 'intake');
  return intake && view.child(intake, 'workflow');
};
const draftId = (view: IntakeCollectionEnvelopeReader, draft: IntakeEnvelopeRecord) => {
  const format = view.field(draft, 'format', { bytes: 256 });
  if (
    format.kind === 'fragmented' ||
    (format.kind === 'value' && format.value === 'health-intake-review-draft-v2')
  )
    throw changed();
  const value = view.field(draft, 'id', { bytes: 8192 });
  if (value.kind !== 'value' || typeof value.value !== 'string') throw changed();
  return value.value;
};
export function createLegacyDraftHistoryReference(
  db: Database,
  source: IntakeEnvelopeSource,
  view: IntakeCollectionEnvelopeReader,
  draft: IntakeEnvelopeRecord,
): IntakeLegacyReviewDraftHistory {
  const selected = selectedEnvelopeStore(db, source),
    ordinal = intakeEnvelopeRecordOrder(view, draft).at(-1),
    workflow = flow(view);
  if (
    ordinal === undefined ||
    !workflow ||
    view.address(view.childAt(workflow, 'reviewDrafts', ordinal)!) !== view.address(draft)
  )
    throw changed();
  if (
    JSON.stringify(openIntakeCollectionEnvelope(db, source).logical) !==
      JSON.stringify(view.logical) ||
    !selected.source.sha256
  )
    throw changed();
  return {
    format: FORMAT,
    intakeId: source.id,
    sourceHash: selected.source.sha256,
    draftId: draftId(view, draft),
    ordinal,
    resolutions: view.childCount(draft, 'resolutions'),
    corrections: view.childCount(draft, 'corrections'),
  };
}
export function checkLegacyDraftHistoryReference(
  db: Database,
  source: IntakeEnvelopeSource,
  reference: IntakeLegacyReviewDraftHistory,
) {
  const selected = selectedEnvelopeStore(db, source);
  if (
    !reference ||
    reference.format !== FORMAT ||
    reference.intakeId !== source.id ||
    reference.sourceHash !== selected.source.sha256 ||
    typeof reference.draftId !== 'string' ||
    ![reference.ordinal, reference.resolutions, reference.corrections].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    throw changed();
  const view = openIntakeCollectionEnvelope(db, source),
    workflow = flow(view),
    draft = workflow && view.childAt(workflow, 'reviewDrafts', reference.ordinal);
  if (
    !draft ||
    draftId(view, draft) !== reference.draftId ||
    view.childCount(draft, 'resolutions') !== reference.resolutions ||
    view.childCount(draft, 'corrections') !== reference.corrections
  )
    throw changed();
  return { view, draft };
}
export function readLegacyDraftHistoryPage(
  db: Database,
  source: IntakeEnvelopeSource,
  reference: IntakeLegacyReviewDraftHistory,
  input: { section: 'resolutions' | 'corrections'; offset?: number; limit?: number },
) {
  const { view, draft } = checkLegacyDraftHistoryReference(db, source, reference),
    offset = input.offset ?? 0,
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
  const total = reference[input.section],
    items: Array<
      | { ordinal: number; value: IntakeIssueResolution | IntakeImportCorrection }
      | {
          ordinal: number;
          reference: IntakeLegacyReviewDraftHistory;
          section: typeof input.section;
        }
    > = [];
  let used = 0;
  for (let ordinal = offset; ordinal < Math.min(total, offset + limit); ordinal++) {
    const record = view.childAt(draft, input.section, ordinal)!;
    try {
      const value = readIntakeReviewValue<IntakeIssueResolution | IntakeImportCorrection>(
        view,
        record,
        Math.max(0, 65536 - used),
      );
      used += Buffer.byteLength(JSON.stringify(value));
      items.push({ ordinal, value });
    } catch (error) {
      if (!(error instanceof IntakeReviewFragmentRequired)) throw error;
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
export async function readLegacyDraftHistoryFragment(
  db: Database,
  root: string,
  profileId: string,
  source: IntakeEnvelopeSource,
  reference: IntakeLegacyReviewDraftHistory,
  input: { section: 'resolutions' | 'corrections'; ordinal: number; cursor?: string },
) {
  const { view, draft } = checkLegacyDraftHistoryReference(db, source, reference);
  if (
    !['resolutions', 'corrections'].includes(input.section) ||
    !Number.isSafeInteger(input.ordinal) ||
    input.ordinal < 0 ||
    input.ordinal >= reference[input.section]
  )
    throw new HttpError(400, 'REVIEW_HISTORY_WINDOW', 'Select an existing history entry');
  const binding = JSON.stringify([
    reference.intakeId,
    reference.sourceHash,
    reference.ordinal,
    reference.draftId,
    input.section,
    input.ordinal,
  ]);
  let offset = 0;
  if (input.cursor) {
    try {
      if (input.cursor.length > 4096) throw Error();
      const value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()) as unknown[];
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        value[0] !== binding ||
        !Number.isSafeInteger(value[1]) ||
        (value[1] as number) < 0
      )
        throw Error();
      offset = value[1] as number;
    } catch {
      throw new HttpError(409, 'REVIEW_HISTORY_CURSOR', 'Reload this selected history entry');
    }
  }
  const record = view.childAt(draft, input.section, input.ordinal)!;
  const page = await readIntakeCollectionEvidenceFragment(db, root, profileId, source.id, {
    reference: {
      format: 'health-intake-review-fragment-v1',
      logical: view.logical,
      address: view.address(record),
    },
    offset,
    bytes: 32768,
  });
  checkLegacyDraftHistoryReference(db, source, reference);
  return {
    format: 'health-intake-review-history-fragment-v1' as const,
    encoding: page.encoding,
    data: page.data,
    complete: page.complete,
    nextCursor:
      page.nextOffset === null
        ? null
        : Buffer.from(JSON.stringify([binding, page.nextOffset])).toString('base64url'),
  };
}
