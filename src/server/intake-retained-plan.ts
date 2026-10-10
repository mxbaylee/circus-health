/** Retained expanded plans keep their actual units. They are never relabelled as
 * an inventory recipe; the selected schema remains the evidence authority. */
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { HttpError, type Database } from './database.ts';
import { assertIntakeOwner } from './intake.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { createEnvelopeBuildWriter } from './intake-envelope-build.ts';
import {
  prepareIntakeJsonCanonical,
  intakeJsonCanonicalWorkObserver,
} from './intake-json-canonical.ts';
import { hashIntakeJsonScalar } from './intake-json-scalar.ts';
import { prepareDirectPlanAccess, readDirectPlanScope } from './intake-direct-plan.ts';
import { readPackagePlanScope } from './intake-package-plan.ts';
import { readDurablePackageInventory } from './intake-package-state.ts';
import { prepareRetainedUnitPages, readRetainedUnitPages } from './intake-retained-unit-pages.ts';
import { selectedReadingStateIndex, type IntakeDecisionIndex } from './intake-reading-state.ts';
import { workflowHash } from './intake-workflow.ts';
import { recordCollectionReaderCoverageTransition } from './intake-source-reader-index.ts';
import { schemaOrdinal } from './intake-envelope-schema.ts';
import { HEAD_BYTES } from './intake-state-evidence.ts';
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import type { IntakeEnvelopeDerivedPreparation } from './intake-envelope-mutation.ts';
import type {
  IntakeExtractionCoverage,
  IntakeExtractionPlan,
  IntakeExtractionUnit,
} from '../shared/intake.ts';

const POLICY = 'health-intake-retained-plan-access-v7';
const buildDecisionName = (name: string, address: string, kind: DecisionKind) =>
  'retained.decisions.' + workflowHash([name, address]) + '.' + kind;
const decisionName = (kind: string, id: string) => 'package.' + kind + '.' + workflowHash(id);
type DecisionKind = 'units' | 'attempts' | 'accounted' | 'readingSkipped' | 'roles';
const decisionKinds: readonly DecisionKind[] = [
  'units',
  'attempts',
  'accounted',
  'readingSkipped',
  'roles',
];
interface UnitPointer {
  plan: string;
  unit: string;
  planOrdinal: number;
  ordinal: number;
}
interface NativePointer {
  plan: string;
  planOrdinal: number;
}
function scalar<T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): T {
  const value = view.field(record, name, { bytes: 8192 });
  if (value.kind !== 'value') throw Error('Missing bounded retained plan field: ' + name);
  return value.value as T;
}
function* children(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  field: string,
) {
  let after: string | undefined;
  do {
    const page = view.children(record, field, { after, items: 32, bytes: 32768 });
    yield* page.records;
    if (page.complete) return;
    if (!page.after || page.after === after) throw Error('Retained plan cursor did not advance');
    after = page.after;
  } while (true);
}
function context(db: Database, profileId: string, id: string) {
  assertIntakeOwner(db, profileId);
  const source = db
    .prepare(
      "SELECT id,kind,sha256,details_json FROM source_files WHERE id=? AND kind='intake_original'",
    )
    .get(id) as { id: string; kind: string; sha256: string; details_json: string } | undefined;
  if (!source) throw new HttpError(404, 'NOT_FOUND', 'Source intake not found');
  const view = openIntakeCollectionEnvelope(db, source),
    version = intakeSourceVersion(db, id),
    collections = selectedEnvelopeStore(db, source).collections,
    name = 'retained.plans.' + workflowHash(view.logical),
    intake = view.child(view.root(), 'intake'),
    flow = intake && view.child(intake, 'workflow');
  const assertCurrent = () => {
    assertIntakeOwner(db, profileId);
    const current = intakeSourceVersion(db, id);
    if (current.version !== version.version || current.logicalBinding !== version.logicalBinding)
      throw new HttpError(409, 'PLAN_CHANGED', 'This plan changed. Reload it before continuing.');
  };
  const get = <T>(key: string): T | undefined => {
    assertCurrent();
    const value = collections.get(collections.openView(), 'builds', name, key);
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw Error('Invalid retained plan index value');
    return JSON.parse(value) as T;
  };
  return { source, view, version, collections, name, flow, assertCurrent, get };
}
function coverageIdentity(view: IntakeCollectionEnvelopeReader, record: IntakeEnvelopeRecord) {
  return workflowHash([
    scalar(view, record, 'unitId'),
    scalar(view, record, 'kind'),
    hashIntakeJsonScalar(view.fieldChunks(record, 'notes')).hash,
  ]);
}

/** A complete cold pass indexes exact retained addresses and receipt joins.
 * Checkpoints remain auxiliary; cancellation never proves absent history. */
export async function prepareRetainedPlanAccess(
  db: Database,
  profileId: string,
  id: string,
  options: { assertRunning?: () => void } = {},
) {
  options.assertRunning?.();
  const ctx = context(db, profileId, id),
    { source, view, version, name, flow } = ctx;
  if (ctx.get('complete') === POLICY) return;
  const assertCurrent = () => {
    options.assertRunning?.();
    ctx.assertCurrent();
  };
  let examined = 0;
  const checkpoint = async () => {
    assertCurrent();
    if (++examined % 64 === 0) {
      await setImmediate();
      assertCurrent();
    }
  };
  const writer = createEnvelopeBuildWriter(db, source, name, version.rawVersion, {
    assertRunning: assertCurrent,
  });
  if (flow) {
    let planOrdinal = 0;
    for (const plan of children(view, flow, 'plans')) {
      await checkpoint();
      withIntakeWork(db, 'reconstruction', () => recordIntakeWork('retainedPlanHeaders'));
      const planId = scalar<string>(view, plan, 'id'),
        address = view.address(plan),
        active = scalar(view, plan, 'status') === 'active';
      await writer.put('record:' + address, JSON.stringify(planId));
      if (writer.peek('plan:' + planId) === undefined)
        await writer.put('plan:' + planId, JSON.stringify(address));
      if (active && writer.peek('activePlan:' + planId) === undefined)
        await writer.put('activePlan:' + planId, JSON.stringify(address));
      const pins = view.child(plan, 'pins');
      if (pins) {
        const parsed = await prepareIntakeJsonCanonical(view.recordChunks(pins), {
          mode: 'stringify',
          assertRunning: assertCurrent,
          onWork: intakeJsonCanonicalWorkObserver(db, 'reconstruction'),
        });
        const hash = createHash('sha256');
        try {
          for (const piece of parsed.chunks()) hash.update(piece);
        } finally {
          parsed.close();
        }
        await writer.put('pins:' + address, JSON.stringify(hash.digest('hex')));
      }
      if (active && writer.peek('active') === undefined)
        await writer.put('active', JSON.stringify(address));
      if (
        view.field(plan, 'format', { bytes: 256 }).kind === 'value' &&
        scalar(view, plan, 'format') === 'health-intake-package-plan-v2'
      ) {
        await writer.put('packageEvidence', 'true');
        if (scalar<number>(view, plan, 'unitCount') > 0) await writer.put('hasMembers', 'true');
        await writer.put('nativeInventory', 'true');
        const pointer = JSON.stringify({ plan: address, planOrdinal } satisfies NativePointer);
        if (writer.peek('native:first') === undefined) await writer.put('native:first', pointer);
        if (active && writer.peek('native:active') === undefined)
          await writer.put('native:active', pointer);
        planOrdinal++;
        continue;
      }
      if (
        view.field(plan, 'format', { bytes: 256 }).kind === 'value' &&
        scalar(view, plan, 'format') === 'health-intake-direct-plan-v2'
      ) {
        await prepareDirectPlanAccess(db, profileId, id, {
          recordAddress: address,
          assertRunning: assertCurrent,
        });
        const scope = readDirectPlanScope(db, profileId, id, { recordAddress: address });
        if (!scope) throw Error('Direct plan registry disagrees');
        for (let ordinal = 0; ordinal < scope.unitCount; ordinal++) {
          await checkpoint();
          withIntakeWork(db, 'reconstruction', () => recordIntakeWork('retainedPlanUnits'));
          const unit = scope.unitIdentityAt(ordinal);
          if (!unit) throw Error('Direct recipe unit is unavailable');
          const pointer = JSON.stringify({ plan: address, planOrdinal } satisfies NativePointer);
          if (writer.peek('direct:first:' + unit.id) === undefined)
            await writer.put('direct:first:' + unit.id, pointer);
          if (active && writer.peek('direct:active:' + unit.id) === undefined)
            await writer.put('direct:active:' + unit.id, pointer);
        }
        planOrdinal++;
        continue;
      }
      const planKey = 'p:' + address + ':',
        maps = Object.fromEntries(
          decisionKinds.map((kind) => [
            kind,
            createEnvelopeBuildWriter(
              db,
              source,
              buildDecisionName(name, address, kind),
              version.rawVersion,
              { assertRunning: assertCurrent },
            ),
          ]),
        ) as Record<DecisionKind, ReturnType<typeof createEnvelopeBuildWriter>>;
      for (const map of Object.values(maps)) {
        await map.put('initialize', '');
        await map.remove('initialize');
      }
      const index = view.child(plan, 'index');
      if (
        index &&
        view.field(index, 'kind', { bytes: 256 }).kind === 'value' &&
        scalar(view, index, 'kind') === 'zip'
      )
        await writer.put('packageEvidence', 'true');
      if (index)
        for (const member of children(view, index, 'members')) {
          await checkpoint();
          if (writer.peek('hasMembers') !== 'true') await writer.put('hasMembers', 'true');
          const filename = view.field(member, 'filename', { bytes: 262144 });
          const identity = view.field(member, 'memberId', { bytes: 8192 });
          if (
            filename.kind === 'value' &&
            typeof filename.value === 'string' &&
            identity.kind === 'value' &&
            typeof identity.value === 'string'
          ) {
            const key = planKey + 'filename:' + workflowHash(filename.value);
            const saved = writer.peek(key);
            const matches = saved ? (JSON.parse(saved) as { id: string; address: string }[]) : [];
            if (matches.length < 2 && !matches.some((x) => x.id === identity.value)) {
              matches.push({ id: identity.value, address: view.address(member) });
              await writer.put(key, JSON.stringify(matches));
            }
          }

          for (const field of ['sourceFileId', 'memberId'] as const) {
            const value = view.field(member, field, { bytes: 8192 });
            if (value.kind === 'missing') continue;
            if (value.kind !== 'value' || typeof value.value !== 'string')
              throw Error('Invalid retained member identity');
            const key = planKey + 'member:' + field + ':' + workflowHash(value.value);
            if (field === 'memberId') {
              await writer.put(
                'hasMember:' + workflowHash(value.value),
                JSON.stringify(value.value),
              );
              const firstKey = 'firstMember:' + workflowHash(value.value);
              if (writer.peek(firstKey) === undefined)
                await writer.put(
                  firstKey,
                  JSON.stringify({
                    memberId: value.value,
                    planOrdinal,
                    address: view.address(member),
                  }),
                );
            }
            if (writer.peek(key) === undefined)
              await writer.put(key, JSON.stringify(view.address(member)));
          }
        }
      let ordinal = 0;
      for (const unit of children(view, plan, 'units')) {
        await checkpoint();
        withIntakeWork(db, 'reconstruction', () => recordIntakeWork('retainedPlanUnits'));
        await prepareRetainedUnitPages(view, unit, writer, 'pages:' + view.address(unit) + ':', {
          assertRunning: assertCurrent,
          onWork: intakeJsonCanonicalWorkObserver(db, 'reconstruction'),
        });
        const unitId = scalar<string>(view, unit, 'id'),
          pointer = JSON.stringify({
            plan: address,
            unit: view.address(unit),
            planOrdinal,
            ordinal,
          } satisfies UnitPointer);
        if (writer.peek('first:' + unitId) === undefined)
          await writer.put('first:' + unitId, pointer);
        if (active && writer.peek('active:' + unitId) === undefined)
          await writer.put('active:' + unitId, pointer);
        if (writer.peek(planKey + 'unit:' + unitId) === undefined)
          await writer.put(planKey + 'unit:' + unitId, pointer);
        const memberField = view.field(unit, 'memberId', { bytes: 8192 });
        const memberId =
          memberField.kind === 'missing' ? undefined : scalar<string>(view, unit, 'memberId');
        if (memberId !== undefined) {
          const key = planKey + 'unitMember:' + workflowHash(memberId);
          if (writer.peek(key) === undefined)
            await writer.put(key, JSON.stringify({ memberId, unitId }));
        }
        for (const attempt of children(view, unit, 'attempts')) {
          await checkpoint();
          let text = '';
          for (const piece of view.recordChunks(attempt)) {
            if (Buffer.byteLength(text) + Buffer.byteLength(piece) > 8192)
              throw Error('Invalid retained attempt identity');
            text += piece;
          }
          const attemptId: unknown = JSON.parse(text);
          if (typeof attemptId !== 'string') throw Error('Invalid retained attempt identity');
          await maps.attempts.put(workflowHash([unitId, attemptId]), '1');
        }
        const exceptionField = view.field(unit, 'processingException', { bytes: 8192 });
        if (
          view.child(unit, 'processingException') ||
          (exceptionField.kind === 'value' && !!exceptionField.value)
        )
          await maps.readingSkipped.put(schemaOrdinal(ordinal), unitId);
        ordinal++;
      }
      for (const batch of children(view, plan, 'batches')) {
        await checkpoint();
        const batchId = scalar<string>(view, batch, 'id');
        for (const receipt of children(view, batch, 'coverage')) {
          await checkpoint();
          withIntakeWork(db, 'reconstruction', () =>
            recordIntakeWork('retainedPlanCoverageReceipts'),
          );
          assertCurrent();
          const unitId = scalar<string>(view, receipt, 'unitId'),
            unit = view.find('unit', plan, unitId),
            selected = unit && view.child(unit, 'coverage');
          if (
            unit &&
            selected &&
            view.contains(unit, 'attempts', batchId) &&
            coverageIdentity(view, selected) === coverageIdentity(view, receipt)
          ) {
            const pointer = JSON.parse(writer.peek(planKey + 'unit:' + unitId)!) as UnitPointer;
            await writer.put(
              planKey + 'proof:' + unitId,
              JSON.stringify({ batch: view.address(batch), receipt: view.address(receipt) }),
            );
            // Cold retained evidence stays addressed directly; new decisions alone populate units.
            if (['extracted', 'context', 'unreadable'].includes(scalar(view, receipt, 'kind'))) {
              await maps.accounted.put(schemaOrdinal(pointer.ordinal), unitId);
              await maps.readingSkipped.remove(schemaOrdinal(pointer.ordinal));
            }
          }
        }
      }
      for (const role of children(view, plan, 'packageRoles')) {
        await checkpoint();
        const memberId = scalar<string>(view, role, 'memberId'),
          key = planKey + 'role:' + memberId;
        const canonical = await prepareIntakeJsonCanonical(view.recordChunks(role), {
          mode: 'stringify',
          assertRunning: assertCurrent,
          onWork: intakeJsonCanonicalWorkObserver(db, 'reconstruction'),
        });
        const hash = createHash('sha256');
        try {
          for (const piece of canonical.chunks()) hash.update(piece);
        } finally {
          canonical.close();
        }
        const pointer = { address: view.address(role), hash: hash.digest('hex') };
        if (writer.peek(key) === undefined) await writer.put(key, JSON.stringify(pointer));
        await maps.roles.put(memberId, JSON.stringify({ retainedRole: pointer }));
      }
      for (const map of Object.values(maps)) await map.flush();
      planOrdinal++;
    }
  }
  await writer.flush();
  assertCurrent();
  await writer.put('complete', JSON.stringify(POLICY));
  await writer.flush();
  assertCurrent();
}

/** Complete package-evidence membership, independent of the active recipe kind. */
export function readRetainedPlanEvidence(db: Database, profileId: string, id: string) {
  const ctx = context(db, profileId, id);
  if (ctx.get('complete') !== POLICY)
    throw new HttpError(
      409,
      'PLAN_PREPARATION_REQUIRED',
      'Prepare retained plan evidence before reading package membership',
    );
  return {
    packageEvidence: ctx.get('packageEvidence') === true,
    hasMembers: ctx.get('hasMembers') === true,
    assertCurrent: ctx.assertCurrent,
    /** First plan and first member, including a native inventory preceding a retained plan. */
    firstMember(memberId: string) {
      const pointer = ctx.get<{ memberId: string; planOrdinal: number; address: string }>(
        'firstMember:' + workflowHash(memberId),
      );
      if (pointer && pointer.memberId !== memberId)
        throw Error('Retained member identity mismatch');
      const native = ctx.get<NativePointer>('native:first');
      if (native && (!pointer || native.planOrdinal < pointer.planOrdinal)) {
        const plan = ctx.view.resolve(native.plan),
          descriptor = scalar<{ id: string }>(ctx.view, plan, 'inventory');
        const inventory = readDurablePackageInventory({
          db,
          profileId,
          id,
          rawDomainVersion: ctx.version.rawVersion,
        });
        if (!inventory || inventory.inventoryId !== descriptor.id)
          throw Error('Selected historical package inventory is unavailable');
        const member = inventory.byId(memberId);
        if (member) return { kind: 'inventory' as const, member };
      }
      if (!pointer) return undefined;
      const record = ctx.view.resolve(pointer.address);
      if (scalar(ctx.view, record, 'memberId') !== memberId)
        throw Error('Retained member pointer changed');
      return { kind: 'retained' as const, view: ctx.view, record };
    },
    hasMember(memberId: string) {
      return (
        ctx.get<string>('hasMember:' + workflowHash(memberId)) === memberId ||
        (ctx.get('nativeInventory') === true &&
          !!readDurablePackageInventory({
            db,
            profileId,
            id,
            rawDomainVersion: ctx.version.rawVersion,
          })?.byId(memberId))
      );
    },
  };
}

export function readRetainedPlanScope(
  db: Database,
  profileId: string,
  id: string,
  options: { planId?: string; recordAddress?: string; activeOnly?: boolean } = {},
) {
  const ctx = context(db, profileId, id),
    { view, flow, collections, name } = ctx;
  if (ctx.get('complete') !== POLICY)
    throw new HttpError(
      409,
      'PLAN_PREPARATION_REQUIRED',
      'Prepare retained plan evidence before reading this scope',
    );
  const address =
    options.recordAddress ??
    (options.planId === undefined
      ? ctx.get<string>('active')
      : ctx.get<string>((options.activeOnly ? 'activePlan:' : 'plan:') + options.planId));
  if (!flow || !address) return undefined;
  if (ctx.get<string>('record:' + address) === undefined)
    throw Error('Foreign retained plan record');
  const record = view.resolve(address),
    planId = scalar<string>(view, record, 'id');
  if (options.activeOnly && scalar(view, record, 'status') !== 'active') return undefined;
  if (scalar<string | undefined>(view, record, 'status') === undefined)
    throw Error('Invalid retained plan status');
  if (
    view.field(record, 'format', { bytes: 256 }).kind === 'value' &&
    ['health-intake-package-plan-v2', 'health-intake-direct-plan-v2'].includes(
      scalar<string>(view, record, 'format'),
    )
  )
    return undefined;
  const prefix = 'p:' + address + ':';
  const decisionCollection = (kind: DecisionKind) =>
    decisionName(
      kind,
      ctx.get<string>('plan:' + planId) === address ? planId : planId + ':' + address,
    );
  function decisionIndex(kind: 'readingSkipped'): IntakeDecisionIndex;
  function decisionIndex(kind: Exclude<DecisionKind, 'readingSkipped'>): {
    area: 'logical' | 'builds';
    collection: string;
  };
  function decisionIndex(kind: DecisionKind): IntakeDecisionIndex;
  function decisionIndex(kind: DecisionKind): IntakeDecisionIndex {
    ctx.assertCurrent();
    if (kind === 'readingSkipped') {
      const catalog = selectedReadingStateIndex(collections, address!, kind);
      if (catalog) return catalog;
    }
    const logical = decisionCollection(kind);
    return collections.collection(collections.openView(), 'logical', logical)
      ? { area: 'logical' as const, collection: logical }
      : {
          area: 'builds' as const,
          collection: buildDecisionName(ctx.get<string>('decisionBase') ?? name, address!, kind),
        };
  }
  const decision = (unitId: string) => {
    const index = decisionIndex('units'),
      raw = collections.get(collections.openView(), index.area, index.collection, unitId);
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') throw Error('Invalid retained unit selection');
    return JSON.parse(raw) as { batchId: string; coverageOrdinal: number; attemptCount: number };
  };
  const unitById = (unitId: string) => {
    const pointer = ctx.get<UnitPointer>(prefix + 'unit:' + unitId);
    if (!pointer) return undefined;
    const unit = view.resolve(pointer.unit);
    if (scalar(view, unit, 'id') !== unitId) throw Error('Retained unit index disagrees');
    const selected = decision(unitId),
      attemptIndex = decisionIndex('attempts');
    let coverage = view.child(unit, 'coverage');
    if (selected) {
      const batch = view.find('batch', record, selected.batchId),
        receipt = batch && view.childAt(batch, 'coverage', selected.coverageOrdinal);
      if (
        !receipt ||
        scalar(view, receipt, 'unitId') !== unitId ||
        !Number.isSafeInteger(selected.attemptCount) ||
        selected.attemptCount < 1 ||
        collections.get(
          collections.openView(),
          attemptIndex.area,
          attemptIndex.collection,
          workflowHash([unitId, selected.batchId]),
        ) !== '1'
      )
        throw Error('Selected retained unit receipt is unavailable');
      coverage = receipt;
    }
    return {
      reader: view,
      record: unit,
      pages: readRetainedUnitPages(ctx.get, 'pages:' + pointer.unit + ':'),
      coverageRecord: coverage,
      ordinal: pointer.ordinal,
      id: unitId,
      kind: scalar<IntakeExtractionUnit['kind']>(view, unit, 'kind'),
      status:
        selected && coverage
          ? ((scalar(view, coverage, 'kind') === 'extracted'
              ? 'completed'
              : 'partial') as IntakeExtractionUnit['status'])
          : scalar<IntakeExtractionUnit['status']>(view, unit, 'status'),
      attemptCount: selected?.attemptCount ?? view.childCount(unit, 'attempts'),
      processingException:
        !!view.child(unit, 'processingException') ||
        (() => {
          const value = view.field(unit, 'processingException', { bytes: 8192 });
          return value.kind === 'value' && !!value.value;
        })(),
      exceptionRecord: view.child(unit, 'processingException'),
      memberRecord: (() => {
        const kind = scalar<string>(view, unit, 'kind'),
          key = kind === 'package_member' ? 'memberId' : 'sourceFileId',
          value = view.field(unit, key, { bytes: 8192 });
        if (value.kind === 'missing') return undefined;
        if (value.kind !== 'value' || typeof value.value !== 'string')
          throw Error('Invalid retained unit source identity');
        const address = ctx.get<string>(prefix + 'member:' + key + ':' + workflowHash(value.value)),
          member = address && view.resolve(address);
        if (
          !member ||
          scalar(view, member, key) !== value.value ||
          scalar(view, member, 'sourceHash') !== scalar(view, unit, 'sourceHash')
        )
          throw new HttpError(
            409,
            'PLAN_SOURCE',
            'Unit member does not match its retained delivery index',
          );
        return member;
      })(),
    };
  };
  return {
    format: 'health-intake-retained-expanded-plan-v1' as const,
    /** Conservative encoded footprint of the captured context, not unit/history
     * data. Source/binding strings occur in the context and checked schema
     * reader closures; the allowance covers their copies and bounded heads.
     * Page providers retain only prefixes/counts. Shared storage caches have
     * their own bounds. Extend this accounting if a closure starts retaining
     * decoded collection values or a new variable-sized descriptor. */
    retainedMetadataBytes() {
      ctx.assertCurrent();
      return (
        4 *
          Buffer.byteLength(
            JSON.stringify({
              source: ctx.source,
              version: ctx.version,
              logical: view.logical,
              name,
              address,
              planId,
              prefix,
            }),
          ) +
        4 * HEAD_BYTES
      );
    },
    planId,
    record,
    reader: view,
    version: ctx.version.version,
    unitCount: view.childCount(record, 'units'),
    status: scalar<IntakeExtractionPlan['status']>(view, record, 'status'),
    pinsRecord: view.child(record, 'pins'),
    indexRecord: view.child(record, 'index'),
    unitById,
    unitPagesAt(ordinal: number) {
      const unit = view.childAt(record, 'units', ordinal);
      return unit ? readRetainedUnitPages(ctx.get, 'pages:' + view.address(unit) + ':') : undefined;
    },
    unitByMemberId(memberId: string) {
      const selected = ctx.get<{ memberId: string; unitId: string }>(
        prefix + 'unitMember:' + workflowHash(memberId),
      );
      if (!selected) return undefined;
      const unit = unitById(selected.unitId);
      if (
        selected.memberId !== memberId ||
        !unit ||
        scalar(view, unit.record, 'memberId') !== memberId
      )
        throw Error('Retained unit member index disagrees');
      return unit;
    },
    decisionCollection,
    pinsHash: ctx.get<string>('pins:' + address),
    packageEvidence: ctx.get('packageEvidence') === true,
    hasMember(memberId: string) {
      return (
        ctx.get<string>('hasMember:' + workflowHash(memberId)) === memberId ||
        (ctx.get('nativeInventory') === true &&
          !!readDurablePackageInventory({
            db,
            profileId,
            id,
            rawDomainVersion: ctx.version.rawVersion,
          })?.byId(memberId))
      );
    },
    memberById(memberId: string) {
      const address = ctx.get<string>(prefix + 'member:memberId:' + workflowHash(memberId));
      if (!address) return undefined;
      const member = view.resolve(address),
        filename = view.field(member, 'filename', { bytes: 262144 });
      if (
        scalar(view, member, 'memberId') !== memberId ||
        filename.kind !== 'value' ||
        typeof filename.value !== 'string'
      )
        throw Error('Invalid selected package member');
      return { memberId, filename: filename.value };
    },
    membersByExactName(filename: string) {
      const matches =
        ctx.get<{ id: string; address: string }[]>(prefix + 'filename:' + workflowHash(filename)) ??
        [];
      return matches.flatMap((match) => {
        const member = view.resolve(match.address),
          literal = view.field(member, 'filename', { bytes: 262144 });
        if (
          literal.kind !== 'value' ||
          literal.value !== filename ||
          scalar(view, member, 'memberId') !== match.id
        )
          throw Error('Selected package name index disagrees');
        return [{ memberId: match.id, filename }];
      });
    },
    roleMergeChanges(): IntakeCollectionChange[] {
      ctx.assertCurrent();
      const name = decisionCollection('roles');
      return collections.collection(collections.openView(), 'logical', name)
        ? []
        : [
            {
              area: 'logical',
              collection: name,
              op: 'adoptCollection',
              fromArea: 'builds',
              fromCollection: buildDecisionName(
                ctx.get<string>('decisionBase') ?? ctx.name,
                address!,
                'roles',
              ),
            },
          ];
    },
    decisionIndex,
    assertCurrent: ctx.assertCurrent,
    units(options: { after?: string; items: number; bytes: number }) {
      return view.children(record, 'units', options);
    },
    attempts(unitId: string, options: { after?: string; items: number; bytes: number }) {
      const unit = unitById(unitId);
      if (!unit) throw new HttpError(404, 'NOT_FOUND', 'Extraction unit not found');
      return view.children(unit.record, 'attempts', options);
    },
    roleRecord(memberId: string) {
      const raw = collections.get(
        collections.openView(),
        'logical',
        decisionCollection('roles'),
        memberId,
      );
      if (raw !== undefined) {
        if (typeof raw !== 'string') throw Error('Invalid selected retained role');
        const retained = JSON.parse(raw) as { retainedRole?: { address: string; hash: string } };
        if (retained.retainedRole) {
          const pointer = retained.retainedRole,
            role = view.resolve(pointer.address);
          if (scalar(view, role, 'memberId') !== memberId || !/^[a-f0-9]{64}$/.test(pointer.hash))
            throw Error('Retained merged role pointer disagrees');
          return { reader: view, record: role, hash: pointer.hash };
        }
        const selected = JSON.parse(raw) as {
          historyId: string;
          ordinal: number;
          referenceCount: number;
          roleHash: string;
        };
        const history = view.find('packageRoleHistory', record, selected.historyId),
          role = history && view.childAt(history, 'roles', selected.ordinal);
        if (
          !role ||
          scalar(view, role, 'memberId') !== memberId ||
          view.childCount(role, 'references') !== selected.referenceCount ||
          !/^[a-f0-9]{64}$/.test(selected.roleHash)
        )
          throw Error('Selected retained role disagrees with history');
        return { reader: view, record: role, hash: selected.roleHash };
      }
      const pointer = ctx.get<{ address: string; hash: string }>(prefix + 'role:' + memberId);
      if (!pointer) return undefined;
      const role = view.resolve(pointer.address);
      if (scalar(view, role, 'memberId') !== memberId) throw Error('Retained role index disagrees');
      return { reader: view, record: role, hash: pointer.hash };
    },
    accountedKind(unitId: string): 'extracted' | 'context' | 'unreadable' | null {
      const unit = unitById(unitId);
      if (!unit) throw new HttpError(404, 'NOT_FOUND', 'Extraction unit not found');
      const coverage = unit.coverageRecord;
      if (!coverage || scalar(view, coverage, 'unitId') !== unitId) return null;
      const kind = scalar<IntakeExtractionCoverage['kind']>(view, coverage, 'kind');
      if (kind === 'inspected' || !['extracted', 'context', 'unreadable'].includes(kind))
        return null;
      return decision(unitId) || ctx.get(prefix + 'proof:' + unitId)
        ? (kind as 'extracted' | 'context' | 'unreadable')
        : null;
    },
    compatibilityChanges(): IntakeCollectionChange[] {
      return decisionKinds.flatMap((kind) => {
        const from = decisionIndex(kind);
        if (from.reference) return [];
        return from.area === 'logical'
          ? []
          : [
              {
                area: 'logical' as const,
                collection: decisionCollection(kind),
                op: 'adoptCollection' as const,
                fromArea: from.area,
                fromCollection: from.collection,
              },
            ];
      });
    },
  };
}

/** Exact old precedence: first active plan containing the unit, then first
 * retained plan containing it. Native recipe plans do not hide older units. */
export function readRetainedIntakeUnitScope(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  unitId: string,
) {
  const ctx = context(db, profileId, id);
  if (ctx.get('complete') !== POLICY)
    throw new HttpError(
      409,
      'PLAN_PREPARATION_REQUIRED',
      'Prepare retained plan evidence before reading this unit',
    );
  for (const mode of ['active', 'first'] as const) {
    const retained = ctx.get<UnitPointer>(mode + ':' + unitId),
      native = ctx.get<NativePointer>('native:' + mode),
      direct = ctx.get<NativePointer>('direct:' + mode + ':' + unitId);
    const candidates = [
      ...(retained ? [{ kind: 'retained' as const, pointer: retained }] : []),
      ...(native ? [{ kind: 'native' as const, pointer: native }] : []),
      ...(direct ? [{ kind: 'direct' as const, pointer: direct }] : []),
    ].sort((a, b) => a.pointer.planOrdinal - b.pointer.planOrdinal);
    for (const { kind, pointer } of candidates) {
      if (kind === 'direct') {
        const scope = readDirectPlanScope(db, profileId, id, { recordAddress: pointer.plan }),
          unit = scope?.unitById(unitId);
        if (!unit) throw Error('Direct plan unit registry disagrees');
        return { format: 'direct' as const, scope: scope!, unit };
      }
      const record = ctx.view.resolve(pointer.plan),
        planId = scalar<string>(ctx.view, record, 'id');
      if (kind === 'native') {
        const scope = readPackagePlanScope(db, root, profileId, id, { planId }),
          unit = scope?.unitById(unitId);
        if (unit) return { format: 'native' as const, scope: scope!, unit };
      } else {
        const scope = readRetainedPlanScope(db, profileId, id, {
            planId,
            recordAddress: pointer.plan,
          }),
          unit = scope?.unitById(unitId);
        if (!unit) throw Error('Retained plan unit index disagrees');
        return { format: 'retained' as const, scope: scope!, unit };
      }
    }
  }
  throw new HttpError(404, 'NOT_FOUND', 'Extraction unit not found');
}

/** Closed host command effects. These are supplied by the owning command
 * participant, never deserialized from a client assertion about changed paths. */
export type RetainedPlanImpact =
  | { kind: 'proposal' | 'question' | 'link' | 'processing-exception' }
  | {
      kind: 'package-batch';
      planId: string;
      planAddress?: string;
      batchId: string;
      unitIds: readonly string[];
    }
  | {
      kind: 'package-roles';
      planId: string;
      planAddress?: string;
      historyId: string;
      memberIds: readonly string[];
    }
  | { kind: 'unsupported' };

/** Share the complete checked selector after a command that preserves plan/unit
 * membership. New decision roots remain part of the same domain publication.
 * Unsupported structural changes leave the new selection explicitly pending. */
export async function prepareRetainedPlanDerived(
  db: Database,
  profileId: string,
  id: string,
  input: IntakeEnvelopeDerivedPreparation & { impact: RetainedPlanImpact },
): Promise<readonly IntakeCollectionChange[]> {
  const ctx = context(db, profileId, id);
  if (input.impact.kind !== 'unsupported') {
    const oldIntake = ctx.view.child(ctx.view.root(), 'intake')!,
      intake = input.reader.child(input.reader.root(), 'intake')!,
      proposalIds: string[] = [];
    for (
      let n = ctx.view.childCount(oldIntake, 'proposals'),
        count = input.reader.childCount(intake, 'proposals');
      n < count;
      n++
    )
      proposalIds.push(
        scalar<string>(input.reader, input.reader.childAt(intake, 'proposals', n)!, 'id'),
      );
    const batch = input.impact.kind === 'package-batch' ? input.impact : undefined;
    const planAddress =
      batch &&
      (batch.planAddress ||
        (ctx.flow &&
          ctx.view.find('plan', ctx.flow, batch.planId) &&
          ctx.view.address(ctx.view.find('plan', ctx.flow, batch.planId)!)));
    if (batch && !planAddress) throw Error('Reader coverage changed batch has no selected plan');
    recordCollectionReaderCoverageTransition(db, ctx.source, input, {
      proposalIds,
      ...(batch ? { batches: [{ planAddress: planAddress!, unitIds: batch.unitIds }] } : {}),
    });
  }
  if (ctx.get('complete') !== POLICY || input.impact.kind === 'unsupported') return [];
  if (JSON.stringify(input.reader.logical) !== JSON.stringify(ctx.view.logical))
    throw Error('Retained plan derived reader has a different base');
  const intake = input.reader.child(input.reader.root(), 'intake'),
    flow = intake && input.reader.child(intake, 'workflow');
  if (
    !!flow !== !!ctx.flow ||
    (flow &&
      ctx.flow &&
      input.reader.childCount(flow, 'plans') !== ctx.view.childCount(ctx.flow, 'plans'))
  )
    return [];
  const impact = input.impact;
  if (impact.kind === 'package-batch' || impact.kind === 'package-roles') {
    const keys = impact.kind === 'package-batch' ? impact.unitIds : impact.memberIds;
    if (
      !keys.length ||
      keys.length > 50 ||
      new Set(keys).size !== keys.length ||
      !flow ||
      !ctx.flow
    )
      throw Error('Invalid bounded retained plan impact');
    if (impact.planAddress && ctx.get<string>('record:' + impact.planAddress) !== impact.planId)
      throw Error('Foreign retained plan impact');
    const old = impact.planAddress
        ? ctx.view.resolve(impact.planAddress)
        : ctx.view.find('plan', ctx.flow, impact.planId),
      selected = impact.planAddress
        ? input.reader.resolve(impact.planAddress)
        : input.reader.find('plan', flow, impact.planId);
    const decisionId =
      impact.planAddress && ctx.get<string>('plan:' + impact.planId) !== impact.planAddress
        ? impact.planId + ':' + impact.planAddress
        : impact.planId;
    if (
      !old ||
      !selected ||
      ctx.view.address(old) !== input.reader.address(selected) ||
      scalar(ctx.view, old, 'status') !== scalar(input.reader, selected, 'status') ||
      ctx.view.childCount(old, 'units') !== input.reader.childCount(selected, 'units')
    )
      return [];
    if (impact.kind === 'package-batch') {
      const batch = input.reader.find('batch', selected, impact.batchId);
      if (
        !batch ||
        input.reader.childCount(batch, 'coverage') !== keys.length ||
        input.reader.childCount(selected, 'batches') !== ctx.view.childCount(old, 'batches') + 1
      )
        return [];
      const received = new Set<string>();
      for (const receipt of children(input.reader, batch, 'coverage'))
        received.add(scalar(input.reader, receipt, 'unitId'));
      if (keys.some((key) => !received.has(key))) return [];
      for (const kind of ['units', 'attempts', 'accounted'] as const)
        if (
          !input.domainChanges.some(
            (change) =>
              change.area === 'logical' && change.collection === decisionName(kind, decisionId),
          )
        )
          return [];
    } else {
      const history = input.reader.find('packageRoleHistory', selected, impact.historyId);
      if (
        !history ||
        input.reader.childCount(history, 'roles') !== keys.length ||
        input.reader.childCount(selected, 'packageRolesHistory') !==
          ctx.view.childCount(old, 'packageRolesHistory') + 1
      )
        return [];
      const received = new Set<string>();
      for (const role of children(input.reader, history, 'roles'))
        received.add(scalar(input.reader, role, 'memberId'));
      if (
        keys.some((key) => !received.has(key)) ||
        !input.domainChanges.some(
          (change) =>
            change.area === 'logical' && change.collection === decisionName('roles', decisionId),
        )
      )
        return [];
    }
  }
  ctx.assertCurrent();
  const name = 'retained.plans.' + workflowHash(input.logical);
  if (name === ctx.name) return [];
  return [
    {
      area: 'builds',
      collection: name,
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: ctx.name,
    },
    {
      area: 'builds',
      collection: name,
      op: 'put',
      key: 'decisionBase',
      value: JSON.stringify(ctx.get<string>('decisionBase') ?? ctx.name),
    },
  ];
}
