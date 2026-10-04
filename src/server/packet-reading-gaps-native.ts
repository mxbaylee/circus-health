import type { Database } from './database.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { intakeReviewChildren } from './intake-review-collection.ts';
import { hashIntakeJsonScalar } from './intake-json-scalar.ts';
import { readDirectPlanScope } from './intake-direct-plan.ts';
import { readPackagePlanScope } from './intake-package-plan.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { workflowHash } from './intake-workflow.ts';
import { selectedReadingStateIndex, decisionIndexGet } from './intake-reading-state.ts';
import { PacketOutputBudget } from './packet-output-budget.ts';
import { packetReadingIndexReferences } from './packet-reading-index-references.ts';

export interface PacketReadingGap {
  locator: string;
  reason: string;
}
function field<T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): T | undefined {
  const value = view.field(record, name, { bytes: 256 * 1024 });
  if (value.kind === 'fragmented')
    throw Error('Packet reading disclosure field requires fragment access');
  return value.kind === 'value' ? (value.value as T) : undefined;
}

/** Complete selected reading scope. Retained receipts are joined on disk, never
 * hydrated as a plan/workflow; recipe scopes retain their exact occurrence IDs. */
export function* iterateNativePacketReadingGaps(
  db: Database,
  id: string,
): Generator<PacketReadingGap> {
  const view = openIntakeCollectionEnvelope(db, { id }),
    intake = view.child(view.root(), 'intake'),
    flow = intake && view.child(intake, 'workflow');
  let plan: IntakeEnvelopeRecord | undefined;
  for (const record of intakeReviewChildren(view, flow, 'plans'))
    if (field(view, record, 'status') === 'active') {
      plan = record;
      break;
    }
  if (!plan) {
    yield { locator: 'Retained original', reason: 'reading has not established page coverage' };
    return;
  }
  const profileId = String(
      db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value || '',
    ),
    format = field(view, plan, 'format');
  let units = 0;
  const add = (
    unit: { id: string; locator?: string; processingException?: { reason: string } },
    kind: unknown,
  ) => {
    units++;
    if (unit.processingException || !kind || kind === 'unreadable')
      return {
        locator: unit.locator || unit.id,
        reason:
          unit.processingException?.reason ||
          (kind === 'unreadable' ? 'unreadable' : 'not yet read'),
      };
    return undefined;
  };
  if (format === 'health-intake-direct-plan-v2') {
    const scope = readDirectPlanScope(db, profileId, id, { recordAddress: view.address(plan) });
    if (!scope) throw Error('Selected direct reading scope is unavailable');
    for (let ordinal = 0; ordinal < scope.unitCount; ordinal++) {
      const unit = scope.unitAt(ordinal);
      if (!unit) throw Error('Selected direct reading unit is unavailable');
      const gap = add(unit, scope.accountedKind(unit.id));
      if (gap) yield gap;
    }
    yield* packetReadingIndexReferences(scope.sourceIndexChunks());
  } else if (format === 'health-intake-package-plan-v2') {
    const scope = readPackagePlanScope(db, '', profileId, id, {
      recordAddress: view.address(plan),
    });
    if (!scope) throw Error('Selected package reading scope is unavailable');
    for (let ordinal = 0; ordinal < scope.plan.unitCount; ordinal++) {
      const member = scope.inventory.member(ordinal),
        unit = member && scope.unit(member.memberId);
      if (!unit) throw Error('Selected package reading unit is unavailable');
      const gap = add(unit, scope.accountedKind(unit.id));
      if (gap) yield gap;
    }
  } else {
    const scratch = disposableSqlite('circus-packet-reading-'),
      collections = selectedEnvelopeStore(db, { id }).collections;
    const planId = field<string>(view, plan, 'id')!,
      first = view.find('plan', flow!, planId),
      selectionId =
        first && view.address(first) === view.address(plan)
          ? planId
          : planId + ':' + view.address(plan),
      collection = (kind: string) => 'package.' + kind + '.' + workflowHash(selectionId);
    const notes = (record: IntakeEnvelopeRecord) =>
      hashIntakeJsonScalar(view.fieldChunks(record, 'notes')).hash;
    try {
      scratch.db.exec(
        'CREATE TABLE receipts(unit TEXT,kind TEXT,notes TEXT,batch TEXT,PRIMARY KEY(unit,kind,notes,batch))',
      );
      const insert = scratch.db.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?,?,?)');
      for (const batch of intakeReviewChildren(view, plan, 'batches'))
        for (const coverage of intakeReviewChildren(view, batch, 'coverage'))
          insert.run(
            field<string>(view, coverage, 'unitId')!,
            field<string>(view, coverage, 'kind')!,
            notes(coverage),
            field<string>(view, batch, 'id')!,
          );
      const exceptionIndex = selectedReadingStateIndex(
        collections,
        view.address(plan),
        'exceptions',
      );
      for (const unit of intakeReviewChildren(view, plan, 'units')) {
        const unitId = field<string>(view, unit, 'id')!,
          raw = collections.get(collections.openView(), 'logical', collection('units'), unitId);
        let coverage = view.child(unit, 'coverage'),
          proven = false;
        if (raw !== undefined) {
          if (typeof raw !== 'string') throw Error('Invalid selected reading receipt');
          const selected = JSON.parse(raw) as {
              batchId: string;
              coverageOrdinal: number;
              attemptCount: number;
            },
            batch = view.find('batch', plan, selected.batchId);
          coverage = batch && view.childAt(batch, 'coverage', selected.coverageOrdinal);
          if (
            !coverage ||
            field(view, coverage, 'unitId') !== unitId ||
            !Number.isSafeInteger(selected.attemptCount) ||
            selected.attemptCount < 1 ||
            collections.get(
              collections.openView(),
              'logical',
              collection('attempts'),
              workflowHash([unitId, selected.batchId]),
            ) !== '1'
          )
            throw Error('Selected reading receipt is unavailable');
          proven = true;
        } else if (coverage && field(view, coverage, 'unitId') === unitId) {
          for (const receipt of scratch.db
            .prepare('SELECT batch FROM receipts WHERE unit=? AND kind=? AND notes=?')
            .iterate(unitId, field<string>(view, coverage, 'kind')!, notes(coverage)))
            if (view.contains(unit, 'attempts', String(receipt.batch))) {
              proven = true;
              break;
            }
        }
        const kind = proven && coverage ? field<string>(view, coverage, 'kind') : undefined;
        const exception = view.child(unit, 'processingException');
        let reason = exception
          ? field<string>(view, exception, 'reason')
          : field<{ reason: string }>(view, unit, 'processingException')?.reason;
        if (exceptionIndex) {
          const selected = decisionIndexGet(collections, exceptionIndex, unitId);
          if (selected !== undefined && typeof selected !== 'string')
            throw Error('Invalid selected reading exception');
          reason =
            selected === undefined
              ? undefined
              : (JSON.parse(selected as string) as { reason: string }).reason;
        }
        const gap = add(
          {
            id: unitId,
            locator: field<string>(view, unit, 'locator'),
            ...(reason ? { processingException: { reason } } : {}),
          },
          ['extracted', 'context', 'unreadable'].includes(kind || '') ? kind : undefined,
        );
        if (gap) yield gap;
      }
    } finally {
      scratch.close();
    }
  }
  if (!units)
    yield { locator: 'Retained original', reason: 'reading has not established page coverage' };
  const index = view.child(plan, 'index');
  for (const reference of intakeReviewChildren(view, index, 'references'))
    if (field(view, reference, 'status') === 'capacity_exception')
      yield {
        locator: field<string>(view, reference, 'locator')!,
        reason:
          'capacity exception: ' +
          (field<string>(view, reference, 'note') || 'references were not indexed'),
      };
}

/** Compatibility collector has the same checked output limit as production. */
export function nativePacketReadingGaps(
  db: Database,
  id: string,
  budget = new PacketOutputBudget(),
): PacketReadingGap[] {
  const gaps: PacketReadingGap[] = [];
  for (const gap of iterateNativePacketReadingGaps(db, id)) {
    budget.add(gap, gaps.length ? 1 : 0);
    gaps.push(gap);
  }
  return gaps;
}
