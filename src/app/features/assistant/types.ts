export type AssistantRunStatus = 'idle' | 'running' | 'failed' | 'cancelled';
export type AssistantAvailability = {
  available: boolean;
  backend?: string;
  message?: string;
  model?: string | null;
  readiness?: string;
  capabilities?: { tools: boolean | null; images: boolean | null; pdf?: boolean | null };
};
export type AssistantChatSummary = {
  id: string;
  title: string;
  updatedAt: string;
  status: AssistantRunStatus;
};
export type AssistantMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  status?: 'streaming' | 'complete' | 'interrupted';
  context?: AssistantContext;
  runId?: string;
};
export type AssistantUsage = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number | null;
  modelContextWindow: number | null;
  measuredAt: string;
  source: 'thread/tokenUsage/updated';
};
export type AssistantRun = {
  id: string;
  startedAt: string;
  endedAt?: string;
  status: AssistantRunStatus;
  model?: string;
  reasoningEffort?: string;
  progress?: { text: string; at: string };
  usage: AssistantUsage | null;
  error?: string;
};
export type AssistantReading = {
  status: 'running' | 'paused';
  reason: string | null;
  turns: number;
  readyRecords: number;
  remainingUnits: number;
  pendingReadWindows: number;
  coverage: 'reading_progress_only';
};
export interface ClinicalReviewEvidence {
  label?: string;
  acquiringSource?: string;
  locator: unknown;
  contentUrl?: string;
}
export interface ClinicalCorrectionPreview {
  reclassification?: boolean;
  supportedTargetKinds?: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  evidence: ClinicalReviewEvidence[];
}
export interface FutureClassificationPreview {
  scope: 'future_imports';
  matchingExistingCount: number;
  exceptionCount: number;
  count: number;
  complete: boolean;
  match: {
    providerId: string;
    providerName?: string;
    sourceSystem: string;
    kind: string;
    label: string;
  };
  set: Record<string, string>;
  examples: {
    id: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    individualException: boolean;
    problem: string | null;
  }[];
}
export interface DuplicateReviewPreview {
  left: {
    title: string;
    date: string | null;
    mapping: Record<string, unknown>;
    evidence: ClinicalReviewEvidence[];
  };
  right: {
    title: string;
    date: string | null;
    mapping: Record<string, unknown>;
    evidence: ClinicalReviewEvidence[];
  };
  outcome: string;
  reason: string;
}
export interface IntakeDraftRepairPreview {
  format: 'intake-draft-repair-preview-v2';
  scopeToken: string;
  rows: {
    recordId: string;
    title: string;
    field: 'date' | 'method' | 'observationCategory';
    before: string;
    after: string;
    evidence: ClinicalReviewEvidence[];
    originalReads: {
      format: 'intake-draft-repair-evidence-read-v1';
      receiptId: string;
      scopeToken: string;
      recordId: string;
      evidenceId: string;
      originalSha256: string;
      originalWindow: Record<string, unknown>;
    }[];
  }[];
  unresolvedNotes: string[];
  sourceUnchanged: true;
  acceptanceUnchanged: true;
}
export type AssistantProposal = {
  id: string;
  title: string;
  summary: string;
  status: 'pending' | 'applied' | 'failed';
  changes: unknown;
  error?: string;
  resultUrl?: string;
} & (
  | { kind: 'restore'; preview?: import('../../../shared/api').NoteRestorationPreview }
  | { kind: 'clinical_correction'; preview?: ClinicalCorrectionPreview }
  | { kind: 'duplicate_decision'; preview?: DuplicateReviewPreview }
  | { kind: 'intake_draft_repair'; preview?: IntakeDraftRepairPreview }
  | { kind: 'mapping'; preview?: unknown }
  | { kind: 'note' | 'classification' | 'attachment'; preview?: unknown }
);
export type AssistantChat = AssistantChatSummary & {
  messages: AssistantMessage[];
  error?: string;
  proposals?: AssistantProposal[];
  runs?: AssistantRun[];
  reading?: AssistantReading;
};
export type AssistantSelection = {
  collection:
    | 'people'
    | 'notes'
    | 'results'
    | 'test_types'
    | 'medications'
    | 'procedures'
    | 'sources'
    | 'records'
    | 'documents';
  id: string;
};
export type AssistantContext = {
  route: string;
  intakeId?: string;
  selection?: AssistantSelection;
  intakeRepair?: import('../../../shared/intake').IntakeDraftRepairSelection | unknown;
};
