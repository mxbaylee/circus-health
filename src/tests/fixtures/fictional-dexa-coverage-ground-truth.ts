import type { IntakeExtractionPlan, IntakeExtractionUnit } from '../../shared/intake.ts';
import type { IntakeReadingAccounting } from '../../shared/intake-reading-accounting.ts';

export const FICTIONAL_DEXA_COVERAGE_GROUND_TRUTH = {
  standalonePages: [1, 2, 3],
  standaloneWindows: [[1, 2], [3]],
  mixedZipMembers: [
    {
      filename: 'person-a/dexa-report.pdf',
      role: 'clinical',
      disposition: 'extracted',
      duplicateOf: null,
    },
    {
      filename: 'redundant/person-a/dexa-report-copy.pdf',
      role: 'clinical',
      disposition: 'extracted',
      duplicateOf: 'person-a/dexa-report.pdf',
    },
    {
      filename: 'person-b/surgery-summary.pdf',
      role: 'context',
      disposition: 'context',
      duplicateOf: null,
    },
  ],
  acceptedUniqueDexaResults: 28,
} as const;

type CoverageFailure = {
  category:
    | 'missing_scope'
    | 'extra_scope'
    | 'deferred_scope'
    | 'unreadable_scope'
    | 'wrong_disposition'
    | 'duplicate_occurrence'
    | 'host_accounting'
    | 'clinical_count';
  scope: string;
  detail: string;
};

type CoverageInput = {
  standalonePlan: IntakeExtractionPlan;
  mixedZipPlan: IntakeExtractionPlan;
  readingAccounting?: IntakeReadingAccounting;
  acceptedUniqueDexaResults?: number;
};

function retainedDisposition(
  plan: IntakeExtractionPlan,
  unit: IntakeExtractionUnit,
): 'extracted' | 'context' | 'unreadable' | null {
  const coverage = unit.coverage;
  if (!coverage || coverage.unitId !== unit.id || coverage.kind === 'inspected') return null;
  const receipt = plan.batches.findLast(
    (batch) =>
      unit.attempts.includes(batch.id) &&
      batch.coverage.some(
        (item) =>
          item.unitId === unit.id && item.kind === coverage.kind && item.notes === coverage.notes,
      ),
  );
  return receipt ? coverage.kind : null;
}

export function evaluateFictionalDexaCoverage(input: CoverageInput) {
  const failures: CoverageFailure[] = [];
  const fail = (category: CoverageFailure['category'], scope: string, detail: string) =>
    failures.push({ category, scope, detail });
  const expected = FICTIONAL_DEXA_COVERAGE_GROUND_TRUTH;
  const standalone = input.standalonePlan;
  const pdfIndex = standalone.index as IntakeExtractionPlan['index'] & { pages?: number };
  if (pdfIndex.kind !== 'pdf' || pdfIndex.pages !== expected.standalonePages.length)
    fail(
      'missing_scope',
      'standalone PDF',
      `host index must enumerate exactly ${expected.standalonePages.length} pages`,
    );
  const windows = standalone.units.map((unit) => unit.pages || []);
  for (const expectedWindow of expected.standaloneWindows)
    if (!windows.some((pages) => JSON.stringify(pages) === JSON.stringify(expectedWindow)))
      fail(
        'missing_scope',
        `standalone pages ${expectedWindow.join('-')}`,
        'planned window is absent',
      );
  for (const pages of windows)
    if (
      !expected.standaloneWindows.some(
        (expectedWindow) => JSON.stringify(pages) === JSON.stringify(expectedWindow),
      )
    )
      fail('extra_scope', `standalone pages ${pages.join('-')}`, 'unexpected planned window');
  for (const page of expected.standalonePages) {
    const units = standalone.units.filter((unit) => unit.pages?.includes(page));
    if (!units.length) {
      fail('missing_scope', `standalone page ${page}`, 'page has no host extraction unit');
      continue;
    }
    const dispositions = units.map((unit) => retainedDisposition(standalone, unit));
    if (dispositions.some((kind) => kind === 'unreadable'))
      fail('unreadable_scope', `standalone page ${page}`, 'a page window is marked unreadable');
    if (!dispositions.includes('extracted'))
      fail(
        dispositions.every((kind) => kind === null) ? 'deferred_scope' : 'wrong_disposition',
        `standalone page ${page}`,
        'expected an extracted host disposition',
      );
  }

  const mixed = input.mixedZipPlan;
  const members = mixed.index.members || [];
  const expectedNames = new Set<string>(expected.mixedZipMembers.map((member) => member.filename));
  for (const member of expected.mixedZipMembers)
    if (!members.some((actual) => actual.filename === member.filename))
      fail('missing_scope', `ZIP member ${member.filename}`, 'inventory occurrence is absent');
  for (const member of members)
    if (!expectedNames.has(member.filename))
      fail('extra_scope', `ZIP member ${member.filename}`, 'unexpected inventory occurrence');
  if (mixed.index.totalMembers !== expected.mixedZipMembers.length)
    fail('host_accounting', 'mixed ZIP', 'totalMembers differs from the exact inventory oracle');

  const byFilename = new Map(members.map((member) => [member.filename, member]));
  for (const memberTruth of expected.mixedZipMembers) {
    const member = byFilename.get(memberTruth.filename);
    if (!member) continue;
    const duplicate = memberTruth.duplicateOf ? byFilename.get(memberTruth.duplicateOf) : undefined;
    if (memberTruth.duplicateOf) {
      if (
        !duplicate ||
        member.duplicateOf !== duplicate.memberId ||
        member.sourceHash !== duplicate.sourceHash
      )
        fail(
          'duplicate_occurrence',
          `ZIP member ${memberTruth.filename}`,
          'redundant occurrence must retain its own member ID and point to the primary identical bytes',
        );
    } else if (member.duplicateOf)
      fail(
        'duplicate_occurrence',
        `ZIP member ${memberTruth.filename}`,
        'unique occurrence is incorrectly marked as a byte duplicate',
      );
    const role = mixed.packageRoles?.find((value) => value.memberId === member.memberId);
    if (role?.role !== memberTruth.role)
      fail(
        'wrong_disposition',
        `ZIP member ${memberTruth.filename}`,
        `expected ${memberTruth.role} role; received ${role?.role || 'none'}`,
      );
    const units = mixed.units.filter(
      (unit) => unit.memberId === member.memberId && unit.sourceHash === member.sourceHash,
    );
    if (units.length !== 1) {
      fail(
        units.length ? 'extra_scope' : 'missing_scope',
        `ZIP member ${memberTruth.filename}`,
        `expected one occurrence unit; received ${units.length}`,
      );
      continue;
    }
    const disposition = retainedDisposition(mixed, units[0]!);
    if (disposition === null)
      fail(
        'deferred_scope',
        `ZIP member ${memberTruth.filename}`,
        'member remains inspected/pending without a final host disposition',
      );
    else if (disposition === 'unreadable')
      fail(
        'unreadable_scope',
        `ZIP member ${memberTruth.filename}`,
        'known readable fixture member is marked unreadable',
      );
    else if (disposition !== memberTruth.disposition)
      fail(
        'wrong_disposition',
        `ZIP member ${memberTruth.filename}`,
        `expected ${memberTruth.disposition}; received ${disposition}`,
      );
  }

  if (input.readingAccounting) {
    const accounting = input.readingAccounting;
    const exact = {
      state: 'accounted_with_gaps',
      sourceCount: 2,
      accountedSources: 2,
      pendingSources: 0,
      unknownSources: 0,
      allSourceOccurrencesAccounted: true,
      clinicalExtraction: 'unknown',
      units: {
        total: 5,
        pending: 0,
        extractedClaims: 4,
        contextOnly: 1,
        unreadable: 0,
      },
      packageOccurrences: {
        total: 3,
        accounted: 3,
        pending: 0,
        unknownRoles: 0,
        duplicateBytes: 1,
      },
    } as const;
    for (const [key, value] of Object.entries(exact))
      if (JSON.stringify(accounting[key as keyof typeof exact]) !== JSON.stringify(value))
        fail('host_accounting', `readingAccounting.${key}`, `expected ${JSON.stringify(value)}`);
  }
  if (
    input.acceptedUniqueDexaResults !== undefined &&
    input.acceptedUniqueDexaResults !== expected.acceptedUniqueDexaResults
  )
    fail(
      'clinical_count',
      'accepted observations',
      `expected ${expected.acceptedUniqueDexaResults} unique DEXA results; received ${input.acceptedUniqueDexaResults}`,
    );

  const coverageFailures = failures.filter((failure) => failure.category !== 'clinical_count');
  return {
    passed: failures.length === 0,
    coveragePassed: coverageFailures.length === 0,
    clinicalCountPassed: !failures.some((failure) => failure.category === 'clinical_count'),
    failures,
  };
}
