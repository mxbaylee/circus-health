import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, type Stats } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument, PDFDataRangeTransport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { INTAKE_PDF_BOUNDS } from './intake-files.ts';
import { encodeIntakeImage } from './intake-image.ts';
import { extractNativePdfPage } from './intake-pdf-native.ts';
import type { PdfWorkerPage } from './intake-pdf-session.ts';

interface WorkerSource {
  path: string;
  size: number;
  sourceHash: string;
  filename: string;
}

interface WorkerRequest {
  requestId: number;
  action: 'index' | 'page' | 'identity' | 'search';
  sourceId?: string;
  page?: number;
  offset?: number;
  query?: string;
  format?: 'pdf' | 'image';
}

async function identityPageText(pageNumber: number) {
  assertSameOpenFile();
  const doc = document!;
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) {
    const error = new Error('PDF page outside document');
    Object.assign(error, { code: 'PDF_PAGE' });
    throw error;
  }
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  let text = '';
  for (const item of content.items as ({ str: string; hasEOL?: boolean } | object)[]) {
    text += 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '';
    if (text.length > INTAKE_PDF_BOUNDS.maxIdentityTextCharacters) {
      const error = new Error('Review this unusually large page individually');
      Object.assign(error, { code: 'IDENTITY_EVIDENCE_LIMIT' });
      throw error;
    }
  }
  page.cleanup();
  return { text, totalPages: doc.numPages };
}

async function searchPdf(query: string, requestedOffset: number) {
  assertSameOpenFile();
  if (!query || query.length > 200) {
    const error = new Error('Enter 1-200 search characters');
    Object.assign(error, { code: 'SEARCH_INPUT' });
    throw error;
  }
  const offset = Math.max(0, Math.trunc(requestedOffset || 0));
  const needle = query.toLocaleLowerCase();
  const results: { page: number; snippet: string }[] = [];
  let matches = 0;
  for (let number = 1; number <= document!.numPages; number++) {
    const page = await document!.getPage(number);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items as ({ str: string; hasEOL?: boolean } | object)[]) {
      text += 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '';
      if (text.length > INTAKE_PDF_BOUNDS.maxTextCharactersPerPage) {
        const error = new Error('PDF page text exceeds the bounded evidence limit');
        Object.assign(error, { code: 'PDF_TEXT_LIMIT' });
        throw error;
      }
    }
    const found = text.toLocaleLowerCase().indexOf(needle);
    if (found >= 0 && matches++ >= offset) {
      const start = Math.max(0, found - 160);
      const end = Math.min(text.length, found + needle.length + 320);
      results.push({ page: number, snippet: text.slice(start, end) });
    }
    page.cleanup();
    if (results.length > 20) break;
  }
  return {
    results: results.slice(0, 20),
    nextOffset: results.length > 20 ? offset + 20 : null,
    matchedPages: matches,
  };
}

interface PdfFileAnnotation {
  filename?: string;
  content?: Uint8Array | null;
}

interface PdfAnnotation {
  id?: string;
  dest?: string | unknown[];
  url?: string;
  unsafeUrl?: string;
  file?: PdfFileAnnotation;
  fileId?: string;
}

let source: WorkerSource;
if (!process.send) throw new Error('PDF evidence worker requires an IPC channel');
const send = (value: unknown): void => {
  process.send?.(value as object);
};

let fd: number | null = null;
let opened: Stats | null = null;
let task: ReturnType<typeof getDocument> | null = null;
let document: Awaited<ReturnType<typeof getDocument>['promise']> | null = null;
let rangeReads = 0;
let rangeBytes = 0;
let disposed = false;
const nativeExtraction = new AbortController();

function since(started: number): number {
  return Math.max(0, performance.now() - started);
}

const hashValue = (value: unknown): string =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');

function sourceChanged(): never {
  const error = new Error('The retained original no longer matches its verified source');
  Object.assign(error, { code: 'SOURCE_CHANGED' });
  throw error;
}

function safeStat(): Stats {
  if (fd === null) sourceChanged();
  const current = fstatSync(fd);
  if (!current.isFile() || current.size !== source.size) sourceChanged();
  return current;
}

function assertSameOpenFile(): void {
  const current = safeStat();
  if (
    !opened ||
    current.dev !== opened.dev ||
    current.ino !== opened.ino ||
    current.size !== opened.size ||
    current.mtimeMs !== opened.mtimeMs ||
    current.ctimeMs !== opened.ctimeMs
  )
    sourceChanged();
}

class RetainedFileRangeTransport extends PDFDataRangeTransport {
  #aborted = false;

  constructor(initialData: Uint8Array) {
    super(source.size, initialData, true, source.filename);
  }

  override requestDataRange(begin: number, end: number): void {
    if (this.#aborted || fd === null) return;
    if (
      !Number.isSafeInteger(begin) ||
      !Number.isSafeInteger(end) ||
      begin < 0 ||
      end <= begin ||
      end > source.size ||
      end - begin > INTAKE_PDF_BOUNDS.maxRangeRequestBytes
    )
      sourceChanged();
    const bytes = Buffer.allocUnsafe(end - begin);
    const read = readSync(fd, bytes, 0, bytes.length, begin);
    if (read !== bytes.length) sourceChanged();
    rangeReads++;
    rangeBytes += read;
    this.onDataRange(begin, Uint8Array.from(bytes));
  }

  override abort(): void {
    this.#aborted = true;
  }
}

function verifiedOpen(): Uint8Array {
  if (
    typeof source.path !== 'string' ||
    !Number.isSafeInteger(source.size) ||
    source.size < 1 ||
    !/^[a-f\d]{64}$/.test(source.sourceHash) ||
    typeof source.filename !== 'string'
  )
    sourceChanged();
  fd = openSync(source.path, 'r');
  const first = safeStat();
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(INTAKE_PDF_BOUNDS.verificationChunkBytes);
  let offset = 0;
  while (offset < source.size) {
    const expected = Math.min(buffer.length, source.size - offset);
    const read = readSync(fd, buffer, 0, expected, offset);
    if (read !== expected) sourceChanged();
    hash.update(buffer.subarray(0, read));
    offset += read;
  }
  if (hash.digest('hex') !== source.sourceHash) sourceChanged();
  opened = fstatSync(fd);
  if (
    opened.dev !== first.dev ||
    opened.ino !== first.ino ||
    opened.size !== first.size ||
    opened.mtimeMs !== first.mtimeMs ||
    opened.ctimeMs !== first.ctimeMs
  )
    sourceChanged();
  const initialLength = Math.min(INTAKE_PDF_BOUNDS.rangeChunkBytes, source.size);
  const initial = Buffer.allocUnsafe(initialLength);
  if (readSync(fd, initial, 0, initialLength, 0) !== initialLength) sourceChanged();
  rangeReads++;
  rangeBytes += initialLength;
  return Uint8Array.from(initial);
}

function textWindow(
  items: ({ str: string; hasEOL?: boolean } | object)[],
  requestedOffset: number,
) {
  const offset = Math.max(0, Math.trunc(requestedOffset || 0));
  let totalCharacters = 0;
  let text = '';
  for (const item of items) {
    const value = 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '';
    const start = totalCharacters;
    totalCharacters += value.length;
    if (totalCharacters > INTAKE_PDF_BOUNDS.maxTextCharactersPerPage) {
      const error = new Error('PDF page text exceeds the bounded evidence limit');
      Object.assign(error, { code: 'PDF_TEXT_LIMIT' });
      throw error;
    }
    if (totalCharacters > offset && start < offset + INTAKE_PDF_BOUNDS.maxTextCharactersPerRead)
      text += value.slice(
        Math.max(0, offset - start),
        offset + INTAKE_PDF_BOUNDS.maxTextCharactersPerRead - start,
      );
  }
  return {
    text,
    offset,
    totalCharacters,
    nextOffset:
      offset + INTAKE_PDF_BOUNDS.maxTextCharactersPerRead < totalCharacters
        ? offset + INTAKE_PDF_BOUNDS.maxTextCharactersPerRead
        : null,
  };
}

async function renderPage(
  page: Awaited<ReturnType<NonNullable<typeof document>['getPage']>>,
  maximumDimension: number,
) {
  const natural = page.getViewport({ scale: 1 });
  const scale = Math.min(2, maximumDimension / Math.max(natural.width, natural.height));
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  if (width * height > INTAKE_PDF_BOUNDS.maxRenderPixels) {
    const error = new Error('PDF page dimensions exceed the bounded render limit');
    Object.assign(error, { code: 'PDF_RENDER_LIMIT' });
    throw error;
  }
  const canvas = createCanvas(width, height);
  await page.render({
    canvasContext: canvas.getContext('2d') as unknown as Parameters<
      typeof page.render
    >[0]['canvasContext'],
    viewport,
    canvas: canvas as unknown as Parameters<typeof page.render>[0]['canvas'],
  }).promise;
  const encodeStarted = performance.now();
  const encoded = encodeIntakeImage(canvas, INTAKE_PDF_BOUNDS.imageEncoding);
  const encodeMs = since(encodeStarted);
  canvas.width = 1;
  canvas.height = 1;
  return { ...encoded, width, height, encodeMs };
}

async function boundedAttachments(
  pageNumber: number,
  doc: NonNullable<typeof document>,
  annotations: PdfAnnotation[],
) {
  const global = await doc.getAttachments();
  const embedded = [
    ...[...(global || [])].map(([key, attachment]) => ({
      filename: attachment.filename || key,
      locator: 'PDF embedded file ' + key,
      content: attachment.content,
      contentId: key,
    })),
    ...annotations
      .filter((annotation) => annotation.file && (annotation.file.content || annotation.fileId))
      .map((annotation) => ({
        filename: annotation.file!.filename || 'attachment',
        locator: `page ${pageNumber} attachment ${annotation.id}`,
        content: annotation.file!.content,
        contentId: annotation.fileId!,
      })),
  ];
  if (embedded.length > INTAKE_PDF_BOUNDS.maxAttachments) {
    const error = new Error('PDF page exceeds the bounded attachment count');
    Object.assign(error, { code: 'PDF_ATTACHMENT_LIMIT' });
    throw error;
  }
  let total = 0;
  const result: { filename: string; locator: string; bytes: Uint8Array }[] = [];
  for (const attachment of embedded) {
    const content = attachment.content || (await doc.getAttachmentContent(attachment.contentId));
    const bytes = content || new Uint8Array();
    total += bytes.byteLength;
    if (
      bytes.byteLength < 1 ||
      bytes.byteLength > INTAKE_PDF_BOUNDS.maxAttachmentBytes ||
      total > INTAKE_PDF_BOUNDS.maxAttachmentBytesPerRead
    ) {
      const error = new Error('PDF page exceeds the bounded attachment byte limit');
      Object.assign(error, { code: 'PDF_ATTACHMENT_LIMIT' });
      throw error;
    }
    result.push({
      filename: attachment.filename,
      locator: attachment.locator,
      bytes: Uint8Array.from(bytes),
    });
  }
  return result;
}

async function indexPdf(sourceId: string) {
  assertSameOpenFile();
  const doc = document!;
  const sections: { id: string; locator: string; page: number }[] = [];
  const references: Record<string, unknown>[] = [];
  for (let number = 1; number <= doc.numPages; number++) {
    sections.push({ id: `page:${number}`, locator: `page ${number}`, page: number });
    const page = await doc.getPage(number);
    const annotations = (await page.getAnnotations()) as PdfAnnotation[];
    for (const annotation of annotations) {
      if (!annotation.dest && !annotation.url && !annotation.unsafeUrl) continue;
      if (references.length >= INTAKE_PDF_BOUNDS.maxReferences) {
        const error = new Error('This PDF exceeds 5,000 indexed references; original retained');
        Object.assign(error, { code: 'REFERENCE_LIMIT' });
        throw error;
      }
      const reference: Record<string, unknown> = {
        id: 'reference:' + hashValue([sourceId, number, annotation.id]),
        source: String(annotation.unsafeUrl || annotation.url || annotation.dest).slice(0, 2_000),
        locator: `page ${number}, annotation ${annotation.id}`,
        status: 'not_supplied',
        note: 'PDF link target is uninspected. No external dependency was fetched.',
      };
      if (annotation.dest) {
        try {
          const destination =
            typeof annotation.dest === 'string'
              ? await doc.getDestination(annotation.dest)
              : annotation.dest;
          const targetPage = destination
            ? (Number.isInteger(destination[0])
                ? Number(destination[0])
                : await doc.getPageIndex(destination[0])) + 1
            : null;
          if (targetPage !== null && targetPage > 0 && targetPage <= doc.numPages)
            Object.assign(reference, {
              sourceFileId: sourceId,
              fragment: `page=${targetPage}`,
              status: 'supplied_uninspected',
            });
          else reference.status = 'unresolved_reference';
        } catch {
          reference.status = 'unresolved_reference';
        }
      }
      references.push(reference);
    }
    page.cleanup();
  }
  const result = { pages: doc.numPages, sections, references };
  if (Buffer.byteLength(JSON.stringify(result)) > INTAKE_PDF_BOUNDS.maxIndexOutputBytes) {
    const error = new Error('PDF index exceeds the bounded worker output limit');
    Object.assign(error, { code: 'PDF_OUTPUT_LIMIT' });
    throw error;
  }
  return result;
}

async function readPage(
  pageNumber: number,
  offset: number,
  format: 'pdf' | 'image',
): Promise<PdfWorkerPage> {
  const verifyStarted = performance.now();
  assertSameOpenFile();
  const verifyMs = since(verifyStarted);
  const doc = document!;
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) {
    const error = new Error('PDF page outside document');
    Object.assign(error, { code: 'PDF_PAGE' });
    throw error;
  }
  const page = await doc.getPage(pageNumber);

  const textStarted = performance.now();
  const content = await page.getTextContent();
  const text = textWindow(content.items as ({ str: string; hasEOL?: boolean } | object)[], offset);
  const textMs = since(textStarted);

  const annotationStarted = performance.now();
  const annotations = (await page.getAnnotations()) as PdfAnnotation[];
  const embedded = await boundedAttachments(pageNumber, doc, annotations);
  const annotationMs = since(annotationStarted);
  if (format === 'pdf') {
    try {
      // Copying annotation graphs can retain another page or an embedded file;
      // flattening can change form-field appearances. Keep those pages on the
      // explicit raster fallback instead of claiming a faithful native subset.
      if (annotations.length || doc.isPureXfa) {
        const error = new Error('Native page isolation does not support annotations or XFA forms');
        Object.assign(error, { code: 'PDF_NATIVE_UNSUPPORTED' });
        throw error;
      }
      const nativeStarted = performance.now();
      const pdf = await extractNativePdfPage(fd!, pageNumber, { signal: nativeExtraction.signal });
      assertSameOpenFile();
      const nativePdfMs = since(nativeStarted);
      const outputBytes =
        pdf.byteLength +
        Buffer.byteLength(text.text) +
        embedded.reduce((total, attachment) => total + attachment.bytes.byteLength, 0);
      if (outputBytes > INTAKE_PDF_BOUNDS.maxPageOutputBytes) {
        const error = new Error('PDF page evidence exceeds the bounded worker output limit');
        Object.assign(error, { code: 'PDF_OUTPUT_LIMIT' });
        throw error;
      }
      return {
        ...text,
        totalPages: doc.numPages,
        nextPage: pageNumber < doc.numPages ? pageNumber + 1 : null,
        pdf: Uint8Array.from(pdf),
        mimeType: 'application/pdf',
        embedded,
        timings: { verifyMs, textMs, nativePdfMs, annotationMs },
      };
    } finally {
      // Compatibility fallback keeps the healthy session: release this page's
      // temporary state on both the native success and rejection paths.
      page.cleanup();
    }
  }

  const renderStarted = performance.now();
  let rendered = await renderPage(page, INTAKE_PDF_BOUNDS.maxRenderDimension);
  let renderPasses = 1;
  let imageReducedForOutput = false;
  // Both passes' encodes are counted. `rendered` is reassigned by the retry, so
  // reading `rendered.encodeMs` alone would report the *second* encode and silently
  // drop the first — the encode of the oversized PNG, which is the slowest in the
  // document and the strongest evidence for or against the "PNG is the lever"
  // hypothesis these timings exist to test. The passes are sequential, so the sum
  // is exact rather than an approximation.
  let encodeMs = rendered.encodeMs;
  if (rendered.image.byteLength > INTAKE_PDF_BOUNDS.maxImageBytes) {
    rendered = await renderPage(page, INTAKE_PDF_BOUNDS.reducedRenderDimension);
    encodeMs += rendered.encodeMs;
    renderPasses = 2;
    imageReducedForOutput = true;
  }
  const renderMs = since(renderStarted);
  if (rendered.image.byteLength > INTAKE_PDF_BOUNDS.maxImageBytes) {
    const error = new Error('PDF page preview exceeds the bounded output limit');
    Object.assign(error, { code: 'PDF_OUTPUT_LIMIT' });
    throw error;
  }

  const outputBytes =
    rendered.image.byteLength +
    Buffer.byteLength(text.text) +
    embedded.reduce((total, attachment) => total + attachment.bytes.byteLength, 0);
  if (outputBytes > INTAKE_PDF_BOUNDS.maxPageOutputBytes) {
    const error = new Error('PDF page evidence exceeds the bounded worker output limit');
    Object.assign(error, { code: 'PDF_OUTPUT_LIMIT' });
    throw error;
  }
  page.cleanup();
  return {
    ...text,
    totalPages: doc.numPages,
    nextPage: pageNumber < doc.numPages ? pageNumber + 1 : null,
    image: Uint8Array.from(rendered.image),
    mimeType: rendered.mimeType,
    width: rendered.width,
    height: rendered.height,
    imageReducedForOutput,
    embedded,
    timings: { verifyMs, textMs, renderMs, encodeMs, annotationMs, renderPasses },
  };
}

async function initialize() {
  const initial = verifiedOpen();
  const range = new RetainedFileRangeTransport(initial);
  task = getDocument({
    range,
    rangeChunkSize: INTAKE_PDF_BOUNDS.rangeChunkBytes,
    disableStream: true,
    disableAutoFetch: true,
    isEvalSupported: false,
    useSystemFonts: false,
    maxImageSize: INTAKE_PDF_BOUNDS.maxSourceImagePixels,
    canvasMaxAreaInBytes: INTAKE_PDF_BOUNDS.maxSourceImagePixels * 4,
    standardFontDataUrl: fileURLToPath(
      new URL('../../standard_fonts/', import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')),
    ),
  } as unknown as Parameters<typeof getDocument>[0]);
  document = await task.promise;
  if (document.numPages < 1 || document.numPages > INTAKE_PDF_BOUNDS.maxPages) {
    const error = new Error('PDF page count exceeds the bounded evidence limit');
    Object.assign(error, { code: 'PDF_PAGE_LIMIT' });
    throw error;
  }
  send({
    type: 'ready',
    pages: document.numPages,
    verifiedBytes: source.size,
    rangeReads,
    rangeBytes,
  });
}

async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  nativeExtraction.abort();
  try {
    await task?.destroy();
  } finally {
    if (fd !== null) closeSync(fd);
    fd = null;
    opened = null;
    task = null;
    document = null;
  }
}

function errorResponse(requestId: number, error: unknown) {
  const caught = error as Error & { code?: string };
  send({
    type: 'error',
    requestId,
    code: caught.code || 'PDF_EVIDENCE',
    message: caught.message,
  });
}

async function handleRequest(request: WorkerRequest) {
  if (disposed || !document) return errorResponse(request.requestId, Error('PDF session closed'));
  try {
    const result =
      request.action === 'index'
        ? await indexPdf(String(request.sourceId || ''))
        : request.action === 'identity'
          ? await identityPageText(Number(request.page))
          : request.action === 'search'
            ? await searchPdf(String(request.query || ''), Number(request.offset || 0))
            : await readPage(
                Number(request.page),
                Number(request.offset || 0),
                request.format === 'pdf' ? 'pdf' : 'image',
              );
    send({
      type: 'result',
      requestId: request.requestId,
      result,
      diagnostics: { rangeReads, rangeBytes, memory: process.memoryUsage() },
    });
  } catch (error) {
    errorResponse(request.requestId, error);
  }
}

process.once('message', (message: { type?: string; source?: WorkerSource }) => {
  if (message.type !== 'initialize' || !message.source) {
    errorResponse(0, new Error('Invalid PDF initialization'));
    return;
  }
  source = message.source;
  void initialize()
    .then(() => process.on('message', handleRequest))
    .catch(async (error) => {
      errorResponse(0, error);
      await dispose();
    });
});
process.once('disconnect', () => {
  void dispose().finally(() => process.exit(0));
});

process.once('exit', () => {
  if (fd !== null) closeSync(fd);
});
