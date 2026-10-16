import { canonicalLiteral, type IntakeEntry } from './intake-format.ts';
import { evidenceScopedSourceSuggestion } from './intake-review.ts';
import type {
  HealthRecordEnvelope,
  IntakeReportContextReference,
  IntakeReportReference,
  IntakeWorkflow,
} from '../shared/intake.ts';

type UnknownRecord = Record<string, unknown>;

export interface ResolvedReportContext {
  report: IntakeReportReference | null;
  context: IntakeReportContextReference;
}

const object = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string' || value.length > max || !value.trim()) return null;
  return value;
};
const payloadField = (value: HealthRecordEnvelope, field: string): unknown =>
  object(value.payload) ? value.payload[field] : undefined;
function contextIdClaim(value: HealthRecordEnvelope): { id: string | null; conflict: boolean } {
  const topLevel = text(value.contextId, 2000);
  const payload = text(payloadField(value, 'contextId'), 2000);
  return {
    id: topLevel || payload,
    conflict: !!(topLevel && payload && topLevel !== payload),
  };
}
function literalText(value: HealthRecordEnvelope): string | null {
  if (typeof value.payload === 'string') return text(value.payload, 4000);
  const candidates = ['literal', 'text', 'transcript']
    .map((field) => text(payloadField(value, field), 4000))
    .filter((candidate): candidate is string => !!candidate);
  const distinct = [...new Set(candidates)];
  return distinct.length === 1 ? distinct[0]! : null;
}

function payloadContains(payload: unknown, expected: string): boolean {
  const pending = [payload];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (pending.length && visited++ < 100_000) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (value.includes(expected)) return true;
      continue;
    }
    if (!value || typeof value !== 'object' || JSON.isRawJSON(value) || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) pending.push(...value);
    else pending.push(...Object.values(value));
  }
  return false;
}

function reportLiteralIsRetained(value: HealthRecordEnvelope): boolean {
  const report = value.report;
  return !!(
    report &&
    payloadContains(value.payload, report.anchor.text) &&
    (!report.subject || payloadContains(value.payload, report.subject.text))
  );
}

function issueSourceSuggestion(
  value: HealthRecordEnvelope,
  memberId: string | null,
): IntakeReportContextReference['sourceSuggestion'] | undefined {
  const clinical = object(value.clinical) ? value.clinical : {};
  const issues = [
    ...(Array.isArray(value.reviewIssues) ? value.reviewIssues : []),
    ...(Array.isArray(clinical.reviewIssues) ? clinical.reviewIssues : []),
  ];
  const suggestions = issues.flatMap((candidate) => {
    const suggestion = evidenceScopedSourceSuggestion(candidate, value, {
      packageEvidence: memberId !== null,
      reportScoped: true,
      memberId,
    });
    return suggestion ? [{ ...suggestion, locator: value.provenance.locator }] : [];
  });
  const distinct = new Map(suggestions.map((item) => [canonicalLiteral(item), item]));
  return distinct.size === 1 ? [...distinct.values()][0] : undefined;
}

function legacyBrandSuggestion(
  value: HealthRecordEnvelope,
): IntakeReportContextReference['sourceSuggestion'] | undefined {
  const label = text(payloadField(value, 'branding'), 200)?.trim();
  const literal = literalText(value);
  if (!label || !literal?.includes(label)) return undefined;
  const suggestion = evidenceScopedSourceSuggestion(
    { sourceSuggestion: label, textAnchor: label },
    value,
    { packageEvidence: false, reportScoped: true, memberId: null },
  );
  return suggestion ? { ...suggestion, locator: value.provenance.locator } : undefined;
}

function aliases(value: HealthRecordEnvelope): string[] {
  const claim = contextIdClaim(value);
  if (claim.conflict) return [];
  return [
    ...new Set([
      value.id,
      text(value.contextId, 2000),
      text(payloadField(value, 'contextId'), 2000),
    ]),
  ].filter((item): item is string => !!item);
}

export interface ReportContextPackageScope {
  packageEvidence: boolean;
  /** Complete selected inventory lookup, never membership in a presentation page. */
  hasMember(memberId: string): boolean;
}

export interface ReportContextLookup {
  /** All distinct context entries with this alias in the complete selected proposal. */
  contexts(alias: string): Iterable<IntakeEntry>;
}

/**
 * Resolve context links only inside the supplied proposal entries. The result is a
 * review/presentation claim and never mutates the retained envelope or clinical mapping.
 */
export function resolveReportContexts(
  file: { mime_type?: string },
  workflow: IntakeWorkflow,
  entries: IntakeEntry[],
): Map<number, ResolvedReportContext> {
  return resolveReportContextsInScope(
    {
      packageEvidence:
        file.mime_type === 'application/zip' ||
        workflow.plans.some((plan) => !!plan.index.members?.length),
      hasMember: (memberId) =>
        workflow.plans.some((plan) =>
          plan.index.members?.some((member) => member.memberId === memberId),
        ),
    },
    entries,
  );
}

/** Entries must cover the complete proposal context scope, not an arbitrary display page. */
export function resolveReportContextsInScope(
  packageInfo: ReportContextPackageScope,
  entries: IntakeEntry[],
): Map<number, ResolvedReportContext> {
  return resolveReportContextsWithLookup(packageInfo, entries, buildReportContextLookup(entries));
}

/** Complete bounded proposal-input scope; preserves exact alias and ambiguity rules. */
export function buildReportContextLookup(entries: readonly IntakeEntry[]): ReportContextLookup {
  const byAlias = new Map<string, IntakeEntry[]>();
  for (const entry of entries) {
    if (entry.value.kind !== 'context') continue;
    for (const alias of aliases(entry.value)) {
      const existing = byAlias.get(alias) || [];
      existing.push(entry);
      byAlias.set(alias, existing);
    }
  }
  return {
    contexts: (alias) => byAlias.get(alias) || [],
  };
}

/** A bounded presentation window with alias/conflict checks over its complete proposal. */
export function resolveReportContextsWithLookup(
  packageInfo: ReportContextPackageScope,
  entries: readonly IntakeEntry[],
  lookup: ReportContextLookup,
): Map<number, ResolvedReportContext> {
  const results = new Map<number, ResolvedReportContext>();
  for (const entry of entries) {
    if (entry.value.kind === 'context') continue;
    const claim = contextIdClaim(entry.value);
    const contextId = claim.id;
    if (!contextId) continue;
    // Two distinct matches suffice to prove ambiguity; retain no full alias scope.
    const matches: IntakeEntry[] = [];
    for (const context of lookup.contexts(contextId)) {
      if (matches[0] === context) continue;
      matches.push(context);
      if (matches.length === 2) break;
    }
    const unresolved = (detail: string, envelopeId = contextId): void => {
      results.set(entry.line, {
        report: null,
        context: { contextId, envelopeId, status: 'unresolved', detail },
      });
    };
    if (claim.conflict) {
      unresolved('The top-level and payload context IDs conflict. Review this record separately.');
      continue;
    }
    if (matches.length !== 1) {
      unresolved(
        matches.length
          ? 'This context ID is ambiguous in the proposal. Review these records separately.'
          : 'The linked report context is missing from this proposal. Review this record separately.',
      );
      continue;
    }
    const contextEntry = matches[0]!;
    const contextValue = contextEntry.value;
    if (contextValue.provenance.sourceSystem !== entry.value.provenance.sourceSystem) {
      unresolved(
        'The linked context and record claim different source systems. Review this record separately.',
        contextValue.id,
      );
      continue;
    }
    if (entry.value.report && contextValue.report) {
      const left = { ...entry.value.report, section: undefined };
      const right = { ...contextValue.report, section: undefined };
      if (canonicalLiteral(left) !== canonicalLiteral(right)) {
        unresolved(
          'The record has report evidence that conflicts with its linked context. Review this record in its explicit report.',
          contextValue.id,
        );
        continue;
      }
    }
    let report: IntakeReportReference | null = null;
    if (contextValue.report && reportLiteralIsRetained(contextValue))
      report = structuredClone(contextValue.report);
    else {
      const literal = literalText(contextValue);
      if (literal) {
        const branding = legacyBrandSuggestion(contextValue)?.value;
        report = {
          key: 'linked-context:' + contextId,
          title: branding || 'Shared report context',
          anchor: { locator: contextValue.provenance.locator, text: literal },
          subject: null,
        };
      }
    }
    if (!report) {
      unresolved(
        'The linked context lacks a bounded literal report anchor. Confirm the report boundary in the original and review these records separately.',
        contextValue.id,
      );
      continue;
    }
    const contextMember = report.memberId || null;
    const recordMember = entry.value.report?.memberId || null;
    if (
      packageInfo.packageEvidence &&
      (!contextMember ||
        !recordMember ||
        contextMember !== recordMember ||
        !packageInfo.hasMember(contextMember))
    ) {
      unresolved(
        'The linked context does not have the same host-verified package member as this record. Review it separately.',
        contextValue.id,
      );
      continue;
    }
    const sourceSuggestion =
      issueSourceSuggestion(contextValue, contextMember) || legacyBrandSuggestion(contextValue);
    results.set(entry.line, {
      report,
      context: {
        contextId,
        envelopeId: contextValue.id,
        status: 'linked',
        detail: report.subject
          ? 'Shared literal report context is linked. Patient identity still requires explicit review.'
          : 'Shared literal report context is linked. Review patient identity for each record unless an exact report identity scope becomes available.',
        ...(sourceSuggestion ? { sourceSuggestion } : {}),
      },
    });
  }
  return results;
}
