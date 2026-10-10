import test from 'node:test';
import assert from 'node:assert/strict';
import { createLargeImportOracle } from './large-import-fixture.ts';
import {
  exactLargeImportPages,
  gradeLargeImportReview,
  type LargeImportReviewInput,
} from './large-import-review-grader.ts';
import type { IntakeReportGroupMember, IntakeReviewRecord } from '../shared/intake.ts';

function inlineReportGroups(record: IntakeReviewRecord) {
  assert.ok(
    Array.isArray(record.reportGroups),
    'Fictional oracle snapshots contain complete inline report membership',
  );
  return record.reportGroups;
}
function snapshots(): LargeImportReviewInput {
  const oracle = createLargeImportOracle();
  const people = Object.fromEntries(
    oracle.people.map((person, index) => [
      person.key,
      {
        personId: index ? `runtime-person-${index}` : 'patient',
        noteId: index ? 'note:fictional-willow' : 'person-note:self',
        version: 1,
        fullName: person.name,
        birthDate: person.birthDate,
      },
    ]),
  );
  const records: IntakeReviewRecord[] = oracle.assertions.map((assertion) => ({
    id: `record-${assertion.key}`,
    candidateId: `candidate-${assertion.key}`,
    candidateVersionId: `version-${assertion.key}`,
    classification: 'addition',
    kind: assertion.mapping.kind,
    title: assertion.key,
    date: assertion.mapping.date!,
    provider: null,
    confidence: null,
    uncertainties: [],
    supportedFields: [],
    mapping: {
      ...assertion.mapping,
      personId: people[assertion.personKey]!.personId,
      subject: assertion.personKey === oracle.people[0]!.key ? 'self' : 'other',
    },
    evidence: assertion.pages.map((page) => ({
      label: 'Original source',
      locator: `page ${page}`,
      contentUrl: '/api/sources/original/content',
    })),
    reportGroups: [
      { groupId: assertion.reportKey, groupVersionId: `group-version-${assertion.reportKey}` },
    ],
    identityReview: {
      status: 'evidenced_match',
      blocking: false,
      message: '',
      conflicts: [],
      assignedPerson: people[assertion.personKey]!,
      evidencedIdentity: {
        fullName: people[assertion.personKey]!.fullName,
        birthDate: people[assertion.personKey]!.birthDate!,
      },
    },
  }));
  const authorities = oracle.reports.map((report) => {
    const bound = people[report.personKey]!;
    const members: IntakeReportGroupMember[] = records
      .filter((record) => inlineReportGroups(record)[0]!.groupId === report.key)
      .map((record) => ({
        candidateId: record.candidateId!,
        candidateVersionId: record.candidateVersionId!,
        occurrences: [
          {
            proposalId: 'proposal',
            recordId: record.id,
            batchId: null,
            locator: record.evidence[0]!.locator,
          },
        ],
      }));
    const anchor = { locator: `page ${report.firstPage}`, text: `Report: ${report.key}.` };
    const subject = {
      locator: `page ${report.firstPage}`,
      text: `Patient: ${bound.fullName}. DOB: ${bound.birthDate}.`,
    };
    return {
      retained: {
        id: report.key,
        basis: 'report_anchor' as const,
        sourceFileId: 'original',
        sourceHash: 'fixture-hash',
        sourceSystem: null,
        memberId: null,
        report: { key: report.key, title: 'Fictional report', anchor, subject },
        versions: [
          {
            id: `group-version-${report.key}`,
            createdAt: '2026-01-01',
            title: 'Fictional report',
            members,
            contributionId: 'contribution',
          },
        ],
      },
      queue: {
        groupId: report.key,
        groupVersionId: `group-version-${report.key}`,
        intakeId: 'original',
        intakeVersion: 1,
        discoveryOrder: null,
        title: 'Fictional report',
        source: null,
        date: report.date,
        basis: 'report_anchor' as const,
        original: {
          filename: 'fictional.pdf',
          contentUrl: '/api/sources/original/content',
          parentSourceFileId: null,
        },
        member: null,
        anchor,
        counts: {
          pending: members.length,
          deferred: 0,
          blocked: 0,
          accepted: 0,
          keptOriginal: 0,
          superseded: 0,
          questions: 0,
        },
      },
      identity: {
        status: 'evidenced_match' as const,
        blocking: false,
        message: '',
        conflicts: [],
        assignedPerson: bound,
        evidencedIdentity: { fullName: bound.fullName, birthDate: bound.birthDate! },
        self: {
          noteId: 'person-note:self' as const,
          version: 1,
          fullName: oracle.people[0]!.name,
          birthDate: oracle.people[0]!.birthDate,
        },
        offeredSelfFields: {},
        scope: {
          profileId: 'fictional-profile',
          intakeId: 'original',
          intakeVersion: 1,
          selfVersion: 1,
          groupId: report.key,
          groupVersionId: `group-version-${report.key}`,
          sourceHash: 'fixture-hash',
          memberId: null,
          original: {
            filename: 'fictional.pdf',
            contentUrl: '/api/sources/original/content',
            page: report.firstPage,
          },
          report: anchor,
          subject,
          verificationMode: 'literal_text_match' as const,
          evidencedIdentity: { fullName: bound.fullName, birthDate: bound.birthDate! },
          membership: members,
          targets: [],
          scopeToken: 'opaque-scope',
        },
      },
    };
  });
  return {
    oracle,
    stage: 'review',
    originalId: 'original',
    people,
    reviews: [
      {
        intakeId: 'original',
        proposalId: 'proposal',
        version: 1,
        reviewToken: 'opaque',
        summary: { additions: 901, duplicates: 0, unsupported: 0, uncertain: 0 },
        records,
        coverageGaps: [],
      },
    ],
    authorities,
  };
}
const grade = (input: LargeImportReviewInput) => gradeLargeImportReview(input);
const first = (input: LargeImportReviewInput) => input.reviews[0]!.records[0]!;

test('an unloaded membership reference cannot qualify from its navigation hint', () => {
  const input = snapshots(),
    record = first(input);
  const firstGroup = inlineReportGroups(record)[0]!;
  record.reportGroups = {
    format: 'health-intake-report-group-links-v1',
    count: 1,
    first: firstGroup,
    selection: {
      candidateId: record.candidateId!,
      candidateVersionId: record.candidateVersionId!,
      recordId: record.id,
      proposalId: input.reviews[0]!.proposalId,
    },
  };
  assert.equal(grade(input).passed, false);
});

function scopedSelfSnapshots() {
  const input = snapshots();
  first(input).mapping.personId = undefined;
  first(input).identityReview!.assignedPerson = undefined;
  first(input).identityReview!.status = 'prior_confirmation';
  input.authorities[0]!.identity.assignedPerson = undefined;
  input.authorities[0]!.identity.status = 'prior_confirmation';
  return input;
}

test('normal Self projection requires exact current bound and scoped Self evidence', () => {
  assert.equal(grade(scopedSelfSnapshots()).passed, true);
  const linkedPages = scopedSelfSnapshots();
  for (const authority of linkedPages.authorities) {
    const original = authority.identity.scope!.original;
    original.contentUrl += `#page=${original.page}`;
  }
  // The normal scope URL points at its page; the queue URL points at the file.
  // Both must pass exact original/page validation, not raw URL string equality.
  assert.equal(grade(linkedPages).passed, true);
  for (const mutate of [
    (input: LargeImportReviewInput) => {
      Object.assign(input.authorities[0]!.identity, { self: undefined });
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.identity.scope!.selfVersion = undefined;
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.identity.scope!.selfVersion = 2;
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.identity.self.version = 2;
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.identity.self.fullName = 'Fictional Wrong Person';
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.identity.self.birthDate = '1900-01-01';
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.identity.scope!.evidencedIdentity = undefined;
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.identity.scope!.evidencedIdentity = {
        fullName: input.people['fictional-cedar']!.fullName,
      };
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.identity.scope!.evidencedIdentity!.fullName = 'Fictional Wrong Person';
    },
    (input: LargeImportReviewInput) => {
      input.people['fictional-cedar']!.personId = 'wrong-self';
    },
    (input: LargeImportReviewInput) => {
      input.people['fictional-cedar']!.noteId = 'wrong-self-note';
    },
    (input: LargeImportReviewInput) => {
      first(input).mapping.personId = input.people['fictional-willow']!.personId;
    },
    (input: LargeImportReviewInput) => {
      first(input).mapping.subject = 'unknown';
    },
    (input: LargeImportReviewInput) => {
      first(input).identityReview!.status = 'confirmation_required';
    },
    (input: LargeImportReviewInput) => {
      first(input).identityReview!.blocking = true;
    },
    (input: LargeImportReviewInput) => {
      first(input).identityReview!.evidencedIdentity.fullName = 'Fictional Wrong Person';
    },
    (input: LargeImportReviewInput) => {
      first(input).identityReview!.evidencedIdentity.birthDate = '1900-01-01';
    },
    (input: LargeImportReviewInput) => {
      first(input).identityReview!.assignedPerson = input.people['fictional-willow']!;
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.identity.assignedPerson = input.people['fictional-willow']!;
    },
    (input: LargeImportReviewInput) => {
      first(input).identityReview!.conflicts = [
        {
          field: 'birthDate',
          selfValue: input.people['fictional-cedar']!.birthDate!,
          evidencedValue: '1900-01-01',
          reason: 'evidence_disagreement',
        },
      ];
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.identity.scope!.sourceHash = 'wrong-original';
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.identity.scope!.subject.text = 'Patient: Fictional Wrong Person';
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.identity.scope!.membership = [];
    },
    (input: LargeImportReviewInput) => {
      const authority = input.authorities[0]!;
      authority.retained.versions[0]!.members = [];
    },
    (input: LargeImportReviewInput) => {
      const authority = input.authorities[0]!;
      authority.identity.scope!.original.contentUrl = '/api/sources/wrong/content';
      authority.queue.original.contentUrl = '/api/sources/wrong/content';
    },
    (input: LargeImportReviewInput) => {
      const authority = input.authorities[0]!;
      authority.identity.scope!.report.text = 'Wrong report';
      authority.retained.report!.anchor.text = 'Wrong report';
      authority.queue.anchor!.text = 'Wrong report';
    },
  ]) {
    const input = scopedSelfSnapshots();
    mutate(input);
    assert.equal(grade(input).ownershipResolved, false);
    assert.equal(grade(input).passed, false);
  }
});

test('assignment snapshots may omit DOB but cannot contradict the required binding or evidence', () => {
  const input = snapshots();
  for (const authority of input.authorities) {
    const { birthDate: _dob, ...assigned } = authority.identity.assignedPerson!;
    authority.identity.assignedPerson = assigned;
  }
  for (const record of input.reviews[0]!.records) {
    const { birthDate: _dob, ...assigned } = record.identityReview!.assignedPerson!;
    record.identityReview!.assignedPerson = assigned;
  }
  assert.equal(grade(input).passed, true);
  const other = input.reviews[0]!.records.find((record) => record.mapping.subject === 'other')!;
  for (const birthDate of [null, '', '1900-01-01']) {
    other.identityReview!.assignedPerson!.birthDate = birthDate;
    assert.equal(grade(input).ownershipResolved, false);
  }
  delete other.identityReview!.assignedPerson!.birthDate;
  delete input.people['fictional-willow']!.birthDate;
  assert.ok(grade(input).authorityIssues.includes('peopleBinding'));
});

test('another person cannot borrow the Self projection fallback', () => {
  const input = scopedSelfSnapshots();
  const record = input.reviews[0]!.records.find(
    (item) => item.mapping.personId === input.people['fictional-willow']!.personId,
  )!;
  record.mapping.personId = undefined;
  record.identityReview!.assignedPerson = undefined;
  const authority = input.authorities.find(
    (item) => item.retained.id === inlineReportGroups(record)[0]!.groupId,
  )!;
  authority.identity.assignedPerson = undefined;
  assert.equal(grade(input).ownershipResolved, false);
  record.mapping.subject = 'self';
  assert.equal(grade(input).ownershipResolved, false);
});

test('full oracle reconciliation is pure and distinguishes proposal/review outcomes', () => {
  const input = snapshots(),
    before = JSON.stringify(input);
  assert.equal(grade(input).reviewReady, true);
  assert.equal(grade(input).exactRecords, 901);
  assert.equal(JSON.stringify(input), before);
  first(input).mapping.personId = undefined;
  first(input).mapping.subject = 'unknown';
  first(input).identityReview!.assignedPerson = undefined;
  first(input).identityReview!.status = 'confirmation_required';
  first(input).identityReview!.blocking = true;
  input.stage = 'proposal';
  const pending = grade(input);
  assert.equal(pending.passed, true);
  assert.equal(pending.clinicalProvenancePassed, true);
  assert.equal(pending.ownershipResolved, false);
  assert.equal(pending.reviewReady, false);
  input.stage = 'review';
  assert.equal(grade(input).passed, false);
});

test('missing, extra, duplicates and exact occurrence duplicates remain separate', () => {
  const input = snapshots();
  input.reviews[0]!.records.pop();
  const extra = structuredClone(first(input));
  extra.id = 'extra';
  extra.mapping.testLabel = 'invented-label';
  input.reviews[0]!.records.push(extra, structuredClone(first(input)));
  const result = grade(input);
  assert.equal(result.missing.length, 1);
  assert.equal(result.unexpectedRecords, 1);
  assert.equal(result.duplicate.length, 1);
  assert.equal(result.duplicateOccurrences, 1);
  assert.equal(result.passed, false);
  const output = JSON.stringify(result);
  assert.equal(output.includes('invented-label'), false);
  assert.equal(output.includes('runtime-person'), false);
});

test('literal precision and canonical classifications are exact and host defaults narrowly allowed', () => {
  const input = snapshots(),
    record = first(input);
  Object.assign(record.mapping, {
    label: record.mapping.testLabel,
    dateRole: 'recorded',
    medicationKind: 'unknown',
    procedureCategory: 'unspecified',
    documentDate: record.mapping.date,
    documentTitle: 'Private host envelope title',
    text: 'Private retained payload',
    assets: ['original'],
    uncertainties: [],
    mappingOrigins: { kind: 'clinical', documentTitle: 'envelope', text: 'payload' },
  });
  assert.equal(grade(input).passed, true);
  record.mapping.label = 'altered canonical label';
  assert.equal(grade(input).passed, false);
  record.mapping.label = record.mapping.testLabel;
  record.mapping.valueText = '<0.07';
  record.mapping.observationCategory = 'Laboratory';
  record.mapping.specimen = 'invented';
  const result = grade(input);
  assert.deepEqual(
    [...result.mismatches[0]!.fields].sort(),
    ['observationCategory', 'valueText', 'unexpectedField'].sort(),
  );
  assert.equal(JSON.stringify(result).includes('Private'), false);
  assert.equal(JSON.stringify(result).includes('invented'), false);
  (record.mapping as Record<string, unknown>).mappingOrigins = {
    kind: 'clinical',
    documentTitle: 'clinical',
    text: 'clinical',
  };
  assert.ok(grade(input).mismatches[0]!.fields.includes('unexpectedField'));
});

test('wrong original, broad pages, missing split half and wrong report fail attribution', () => {
  for (const mutate of [
    (input: LargeImportReviewInput) => {
      first(input).evidence[0]!.contentUrl = '/api/sources/wrong/content';
    },
    (input: LargeImportReviewInput) => {
      first(input).evidence[0]!.locator = 'pages 1-2';
    },
    (input: LargeImportReviewInput) => {
      input.reviews[0]!.records.at(-1)!.evidence.pop();
    },
    (input: LargeImportReviewInput) => {
      inlineReportGroups(first(input))[0]!.groupId = input.authorities[1]!.retained.id;
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.retained.report!.anchor.text = 'An unrelated heading';
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.identity.scope!.subject.locator = 'page 151';
    },
  ]) {
    const input = snapshots();
    mutate(input);
    assert.equal(grade(input).clinicalProvenancePassed, false);
  }
});

test('single API locator accepts precise clauses without hiding uncertainty or ranges', () => {
  const evidence = {
    label: 'Original source',
    contentUrl: '/api/sources/original/content',
    locator: 'page 149 label; page 150 result unit reference',
  };
  assert.deepEqual(exactLargeImportPages(evidence, 'original'), [149, 150]);
  for (const locator of [
    'pages 149-150',
    '149;150',
    'page 149;150',
    'page 149;',
    'page 149; possibly page 150',
    'maybe page 149; page 150',
    'page 149; page 150 uncertain',
    'page 149; page 150?',
    'page 149; pages 150-151',
  ])
    assert.equal(exactLargeImportPages({ ...evidence, locator }, 'original'), null, locator);
  const input = snapshots();
  input.reviews[0]!.records.at(-1)!.evidence = [evidence];
  assert.equal(grade(input).passed, true);
});

test('wrong ownership, unresolved issues and conflicting/missing bindings cannot become review ready', () => {
  for (const mutate of [
    (input: LargeImportReviewInput) => {
      first(input).mapping.personId = input.people['fictional-willow']!.personId;
    },
    (input: LargeImportReviewInput) => {
      first(input).identityReview!.evidencedIdentity.birthDate = '1999-01-01';
    },
    (input: LargeImportReviewInput) => {
      first(input).identityReview!.status = 'conflict';
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.identity.scope = null;
    },
    (input: LargeImportReviewInput) => {
      input.people = { ...input.people, 'fictional-willow': input.people['fictional-cedar']! };
    },
    (input: LargeImportReviewInput) => {
      input.people = {};
    },
    (input: LargeImportReviewInput) => {
      input.authorities = [...input.authorities, input.authorities[0]!];
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.queue.groupVersionId = 'not-retained';
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.queue.basis = 'candidate_fallback';
    },
    (input: LargeImportReviewInput) => {
      first(input).issues = [
        {
          id: 'issue',
          kind: 'identity',
          prompt: 'Private question',
          field: 'subject',
          blocking: true,
          status: 'unresolved',
          locator: 'page 1',
          questionId: null,
        },
      ];
    },
  ]) {
    const input = snapshots();
    mutate(input);
    assert.equal(grade(input).reviewReady, false);
  }
});

test('missing report authority cannot hide wrong or unresolved ownership', () => {
  for (const personId of [undefined, 'wrong-person']) {
    const input = snapshots();
    inlineReportGroups(first(input))[0]!.groupId = 'missing-group';
    first(input).mapping.personId = personId;
    const result = grade(input);
    assert.equal(result.ownershipResolved, false);
    assert.ok(result.unresolved.includes(input.oracle.assertions[0]!.key));
    if (personId) assert.ok(result.mismatches[0]!.ownership.includes('mappingPerson'));
  }
});

test('record-level identity scope cannot contradict the actual group scope', () => {
  for (const change of [
    (scope: NonNullable<LargeImportReviewInput['authorities'][number]['identity']['scope']>) => {
      scope.sourceHash = 'wrong';
    },
    (scope: NonNullable<LargeImportReviewInput['authorities'][number]['identity']['scope']>) => {
      scope.groupId = 'wrong';
    },
    (scope: NonNullable<LargeImportReviewInput['authorities'][number]['identity']['scope']>) => {
      scope.intakeId = 'wrong';
    },
    (scope: NonNullable<LargeImportReviewInput['authorities'][number]['identity']['scope']>) => {
      scope.membership = [];
    },
  ]) {
    const input = snapshots(),
      scope = structuredClone(input.authorities[0]!.identity.scope!);
    change(scope);
    Object.assign(first(input).identityReview!, { scope });
    assert.equal(grade(input).clinicalProvenancePassed, false);
  }
});

test('optional pinned identity facts and original member authority must agree', () => {
  for (const mutate of [
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.identity.scope!.evidencedIdentity = { birthDate: '1900-01-01' };
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.identity.scope!.evidencedIdentity = { fullName: 'Wrong Person' };
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.identity.scope!.memberId = 'different-member';
    },
    (input: LargeImportReviewInput) => {
      input.authorities[0]!.queue.member = {
        memberId: 'different-member',
        filename: null,
        locator: null,
      };
    },
  ]) {
    const input = snapshots();
    mutate(input);
    assert.equal(grade(input).ownershipResolved, false);
    assert.equal(grade(input).reviewReady, false);
  }
});

test('valid older introducing versions pass but invented versions and membership do not', () => {
  const input = snapshots(),
    authority = input.authorities[0]!;
  authority.retained.versions.push({
    ...structuredClone(authority.retained.versions[0]!),
    id: 'latest-version',
    contributionId: 'later',
  });
  authority.queue.groupVersionId = 'latest-version';
  authority.identity.scope!.groupVersionId = 'latest-version';
  assert.equal(grade(input).passed, true);
  inlineReportGroups(first(input))[0]!.groupVersionId = 'unretained-version';
  assert.equal(grade(input).passed, false);
  inlineReportGroups(first(input))[0]!.groupVersionId = authority.retained.versions[0]!.id;
  authority.retained.versions[0]!.members = [];
  assert.equal(grade(input).passed, false);
});
