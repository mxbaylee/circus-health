/** Counts-only T17 Part A reducer. Never serializes input strings or error details. */
import { readFileSync } from 'node:fs';

type Row = Record<string, unknown>;
const object = (v: unknown): Row =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
const count = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const ratio = (n: number, d: number) => (d ? n / d : null);

export function libraryCounts(input: unknown) {
  const envelope = object(input);
  if (envelope.format !== 'circus-import-diagnostics-v1') throw new Error('invalid_export');
  const attribution = object(object(envelope.server).attribution);
  if (attribution.schemaVersion !== 1 || !Array.isArray(attribution.imports))
    throw new Error('attribution_unavailable');
  const histogram = { zero: 0, one: 0, twoToTen: 0, elevenTo200: 0, over200: 0 };
  let pages = 0,
    sourceWideScopes = 0,
    observed = 0,
    zero = 0,
    under50 = 0,
    unknown = 0,
    conflicting = 0,
    incompleteImports = 0,
    attempts = 0,
    inputTokens = 0,
    outputTokens = 0,
    completeUsageImports = 0,
    completeUsagePages = 0,
    completeInputTokens = 0,
    completeOutputTokens = 0,
    completeRequests = 0,
    completeRequestPages = 0,
    completeRequestImports = 0;
  for (const raw of attribution.imports) {
    const item = object(raw);
    if (!Array.isArray(item.pages)) throw new Error('invalid_export');
    let retained = 0;
    for (const rawPage of item.pages) {
      const page = object(rawPage);
      if (page.page === null) {
        sourceWideScopes++;
        continue;
      }
      if (!count(page.page) || page.page < 1) throw new Error('invalid_export');
      retained++;
      if (page.textLayerCountStatus === 'conflicting') conflicting++;
      else if (page.textLayerCountStatus === 'observed' && count(page.textLayerCharacters)) {
        observed++;
        if (page.textLayerCharacters === 0) zero++;
        if (page.textLayerCharacters < 50) under50++;
      } else unknown++;
    }
    pages += retained;
    if (!retained) histogram.zero++;
    else if (retained === 1) histogram.one++;
    else if (retained <= 10) histogram.twoToTen++;
    else if (retained <= 200) histogram.elevenTo200++;
    else histogram.over200++;
    const totals = object(item.requestTotals);
    const historyComplete = item.truncated === false && item.historicalReadsUnknown === false;
    if (!historyComplete) incompleteImports++;
    if (count(totals.attempts)) attempts += totals.attempts;
    if (count(totals.measuredInputTokens)) inputTokens += totals.measuredInputTokens;
    if (count(totals.measuredOutputTokens)) outputTokens += totals.measuredOutputTokens;
    if (historyComplete && count(totals.attempts) && retained > 0) {
      completeRequests += totals.attempts;
      completeRequestPages += retained;
      completeRequestImports++;
    }
    if (
      historyComplete &&
      totals.usageComplete === true &&
      count(totals.measuredInputTokens) &&
      count(totals.measuredOutputTokens) &&
      retained > 0
    ) {
      completeUsageImports++;
      completeUsagePages += retained;
      completeInputTokens += totals.measuredInputTokens;
      completeOutputTokens += totals.measuredOutputTokens;
    }
  }
  return {
    format: 'circus-processing-library-counts-v1',
    scope: 'retained_numbered_page_scopes_not_verified_original_page_totals',
    measurements: {
      selectedImports: attribution.imports.length,
      retainedNumberedPageScopes: pages,
      sourceWideScopes,
      retainedPageScopesPerImportHistogram: histogram,
      observedTextPages: observed,
      zeroTextPages: zero,
      under50TextPages: under50,
      unknownTextPages: unknown,
      conflictingTextPages: conflicting,
      zeroTextShareOfObserved: ratio(zero, observed),
      under50TextShareOfObserved: ratio(under50, observed),
      incompleteImports,
      exportPartial: object(attribution.exportBounds).partial !== false,
      omittedImports: count(attribution.omittedImports) ? attribution.omittedImports : null,
      canonicalTrackedRequests: attempts,
      reportedInputTokens: inputTokens,
      reportedOutputTokens: outputTokens,
      completeRequestImports,
      completeRequestPages,
      requestsPerRetainedPageScope: ratio(completeRequests, completeRequestPages),
      completeUsageImports,
      completeUsagePages,
      inputTokensPerRetainedPageScope: ratio(completeInputTokens, completeUsagePages),
      outputTokensPerRetainedPageScope: ratio(completeOutputTokens, completeUsagePages),
    },
    unknowns: [
      'original_page_totals_and_unrepresented_pages',
      'whole_library_distribution_beyond_export_selection',
      'source_type_size_and_overlap',
      'usage_for_unreported_attempts',
    ],
  };
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error('invalid_arguments');
    console.log(
      JSON.stringify(libraryCounts(JSON.parse(readFileSync(process.argv[2]!, 'utf8'))), null, 2),
    );
  } catch {
    // JSON parse and filesystem errors can contain private values and paths.
    console.error(
      'Counts unavailable: invalid arguments, unreadable export, or unsupported diagnostics.',
    );
    process.exitCode = 1;
  }
}
