import assert from 'node:assert/strict';
import test from 'node:test';
import type { Intake, IntakeCandidate, IntakeExtractionUnit } from '../../shared/intake.ts';
import {
  MODEL_INTAKE_SECTIONS,
  modelIntakeContext,
  modelIntakeEvidenceContext,
  type ModelIntakeSection,
} from '../intake-model-context.ts';
import { conversionReadKey } from '../intake-continuation.ts';

function fictionalIntake(): Intake & {
  workflow: NonNullable<Intake['workflow']> & {
    operations: { id: string; fingerprint: string; at: string }[];
  };
} {
  const units: IntakeExtractionUnit[] = Array.from({ length: 585 }, (_, index) => ({
    id: `unit:fictional-${index}`,
    kind: 'pdf',
    locator: `Synthetic archive page ${index + 1} ${'location '.repeat(20)}`,
    status: index % 3 === 0 ? 'completed' : index % 3 === 1 ? 'partial' : 'pending',
    pages: [index + 1],
    attempts: index % 3 === 0 ? [`attempt-${index}`] : [],
    ...(index % 3 === 0
      ? {
          coverage: {
            unitId: `unit:fictional-${index}`,
            kind: 'extracted' as const,
            notes: 'Synthetic page retained in a fictional proposal.',
          },
        }
      : {}),
  }));
  const candidates: IntakeCandidate[] = Array.from({ length: 1000 }, (_, index) => ({
    id: `candidate:fictional-${index}`,
    envelopeId: `fictional-envelope-${index}`,
    sourceSystem: 'Fictional archive',
    sourceRecordId: `fictional-source-${index}`,
    versions: [
      {
        id: `candidate-version:fictional-${index}-old`,
        status: 'superseded',
        createdAt: '2026-01-01T00:00:00.000Z',
        occurrences: [
          {
            proposalId: `proposal-${index}-old`,
            recordId: `record-${index}-old`,
            batchId: `batch-${index}-old`,
            locator:
              index === 0
                ? `Synthetic archive page 1 ${'long locator '.repeat(7000)}`
                : `Synthetic archive page ${index + 1}`,
          },
        ],
      },
      {
        id: `candidate-version:fictional-${index}-current`,
        status: index === 1 ? 'accepted' : 'pending',
        createdAt: '2026-01-02T00:00:00.000Z',
        occurrences: [
          {
            proposalId: `proposal-${index}-current`,
            recordId: `record-${index}-current`,
            batchId: `batch-${index}-current`,
            locator:
              index === 0
                ? `Synthetic archive page 1 ${'long locator '.repeat(7000)}`
                : `Synthetic archive page ${index + 1}`,
          },
        ],
      },
    ],
  }));
  return {
    id: 'intake:fictional-large',
    providerId: 'provider:fictional',
    provider: 'Fictional archive',
    filename: 'fictional-large.pdf',
    mimeType: 'application/pdf',
    bytes: 1234,
    sha256: 'a'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z',
    state: 'needs_review',
    version: 42,
    contentUrl: '/fictional-large.pdf',
    validation: {
      valid: false,
      rows: 0,
      exactRepeatedRows: 0,
      partialRows: 0,
      unrecognizedRows: 0,
      preview: [],
      previewComplete: true,
      issues: [],
    },
    proposals: [
      {
        id: 'proposal-latest',
        fileId: 'file-latest',
        summary: 's'.repeat(10000),
        contentUrl: '/fictional-proposal',
        createdAt: '2026-01-02T00:00:00.000Z',
        runId: 'run:fictional',
        validation: {
          valid: true,
          rows: 1,
          exactRepeatedRows: 0,
          partialRows: 0,
          unrecognizedRows: 0,
          preview: [],
          previewComplete: true,
          issues: [],
        },
      },
    ],
    acceptedProposalId: 'proposal-latest',
    conversionChatId: 'chat:fictional',
    imported: {
      records: 1,
      repeatedRows: 0,
      matchingEarlierRows: 0,
      at: '2026-01-02T00:00:00.000Z',
      fileId: 'file-latest',
    },
    importHistory: Array.from({ length: 100 }, (_, index) => ({
      acceptedProposalId: `proposal-history-${index}`,
      reviewToken: `review-token-${index}`,
      at: '2026-01-01T00:00:00.000Z',
    })),
    durability: { pending: false, mutationRevision: 1, persistedRevision: 1, error: null },
    needsReview: true,
    pendingCount: 1000,
    unansweredCount: 100,
    pendingWorkCount: 390,
    reviewLaterCount: 0,
    workflow: {
      format: 'health-intake-workflow-v1',
      questions: Array.from({ length: 100 }, (_, index) => ({
        id: `question-${index}`,
        key: `question-key-${index}`,
        candidateId: `candidate:fictional-${index}`,
        candidateVersionId: `candidate-version:fictional-${index}-current`,
        prompt: `Synthetic question ${index}: ${'detail '.repeat(250)}`,
        locator: `Synthetic archive page ${index + 1}`,
        field: 'synthetic-field',
        status: 'unanswered' as const,
        createdAt: '2026-01-02T00:00:00.000Z',
        ...(index === 0 ? { otherRecordId: 'record-fictional-comparison' } : {}),
        answers:
          index === 0
            ? [
                {
                  id: 'answer-0',
                  answer: 'These are distinct fictional source events.',
                  mapping: { subject: 'self', text: 'q'.repeat(10000) },
                  scope: 'record' as const,
                  outcome: 'distinct',
                  otherRecordId: 'record-fictional-comparison',
                  at: '2026-01-02T00:00:00.000Z',
                },
              ]
            : [],
      })),
      candidates,
      plans: [
        {
          id: 'plan:fictional-large',
          createdAt: '2026-01-01T00:00:00.000Z',
          status: 'active',
          pins: {
            sourceHash: 'a'.repeat(64),
            backend: 'synthetic',
            model: 'synthetic-model',
            reasoningEffort: null,
            instructionVersion: 'instruction-v1',
            mappingVersion: 'mapping-v1',
          },
          index: {
            kind: 'pdf',
            coverage: 'indexed_only',
            missingAssets: Array.from({ length: 100 }, (_, index) => ({
              locator: `Synthetic missing asset ${index}`,
              source: `synthetic-source-${index}`,
              status: 'not_supplied',
            })),
          },
          units,
          batches: [
            {
              id: 'batch-operation:fictional',
              proposalId: 'proposal-latest',
              at: '2026-01-02T00:00:00.000Z',
              coverage: Array.from({ length: 50 }, (_, index) => ({
                unitId: `unit:fictional-${index}`,
                kind: 'inspected' as const,
                notes: 'n'.repeat(4000),
              })),
            },
          ],
        },
      ],
      decisions: [
        {
          id: 'decision:fictional-accepted',
          candidateId: 'candidate:fictional-1',
          candidateVersionId: 'candidate-version:fictional-1-current',
          recordId: 'record-1-current',
          action: 'accept',
          mapping: {
            kind: 'observation',
            testLabel: 'Accepted synthetic density',
            valueText: '2.000',
            unit: 'fictional-unit',
            date: '2026-01-01',
            subject: 'self',
            text: 'Exact accepted synthetic text.',
          },
          scope: 'record',
          ...{
            evidence: [
              {
                label: 'Synthetic accepted evidence',
                locator: 'Synthetic archive page 2, region A',
                contentUrl: '/fictional-source',
              },
            ],
          },
          at: '2026-01-02T00:00:00.000Z',
        },
      ],
      reviewDrafts: [
        {
          id: 'draft-current',
          proposalId: 'proposal-0-current',
          recordId: 'record-0-current',
          candidateId: 'candidate:fictional-0',
          candidateVersionId: 'candidate-version:fictional-0-current',
          mapping: {
            kind: 'observation',
            testLabel: 't'.repeat(10000),
            valueText: 'v'.repeat(10000),
            unit: 'u'.repeat(10000),
            date: 'd'.repeat(10000),
            method: 'm'.repeat(10000),
            referenceText: 'r'.repeat(10000),
          },
          resolutions: [],
          disposition: 'review_later',
          at: '2026-01-02T00:00:00.000Z',
        },
      ],
      reportGroups: [
        {
          id: 'report-group:fictional',
          discoveryOrder: 17,
          basis: 'report_anchor',
          sourceFileId: 'intake:fictional-large',
          sourceHash: 'a'.repeat(64),
          sourceSystem: 'Fictional archive',
          memberId: null,
          report: {
            key: 'synthetic-report-key',
            title: 'Synthetic source report',
            anchor: {
              text: 'Synthetic source report anchor',
              locator: 'Synthetic archive page 1, header',
            },
            subject: {
              text: 'Synthetic subject anchor',
              locator: 'Synthetic archive page 1, subject row',
            },
            section: {
              key: 'synthetic-section-key',
              title: 'Synthetic measurements',
              anchor: {
                text: 'Synthetic section anchor',
                locator: 'Synthetic archive page 1, section heading',
              },
            },
          },
          versions: [
            {
              id: 'report-group-version:fictional',
              createdAt: '2026-01-02T00:00:00.000Z',
              title: 'Synthetic report',
              contributionId: 'synthetic-contribution',
              context: {
                contextId: 'context:fictional',
                envelopeId: 'envelope:fictional-context',
                status: 'linked',
                detail: 'Synthetic linked context.',
                sourceSuggestion: {
                  value: 'Fictional source',
                  textAnchor: 'Synthetic source suggestion anchor',
                  locator: 'Synthetic archive page 1, source row',
                },
              },
              contextState: 'uniform',
              members: [
                {
                  candidateId: 'candidate:fictional-0',
                  candidateVersionId: 'candidate-version:fictional-0-current',
                  section: {
                    key: 'synthetic-member-section-key',
                    title: 'Synthetic member section',
                    anchor: {
                      text: 'Synthetic member section anchor',
                      locator: 'Synthetic archive page 1, member section',
                    },
                  },
                  occurrences: candidates[0]!.versions[1]!.occurrences,
                },
              ],
            },
          ],
        },
      ],
      operations: [
        {
          id: 'batch-operation:fictional',
          fingerprint: 'fictional-fingerprint',
          at: '2026-01-02T00:00:00.000Z',
        },
      ],
    },
  };
}

function allSectionItems(intake: Intake, section: ModelIntakeSection) {
  const wireItems: unknown[] = [];
  let offset = 0;
  for (let pageNumber = 0; pageNumber < 10000; pageNumber++) {
    const result = modelIntakeContext(intake, { section, offset });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 64 * 1024);
    assert.equal(result.page.section, section);
    assert.equal(result.page.offset, offset);
    assert.equal('preview' in result, false);
    assert.equal('truncated' in result, false);
    wireItems.push(...result.page.items);
    if (result.page.nextOffset === null) {
      assert.equal(result.page.complete, true);
      const items: unknown[] = [];
      for (let index = 0; index < wireItems.length; index++) {
        const item = wireItems[index] as {
          format?: string;
          itemIndex?: number;
          chunkIndex?: number;
          chunkCount?: number;
          jsonText?: string;
        };
        if (item.format !== 'health-intake-json-item-chunk-v1') {
          items.push(item);
          continue;
        }
        assert.equal(item.chunkIndex, 0);
        const chunks = wireItems.slice(index, index + item.chunkCount!) as {
          format: string;
          itemIndex: number;
          chunkIndex: number;
          chunkCount: number;
          jsonText: string;
        }[];
        assert.equal(chunks.length, item.chunkCount);
        assert.ok(chunks.every((chunk, chunkIndex) => chunk.chunkIndex === chunkIndex));
        assert.ok(chunks.every((chunk) => chunk.itemIndex === item.itemIndex));
        items.push(JSON.parse(chunks.map((chunk) => chunk.jsonText).join('')));
        index += item.chunkCount! - 1;
      }
      assert.equal(items.length, result.page.logicalTotal);
      return items;
    }
    assert.ok(result.page.nextOffset > offset);
    offset = result.page.nextOffset;
  }
  assert.fail(`Pagination did not finish for ${section}`);
}

test('model intake context keeps large plans and candidate history bounded and exhaustively paged', () => {
  const intake = {
    ...fictionalIntake(),
    mappingRules: Array.from({ length: 1200 }, (_, index) => ({
      id: `mapping-rule-${index}`,
      match: { kind: 'observation', label: `Synthetic label ${index}` },
      set: { testLabel: `Synthetic normalized label ${index}` },
    })),
    mappingRulesVersion: 'mapping-v1',
  };
  const sections = Object.fromEntries(
    MODEL_INTAKE_SECTIONS.map((section) => [section, allSectionItems(intake, section)]),
  );
  assert.equal(sections.units.length, 585);
  assert.equal(sections.plan.length, 1);
  assert.equal(sections.candidates.length, 2000);
  assert.equal(sections.occurrences.length, 2000);
  assert.equal(sections.report_scopes.length, 1);
  assert.deepEqual(sections.report_scopes[0], {
    groupId: 'report-group:fictional',
    groupVersionId: 'report-group-version:fictional',
    discoveryOrder: 17,
    basis: 'report_anchor',
    sourceFileId: intake.id,
    sourceHash: intake.sha256,
    sourceSystem: 'Fictional archive',
    memberId: null,
    report: intake.workflow.reportGroups?.[0]?.report,
    createdAt: '2026-01-02T00:00:00.000Z',
    title: 'Synthetic report',
    contributionId: 'synthetic-contribution',
    context: intake.workflow.reportGroups?.[0]?.versions[0]?.context,
    contextState: 'uniform',
    members: [
      {
        candidateId: 'candidate:fictional-0',
        candidateVersionId: 'candidate-version:fictional-0-current',
        section: intake.workflow.reportGroups?.[0]?.versions[0]?.members[0]?.section,
        occurrences: intake.workflow.candidates[0]!.versions[1]!.occurrences,
      },
    ],
  });
  assert.equal(sections.questions.length, 100);
  assert.equal(sections.question_answers.length, 1);
  assert.equal(sections.proposals.length, 1);
  assert.equal(sections.decisions.length, 2);
  assert.equal(sections.batches.length, 1);
  assert.equal(sections.operations.length, 1);
  assert.equal(sections.acceptances.length, 101);
  assert.equal(sections.mapping_rules.length, 1200);
  assert.equal(sections.missing_assets.length, 100);
  assert.equal(new Set(sections.units.map((item) => (item as { id: string }).id)).size, 585);
  assert.ok(
    sections.candidates.some(
      (item) =>
        (item as { candidateVersionId: string }).candidateVersionId ===
          'candidate-version:fictional-0-old' &&
        (item as { currentVersion: boolean }).currentVersion === false,
    ),
  );
  const current = sections.candidates.find(
    (item) =>
      (item as { candidateVersionId: string }).candidateVersionId ===
      'candidate-version:fictional-0-current',
  ) as {
    recentLocators: string[];
    matchKeys: { testLabel: string; valueText: string; unit: string; date: string };
    recentReportScopes: { groupId: string; sourceFileId: string }[];
  };
  assert.ok((current.recentLocators[0]?.length || 0) > 70000);
  assert.equal(current.matchKeys.testLabel.length, 10000);
  assert.equal(current.matchKeys.valueText.length, 10000);
  assert.equal(current.matchKeys.unit.length, 10000);
  assert.equal(current.matchKeys.date.length, 10000);
  assert.equal(current.recentReportScopes[0]?.groupId, 'report-group:fictional');
  assert.equal(current.recentReportScopes[0]?.sourceFileId, intake.id);
  assert.ok(
    sections.decisions.some(
      (item) =>
        (item as { kind: string; id: string; mapping?: { testLabel?: string } }).kind ===
          'accepted_decision' &&
        (item as { id: string }).id === 'decision:fictional-accepted' &&
        (item as { mapping: { testLabel: string } }).mapping.testLabel ===
          'Accepted synthetic density',
    ),
  );
  assert.deepEqual(sections.question_answers[0], {
    questionId: 'question-0',
    candidateId: 'candidate:fictional-0',
    candidateVersionId: 'candidate-version:fictional-0-current',
    otherRecordId: 'record-fictional-comparison',
    id: 'answer-0',
    answer: 'These are distinct fictional source events.',
    mapping: { subject: 'self', text: 'q'.repeat(10000) },
    scope: 'record',
    at: '2026-01-02T00:00:00.000Z',
    outcome: 'distinct',
    comparedRecordId: 'record-fictional-comparison',
  });
  assert.equal(
    (sections.questions[0] as { otherRecordId: string }).otherRecordId,
    'record-fictional-comparison',
  );
  assert.equal(
    (
      sections.decisions.find(
        (item) => (item as { id?: string }).id === 'decision:fictional-accepted',
      ) as { mapping: { subject: string; text: string } }
    ).mapping.text,
    'Exact accepted synthetic text.',
  );
  assert.equal(
    (
      sections.decisions.find(
        (item) => (item as { id?: string }).id === 'decision:fictional-accepted',
      ) as { evidence: { locator: string }[] }
    ).evidence[0]?.locator,
    'Synthetic archive page 2, region A',
  );
  assert.equal((sections.batches[0] as { coverage: unknown[] }).coverage.length, 50);
  assert.equal(
    (sections.plan[0] as { pins: { instructionVersion: string } }).pins.instructionVersion,
    'instruction-v1',
  );
  assert.ok(
    sections.candidates.some(
      (item) =>
        (item as { candidateVersionId: string; reviewDisposition: string }).candidateVersionId ===
          'candidate-version:fictional-0-current' &&
        (item as { reviewDisposition: string }).reviewDisposition === 'review_later',
    ),
  );
  assert.equal(
    new Set(sections.occurrences.map((item) => (item as { recordId: string }).recordId)).size,
    2000,
  );
});

test('page evidence context retains exact source and current-unit identity without review payloads', () => {
  const intake = fictionalIntake();
  const context = modelIntakeEvidenceContext(intake, { page: 123 });
  assert.equal(context.id, intake.id);
  assert.equal(context.sourceHash, intake.sha256);
  assert.equal(context.version, intake.version);
  assert.equal(context.currentUnits.length, 1);
  assert.equal(context.currentUnits[0]?.pages?.[0], 123);
  assert.equal(context.candidates.versionCount, 2000);
  assert.equal(context.candidates.recentVersions.length, 4);
  assert.ok(
    context.candidates.recentVersions.every((item) => item.candidateVersionId && item.status),
  );
  assert.equal(context.questions.count, 100);
  assert.equal(context.questions.answerSection, 'question_answers');
  assert.equal('workflow' in context, false);
  assert.equal('imported' in context, false);
  assert.equal('acceptedProposalId' in context, false);
  assert.ok(Buffer.byteLength(JSON.stringify(context)) < 16 * 1024);
});

test('model plan paging keys bind section and intake revision', () => {
  const base = { id: 'intake:fictional', action: 'read', offset: 0 };
  const units = conversionReadKey('health_intake_plan', {
    ...base,
    section: 'units',
    version: 41,
    mappingVersion: 'mapping-v1',
  });
  assert.notEqual(
    units,
    conversionReadKey('health_intake_plan', {
      ...base,
      section: 'candidates',
      version: 41,
      mappingVersion: 'mapping-v1',
    }),
  );
  assert.notEqual(
    units,
    conversionReadKey('health_intake_plan', {
      ...base,
      section: 'units',
      version: 42,
      mappingVersion: 'mapping-v1',
    }),
  );
  assert.notEqual(
    units,
    conversionReadKey('health_intake_plan', {
      ...base,
      section: 'units',
      version: 41,
      mappingVersion: 'mapping-v2',
    }),
  );
});
