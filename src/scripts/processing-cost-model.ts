/**
 * Structural cost model for the processing strategies compared in
 * docs/processing-context-proposal.md. It estimates request counts, the
 * sequential critical path, input and output tokens, and the Resume clicks the
 * current job limits would demand, for any page count and record density.
 *
 * This is a model, not a measurement. Defaults are calibrated to the offline
 * receipts named in the proposal; every parameter can be overridden, and a
 * harness measurement supersedes any figure printed here. Direction (which
 * strategy sends more) is robust to the parameters; magnitude is not.
 */

export interface CostParams {
  /** First request of a fresh session, in characters (observed 46k–65k). */
  freshRequestChars: number;
  /** Residual history added per executed call at unit size 1, 2 and 10 (fitted). */
  residualCharsU1: number;
  residualCharsU2: number;
  residualCharsU10: number;
  /** Candidate B hypothesis: call metadata and receipts only. */
  boundedResidualChars: number;
  /** Candidate H: schema once in the prefix plus conversion-only tools, saved per later request. */
  hygieneSavedChars: number;
  systemChars: number;
  schemaChars: number;
  seedChars: number;
  /** Host-pushed request framing beyond system, schema and seed. */
  pushFramingChars: number;
  pageTextChars: number;
  pageMetaChars: number;
  /** Media tokens per page exposure; unknown until T11, so 0 by default. */
  mediaTokensPerPage: number;
  /** Page exposures per page in session strategies (newest two groups stay exact). */
  sessionMediaExposures: number;
  charsPerToken: number;
  outputTokensPerRecord: number;
  outputTokensPerRequest: number;
  /** Route output cap; unknown, assumed. Records per publication = min(50, cap / per record). */
  outputCapTokens: number;
  /** Executed calls per fresh session (64 rounds less the final acknowledgement). */
  sessionCalls: number;
  /** Candidate I: executed calls per session when session length is the variable. */
  shortSessionCalls: number;
  /** Candidate D: share of pages dense enough to take unit size 2 rather than 10. */
  denseShare: number;
  /** Candidate J: largest source sent as one host-pushed request. */
  singleShotMaxPages: number;
  /** Candidate K: stage-one prompt, stage-one facts per page, stage-two window and carry. */
  stageOnePromptChars: number;
  stageOneFactTokensPerPage: number;
  stageTwoWindowPages: number;
  stageTwoCarryChars: number;
  /** Candidate L: re-export share matching an earlier import, and the audited share of it. */
  duplicateShare: number;
  auditShare: number;
  /** Parallel workers for E and F, and seam pages each extra worker re-reads. */
  workers: number;
  seamPages: number;
  /** Cost of a cached input token relative to an uncached one; 1 means caching off. */
  cachedTokenCost: number;
  /** Current job limits, used only to count the Resume clicks they would demand. */
  jobRequestLimit: number;
  jobTokenLimit: number;
  jobSliceLimit: number;
  /** Records per page in a multi-record scenario. */
  recordsPerPage: number;
  /**
   * Tokens a subscription usage or rate window allows per hour; unknown until T20, so 0
   * (not modeled). When set, tokens become hours of window time, which is how token volume
   * still costs time once token spend itself is not a constraint.
   */
  usageTokensPerHour: number;
}

export const DEFAULT_COST_PARAMS: Readonly<CostParams> = Object.freeze({
  freshRequestChars: 55_000,
  residualCharsU1: 13_300,
  residualCharsU2: 23_400,
  residualCharsU10: 11_100,
  boundedResidualChars: 2_000,
  hygieneSavedChars: 34_000,
  systemChars: 28_250,
  schemaChars: 22_739,
  seedChars: 10_000,
  pushFramingChars: 3_000,
  pageTextChars: 3_000,
  pageMetaChars: 1_000,
  mediaTokensPerPage: 0,
  sessionMediaExposures: 2,
  charsPerToken: 4,
  outputTokensPerRecord: 329,
  outputTokensPerRequest: 150,
  outputCapTokens: 16_384,
  sessionCalls: 63,
  shortSessionCalls: 16,
  denseShare: 0.5,
  singleShotMaxPages: 10,
  stageOnePromptChars: 8_000,
  stageOneFactTokensPerPage: 300,
  stageTwoWindowPages: 3,
  stageTwoCarryChars: 2_000,
  duplicateShare: 0.9,
  auditShare: 0.05,
  workers: 3,
  seamPages: 1,
  cachedTokenCost: 1,
  jobRequestLimit: 2_048,
  jobTokenLimit: 20_000_000,
  jobSliceLimit: 16,
  recordsPerPage: 4,
  usageTokensPerHour: 0,
});

export interface Scenario {
  pages: number;
  records: number;
  shape: 'single' | 'multi';
}

export interface CostEstimate {
  requests: number;
  /** Sequential requests on the longest worker lane. */
  criticalPath: number;
  inputChars: number;
  /** Characters identical to an earlier request's prefix, and so cacheable. */
  sharedChars: number;
  peakRequestChars: number;
  mediaPageExposures: number;
  outputTokens: number;
  /** Fresh sessions or reading slices, for the current slice limit. */
  slices: number;
}

export interface CostSummary extends CostEstimate {
  inputTokens: number;
  effectiveInputTokens: number;
  totalTokens: number;
  /** Resume clicks the current job limits would demand; unattended continuation makes this 0. */
  resumes: number;
  /** Hours of usage-window time the tokens need; null when the window is not modeled. */
  windowHours: number | null;
}

export interface Strategy {
  id: string;
  label: string;
  unattended?: boolean;
  estimate(scenario: Scenario, params: CostParams): CostEstimate;
}

const empty = (): CostEstimate => ({
  requests: 0,
  criticalPath: 0,
  inputChars: 0,
  sharedChars: 0,
  peakRequestChars: 0,
  mediaPageExposures: 0,
  outputTokens: 0,
  slices: 0,
});

function add(a: CostEstimate, b: CostEstimate): CostEstimate {
  return {
    requests: a.requests + b.requests,
    criticalPath: a.criticalPath + b.criticalPath,
    inputChars: a.inputChars + b.inputChars,
    sharedChars: a.sharedChars + b.sharedChars,
    peakRequestChars: Math.max(a.peakRequestChars, b.peakRequestChars),
    mediaPageExposures: a.mediaPageExposures + b.mediaPageExposures,
    outputTokens: a.outputTokens + b.outputTokens,
    slices: a.slices + b.slices,
  };
}

const recordsPerPublication = (p: CostParams) =>
  Math.max(1, Math.min(50, Math.floor(p.outputCapTokens / p.outputTokensPerRecord)));

/** Records in each unit: evenly spread for multi-record, all in the last unit for single. */
function unitRecords(s: Scenario, unitPages: number[]): number[] {
  if (s.shape === 'single') return unitPages.map((_, i) => (i === unitPages.length - 1 ? 1 : 0));
  return unitPages.map((pages) => (s.records * pages) / s.pages);
}

function splitUnits(pages: number, unitSize: number): number[] {
  const units: number[] = [];
  for (let start = 0; start < pages; start += unitSize)
    units.push(Math.min(unitSize, pages - start));
  return units;
}

const publications = (records: number, p: CostParams) =>
  Math.max(1, Math.ceil(records / recordsPerPublication(p)));

function residualFor(unitSize: number, p: CostParams): number {
  if (unitSize <= 1) return p.residualCharsU1;
  if (unitSize <= 2) return p.residualCharsU2;
  return p.residualCharsU10;
}

/**
 * Model-driven sessions: each executed call adds `residual` characters of history
 * until a fresh session starts. Request j of a session is `fresh + residual·j`.
 */
function sessions(
  calls: number,
  residual: number,
  p: CostParams,
  opts: { hygiene?: boolean; callsPerSession?: number } = {},
): CostEstimate {
  const perSession = opts.callsPerSession ?? p.sessionCalls;
  const saved = opts.hygiene ? p.hygieneSavedChars : 0;
  const out = empty();
  for (let remaining = calls; remaining > 0; remaining -= perSession) {
    const executed = Math.min(perSession, remaining);
    let previous = 0;
    for (let j = 0; j <= executed; j++) {
      const size = p.freshRequestChars + residual * j - (j > 0 ? saved : 0);
      out.inputChars += size;
      out.sharedChars += Math.min(previous, size);
      out.peakRequestChars = Math.max(out.peakRequestChars, size);
      previous = size;
    }
    out.requests += executed + 1;
    out.slices++;
  }
  out.criticalPath = out.requests;
  out.outputTokens = out.requests * p.outputTokensPerRequest;
  return out;
}

/** Current schedule: one read per page, one publication per unit (more past the output cap), plan and finish. */
function currentCalls(s: Scenario, unitSize: number, p: CostParams): number {
  const units = splitUnits(s.pages, unitSize);
  const pubs = unitRecords(s, units).reduce((sum, r) => sum + publications(r, p), 0);
  return s.pages + pubs + 2;
}

function withRecords(e: CostEstimate, s: Scenario, p: CostParams): CostEstimate {
  return { ...e, outputTokens: e.outputTokens + s.records * p.outputTokensPerRecord };
}

function modelDriven(
  s: Scenario,
  p: CostParams,
  unitSize: number,
  opts: { residual?: number; hygiene?: boolean; callsPerSession?: number } = {},
): CostEstimate {
  const u = Math.min(unitSize, s.pages);
  const e = sessions(currentCalls(s, u, p), opts.residual ?? residualFor(u, p), p, opts);
  return withRecords({ ...e, mediaPageExposures: s.pages * p.sessionMediaExposures }, s, p);
}

/** Candidate G: the host sends each unit; the response is the publication. */
function hostPush(s: Scenario, p: CostParams, unitSize: number, pages = s.pages): CostEstimate {
  const base = p.systemChars + p.schemaChars + p.pushFramingChars + p.seedChars;
  const units = splitUnits(pages, Math.min(unitSize, pages));
  const records = unitRecords({ ...s, pages }, units);
  const out = empty();
  units.forEach((unitPages, i) => {
    const size = base + unitPages * (p.pageTextChars + p.pageMetaChars);
    const n = publications(records[i]!, p);
    out.requests += n;
    out.inputChars += size * n;
    out.sharedChars += out.requests > n ? base * n : base * (n - 1);
    out.peakRequestChars = Math.max(out.peakRequestChars, size);
    out.mediaPageExposures += unitPages * n;
  });
  out.criticalPath = out.requests;
  out.slices = Math.ceil(out.requests / (p.sessionCalls + 1));
  out.outputTokens = out.requests * p.outputTokensPerRequest;
  return withRecords(out, { ...s, records: records.reduce((a, b) => a + b, 0) }, p);
}

/** Candidates E and F: tokens never fall; the critical path divides across workers. */
function parallel(base: CostEstimate, workers: number, p: CostParams): CostEstimate {
  const w = Math.max(1, Math.min(workers, base.requests));
  const extraChars =
    (w - 1) * (p.freshRequestChars + p.seamPages * (p.pageTextChars + p.pageMetaChars));
  return {
    ...base,
    requests: base.requests + (w - 1),
    criticalPath: Math.ceil(base.requests / w) + (w > 1 ? 1 : 0),
    inputChars: base.inputChars + extraChars,
    mediaPageExposures: base.mediaPageExposures + (w - 1) * p.seamPages,
    outputTokens: base.outputTokens + (w - 1) * p.outputTokensPerRequest,
  };
}

/** Candidate A: a fresh bounded context per unit, model-driven reads inside it. */
function perUnit(s: Scenario, p: CostParams, unitSize: number): CostEstimate {
  const u = Math.min(unitSize, s.pages);
  let out = empty();
  for (const pages of splitUnits(s.pages, u))
    out = add(out, sessions(pages + 1, residualFor(u, p), p));
  return withRecords({ ...out, mediaPageExposures: s.pages * p.sessionMediaExposures }, s, p);
}

/** Candidate D: dense pages at unit size 2, sparse pages at 10, one blended residual. */
function adaptive(s: Scenario, p: CostParams): CostEstimate {
  const dense = Math.round(s.pages * p.denseShare);
  const sparse = s.pages - dense;
  const units = [...splitUnits(dense, 2), ...splitUnits(sparse, 10)];
  const records = unitRecords(s, units);
  const pubs = records.reduce((sum, r) => sum + publications(r, p), 0);
  const residual =
    (dense * residualFor(Math.min(2, dense), p) + sparse * residualFor(Math.min(10, sparse), p)) /
    s.pages;
  const e = sessions(s.pages + pubs + 2, residual, p);
  return withRecords({ ...e, mediaPageExposures: s.pages * p.sessionMediaExposures }, s, p);
}

/** Candidate K: stage one reads each page into compact located facts; stage two composes records. */
function twoStage(s: Scenario, p: CostParams): CostEstimate {
  const one = empty();
  for (let i = 0; i < s.pages; i++) {
    const size = p.stageOnePromptChars + p.pageTextChars + p.pageMetaChars;
    one.requests++;
    one.inputChars += size;
    if (i > 0) one.sharedChars += p.stageOnePromptChars;
    one.peakRequestChars = Math.max(one.peakRequestChars, size);
    one.mediaPageExposures++;
    one.outputTokens += p.stageOneFactTokensPerPage;
  }
  const two = empty();
  const base = p.systemChars + p.schemaChars;
  for (const pages of splitUnits(s.pages, p.stageTwoWindowPages)) {
    const size =
      base + p.stageTwoCarryChars + pages * p.stageOneFactTokensPerPage * p.charsPerToken;
    two.requests++;
    two.inputChars += size;
    if (two.requests > 1) two.sharedChars += base;
    two.peakRequestChars = Math.max(two.peakRequestChars, size);
    two.outputTokens += p.outputTokensPerRequest;
  }
  const out = add(one, two);
  out.criticalPath = out.requests;
  out.slices = Math.ceil(out.requests / (p.sessionCalls + 1));
  return withRecords(out, s, p);
}

/** Candidate L: exact or confirmed re-export matches are linked, a sample is audited, the rest pushed. */
function reexport(s: Scenario, p: CostParams): CostEstimate {
  const matched = Math.round(s.pages * p.duplicateShare);
  const processed = s.pages - matched + Math.ceil(matched * p.auditShare);
  if (processed <= 0) return empty();
  const scaled = {
    ...s,
    records: s.shape === 'multi' ? (s.records * processed) / s.pages : s.records,
  };
  return hostPush(scaled, p, 10, processed);
}

export const STRATEGIES: readonly Strategy[] = [
  { id: '0', label: 'current, U=2', estimate: (s, p) => modelDriven(s, p, 2) },
  { id: '0b', label: 'current, U=10', estimate: (s, p) => modelDriven(s, p, 10) },
  { id: 'A', label: 'per-unit context, U=2', estimate: (s, p) => perUnit(s, p, 2) },
  {
    id: 'B',
    label: 'bounded sequential, U=2',
    estimate: (s, p) => modelDriven(s, p, 2, { residual: p.boundedResidualChars }),
  },
  {
    id: 'C',
    label: 'unattended continuation over 0',
    unattended: true,
    estimate: (s, p) => modelDriven(s, p, 2),
  },
  { id: 'D', label: 'adaptive spans (dense U=2, sparse U=10)', estimate: adaptive },
  {
    id: 'E',
    label: 'first/middle/last workers over 0',
    estimate: (s, p) => parallel(modelDriven(s, p, 2), p.workers, p),
  },
  {
    id: 'F',
    label: 'parallel windows over G, U=10',
    estimate: (s, p) => parallel(hostPush(s, p, 10), p.workers, p),
  },
  { id: 'G2', label: 'host-pushed units, U=2', estimate: (s, p) => hostPush(s, p, 2) },
  { id: 'G10', label: 'host-pushed units, U=10', estimate: (s, p) => hostPush(s, p, 10) },
  {
    id: 'H',
    label: 'prefix hygiene over 0',
    estimate: (s, p) => modelDriven(s, p, 2, { hygiene: true }),
  },
  {
    id: 'B+H',
    label: 'bounded sequential with hygiene, U=2',
    estimate: (s, p) => modelDriven(s, p, 2, { residual: p.boundedResidualChars, hygiene: true }),
  },
  {
    id: 'I',
    label: 'bounded, short sessions',
    estimate: (s, p) =>
      modelDriven(s, p, 2, {
        residual: p.boundedResidualChars,
        callsPerSession: p.shortSessionCalls,
      }),
  },
  {
    id: 'J',
    label: 'adapter: single shot up to the max, else G10',
    estimate: (s, p) => hostPush(s, p, s.pages <= p.singleShotMaxPages ? s.pages : 10),
  },
  { id: 'K', label: 'page read, then compaction', estimate: twoStage },
  {
    id: 'L',
    label: 're-export skip with audit, over G10 (withdrawn; comparison only)',
    estimate: reexport,
  },
];

export function summarize(strategy: Strategy, s: Scenario, p: CostParams): CostSummary {
  const e = strategy.estimate(s, p);
  const media = e.mediaPageExposures * p.mediaTokensPerPage;
  const inputTokens = e.inputChars / p.charsPerToken + media;
  const shared = e.sharedChars / p.charsPerToken;
  const effectiveInputTokens = inputTokens - shared + shared * p.cachedTokenCost;
  const totalTokens = inputTokens + e.outputTokens;
  const resumes = strategy.unattended
    ? 0
    : Math.max(
        0,
        Math.ceil(
          Math.max(
            e.requests / p.jobRequestLimit,
            totalTokens / p.jobTokenLimit,
            e.slices / p.jobSliceLimit,
          ),
        ) - 1,
      );
  const windowHours =
    p.usageTokensPerHour > 0
      ? (effectiveInputTokens + e.outputTokens) / p.usageTokensPerHour
      : null;
  return { ...e, inputTokens, effectiveInputTokens, totalTokens, resumes, windowHours };
}

export function scenario(pages: number, shape: Scenario['shape'], p: CostParams): Scenario {
  return { pages, shape, records: shape === 'single' ? 1 : pages * p.recordsPerPage };
}

export function parseArgs(argv: string[]): {
  pages: number[];
  shapes: Scenario['shape'][];
  strategies: string[] | null;
  format: 'table' | 'markdown' | 'json';
  params: CostParams;
} {
  const params: CostParams = { ...DEFAULT_COST_PARAMS };
  let pages = [1, 10, 200, 800];
  let shapes: Scenario['shape'][] = ['single', 'multi'];
  let strategies: string[] | null = null;
  let format: 'table' | 'markdown' | 'json' = 'table';
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i++;
    if (flag === '--pages') {
      pages = value.split(',').map(Number);
      if (pages.some((n) => !Number.isSafeInteger(n) || n < 1))
        throw new Error('--pages takes positive integers');
    } else if (flag === '--shape') {
      if (!['single', 'multi', 'both'].includes(value))
        throw new Error('--shape is single, multi or both');
      shapes = value === 'both' ? ['single', 'multi'] : [value as Scenario['shape']];
    } else if (flag === '--strategies') {
      strategies = value.split(',');
      const unknown = strategies.filter((id) => !STRATEGIES.some((s) => s.id === id));
      if (unknown.length) throw new Error(`Unknown strategies: ${unknown.join(', ')}`);
    } else if (flag === '--format') {
      if (!['table', 'markdown', 'json'].includes(value))
        throw new Error('--format is table, markdown or json');
      format = value as typeof format;
    } else if (flag === '--set') {
      const [key, raw] = value.split('=');
      if (!key || !(key in params)) throw new Error(`Unknown parameter: ${key}`);
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${key} needs a non-negative number`);
      params[key as keyof CostParams] = n;
    } else throw new Error(`Unknown flag: ${flag}`);
  }
  return { pages, shapes, strategies, format, params };
}

const fmt = (n: number) =>
  n >= 1e6
    ? (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M'
    : n >= 1e3
      ? Math.round(n / 1e3) + 'k'
      : String(Math.round(n));

export function rows(options: ReturnType<typeof parseArgs>) {
  const chosen = STRATEGIES.filter((s) => !options.strategies || options.strategies.includes(s.id));
  return options.pages.flatMap((pages) =>
    options.shapes.flatMap((shape) =>
      chosen.map((strategy) => {
        const sc = scenario(pages, shape, options.params);
        return {
          pages,
          shape,
          strategy: strategy.id,
          label: strategy.label,
          ...summarize(strategy, sc, options.params),
        };
      }),
    ),
  );
}

function main(argv: string[]): void {
  const options = parseArgs(argv);
  const result = rows(options);
  if (options.format === 'json') {
    console.log(JSON.stringify({ params: options.params, rows: result }, null, 2));
    return;
  }
  const display = result.map((r) => ({
    scenario: `${r.shape[0]!.toUpperCase()}${r.pages}`,
    strategy: r.strategy,
    requests: r.requests,
    critical: r.criticalPath,
    'input tok': fmt(r.inputTokens),
    'effective in': fmt(r.effectiveInputTokens),
    'output tok': fmt(r.outputTokens),
    'peak chars': fmt(r.peakRequestChars),
    resumes: r.resumes,
    ...(r.windowHours === null ? {} : { 'window h': r.windowHours.toFixed(1) }),
  }));
  if (options.format === 'table') {
    console.table(display);
    return;
  }
  const keys = Object.keys(display[0] ?? {});
  console.log(`| ${keys.join(' | ')} |\n| ${keys.map(() => '---').join(' | ')} |`);
  for (const row of display)
    console.log(`| ${keys.map((k) => row[k as keyof typeof row]).join(' | ')} |`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
