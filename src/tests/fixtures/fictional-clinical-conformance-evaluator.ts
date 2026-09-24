import { isDeepStrictEqual } from 'node:util';
import type { HealthRecordEnvelope, IntakeClinicalMapping } from '../../shared/intake.ts';
import { evaluateImportGroundTruth } from './import-ground-truth-evaluator.ts';
import {
  FICTIONAL_CLINICAL_CONFORMANCE_ASSET,
  FICTIONAL_CLINICAL_CONFORMANCE_GROUND_TRUTH,
  FICTIONAL_CLINICAL_CONFORMANCE_REPEATED,
  FICTIONAL_CLINICAL_CONFORMANCE_STABLE_IDS,
} from './fictional-clinical-conformance-ground-truth.ts';
import { CLINICAL_CONFORMANCE_AMBIGUITY_ANCHOR } from './fictional-clinical-conformance-source-generator.ts';

export type FictionalClinicalConformanceEnvelope = HealthRecordEnvelope & {
  clinical?: IntakeClinicalMapping;
  reviewIssues?: Array<{
    kind?: unknown;
    field?: unknown;
    textAnchor?: unknown;
    choices?: unknown;
  }>;
};

export type FictionalClinicalConformanceGrade = {
  passed: boolean;
  failures: string[];
  stableCount: number;
  repeatedCount: number;
  clinicalCount: number;
};

export type FictionalClinicalConformanceOptions = {
  /** Exact profile-bound original source-file ID from the frozen host snapshot. */
  originalSourceFileId?: string;
};

const stableIds = new Set<string>(FICTIONAL_CLINICAL_CONFORMANCE_STABLE_IDS);
const repeatedTruth = new Map<string, (typeof FICTIONAL_CLINICAL_CONFORMANCE_REPEATED)[number]>(
  FICTIONAL_CLINICAL_CONFORMANCE_REPEATED.map((record) => [record.testLabel, record]),
);

const pageToken = /(?:^|[^A-Za-z0-9])(?:page|p\.)[\s#:._=-]*([0-9]+)(?![0-9])/gi;
const additionalPageAfter =
  /^\s*(?:[-–—/,]|&|\b(?:to|through|and|or|vs\.?)\b)\s*(?:(?:page|p\.)[\s#:._=-]*)?[0-9]+/i;

function exactPrintedLabel(locator: string, label: string): boolean {
  for (let index = locator.indexOf(label); index >= 0; index = locator.indexOf(label, index + 1)) {
    const before = locator[index - 1];
    const after = locator[index + label.length];
    if ((!before || !/[A-Za-z0-9]/.test(before)) && (!after || !/[A-Za-z0-9]/.test(after)))
      return true;
  }
  return false;
}

function directlyNegatesOccurrence(locator: string, label: string): boolean {
  for (let index = locator.indexOf(label); index >= 0; index = locator.indexOf(label, index + 1)) {
    const before = locator[index - 1];
    const after = locator[index + label.length];
    if ((before && /[A-Za-z0-9]/.test(before)) || (after && /[A-Za-z0-9]/.test(after))) continue;
    const prefix = locator.slice(Math.max(0, index - 32), index);
    const suffix = locator.slice(index + label.length);
    if (/(?:^|[^A-Za-z0-9])not[\s:;,|()[\]–—-]*$/i.test(prefix)) return true;
    if (
      /^[\s:;,|()[\]–—-]*(?:is\s+)?not\s+(?:(?:on|at|in)\s+)?(?:the\s+)?(?:page\b|p\.(?=[\s#:._=-]*[0-9]))/i.test(
        suffix,
      )
    )
      return true;
  }
  return false;
}

function repeatedOccurrencePage(locator: unknown, label: string): number | null {
  if (
    typeof locator !== 'string' ||
    !exactPrintedLabel(locator, label) ||
    directlyNegatesOccurrence(locator, label)
  )
    return null;
  const pages = new Set<number>();
  for (const match of locator.matchAll(pageToken)) {
    const page = Number(match[1]);
    if (!Number.isSafeInteger(page) || page < 1 || page > 4) return null;
    const suffix = locator.slice((match.index || 0) + match[0].length);
    if (additionalPageAfter.test(suffix)) return null;
    pages.add(page);
  }
  return pages.size === 1 ? [...pages][0]! : null;
}

function clinical(value: HealthRecordEnvelope): value is FictionalClinicalConformanceEnvelope {
  return !!value.clinical && typeof value.clinical === 'object' && !Array.isArray(value.clinical);
}

/** Fixture-local proposal grader. It does not read, generate or accept source data. */
export function evaluateFictionalClinicalConformanceProposal(
  envelopes: HealthRecordEnvelope[],
  options: FictionalClinicalConformanceOptions = {},
): FictionalClinicalConformanceGrade {
  const failures: string[] = [];
  const originalSourceFileId = options.originalSourceFileId ?? FICTIONAL_CLINICAL_CONFORMANCE_ASSET;
  if (typeof originalSourceFileId !== 'string' || !originalSourceFileId.trim())
    failures.push('expected original source-file ID must be nonempty');
  const allClinical = envelopes.filter(clinical);
  const stable = allClinical.filter((envelope) =>
    stableIds.has(String(envelope.provenance.sourceRecordId || '')),
  );
  const unknownStableIds = allClinical.filter(
    (envelope) =>
      envelope.provenance.sourceRecordId !== null &&
      !stableIds.has(envelope.provenance.sourceRecordId),
  );
  for (const envelope of unknownStableIds)
    failures.push(`unexpected nonempty source ID ${envelope.provenance.sourceRecordId}`);

  const nullId = allClinical.filter((envelope) => envelope.provenance.sourceRecordId === null);
  const repeated = nullId.filter(
    (envelope) =>
      envelope.clinical?.kind === 'observation' &&
      repeatedTruth.has(String(envelope.clinical.testLabel || '')),
  );
  for (const envelope of nullId.filter((candidate) => !repeated.includes(candidate)))
    failures.push(
      envelope.clinical?.kind === 'procedure'
        ? `unsupported null-ID procedure role at ${envelope.provenance.locator}`
        : `unclassified null-ID clinical mapping at ${envelope.provenance.locator}`,
    );

  if (stable.length !== 8) failures.push(`stable partition expected 8, received ${stable.length}`);
  if (repeated.length !== 8)
    failures.push(`repeated partition expected 8, received ${repeated.length}`);
  if (allClinical.length !== 16)
    failures.push(`clinical partition expected 16, received ${allClinical.length}`);
  if (new Set([...stable, ...repeated]).size !== allClinical.length)
    failures.push('stable and repeated partitions do not cover every clinical envelope once');

  const stableTruth = structuredClone(FICTIONAL_CLINICAL_CONFORMANCE_GROUND_TRUTH);
  for (const record of stableTruth.records)
    for (const source of record.sources) source.assetRefs = [originalSourceFileId];
  const stableReport = evaluateImportGroundTruth(stable, { truth: stableTruth });
  for (const failure of stableReport.failures)
    failures.push(`stable:${String(failure.recordId)}:${failure.category}:${failure.detail}`);

  for (const [label, expected] of repeatedTruth) {
    const found = repeated.filter((envelope) => envelope.clinical?.testLabel === label);
    if (found.length !== 4)
      failures.push(`repeated ${label} expected 4 occurrences, received ${found.length}`);
    const pages = new Map([1, 2, 3, 4].map((page) => [page, 0]));
    for (const envelope of found) {
      const page = repeatedOccurrencePage(envelope.provenance.locator, label);
      if (page === null)
        failures.push(
          `repeated ${label} locator must cite the exact printed label and one unambiguous page 1-4: ${envelope.provenance.locator}`,
        );
      else pages.set(page, pages.get(page)! + 1);
    }
    for (const [page, occurrences] of pages)
      if (occurrences !== 1)
        failures.push(
          `repeated ${label} expected one page ${page} occurrence, received ${occurrences}`,
        );
    for (const envelope of found) {
      const mapping = envelope.clinical!;
      const exact = {
        kind: mapping.kind,
        subject: mapping.subject,
        eventKind: mapping.eventKind,
        testLabel: mapping.testLabel,
        valueText: mapping.valueText,
        unit: mapping.unit,
        date: mapping.date ?? null,
        assets: mapping.assets,
        uncertainties: mapping.uncertainties,
      };
      const expectedMapping = {
        kind: 'observation',
        subject: 'unknown',
        eventKind: 'performed',
        testLabel: expected.testLabel,
        valueText: expected.valueText,
        unit: expected.unit,
        date: null,
        assets: [originalSourceFileId],
        uncertainties: [],
      };
      if (!isDeepStrictEqual(exact, expectedMapping))
        failures.push(`repeated ${label} mapping differs at ${envelope.provenance.locator}`);
      if (envelope.provenance.sourceRecordId !== null)
        failures.push(`repeated ${label} invented a source ID`);
      const allowed = new Set([
        'kind',
        'subject',
        'eventKind',
        'testLabel',
        'valueText',
        'unit',
        'assets',
        'uncertainties',
      ]);
      for (const key of Object.keys(mapping))
        if (!allowed.has(key)) failures.push(`repeated ${label} invented clinical field ${key}`);
    }
  }

  for (const sourceRecordId of ['fx-appendix-a', 'fx-appendix-b']) {
    const envelope = stable.find(
      (candidate) => candidate.provenance.sourceRecordId === sourceRecordId,
    );
    if (!envelope) {
      failures.push(`${sourceRecordId} is missing before date-issue checks`);
      continue;
    }
    const dateIssues = (envelope.reviewIssues || []).filter(
      (issue) => issue.kind === 'date' && issue.field === 'date',
    );
    if (dateIssues.length !== 1) failures.push(`${sourceRecordId} expected exactly one date issue`);
    const issue = dateIssues[0];
    if (issue?.textAnchor !== CLINICAL_CONFORMANCE_AMBIGUITY_ANCHOR)
      failures.push(`${sourceRecordId} has the wrong date issue anchor`);
    if (
      issue &&
      issue.choices !== undefined &&
      (!Array.isArray(issue.choices) || issue.choices.length)
    )
      failures.push(`${sourceRecordId} date issue must have zero actual choices`);
    if (envelope.clinical?.date) failures.push(`${sourceRecordId} borrowed an unsupported date`);
  }

  for (const context of envelopes.filter((envelope) => envelope.kind === 'context'))
    if (context.clinical) failures.push(`context ${context.id} has a clinical mapping`);

  return {
    passed: failures.length === 0,
    failures,
    stableCount: stable.length,
    repeatedCount: repeated.length,
    clinicalCount: allClinical.length,
  };
}
