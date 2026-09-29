/** Located source evidence is distinct from clinical proposals and accepted records. */
export interface SourceTextRegion {
  /** One-based page or logical section. */
  page: number;
  /** Normalized canonical display coordinates after intrinsic document rotation, before UI rotation: [x,y,width,height]. */
  box?: [number, number, number, number];
}
export interface SourceTextSpan {
  id: string;
  text: string;
  region: SourceTextRegion;
  provenance: 'native' | 'ocr' | 'structured' | 'human';
  confidence?: number;
  alternatives?: { text: string; adapter: string }[];
}
export interface SourceTextRelation {
  id: string;
  kind: 'precedes' | 'same-row' | 'same-column' | 'header-for';
  from: string;
  to: string;
  provenance: 'adapter' | 'human';
}
export interface SourceTextIssue {
  id: string;
  region: SourceTextRegion;
  kind: 'confidence' | 'coverage' | 'disagreement' | 'structure' | 'unreadable' | 'unsupported';
  detail: string;
  status: 'open' | 'confirmed' | 'corrected' | 'not-text' | 'unreadable' | 'later';
}
export interface SourceTextPage {
  page: number;
  width?: number;
  height?: number;
  disposition: 'extracted' | 'partial' | 'unreadable' | 'unsupported' | 'not-text';
  /** No automatic extractor may set inspected=true. */
  inspected: boolean;
}
export interface SourceTextEvidence {
  adapter: { name: string; version: string };
  pages: SourceTextPage[];
  spans: SourceTextSpan[];
  relations: SourceTextRelation[];
  issues: SourceTextIssue[];
}
export type SourceTextReviewAction =
  'confirm' | 'correct' | 'not-text' | 'unreadable' | 'later' | 'clarification';
export interface SourceTextReviewRequest {
  operationId: string;
  expectedRevisionId: string;
  sourceHash: string;
  action: SourceTextReviewAction;
  /** Entire page remains editable regardless of detector highlights. */
  scope: SourceTextRegion;
  reason?: string;
  /** Replacement spans in this inspected scope. Outside spans are preserved. */
  spans?: SourceTextSpan[];
  /** Explicit complete relation set, including cross-page relationships. */
  relations?: SourceTextRelation[];
  /** External knowledge only; never silently copied into source transcript. */
  clarification?: string;
  /** Explicit issue resolutions accompanying confirmation; never inferred from saving an edit. */
  resolveIssueIds?: string[];
}
export interface SourceTextReviewEvent {
  operationId: string;
  expectedRevisionId: string;
  action: SourceTextReviewAction;
  scope: SourceTextRegion;
  actor: string;
  at: string;
  reason?: string;
  clarification?: string;
  resolvedIssueIds?: string[];
}
export interface SourceTextRevision extends SourceTextEvidence {
  format: 'intake-source-text-v1';
  id: string;
  parentRevisionId: string | null;
  profileId: string;
  intakeId: string;
  sourceHash: string;
  createdAt: string;
  review: SourceTextReviewEvent | null;
  /** Extraction may continue only on other pages; these pages preserve human work. */
  protectedPages: number[];
  /** A new profile's documentary copy; the original profile history is untouched. */
  copiedFrom?: { profileId: string; revisionId: string };
}
export interface SourceTextSummary {
  pages: number;
  spans: number;
  unresolved: number;
  exceptions: number;
  inspectedPages: number;
  /** Inspection status is not a guarantee of source accuracy. */
  status: 'needs-review' | 'reviewed-with-exceptions' | 'reviewed';
}
export interface SourceExtractionOperationStatus {
  operationId: string;
  status: 'completed' | 'interrupted';
  revisionId: string | null;
  requiresNewOperation: boolean;
  reasonCode: string | null;
}
export type IntakeSourceText = (
  | { status: 'unavailable'; revision: null; summary: null }
  | { status: 'available'; revision: SourceTextRevision; summary: SourceTextSummary }
) & { extractionOperation?: SourceExtractionOperationStatus };

/** Host-produced dependency state for the next clinical proposal or batch.
 * A ready pin proves a current passage was read, not clinical completeness. */
export type ProposalSourceTextHandoff = (
  | {
      status: 'unavailable';
      currentRevisionId: null;
      readRequired: false;
      sourceTextRevisionId: null;
    }
  | {
      status: 'read_required';
      currentRevisionId: string;
      readRequired: true;
      sourceTextRevisionId: null;
    }
  | {
      status: 'ready';
      currentRevisionId: string;
      readRequired: false;
      /** Exactly currentRevisionId, produced by the host after a passage read. */
      sourceTextRevisionId: string;
    }
) & { instruction: string };
export interface SourceTextPassage {
  revisionId: string;
  sourceHash: string;
  spans: SourceTextSpan[];
  issues: (SourceTextIssue & { detailTruncated?: boolean; detailCharacters?: number })[];
  relations: SourceTextRelation[];
  issuesTruncated: boolean;
  relationsTruncated: boolean;
  alternativeCounts: Record<string, number>;
  nextIssueOffset: number | null;
  nextRelationOffset: number | null;
  /** UTF-16 offsets into the retained literal span, explicitly marking every returned fragment. */
  spanFragments: { spanId: string; start: number; end: number; total: number }[];
  /** A bounded passage may omit later spans, never claim complete retrieval. */
  nextOffset: number | null;
  nextCharacter: number;
  /** Human clarification remains an attributed event, never extracted wording. */
  reviewHistory: {
    revisionId: string;
    parentRevisionId: string | null;
    event: SourceTextReviewEvent | null;
    truncatedFields?: ('reason' | 'clarification')[];
  }[];
  nextHistoryRevisionId: string | null;
}
export interface SourceTextAnnotationPassage {
  revisionId: string;
  sourceHash: string;
  kind: 'alternative' | 'issue' | 'review';
  id: string;
  index?: number;
  field?: 'reason' | 'clarification';
  text: string;
  offset: number;
  totalCharacters: number;
  nextOffset: number | null;
}

/** Bounded source-review projection; counters never assert transcription completeness. */
export interface SourceTextIssueSummary {
  /** Distinct source pages with unresolved issues, not the number of OCR flags. */
  attentionSections?: number;
  pages: number;
  specificIssues: number;
  coverageIssues: number;
  exceptions: number;
  inspectedPages: number;
  totalIssues: number;
}

export interface SourceAttentionQueue {
  sections: number;
  total: number;
  items: { intakeId: string; sections: number }[];
  offset: number;
  nextOffset: number | null;
}
export interface SourceReaderCoverage {
  intakeVersion: number;
  summary: {
    units: number;
    pending: number;
    partial: number;
    unreadable: number;
    context: number;
    stale?: number;
  };
  entries: {
    stale?: boolean;
    planId: string;
    unitId: string;
    status: 'pending' | 'partial' | 'completed';
    kind: string;
    locator: string;
    pages?: number[];
    pagesTruncated?: boolean;
    coverageKind?: 'inspected' | 'extracted' | 'context' | 'unreadable';
    notes: string;
    notesTruncated?: boolean;
  }[];
  offset: number;
  nextOffset: number | null;
}
export interface SourceTextIssueList {
  readerCoverage?: SourceReaderCoverage;
  status: 'available' | 'unavailable';
  extractionFailure?: { scope: 'file'; reasonCode: string };
  revisionId: string | null;
  sourceHash: string;
  adapter: SourceTextEvidence['adapter'] | null;
  summary: SourceTextIssueSummary | null;
  issues: (SourceTextIssue & {
    category: 'detected' | 'not-inspected' | 'processing-failure';
    precision: 'region' | 'page';
    detailTruncated?: boolean;
  })[];
  offset: number;
  nextOffset: number | null;
}
