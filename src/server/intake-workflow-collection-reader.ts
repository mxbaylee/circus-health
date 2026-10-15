import type { IntakeClinicalMapping, IntakeIssueResolution } from '../shared/intake.ts';
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { accountedUnitKindInScope } from './intake-unit-accounting.ts';
import type {
  WorkflowCandidateHeader,
  WorkflowCountReader,
  WorkflowDecisionHeader,
  WorkflowDraftHeader,
  WorkflowQuestionHeader,
  WorkflowVersionHeader,
} from './intake-workflow-reader.ts';

/** A fragmented required clinical field is unavailable, never silently absent. */
export class WorkflowScopeUnavailable extends Error {
  constructor(kind: string, field: string) {
    super(`Intake workflow scope requires a bounded ${kind}.${field} field`);
    this.name = 'WorkflowScopeUnavailable';
  }
}

/** Checked map/sequence joins over one selected envelope; no materialized workflow fallback. */
export function collectionWorkflowCountReader(
  view: IntakeCollectionEnvelopeReader,
  sourceContext: {
    isSourceContextVersion(versionId: string): boolean;
    implicitUnits?: (
      plan: IntakeEnvelopeRecord,
      view: IntakeCollectionEnvelopeReader,
    ) => Iterable<{ planId: string; unitId: string; pending: boolean }>;
  },
): WorkflowCountReader & {
  candidateHeader(record: IntakeEnvelopeRecord): WorkflowCandidateHeader;
  versionHeader(record: IntakeEnvelopeRecord): WorkflowVersionHeader;
  questionHeader(record: IntakeEnvelopeRecord): WorkflowQuestionHeader;
} {
  const intake = view.child(view.root(), 'intake');
  if (!intake) throw Error('Selected intake envelope has no intake record');
  const workflow = view.child(intake, 'workflow');
  const candidates = new WeakMap<WorkflowCandidateHeader, IntakeEnvelopeRecord>();
  const value = (record: IntakeEnvelopeRecord, name: string): unknown => {
    const result = view.field(record, name, { bytes: 64 * 1024 });
    if (result.kind === 'fragmented') throw new WorkflowScopeUnavailable(record.kind, name);
    return result.kind === 'missing' ? undefined : result.value;
  };
  const text = (record: IntakeEnvelopeRecord, name: string): string => {
    const result = value(record, name);
    if (typeof result !== 'string') throw new WorkflowScopeUnavailable(record.kind, name);
    return result;
  };
  const nullableText = (record: IntakeEnvelopeRecord, name: string): string | null => {
    const result = value(record, name);
    if (result !== null && typeof result !== 'string')
      throw new WorkflowScopeUnavailable(record.kind, name);
    return result;
  };
  const optionalText = (record: IntakeEnvelopeRecord, name: string): string | undefined => {
    const result = value(record, name);
    if (result !== undefined && typeof result !== 'string')
      throw new WorkflowScopeUnavailable(record.kind, name);
    return result;
  };
  const choice = <T extends string>(
    record: IntakeEnvelopeRecord,
    name: string,
    choices: readonly T[],
  ): T => {
    const result = text(record, name);
    if (!choices.includes(result as T)) throw new WorkflowScopeUnavailable(record.kind, name);
    return result as T;
  };
  function* children(
    record: IntakeEnvelopeRecord | undefined,
    field: string,
  ): Generator<IntakeEnvelopeRecord> {
    if (!record) return;
    if (view.has(record, field) && !view.child(record, field))
      throw Error(`Intake workflow ${field} requires a selected structured collection`);
    let after: string | undefined;
    do {
      const page = view.children(record, field, { after, items: 64, bytes: 128 * 1024 });
      for (const item of page.records) yield item;
      if (page.complete) return;
      if (!page.after || page.after === after || !page.records.length)
        throw Error('Intake workflow page failed to advance');
      after = page.after;
    } while (true);
  }
  const candidate = (record: IntakeEnvelopeRecord): WorkflowCandidateHeader => {
    const header = {
      id: text(record, 'id'),
      envelopeId: text(record, 'envelopeId'),
      sourceSystem: nullableText(record, 'sourceSystem'),
      sourceRecordId: nullableText(record, 'sourceRecordId'),
    };
    candidates.set(header, record);
    return header;
  };
  const version = (record: IntakeEnvelopeRecord | undefined): WorkflowVersionHeader | undefined => {
    if (!record) return undefined;
    const sourceContext = value(record, 'sourceContext'),
      peopleOnly = value(record, 'peopleOnly');
    if (
      (sourceContext !== undefined && typeof sourceContext !== 'boolean') ||
      (peopleOnly !== undefined && typeof peopleOnly !== 'boolean')
    )
      throw new WorkflowScopeUnavailable(record.kind, 'sourceContext/peopleOnly');
    return {
      id: text(record, 'id'),
      createdAt: text(record, 'createdAt'),
      status: choice(record, 'status', ['pending', 'accepted', 'superseded', 'kept_original']),
      ...(sourceContext !== undefined ? { sourceContext } : {}),
      ...(peopleOnly !== undefined ? { peopleOnly } : {}),
    };
  };
  const mapping = (record: IntakeEnvelopeRecord | undefined): Partial<IntakeClinicalMapping> => {
    if (!record) return {};
    const kind = optionalText(record, 'kind');
    return kind === undefined ? {} : { kind: kind as IntakeClinicalMapping['kind'] };
  };
  const decision = (
    record: IntakeEnvelopeRecord | undefined,
  ): WorkflowDecisionHeader | undefined => {
    if (!record) return undefined;
    return {
      id: text(record, 'id'),
      candidateId: text(record, 'candidateId'),
      candidateVersionId: text(record, 'candidateVersionId'),
      action: choice(record, 'action', ['accept', 'keep_original_only']),
      mapping: mapping(view.child(record, 'mapping')),
    };
  };
  const draft = (record: IntakeEnvelopeRecord | undefined): WorkflowDraftHeader | undefined => {
    if (!record) return undefined;
    const reviewed = view.child(record, 'decision');
    return {
      id: text(record, 'id'),
      candidateId: text(record, 'candidateId'),
      candidateVersionId: text(record, 'candidateVersionId'),
      mapping: mapping(view.child(record, 'mapping')),
      disposition: choice(record, 'disposition', ['pending', 'review_later', 'keep_original_only']),
      ...(reviewed
        ? {
            decision: {
              mapping: mapping(view.child(reviewed, 'mapping')),
            },
          }
        : {}),
    };
  };
  const question = (item: IntakeEnvelopeRecord): WorkflowQuestionHeader => {
    return {
      id: text(item, 'id'),
      key: text(item, 'key'),
      candidateId: nullableText(item, 'candidateId'),
      candidateVersionId: nullableText(item, 'candidateVersionId'),
      prompt: text(item, 'prompt'),
      locator: text(item, 'locator'),
      field: nullableText(item, 'field'),
      status: choice(item, 'status', ['unanswered', 'answered', 'resolved']),
      createdAt: text(item, 'createdAt'),
      resolvedByDecisionId: optionalText(item, 'resolvedByDecisionId'),
    };
  };
  const reader: WorkflowCountReader = {
    *candidates() {
      for (const item of children(workflow, 'candidates')) yield candidate(item);
    },
    *versions(header) {
      const record = candidates.get(header);
      if (!record) throw Error('Foreign intake workflow candidate header');
      for (const item of children(record, 'versions')) yield version(item)!;
    },
    version(candidateId, versionId) {
      const record = workflow && view.find('candidate', workflow, candidateId);
      return version(record && view.find('version', record, versionId));
    },
    versionById: (id) => version(view.lookup('workflow-version-last', [id])),
    latestVersion: (id) => version(view.lookup('candidate-version-last', [id])),
    *questions() {
      for (const item of children(workflow, 'questions')) {
        yield question(item);
      }
    },
    decision: (id) => decision(workflow && view.find('decision', workflow, id)),
    latestDraft: (id) => draft(view.lookup('draft-version-last', [id])),
    latestAcceptance: (id) => decision(view.lookup('acceptance-version-last', [id])),
    latestResolution(candidateId, versionId, issueId) {
      const item = view.lookup('resolution-last', [
        JSON.stringify(candidateId),
        versionId,
        issueId,
      ]);
      if (!item) return undefined;
      if (text(item, 'issueId') !== issueId)
        throw Error('Intake resolution index conflicts with its target');
      return {
        issueId,
        outcome: text(item, 'outcome') as IntakeIssueResolution['outcome'],
        operationId: optionalText(item, 'operationId'),
      };
    },
    hasPersonAssignment(operationId, candidateId, versionId, issueId) {
      const key = [operationId, JSON.stringify(candidateId), versionId, issueId];
      const receipt = view.lookup('person-assignment-receipt', key);
      const target = view.lookup('person-assignment-target', key);
      if (!receipt && !target) return false;
      if (
        !receipt ||
        !target ||
        text(receipt, 'outcome') !== 'this_is_person' ||
        text(receipt, 'operationId') !== operationId ||
        !view.child(receipt, 'assignedPerson') ||
        nullableText(target, 'candidateId') !== candidateId ||
        text(target, 'candidateVersionId') !== versionId
      )
        throw Error('Intake person assignment index conflicts with its target');
      return view.child(target, 'issueIds') || value(target, 'issueIds')
        ? view.contains(target, 'issueIds', issueId)
        : text(target, 'issueId') === issueId;
    },
    isSourceContextVersion: sourceContext.isSourceContextVersion,
    *units() {
      for (const plan of children(workflow, 'plans')) {
        if (text(plan, 'status') === 'superseded') continue;
        if (
          ['health-intake-package-plan-v2', 'health-intake-direct-plan-v2'].includes(
            String(value(plan, 'format')),
          )
        ) {
          if (!sourceContext.implicitUnits)
            throw Error('Implicit package accounting requires its checked unit provider');
          const planId = text(plan, 'id'),
            total = value(plan, 'unitCount');
          if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0)
            throw Error('Invalid implicit package unit count');
          let count = 0;
          for (const unit of sourceContext.implicitUnits(plan, view)) {
            if (
              unit.planId !== planId ||
              typeof unit.unitId !== 'string' ||
              typeof unit.pending !== 'boolean' ||
              ++count > total
            )
              throw Error('Conflicting implicit package unit scope');
            yield unit;
          }
          if (count !== total) throw Error('Incomplete implicit package unit scope');
          continue;
        }
        const planId = text(plan, 'id');
        for (const unit of children(plan, 'units')) {
          const unitId = text(unit, 'id'),
            coverageRecord = view.child(unit, 'coverage');
          const coverage = coverageRecord && {
            unitId: text(coverageRecord, 'unitId'),
            kind: choice(coverageRecord, 'kind', [
              'inspected',
              'extracted',
              'context',
              'unreadable',
            ]),
            notes: text(coverageRecord, 'notes'),
          };
          const accounted = accountedUnitKindInScope({ id: unitId, coverage }, (wanted) => {
            const retained = view.lookup('unit-accounted-coverage', [
              view.address(plan),
              view.address(unit),
              wanted.kind,
              wanted.notes,
            ]);
            if (!retained) return false;
            if (
              text(retained, 'unitId') !== unitId ||
              text(retained, 'kind') !== wanted.kind ||
              text(retained, 'notes') !== wanted.notes
            )
              throw Error('Intake unit coverage index conflicts with its target');
            return true;
          });
          yield { planId, unitId, pending: !accounted };
        }
      }
    },
    hasPendingPackageFailure() {
      const failure = view.lookup('pending-package-failure', []);
      if (!failure) return false;
      if (text(failure, 'status') !== 'pending')
        throw Error('Intake failure index conflicts with its target');
      return true;
    },
  };
  return {
    ...reader,
    candidateHeader: candidate,
    versionHeader: (record) => version(record)!,
    questionHeader: question,
  };
}
