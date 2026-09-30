import { HttpError } from './database.ts';
import { isRetainOnlyIntake } from './intake-source-policy.ts';
import { currentIntakeSourceTextRevisionId, getIntakeSourceText } from './intake-source-text.ts';
import { recordDurabilityStatus } from './record-versions.ts';
import {
  extractIntakeSourceText,
  sourceTextExtractionPending,
} from './intake-source-extraction.ts';
import { createHash } from 'node:crypto';
import {
  htmlNavigationIndex,
  searchIndexedEvidence,
  followIndexedReference,
} from './intake-navigation.ts';
import {
  getIntakeOriginal,
  getRetainedIntakeOriginalReference,
  retainIntakeChildren,
  getIntake,
  readIntake,
} from './intake.ts';
import {
  indexPdfEvidence,
  readPdfEvidencePage,
  type PdfEvidencePage,
  type PdfNativeEvidencePage,
} from './intake-pdf-session.ts';
import { INTAKE_PDF_BOUNDS } from './intake-files.ts';
import { encodeIntakeImage, intakeImageDataUrl, type IntakeImageMimeType } from './intake-image.ts';
import { activeMappingRules } from './clinical-import.ts';
import { INTAKE_SCHEMA_INSTRUCTIONS } from './intake-format.ts';
import { modelIntakeEvidenceContext } from './intake-model-context.ts';
import { inventoryIntakePackage, indexIntakePackage } from './intake-package.ts';
import {
  diagnosticReasonCode,
  importDiagnostics,
  type ImportDiagnosticSink,
} from './import-diagnostics.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { NavigationIndex } from './intake-navigation.ts';

export interface SourceTextCaptureTransition {
  intakeId: string;
  priorRevisionId: string | null;
  revisionId: string | null;
}
interface EvidenceContext {
  db: DatabaseSync;
  root: string;
  profileId: string;
  id: string;
  page?: unknown;
  offset?: unknown;
  limit?: number;
  assertRunning?: () => void;
  modelContext?: boolean;
  /** Read-only scoped repair must not mutate its pinned source/version snapshot. */
  captureSourceText?: boolean;
  /** Host-only notification: a bounded local capture changed the source snapshot. */
  onSourceTextCaptured?: (transition: SourceTextCaptureTransition) => void;
  /** Host-negotiated PDF support; direct UI reads leave this disabled. */
  pdf?: boolean;
  diagnostics?: ImportDiagnosticSink;
}

interface NavigateEvidenceContext extends EvidenceContext {
  action: string;
  query?: unknown;
  referenceId?: string;
}

interface HtmlSection {
  id: string;
  locator: string;
  start: number;
  end: number;
  rows: { id: string; locator: string; start: number; end: number; header: boolean }[];
  sharedHeadings?: { start: number; end: number }[];
}

const literalWindow = ({ intake: _intake, ...window }: ReturnType<typeof readIntake>) => window;
// Resized uploads keep their source format. WebP quality 100 selects lossless
// encoding in @napi-rs/canvas; JPEG 100 minimizes additional quantization.
const UPLOADED_IMAGE_QUALITY = 100;

export async function captureIntakeSourceTextForRead({
  db,
  root,
  profileId,
  id,
  assertRunning = () => {},
  modelContext = false,
  captureSourceText = true,
  onSourceTextCaptured,
}: EvidenceContext) {
  // Container members can first enter processing through this reader rather
  // than a top-level batch. Capture bounded local evidence before taking the
  // metadata/version snapshot, while leaving original preview reads read-only.
  if (modelContext && captureSourceText && recordDurabilityStatus(db)) {
    const prior = getIntakeSourceText(db, root, profileId, id);
    if (sourceTextExtractionPending(prior)) {
      assertRunning();
      const captured = await extractIntakeSourceText({
        db,
        root,
        profileId,
        id,
        maxPages: 2,
        assertRunning,
      });
      assertRunning();
      onSourceTextCaptured?.({
        intakeId: id,
        priorRevisionId: prior.revision?.id ?? null,
        revisionId: captured.sourceText.revision?.id ?? null,
      });
    }
  }
}

export function sourceTextReadMetadata(db: DatabaseSync, profileId: string, id: string) {
  return {
    revisionId: currentIntakeSourceTextRevisionId(db, profileId, id),
    tool: 'health_intake_source_text',
    note: 'When available, retrieve durable source text before interpreting. It retains corrections, provenance and uncertainty. Original/native text below is unchanged evidence and may disagree. After reading the relevant current durable passages, pass their revisionId as sourceTextRevisionId on every intake_batch or intake_propose. Reading another original page may advance the durable revision. Text review is not clinical acceptance.',
  };
}

export async function readIntakeEvidence({
  db,
  root,
  profileId,
  id,
  page = 1,
  offset = 0,
  limit,
  assertRunning = () => {},
  modelContext = false,
  captureSourceText = true,
  onSourceTextCaptured,
  pdf = false,
}: EvidenceContext) {
  await captureIntakeSourceTextForRead({
    db,
    root,
    profileId,
    id,
    assertRunning,
    modelContext,
    captureSourceText,
    onSourceTextCaptured,
  });
  const intake = getIntake(db, root, profileId, id);
  if (modelContext && isRetainOnlyIntake(intake))
    throw new HttpError(
      409,
      'INTAKE_RETAIN_ONLY',
      'This source is retained for access but is excluded from model interpretation',
    );
  const mappingRules = activeMappingRules(db, intake.providerId);
  const mappingRulesVersion = createHash('sha256')
    .update(JSON.stringify(mappingRules))
    .digest('hex');
  const modelMappingRules = {
    count: mappingRules.length,
    version: mappingRulesVersion,
    section: 'mapping_rules',
  };
  if (intake.mimeType === 'application/zip')
    return {
      instructions: INTAKE_SCHEMA_INSTRUCTIONS,
      mappingRules: modelContext ? modelMappingRules : mappingRules,
      original: await inventoryIntakePackage({
        db,
        root,
        profileId,
        id,
        offset: offset as number,
        assertRunning,
      }),
    };
  const isPdf = intake.mimeType === 'application/pdf';
  const file = isPdf ? null : getIntakeOriginal(db, root, profileId, id);
  const metadata = {
    instructions: INTAKE_SCHEMA_INSTRUCTIONS,
    sourceText: sourceTextReadMetadata(db, profileId, id),
    mappingRules: modelContext ? modelMappingRules : mappingRules,
    intake: modelContext
      ? modelIntakeEvidenceContext(intake, { mappingRules, mappingRulesVersion })
      : intake,
    original: isPdf
      ? {
          ...(modelContext ? {} : { intake }),
          text: null,
          offset: 0,
          nextOffset: null,
          totalCharacters: null,
          complete: false,
          note: 'Original retained. PDF text and visuals are read from bounded page ranges.',
        }
      : modelContext
        ? literalWindow(readIntake(db, root, profileId, id, { offset: offset as number, limit }))
        : readIntake(db, root, profileId, id, { offset: offset as number, limit }),
  };
  if (file && ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimeType)) {
    const { loadImage, createCanvas } = await import('@napi-rs/canvas');
    assertRunning();
    const image = await loadImage(file.bytes);
    assertRunning();
    if (image.width * image.height > 80000000)
      throw Error('Image dimensions exceed visual review limit');
    const mimeType = file.mimeType as IntakeImageMimeType;
    const scale = Math.min(
      1,
      INTAKE_PDF_BOUNDS.maxRenderDimension / Math.max(image.width, image.height),
    );
    // Re-encode only the raster, even when no resizing is needed: forwarding the
    // upload bytes would also forward EXIF/XMP/ancillary metadata to the model.
    const canvas = createCanvas(
      Math.max(1, Math.round(image.width * scale)),
      Math.max(1, Math.round(image.height * scale)),
    );
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const preview = encodeIntakeImage(
      canvas,
      mimeType === 'image/png' ? { mimeType } : { mimeType, quality: UPLOADED_IMAGE_QUALITY },
    );
    return {
      imageContent: intakeImageDataUrl(preview.image, preview.mimeType),
      metadata: {
        ...metadata,
        caution: 'Raster visual derivative; original image retained. Preserve uncertainty.',
      },
    };
  }
  if (!isPdf) return metadata;
  const retained = getRetainedIntakeOriginalReference(db, root, profileId, id);
  assertRunning();
  const pageNumber = Math.trunc(Number(page));
  const start = Math.max(0, Math.trunc(Number(offset) || 0));
  const source = { ...retained, profileId };
  let failedNativeReadMs: number | undefined;
  const present = (
    result: PdfEvidencePage | PdfNativeEvidencePage,
    base64Ms: number,
    nativePdfFallback = false,
  ) => {
    assertRunning();
    const embedded = result.embedded.map((asset) => ({
      ...asset,
      bytes: Buffer.from(asset.bytes),
    }));
    // Both visual forms are transient. Retain the exact original page reference,
    // never a generated single-page PDF or image as new durable source evidence.
    const assets = [
      {
        id,
        filename: retained.filename,
        locator: `page ${pageNumber}`,
        mimeType: 'application/pdf',
        derivative: false,
      },
      ...retainIntakeChildren(db, root, profileId, id, embedded),
    ];
    assertRunning();
    const native = 'pdf' in result;
    return {
      metadata: {
        ...metadata,
        ...(nativePdfFallback
          ? {
              caution:
                'Native PDF input was unavailable for this page; a raster preview of the same original page is supplied.',
            }
          : {}),
        intake: modelContext
          ? modelIntakeEvidenceContext(intake, {
              page: pageNumber,
              mappingRules,
              mappingRulesVersion,
            })
          : intake,
        original: {
          page: pageNumber,
          totalPages: result.totalPages,
          nextPage: result.nextPage,
          text: result.text,
          offset: result.offset,
          nextOffset: result.nextOffset,
          totalCharacters: result.totalCharacters,
          assets,
          complete: false,
          coverage: native
            ? 'One derived PDF page plus bounded extracted text and embedded files. PDF page 1 corresponds only to the original page identified here; other original pages remain unread. Inspect every remaining page and attachment; report unreadable/omitted regions.'
            : 'Page render plus text and embedded files, with exact text returned through a bounded page window. The page render contains visible photos/diagrams, not separately recovered original image bytes. Inspect all pages and attachments; report unreadable/omitted regions.',
          ...(native
            ? {
                document: {
                  mimeType: 'application/pdf',
                  pages: 1,
                  originalPage: pageNumber,
                  derivative: true,
                },
              }
            : {
                render: {
                  width: result.width,
                  height: result.height,
                  reducedForOutputBound: result.imageReducedForOutput,
                },
              }),
        },
      },
      // Host telemetry only — never handed to the model. Counts and durations,
      // no health content. The worker's own phase timings are spread in flat
      // alongside these; see PdfWorkerPhaseTimings for what that spread contributes.
      hostTimings: {
        page: pageNumber,
        queueWaitMs: result.queueWaitMs,
        sessionSetupMs: result.sessionSetupMs,
        base64Ms,
        textLayerCharacters: result.totalCharacters,
        ...(native ? { pdfBytes: result.pdf.byteLength } : { imageBytes: result.image.byteLength }),
        ...(nativePdfFallback ? { nativePdfFallback: true } : {}),
        ...(failedNativeReadMs === undefined ? {} : { failedNativeReadMs }),
        ...result.timings,
      },
    };
  };
  const raster = async (nativePdfFallback = false) => {
    const result = await readPdfEvidencePage(source, pageNumber, start, assertRunning);
    assertRunning();
    const base64Started = performance.now();
    const imageContent = intakeImageDataUrl(result.image, result.mimeType);
    const base64Ms = Math.max(0, performance.now() - base64Started);
    return { imageContent, ...present(result, base64Ms, nativePdfFallback) };
  };
  if (!pdf) return raster();
  let result: PdfNativeEvidencePage;
  const nativeReadStarted = performance.now();
  try {
    result = await readPdfEvidencePage(source, pageNumber, start, assertRunning, { format: 'pdf' });
  } catch (error) {
    if (
      error instanceof HttpError &&
      ['PDF_NATIVE_PAGE_LIMIT', 'PDF_NATIVE_UNSUPPORTED'].includes(error.code)
    ) {
      // This failed attempt includes queue/setup/IPC, before the separately
      // measured raster read. It is not the worker-only nativePdfMs phase.
      failedNativeReadMs = Math.max(0, performance.now() - nativeReadStarted);
      return raster(true);
    }
    throw error;
  }
  assertRunning();
  const base64Started = performance.now();
  const pdfContent = `data:application/pdf;base64,${Buffer.from(result.pdf).toString('base64')}`;
  const base64Ms = Math.max(0, performance.now() - base64Started);
  return {
    pdfContent,
    ...present(result, base64Ms),
    // Host-only lazy fallback. The bridge invokes this only after an explicit
    // PDF transport rejection; no raster encode is paid on the successful path.
    pdfFallback: () => raster(true),
  };
}

// A navigable index into retained bytes; indexing is not extraction or acceptance.
export async function indexIntakeEvidence({
  db,
  root,
  profileId,
  id,
  assertRunning = () => {},
  diagnostics = importDiagnostics,
}: EvidenceContext): Promise<NavigationIndex> {
  if (getIntake(db, root, profileId, id).mimeType === 'application/zip')
    return (await indexIntakePackage({
      db,
      root,
      profileId,
      id,
      assertRunning,
    })) as NavigationIndex;
  const intake = getIntake(db, root, profileId, id);
  if (['image/png', 'image/jpeg', 'image/webp'].includes(intake.mimeType))
    return {
      kind: 'image',
      sections: [],
      missingAssets: [],
      coverage: 'uninspected',
      note: 'Original image retained. Use the visual evidence tool; indexing does not inspect its content.',
    };
  if (intake.mimeType === 'application/pdf') {
    const retained = getRetainedIntakeOriginalReference(db, root, profileId, id);
    const indexStarted = performance.now();
    diagnostics.record('import.phase.started', { phase: 'index_pdf' });
    try {
      const index = await indexPdfEvidence({ ...retained, profileId }, assertRunning);
      assertRunning();
      diagnostics.record('import.phase.completed', {
        phase: 'index_pdf',
        durationMs: Math.round(performance.now() - indexStarted),
        pages: index.pages,
      });
      return {
        kind: 'pdf',
        ...index,
        missingAssets: [],
        coverage: 'indexed_only',
        note: 'Verified retained original indexed through a bounded, reusable PDF range session. Indexing is not clinical extraction.',
      };
    } catch (error) {
      diagnostics.record('import.phase.failed', {
        phase: 'index_pdf',
        durationMs: Math.round(performance.now() - indexStarted),
        reasonCode: diagnosticReasonCode(error),
      });
      throw error;
    }
  }
  const original = getIntakeOriginal(db, root, profileId, id);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(original.bytes);
  } catch {
    return { kind: 'unsupported', sections: [], missingAssets: [], coverage: 'unreadable_binary' };
  }
  const html =
    /\.html?$/i.test(original.filename) || /<(?:html|table|body)\b/i.test(text.slice(0, 4096));
  if (!html)
    return {
      kind: 'text',
      characters: text.length,
      sections: [
        { id: 'text:1', locator: `characters 0–${text.length}`, start: 0, end: text.length },
      ],
      missingAssets: [],
      coverage: 'indexed_only',
    };
  const sections: HtmlSection[] = [],
    missingAssets: NonNullable<NavigationIndex['missingAssets']> = [];
  // Skip script/style bodies in indexing. Raw original offsets remain unchanged;
  // text returned for review is data and is never mounted as executable HTML.
  const inert = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (value) =>
    ' '.repeat(value.length),
  );
  let tableNumber = 0;
  for (const table of inert.matchAll(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi)) {
    tableNumber++;
    const rows = [];
    let rowNumber = 0;
    for (const row of table[0].matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi))
      rows.push({
        id: `table:${tableNumber}:row:${++rowNumber}`,
        locator: `table ${tableNumber}, row ${rowNumber}`,
        start: table.index + row.index,
        end: table.index + row.index + row[0].length,
        header: /<th\b/i.test(row[0]),
      });
    sections.push({
      id: `table:${tableNumber}`,
      locator: `table ${tableNumber}`,
      start: table.index,
      end: table.index + table[0].length,
      rows,
    });
  }
  const tableRanges = sections.map((s) => ({ start: s.start, end: s.end }));
  let cursor = 0;
  for (const range of [...tableRanges, { start: text.length, end: text.length }]) {
    if (
      range.start > cursor &&
      inert
        .slice(cursor, range.start)
        .replace(/<[^>]*>/g, '')
        .trim()
    )
      sections.push({
        id: `html:context:${cursor}`,
        locator: `characters ${cursor}–${range.start}`,
        start: cursor,
        end: range.start,
        rows: [],
      });
    cursor = range.end;
  }
  const navigation = htmlNavigationIndex({ db, id, filename: original.filename, text: inert });
  missingAssets.push(...navigation.references.filter((reference) => reference.asset));
  for (const section of sections)
    section.sharedHeadings = [
      ...navigation.headings.filter((heading) => heading.start < section.start).slice(-1),
      ...navigation.headings.filter(
        (heading) =>
          heading.kind === 'caption' &&
          heading.start >= section.start &&
          heading.end <= section.end,
      ),
    ].map(({ start, end }) => ({ start, end }));
  if (!sections.length)
    sections.push({
      id: 'html:1',
      locator: `characters 0–${text.length}`,
      start: 0,
      end: text.length,
      rows: [],
    });
  return {
    kind: 'html',
    characters: text.length,
    sections,
    missingAssets,
    ...navigation,
    coverage: 'indexed_only',
    note: 'Literal UTF-16 offsets in the unchanged original. Table windows share headings and may share rows; windows are not clinical record boundaries. Scripts are never executed.',
  };
}

// Navigation never accepts a record or changes extraction coverage. A persisted
// active index is reused so retries keep the same locators and member identity.
export async function navigateIntakeEvidence({
  db,
  root,
  profileId,
  id,
  action,
  query,
  referenceId,
  offset = 0,
  assertRunning = () => {},
}: NavigateEvidenceContext) {
  const intake = getIntake(db, root, profileId, id);
  const index: NavigationIndex =
    (intake.workflow!.plans.find((plan) => plan.status === 'active')?.index as NavigationIndex) ||
    (await indexIntakeEvidence({ db, root, profileId, id, assertRunning }));
  const context = { db, root, profileId, id, index, assertRunning };
  if (index.inventoryVersion === 1)
    return {
      intakeId: id,
      coverage: 'inventory_only',
      searched: false,
      followed: false,
      note: 'Package inventory contains metadata only. Read a supplied member through health_intake_package, then search or follow references on its returned sourceFileId. No member content was searched and this result does not establish absence.',
    };
  if (action === 'search') return searchIndexedEvidence({ ...context, query, offset });
  if (action === 'follow') return followIndexedReference({ ...context, referenceId });
  throw new HttpError(
    400,
    'NAVIGATION_ACTION',
    'Choose section search or follow a supplied reference',
  );
}
