import type { HealthTool } from './proxy-model-bridge.ts';
import {
  previewRecordCorrection,
  correctClinicalRecord,
  type RecordCorrectionInput,
  type CorrectionEvidenceContext,
} from './record-corrections.ts';
import {
  previewDuplicateDecision,
  saveDuplicateDecision,
  syncDuplicateQuestions,
  type DuplicateDecision,
} from './duplicate-review.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpError, transaction, now, json, revision, type Database } from './database.ts';
import {
  previewMappingChange,
  applyMappingRows,
  saveMappingRule,
  activeMappingRules,
} from './clinical-import.ts';
import { exportCuration, durableWrite, personalDurabilityStatus } from './portable.ts';
import { profilePaths } from './profile-storage.ts';

type MappingRule = Parameters<typeof previewMappingChange>[2];
type DuplicatePreviewInput = Parameters<typeof previewDuplicateDecision>[1];
type DuplicatePreview = ReturnType<typeof previewDuplicateDecision>;
type ReviewKind = 'clinical_correction' | 'duplicate_decision';
type ExportCuration = (db: Database, root: string, profileId: string) => unknown;
export interface MappingApplyInput extends Record<string, unknown> {
  operationId?: string;
  providerId: string;
  rule: MappingRule;
  previewToken: string;
  version: number;
}
export type ClinicalDecisionInput = RecordCorrectionInput &
  Partial<DuplicatePreviewInput> & {
    operationId?: string;
    previewToken: string;
    version: number;
  };
interface StoredActionReceipt {
  requestFingerprint: string;
  appliedRevision: number;
  result: Record<string, unknown>;
}
interface MappingProposal extends Record<string, unknown> {
  id: string;
  kind: string;
  status: string;
  changes: Record<string, unknown>;
}
interface MappingCallContext {
  db: Database;
  chat: { proposals: MappingProposal[] };
}
interface MappingApplyContext {
  db: Database;
  root: string;
  profileId: string;
}

function owner(db: Database, profileId: string): void {
  if (
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !== profileId
  )
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'Mapping belongs to another profile');
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  return value && typeof value === 'object'
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
      )
    : value;
}
const fingerprint = (input: MappingApplyInput | Record<string, unknown>): string =>
  createHash('sha256')
    .update(JSON.stringify(stable({ providerId: input.providerId, rule: input.rule })))
    .digest('hex');

// Human-readable mirrors. Accepted curation remains the rebuild authority and
// contains the complete rule journal, including superseded decisions.
export function exportMappingRules(db: Database, root: string, profileId: string): void {
  owner(db, profileId);
  const rows = db
    .prepare("SELECT id,coverage_json FROM manual_batches WHERE title='Import mapping decision'")
    .all();
  if (!rows.length) return;
  const directory = resolve(profilePaths(root, profileId).root, 'mappings/import-rules');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const row of rows) {
    const rule = (json(row.coverage_json) as { mappingRule: Record<string, unknown> }).mappingRule;
    durableWrite(
      resolve(directory, (row.id as string).replace(':', '-') + '.json'),
      Buffer.from(
        JSON.stringify(
          { format: 'health-mapping-rule-v1', profileId, id: row.id, ...rule },
          null,
          2,
        ),
      ),
    );
  }
}

export function applyMappingChange(
  db: Database,
  root: string,
  profileId: string,
  input: MappingApplyInput,
  { exportFn = exportCuration }: { exportFn?: ExportCuration } = {},
) {
  owner(db, profileId);
  const operation = input.operationId || randomUUID(),
    receiptId = 'mapping-apply:' + operation;
  const requestFingerprint = fingerprint(input);
  const existing = db.prepare('SELECT coverage_json FROM manual_batches WHERE id=?').get(receiptId);
  let result!: object;
  if (existing) {
    const receipt = json(existing.coverage_json) as StoredActionReceipt;
    if (receipt.requestFingerprint !== requestFingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'This operation already belongs to a different mapping change',
      );
    result = receipt.result;
  } else {
    const preview = previewMappingChange(db, input.providerId, input.rule);
    if (preview.token !== input.previewToken || preview.version !== input.version)
      throw new HttpError(
        409,
        'MAPPING_REVIEW_CHANGED',
        'Records changed; review affected entries again',
      );
    transaction(db, () => {
      const ruleId = saveMappingRule(db, input.providerId, input.rule, operation);
      const changes = applyMappingRows(db, input.providerId, input.rule);
      result = {
        ruleId,
        changed: changes.length,
        changes,
        sourceUnchanged: true,
      };
      db.prepare(
        "INSERT INTO manual_batches(id,title,status,created_at,verified_at,notes,coverage_json) VALUES(?,'Applied mapping review','verified',?,?,?,?)",
      ).run(
        receiptId,
        now(),
        now(),
        'Explicitly accepted mapping change. Prior values and original evidence retained.',
        JSON.stringify({
          requestFingerprint,
          appliedRevision: revision(db) + 1,
          result,
        }),
      );
    });
  }
  // Retrying a committed operation also heals a failed portable publication.
  try {
    exportFn(db, root, profileId);
    exportMappingRules(db, root, profileId);
  } catch (error) {
    return {
      ...result,
      durability: {
        ...personalDurabilityStatus(db),
        pending: true,
        error: (error as Error).message,
      },
    };
  }
  return result;
}

const reviewedKinds = new Set(['clinical_correction', 'duplicate_decision']);
const reviewInput = (input: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => !['previewToken', 'version', 'operationId'].includes(key),
    ),
  );
const reviewFingerprint = (input: Record<string, unknown>): string =>
  createHash('sha256')
    .update(JSON.stringify(stable(reviewInput(input))))
    .digest('hex');
export function applyClinicalDecision(
  db: Database,
  root: string,
  profileId: string,
  kind: ReviewKind,
  input: ClinicalDecisionInput,
  {
    exportFn = exportCuration,
    supporting,
  }: {
    exportFn?: ExportCuration;
    supporting?: CorrectionEvidenceContext['supporting'];
  } = {},
) {
  owner(db, profileId);
  if (!reviewedKinds.has(kind))
    throw new HttpError(400, 'REVIEW_KIND', 'Unsupported reviewed operation');
  const operationId = input.operationId || randomUUID(),
    receiptId = kind + ':' + operationId;
  const existing = db.prepare('SELECT coverage_json FROM manual_batches WHERE id=?').get(receiptId);
  const requestFingerprint = reviewFingerprint(input);
  let result!: object;
  if (existing) {
    const receipt = json(existing.coverage_json) as StoredActionReceipt;
    if (receipt.requestFingerprint !== requestFingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'This operation belongs to a different reviewed decision',
      );
    result = receipt.result;
  } else {
    if (input.version !== revision(db))
      throw new HttpError(
        409,
        'CLINICAL_REVIEW_CHANGED',
        'Records or evidence changed; review the proposal again',
      );
    const preview =
      kind === 'clinical_correction'
        ? previewRecordCorrection(db, reviewInput(input) as RecordCorrectionInput, {
            root,
            profileId,
            supporting,
          })
        : previewDuplicateDecision(db, reviewInput(input) as unknown as DuplicatePreviewInput);
    if (preview.token !== input.previewToken || preview.version !== input.version)
      throw new HttpError(
        409,
        'CLINICAL_REVIEW_CHANGED',
        'Records or evidence changed; review the proposal again',
      );
    transaction(
      db,
      () => {
        result =
          kind === 'clinical_correction'
            ? correctClinicalRecord(db, input, operationId, { root, profileId, supporting })
            : saveDuplicateDecision(
                db,
                (preview as DuplicatePreview).left,
                (preview as DuplicatePreview).right,
                input as DuplicatePreviewInput,
                operationId,
              );
        if (kind === 'duplicate_decision')
          syncDuplicateQuestions(db, result as unknown as DuplicateDecision);
        db.prepare(
          "INSERT INTO manual_batches(id,title,status,created_at,verified_at,notes,coverage_json) VALUES(?,'Applied clinical review','verified',?,?,?,?)",
        ).run(
          receiptId,
          now(),
          now(),
          'Explicitly accepted clinical review; original evidence retained.',
          JSON.stringify({ requestFingerprint, appliedRevision: revision(db) + 1, result }),
        );
      },
      kind === 'clinical_correction'
        ? { actor: 'profile-user', origin: 'clinical-correction' }
        : {},
    );
  }
  try {
    exportFn(db, root, profileId);
  } catch (error) {
    return {
      ...result,
      durability: {
        ...personalDurabilityStatus(db),
        pending: true,
        error: (error as Error).message,
      },
    };
  }
  return result;
}
const clinicalReviewTools: HealthTool[] = [
  {
    type: 'function' as const,
    name: 'health_record_correction_review',
    description:
      'Read retained original evidence and preview a one-record correction to an accepted import. Supports observation, medication, procedure and document fields. For an already accepted lab misclassified as a procedure, set.kind=observation and provide the evidence-supported target fields including testLabel and valueText. Kind transitions support observations, procedures and documents. Only this record changes; use health_classification_rule_review separately for explicit future scope. Does not change source identity, source bytes or personal medication use. Set propose:true for explicit user Apply.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { enum: ['observation', 'medication', 'procedure', 'document'] },
        recordId: { type: 'string' },
        set: { type: 'object', additionalProperties: { type: 'string' } },
        reason: { type: 'string' },
        propose: { type: 'boolean' },
      },
      required: ['kind', 'recordId', 'set', 'reason', 'propose'],
      additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'health_duplicate_review',
    description:
      'Compare two same-kind accepted records side by side with original evidence. Propose same_event, changed_version, distinct or unresolved. Grouping preserves all assertions, conflicting values and links; dates/values alone never establish identity. User must Apply.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { enum: ['observation', 'medication', 'procedure', 'document'] },
        recordId: { type: 'string' },
        otherRecordId: { type: 'string' },
        outcome: { enum: ['same_event', 'changed_version', 'distinct', 'unresolved'] },
        reason: { type: 'string' },
        propose: { type: 'boolean' },
      },
      required: ['kind', 'recordId', 'otherRecordId', 'outcome', 'reason', 'propose'],
      additionalProperties: false,
    },
  },
];
export function mappingAssistantExtensions() {
  return {
    tools: [
      ...clinicalReviewTools,
      {
        type: 'function' as const,
        name: 'health_classification_rule_review',
        description:
          'Separately preview an explicitly reusable future-import classification rule for one acquiring provider, exact original source system, kind and label. Does not change existing records or accept imports. Individual exceptions take precedence. Reuses only target kind and labels/categories, never dates, results, doses or event identity. Missing target evidence stays an import question. Set propose:true only when the user requests this broader future scope.',
        inputSchema: {
          type: 'object',
          properties: {
            providerId: { type: 'string' },
            sourceSystem: { type: 'string' },
            kind: { enum: ['observation', 'procedure', 'document'] },
            label: { type: 'string' },
            set: {
              type: 'object',
              properties: {
                kind: { enum: ['observation', 'procedure', 'document'] },
                testLabel: { type: 'string' },
                observationCategory: { type: 'string' },
                procedureLabel: { type: 'string' },
                procedureCategory: { type: 'string' },
                documentTitle: { type: 'string' },
                documentCategory: { type: 'string' },
              },
              additionalProperties: false,
            },
            propose: { type: 'boolean' },
            reason: { type: 'string' },
          },
          required: ['providerId', 'sourceSystem', 'kind', 'label', 'set', 'propose', 'reason'],
          additionalProperties: false,
        },
      },
      {
        type: 'function' as const,
        name: 'health_mapping_review',
        description:
          'Preview exact-label classification or naming corrections for this source, with affected existing records. Does not change data. Read evidence first. To propose, set propose:true; user must Apply.',
        inputSchema: {
          type: 'object',
          properties: {
            providerId: { type: 'string' },
            kind: {
              enum: ['observation', 'medication', 'procedure', 'document'],
            },
            label: { type: 'string' },
            set: {
              type: 'object',
              properties: {
                testLabel: { type: 'string' },
                medicationName: { type: 'string' },
                procedureLabel: { type: 'string' },
                procedureCategory: {
                  enum: [
                    'surgery',
                    'clinical_procedure',
                    'imaging',
                    'laboratory',
                    'pathology',
                    'unspecified',
                  ],
                },
                documentTitle: { type: 'string' },
              },
              additionalProperties: false,
            },
            propose: { type: 'boolean' },
            reason: { type: 'string' },
          },
          required: ['providerId', 'kind', 'label', 'set', 'propose', 'reason'],
          additionalProperties: false,
        },
      },
    ] satisfies HealthTool[],
    async call(name: string, args: Record<string, unknown>, { db, chat }: MappingCallContext) {
      if (clinicalReviewTools.some((tool) => tool.name === name)) {
        const { propose, ...input } = args;
        const correction = name === 'health_record_correction_review';
        const preview = (correction ? previewRecordCorrection : previewDuplicateDecision)(
          db,
          input as RecordCorrectionInput & DuplicatePreviewInput,
        );
        if (!propose) return { preview };
        const proposal = {
          id: randomUUID(),
          kind: correction ? 'clinical_correction' : 'duplicate_decision',
          title: correction ? 'Review individual correction' : 'Review paired evidence',
          summary: args.reason,
          status: 'pending',
          changes: { ...input, previewToken: preview.token, version: preview.version },
          preview,
        };
        chat.proposals.push(proposal);
        return proposal;
      }
      if (name !== 'health_mapping_review' && name !== 'health_classification_rule_review')
        throw Error('Unsupported mapping action');
      const rule = {
        ...(name === 'health_classification_rule_review' ? { scope: 'future_imports' } : {}),
        match: {
          kind: args.kind,
          label: args.label,
          ...(name === 'health_classification_rule_review'
            ? { sourceSystem: args.sourceSystem }
            : {}),
        },
        set: args.set,
      };
      const preview = previewMappingChange(db, args.providerId as string, rule as MappingRule);
      if (!args.propose)
        return {
          preview,
          currentRules: activeMappingRules(db, args.providerId as string),
        };
      const proposal = {
        id: randomUUID(),
        kind: 'mapping',
        title:
          name === 'health_classification_rule_review'
            ? 'Review future classification rule'
            : 'Review source mapping',
        summary: args.reason,
        status: 'pending',
        changes: {
          providerId: args.providerId,
          rule,
          previewToken: preview.token,
          version: preview.version,
        },
        preview,
      };
      chat.proposals.push(proposal);
      return proposal;
    },
    apply(proposal: MappingProposal, { db, root, profileId }: MappingApplyContext) {
      if (reviewedKinds.has(proposal.kind))
        return {
          applied: true,
          resultUrl: '#/sources',
          result: applyClinicalDecision(
            db,
            root,
            profileId,
            proposal.kind as ReviewKind,
            {
              ...proposal.changes,
              operationId: proposal.id,
            } as ClinicalDecisionInput,
          ),
        };
      if (proposal.kind !== 'mapping') throw Error('Unsupported mapping proposal');
      const result = applyMappingChange(db, root, profileId, {
        ...proposal.changes,
        operationId: proposal.id,
      } as MappingApplyInput);
      return { applied: true, resultUrl: '#/sources', result };
    },
    reconcile(proposal: MappingProposal, { db, root, profileId }: MappingApplyContext) {
      if (reviewedKinds.has(proposal.kind)) {
        if (
          !db
            .prepare('SELECT 1 FROM manual_batches WHERE id=?')
            .get(proposal.kind + ':' + proposal.id)
        )
          return null;
        return {
          resultUrl: '#/sources',
          result: applyClinicalDecision(
            db,
            root,
            profileId,
            proposal.kind as ReviewKind,
            {
              ...proposal.changes,
              operationId: proposal.id,
            } as ClinicalDecisionInput,
          ),
        };
      }
      if (proposal.kind !== 'mapping') return null;
      const row = db
        .prepare('SELECT coverage_json FROM manual_batches WHERE id=?')
        .get('mapping-apply:' + proposal.id);
      if (!row) return null;
      const receipt = json(row.coverage_json) as StoredActionReceipt;
      if (receipt.requestFingerprint !== fingerprint(proposal.changes))
        throw new HttpError(
          409,
          'OPERATION_CONFLICT',
          'Saved mapping receipt belongs to another change',
        );
      const persisted = Number(
        db.prepare("SELECT value FROM app_meta WHERE key='curation_revision'").get()?.value || 0,
      );
      const result =
        proposal.status === 'applied' && persisted >= receipt.appliedRevision
          ? receipt.result
          : applyMappingChange(db, root, profileId, {
              ...proposal.changes,
              operationId: proposal.id,
            } as MappingApplyInput);
      return { resultUrl: '#/sources', result };
    },
  };
}
