import type {
  Intake,
  IntakeCandidate,
  IntakeClinicalMapping,
  IntakeExtractionPlan,
  IntakeExtractionUnit,
  IntakeQuestion,
} from '../shared/intake.ts';

// Leave room for the fixed plan/pin/count summary so the complete tool result
// stays below the assistant's 64k structured-result envelope.
export const MODEL_INTAKE_CONTEXT_MAX_PAGE_BYTES = 40 * 1024;
const MODEL_INTAKE_CONTEXT_MAX_ITEM_BYTES = 12 * 1024;
const MODEL_INTAKE_CONTEXT_CHUNK_CHARACTERS = 4 * 1024;

export const MODEL_INTAKE_SECTIONS = [
  'plan',
  'units',
  'candidates',
  'occurrences',
  'report_scopes',
  'questions',
  'question_answers',
  'proposals',
  'decisions',
  'batches',
  'operations',
  'acceptances',
  'mapping_rules',
  'missing_assets',
] as const;

export type ModelIntakeSection = (typeof MODEL_INTAKE_SECTIONS)[number];

interface ModelIntakeSource {
  id?: string;
  intakeId?: string;
  sha256?: string;
  version: number;
  mimeType?: string;
  state?: string;
  pendingWorkCount?: number;
  proposals?: Intake['proposals'];
  workflow?: Intake['workflow'] & {
    operations?: { id: string; fingerprint: string; at: string }[];
  };
  plans?: IntakeExtractionPlan[];
  candidates?: IntakeCandidate[];
  questions?: IntakeQuestion[];
  acceptedProposalId?: Intake['acceptedProposalId'];
  imported?: Intake['imported'];
  importHistory?: Intake['importHistory'];
  mappingRules?: unknown[];
  mappingRulesVersion?: string;
}

interface ModelIntakeContextOptions {
  section?: ModelIntakeSection;
  offset?: number;
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

const activePlan = (source: ModelIntakeSource): IntakeExtractionPlan | null =>
  (source.workflow?.plans || source.plans || []).find((plan) => plan.status === 'active') || null;

const candidates = (source: ModelIntakeSource): IntakeCandidate[] =>
  source.workflow?.candidates || source.candidates || [];

const questions = (source: ModelIntakeSource): IntakeQuestion[] =>
  source.workflow?.questions || source.questions || [];

const unit = (value: IntakeExtractionUnit) => ({
  id: value.id,
  kind: value.kind,
  memberId: value.memberId || null,
  sourceFileId: value.sourceFileId || null,
  sourceHash: value.sourceHash || null,
  locator: value.locator,
  pages: value.pages || null,
  start: value.start ?? null,
  end: value.end ?? null,
  status: value.status,
  attemptCount: value.attempts.length,
  coverage: value.coverage || null,
});

const compactUnit = (value: IntakeExtractionUnit) => ({
  id: value.id,
  kind: value.kind,
  sourceFileId: value.sourceFileId || null,
  sourceHash: value.sourceHash || null,
  pages: value.pages || null,
  status: value.status,
  attemptCount: value.attempts.length,
  coverageKind: value.coverage?.kind || null,
});

const MATCH_FIELDS = [
  'kind',
  'label',
  'date',
  'status',
  'eventKind',
  'observationCategory',
  'testLabel',
  'valueText',
  'unit',
  'referenceText',
  'code',
  'codeSystem',
  'specimen',
  'method',
  'medicationName',
  'doseText',
  'route',
  'frequency',
  'medicationKind',
  'dateRole',
  'startDate',
  'endDate',
  'procedureLabel',
  'procedureCategory',
  'documentTitle',
  'documentDate',
] as const satisfies readonly (keyof IntakeClinicalMapping)[];

function clinicalMatch(mapping: Partial<IntakeClinicalMapping> | undefined) {
  if (!mapping) return null;
  const result = Object.fromEntries(
    MATCH_FIELDS.flatMap((key) => (mapping[key] === undefined ? [] : [[key, mapping[key]]])),
  );
  return Object.keys(result).length ? result : null;
}

function candidateVersions(source: ModelIntakeSource) {
  const drafts = new Map(
    (source.workflow?.reviewDrafts || []).map((item) => [item.candidateVersionId, item]),
  );
  const decisions = new Map(
    (source.workflow?.decisions || []).map((item) => [item.candidateVersionId, item]),
  );
  const reportScopesByVersion = new Map<
    string,
    {
      groupId: string;
      groupVersionId: string;
      sourceFileId: string | null;
      sourceHash: string | null;
      memberId: string | null;
    }[]
  >();
  for (const group of source.workflow?.reportGroups || [])
    for (const groupVersion of group.versions)
      for (const member of groupVersion.members) {
        const scopes = reportScopesByVersion.get(member.candidateVersionId) || [];
        scopes.push({
          groupId: group.id,
          groupVersionId: groupVersion.id,
          sourceFileId: group.sourceFileId,
          sourceHash: group.sourceHash,
          memberId: group.memberId,
        });
        reportScopesByVersion.set(member.candidateVersionId, scopes);
      }
  return candidates(source).flatMap((candidate) =>
    candidate.versions.map((version, index) => {
      const draft = drafts.get(version.id);
      const decision = decisions.get(version.id);
      return {
        candidateId: candidate.id,
        envelopeId: candidate.envelopeId,
        sourceSystem: candidate.sourceSystem,
        sourceRecordId: candidate.sourceRecordId,
        candidateVersionId: version.id,
        createdAt: version.createdAt,
        currentVersion: index === candidate.versions.length - 1,
        status: version.status,
        reviewDisposition: draft?.disposition || null,
        matchKeys: clinicalMatch({
          ...decision?.mapping,
          ...draft?.mapping,
          ...draft?.decision?.mapping,
        }),
        locatorCount: new Set(version.occurrences.map((occurrence) => occurrence.locator)).size,
        recentLocators: [
          ...new Set(version.occurrences.map((occurrence) => occurrence.locator)),
        ].slice(-4),
        reportScopeCount: reportScopesByVersion.get(version.id)?.length || 0,
        recentReportScopes: (reportScopesByVersion.get(version.id) || []).slice(-4),
        sourceContext: version.sourceContext === true,
        peopleCount: version.peopleCount || 0,
        peopleOnly: version.peopleOnly === true,
        occurrenceCount: version.occurrences.length,
      };
    }),
  );
}

function recentCandidateVersions(source: ModelIntakeSource, limit: number) {
  const dispositions = new Map(
    (source.workflow?.reviewDrafts || []).map((item) => [
      item.candidateVersionId,
      item.disposition,
    ]),
  );
  const result: {
    candidateId: string;
    candidateVersionId: string;
    currentVersion: boolean;
    status: string;
    reviewDisposition: string | null;
    createdAt: string;
  }[] = [];
  const all = candidates(source);
  for (const candidate of all)
    for (const [versionIndex, version] of candidate.versions.entries()) {
      result.push({
        candidateId: candidate.id,
        candidateVersionId: version.id,
        currentVersion: versionIndex === candidate.versions.length - 1,
        status: version.status,
        reviewDisposition: dispositions.get(version.id) || null,
        createdAt: version.createdAt,
      });
      result.sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.candidateVersionId.localeCompare(right.candidateVersionId)
          : left.createdAt.localeCompare(right.createdAt),
      );
      if (result.length > limit) result.shift();
    }
  return result.map(({ createdAt: _createdAt, ...item }) => item);
}

function occurrences(source: ModelIntakeSource) {
  return candidates(source).flatMap((candidate) =>
    candidate.versions.flatMap((version) =>
      version.occurrences.map((occurrence) => ({
        candidateId: candidate.id,
        candidateVersionId: version.id,
        proposalId: occurrence.proposalId,
        recordId: occurrence.recordId,
        batchId: occurrence.batchId,
        locator: occurrence.locator,
      })),
    ),
  );
}

function reportScopes(source: ModelIntakeSource) {
  return (source.workflow?.reportGroups || []).flatMap((group) =>
    group.versions.map((groupVersion) => ({
      groupId: group.id,
      groupVersionId: groupVersion.id,
      discoveryOrder: group.discoveryOrder ?? null,
      basis: group.basis,
      sourceFileId: group.sourceFileId,
      sourceHash: group.sourceHash,
      sourceSystem: group.sourceSystem,
      memberId: group.memberId,
      report: group.report,
      createdAt: groupVersion.createdAt,
      title: groupVersion.title,
      contributionId: groupVersion.contributionId,
      context: groupVersion.context ?? null,
      contextState: groupVersion.contextState ?? null,
      members: groupVersion.members.map((member) => ({
        candidateId: member.candidateId,
        candidateVersionId: member.candidateVersionId,
        section: member.section ?? null,
        occurrences: member.occurrences,
      })),
    })),
  );
}

const question = (value: IntakeQuestion) => ({
  id: value.id,
  key: value.key,
  candidateId: value.candidateId,
  candidateVersionId: value.candidateVersionId,
  otherRecordId: value.otherRecordId || null,
  prompt: value.prompt,
  locator: value.locator,
  field: value.field,
  status: value.status,
  createdAt: value.createdAt,
  answerCount: value.answers.length,
  resolvedAt: value.resolvedAt || null,
  resolvedByDecisionId: value.resolvedByDecisionId || null,
});

function questionAnswers(source: ModelIntakeSource) {
  return questions(source).flatMap((item) =>
    item.answers.map((answer) => ({
      questionId: item.id,
      candidateId: item.candidateId,
      candidateVersionId: item.candidateVersionId,
      otherRecordId: item.otherRecordId || null,
      id: answer.id,
      answer: answer.answer,
      mapping: answer.mapping,
      scope: answer.scope,
      at: answer.at,
      ...(('outcome' in answer && answer.outcome) || null
        ? { outcome: (answer as typeof answer & { outcome: string }).outcome }
        : {}),
      ...(('otherRecordId' in answer && answer.otherRecordId) || null
        ? { comparedRecordId: (answer as typeof answer & { otherRecordId: string }).otherRecordId }
        : {}),
    })),
  );
}

function proposals(source: ModelIntakeSource) {
  return (source.proposals || []).map((proposal) => ({
    id: proposal.id,
    fileId: proposal.fileId,
    summary: proposal.summary,
    contentUrl: proposal.contentUrl,
    createdAt: proposal.createdAt,
    runId: proposal.runId,
  }));
}

function decisions(source: ModelIntakeSource) {
  const accepted = (source.workflow?.decisions || []).map((item) => ({
    kind: 'accepted_decision',
    id: item.id,
    candidateId: item.candidateId,
    candidateVersionId: item.candidateVersionId,
    recordId: item.recordId,
    action: item.action,
    mapping: item.mapping,
    scope: item.scope,
    evidence: 'evidence' in item ? item.evidence : null,
    at: item.at,
  }));
  const drafts = (source.workflow?.reviewDrafts || []).map((item) => ({
    kind: 'review_draft',
    id: item.id,
    proposalId: item.proposalId,
    recordId: item.recordId,
    candidateId: item.candidateId,
    candidateVersionId: item.candidateVersionId,
    disposition: item.disposition,
    mapping: item.mapping,
    resolutions: item.resolutions,
    decision: item.decision || null,
    answerDrafts: item.answers || null,
    at: item.at,
  }));
  return [...accepted, ...drafts];
}

function batches(source: ModelIntakeSource) {
  return (source.workflow?.plans || source.plans || []).flatMap((plan) =>
    plan.batches.map((batch) => ({
      planId: plan.id,
      planStatus: plan.status,
      operationId: batch.id,
      proposalId: batch.proposalId,
      at: batch.at,
      coverage: batch.coverage,
    })),
  );
}

function planState(source: ModelIntakeSource) {
  return (source.workflow?.plans || source.plans || []).map((plan) => ({
    id: plan.id,
    status: plan.status,
    createdAt: plan.createdAt,
    pins: plan.pins,
    index: {
      kind: plan.index.kind,
      coverage: plan.index.coverage,
      inventoryVersion: plan.index.inventoryVersion || null,
      totalMembers: plan.index.totalMembers ?? null,
      totalExpandedBytes: plan.index.totalExpandedBytes ?? null,
      uniqueByteContents: plan.index.uniqueByteContents ?? null,
      missingAssetCount: plan.index.missingAssets.length,
    },
    unitCount: plan.units.length,
    roleProposalCount: plan.packageRoles?.length || 0,
    batchCount: plan.batches.length,
  }));
}

function acceptances(source: ModelIntakeSource) {
  return [
    ...(source.acceptedProposalId || source.imported
      ? [
          {
            kind: 'current_acceptance',
            acceptedProposalId: source.acceptedProposalId || null,
            imported: source.imported || null,
          },
        ]
      : []),
    ...(source.importHistory || []).map((item) => ({ kind: 'import_history', ...item })),
  ];
}

const missingAsset = (value: IntakeExtractionPlan['index']['missingAssets'][number]) => ({
  locator: value.locator,
  source: value.source,
  status: value.status,
  sourceFileId: value.sourceFileId || null,
  contentUrl: value.contentUrl || null,
});

function sectionItems(source: ModelIntakeSource, section: ModelIntakeSection): unknown[] {
  const plan = activePlan(source);
  if (section === 'plan') return planState(source);
  if (section === 'units') return (plan?.units || []).map(unit);
  if (section === 'candidates') return candidateVersions(source);
  if (section === 'occurrences') return occurrences(source);
  if (section === 'report_scopes') return reportScopes(source);
  if (section === 'questions') return questions(source).map(question);
  if (section === 'question_answers') return questionAnswers(source);
  if (section === 'proposals') return proposals(source);
  if (section === 'decisions') return decisions(source);
  if (section === 'batches') return batches(source);
  if (section === 'operations') return source.workflow?.operations || [];
  if (section === 'acceptances') return acceptances(source);
  if (section === 'mapping_rules') return source.mappingRules || [];
  return (plan?.index.missingAssets || []).map(missingAsset);
}

function sectionCount(source: ModelIntakeSource, section: ModelIntakeSection): number {
  const plan = activePlan(source);
  if (section === 'plan') return (source.workflow?.plans || source.plans || []).length;
  if (section === 'units') return plan?.units.length || 0;
  if (section === 'candidates')
    return candidates(source).reduce((sum, candidate) => sum + candidate.versions.length, 0);
  if (section === 'occurrences')
    return candidates(source).reduce(
      (sum, candidate) =>
        sum +
        candidate.versions.reduce(
          (versionSum, version) => versionSum + version.occurrences.length,
          0,
        ),
      0,
    );
  if (section === 'report_scopes')
    return (source.workflow?.reportGroups || []).reduce(
      (groupSum, group) => groupSum + group.versions.length,
      0,
    );
  if (section === 'questions') return questions(source).length;
  if (section === 'question_answers')
    return questions(source).reduce((sum, item) => sum + item.answers.length, 0);
  if (section === 'proposals') return source.proposals?.length || 0;
  if (section === 'decisions')
    return (source.workflow?.decisions.length || 0) + (source.workflow?.reviewDrafts?.length || 0);
  if (section === 'batches')
    return (source.workflow?.plans || source.plans || []).reduce(
      (sum, item) => sum + item.batches.length,
      0,
    );
  if (section === 'operations') return source.workflow?.operations?.length || 0;
  if (section === 'acceptances')
    return (
      (source.acceptedProposalId || source.imported ? 1 : 0) + (source.importHistory?.length || 0)
    );
  if (section === 'mapping_rules') return source.mappingRules?.length || 0;
  return plan?.index.missingAssets.length || 0;
}

function wireItems(items: unknown[]) {
  return items.flatMap((item, itemIndex) => {
    if (bytes(item) <= MODEL_INTAKE_CONTEXT_MAX_ITEM_BYTES) return [item];
    const jsonText = JSON.stringify(item);
    const chunks = Array.from(
      { length: Math.ceil(jsonText.length / MODEL_INTAKE_CONTEXT_CHUNK_CHARACTERS) },
      (_, chunkIndex) =>
        jsonText.slice(
          chunkIndex * MODEL_INTAKE_CONTEXT_CHUNK_CHARACTERS,
          (chunkIndex + 1) * MODEL_INTAKE_CONTEXT_CHUNK_CHARACTERS,
        ),
    );
    return chunks.map((chunk, chunkIndex) => ({
      format: 'health-intake-json-item-chunk-v1',
      itemIndex,
      chunkIndex,
      chunkCount: chunks.length,
      jsonText: chunk,
    }));
  });
}

function page(items: unknown[], offset: number) {
  const selected: unknown[] = [];
  let index = offset;
  while (index < items.length) {
    const next = [...selected, items[index]];
    if (selected.length && bytes(next) > MODEL_INTAKE_CONTEXT_MAX_PAGE_BYTES) break;
    selected.push(items[index]);
    index += 1;
  }
  return {
    offset,
    items: selected,
    nextOffset: index < items.length ? index : null,
    complete: index >= items.length,
  };
}

function summary(source: ModelIntakeSource) {
  const plan = activePlan(source);
  const allCandidates = candidates(source);
  const allQuestions = questions(source);
  const recentVersions = recentCandidateVersions(source, 12);
  const latestProposal = source.proposals?.at(-1);
  const unitCounts = { pending: 0, partial: 0, completed: 0 };
  for (const item of plan?.units || []) unitCounts[item.status] += 1;
  return {
    format: 'health-intake-model-context-v1',
    id: source.id || source.intakeId,
    sourceHash: source.sha256 || plan?.pins.sourceHash || null,
    version: source.version,
    mimeType: source.mimeType || null,
    state: source.state || null,
    pendingWorkCount: source.pendingWorkCount ?? null,
    plan: plan
      ? {
          id: plan.id,
          status: plan.status,
          createdAt: plan.createdAt,
          pinsSection: 'plan',
          index: {
            kind: plan.index.kind,
            coverage: plan.index.coverage,
            missingAssetCount: plan.index.missingAssets.length,
          },
          unitCount: plan.units.length,
          unitCounts,
          batchCount: plan.batches.length,
        }
      : null,
    candidates: {
      candidateCount: allCandidates.length,
      versionCount: sectionCount(source, 'candidates'),
      occurrenceCount: sectionCount(source, 'occurrences'),
      recentVersions,
      exhaustiveSection: 'candidates',
      occurrenceSection: 'occurrences',
    },
    questions: {
      count: allQuestions.length,
      unansweredCount: allQuestions.filter((item) => item.status === 'unanswered').length,
      recentlyCreated: [...allQuestions]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(-8)
        .map((item) => ({
          id: item.id,
          key: item.key,
          candidateId: item.candidateId,
          candidateVersionId: item.candidateVersionId,
          field: item.field,
          status: item.status,
        })),
      exhaustiveSection: 'questions',
      answerSection: 'question_answers',
    },
    proposals: {
      count: source.proposals?.length || 0,
      latest: latestProposal
        ? {
            id: latestProposal.id,
            fileId: latestProposal.fileId,
            contentUrl: latestProposal.contentUrl,
            createdAt: latestProposal.createdAt,
          }
        : null,
      exhaustiveSection: 'proposals',
    },
    acceptances: {
      acceptedProposalId: source.acceptedProposalId || null,
      currentImport: source.imported !== null && source.imported !== undefined,
      historyCount: source.importHistory?.length || 0,
      exhaustiveSection: 'acceptances',
    },
    mappingRules: {
      count: source.mappingRules?.length || 0,
      version: source.mappingRulesVersion || null,
      planVersion: plan?.pins.mappingVersion || null,
      consistentWithPlan:
        !plan || !source.mappingRulesVersion
          ? null
          : plan.pins.mappingVersion === source.mappingRulesVersion,
      exhaustiveSection: 'mapping_rules',
    },
    sections: MODEL_INTAKE_SECTIONS.map((section) => ({
      section,
      count: sectionCount(source, section),
    })),
    paging:
      'Use health_intake_plan action read with section and offset. Follow nextOffset until complete. Reassemble explicitly marked JSON item chunks when present. Use action read_unit with an exact unitId for literal unit evidence.',
    identitySafety:
      'Candidate match keys and equal values are review context only, never automatic proof of one event. Preserve distinct occurrences and use the exhaustive occurrences, report_scopes and question_answers sections to compare candidate IDs, locators, report scope, prior explicit outcomes, event/date roles, region or specimen, method and reference context before proposing a relationship.',
  };
}

export function modelIntakeContext(
  source: ModelIntakeSource,
  { section = 'units', offset = 0 }: ModelIntakeContextOptions = {},
) {
  const normalizedOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const items = sectionItems(source, section);
  const wired = wireItems(items);
  return {
    ...summary(source),
    page: {
      section,
      logicalTotal: items.length,
      total: wired.length,
      chunked: wired.length !== items.length,
      chunkInstructions:
        'Items with format health-intake-json-item-chunk-v1 are exact JSON fragments. Concatenate jsonText in chunkIndex order for the same itemIndex, then parse the complete JSON item.',
      ...page(wired, normalizedOffset),
    },
  };
}

export function modelIntakeEvidenceContext(
  intake: Intake,
  {
    page: pageNumber,
    mappingRules,
    mappingRulesVersion,
  }: { page?: number; mappingRules?: unknown[]; mappingRulesVersion?: string } = {},
) {
  const source = { ...intake, mappingRules, mappingRulesVersion };
  const plan = activePlan(source);
  const currentUnits: ReturnType<typeof compactUnit>[] = [];
  let currentUnitCount = 0;
  for (const item of plan?.units || []) {
    if (
      (item.sourceFileId || intake.id) !== intake.id ||
      (pageNumber !== undefined && !item.pages?.includes(pageNumber))
    )
      continue;
    currentUnitCount += 1;
    if (currentUnits.length < 8) currentUnits.push(compactUnit(item));
  }
  const context = summary(source);
  return {
    format: context.format,
    id: context.id,
    sourceHash: context.sourceHash,
    version: context.version,
    mimeType: context.mimeType,
    state: context.state,
    pendingWorkCount: context.pendingWorkCount,
    plan: context.plan,
    candidates: {
      candidateCount: context.candidates.candidateCount,
      versionCount: context.candidates.versionCount,
      occurrenceCount: context.candidates.occurrenceCount,
      recentVersions: context.candidates.recentVersions.slice(-4),
      exhaustiveSection: context.candidates.exhaustiveSection,
      occurrenceSection: context.candidates.occurrenceSection,
    },
    questions: {
      count: context.questions.count,
      unansweredCount: context.questions.unansweredCount,
      exhaustiveSection: context.questions.exhaustiveSection,
      answerSection: context.questions.answerSection,
    },
    acceptances: context.acceptances,
    mappingRules: context.mappingRules,
    currentUnitCount,
    currentUnits,
    currentUnitsComplete: currentUnitCount <= currentUnits.length,
    currentUnitsSection: 'units',
    sections: context.sections,
    paging: context.paging,
    identitySafety: context.identitySafety,
  };
}
