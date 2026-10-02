import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { cpus, platform, release, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { INTAKE_PDF_BOUNDS } from '../server/intake-files.ts';
import {
  disposePdfEvidenceSessions,
  indexPdfEvidence,
  pdfEvidenceSessionDiagnostics,
  readPdfEvidencePage,
  type PdfEvidencePage,
  type PdfNativeEvidencePage,
} from '../server/intake-pdf-session.ts';
import {
  fictionalPageKind,
  fictionalPageMarker,
  writeFictionalBenchmarkPdf,
  type FictionalPdfKind,
} from './fictional-pdf-benchmark-fixture.ts';

const pages = Number(process.env.CRS_PDF_BENCHMARK_PAGES || 100);
const targetBytes = Number(process.env.CRS_PDF_BENCHMARK_BYTES || 0);
const kind = process.env.CRS_PDF_BENCHMARK_FIXTURE || 'mixed';
const format = process.env.CRS_PDF_BENCHMARK_FORMAT || 'both';
const order = process.env.CRS_PDF_BENCHMARK_ORDER || 'pdf,image';
const keep = process.env.CRS_PDF_BENCHMARK_KEEP === '1';
const readAll = process.env.CRS_PDF_BENCHMARK_READ_ALL === '1';
if (
  !Number.isSafeInteger(pages) ||
  pages < 1 ||
  pages > INTAKE_PDF_BOUNDS.maxPages ||
  !Number.isSafeInteger(targetBytes) ||
  targetBytes < 0 ||
  targetBytes > 1024 ** 3 ||
  !['mixed', 'dense', 'scan', 'sparse'].includes(kind) ||
  !['pdf', 'image', 'both'].includes(format) ||
  !['pdf,image', 'image,pdf'].includes(order)
)
  throw new Error(
    'Choose PAGES=1..10000, optional BYTES=0..1073741824, FIXTURE=mixed|dense|scan|sparse, FORMAT=pdf|image|both, ORDER=pdf,image|image,pdf.',
  );

const execute = promisify(execFile);
const implementationHashes = () =>
  Object.fromEntries(
    [
      './benchmark-intake-pdf.ts',
      './fictional-pdf-benchmark-fixture.ts',
      './fictional-pdf-writer.ts',
      '../server/intake-pdf-native.ts',
      '../server/intake-pdf-worker.ts',
      '../server/intake-pdf-session.ts',
      '../server/intake-files.ts',
      '../server/intake-image.ts',
    ].map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(new URL(path, import.meta.url)))
        .digest('hex'),
    ]),
  );
const phaseKeys = [
  'queueWaitMs',
  'sessionSetupMs',
  'verifyMs',
  'textMs',
  'renderMs',
  'encodeMs',
  'nativePdfMs',
  'annotationMs',
] as const;
const memory = () => {
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
  return { rss, heapUsed, external, arrayBuffers };
};
const distribution = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    total,
    mean: values.length ? total / values.length : null,
    p50: sorted[Math.floor((sorted.length - 1) * 0.5)] ?? null,
    p95: sorted[Math.floor((sorted.length - 1) * 0.95)] ?? null,
    max: sorted.at(-1) ?? null,
  };
};

async function measure(
  source: {
    profileId: string;
    id: string;
    path: string;
    size: number;
    sourceHash: string;
    filename: string;
  },
  requestedFormat: 'pdf' | 'image',
  requestedPages: number[],
) {
  await disposePdfEvidenceSessions(source.profileId);
  const before = pdfEvidenceSessionDiagnostics();
  const baseline = memory(),
    parentPeak = { ...baseline };
  let processSamples = 0,
    processSampleErrors = 0,
    workerPeak = 0,
    nativePeak: number | null = null,
    treePeak = 0;
  let pendingSample: Promise<void> | null = null;
  const sample = async () => {
    const current = memory();
    for (const key of Object.keys(parentPeak) as (keyof typeof parentPeak)[])
      parentPeak[key] = Math.max(parentPeak[key], current[key]);
    const workerPid = pdfEvidenceSessionDiagnostics().activeWorkerPid;
    if (!workerPid || process.platform === 'win32') return;
    try {
      const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,rss='], {
        timeout: 2000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const rows = stdout
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/).map(Number));
      const included = new Set([workerPid]);
      for (let pass = 0; pass < 8; pass++)
        for (const [pid, ppid] of rows) if (included.has(ppid!)) included.add(pid!);
      const workerRss = (rows.find((row) => row[0] === workerPid)?.[2] || 0) * 1024;
      const children = rows.filter(([pid]) => pid !== workerPid && included.has(pid!));
      const nativeRss = children.reduce((sum, row) => sum + (row[2] || 0) * 1024, 0);
      processSamples++;
      workerPeak = Math.max(workerPeak, workerRss);
      if (children.length) nativePeak = Math.max(nativePeak || 0, nativeRss);
      treePeak = Math.max(treePeak, workerRss + nativeRss);
    } catch {
      processSampleErrors++;
    }
  };
  const sampler = setInterval(() => {
    if (!pendingSample)
      pendingSample = sample().finally(() => {
        pendingSample = null;
      });
  }, 100);
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  const started = performance.now();
  type Read = {
    page: number;
    kind: string;
    requestedFormat: string;
    actualFormat: string;
    milliseconds: number;
    failedNativeAttemptMs: number | null;
    fallbackCode: string | null;
    textCharacters: number;
    textCheck: boolean;
    pdfBytes: number | null;
    imageBytes: number | null;
    width: number | null;
    height: number | null;
    workerRssAfterRead: number | null;
    sessionNumber: number;
    recycledBeforeRead: boolean;
    phases: Partial<Record<(typeof phaseKeys)[number], number>>;
  };
  const reads: Read[] = [];
  try {
    const indexStarted = performance.now();
    const indexed = await indexPdfEvidence(source);
    const indexMs = performance.now() - indexStarted;
    if (indexed.pages !== pages) throw new Error('Fixture page count did not round-trip.');
    const indexMemory = pdfEvidenceSessionDiagnostics().lastWorkerMemory;
    for (const page of requestedPages) {
      const prior = pdfEvidenceSessionDiagnostics();
      const pageStarted = performance.now();
      let result: PdfEvidencePage | PdfNativeEvidencePage,
        fallbackCode: string | null = null,
        failedNativeAttemptMs: number | null = null;
      if (requestedFormat === 'pdf') {
        try {
          result = await readPdfEvidencePage(source, page, 0, undefined, { format: 'pdf' });
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (!code || !['PDF_NATIVE_PAGE_LIMIT', 'PDF_NATIVE_UNSUPPORTED'].includes(code))
            throw error;
          failedNativeAttemptMs = performance.now() - pageStarted;
          fallbackCode = code;
          result = await readPdfEvidencePage(source, page, 0);
        }
      } else result = await readPdfEvidencePage(source, page, 0);
      const milliseconds = performance.now() - pageStarted;
      const state = pdfEvidenceSessionDiagnostics();
      const pageKind = fictionalPageKind(kind as FictionalPdfKind, page);
      const textCheck =
        pageKind === 'scan'
          ? result.totalCharacters === 0
          : result.text.includes(fictionalPageMarker(page, pages));
      if (!textCheck) throw new Error(`Fictional text-layer expectation failed at page ${page}.`);
      reads.push({
        page,
        kind: pageKind,
        requestedFormat,
        actualFormat: 'pdf' in result ? 'pdf' : 'image',
        milliseconds,
        failedNativeAttemptMs,
        fallbackCode,
        textCharacters: result.totalCharacters,
        textCheck,
        pdfBytes: 'pdf' in result ? result.pdf.byteLength : null,
        imageBytes: 'image' in result ? result.image.byteLength : null,
        width: 'width' in result ? result.width : null,
        height: 'height' in result ? result.height : null,
        workerRssAfterRead: state.lastWorkerMemory?.rss ?? null,
        sessionNumber: state.sessionsCreated - before.sessionsCreated,
        recycledBeforeRead: state.sessionsRecycled > prior.sessionsRecycled,
        phases: {
          queueWaitMs: result.queueWaitMs,
          sessionSetupMs: result.sessionSetupMs,
          ...result.timings,
        },
      });
    }
    clearInterval(sampler);
    await pendingSample;
    await sample();
    const state = pdfEvidenceSessionDiagnostics();
    const byKind = Object.fromEntries(
      ['dense', 'scan', 'sparse'].map((pageKind) => {
        const selected = reads.filter((read) => read.kind === pageKind);
        return [
          pageKind,
          {
            wallMs: distribution(selected.map((read) => read.milliseconds)),
            pdfBytes: distribution(
              selected.flatMap((read) => (read.pdfBytes === null ? [] : [read.pdfBytes])),
            ),
            imageBytes: distribution(
              selected.flatMap((read) => (read.imageBytes === null ? [] : [read.imageBytes])),
            ),
          },
        ];
      }),
    );
    return {
      requestedFormat,
      totalMs: performance.now() - started,
      indexMs,
      pageReads: reads,
      wallMs: distribution(reads.map((read) => read.milliseconds)),
      phases: Object.fromEntries(
        phaseKeys.map((key) => [
          key,
          distribution(
            reads.flatMap((read) => (read.phases[key] === undefined ? [] : [read.phases[key]!])),
          ),
        ]),
      ),
      byKind,
      nativePages: reads.filter((read) => read.actualFormat === 'pdf').length,
      fallbackPages: reads.filter((read) => read.fallbackCode).length,
      parser: {
        sessionsCreated: state.sessionsCreated - before.sessionsCreated,
        sessionsReused: state.sessionsReused - before.sessionsReused,
        sessionsRecycled: state.sessionsRecycled - before.sessionsRecycled,
        indexWorkerMemory: indexMemory,
        lastWorkerMemory: state.lastWorkerMemory,
        workerRssAfterRead: distribution(
          reads.flatMap((read) =>
            read.workerRssAfterRead === null ? [] : [read.workerRssAfterRead],
          ),
        ),
      },
      memory: {
        parentBaseline: baseline,
        parentSampledPeak: parentPeak,
        workerSampledRssPeak: workerPeak || null,
        nativeChildrenSampledRssPeak: nativePeak,
        pdfProcessTreeSampledRssPeak: treePeak || null,
        processSamples,
        processSampleErrors,
      },
      eventLoopDelayMs: {
        mean: Number.isFinite(eventLoop.mean) ? eventLoop.mean / 1e6 : null,
        max: eventLoop.max / 1e6,
        p99: eventLoop.percentile(99) / 1e6,
      },
      checks: {
        exactPageCount: indexed.pages === pages,
        expectedTextLayers: reads.every((read) => read.textCheck),
        boundedOutput: reads.every(
          (read) =>
            (read.pdfBytes ?? 0) <= INTAKE_PDF_BOUNDS.maxNativePdfBytes &&
            (read.imageBytes ?? 0) <= INTAKE_PDF_BOUNDS.maxImageBytes,
        ),
      },
    };
  } finally {
    clearInterval(sampler);
    await pendingSample;
    eventLoop.disable();
    await disposePdfEvidenceSessions(source.profileId);
  }
}

const directory = mkdtempSync(resolve(tmpdir(), 'circus-fictional-pdf-benchmark-'));
const path = resolve(directory, 'fictional-generated-benchmark.pdf');
try {
  const implementationBefore = implementationHashes();
  const generationStarted = performance.now();
  const fixture = writeFictionalBenchmarkPdf(path, pages, kind as FictionalPdfKind, targetBytes);
  const generationMs = performance.now() - generationStarted;
  const source = {
    profileId: 'fictional-benchmark-profile',
    id: 'fictional-benchmark-source',
    path,
    size: fixture.bytes,
    sourceHash: fixture.sourceHash,
    filename: 'fictional-generated-benchmark.pdf',
  };
  const selected = readAll
    ? Array.from({ length: pages }, (_, index) => index + 1)
    : [...new Set([1, Math.ceil(pages / 2), pages])];
  const formats = (format === 'both' ? order.split(',') : [format]) as ('pdf' | 'image')[];
  const runs = [];
  for (const selectedFormat of formats) runs.push(await measure(source, selectedFormat, selected));
  const implementationAfter = implementationHashes();
  process.stdout.write(
    JSON.stringify(
      {
        format: 'circus-fictional-pdf-benchmark-v2',
        fixture: {
          fictional: true,
          kind,
          pages,
          ...fixture,
          generationMs,
          readAllPages: readAll,
          sampledPages: selected,
        },
        environment: {
          node: process.version,
          platform: platform(),
          release: release(),
          architecture: process.arch,
          cpuCount: cpus().length,
        },
        formatOrder: formats,
        implementation: {
          before: implementationBefore,
          after: implementationAfter,
          unchangedDuringRun:
            JSON.stringify(implementationBefore) === JSON.stringify(implementationAfter),
        },
        bounds: INTAKE_PDF_BOUNDS,
        notes: [
          'Independently fictional dense text/vector pages and/or scan-like raster pages; not representative clinical content or model fidelity evidence.',
          'Both passes use identical source bytes and fresh worker sessions. Filesystem caches are not cleared; parent allocator state persists. Reverse ORDER to inspect order effects.',
          'Wall timings include sampling overhead. RSS is sampled every 100ms using ps; peaks are lower bounds. Native child samples can miss short processes. Worker diagnostic RSS is after operations only.',
          'Index time includes cold worker setup and full-file verification. Page sessionSetupMs covers later reuse/recycling. Native fallbacks retain their failed-attempt wall time separately.',
          'Timing phases are nested, not additive: encodeMs is included in renderMs; sessionSetupMs may include cold verification. Compare total wall time without summing all phase totals.',
          'No model, network, base64 transport, upload/vault work, or journal persistence is measured. No provider acceptance, token savings, or 100-page unattended completion is implied.',
          'Optional byte padding is an unreferenced stream; its bytes add source verification cost, not page complexity.',
        ],
        runs,
        ...(keep ? { temporaryFixturePath: path } : {}),
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await disposePdfEvidenceSessions('fictional-benchmark-profile');
  if (!keep) rmSync(directory, { recursive: true, force: true });
}
