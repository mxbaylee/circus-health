/** Bounded observations of one exact plan/unit occurrence. These are reader
 * observations, never proof of clinical acceptance or physical source reading. */
import type { Database } from './database.ts';
import type { SourceReaderCoverage } from '../shared/intake-source-text.ts';
import type { IntakeExtractionCoverage, IntakeExtractionUnit } from '../shared/intake.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { readDirectPlanScope } from './intake-direct-plan.ts';
import { readPackagePlanScope } from './intake-package-plan.ts';
import { readRetainedPlanScope } from './intake-retained-plan.ts';
import { decisionIndexGet, type IntakeDecisionIndex } from './intake-reading-state.ts';
import { hashIntakeJsonScalar } from './intake-json-scalar.ts';
import { proposalDependenciesCurrent } from './intake-proposal-dependencies.ts';
import { readIntakeSourcePin } from './intake-source-pin.ts';

const scalar = <T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  field: string,
): T | undefined => {
  const value = view.field(record, field, { bytes: 8192 });
  if (value.kind === 'missing') return undefined;
  if (value.kind !== 'value') throw Error('Selected reader metadata requires a bounded scalar');
  return value.value as T;
};
function literal<T>(view: IntakeCollectionEnvelopeReader, record: IntakeEnvelopeRecord): T {
  let text = '';
  for (const piece of view.recordChunks(record)) {
    text += piece;
    if (text.length > 8192) throw Error('Selected reader metadata exceeds its bound');
  }
  return JSON.parse(text) as T;
}
/** Stop after the requested UTF-16 prefix; retained lexical evidence was checked
 * by the selected envelope. No full historical note is decoded for this view. */
function prefix(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  field: string,
  limit: number,
) {
  if (!view.has(record, field)) return { text: '', truncated: false };
  const stop = {},
    value = { text: '', truncated: false };
  try {
    const result = hashIntakeJsonScalar(view.fieldChunks(record, field), [], (unit) => {
      if (value.text.length === limit) {
        value.truncated = true;
        throw stop;
      }
      value.text += unit;
    });
    if (result.kind !== 'string') throw Error('Selected reader text is not a string');
  } catch (error) {
    if (error !== stop) throw error;
  }
  return value;
}
export interface CollectionReaderUnitOverride {
  reader: IntakeCollectionEnvelopeReader;
  coverageRecord: IntakeEnvelopeRecord;
  batchId: string;
  proposalId: string;
}
export interface CollectionReaderUnitFacts {
  unitId: string;
  status: IntakeExtractionUnit['status'];
  coverageKind?: IntakeExtractionCoverage['kind'];
  hasNotes: boolean;
  lastAttemptId?: string;
  proposalId?: string;
}
export function collectionReaderProposalCurrent(
  db: Database,
  id: string,
  reader: IntakeCollectionEnvelopeReader,
  proposalId: string,
): boolean {
  const intake = reader.child(reader.root(), 'intake')!,
    proposal = reader.find('proposal', intake, proposalId);
  if (!proposal) return false;
  const measured = proposalDependenciesCurrent(db, proposalId);
  if (measured !== null) return measured;
  const pin = readIntakeSourcePin(db, id);
  return (
    (scalar(reader, proposal, 'sourceTextRevisionId') || null) ===
      (pin ? pin.revisionId : scalar(reader, intake, 'sourceTextRevisionId') || null) &&
    (scalar(reader, proposal, 'sourceTextDependencyToken') || null) ===
      (pin ? pin.dependencyToken : scalar(reader, intake, 'sourceTextDependencyToken') || null)
  );
}
export function openCollectionReaderPlan(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  planAddress: string,
) {
  const view = openIntakeCollectionEnvelope(db, { id }),
    plan = view.resolve(planAddress);
  if (plan.kind !== 'plan') throw Error('Reader scope is not a plan');
  const planId = scalar<string>(view, plan, 'id')!,
    format = scalar<string>(view, plan, 'format');
  const direct =
    format === 'health-intake-direct-plan-v2'
      ? readDirectPlanScope(db, profileId, id, { recordAddress: planAddress })
      : undefined;
  const packageScope =
    format === 'health-intake-package-plan-v2'
      ? readPackagePlanScope(db, root, profileId, id, { recordAddress: planAddress })
      : undefined;
  const retained =
    direct || packageScope
      ? undefined
      : readRetainedPlanScope(db, profileId, id, { recordAddress: planAddress });
  if (!direct && !packageScope && !retained) throw Error('Reader plan preparation required');
  const collections = selectedEnvelopeStore(db, { id }).collections;
  const unitCount =
    direct?.unitCount ?? packageScope?.plan.unitCount ?? view.childCount(plan, 'units');
  function select(ordinal: number, override?: CollectionReaderUnitOverride, notesLimit = 1200) {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= unitCount)
      throw Error('Reader unit ordinal is outside the selected plan');
    const record = retained ? view.childAt(plan, 'units', ordinal)! : undefined;
    const implicit = direct
      ? direct.unitAt(ordinal)
      : packageScope
        ? (() => {
            const member = packageScope.inventory.range({ offset: ordinal, limit: 1 }).next().value;
            return member && packageScope.unit(member.memberId);
          })()
        : undefined;
    const unitId = record ? scalar<string>(view, record, 'id')! : implicit?.id;
    if (!unitId) throw Error('Reader unit identity unavailable');
    const first = record && view.find('unit', plan, unitId),
      useDecision = !record || (!!first && view.address(first) === view.address(record));
    const index = (direct || packageScope || retained)!.decisionIndex('units');
    const raw = useDecision ? decisionIndexGet(collections, index, unitId) : undefined;
    if (raw !== undefined && typeof raw !== 'string') throw Error('Invalid reader unit decision');
    const decision =
      raw === undefined
        ? undefined
        : (JSON.parse(raw) as { batchId: string; coverageOrdinal: number });
    const attempts = record ? view.childCount(record, 'attempts') : 0;
    const last = attempts ? view.childAt(record!, 'attempts', attempts - 1) : undefined;
    const lastAttemptId =
      override?.batchId ?? decision?.batchId ?? (last ? literal<string>(view, last) : undefined);
    const batch = lastAttemptId ? view.find('batch', plan, lastAttemptId) : undefined;
    const coverage =
      override?.coverageRecord ??
      (decision && batch
        ? view.childAt(batch, 'coverage', decision.coverageOrdinal)
        : record
          ? view.child(record, 'coverage')
          : undefined);
    const reader = override?.reader ?? view;
    if (
      (decision || override) &&
      (!coverage || scalar<string>(reader, coverage, 'unitId') !== unitId)
    )
      throw Error('Reader unit decision disagrees with its selected receipt');
    const coverageKind = coverage
      ? scalar<IntakeExtractionCoverage['kind']>(reader, coverage, 'kind')
      : implicit?.coverage?.kind;
    const notes = coverage
      ? prefix(reader, coverage, 'notes', notesLimit)
      : {
          text: implicit?.coverage?.notes.slice(0, notesLimit) || '',
          truncated: (implicit?.coverage?.notes.length || 0) > notesLimit,
        };
    const status =
      override || decision
        ? coverageKind === 'extracted'
          ? 'completed'
          : 'partial'
        : record
          ? scalar<IntakeExtractionUnit['status']>(view, record, 'status')!
          : implicit!.status;
    const facts: CollectionReaderUnitFacts = {
      unitId,
      status,
      ...(coverageKind ? { coverageKind } : {}),
      hasNotes: !!notes.text || notes.truncated,
      ...(lastAttemptId ? { lastAttemptId } : {}),
      ...(override
        ? { proposalId: override.proposalId }
        : batch
          ? { proposalId: scalar<string>(view, batch, 'proposalId') }
          : {}),
    };
    return { record, implicit, facts, notes };
  }
  return {
    format: direct
      ? ('direct' as const)
      : packageScope
        ? ('package' as const)
        : ('retained' as const),
    planId,
    unitCount,
    status: scalar<string>(view, plan, 'status')!,
    sourceHash: scalar<string>(view, view.child(plan, 'pins')!, 'sourceHash')!,
    ordinalOf(unitId: string) {
      return (
        direct?.unitById(unitId)?.ordinal ??
        packageScope?.inventory.byUnit(unitId)?.ordinal ??
        retained?.unitById(unitId)?.ordinal
      );
    },
    *changedOrdinals() {
      const index: IntakeDecisionIndex = (direct || packageScope || retained)!.decisionIndex(
        'units',
      );
      let after: string | undefined;
      do {
        const options = { after, items: 32, bytes: 32768 };
        const page = index.reference
          ? collections.rangeReferenced(index.reference, options)
          : collections.range(collections.openView(), index.area, index.collection, options);
        for (const entry of page.items) {
          const ordinal =
            direct?.unitById(entry.key)?.ordinal ??
            packageScope?.inventory.byUnit(entry.key)?.ordinal ??
            retained?.unitById(entry.key)?.ordinal;
          if (ordinal === undefined) throw Error('Reader decision has no selected unit');
          yield ordinal;
        }
        if (page.complete) return;
        if (!page.after || page.after === after) throw Error('Reader decisions failed to advance');
        after = page.after;
      } while (true);
    },
    facts(ordinal: number, override?: CollectionReaderUnitOverride) {
      return select(ordinal, override, 1).facts;
    },
    attributionUnit(ordinal: number) {
      const { record, implicit, facts } = select(ordinal, undefined, 0);
      const retainedPages = record ? retained!.unitPagesAt(ordinal) : undefined;
      const length = retainedPages?.count ?? implicit?.pages?.length ?? 0;
      return {
        id: facts.unitId,
        status: facts.status,
        sourceFileId: record
          ? scalar<string>(view, record, 'sourceFileId')
          : implicit?.sourceFileId,
        memberId: record
          ? scalar<string>(view, record, 'memberId')
          : implicit && 'memberId' in implicit
            ? implicit.memberId
            : undefined,
        ...(facts.coverageKind ? { coverage: { kind: facts.coverageKind } } : {}),
        pages: {
          length,
          *[Symbol.iterator]() {
            for (let i = 0; i < length; i++)
              yield retainedPages ? retainedPages.pageAt(i)! : implicit!.pages![i];
          },
        },
      };
    },
    entry(
      ordinal: number,
      stale: boolean,
      override?: CollectionReaderUnitOverride,
    ): SourceReaderCoverage['entries'][number] {
      const { record, implicit, facts, notes } = select(ordinal, override);
      const retainedPages = record ? retained!.unitPagesAt(ordinal) : undefined;
      const pageCount = retainedPages?.count ?? implicit?.pages?.length ?? 0;
      const pages: number[] = [];
      for (let i = 0; i < Math.min(20, pageCount); i++)
        pages.push(record ? retainedPages!.pageAt(i)! : implicit!.pages![i]);
      return {
        planId,
        unitId: facts.unitId,
        status: facts.status,
        stale,
        kind: record ? scalar<string>(view, record, 'kind')! : implicit!.kind,
        locator: record
          ? prefix(view, record, 'locator', 240).text
          : implicit!.locator.slice(0, 240),
        ...(pageCount ? { pages, ...(pageCount > 20 ? { pagesTruncated: true } : {}) } : {}),
        ...(facts.coverageKind ? { coverageKind: facts.coverageKind } : {}),
        notes: notes.text,
        ...(notes.truncated ? { notesTruncated: true } : {}),
      };
    },
  };
}
