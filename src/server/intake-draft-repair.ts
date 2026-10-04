import { currentClinicalOperation, runExclusiveClinicalOperation } from './clinical-operation.ts';
import { selectedReportGroups } from './intake-selected-report-groups.ts';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from './database.ts';
import type { Database } from './database.ts';
import {
  getIntakeRead,
  reviewIntake,
  saveIntakeDraftRepair,
  verifyIntakeOriginal,
} from './intake.ts';
import { isIntakeSummary } from '../shared/intake-summary.ts';
import {
  prepareCollectionClinicalReview,
  prepareCollectionClinicalReviewAsync,
  prepareCollectionClinicalReviewDependencies,
} from './intake-review-collection-host.ts';
import {
  collectionClinicalProjectionContext,
  type CollectionClinicalReviewResult,
} from './intake-review-collection-session.ts';
import { openIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
import { retainedIntakeWorkflowCommand } from './intake-workflow-command.ts';
import { saveIntakeDraftRepairRead } from './intake-draft-repair-native.ts';
import { readIntakeEvidence } from './intake-evidence.ts';
import { currentReviewDraft } from './intake-review.ts';
import { datePrecision } from './clinical-import.ts';
import { workflowHash } from './intake-workflow.ts';
import type { HealthTool } from './proxy-model-bridge.ts';
import type {
  IntakeDraftRepairField,
  IntakeDraftRepairSelection,
  IntakeDraftRepairUpdate,
} from '../shared/intake.ts';

type UnknownRecord = Record<string, unknown>;
const object = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
const supportedFields = new Set<IntakeDraftRepairField>(['date', 'method', 'observationCategory']);

export interface IntakeDraftRepairScope {
  format: 'intake-draft-repair-scope-v2';
  intakeId: string;
  intakeVersion: number;
  groupId: string;
  originalSha256: string;
  rows: {
    proposalId: string | null;
    recordId: string;
    candidateVersionId: string;
    kind: string;
    title: string;
    allowedFields: IntakeDraftRepairField[];
    before: Partial<Record<IntakeDraftRepairField, string>>;
    evidence: {
      id: string;
      label: string;
      locator: string;
      contentUrl?: string;
      originalWindow:
        | {
            kind: 'pdf_page';
            page: number;
            maximumTextCharacters: 24000;
            maximumImageBytes: 16777216;
          }
        | {
            kind: 'image';
            maximumPixels: 80000000;
            maximumEdge: 1800;
            maximumImageBytes: 16777216;
          }
        | { kind: 'text'; offset: number; limit: number };
    }[];
  }[];
  scopeToken: string;
}

function selection(value: unknown): IntakeDraftRepairSelection {
  if (
    !object(value) ||
    value.format !== 'intake-draft-repair-selection-v1' ||
    Object.keys(value).some((key) => !['format', 'intakeId', 'groupId', 'rows'].includes(key))
  )
    throw new HttpError(400, 'DRAFT_REPAIR_SCOPE', 'Choose exact import drafts before asking');
  if (
    typeof value.intakeId !== 'string' ||
    typeof value.groupId !== 'string' ||
    !Array.isArray(value.rows) ||
    !value.rows.length ||
    value.rows.length > 8
  )
    throw new HttpError(400, 'DRAFT_REPAIR_SCOPE', 'Choose 1–8 drafts from one report');
  const rows = value.rows.map((row) => {
    if (
      !object(row) ||
      Object.keys(row).some(
        (key) => !['proposalId', 'recordId', 'candidateVersionId', 'fields'].includes(key),
      ) ||
      (row.proposalId !== null && typeof row.proposalId !== 'string') ||
      typeof row.recordId !== 'string' ||
      typeof row.candidateVersionId !== 'string' ||
      !Array.isArray(row.fields) ||
      !row.fields.length ||
      row.fields.some((field) => !supportedFields.has(field as IntakeDraftRepairField))
    )
      throw new HttpError(400, 'DRAFT_REPAIR_SCOPE', 'Choose supported fields on exact drafts');
    return {
      proposalId: row.proposalId as string | null,
      recordId: row.recordId,
      candidateVersionId: row.candidateVersionId,
      fields: [...new Set(row.fields as IntakeDraftRepairField[])],
    };
  });
  if (
    new Set(rows.map((row) => JSON.stringify([row.proposalId, row.recordId]))).size !== rows.length
  )
    throw new HttpError(400, 'DRAFT_REPAIR_SCOPE', 'Choose each draft once');
  return {
    format: 'intake-draft-repair-selection-v1',
    intakeId: value.intakeId,
    groupId: value.groupId,
    rows,
  };
}

function* intakeDraftRepairScopeSteps(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
): Generator<
  { intakeId: string; proposalId: string | null },
  IntakeDraftRepairScope,
  CollectionClinicalReviewResult
> {
  const chosen = selection(input);
  const intake = getIntakeRead(db, root, profileId, chosen.intakeId);
  const native = isIntakeSummary(intake);
  const view = native ? openIntakeCollectionEnvelope(db, { id: intake.id }) : undefined;
  const reviews = new Map<string, ReturnType<typeof reviewIntake>>();
  const originalWindow = (locator: string) => {
    if (intake.mimeType === 'application/pdf') {
      const page = Number(locator.match(/\bpage\s+(\d+)\b/i)?.[1]);
      if (!Number.isSafeInteger(page) || page < 1)
        throw new HttpError(
          409,
          'DRAFT_REPAIR_EVIDENCE',
          'The selected row has no exact original PDF page',
        );
      return {
        kind: 'pdf_page' as const,
        page,
        maximumTextCharacters: 24000 as const,
        maximumImageBytes: 16777216 as const,
      };
    }
    if (['image/png', 'image/jpeg', 'image/webp'].includes(intake.mimeType))
      return {
        kind: 'image' as const,
        maximumPixels: 80000000 as const,
        maximumEdge: 1800 as const,
        maximumImageBytes: 16777216 as const,
      };
    const range = locator.match(/\bcharacters?\s+(\d+)(?:\s*[–-]\s*(\d+))?/i);
    if (!range)
      throw new HttpError(
        409,
        'DRAFT_REPAIR_EVIDENCE',
        'The selected row has no bounded original text locator',
      );
    const start = Number(range[1]),
      end = range[2] ? Number(range[2]) : start;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end - start > 10000
    )
      throw new HttpError(
        413,
        'DRAFT_REPAIR_EVIDENCE',
        'The selected original text region exceeds the repair window',
      );
    const offset = Math.max(0, start - 1000);
    return { kind: 'text' as const, offset, limit: 12000 };
  };
  const sessions: Extract<
    ReturnType<typeof prepareCollectionClinicalReview>,
    { status: 'ready' }
  >['session'][] = [];
  try {
    const rows: IntakeDraftRepairScope['rows'] = [];
    for (const selected of chosen.rows) {
      const reviewKey = selected.proposalId || '';
      let review = reviews.get(reviewKey);
      if (!review) {
        if (native) {
          const prepared = yield { intakeId: chosen.intakeId, proposalId: selected.proposalId };
          if (prepared.status !== 'ready')
            throw new HttpError(
              409,
              'DRAFT_REPAIR_PREPARATION',
              'Prepare the selected draft review',
            );
          sessions.push(prepared.session);
          review = prepared.session.review;
        } else review = reviewIntake(db, root, profileId, chosen.intakeId, selected.proposalId);
        reviews.set(reviewKey, review);
      }
      const record = review.records.find((candidate) => candidate.id === selected.recordId);
      if (!record || record.candidateVersionId !== selected.candidateVersionId)
        throw new HttpError(409, 'DRAFT_REPAIR_STALE', 'A selected draft changed; choose it again');
      if (
        !selectedReportGroups(record.reportGroups).some((group) => group.groupId === chosen.groupId)
      )
        throw new HttpError(409, 'DRAFT_REPAIR_SCOPE', 'Selected drafts must share one report');
      if (record.reviewState === 'accepted' || record.reviewState === 'kept_original')
        throw new HttpError(409, 'DRAFT_REPAIR_STATE', 'Only pending drafts can be repaired');
      const allowedFields = selected.fields.filter(
        (field) =>
          (field === 'date' &&
            (record.mapping.kind === 'observation' || record.mapping.kind === 'procedure')) ||
          (record.mapping.kind === 'observation' &&
            (field === 'method' || field === 'observationCategory')),
      );
      if (allowedFields.length !== selected.fields.length)
        throw new HttpError(
          400,
          'DRAFT_REPAIR_FIELD',
          'A selected field does not fit this draft kind',
        );
      const prior = !isIntakeSummary(intake)
        ? currentReviewDraft(
            intake.workflow!,
            selected.proposalId,
            record.id,
            record.candidateVersionId!,
          )
        : undefined;
      const mapping = { ...record.mapping, ...prior?.mapping, ...prior?.decision?.mapping };
      if (view) {
        const draft = view.lookup('draft-record-version-last', [
          selected.proposalId || '',
          record.id,
          record.candidateVersionId!,
        ]);
        const decision = draft && view.child(draft, 'decision');
        for (const source of [
          draft && view.child(draft, 'mapping'),
          decision && view.child(decision, 'mapping'),
        ])
          if (source)
            for (const field of allowedFields) {
              const value = view.field(source, field, { bytes: 8192 });
              if (value.kind === 'missing') continue;
              if (value.kind !== 'value' || typeof value.value !== 'string')
                throw new HttpError(
                  409,
                  'DRAFT_REPAIR_PREPARATION',
                  'Prepare the selected draft field',
                );
              mapping[field] = value.value;
            }
      }
      const evidence = (record.evidence || []).slice(0, 20).map((item) => ({
        id: hash([selected.recordId, item.label, item.locator, item.contentUrl || null]),
        label: item.label,
        locator: item.locator,
        ...(item.contentUrl ? { contentUrl: item.contentUrl } : {}),
        originalWindow: originalWindow(item.locator),
      }));
      if (!evidence.length)
        throw new HttpError(
          409,
          'DRAFT_REPAIR_EVIDENCE',
          'The selected draft has no exact source locator',
        );
      rows.push({
        proposalId: selected.proposalId,
        recordId: selected.recordId,
        candidateVersionId: selected.candidateVersionId,
        kind: record.mapping.kind || record.kind,
        title: record.title,
        allowedFields,
        before: Object.fromEntries(
          allowedFields.map((field) => [field, String(mapping[field] ?? '')]),
        ) as Partial<Record<IntakeDraftRepairField, string>>,
        evidence,
      });
    }
    // A later selected proposal may yield after an earlier session was built.
    for (const session of sessions) collectionClinicalProjectionContext(session).assertCurrent();
    const basis = {
      format: 'intake-draft-repair-scope-v2' as const,
      intakeId: intake.id,
      intakeVersion: intake.version,
      groupId: chosen.groupId,
      originalSha256: intake.sha256,
      rows,
    };
    return { ...basis, scopeToken: hash([profileId, basis]) };
  } finally {
    for (const session of sessions) session.close();
  }
}

export function resolveIntakeDraftRepairScope(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
): IntakeDraftRepairScope {
  const steps = intakeDraftRepairScopeSteps(db, root, profileId, input);
  try {
    let step = steps.next();
    while (!step.done) {
      step = steps.next(
        prepareCollectionClinicalReview(
          db,
          root,
          profileId,
          step.value.intakeId,
          step.value.proposalId,
        ),
      );
    }
    return step.value;
  } finally {
    steps.return(undefined as never);
  }
}

async function resolveIntakeDraftRepairScopeAsync(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
  options: { assertRunning?: () => void } = {},
): Promise<IntakeDraftRepairScope> {
  const steps = intakeDraftRepairScopeSteps(db, root, profileId, input);
  let pending: CollectionClinicalReviewResult | undefined;
  try {
    options.assertRunning?.();
    let step = steps.next();
    while (!step.done) {
      pending = await prepareCollectionClinicalReviewAsync(
        db,
        root,
        profileId,
        step.value.intakeId,
        step.value.proposalId,
        options,
      );
      options.assertRunning?.();
      const prepared = pending;
      pending = undefined; // The generator owns ready sessions once resumed.
      step = steps.next(prepared);
    }
    options.assertRunning?.();
    return step.value;
  } finally {
    if (pending?.status === 'ready') pending.session.close();
    steps.return(undefined as never);
  }
}

export function resolveIntakeDraftRepairContext(
  db: Database,
  root: string,
  profileId: string,
  context: UnknownRecord,
) {
  if (context.intakeRepair === undefined) return context;
  const chosen = selection(context.intakeRepair);
  // Native dependency preparation runs before provider dispatch. This retains
  // only validated selected IDs while keeping chat creation synchronous.
  if (isIntakeSummary(getIntakeRead(db, root, profileId, chosen.intakeId)))
    return { ...context, intakeRepair: chosen };
  return {
    ...context,
    intakeRepair: resolveIntakeDraftRepairScope(db, root, profileId, context.intakeRepair),
  };
}

/** Cold selected review dependencies are prepared explicitly before dispatch.
 * Existing retained scopes remain bound to their original digest. */
export async function prepareIntakeDraftRepairScope(
  db: Database,
  root: string,
  profileId: string,
  value: unknown,
  options: { assertRunning?: () => void } = {},
): Promise<IntakeDraftRepairScope> {
  return runExclusiveClinicalOperation(
    db,
    async () => {
      const retained =
        object(value) && value.format === 'intake-draft-repair-scope-v2'
          ? retainedScope(profileId, value)
          : undefined;
      const chosen = retained
        ? {
            format: 'intake-draft-repair-selection-v1' as const,
            intakeId: retained.intakeId,
            groupId: retained.groupId,
            rows: retained.rows.map((row) => ({
              proposalId: row.proposalId,
              recordId: row.recordId,
              candidateVersionId: row.candidateVersionId,
              fields: row.allowedFields,
            })),
          }
        : selection(value);
      options.assertRunning?.();
      if (isIntakeSummary(getIntakeRead(db, root, profileId, chosen.intakeId)))
        for (const proposalId of new Set(chosen.rows.map((row) => row.proposalId))) {
          await prepareCollectionClinicalReviewDependencies(
            db,
            root,
            profileId,
            chosen.intakeId,
            proposalId,
            options,
          );
          options.assertRunning?.();
        }
      if (retained) {
        const original = verifyIntakeOriginal(db, root, profileId, retained.intakeId);
        if (original.sourceHash !== retained.originalSha256)
          throw new HttpError(
            409,
            'DRAFT_REPAIR_STALE',
            'The retained original changed; ask again',
          );
      }
      const refreshed = await resolveIntakeDraftRepairScopeAsync(
        db,
        root,
        profileId,
        chosen,
        options,
      );
      if (retained && refreshed.scopeToken !== retained.scopeToken)
        throw new HttpError(
          409,
          'DRAFT_REPAIR_STALE',
          'Selected drafts or evidence changed; ask again',
        );
      return refreshed;
    },
    { operation: currentClinicalOperation(db) },
  );
}

type RepairEdit = {
  recordId: string;
  candidateVersionId: string;
  field: IntakeDraftRepairField;
  after: string;
  evidenceIds: string[];
};

interface RepairEvidenceRead {
  format: 'intake-draft-repair-evidence-read-v1';
  receiptId: string;
  scopeToken: string;
  recordId: string;
  evidenceId: string;
  originalSha256: string;
  originalWindow: IntakeDraftRepairScope['rows'][number]['evidence'][number]['originalWindow'];
}

type RepairRunState = {
  intakeDraftRepairEvidenceReads?: Map<string, RepairEvidenceRead>;
};

const evidenceReadKey = (scopeToken: string, recordId: string, evidenceId: string) =>
  `${scopeToken}:${recordId}:${evidenceId}`;

function parseEdits(scope: IntakeDraftRepairScope, args: UnknownRecord): RepairEdit[] {
  if (args.scopeToken !== scope.scopeToken || !Array.isArray(args.edits) || args.edits.length > 100)
    throw new HttpError(409, 'DRAFT_REPAIR_SCOPE', 'Use the exact current selected-draft scope');
  const seen = new Set<string>();
  return args.edits.map((value) => {
    if (
      !object(value) ||
      Object.keys(value).some(
        (key) => !['recordId', 'candidateVersionId', 'field', 'after', 'evidenceIds'].includes(key),
      ) ||
      typeof value.recordId !== 'string' ||
      typeof value.candidateVersionId !== 'string' ||
      !supportedFields.has(value.field as IntakeDraftRepairField) ||
      typeof value.after !== 'string' ||
      !value.after.trim() ||
      value.after.length > 1000 ||
      !Array.isArray(value.evidenceIds) ||
      !value.evidenceIds.length ||
      value.evidenceIds.some((id) => typeof id !== 'string')
    )
      throw new HttpError(400, 'DRAFT_REPAIR_CHANGE', 'Return bounded supported field changes');
    const row = scope.rows.find(
      (candidate) =>
        candidate.recordId === value.recordId &&
        candidate.candidateVersionId === value.candidateVersionId,
    );
    const field = value.field as IntakeDraftRepairField;
    if (!row || !row.allowedFields.includes(field))
      throw new HttpError(
        403,
        'DRAFT_REPAIR_SCOPE',
        'A proposed row or field is outside selection',
      );
    const evidenceIds = [...new Set(value.evidenceIds as string[])];
    if (evidenceIds.some((id) => !row.evidence.some((evidence) => evidence.id === id)))
      throw new HttpError(403, 'DRAFT_REPAIR_EVIDENCE', 'Use evidence from the same selected row');
    if (field === 'date') datePrecision(value.after);
    const key = `${row.recordId}:${field}`;
    if (seen.has(key))
      throw new HttpError(400, 'DRAFT_REPAIR_CHANGE', 'Propose each selected field once');
    seen.add(key);
    return {
      recordId: row.recordId,
      candidateVersionId: row.candidateVersionId,
      field,
      after: value.after,
      evidenceIds,
    };
  });
}

function retainedScope(profileId: string, value: unknown): IntakeDraftRepairScope {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'format',
          'intakeId',
          'intakeVersion',
          'groupId',
          'originalSha256',
          'rows',
          'scopeToken',
        ].includes(key),
    ) ||
    value.format !== 'intake-draft-repair-scope-v2' ||
    typeof value.intakeId !== 'string' ||
    !Number.isInteger(value.intakeVersion) ||
    typeof value.groupId !== 'string' ||
    typeof value.originalSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.originalSha256) ||
    typeof value.scopeToken !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.scopeToken) ||
    !Array.isArray(value.rows) ||
    !value.rows.length ||
    value.rows.length > 8
  )
    throw new HttpError(409, 'DRAFT_REPAIR_RECEIPT', 'Saved draft repair scope is invalid');
  const scope = value as unknown as IntakeDraftRepairScope;
  for (const row of scope.rows) {
    if (
      !object(row) ||
      Object.keys(row).some(
        (key) =>
          ![
            'proposalId',
            'recordId',
            'candidateVersionId',
            'kind',
            'title',
            'allowedFields',
            'before',
            'evidence',
          ].includes(key),
      ) ||
      (row.proposalId !== null && typeof row.proposalId !== 'string') ||
      typeof row.recordId !== 'string' ||
      typeof row.candidateVersionId !== 'string' ||
      typeof row.kind !== 'string' ||
      typeof row.title !== 'string' ||
      !Array.isArray(row.allowedFields) ||
      !row.allowedFields.length ||
      row.allowedFields.some((field) => !supportedFields.has(field)) ||
      !object(row.before) ||
      Object.keys(row.before).some(
        (field) => !row.allowedFields.includes(field as IntakeDraftRepairField),
      ) ||
      row.allowedFields.some((field) => typeof row.before[field] !== 'string') ||
      !Array.isArray(row.evidence) ||
      !row.evidence.length ||
      row.evidence.length > 20 ||
      row.evidence.some(
        (item) =>
          !object(item) ||
          Object.keys(item).some(
            (key) => !['id', 'label', 'locator', 'contentUrl', 'originalWindow'].includes(key),
          ) ||
          typeof item.id !== 'string' ||
          typeof item.label !== 'string' ||
          typeof item.locator !== 'string' ||
          (item.contentUrl !== undefined && typeof item.contentUrl !== 'string') ||
          !validOriginalWindow(item.originalWindow),
      )
    )
      throw new HttpError(409, 'DRAFT_REPAIR_RECEIPT', 'Saved draft repair row is invalid');
  }
  const { scopeToken, ...basis } = scope;
  if (scopeToken !== hash([profileId, basis]))
    throw new HttpError(409, 'DRAFT_REPAIR_RECEIPT', 'Saved draft repair scope digest is invalid');
  return scope;
}

function validOriginalWindow(
  value: unknown,
): value is IntakeDraftRepairScope['rows'][number]['evidence'][number]['originalWindow'] {
  if (!object(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'pdf_page')
    return (
      Object.keys(value).every((key) =>
        ['kind', 'page', 'maximumTextCharacters', 'maximumImageBytes'].includes(key),
      ) &&
      Number.isSafeInteger(value.page) &&
      Number(value.page) >= 1 &&
      value.maximumTextCharacters === 24000 &&
      value.maximumImageBytes === 16777216
    );
  if (value.kind === 'image')
    return (
      Object.keys(value).every((key) =>
        ['kind', 'maximumPixels', 'maximumEdge', 'maximumImageBytes'].includes(key),
      ) &&
      value.maximumPixels === 80000000 &&
      value.maximumEdge === 1800 &&
      value.maximumImageBytes === 16777216
    );
  return (
    value.kind === 'text' &&
    Object.keys(value).every((key) => ['kind', 'offset', 'limit'].includes(key)) &&
    Number.isSafeInteger(value.offset) &&
    Number(value.offset) >= 0 &&
    value.limit === 12000
  );
}

function retainedEvidenceReads(
  scope: IntakeDraftRepairScope,
  value: unknown,
  edits: RepairEdit[],
): RepairEvidenceRead[] {
  if (!Array.isArray(value) || value.length > scope.rows.length * 20)
    throw new HttpError(409, 'DRAFT_REPAIR_RECEIPT', 'Saved source reads are invalid');
  const reads = value.map((item) => {
    if (
      !object(item) ||
      Object.keys(item).some(
        (key) =>
          ![
            'format',
            'receiptId',
            'scopeToken',
            'recordId',
            'evidenceId',
            'originalSha256',
            'originalWindow',
          ].includes(key),
      ) ||
      item.format !== 'intake-draft-repair-evidence-read-v1' ||
      typeof item.receiptId !== 'string' ||
      typeof item.recordId !== 'string' ||
      typeof item.evidenceId !== 'string' ||
      item.scopeToken !== scope.scopeToken ||
      item.originalSha256 !== scope.originalSha256 ||
      !validOriginalWindow(item.originalWindow)
    )
      throw new HttpError(409, 'DRAFT_REPAIR_RECEIPT', 'Saved source read is invalid');
    const row = scope.rows.find((candidate) => candidate.recordId === item.recordId),
      evidence = row?.evidence.find((candidate) => candidate.id === item.evidenceId);
    const basis = {
      format: item.format,
      scopeToken: item.scopeToken,
      recordId: item.recordId,
      evidenceId: item.evidenceId,
      originalSha256: item.originalSha256,
      originalWindow: item.originalWindow,
    };
    if (
      !row ||
      !evidence ||
      JSON.stringify(evidence.originalWindow) !== JSON.stringify(item.originalWindow) ||
      item.receiptId !== hash(basis)
    )
      throw new HttpError(409, 'DRAFT_REPAIR_RECEIPT', 'Saved source read binding is invalid');
    return item as unknown as RepairEvidenceRead;
  });
  const keys = new Set(
    reads.map((item) => evidenceReadKey(scope.scopeToken, item.recordId, item.evidenceId)),
  );
  if (keys.size !== reads.length)
    throw new HttpError(409, 'DRAFT_REPAIR_RECEIPT', 'Saved source reads contain duplicates');
  for (const edit of edits)
    for (const evidenceId of edit.evidenceIds)
      if (!keys.has(evidenceReadKey(scope.scopeToken, edit.recordId, evidenceId)))
        throw new HttpError(
          409,
          'DRAFT_REPAIR_RECEIPT',
          'Every saved correction must retain its original source read',
        );
  return reads;
}

function currentScope(
  db: Database,
  root: string,
  profileId: string,
  retained: IntakeDraftRepairScope,
) {
  const original = verifyIntakeOriginal(db, root, profileId, retained.intakeId);
  if (original.sourceHash !== retained.originalSha256)
    throw new HttpError(409, 'DRAFT_REPAIR_STALE', 'The retained original changed; ask again');
  const refreshed = resolveIntakeDraftRepairScope(db, root, profileId, {
    format: 'intake-draft-repair-selection-v1',
    intakeId: retained.intakeId,
    groupId: retained.groupId,
    rows: retained.rows.map((row) => ({
      proposalId: row.proposalId,
      recordId: row.recordId,
      candidateVersionId: row.candidateVersionId,
      fields: row.allowedFields,
    })),
  });
  if (refreshed.scopeToken !== retained.scopeToken)
    throw new HttpError(
      409,
      'DRAFT_REPAIR_STALE',
      'Selected drafts or evidence changed; ask again',
    );
  return refreshed;
}

function repairOperationRecorded(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  request: {
    operationId: string;
    groupId: string;
    corrections: IntakeDraftRepairUpdate['corrections'];
  },
): boolean {
  const intake = getIntakeRead(db, root, profileId, id);
  if (isIntakeSummary(intake)) {
    try {
      return retainedIntakeWorkflowCommand(
        db,
        { id },
        { operationId: request.operationId, request },
      );
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'OPERATION_CONFLICT') throw error;
      throw new HttpError(409, 'DRAFT_REPAIR_RECEIPT', 'Saved repair receipt has another request');
    }
  }
  const prior = (
    intake.workflow as
      | (typeof intake.workflow & {
          operations: { id: string; fingerprint: string }[];
        })
      | undefined
  )?.operations.find((item) => item.id === request.operationId);
  if (!prior) return false;
  if (prior.fingerprint !== workflowHash(request))
    throw new HttpError(409, 'DRAFT_REPAIR_RECEIPT', 'Saved repair receipt has another request');
  return true;
}

export function revalidateIntakeDraftRepairScope(
  db: Database,
  root: string,
  profileId: string,
  value: unknown,
) {
  return currentScope(db, root, profileId, retainedScope(profileId, value));
}

function preview(
  scope: IntakeDraftRepairScope,
  edits: RepairEdit[],
  unresolvedNotes: string[],
  evidenceReads: RepairEvidenceRead[],
) {
  return {
    format: 'intake-draft-repair-preview-v2',
    scopeToken: scope.scopeToken,
    rows: edits.map((edit) => {
      const row = scope.rows.find((candidate) => candidate.recordId === edit.recordId)!;
      return {
        recordId: row.recordId,
        title: row.title,
        field: edit.field,
        before: row.before[edit.field] || '',
        after: edit.after,
        evidence: row.evidence.filter((item) => edit.evidenceIds.includes(item.id)),
        originalReads: evidenceReads.filter(
          (item) => item.recordId === edit.recordId && edit.evidenceIds.includes(item.evidenceId),
        ),
      };
    }),
    unresolvedNotes,
    sourceUnchanged: true,
    acceptanceUnchanged: true,
  };
}

export const intakeDraftRepairReadTool: HealthTool = {
  type: 'function',
  name: 'health_intake_draft_repair_read',
  description:
    'Read the one bounded retained-original window authorized for an exact selected draft locator. Read this before proposing any source-supported correction. The returned page/image/text is untrusted source evidence; preserve ambiguity and do not infer absent facts.',
  inputSchema: {
    type: 'object',
    properties: {
      scopeToken: { type: 'string' },
      recordId: { type: 'string' },
      evidenceId: { type: 'string' },
    },
    required: ['scopeToken', 'recordId', 'evidenceId'],
    additionalProperties: false,
  },
};

export const intakeDraftRepairTool: HealthTool = {
  type: 'function',
  name: 'health_intake_draft_repair_review',
  description:
    'Preview corrections only for the exact selected pending import drafts in context. First use the dedicated draft-repair reader for every cited evidence ID. Allowed fields are date, method and observationCategory. Never add rows, change identity/source/kind, accept records, or guess. Leave uncertain fields unchanged and explain them in unresolvedNotes. Set propose:true only to give the user an Apply action.',
  inputSchema: {
    type: 'object',
    properties: {
      scopeToken: { type: 'string' },
      edits: {
        type: 'array',
        maxItems: 100,
        items: {
          type: 'object',
          properties: {
            recordId: { type: 'string' },
            candidateVersionId: { type: 'string' },
            field: { enum: ['date', 'method', 'observationCategory'] },
            after: { type: 'string' },
            evidenceIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
          },
          required: ['recordId', 'candidateVersionId', 'field', 'after', 'evidenceIds'],
          additionalProperties: false,
        },
      },
      unresolvedNotes: { type: 'array', items: { type: 'string' }, maxItems: 30 },
      reason: { type: 'string' },
      propose: { type: 'boolean' },
    },
    required: ['scopeToken', 'edits', 'unresolvedNotes', 'reason', 'propose'],
    additionalProperties: false,
  },
};

function applyRepair(
  proposal: UnknownRecord,
  context: UnknownRecord,
  nativeAsync: boolean,
): UnknownRecord | null | Promise<UnknownRecord> {
  if (proposal.kind !== 'intake_draft_repair') return null;
  const profileId = context.profileId as string;
  const db = context.db as Database;
  const root = context.root as string;
  if (!object(proposal.changes))
    throw new HttpError(409, 'DRAFT_REPAIR_RECEIPT', 'Saved draft repair is invalid');
  const retained = retainedScope(profileId, proposal.changes.scope);
  const chatScope = retainedScope(
    profileId,
    (context.chat as { context?: { intakeRepair?: unknown } } | undefined)?.context?.intakeRepair,
  );
  if (chatScope.scopeToken !== retained.scopeToken)
    throw new HttpError(
      409,
      'DRAFT_REPAIR_RECEIPT',
      'Saved repair does not match this conversation scope',
    );
  const edits = parseEdits(retained, {
    scopeToken: retained.scopeToken,
    edits: proposal.changes.edits,
  });
  retainedEvidenceReads(retained, proposal.changes.evidenceReads, edits);
  const corrections: IntakeDraftRepairUpdate['corrections'] = edits.map((edit) => {
    const row = retained.rows.find((candidate) => candidate.recordId === edit.recordId)!;
    return {
      proposalId: row.proposalId,
      recordId: row.recordId,
      candidateVersionId: row.candidateVersionId,
      field: edit.field,
      before: row.before[edit.field] || '',
      after: edit.after,
    };
  });
  const request = {
    operationId: proposal.id as string,
    groupId: retained.groupId,
    corrections,
  };
  const completed = () => ({
    applied: true,
    resultUrl: `#/import?group=${encodeURIComponent(retained.groupId)}&intake=${encodeURIComponent(retained.intakeId)}`,
    result: { changed: corrections.length, sourceUnchanged: true, acceptanceUnchanged: true },
  });
  if (repairOperationRecorded(db, root, profileId, retained.intakeId, request)) return completed();
  if (isIntakeSummary(getIntakeRead(db, root, profileId, retained.intakeId))) {
    if (!nativeAsync)
      throw new HttpError(
        409,
        'DRAFT_REPAIR_PREPARATION',
        'Apply this selected repair through asynchronous preparation',
      );
    return (async () => {
      const scope = await prepareIntakeDraftRepairScope(db, root, profileId, retained);
      await saveIntakeDraftRepairRead(db, root, profileId, scope.intakeId, {
        version: scope.intakeVersion,
        ...request,
      });
      return completed();
    })();
  }
  const scope = currentScope(db, root, profileId, retained);
  saveIntakeDraftRepair(db, root, profileId, scope.intakeId, {
    version: scope.intakeVersion,
    operationId: request.operationId,
    groupId: scope.groupId,
    corrections,
  });
  return {
    applied: true,
    resultUrl: `#/import?group=${encodeURIComponent(scope.groupId)}&intake=${encodeURIComponent(scope.intakeId)}`,
    result: { changed: corrections.length, sourceUnchanged: true, acceptanceUnchanged: true },
  };
}

export function intakeDraftRepairAssistantExtensions() {
  return {
    tools: [intakeDraftRepairReadTool, intakeDraftRepairTool],
    async call(name: string, args: UnknownRecord, context: UnknownRecord): Promise<UnknownRecord> {
      const profileId = context.profileId as string;
      const db = context.db as Database;
      const root = context.root as string;
      const chat = context.chat as {
        context?: { intakeRepair?: IntakeDraftRepairScope };
        proposals: UnknownRecord[];
      };
      const retained = chat.context?.intakeRepair;
      if (!retained) throw new HttpError(403, 'DRAFT_REPAIR_SCOPE', 'Select import drafts first');
      const scope = await prepareIntakeDraftRepairScope(db, root, profileId, retained, {
        assertRunning:
          typeof context.assertRunning === 'function'
            ? (context.assertRunning as () => void)
            : undefined,
      });
      const state = context.state as RepairRunState | undefined;
      if (name === intakeDraftRepairReadTool.name) {
        if (
          Object.keys(args).some(
            (key) => !['scopeToken', 'recordId', 'evidenceId'].includes(key),
          ) ||
          args.scopeToken !== scope.scopeToken ||
          typeof args.recordId !== 'string' ||
          typeof args.evidenceId !== 'string'
        )
          throw new HttpError(
            403,
            'DRAFT_REPAIR_SCOPE',
            'Read only an exact selected source window',
          );
        const row = scope.rows.find((candidate) => candidate.recordId === args.recordId),
          evidence = row?.evidence.find((candidate) => candidate.id === args.evidenceId);
        if (!row || !evidence)
          throw new HttpError(
            403,
            'DRAFT_REPAIR_SCOPE',
            'Read only an exact selected source window',
          );
        const assertRunning = context.assertRunning;
        if (typeof assertRunning !== 'function' || !state)
          throw new HttpError(409, 'DRAFT_REPAIR_RUN', 'Start a current repair response');
        const window = evidence.originalWindow;
        const result = await readIntakeEvidence({
          db,
          root,
          profileId,
          id: scope.intakeId,
          ...(window.kind === 'pdf_page' ? { page: window.page, offset: 0 } : {}),
          ...(window.kind === 'text' ? { offset: window.offset } : {}),
          modelContext: true,
          pagedContext: isIntakeSummary(getIntakeRead(db, root, profileId, scope.intakeId)),
          captureSourceText: false,
          pdf: context.pdf === true && window.kind === 'pdf_page',
          assertRunning: assertRunning as () => void,
        });
        await prepareIntakeDraftRepairScope(db, root, profileId, scope, {
          assertRunning: assertRunning as () => void,
        });
        const resultObject: UnknownRecord = object(result) ? result : {};
        const metadata: UnknownRecord = object(resultObject.metadata) ? resultObject.metadata : {};
        const original = object(resultObject.original)
          ? resultObject.original
          : object(metadata.original)
            ? metadata.original
            : null;
        if (!original)
          throw new HttpError(
            409,
            'DRAFT_REPAIR_EVIDENCE',
            'Original source window is unavailable',
          );
        const imageContent =
          typeof resultObject.imageContent === 'string' ? resultObject.imageContent : null;
        const pdfContent =
          window.kind === 'pdf_page' && typeof resultObject.pdfContent === 'string'
            ? resultObject.pdfContent
            : null;
        if (
          window.kind === 'text' &&
          (typeof original.text !== 'string' || original.text.length > window.limit)
        )
          throw new HttpError(
            413,
            'DRAFT_REPAIR_EVIDENCE',
            'Original text window exceeds its bound',
          );
        if (
          window.kind === 'pdf_page' &&
          (original.page !== window.page ||
            typeof original.text !== 'string' ||
            original.text.length > window.maximumTextCharacters)
        )
          throw new HttpError(
            409,
            'DRAFT_REPAIR_EVIDENCE',
            'Original PDF page does not match its bound',
          );
        if (
          window.kind !== 'text' &&
          (!(imageContent || pdfContent) ||
            Buffer.byteLength(imageContent || pdfContent!) > window.maximumImageBytes)
        )
          throw new HttpError(
            413,
            'DRAFT_REPAIR_EVIDENCE',
            'Original visual window exceeds its bound',
          );
        const basis = {
          format: 'intake-draft-repair-evidence-read-v1' as const,
          scopeToken: scope.scopeToken,
          recordId: row.recordId,
          evidenceId: evidence.id,
          originalSha256: scope.originalSha256,
          originalWindow: window,
        };
        const receipt: RepairEvidenceRead = { ...basis, receiptId: hash(basis) };
        const reads = (state!.intakeDraftRepairEvidenceReads ||= new Map());
        reads.set(evidenceReadKey(scope.scopeToken, row.recordId, evidence.id), receipt);
        const repairMetadata = {
          original,
          ...(typeof metadata.caution === 'string' ? { caution: metadata.caution } : {}),
          repairEvidence: receipt,
          instructions:
            'Use only this selected row and bounded retained-original window. If the requested fact is absent or ambiguous, leave it unresolved.',
        };
        return {
          ...(imageContent ? { imageContent } : {}),
          ...(pdfContent
            ? {
                pdfContent,
                // Re-enter the same authorized repair read so fallback preserves
                // scope revalidation, bounds and the exact evidence receipt.
                pdfFallback: async () => {
                  const fallback = await intakeDraftRepairAssistantExtensions().call(name, args, {
                    ...context,
                    pdf: false,
                  });
                  const caution =
                    'Native PDF input was unavailable; a raster preview of the same selected original page is supplied.';
                  return {
                    ...fallback,
                    caution,
                    metadata: { ...(object(fallback.metadata) ? fallback.metadata : {}), caution },
                  };
                },
              }
            : {}),
          ...repairMetadata,
          ...(imageContent || pdfContent ? { metadata: repairMetadata } : {}),
        };
      }
      if (name !== intakeDraftRepairTool.name)
        throw new HttpError(403, 'DRAFT_REPAIR_SCOPE', 'Unsupported repair tool');
      if (
        Object.keys(args).some(
          (key) => !['scopeToken', 'edits', 'unresolvedNotes', 'reason', 'propose'].includes(key),
        ) ||
        typeof args.reason !== 'string' ||
        args.reason.length > 4000 ||
        typeof args.propose !== 'boolean' ||
        !Array.isArray(args.unresolvedNotes) ||
        args.unresolvedNotes.length > 30 ||
        args.unresolvedNotes.some((note) => typeof note !== 'string' || note.length > 2000)
      )
        throw new HttpError(400, 'DRAFT_REPAIR_CHANGE', 'Return only bounded draft repair fields');
      const edits = parseEdits(scope, args);
      const evidenceReads = [...(state?.intakeDraftRepairEvidenceReads?.values() || [])].filter(
        (item) => item.scopeToken === scope.scopeToken,
      );
      const readKeys = new Set(
        evidenceReads.map((item) =>
          evidenceReadKey(scope.scopeToken, item.recordId, item.evidenceId),
        ),
      );
      if (
        edits.some((edit) =>
          edit.evidenceIds.some(
            (evidenceId) =>
              !readKeys.has(evidenceReadKey(scope.scopeToken, edit.recordId, evidenceId)),
          ),
        )
      )
        throw new HttpError(
          409,
          'DRAFT_REPAIR_EVIDENCE',
          'Read each cited retained-original source window before proposing a correction',
        );
      retainedEvidenceReads(scope, evidenceReads, edits);
      const unresolvedNotes = args.unresolvedNotes as string[];
      const result = preview(scope, edits, unresolvedNotes, evidenceReads);
      if (!args.propose) return { preview: result };
      if (!edits.length)
        throw new HttpError(
          400,
          'DRAFT_REPAIR_CHANGE',
          'No evidence-supported correction was proposed',
        );
      const proposal = {
        id: randomUUID(),
        kind: 'intake_draft_repair',
        title: 'Review selected import corrections',
        summary: String(args.reason || '').slice(0, 4000),
        status: 'pending',
        changes: { scope, edits, unresolvedNotes, evidenceReads },
        preview: result,
      };
      chat.proposals.push(proposal);
      return proposal;
    },
    apply(proposal: UnknownRecord, context: UnknownRecord): UnknownRecord | null {
      return applyRepair(proposal, context, false) as UnknownRecord | null;
    },
    async applyAsync(
      proposal: UnknownRecord,
      context: UnknownRecord,
    ): Promise<UnknownRecord | null> {
      return applyRepair(proposal, context, true);
    },
    reconcile(proposal: UnknownRecord, context: UnknownRecord) {
      if (proposal.kind !== 'intake_draft_repair') return null;
      const db = context.db as Database;
      const root = context.root as string;
      const profileId = context.profileId as string;
      if (!object(proposal.changes) || typeof proposal.id !== 'string')
        throw new HttpError(409, 'DRAFT_REPAIR_RECEIPT', 'Saved draft repair is invalid');
      const scope = retainedScope(profileId, proposal.changes.scope);
      const chatScope = retainedScope(
        profileId,
        (context.chat as { context?: { intakeRepair?: unknown } } | undefined)?.context
          ?.intakeRepair,
      );
      if (chatScope.scopeToken !== scope.scopeToken)
        throw new HttpError(
          409,
          'DRAFT_REPAIR_RECEIPT',
          'Saved repair does not match this conversation scope',
        );
      const edits = parseEdits(scope, {
        scopeToken: scope.scopeToken,
        edits: proposal.changes.edits,
      });
      retainedEvidenceReads(scope, proposal.changes.evidenceReads, edits);
      const corrections: IntakeDraftRepairUpdate['corrections'] = edits.map((edit) => {
        const row = scope.rows.find((candidate) => candidate.recordId === edit.recordId)!;
        return {
          proposalId: row.proposalId,
          recordId: row.recordId,
          candidateVersionId: row.candidateVersionId,
          field: edit.field,
          before: row.before[edit.field] || '',
          after: edit.after,
        };
      });
      if (
        !repairOperationRecorded(db, root, profileId, scope.intakeId, {
          operationId: proposal.id,
          groupId: scope.groupId,
          corrections,
        })
      )
        return null;
      return {
        resultUrl: `#/import?group=${encodeURIComponent(scope.groupId)}&intake=${encodeURIComponent(scope.intakeId)}`,
        result: { changed: edits.length, sourceUnchanged: true, acceptanceUnchanged: true },
      };
    },
  };
}
