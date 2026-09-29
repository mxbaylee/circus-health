import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { HttpError } from './database.ts';
import { isRetainOnlyIntake } from './intake-source-policy.ts';
import type { DatabaseSync } from 'node:sqlite';
import type {
  IntakeSourceText,
  SourceTextEvidence,
  SourceTextIssue,
} from '../shared/intake-source-text.ts';
import { getIntakeOriginal, getRetainedIntakeOriginalReference, readIntake } from './intake.ts';
import { indexPdfEvidence, readPdfEvidencePage } from './intake-pdf-session.ts';
import { getIntakeSourceText, publishIntakeSourceText } from './intake-source-text.ts';
import { composeSourceReadings } from './intake-source-ocr.ts';
import type { LocatedNativeText, SourceOcrResult } from './intake-source-ocr.ts';

const ADAPTER = { name: 'native-local-ocr-source', version: '1' };
const TEXT_WINDOW = 24_000;
interface ExtractionContext {
  db: DatabaseSync;
  root: string;
  profileId: string;
  id: string;
  assertRunning?: () => void;
  maxPages?: number;
}
const activeSources = new WeakMap<DatabaseSync, Set<string>>();
let activeExtractions = 0;
export async function extractIntakeSourceText(context: ExtractionContext) {
  const key = `${context.profileId}:${context.id}`;
  const active = activeSources.get(context.db) || new Set<string>();
  if (active.has(key))
    throw new HttpError(
      409,
      'SOURCE_TEXT_EXTRACTION_ACTIVE',
      'Source extraction is already running. Wait for it to finish before continuing.',
    );
  if (activeExtractions >= 2)
    throw new HttpError(
      429,
      'SOURCE_EXTRACTION_BUSY',
      'Local extraction capacity is busy. Existing progress is retained; try again shortly.',
    );
  active.add(key);
  activeExtractions++;
  activeSources.set(context.db, active);
  try {
    return await extractSourceStep(context);
  } finally {
    active.delete(key);
    activeExtractions--;
  }
}
let workerQueue: Promise<unknown> = Promise.resolve();
let queuedRasterJobs = 0;
/** One local raster worker globally. Never allow an HTTP burst to spawn unbounded OCR. */
export function runSourceRasterWorker(
  bytes: Uint8Array,
  page: number,
  native: LocatedNativeText[],
  assertRunning: () => void = () => {},
): Promise<SourceOcrResult> {
  if (queuedRasterJobs >= 2)
    return Promise.reject(
      new HttpError(
        429,
        'SOURCE_EXTRACTION_BUSY',
        'Local extraction capacity is busy. Try again shortly.',
      ),
    );
  queuedRasterJobs++;
  const run = workerQueue
    .catch(() => {})
    .then(
      () =>
        new Promise<SourceOcrResult>((resolve, reject) => {
          assertRunning();
          const worker = fork(new URL('./intake-source-worker.ts', import.meta.url), [], {
            serialization: 'advanced',
            execArgv: ['--max-old-space-size=256'],
            detached: true,
            env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', OMP_THREAD_LIMIT: '1' },
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          });
          let settled = false;
          const stop = () => {
            try {
              if (worker.pid) process.kill(-worker.pid, 'SIGKILL');
            } catch {
              worker.kill('SIGKILL');
            }
          };
          const finish = (error?: Error, result?: SourceOcrResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            clearInterval(poll);
            stop();
            if (error) reject(error);
            else resolve(result!);
          };
          const timeout = setTimeout(() => finish(Error('SOURCE_RASTER_TIMEOUT')), 75_000);
          const poll = setInterval(() => {
            try {
              assertRunning();
            } catch (error) {
              finish(error instanceof Error ? error : Error('SOURCE_CANCELLED'));
            }
          }, 100);
          worker.on('message', (message: { error?: string; result?: SourceOcrResult }) => {
            try {
              assertRunning();
            } catch (error) {
              finish(error instanceof Error ? error : Error('SOURCE_CANCELLED'));
              return;
            }
            if (message.error || !message.result)
              finish(Error(message.error || 'SOURCE_RASTER_FAILED'));
            else finish(undefined, message.result);
          });
          worker.on('error', () => finish(Error('SOURCE_RASTER_UNAVAILABLE')));
          worker.on('exit', () => {
            if (!settled) finish(Error('SOURCE_RASTER_FAILED'));
          });
          worker.send({ bytes, page, native }, (error) => {
            if (error) finish(Error('SOURCE_RASTER_FAILED'));
          });
        }),
    );
  const tracked = run.finally(() => {
    queuedRasterJobs--;
  });
  workerQueue = tracked;
  return tracked;
}
function pending(page: number): SourceTextIssue {
  return {
    id: `p${page}-pending`,
    region: { page },
    kind: 'coverage',
    status: 'open',
    detail: 'Extraction of this source scope is pending. It has not been inspected.',
  };
}
function replacePage(
  evidence: SourceTextEvidence,
  page: number,
  partial: Pick<SourceTextEvidence, 'spans' | 'issues'>,
  width?: number,
  height?: number,
  disposition: 'partial' | 'extracted' | 'unsupported' = 'partial',
) {
  return {
    ...evidence,
    pages: evidence.pages.map((p) =>
      p.page === page ? { page, width, height, disposition, inspected: false } : p,
    ),
    spans: [...evidence.spans.filter((s) => s.region.page !== page), ...partial.spans],
    issues: [...evidence.issues.filter((i) => i.region.page !== page), ...partial.issues],
    relations: evidence.relations.filter(
      (r) =>
        !evidence.spans.some((s) => s.region.page === page && (s.id === r.from || s.id === r.to)),
    ),
  } satisfies SourceTextEvidence;
}
export function sourceTextExtractionPending(source: IntakeSourceText) {
  return source.status === 'unavailable' || source.revision.issues.some(isPending);
}
function isPending(issue: SourceTextIssue) {
  return /^p\d+-pending$/.test(issue.id) && ['open', 'later'].includes(issue.status);
}
/** A bounded, resumable extraction step. Every publication is an immutable version;
 * no provider call, acceptance, or model-derived completeness claim occurs here. */
async function extractSourceStep({
  db,
  root,
  profileId,
  id,
  assertRunning = () => {},
  maxPages = 2,
}: ExtractionContext) {
  assertRunning();
  const original = getRetainedIntakeOriginalReference(db, root, profileId, id);
  let current = getIntakeSourceText(db, root, profileId, id);
  const limit = Math.min(10, Math.max(1, Math.trunc(maxPages) || 2));
  const publish = (evidence: SourceTextEvidence) => {
    assertRunning();
    current = publishIntakeSourceText(db, root, profileId, id, {
      operationId: randomUUID(),
      expectedRevisionId: current.revision?.id || null,
      sourceHash: original.sourceHash,
      evidence,
    });
  };
  const retainedOnly = isRetainOnlyIntake(original);
  const pdf = original.mimeType === 'application/pdf',
    image = ['image/png', 'image/jpeg', 'image/webp'].includes(original.mimeType);
  if (current.status === 'unavailable') {
    if (retainedOnly || original.mimeType === 'application/zip') {
      publish({
        adapter: ADAPTER,
        pages: [{ page: 1, disposition: 'unsupported', inspected: false }],
        spans: [],
        relations: [],
        issues: [
          {
            id: 'p1-unsupported',
            region: { page: 1 },
            kind: 'unsupported',
            status: 'open',
            detail: retainedOnly
              ? 'This format is retain-only. No text or clinical interpretation was attempted.'
              : 'Package members are accounted by the existing package inventory. Extract each retained readable member separately; the ZIP itself is not text.',
          },
        ],
      });
      return { sourceText: current, morePending: false, processedPages: 0 };
    }
    let pages = 1;
    if (pdf) pages = (await indexPdfEvidence({ ...original, profileId }, assertRunning)).pages;
    else if (!image) {
      const window = readIntake(db, root, profileId, id, { limit: TEXT_WINDOW });
      pages = Math.max(1, Math.ceil((window.totalCharacters || 0) / TEXT_WINDOW));
    }
    publish({
      adapter: ADAPTER,
      pages: Array.from({ length: pages }, (_, i) => ({
        page: i + 1,
        disposition: 'partial',
        inspected: false,
      })),
      spans: [],
      relations: [],
      issues: Array.from({ length: pages }, (_, i) => pending(i + 1)),
    });
  }
  if (current.status !== 'available') throw Error('SOURCE_TEXT_PUBLICATION_FAILED');
  const protectedPages = new Set(current.revision.protectedPages);
  const blockedByReview = current.revision.issues.some(
    (i) => isPending(i) && protectedPages.has(i.region.page),
  );
  const pages = current.revision.issues
    .filter((i) => isPending(i) && !protectedPages.has(i.region.page))
    .map((i) => i.region.page)
    .slice(0, limit);
  let processedPages = 0;
  for (const page of pages) {
    assertRunning();
    let evidence = current.revision as SourceTextEvidence;
    if (pdf || image) {
      let bytes: Uint8Array,
        native: LocatedNativeText[] = [];
      try {
        if (pdf) {
          const result = await readPdfEvidencePage(
            { ...original, profileId },
            page,
            0,
            assertRunning,
          );
          bytes = result.image;
          native = result.locatedText || [];
          // Preserve native work before OCR dispatch. Keep pending so an interrupted
          // OCR attempt can resume instead of silently appearing accounted.
          const partial = composeSourceReadings(page, native, []);
          partial.issues.push(pending(page));
          publish(replacePage(evidence, page, partial, result.width, result.height));
          evidence = current.revision!;
        } else bytes = getIntakeOriginal(db, root, profileId, id).bytes;
        const result = await runSourceRasterWorker(bytes, page, native, assertRunning);
        publish(replacePage(evidence, page, result, result.width, result.height));
      } catch (error) {
        assertRunning(); // Cancellation never converts pending work into a terminal exception.
        const code =
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : 'SOURCE_EXTRACTION_FAILED';
        const partial = composeSourceReadings(page, native, []);
        partial.issues.push({
          id: `p${page}-failed`,
          region: { page },
          kind: 'unreadable',
          status: 'open',
          detail: `This page could not be fully extracted (${code}). The original and any native text remain available for review.`,
        });
        // Never swallow a stale or integrity publication error by publishing another snapshot.
        if (
          error instanceof HttpError &&
          (error.code.startsWith('SOURCE_TEXT_') ||
            error.code === 'SOURCE_CHANGED' ||
            error.code === 'SOURCE_EXTRACTION_BUSY')
        )
          throw error;
        publish(replacePage(evidence, page, partial));
      }
    } else {
      const window = readIntake(db, root, profileId, id, {
        offset: (page - 1) * TEXT_WINDOW,
        limit: TEXT_WINDOW,
      });
      const structured = ['application/json', 'application/x-ndjson'].includes(original.mimeType);
      if (window.text === null) {
        publish(
          replacePage(
            evidence,
            page,
            {
              spans: [],
              issues: [
                {
                  id: `p${page}-unsupported`,
                  region: { page },
                  kind: 'unsupported',
                  status: 'open',
                  detail:
                    'No supported text decoder for this source. The original is retained; no successful extraction is claimed.',
                },
              ],
            },
            undefined,
            undefined,
            'unsupported',
          ),
        );
      } else {
        publish(
          replacePage(
            evidence,
            page,
            {
              spans: [
                {
                  id: `p${page}-literal`,
                  text: window.text,
                  region: { page },
                  provenance: structured ? 'structured' : 'native',
                },
              ],
              issues: [
                {
                  id: `p${page}-literal-review`,
                  region: { page },
                  kind: 'structure',
                  status: 'open',
                  detail:
                    'The original wording is retained, including administrative text and unrecognized fields. Check reading order and relationships before confirming this section.',
                },
              ],
            },
            undefined,
            undefined,
            'extracted',
          ),
        );
      }
    }
    processedPages++;
  }
  return {
    sourceText: current,
    morePending: sourceTextExtractionPending(current),
    processedPages,
    blockedByReview,
  };
}
