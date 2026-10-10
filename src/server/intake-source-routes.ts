import { createManualSourceRecordRead } from './intake-manual-source-record.ts';
import type { ManualSourceRecordRequest } from '../shared/intake-manual-source-record.ts';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './database.ts';
import {
  getIntakeRead,
  readIntakeLiteralWindow,
  getIntakePlan,
  currentIntakeInterpretations,
} from './intake.ts';
import {
  currentIntakeSourceTextRevisionId,
  getIntakeSourceText,
  getIntakeSourceIssues,
  getIntakeSourceTextAnnotation,
  getIntakeSourceTextPassage,
  getIntakeSourceTextReviewHistory,
  reviewIntakeSourceText,
} from './intake-source-text.ts';
import {
  runIntakeSourceExtractionOperation,
  getIntakeSourceExtractionFailure,
} from './intake-source-extraction-operation.ts';
import { searchIntakeSourceText } from './intake-source-search.ts';
import { readIntakeEvidence } from './intake-evidence.ts';
import type {
  SourceTextReviewRequest,
  SourceReaderCoverage,
} from '../shared/intake-source-text.ts';
import { isIntakeSummary } from '../shared/intake-summary.ts';
import {
  prepareCollectionReaderCoverage,
  readCollectionReaderCoverage,
} from './intake-source-reader-index.ts';
import { openCollectionReaderPlan } from './intake-source-reader-unit.ts';

interface SourceRoute {
  db: DatabaseSync;
  root: string;
  profileId: string;
  id: string;
  action: string;
  params: URLSearchParams;
  input?: Record<string, unknown>;
}

async function readerCoverage(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  sourceHash: string,
  params: URLSearchParams,
): Promise<SourceReaderCoverage> {
  const offset = Number(params.get('readerOffset') || 0),
    limit = Number(params.get('readerLimit') || 20);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new HttpError(
      400,
      'SOURCE_TEXT_INVALID',
      'Choose a reader offset and limit from 1 to 50',
    );
  const selected = getIntakeRead(db, root, profileId, id);
  if (isIntakeSummary(selected)) {
    if (
      (params.has('readerVersion') && Number(params.get('readerVersion')) !== selected.version) ||
      (offset > 0 && !params.has('readerVersion'))
    )
      throw new HttpError(409, 'VERSION_CONFLICT', 'Reload reader observations before continuing');
    const assertSelected = () => {
      const current = getIntakeRead(db, root, profileId, id);
      if (current.version !== selected.version || current.sha256 !== sourceHash)
        throw new HttpError(
          409,
          'VERSION_CONFLICT',
          'Reload reader observations before continuing',
        );
    };
    assertSelected();
    await prepareCollectionReaderCoverage(db, root, profileId, id, {
      assertRunning: assertSelected,
    });
    const prepared = readCollectionReaderCoverage(db, profileId, id, { offset, limit });
    const plans = new Map<string, ReturnType<typeof openCollectionReaderPlan>>();
    const entries = prepared.entries.map((entry) => {
      let plan = plans.get(entry.planAddress);
      if (!plan) {
        plan = openCollectionReaderPlan(db, root, profileId, id, entry.planAddress);
        plans.set(entry.planAddress, plan);
      }
      return plan.entry(entry.unitOrdinal, entry.stale);
    });
    prepared.assertCurrent();
    assertSelected();
    return {
      intakeVersion: selected.version,
      summary: prepared.summary,
      entries,
      offset,
      nextOffset: offset + limit < prepared.total ? offset + limit : null,
    };
  }
  const view = getIntakePlan(db, root, profileId, id);
  if (
    (params.has('readerVersion') && Number(params.get('readerVersion')) !== view.version) ||
    (offset > 0 && !params.has('readerVersion'))
  )
    throw new HttpError(409, 'VERSION_CONFLICT', 'Reload reader observations before continuing');
  const currentProposals = new Set(currentIntakeInterpretations(db, profileId, id).proposalIds);
  const units = view.plans
    .filter((p) => p.status === 'active' && p.pins.sourceHash === sourceHash)
    .flatMap((p) =>
      p.units.map((unit) => {
        const receipt = p.batches.find((batch) => batch.id === unit.attempts.at(-1));
        return {
          planId: p.id,
          unit,
          stale: !!unit.coverage && (!receipt || !currentProposals.has(receipt.proposalId)),
        };
      }),
    );
  const entries = units.filter(
    ({ unit, stale }) =>
      stale ||
      unit.status !== 'completed' ||
      unit.coverage?.kind === 'unreadable' ||
      unit.coverage?.kind === 'context' ||
      !!unit.coverage?.notes,
  );
  return {
    intakeVersion: view.version,
    summary: {
      units: units.length,
      pending: units.filter(({ unit }) => unit.status === 'pending').length,
      partial: units.filter(({ unit }) => unit.status === 'partial').length,
      unreadable: units.filter(({ unit, stale }) => !stale && unit.coverage?.kind === 'unreadable')
        .length,
      context: units.filter(({ unit, stale }) => !stale && unit.coverage?.kind === 'context')
        .length,
      stale: units.filter(({ stale }) => stale).length,
    },
    entries: entries.slice(offset, offset + limit).map(({ planId, unit, stale }) => ({
      planId,
      stale,
      unitId: unit.id,
      status: unit.status,
      kind: unit.kind,
      locator: unit.locator.slice(0, 240),
      ...(unit.pages
        ? {
            pages: unit.pages.slice(0, 20),
            ...(unit.pages.length > 20 ? { pagesTruncated: true } : {}),
          }
        : {}),
      ...(unit.coverage ? { coverageKind: unit.coverage.kind } : {}),
      notes: (unit.coverage?.notes || '').slice(0, 1200),
      ...((unit.coverage?.notes.length || 0) > 1200 ? { notesTruncated: true } : {}),
    })),
    offset,
    nextOffset: offset + limit < entries.length ? offset + limit : null,
  };
}

/** Called only through the profile-authorized intake router. No GET creates evidence. */
export async function intakeSourceRoute({
  db,
  root,
  profileId,
  id,
  action,
  params,
  input,
}: SourceRoute) {
  const original = getIntakeRead(db, root, profileId, id);
  const assertRunning = () => {
    // Revalidate after every worker await; a locked/closed profile or changed original
    // must never publish a late worker result. The vault also authorizes response delivery.
    if (getIntakeRead(db, root, profileId, id).sha256 !== original.sha256)
      throw new HttpError(409, 'SOURCE_CHANGED', 'Reload the retained source');
  };
  if (input) {
    if (action === 'source-records')
      return createManualSourceRecordRead(
        db,
        root,
        profileId,
        id,
        input as unknown as ManualSourceRecordRequest,
      );
    if (action === 'source-text')
      return reviewIntakeSourceText(
        db,
        root,
        profileId,
        id,
        input as unknown as SourceTextReviewRequest,
        'profile-owner',
      );
    if (action !== 'source-extract')
      throw new HttpError(404, 'NOT_FOUND', 'Unknown source operation');
    if (typeof input.operationId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.operationId))
      throw new HttpError(400, 'INVALID_INPUT', 'An extraction operation ID is required');
    const result = await runIntakeSourceExtractionOperation({
      db,
      root,
      profileId,
      id,
      assertRunning,
      operationId: input.operationId,
      expectedRevisionId: input.expectedRevisionId as string | null,
    });
    assertRunning();
    return { ...result.sourceText, extractionOperation: result.operation };
  }
  if (action === 'source-issues') {
    const response = getIntakeSourceIssues(db, root, profileId, id, {
      revisionId: params.get('revisionId') || undefined,
      offset: Number(params.get('offset') || 0),
      limit: Number(params.get('limit') || 50),
    });
    return {
      ...response,
      readerCoverage: await readerCoverage(db, root, profileId, id, response.sourceHash, params),
      extractionFailure: getIntakeSourceExtractionFailure(db, profileId, id, response.sourceHash),
    };
  }
  if (action === 'source-text')
    return getIntakeSourceText(db, root, profileId, id, params.get('revisionId') || undefined);
  if (action === 'source-search')
    return searchIntakeSourceText(db, root, profileId, id, {
      query: params.get('query') || '',
      revisionId: params.get('revisionId') || undefined,
      offset: Number(params.get('offset') || 0),
      character: Number(params.get('character') || 0),
    });
  if (action === 'source-annotation')
    return getIntakeSourceTextAnnotation(db, root, profileId, id, {
      revisionId: params.get('revisionId') || '',
      kind: params.get('kind') as 'alternative' | 'issue' | 'review',
      id: params.get('annotationId') || '',
      index: Number(params.get('index') || 0),
      field: params.get('field') as 'reason' | 'clarification',
      offset: Number(params.get('offset') || 0),
    });
  if (action === 'source-history')
    return getIntakeSourceTextReviewHistory(db, root, profileId, id, {
      beforeRevisionId: params.get('beforeRevisionId') || undefined,
      ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
    });
  if (action === 'source-passage')
    return getIntakeSourceTextPassage(db, root, profileId, id, {
      revisionId: params.get('revisionId') || undefined,
      historyBeforeRevisionId: params.get('historyBeforeRevisionId') || undefined,
      ...Object.fromEntries(
        ['page', 'offset', 'character', 'limit', 'maxCharacters', 'issueOffset', 'relationOffset']
          .filter((k) => params.has(k))
          .map((k) => [k, Number(params.get(k))]),
      ),
    });
  if (action !== 'source-preview') throw new HttpError(404, 'NOT_FOUND', 'Unknown source view');
  const revisionId = params.get('revisionId');
  if (!revisionId || revisionId !== currentIntakeSourceTextRevisionId(db, profileId, id))
    throw new HttpError(
      409,
      'SOURCE_TEXT_CHANGED',
      'Reload source text before displaying this revision',
    );
  const page = Number(params.get('page'));
  if (!Number.isSafeInteger(page) || page < 1)
    throw new HttpError(400, 'INVALID_INPUT', 'Choose a source page');
  const source = getIntakeSourceText(db, root, profileId, id);
  const scope = source.revision?.pages.find((p) => p.page === page);
  if (!scope) throw new HttpError(404, 'NOT_FOUND', 'Source page is unavailable');
  if (
    original.mimeType !== 'application/pdf' &&
    !['image/png', 'image/jpeg', 'image/webp'].includes(original.mimeType)
  ) {
    const literal = readIntakeLiteralWindow(db, root, profileId, id, {
      offset: (page - 1) * 24000,
      limit: 24000,
    });
    return { text: literal.text, offset: literal.offset, nextOffset: literal.nextOffset };
  }
  const preview = await readIntakeEvidence({
    db,
    root,
    profileId,
    id,
    page,
    assertRunning,
    pagedContext: isIntakeSummary(original),
  });
  assertRunning();
  if (revisionId !== currentIntakeSourceTextRevisionId(db, profileId, id))
    throw new HttpError(409, 'SOURCE_TEXT_CHANGED', 'Source text changed while rendering');
  if (!('imageContent' in preview))
    throw new HttpError(
      422,
      'SOURCE_PREVIEW_UNAVAILABLE',
      'This source has a literal text view instead of a raster preview',
    );
  return { dataUrl: preview.imageContent, width: scope.width, height: scope.height };
}
