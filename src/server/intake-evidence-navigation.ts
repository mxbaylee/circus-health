import { createHash } from 'node:crypto';
import { HttpError, type Database } from './database.ts';
import {
  getIntakeEvidenceHeader,
  getIntakeOriginal,
  getRetainedIntakeOriginalReference,
  readIntakeLiteralWindow,
} from './intake.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import { searchPdfEvidencePage } from './intake-pdf-session.ts';

export interface CollectionEvidenceNavigationRequest {
  format: 'health-intake-navigation-request-v2';
  action: 'search' | 'follow';
  query?: string;
  cursor?: string;
  referenceId?: string;
}
type Context = {
  db: Database;
  root: string;
  profileId: string;
  id: string;
  assertRunning?: () => void;
};
type Cursor = {
  format: 'health-intake-navigation-cursor-v2';
  binding: string;
  index: string;
  query: string;
  sourceOrdinal: number;
  sectionOrdinal: number;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pending = () => ({
  format: 'health-intake-navigation-v2' as const,
  state: 'pending' as const,
  complete: false,
  searched: false,
  followed: false,
  note: 'The complete selected navigation scope is not available yet. Original evidence remains readable; this result does not establish absence.',
});
function scalar(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  field: string,
): unknown {
  const result = view.field(record, field, { bytes: 65536 });
  if (result.kind === 'fragmented') throw Error('Navigation scalar requires addressed consumption');
  return result.kind === 'missing' ? undefined : result.value;
}
function text(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  field: string,
): string {
  const value = scalar(view, record, field);
  if (typeof value !== 'string') throw Error('Invalid selected navigation field: ' + field);
  return value;
}
function integer(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  field: string,
): number {
  const value = scalar(view, record, field);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw Error('Invalid selected navigation ordinal');
  return value;
}
function count(view: IntakeCollectionEnvelopeReader, record: IntakeEnvelopeRecord, field: string) {
  if (view.has(record, field) && !view.child(record, field))
    throw Error('Navigation requires a complete structured child scope');
  return view.childCount(record, field);
}
function selection(context: Context) {
  const header = getIntakeEvidenceHeader(context.db, context.root, context.profileId, context.id);
  if (header.workflowState !== 'selected') return { header };
  const source = { id: context.id, kind: 'intake_original', sha256: header.sourceHash };
  const view = openIntakeCollectionEnvelope(context.db, source),
    { collections } = selectedEnvelopeStore(context.db, source);
  const current = collections.openView();
  if (
    collections.get(current, 'builds', 'envelope.indexes', 'complete') !==
      JSON.stringify(view.logical) ||
    collections.get(current, 'builds', 'envelope.indexes', 'policy') !==
      'health-intake-workflow-index-v6'
  )
    return { header };
  const plan = view.lookup('active-plan-first', []),
    index = plan && view.child(plan, 'index');
  if (!index) return { header };
  return {
    header,
    view,
    index,
    binding: digest([
      context.id,
      header.sourceHash,
      view.logical,
      intakeSourceVersion(context.db, context.id).sourcePin,
    ]),
  };
}
function decodeCursor(value: string): Cursor {
  if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new HttpError(400, 'NAVIGATION_CURSOR', 'Use the returned navigation cursor');
  let cursor: Cursor;
  try {
    cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
  } catch {
    throw new HttpError(400, 'NAVIGATION_CURSOR', 'Use the returned navigation cursor');
  }
  if (
    !cursor ||
    Object.keys(cursor).sort().join(',') !==
      'binding,format,index,query,sectionOrdinal,sourceOrdinal' ||
    cursor.format !== 'health-intake-navigation-cursor-v2' ||
    !Number.isSafeInteger(cursor.sourceOrdinal) ||
    cursor.sourceOrdinal < 0 ||
    !Number.isSafeInteger(cursor.sectionOrdinal) ||
    cursor.sectionOrdinal < 0
  )
    throw new HttpError(400, 'NAVIGATION_CURSOR', 'Use the returned navigation cursor');
  return cursor;
}
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');
const preview = (value: string, limit: number) => ({
  text: value.slice(0, limit),
  truncated: value.length > limit,
});

/** Explicit v2 navigation. Cursors address selected source/section ordinals;
 * an empty partial page never proves that the complete scope has no matches. */
export async function navigateCollectionEvidence(
  context: Context,
  request: CollectionEvidenceNavigationRequest,
) {
  context.assertRunning?.();
  if (
    request.format !== 'health-intake-navigation-request-v2' ||
    !['search', 'follow'].includes(request.action)
  )
    throw new HttpError(
      400,
      'NAVIGATION_ACTION',
      'Choose a version 2 search or supplied-reference follow',
    );
  const selected = selection(context);
  if (!selected.view || !selected.index) {
    if (selected.header.mimeType === 'application/zip')
      return {
        ...pending(),
        state: 'inventory_only' as const,
        note: 'Read a supplied ZIP member, then navigate its returned sourceFileId. No member content was searched and this result does not establish absence.',
      };
    return pending();
  }
  const { view, index, binding } = selected;
  if (scalar(view, index, 'inventoryVersion') === 1)
    return {
      ...pending(),
      state: 'inventory_only' as const,
      note: 'This selected package inventory contains metadata only. Read a supplied member and navigate its sourceFileId; no member content was searched.',
    };
  if (request.action === 'follow')
    return follow(context, selected as Required<typeof selected>, request.referenceId);
  const query = typeof request.query === 'string' ? request.query.trim() : '';
  const needle = query.toLocaleLowerCase();
  if (!query || query.length > 200 || request.referenceId !== undefined)
    throw new HttpError(400, 'SEARCH_INPUT', 'Enter 1–200 literal search characters');
  const cursor: Cursor = request.cursor
    ? decodeCursor(request.cursor)
    : {
        format: 'health-intake-navigation-cursor-v2',
        binding,
        index: view.address(index),
        query,
        sourceOrdinal: 0,
        sectionOrdinal: 0,
      };
  if (cursor.binding !== binding || cursor.index !== view.address(index) || cursor.query !== query)
    throw new HttpError(
      409,
      'NAVIGATION_CHANGED',
      'This evidence scope changed. Start a fresh search.',
    );
  const zipped = text(view, index, 'kind') === 'zip',
    sourceCount = zipped ? count(view, index, 'members') : 1;
  if (
    cursor.sourceOrdinal > sourceCount ||
    (cursor.sourceOrdinal === sourceCount && cursor.sectionOrdinal !== 0)
  )
    throw new HttpError(400, 'NAVIGATION_CURSOR', 'Navigation cursor is outside its scope');
  const results: Record<string, unknown>[] = [];
  let scanned = 0,
    literalId = '',
    literal = '';
  while (cursor.sourceOrdinal < sourceCount && scanned < 8) {
    context.assertRunning?.();
    const member = zipped ? view.childAt(index, 'members', cursor.sourceOrdinal) : undefined;
    if (zipped && !member) throw Error('Missing selected navigation member');
    const sourceId = member ? scalar(view, member, 'sourceFileId') : context.id;
    const sourceIndex = member ? view.child(member, 'index') : index;
    if (
      !sourceId ||
      !sourceIndex ||
      !['text', 'html', 'pdf'].includes(text(view, sourceIndex, 'kind'))
    ) {
      cursor.sourceOrdinal++;
      cursor.sectionOrdinal = 0;
      scanned++;
      continue;
    }
    if (typeof sourceId !== 'string') throw Error('Invalid navigation source identity');
    const sections = count(view, sourceIndex, 'sections');
    if (cursor.sectionOrdinal > sections)
      throw new HttpError(
        400,
        'NAVIGATION_CURSOR',
        'Navigation cursor is outside its section scope',
      );
    if (cursor.sectionOrdinal === sections) {
      cursor.sourceOrdinal++;
      cursor.sectionOrdinal = 0;
      scanned++;
      continue;
    }
    const section = view.childAt(sourceIndex, 'sections', cursor.sectionOrdinal);
    if (!section) throw Error('Missing selected navigation section');
    const source = getRetainedIntakeOriginalReference(
      context.db,
      context.root,
      context.profileId,
      sourceId,
    );
    const expected = member ? scalar(view, member, 'sourceHash') : selected.header.sourceHash;
    if (expected && source.sourceHash !== expected)
      throw new HttpError(
        409,
        'SOURCE_CHANGED',
        'The member no longer matches this navigation scope',
      );
    const kind = text(view, sourceIndex, 'kind');
    let snippet: string | null = null,
      start: number | undefined,
      end: number | undefined,
      page: number | undefined;
    if (kind === 'pdf') {
      page = integer(view, section, 'page');
      snippet = (
        await searchPdfEvidencePage(
          { ...source, profileId: context.profileId },
          page,
          query,
          context.assertRunning,
        )
      ).snippet;
    } else {
      if (literalId !== sourceId) {
        const original = getIntakeOriginal(context.db, context.root, context.profileId, sourceId);
        literal = new TextDecoder('utf-8', { fatal: true }).decode(original.bytes);
        if (kind === 'html')
          literal = literal.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (value) =>
            ' '.repeat(value.length),
          );
        literalId = sourceId;
      }
      const base = integer(view, section, 'start'),
        sectionEnd = integer(view, section, 'end'),
        chunk = literal.slice(base, sectionEnd),
        found = chunk.toLocaleLowerCase().indexOf(needle);
      if (found >= 0) {
        const left = Math.max(0, found - 160),
          right = Math.min(chunk.length, found + needle.length + 320);
        snippet = chunk.slice(left, right);
        start = base + left;
        end = base + right;
      }
    }
    if (snippet !== null) {
      const filename = preview(source.filename, 160),
        locator = preview(text(view, section, 'locator'), 400);
      results.push({
        sourceFileId: sourceId,
        filenamePreview: filename.text,
        filenameTruncated: filename.truncated,
        sectionId: text(view, section, 'id'),
        locatorPreview: locator.text,
        locatorTruncated: locator.truncated,
        ...(page === undefined ? { start, end } : { page }),
        snippet,
      });
    }
    cursor.sectionOrdinal++;
    scanned++;
    if (cursor.sectionOrdinal === sections) {
      cursor.sourceOrdinal++;
      cursor.sectionOrdinal = 0;
    }
  }
  context.assertRunning?.();
  view.address(index);
  const complete = cursor.sourceOrdinal === sourceCount;
  const result = {
    format: 'health-intake-navigation-v2' as const,
    state: 'ready' as const,
    action: 'search' as const,
    query,
    binding,
    results,
    scannedSections: scanned,
    nextCursor: complete ? null : encode(cursor),
    complete,
    coverage: 'search_only',
    note: 'Literal selected-section search is not clinical extraction. Image-only content and nested archives remain unread. Follow the cursor through empty partial pages before interpreting search completeness.',
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 40000)
    throw Error('Navigation result exceeds its bounded envelope');
  return result;
}

async function follow(
  context: Context,
  selected: {
    header: ReturnType<typeof getIntakeEvidenceHeader>;
    view: IntakeCollectionEnvelopeReader;
    index: IntakeEnvelopeRecord;
    binding: string;
  },
  referenceId: string | undefined,
) {
  if (typeof referenceId !== 'string' || !referenceId || referenceId.length > 512)
    throw new HttpError(400, 'REFERENCE_NOT_FOUND', 'Choose a supplied reference');
  const { view, index } = selected,
    key = [view.address(index), referenceId];
  const reference = view.lookup('navigation-reference-first', key),
    owner = view.lookup('navigation-reference-owner', key),
    source = view.lookup('navigation-reference-source', key);
  if (!reference || !owner || !source) {
    if (reference || owner || source) throw Error('Incomplete selected navigation reference proof');
    throw new HttpError(
      404,
      'REFERENCE_NOT_FOUND',
      'Reference does not belong to this selected evidence index',
    );
  }
  const targetId = scalar(view, reference, 'sourceFileId'),
    memberId = scalar(view, reference, 'memberId');
  const base = {
    format: 'health-intake-navigation-v2' as const,
    action: 'follow' as const,
    referenceId,
    binding: selected.binding,
    coverage: 'uninspected',
  };
  if (!targetId)
    return {
      ...base,
      followed: false,
      ...(memberId
        ? { memberId, intakeId: scalar(view, reference, 'intakeId'), nextAction: 'read_member' }
        : {}),
      note: 'Only retained supplied evidence can be followed. No network request was made.',
    };
  if (typeof targetId !== 'string') throw Error('Invalid selected reference source');
  const target = getIntakeEvidenceHeader(context.db, context.root, context.profileId, targetId);
  if (target.mimeType === 'application/zip')
    return {
      ...base,
      followed: true,
      sourceFileId: targetId,
      kind: 'archive',
      nextAction: 'inventory',
      note: 'Retained nested archive. Open it explicitly; no recursive expansion occurred.',
    };
  const ownerId = source.kind === 'member' ? text(view, source, 'sourceFileId') : context.id;
  const targetSelection =
    targetId === ownerId ? { view, index: owner } : selection({ ...context, id: targetId });
  const fragment = scalar(view, reference, 'fragment');
  if (fragment !== undefined && typeof fragment !== 'string')
    throw Error('Invalid retained reference fragment');
  if (fragment && (!targetSelection.view || !targetSelection.index))
    return {
      ...base,
      followed: false,
      sourceFileId: targetId,
      fragmentState: 'pending',
      note: 'The retained target is available, but its complete anchor scope is not selected yet.',
    };
  let start = 0,
    locator: string | undefined;
  if (fragment && targetSelection.view && targetSelection.index) {
    const targetView = targetSelection.view,
      targetIndex = targetSelection.index;
    if (text(targetView, targetIndex, 'kind') === 'pdf' && /^page=\d+$/.test(fragment)) {
      const page = Number(fragment.slice(5)),
        pages = integer(targetView, targetIndex, 'pages');
      return page > 0 && page <= pages
        ? { ...base, followed: true, sourceFileId: targetId, kind: 'pdf', page }
        : { ...base, followed: false, sourceFileId: targetId, reason: 'Page outside supplied PDF' };
    }
    const anchorKey = [targetView.address(targetIndex), fragment],
      first = targetView.lookup('navigation-anchor-first', anchorKey),
      last = targetView.lookup('navigation-anchor-last', anchorKey);
    if (!first || !last) {
      if (first || last) throw Error('Incomplete navigation anchor proof');
      return {
        ...base,
        followed: false,
        sourceFileId: targetId,
        reason: 'Fragment not found in supplied target',
      };
    }
    if (targetView.address(first) !== targetView.address(last))
      return {
        ...base,
        followed: false,
        sourceFileId: targetId,
        reason: 'Ambiguous duplicate anchor',
      };
    start = integer(targetView, first, 'start');
    locator = text(targetView, first, 'locator');
  }
  context.assertRunning?.();
  const window = readIntakeLiteralWindow(context.db, context.root, context.profileId, targetId, {
    offset: start,
    limit: 4000,
  });
  return {
    ...base,
    followed: true,
    sourceFileId: targetId,
    kind: target.mimeType,
    ...(locator
      ? { locatorPreview: locator.slice(0, 400), locatorTruncated: locator.length > 400 }
      : {}),
    original: window,
    note: 'Untrusted literal retained original. Following a reference does not accept a clinical record.',
  };
}
