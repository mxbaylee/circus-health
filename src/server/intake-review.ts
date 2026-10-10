import { finishClinicalReviewWork, someClinicalReviewWork } from './clinical-review-work.ts';
import { latestSelfReviewDraftResolution } from './intake-review-draft-selection.ts';
import { labelledBirthDates, supportedDateValues } from './intake-evidence-dates.ts';
import type { ReviewIssueCollection } from './intake-review-issue-state.ts';
import { createHash } from 'node:crypto';
import { HttpError } from './database.ts';
import { clinicalFields, clinicalMappingEnvelope, datePrecision } from './clinical-import.ts';
import { validClinicalFieldValue } from './optical-prescription.ts';
import type {
  IntakeClinicalMapping,
  IntakeQuestion,
  IntakeReviewDecision,
  IntakeReviewDraft,
  IntakeReviewIssue,
  IntakeReviewRecord,
  IntakeWorkflow,
} from '../shared/intake.ts';
import { canonicalLiteral, type IntakeEntry } from './intake-format.ts';

type IssueKind = IntakeReviewIssue['kind'];
type UnknownRecord = Record<string, unknown>;
interface ReviewRecordInput extends IntakeReviewRecord {
  undraftedMapping?: IntakeClinicalMapping;
  identityConfirmationRequired?: boolean;
}

interface ReviewIssueSource extends UnknownRecord {
  id?: string;
  kind?: unknown;
  prompt?: unknown;
  field?: unknown;
  textAnchor?: unknown;
  page?: unknown;
  memberId?: unknown;
  sourceSuggestion?: unknown;
  metadataSuggestion?: unknown;
  selfSuggestion?: unknown;
  choices?: unknown;
}

const object = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const kinds: IssueKind[] = ['identity', 'date', 'uncertain_reading', 'information'];
const dateFields = ['date', 'documentDate', 'startDate', 'endDate'];
const documentDateFields = ['date', 'documentDate'];
const metadataSuggestionFields = ['careArea', 'documentType', 'topics'];
const maxMetadataTopics = 12;
const maxMetadataLabelLength = 200;
export interface SuggestionEvidenceScope {
  packageEvidence: boolean;
  reportScoped: boolean;
  memberId: string | null;
  /** Exact printed subject from the host-resolved report group, never model-selected context. */
  reportSubject?: string | null;
}

function metadataLabel(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > maxMetadataLabelLength) return null;
  const label = value.trim();
  if (!label || /[\r\n\u2028\u2029]/.test(label)) return null;
  return label;
}

function payloadContainsAnchor(payload: unknown, anchor: string): boolean {
  const pending = [payload];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (pending.length && visited++ < 100_000) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (value.includes(anchor)) return true;
      continue;
    }
    if (!value || typeof value !== 'object' || JSON.isRawJSON(value) || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) pending.push(...value);
    else pending.push(...Object.values(value));
  }
  return false;
}

function suggestionEvidence(
  item: ReviewIssueSource,
  value: IntakeEntry['value'],
  scope: SuggestionEvidenceScope,
): string | null {
  const sourceAnchor = typeof item.textAnchor === 'string' ? item.textAnchor : '';
  const anchor = sourceAnchor.trim();
  if (
    !anchor ||
    sourceAnchor.length > 4000 ||
    !payloadContainsAnchor(value.payload, sourceAnchor) ||
    (scope.packageEvidence && (!scope.reportScoped || !scope.memberId)) ||
    (item.memberId !== undefined && item.memberId !== scope.memberId) ||
    (scope.memberId !== null && item.memberId !== scope.memberId) ||
    (value.report?.memberId !== undefined && value.report.memberId !== scope.memberId)
  )
    return null;
  return sourceAnchor;
}

function scopedSourceSuggestion(
  item: ReviewIssueSource,
  value: IntakeEntry['value'],
  scope: SuggestionEvidenceScope,
): string | null {
  const anchor = suggestionEvidence(item, value, scope);
  const label = metadataLabel(item.sourceSuggestion);
  return anchor && label && anchor.includes(label) ? label : null;
}

/** Shared report-context normalization uses the same bounded evidence gate as row issues. */
export function evidenceScopedSourceSuggestion(
  item: unknown,
  value: IntakeEntry['value'],
  scope: SuggestionEvidenceScope,
): { value: string; textAnchor: string } | null {
  if (!object(item)) return null;
  const source = item as ReviewIssueSource;
  const suggestion = scopedSourceSuggestion(source, value, scope);
  const textAnchor = suggestionEvidence(source, value, scope);
  return suggestion && textAnchor ? { value: suggestion, textAnchor } : null;
}

function containsExactDateTime(anchor: string, value: string): boolean {
  let offset = 0;
  while ((offset = anchor.indexOf(value, offset)) >= 0) {
    const before = anchor[offset - 1];
    const afterIndex = offset + value.length;
    const after = anchor[afterIndex];
    const continuesFraction = after === '.' && /\d/.test(anchor[afterIndex + 1] || '');
    if (
      (!before || !/[0-9A-Za-z]/.test(before)) &&
      (!after || (!/[0-9A-Za-z:+\-]/.test(after) && !continuesFraction))
    )
      return true;
    offset += value.length;
  }
  return false;
}

function supportedDateValue(value: string, anchor: string): boolean {
  let precision: ReturnType<typeof datePrecision>;
  try {
    precision = datePrecision(value);
  } catch {
    return false;
  }
  return precision === 'datetime'
    ? containsExactDateTime(anchor, value)
    : supportedDateValues(anchor).has(value);
}

function scopedDateChoices(
  item: ReviewIssueSource,
  value: IntakeEntry['value'],
  scope: SuggestionEvidenceScope,
): IntakeReviewIssue['choices'] | null {
  if (
    item.kind !== 'date' ||
    typeof item.field !== 'string' ||
    !dateFields.includes(item.field) ||
    !Array.isArray(item.choices) ||
    !item.choices.length ||
    item.choices.length > 20
  )
    return null;
  const anchor = suggestionEvidence(item, value, scope);
  if (!anchor) return null;
  const choices: NonNullable<IntakeReviewIssue['choices']> = [];
  for (const choice of item.choices) {
    if (!object(choice) || Object.keys(choice).some((key) => !['label', 'value'].includes(key)))
      return null;
    if (
      typeof choice.value === 'string' &&
      ['', 'unknown', '__unknown__'].includes(choice.value.trim().toLowerCase())
    )
      continue;
    const label = metadataLabel(choice.label);
    const date = metadataLabel(choice.value);
    if (!label || !date || !supportedDateValue(date, anchor)) return null;
    if (!choices.some((candidate) => candidate.value === date))
      choices.push({ label, value: date });
  }
  return choices.length ? choices : null;
}

function scopedSelfSuggestion(
  item: ReviewIssueSource,
  value: IntakeEntry['value'],
  _record: ReviewRecordInput,
  scope: SuggestionEvidenceScope,
): IntakeReviewIssue['selfSuggestion'] | null {
  if (
    item.kind !== 'identity' ||
    item.field !== 'subject' ||
    !object(item.selfSuggestion) ||
    Object.keys(item.selfSuggestion).some((key) => !['fullName', 'birthDate'].includes(key))
  )
    return null;
  const anchor = suggestionEvidence(item, value, scope);
  if (!anchor) return null;
  const reportSubject = scope.reportScoped ? scope.reportSubject : null;
  if (scope.reportScoped) {
    if (
      !reportSubject ||
      !payloadContainsAnchor(value.payload, reportSubject) ||
      !anchor.includes(reportSubject)
    )
      return null;
  }
  const input = item.selfSuggestion;
  const result: NonNullable<IntakeReviewIssue['selfSuggestion']> = {};
  if (Object.hasOwn(input, 'fullName')) {
    const fullName = metadataLabel(input.fullName);
    const nameEvidence = reportSubject || anchor;
    if (fullName && nameEvidence.includes(fullName)) result.fullName = fullName;
  }
  // A labelled patient DOB is independent of collection/report dates elsewhere
  // in the same literal evidence. Never resolve an ambiguous DOB against Self.
  const labelledDates = new Set<string>();
  const dobSource =
    reportSubject && anchor.includes(reportSubject)
      ? anchor.slice(anchor.indexOf(reportSubject))
      : anchor;
  // An anchor containing multiple people is not evidence of one person's DOB.
  const mixedPeople =
    /\b(?:mother|father|sibling|spouse|child|family history)\b/i.test(dobSource) ||
    [...dobSource.matchAll(/\b(?:patient|subject)\s*:/gi)].length > 1;
  if (!mixedPeople) for (const date of labelledBirthDates(dobSource)) labelledDates.add(date);
  if (labelledDates.size === 1) {
    result.birthDate = [...labelledDates][0]!;
  } else if (!mixedPeople && labelledDates.size === 0 && Object.hasOwn(input, 'birthDate')) {
    const birthDate = metadataLabel(input.birthDate);
    if (birthDate && birthDate.toLowerCase() !== 'unknown') {
      const subjectDates = reportSubject ? supportedDateValues(reportSubject) : new Set<string>();
      const supported =
        subjectDates.size > 0 && subjectDates.has(birthDate)
          ? subjectDates
          : supportedDateValues(anchor);
      if (supported.size === 1 && supported.has(birthDate)) result.birthDate = birthDate;
    }
  }
  return Object.keys(result).length ? result : null;
}

function scopedMetadataSuggestion(
  item: ReviewIssueSource,
  value: IntakeEntry['value'],
  scope: SuggestionEvidenceScope,
): IntakeReviewIssue['metadataSuggestion'] | null {
  if (!object(item.metadataSuggestion)) return null;
  const input = item.metadataSuggestion;
  const anchor = suggestionEvidence(item, value, scope);
  if (Object.keys(input).some((field) => !metadataSuggestionFields.includes(field)) || !anchor)
    return null;
  const result: NonNullable<IntakeReviewIssue['metadataSuggestion']> = {};
  for (const field of ['careArea', 'documentType'] as const) {
    if (!Object.hasOwn(input, field)) continue;
    const label = metadataLabel(input[field]);
    if (!label) return null;
    result[field] = label;
  }
  if (Object.hasOwn(input, 'topics')) {
    if (!Array.isArray(input.topics) || input.topics.length > maxMetadataTopics) return null;
    const topics = input.topics.map(metadataLabel);
    if (topics.some((topic) => !topic)) return null;
    const uniqueTopics = [...new Set(topics as string[])];
    if (uniqueTopics.length) result.topics = uniqueTopics;
  }
  return Object.keys(result).length ? result : null;
}

export function issueKind(prompt: string, field: string | null = null): IssueKind {
  if (field === 'subject') return 'identity';
  if (dateFields.includes(field || '')) return 'date';
  // Explanatory source/type/provenance notes are not requests to change a
  // clinical assertion merely because they mention a patient or date.
  const request =
    /^\s*(?:please\s+)?(?:confirm|clarify|verify|choose|select|enter|correct|check|review)\b/i.test(
      prompt,
    ) || /\?/.test(prompt);
  const unclear =
    /\b(illegible|unreadable|unclear|ambiguous|uncertain|unknown|missing)\b|\bnot (?:known|clear|stated)\b/i.test(
      prompt,
    );
  if ((request || unclear) && /\b(patient|subject|identity|this is me)\b/i.test(prompt))
    return 'identity';
  if (request && /\b(date|dated|year|month|day)\b/i.test(prompt)) return 'date';
  if (unclear && /\b(date|dated|year|month|day)\b/i.test(prompt)) return 'information';
  if (request || /\b(illegible|unreadable|unclear|ambiguous)\b/i.test(prompt))
    return 'uncertain_reading';
  return 'information';
}

export function actionableIssueKind(prompt: string, field: string | null = null): IssueKind {
  const kind = issueKind(prompt, field);
  return kind === 'date' && !dateFields.includes(field || '') ? 'information' : kind;
}

export function resolutionFields(
  issue: Pick<IntakeReviewIssue, 'kind' | 'field'>,
): (keyof IntakeClinicalMapping)[] {
  if (issue.kind === 'information') return [];
  if (issue.kind === 'identity') return ['subject', 'kind'];
  if (issue.kind === 'date')
    return documentDateFields.includes(issue.field || '')
      ? ['date', 'documentDate']
      : dateFields.includes(issue.field || '')
        ? [issue.field as keyof IntakeClinicalMapping]
        : [];
  return Object.values(clinicalFields)
    .flat()
    .includes(issue.field as keyof IntakeClinicalMapping)
    ? [issue.field as keyof IntakeClinicalMapping]
    : [];
}
export function reviewIssues(...input: Parameters<typeof reviewIssuesWork>): ReviewIssueCollection {
  return finishClinicalReviewWork(reviewIssuesWork(...input));
}
export function* reviewIssuesWork(
  record: ReviewRecordInput,
  entry: IntakeEntry,
  questions: Iterable<IntakeQuestion> & {
    some(predicate: (question: IntakeQuestion) => boolean): boolean;
  } = [],
  metadataScope: SuggestionEvidenceScope = {
    packageEvidence: false,
    reportScoped: false,
    memberId: null,
  },
  sink?: ReviewIssueCollection,
): Generator<void, ReviewIssueCollection, void> {
  const issues: ReviewIssueCollection = sink || [];
  const add = (
    prompt: unknown,
    kind: IssueKind,
    field: string | null = null,
    question: IntakeQuestion | null = null,
    key: unknown = prompt,
  ): IntakeReviewIssue | null => {
    if (typeof prompt !== 'string' || !prompt.trim()) return null;
    const writableKind =
      kind === 'date' && !dateFields.includes(field || '') ? 'information' : kind;
    const writableField = writableKind === 'information' && kind === 'date' ? null : field;
    const id = question?.id || 'issue:' + hash([record.candidateVersionId, writableKind, key]);
    const retained = issues.findId ? issues.findId(id) : issues.find((issue) => issue.id === id);
    if (retained) return retained;
    issues.push({
      id,
      kind: writableKind,
      prompt,
      field: writableField,
      blocking: writableKind === 'identity' || writableKind === 'uncertain_reading',
      status: question?.status === 'resolved' ? 'resolved' : 'unresolved',
      locator: entry.value.provenance.locator,
      questionId: question?.id || null,
    });
    return issues.at(-1)!;
  };
  const value = entry.value;
  const clinical = clinicalMappingEnvelope(value);
  const original = record.undraftedMapping || record.mapping;
  const explicit = [
    ...(Array.isArray(value.reviewIssues) ? value.reviewIssues : []),
    ...(Array.isArray(clinical.reviewIssues) ? clinical.reviewIssues : []),
  ] as ReviewIssueSource[];
  const retainedSelfConfirmation = latestSelfReviewDraftResolution(record.draft);
  if (
    original.subject !== 'self' ||
    (record.identityConfirmationRequired &&
      record.reviewState !== 'accepted' &&
      !record.projectionUpgrade)
  ) {
    const issue = add('Does this record belong to you?', 'identity', 'subject', null, 'subject');
    if (issue && retainedSelfConfirmation) {
      issue.status = 'resolved';
      issue.resolution = retainedSelfConfirmation;
    }
  }
  const scopedDocumentDateReview =
    (yield* someClinicalReviewWork(questions, function* (question) {
      return (
        documentDateFields.includes(question.field || '') &&
        actionableIssueKind(question.prompt, question.field) === 'date'
      );
    })) ||
    explicit.some(
      (item) =>
        item?.kind === 'date' &&
        documentDateFields.includes(typeof item.field === 'string' ? item.field : '') &&
        typeof item.prompt === 'string' &&
        item.prompt.trim(),
    );
  if (!original.date && !original.documentDate && !scopedDocumentDateReview)
    add(
      'The document date is unknown. Keep it unknown or enter the date supported by the original.',
      'date',
      'date',
      null,
      'date',
    );
  for (const question of questions) {
    yield;
    add(question.prompt, issueKind(question.prompt, question.field), question.field, question);
  }
  for (const item of explicit) {
    yield;
    if (item && kinds.includes(item.kind as IssueKind)) {
      const issue = add(
        item.prompt,
        item.kind as IssueKind,
        typeof item.field === 'string' ? item.field : null,
        null,
        item.id || item.prompt,
      );
      if (!issue) continue;
      for (const field of ['textAnchor', 'memberId'])
        if (typeof item[field] === 'string')
          (issue as unknown as UnknownRecord)[field] = (item[field] as string).slice(0, 4000);
      const page = JSON.isRawJSON(item.page) ? Number(JSON.stringify(item.page)) : item.page;
      if (Number.isSafeInteger(page) && (page as number) > 0) issue.page = page as number;
      const sourceSuggestion = scopedSourceSuggestion(item, value, metadataScope);
      if (sourceSuggestion) issue.sourceSuggestion = sourceSuggestion;
      const metadataSuggestion = scopedMetadataSuggestion(item, value, metadataScope);
      if (metadataSuggestion) issue.metadataSuggestion = metadataSuggestion;
      const selfSuggestion = scopedSelfSuggestion(item, value, record, metadataScope);
      if (selfSuggestion) issue.selfSuggestion = selfSuggestion;
      const choices = scopedDateChoices(item, value, metadataScope);
      if (choices) issue.choices = choices;
    }
  }
  const sourceUncertainties = [
    ...(Array.isArray(value.uncertainties) ? value.uncertainties : []),
    ...(Array.isArray(clinical.uncertainties) ? clinical.uncertainties : []),
  ];
  for (const prompt of sourceUncertainties) {
    if (
      !(yield* someClinicalReviewWork(questions, function* (q) {
        return q.prompt === prompt;
      }))
    )
      add(prompt, issueKind(prompt));
  }
  for (const prompt of record.uncertainties)
    if (!sourceUncertainties.includes(prompt)) add(prompt, 'information');
  if (value.mappingReview) {
    const notes =
      typeof value.mappingReview === 'string'
        ? value.mappingReview
        : JSON.stringify(value.mappingReview);
    add(notes, 'information', null, null, 'legacy-mapping-review');
  }
  return issues;
}
type ValidClinicalFieldValue = (field: keyof IntakeClinicalMapping, value: unknown) => boolean;

export function validateDraftMapping(
  mapping: unknown = {},
  baseline: IntakeClinicalMapping = {},
): Partial<IntakeClinicalMapping> {
  const fields = new Set<string>(Object.values(clinicalFields).flat());
  if (
    !mapping ||
    typeof mapping !== 'object' ||
    Array.isArray(mapping) ||
    Object.entries(mapping).some(([key, value]) =>
      fields.has(key)
        ? !(validClinicalFieldValue as unknown as ValidClinicalFieldValue)(
            key as keyof IntakeClinicalMapping,
            value,
          )
        : canonicalLiteral(value) !== canonicalLiteral((baseline as UnknownRecord)[key]),
    )
  )
    throw new HttpError(
      400,
      'IMPORT_MAPPING',
      'Draft mapping must contain supported record fields',
    );
  for (const [key, value] of Object.entries(mapping))
    if (dateFields.includes(key) && value !== (baseline as UnknownRecord)[key])
      datePrecision(value as string);
  return Object.fromEntries(
    Object.entries(mapping).filter(([key]) => fields.has(key)),
  ) as Partial<IntakeClinicalMapping>;
}
export function validateDraftDecision(
  decision: unknown,
  record: IntakeReviewRecord,
): IntakeReviewDecision {
  if (
    !object(decision) ||
    decision.recordId !== record.id ||
    !['accept', 'skip'].includes(decision.action as string) ||
    Object.keys(decision).some(
      (k) => !['recordId', 'action', 'mapping', 'rememberRule', 'comparisons'].includes(k),
    )
  )
    throw new HttpError(400, 'IMPORT_REVIEW', 'Supply this record’s review decision');
  const value = { ...decision, mapping: validateDraftMapping(decision.mapping, record.mapping) };
  if (decision.rememberRule) {
    const rule = decision.rememberRule as UnknownRecord;
    const match = rule.match as UnknownRecord | undefined;
    const set = rule.set as UnknownRecord | undefined;
    if (
      !match ||
      typeof match.label !== 'string' ||
      match.label.length > 500 ||
      !Object.hasOwn(clinicalFields, match.kind as PropertyKey) ||
      !set ||
      Object.entries(set).some(
        ([k, v]) =>
          ![
            'testLabel',
            'medicationName',
            'procedureLabel',
            'procedureCategory',
            'documentTitle',
          ].includes(k) ||
          typeof v !== 'string' ||
          v.length > 500,
      )
    )
      throw new HttpError(400, 'MAPPING_RULE', 'Supply a supported narrow draft mapping rule');
  }
  if (
    decision.comparisons !== undefined &&
    (!Array.isArray(decision.comparisons) ||
      decision.comparisons.length > 100 ||
      new Set((decision.comparisons as UnknownRecord[]).map((c) => c?.otherRecordId)).size !==
        decision.comparisons.length ||
      (decision.comparisons as UnknownRecord[]).some(
        (c) =>
          !object(c) ||
          Object.keys(c).some(
            (key) =>
              !['otherRecordId', 'scope', 'outcome', 'reason', 'occurrenceEvidence'].includes(key),
          ) ||
          typeof c.otherRecordId !== 'string' ||
          !['same_event', 'changed_version', 'distinct', 'unresolved'].includes(
            c.outcome as string,
          ) ||
          typeof c.reason !== 'string' ||
          c.reason.length > 10000 ||
          (c.occurrenceEvidence !== undefined &&
            (c.occurrenceEvidence !== 'attach' || c.outcome !== 'same_event')),
      ))
  )
    throw new HttpError(
      400,
      'DUPLICATE_DECISION',
      'Supply this record’s paired-evidence draft decisions',
    );
  if (
    ((decision.comparisons || []) as UnknownRecord[]).filter(
      (comparison) => comparison.occurrenceEvidence === 'attach',
    ).length > 1
  )
    throw new HttpError(
      400,
      'DUPLICATE_DECISION',
      'Attach one incoming occurrence to at most one reviewed saved record',
    );
  // New choices must echo the exact displayed pair. Historical unpinned drafts
  // remain readable, but cannot acquire a fresh scope through an ordinary autosave.
  for (const comparison of (decision.comparisons || []) as UnknownRecord[]) {
    const retained = record.draft?.decision?.comparisons?.find(
      (item) => item.otherRecordId === comparison.otherRecordId,
    );
    // Carry-forward is not a new relationship decision. Keep the reminder while
    // allowing unrelated edits; acceptance independently revalidates every scope.
    if (retained && canonicalLiteral(retained) === canonicalLiteral(comparison)) continue;
    const scope = comparison.scope as
      { incoming?: unknown; saved?: { recordId?: unknown }; token?: unknown } | undefined;
    const displayed = record.comparisons?.find((item) => item.id === comparison.otherRecordId);
    if (
      !scope ||
      scope.saved?.recordId !== comparison.otherRecordId ||
      canonicalLiteral(scope.incoming) !== canonicalLiteral(record.comparisonReference) ||
      typeof scope.token !== 'string' ||
      (displayed && canonicalLiteral(displayed.scope) !== canonicalLiteral(scope))
    )
      throw new HttpError(
        409,
        'DUPLICATE_SCOPE_CHANGED',
        'Review both exact record versions and their originals again before choosing this relationship',
      );
    if (
      comparison.occurrenceEvidence === 'attach' &&
      (scope as { format?: unknown }).format !== 'intake-pair-scope-v2'
    )
      throw new HttpError(
        409,
        'DUPLICATE_SCOPE_CHANGED',
        'Refresh this exact pair before attaching its source occurrence',
      );
  }
  return value as unknown as IntakeReviewDecision;
}
export function currentReviewDraft(
  workflow: IntakeWorkflow,
  proposalId: string | null,
  recordId: string,
  candidateVersionId: string,
): IntakeReviewDraft | null {
  return (
    (workflow.reviewDrafts || []).findLast(
      (draft) =>
        draft.proposalId === proposalId &&
        draft.recordId === recordId &&
        draft.candidateVersionId === candidateVersionId,
    ) || null
  );
}
