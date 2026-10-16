import { fork, type ChildProcess } from 'node:child_process';
import { HttpError } from './database.ts';
import { INTAKE_PDF_BOUNDS } from './intake-files.ts';
import type { IntakeImageMimeType } from './intake-image.ts';

export interface RetainedPdfSource {
  profileId: string;
  id: string;
  path: string;
  size: number;
  sourceHash: string;
  filename: string;
}

export interface PdfEvidenceIndex {
  pages: number;
  sections: { id: string; locator: string; page: number }[];
  references: {
    id: string;
    source: string;
    locator: string;
    status: string;
    note: string;
    sourceFileId?: string;
    fragment?: string;
  }[];
}

/** Sub-phase timings the PDF worker measures for its own `readPage()` work. */
export interface PdfWorkerPhaseTimings {
  verifyMs: number;
  textMs: number;
  renderMs: number;
  encodeMs: number;
  annotationMs: number;
  renderPasses: number;
}

export interface PdfNativePhaseTimings {
  verifyMs: number;
  textMs: number;
  nativePdfMs: number;
  annotationMs: number;
}

export interface PdfEvidencePage {
  text: string;
  /** Complete native items for this page, in PDF content order; geometry is normalized
   * to the displayed (rotation-aware) page. Native order is not a semantic guarantee. */
  locatedText?: { text: string; x: number; y: number; width: number; height: number }[];
  offset: number;
  nextOffset: number | null;
  totalCharacters: number;
  totalPages: number;
  nextPage: number | null;
  image: Uint8Array;
  mimeType: IntakeImageMimeType;
  width: number;
  height: number;
  imageReducedForOutput: boolean;
  embedded: { filename: string; locator: string; bytes: Uint8Array }[];
  /** Worker-reported sub-timings. Absent only if an older worker build omits them. */
  timings?: PdfWorkerPhaseTimings;
  /** Host-side FIFO queue wait alone, ending when this request left the queue. Always present. */
  queueWaitMs: number;
  /**
   * Session setup this request paid for before dispatch: `fork()`, the pdf.js document
   * open, and `verifiedOpen()`'s chunked SHA-256 over the *entire* retained original.
   * Near zero when the session was reused. Sessions recycle every
   * `maxRenderedPagesPerSession` rendered pages, so a long document re-pays this
   * several times; it is reported separately so that cost is not read as queue
   * contention (which would point at parallel readers, the wrong lever).
   */
  sessionSetupMs: number;
}

export interface PdfNativeEvidencePage extends Omit<
  PdfEvidencePage,
  'image' | 'mimeType' | 'width' | 'height' | 'imageReducedForOutput' | 'timings'
> {
  pdf: Uint8Array;
  mimeType: 'application/pdf';
  timings: PdfNativePhaseTimings;
}

export interface PdfIdentityPageText {
  text: string;
  totalPages: number;
}

export type PdfWorkerPage =
  | Omit<PdfEvidencePage, 'queueWaitMs' | 'sessionSetupMs'>
  | Omit<PdfNativeEvidencePage, 'queueWaitMs' | 'sessionSetupMs'>;

export interface PdfEvidenceSearch {
  results: { page: number; snippet: string }[];
  nextOffset: number | null;
  matchedPages: number;
}
export interface PdfEvidencePageSearch {
  page: number;
  totalPages: number;
  snippet: string | null;
}

interface PdfWorkerMemory {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

interface WorkerResponse {
  type: 'ready' | 'result' | 'error';
  requestId?: number;
  pages?: number;
  verifiedBytes?: number;
  result?:
    | PdfWorkerPage
    | PdfEvidenceIndex
    | PdfIdentityPageText
    | PdfEvidenceSearch
    | PdfEvidencePageSearch;
  diagnostics?: {
    rangeReads: number;
    rangeBytes: number;
    memory: PdfWorkerMemory;
  };
  code?: string;
  message?: string;
}

/** What a pending request resolves with: the action's raw result plus any worker
 *  phase timings nested inside it (only 'page' reads carry timings; see #message). */
interface PendingResponse {
  result: unknown;
  timings?: PdfWorkerPhaseTimings | PdfNativePhaseTimings;
}

interface PendingRequest {
  resolve(value: PendingResponse): void;
  reject(error: Error): void;
}

/** Host `performance.now()` stamps bracketing the queue wait and the session setup. */
interface SchedulingMarks {
  queuedAt: number;
  dequeuedAt: number;
}

const diagnostics = {
  sessionsCreated: 0,
  sessionsReused: 0,
  sessionsDisposed: 0,
  sessionsRecycled: 0,
  requests: 0,
  cancellations: 0,
  timeouts: 0,
  lastRangeReads: 0,
  lastRangeBytes: 0,
  lastWorkerMemory: null as PdfWorkerMemory | null,
  lastWorkerSampleAt: null as string | null,
};

function publicWorkerError(code = 'PDF_EVIDENCE', detail = ''): HttpError {
  if (code === 'SOURCE_CHANGED')
    return new HttpError(409, code, 'The retained original no longer matches its hash');
  if (
    [
      'REFERENCE_LIMIT',
      'PDF_PAGE_LIMIT',
      'PDF_TEXT_LIMIT',
      'PDF_RENDER_LIMIT',
      'PDF_OUTPUT_LIMIT',
      'PDF_ATTACHMENT_LIMIT',
      'PDF_NATIVE_PAGE_LIMIT',
      'IDENTITY_EVIDENCE_LIMIT',
    ].includes(code)
  )
    return new HttpError(
      413,
      code,
      detail || 'The retained PDF exceeds a bounded evidence-processing limit',
    );
  if (code === 'PDF_PAGE') return new HttpError(400, code, 'PDF page outside document');
  if (code === 'SEARCH_INPUT') return new HttpError(400, code, detail);
  const error = new HttpError(
    422,
    code,
    'The retained PDF could not be read safely; the unchanged original remains available',
  );
  if (detail) error.cause = detail;
  return error;
}

class PdfSession {
  readonly source: RetainedPdfSource;
  readonly key: string;
  #worker: ChildProcess;
  #ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  #pending = new Map<number, PendingRequest>();
  #nextRequestId = 1;
  #disposed = false;
  #disposal: Promise<void> | null = null;
  #renderedPages = 0;
  #lastRss = 0;
  #idleTimer: NodeJS.Timeout | null = null;

  constructor(source: RetainedPdfSource) {
    this.source = source;
    this.key = [source.profileId, source.id, source.sourceHash].join('\0');
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#worker = fork(new URL('./intake-pdf-worker.ts', import.meta.url), [], {
      execArgv: [`--max-old-space-size=${INTAKE_PDF_BOUNDS.workerOldGenerationMiB}`],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      detached: process.platform !== 'win32',
      // Parser children need no model credentials, profile keys or preload hooks.
      env: {
        NODE_ENV: process.env.NODE_ENV || 'production',
        PATH: process.env.PATH || '',
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      },
    });
    this.#worker.on('message', (message: WorkerResponse) => this.#message(message));
    this.#worker.once('error', () => this.#fail(publicWorkerError()));
    this.#worker.once('exit', () => {
      this.#killWorkerGroup();
      if (!this.#disposed) this.#fail(publicWorkerError());
    });
    this.#worker.send(
      {
        type: 'initialize',
        source: {
          path: source.path,
          size: source.size,
          sourceHash: source.sourceHash,
          filename: source.filename,
        },
      },
      (error) => {
        if (error) this.#fail(publicWorkerError());
      },
    );
    this.#worker.unref();
    this.#worker.channel?.unref();
    diagnostics.lastWorkerMemory = null;
    diagnostics.lastWorkerSampleAt = null;
    diagnostics.sessionsCreated++;
  }

  get needsRecycle(): boolean {
    return (
      this.#renderedPages >= INTAKE_PDF_BOUNDS.maxRenderedPagesPerSession ||
      this.#lastRss >= INTAKE_PDF_BOUNDS.workerRecycleRssBytes
    );
  }

  get pid(): number | null {
    return this.#worker.pid || null;
  }

  #message(message: WorkerResponse): void {
    if (message.type === 'ready') {
      if (message.verifiedBytes !== this.source.size) {
        this.#fail(publicWorkerError('SOURCE_CHANGED'));
        return;
      }
      this.#resolveReady();
      return;
    }
    if (message.type === 'error') {
      const error = publicWorkerError(message.code, message.message);
      if (message.requestId === 0) this.#fail(error);
      else {
        this.#pending.get(message.requestId!)?.reject(error);
        this.#pending.delete(message.requestId!);
      }
      return;
    }
    if (message.diagnostics) {
      diagnostics.lastRangeReads = message.diagnostics.rangeReads;
      diagnostics.lastRangeBytes = message.diagnostics.rangeBytes;
      diagnostics.lastWorkerMemory = message.diagnostics.memory;
      diagnostics.lastWorkerSampleAt = new Date().toISOString();
      this.#lastRss = message.diagnostics.memory.rss;
    }
    const pending = this.#pending.get(message.requestId!);
    if (!pending) return;
    this.#pending.delete(message.requestId!);
    // Sub-timings travel nested inside the action's own result (see readPage() in
    // intake-pdf-worker.ts) — there is no separate top-level timings field on the wire.
    const timings = (
      message.result as { timings?: PdfWorkerPhaseTimings | PdfNativePhaseTimings } | undefined
    )?.timings;
    pending.resolve({ result: message.result, timings });
  }

  #fail(error: Error): void {
    this.#rejectReady(error);
    for (const request of this.#pending.values()) request.reject(error);
    this.#pending.clear();
  }

  #armIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      void retireSession(this, publicWorkerError());
    }, INTAKE_PDF_BOUNDS.idleTimeoutMs);
    this.#idleTimer.unref();
  }

  /**
   * `marks` (host `performance.now()` stamps taken by `scheduledSource`: `queuedAt` when
   * the caller asked to run something, `dequeuedAt` when this request left the FIFO queue)
   * is only meaningful for 'page' reads: it is how `queueWaitMs` and `sessionSetupMs` get
   * onto `PdfEvidencePage`. Other actions omit it and get nothing merged.
   */
  async run<T>(
    action: 'index' | 'page' | 'identity' | 'search' | 'search_page',
    input: Record<string, unknown>,
    assertRunning: () => void,
    marks?: SchedulingMarks,
  ): Promise<T> {
    if (this.#disposed) throw publicWorkerError();
    this.#worker.ref();
    this.#worker.channel?.ref();
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    const requestId = this.#nextRequestId++;
    const timeoutMs =
      action === 'index'
        ? INTAKE_PDF_BOUNDS.indexTimeoutMs
        : action === 'search'
          ? INTAKE_PDF_BOUNDS.searchTimeoutMs
          : INTAKE_PDF_BOUNDS.pageTimeoutMs;
    const operation = (async () => {
      await this.#ready;
      assertRunning();
      // Two spans, split at the moment this request left the queue, both ending before
      // dispatch so neither includes the worker's own round trip. `queueWaitMs` is the
      // true wait behind other requests; `sessionSetupMs` is what this request paid to
      // have a ready session (fork, document open, full-file SHA-256) and is near zero
      // when the session was reused. They were one number before, which made a
      // re-verification cost look like queue contention.
      const queueWaitMs = marks === undefined ? undefined : marks.dequeuedAt - marks.queuedAt;
      const sessionSetupMs = marks === undefined ? undefined : performance.now() - marks.dequeuedAt;
      const response = new Promise<PendingResponse>((resolve, reject) => {
        this.#pending.set(requestId, { resolve, reject });
        this.#worker.send({ requestId, action, ...input }, (error) => {
          if (error) this.#fail(publicWorkerError());
        });
      });
      diagnostics.requests++;
      const { result, timings } = await response;
      return action === 'page'
        ? ({
            ...(result as object),
            timings,
            queueWaitMs: queueWaitMs ?? 0,
            sessionSetupMs: sessionSetupMs ?? 0,
          } as T)
        : (result as T);
    })();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(cancellation);
        clearTimeout(timeout);
        this.#armIdle();
        this.#worker.unref();
        this.#worker.channel?.unref();
        callback();
      };
      const cancellation = setInterval(() => {
        try {
          assertRunning();
        } catch (error) {
          diagnostics.cancellations++;
          retireSession(this, error as Error);
          finish(() => reject(error));
        }
      }, 50);
      cancellation.unref();
      const timeout = setTimeout(
        () => {
          diagnostics.timeouts++;
          const error = new HttpError(
            422,
            'PDF_EVIDENCE_TIMEOUT',
            'PDF evidence processing exceeded its bounded wall time; the original remains available',
          );
          retireSession(this, error);
          finish(() => reject(error));
        },
        Math.max(INTAKE_PDF_BOUNDS.openTimeoutMs, timeoutMs),
      );
      timeout.unref();
      operation.then(
        (value) => {
          if (action === 'page') this.#renderedPages++;
          finish(() => resolve(value as T));
        },
        (error) => {
          // Native compatibility/output rejection does not invalidate PDF.js or
          // its verified descriptor. Reuse it for the same-page raster read.
          // Integrity, cancellation, parser and other failures still retire it.
          if (!(
            action === 'page' &&
            input.format === 'pdf' &&
            error instanceof HttpError &&
            ['PDF_NATIVE_UNSUPPORTED', 'PDF_NATIVE_PAGE_LIMIT'].includes(error.code)
          ))
            retireSession(this, error as Error);
          finish(() => reject(error));
        },
      );
    });
  }

  #killWorkerGroup(): boolean {
    if (process.platform !== 'win32' && this.#worker.pid) {
      try {
        process.kill(-this.#worker.pid, 'SIGKILL');
        return true;
      } catch {
        // The group may already have exited. Fall back to the direct child.
      }
    }
    return this.#worker.kill('SIGKILL');
  }

  dispose(reason: Error = publicWorkerError()): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#fail(reason);
    diagnostics.sessionsDisposed++;
    this.#disposal = new Promise<void>((resolve) => {
      if (this.#worker.exitCode !== null || this.#worker.signalCode !== null) {
        this.#killWorkerGroup();
        return resolve();
      }
      this.#worker.ref();
      this.#worker.once('exit', () => resolve());
      // A cancelled native render may not service graceful IPC. The worker owns
      // no durable writes, so immediate termination safely releases its memory.
      if (!this.#killWorkerGroup()) resolve();
    });
    return this.#disposal;
  }
}

let activeSession: PdfSession | null = null;
let queue: Promise<void> = Promise.resolve();
let retirement: Promise<void> = Promise.resolve();
const profileGenerations = new Map<string, number>();

function retireSession(session: PdfSession, reason: Error): Promise<void> {
  if (activeSession === session) activeSession = null;
  retirement = Promise.all([retirement, session.dispose(reason)]).then(() => {});
  return retirement;
}

function scheduled<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(
    () => {},
    () => {},
  );
  return result;
}

function scheduledSource<T>(
  source: RetainedPdfSource,
  assertRunning: () => void,
  operation: (session: PdfSession, guard: () => void, marks: SchedulingMarks) => Promise<T>,
): Promise<T> {
  // Stamped at the moment the request enters the system, before it may have to wait
  // behind another request in the process-global FIFO queue below.
  const queuedAt = performance.now();
  const generation = profileGenerations.get(source.profileId) || 0;
  profileGenerations.set(source.profileId, generation);
  const guard = () => {
    if ((profileGenerations.get(source.profileId) || 0) !== generation)
      throw new HttpError(
        409,
        'PDF_EVIDENCE_CANCELLED',
        'PDF reading stopped; the original remains available.',
      );
    assertRunning();
  };
  return scheduled(async () => {
    guard();
    // The queue/setup boundary: everything before this stamp is waiting behind other
    // requests, everything after it is this request's own session setup — `sessionFor`
    // may fork a worker, and the worker then opens the document and hashes the whole
    // retained original before `#ready` resolves.
    const dequeuedAt = performance.now();
    const session = await sessionFor(source, guard);
    guard();
    return operation(session, guard, { queuedAt, dequeuedAt });
  });
}

async function sessionFor(source: RetainedPdfSource, guard: () => void): Promise<PdfSession> {
  await retirement;
  guard();
  const key = [source.profileId, source.id, source.sourceHash].join('\0');
  if (
    activeSession?.key === key &&
    activeSession.source.path === source.path &&
    !activeSession.needsRecycle
  ) {
    diagnostics.sessionsReused++;
    return activeSession;
  }
  if (activeSession) {
    // PDF.js and the native canvas retain document/font caches beyond page
    // cleanup. Recycle between reads, never during one, to bound that lifetime.
    if (activeSession.needsRecycle) diagnostics.sessionsRecycled++;
    await activeSession.dispose();
  }
  guard();
  activeSession = new PdfSession(source);
  return activeSession;
}

export function indexPdfEvidence(
  source: RetainedPdfSource,
  assertRunning: () => void = () => {},
): Promise<PdfEvidenceIndex> {
  return (async () => {
    const combined: PdfEvidenceIndex = { pages: 0, sections: [], references: [] };
    for (let pageStart = 1; pageStart === 1 || pageStart <= combined.pages; pageStart += 64) {
      const chunk = await scheduledSource(source, assertRunning, (session, guard) =>
        session.run<PdfEvidenceIndex>(
          'index',
          { sourceId: source.id, pageStart, pageLimit: 64 },
          guard,
        ),
      );
      combined.pages = chunk.pages;
      combined.sections.push(...chunk.sections);
      combined.references.push(...chunk.references);
    }
    return combined;
  })();
}

export function pdfPageCountEvidence(
  source: RetainedPdfSource,
  assertRunning: () => void = () => {},
): Promise<number> {
  return scheduledSource(
    source,
    assertRunning,
    async (session, guard) =>
      (
        await session.run<PdfEvidenceIndex>(
          'index',
          { sourceId: source.id, pagesOnly: true },
          guard,
        )
      ).pages,
  );
}

export function readPdfEvidencePage(
  source: RetainedPdfSource,
  page: number,
  offset: number,
  assertRunning: (() => void) | undefined,
  options: { format: 'pdf' },
): Promise<PdfNativeEvidencePage>;
export function readPdfEvidencePage(
  source: RetainedPdfSource,
  page: number,
  offset: number,
  assertRunning?: () => void,
  options?: { format?: 'image' },
): Promise<PdfEvidencePage>;
export function readPdfEvidencePage(
  source: RetainedPdfSource,
  page: number,
  offset: number,
  assertRunning: () => void = () => {},
  options: { format?: 'pdf' | 'image' } = {},
): Promise<PdfEvidencePage | PdfNativeEvidencePage> {
  return scheduledSource(source, assertRunning, (session, guard, marks) =>
    session.run<PdfEvidencePage | PdfNativeEvidencePage>(
      'page',
      { page, offset, format: options.format || 'image' },
      guard,
      marks,
    ),
  );
}

export function readPdfIdentityPageText(
  source: RetainedPdfSource,
  page: number,
  assertRunning: () => void = () => {},
): Promise<PdfIdentityPageText> {
  return scheduledSource(source, assertRunning, (session, guard) =>
    session.run<PdfIdentityPageText>('identity', { page }, guard),
  );
}

export function searchPdfEvidence(
  source: RetainedPdfSource,
  query: string,
  offset: number,
  assertRunning: () => void = () => {},
): Promise<PdfEvidenceSearch> {
  return scheduledSource(source, assertRunning, (session, guard) =>
    session.run<PdfEvidenceSearch>('search', { query, offset }, guard),
  );
}

export function searchPdfEvidencePage(
  source: RetainedPdfSource,
  page: number,
  query: string,
  assertRunning: () => void = () => {},
): Promise<PdfEvidencePageSearch> {
  return scheduledSource(source, assertRunning, (session, guard) =>
    session.run<PdfEvidencePageSearch>('search_page', { page, query }, guard),
  );
}

/** Release decrypted parser state and its retained-original file descriptor. */
export async function disposePdfEvidenceSessions(profileId?: string): Promise<void> {
  // Disposal must not wait behind a slow parser operation. Invalidate queued reads
  // too, so profile lock cannot open another decrypted original after cancellation.
  const profiles = profileId ? [profileId] : [...profileGenerations.keys()];
  for (const id of profiles) profileGenerations.set(id, (profileGenerations.get(id) || 0) + 1);
  if (!activeSession || (profileId && activeSession.source.profileId !== profileId)) return;
  const session = activeSession;
  activeSession = null;
  await retireSession(
    session,
    new HttpError(
      409,
      'PDF_EVIDENCE_CANCELLED',
      'PDF reading stopped; the original remains available.',
    ),
  );
}

export function pdfEvidenceSessionDiagnostics() {
  return {
    ...diagnostics,
    activeSessions: activeSession ? 1 : 0,
    activeWorkerPid: activeSession?.pid || null,
    memoryScope: 'isolated_child_process' as const,
  };
}
