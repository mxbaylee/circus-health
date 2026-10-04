/** Domain adapter for selected paged package plans. Inventory occurrences are
 * implicit units; only decisions and bounded plan descriptors are published. */
import { createHash, randomUUID } from 'node:crypto';
import { readRetainedPlanScope } from './intake-retained-plan.ts';
import {
  invalidateCollectionReaderRoleDependencies,
  recordCollectionReaderCoverageTransition,
} from './intake-source-reader-index.ts';
import type { Database } from './database.ts';
import { HttpError } from './database.ts';
import { intakeTransaction, assertIntakeOwner } from './intake.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import {
  selectedReadingStateIndex,
  decisionIndexGet,
  type IntakeDecisionIndex,
} from './intake-reading-state.ts';
import { intakeEnvelopeAuthorityBinding } from './intake-authority.ts';
import { buildIntakeCollectionEnvelope } from './intake-envelope-build.ts';
import { createEnvelopeBuildWriter } from './intake-envelope-build.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import {
  prepareIntakeJsonCanonical,
  intakeJsonCanonicalWorkObserver,
} from './intake-json-canonical.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  intakeEnvelopeRecordOrder,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import {
  prepareIntakeEnvelopeMutation,
  type IntakeEnvelopeMutation,
} from './intake-envelope-mutation.ts';
import {
  buildDurablePackageInventory,
  readDurablePackageInventory,
} from './intake-package-state.ts';
import { extractionPins, packageMemberUnit, streamedExtractionPlanId } from './intake-plan.ts';
import { workflowHash } from './intake-workflow.ts';
import { observeIntakeLogicalVersion } from './import-version-diagnostics.ts';
import type { IntakePackageRole, IntakeExtractionCoverage } from '../shared/intake.ts';
import { accountedUnitKindInScope } from './intake-unit-accounting.ts';
import { recordIntakeWork, withIntakeWork } from './intake-work-accounting.ts';
import type {
  IntakeMetadataFragment,
  IntakeMetadataFragmentReference,
} from '../shared/intake-package-paging.ts';
import type {
  IntakePackagePlanV2,
  IntakePackagePlanResult,
  IntakePackageUnitPage,
  IntakePackageUnitSummary,
} from '../shared/intake-package-plan.ts';

interface PackagePlanInput {
  version: number;
  operationId?: string;
  replacePlanId?: string;
  unitSize?: number;
  overlap?: number;
  assertRunning?: () => void;
}
function source(db: Database, profileId: string, id: string) {
  assertIntakeOwner(db, profileId);
  const value = db
    .prepare(
      "SELECT id,kind,sha256,details_json,provider_id,mime_type FROM source_files WHERE id=? AND kind='intake_original'",
    )
    .get(id) as
    | {
        id: string;
        kind: string;
        sha256: string;
        details_json: string;
        provider_id: string;
        mime_type: string;
      }
    | undefined;
  if (!value) throw new HttpError(404, 'NOT_FOUND', 'Source intake not found');
  if (value.mime_type !== 'application/zip')
    throw new HttpError(415, 'PACKAGE_FORMAT', 'Select a retained ZIP delivery');
  intakeEnvelopeAuthorityBinding(db, value);
  return value;
}
function scalar<T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  field: string,
  bytes = 8192,
): T {
  const result = view.field(record, field, { bytes });
  if (result.kind !== 'value') throw Error('Missing bounded package plan field: ' + field);
  return result.value as T;
}
function optional<T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  field: string,
): T | undefined {
  const result = view.field(record, field, { bytes: 8192 });
  if (result.kind === 'missing') return undefined;
  if (result.kind !== 'value') throw Error('Fragmented package plan field: ' + field);
  return result.value as T;
}
function workflow(view: IntakeCollectionEnvelopeReader) {
  const intake = view.child(view.root(), 'intake');
  if (!intake) throw Error('Missing intake envelope');
  return { intake, workflow: view.child(intake, 'workflow') };
}
function readPlan(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  inventory?: NonNullable<ReturnType<typeof readDurablePackageInventory>>,
): IntakePackagePlanV2 {
  const native = optional(view, record, 'format') === 'health-intake-package-plan-v2';
  if (!native) {
    const index = view.child(record, 'index');
    if (
      !inventory ||
      !index ||
      scalar(view, index, 'kind') !== 'zip' ||
      optional(view, index, 'inventoryVersion') !== 1 ||
      view.childCount(record, 'units') !== inventory.summary.members
    )
      throw Error('Selected package plan requires its legacy expanded-unit reader');
  }
  const pins = view.child(record, 'pins');
  if (!pins) throw Error('Package plan pins are missing');
  const plan: IntakePackagePlanV2 = {
    format: 'health-intake-package-plan-v2',
    id: scalar(view, record, 'id'),
    createdAt: scalar(view, record, 'createdAt'),
    status: scalar(view, record, 'status'),
    pins: {
      sourceHash: scalar(view, pins, 'sourceHash'),
      backend: scalar(view, pins, 'backend'),
      model: scalar(view, pins, 'model'),
      reasoningEffort: scalar(view, pins, 'reasoningEffort'),
      ...(view.has(pins, 'connectionIdentity')
        ? { connectionIdentity: scalar<string>(view, pins, 'connectionIdentity') }
        : {}),
      instructionVersion: scalar(view, pins, 'instructionVersion'),
      mappingVersion: scalar(view, pins, 'mappingVersion'),
      ...(view.has(pins, 'reviewedMetadataVersion')
        ? { reviewedMetadataVersion: scalar<string>(view, pins, 'reviewedMetadataVersion') }
        : {}),
    },
    inventory: native
      ? scalar(view, record, 'inventory')
      : {
          id: inventory!.inventoryId,
          sourceHash: inventory!.binding.sourceHash,
          memberCount: inventory!.summary.members,
          totalExpandedBytes: inventory!.summary.expandedBytes,
          uniqueByteContents: inventory!.uniqueByteContents,
        },
    unitRecipe: native
      ? scalar(view, record, 'unitRecipe')
      : 'health-intake-package-member-unit-v1',
    unitCount: native ? scalar(view, record, 'unitCount') : view.childCount(record, 'units'),
  };
  if (
    !/^plan:[a-f0-9]{64}$/.test(plan.id) ||
    !['active', 'superseded'].includes(plan.status) ||
    plan.unitRecipe !== 'health-intake-package-member-unit-v1' ||
    !Number.isSafeInteger(plan.unitCount) ||
    plan.unitCount < 0 ||
    !plan.inventory ||
    plan.inventory.memberCount !== plan.unitCount ||
    plan.inventory.sourceHash !== plan.pins.sourceHash
  )
    throw Error('Invalid paged package plan descriptor');
  return plan;
}
function activeRecord(
  db: Database,
  file: ReturnType<typeof source>,
  view: IntakeCollectionEnvelopeReader,
) {
  const state = selectedEnvelopeStore(db, file).collections,
    selected = state.get(state.openView(), 'logical', 'package.selection', 'active'),
    flow = workflow(view).workflow;
  if (!flow) return undefined;
  if (selected !== undefined) {
    if (typeof selected !== 'string') throw Error('Invalid package selection');
    const record = view.find('plan', flow, selected);
    if (!record || scalar(view, record, 'status') !== 'active')
      throw Error('Package selection is inconsistent');
    return record;
  }
  // Only the migration path lacks a selector. Traverse legacy plan headers a
  // page at a time; a native publication installs the checked point selector.
  let after: string | undefined;
  do {
    const page = view.children(flow, 'plans', { after, items: 32, bytes: 32768 });
    for (const record of page.records)
      if (scalar(view, record, 'status') === 'active') return record;
    if (page.complete) return undefined;
    after = page.after ?? undefined;
    if (!after) throw Error('Plan header cursor did not advance');
  } while (true);
}
function inline<T>(value: unknown): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw Error('Expected bounded package decision');
  return JSON.parse(value) as T;
}
const decisionCollection = (kind: string, planId: string) =>
  'package.' + kind + '.' + workflowHash(planId);
interface RoleSelection {
  historyId: string;
  ordinal: number;
  referenceCount: number;
  missingReferenceCount: number;
  ambiguousReferenceCount: number;
  roleHash: string;
}
interface UnitSelection {
  batchId: string;
  coverageOrdinal: number;
  attemptCount: number;
}
const compatibilityCollection = (planId: string) => decisionCollection('compatibility', planId);
const compatibilityBuildName = (planId: string, view: IntakeCollectionEnvelopeReader) =>
  'package.compatbuild.' + workflowHash([planId, view.logical]);
type Inventory = NonNullable<ReturnType<typeof readDurablePackageInventory>>;
function compatibility(
  db: Database,
  file: ReturnType<typeof source>,
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
) {
  const collections = selectedEnvelopeStore(db, file).collections;
  const planId = scalar<string>(view, record, 'id'),
    name = compatibilityCollection(planId);
  if (collections.get(collections.openView(), 'logical', name, 'complete') === planId)
    return { area: 'logical' as const, name };
  const nameForRoot = compatibilityBuildName(planId, view);
  if (collections.get(collections.openView(), 'builds', nameForRoot, 'complete') === planId)
    return { area: 'builds' as const, name: nameForRoot };
  return undefined;
}
function* records(
  view: IntakeCollectionEnvelopeReader,
  parent: IntakeEnvelopeRecord,
  field: string,
) {
  let after: string | undefined;
  do {
    const page = view.children(parent, field, { after, items: 32, bytes: 32768 });
    yield* page.records;
    if (page.complete) return;
    if (!page.after || page.after === after) throw Error('Legacy package cursor did not advance');
    after = page.after;
  } while (true);
}
function retainedCoverage(view: IntakeCollectionEnvelopeReader, record: IntakeEnvelopeRecord) {
  return {
    unitId: scalar<string>(view, record, 'unitId'),
    kind: scalar<IntakeExtractionCoverage['kind']>(view, record, 'kind'),
    notes: scalar<string>(view, record, 'notes', 32768),
  };
}
function compatibilityAdoptions(
  db: Database,
  file: ReturnType<typeof source>,
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
): IntakeCollectionChange[] {
  if (optional(view, record, 'format') === 'health-intake-package-plan-v2') return [];
  const selected = compatibility(db, file, view, record);
  if (!selected || selected.area === 'logical') return [];
  const planId = scalar<string>(view, record, 'id');
  return [
    {
      area: 'logical',
      collection: compatibilityCollection(planId),
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: selected.name,
    },
    ...(['units', 'attempts', 'accounted', 'readingSkipped', 'roles'] as const).map((kind) => ({
      area: 'logical' as const,
      collection: decisionCollection(kind, planId),
      op: 'adoptCollection' as const,
      fromArea: 'builds' as const,
      fromCollection: selected.name + '.' + kind,
    })),
  ];
}
async function prepareLegacyPlan(
  db: Database,
  file: ReturnType<typeof source>,
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  inventory: Inventory,
  assertCurrent: () => void,
) {
  if (
    optional(view, record, 'format') === 'health-intake-package-plan-v2' ||
    compatibility(db, file, view, record)
  )
    return;
  const plan = readPlan(view, record, inventory),
    name = compatibilityBuildName(plan.id, view);
  const writer = createEnvelopeBuildWriter(db, file, name, view.logical.domainVersion, {
    assertRunning: assertCurrent,
  });
  const maps = Object.fromEntries(
    ['units', 'attempts', 'accounted', 'readingSkipped', 'roles'].map((kind) => [
      kind,
      createEnvelopeBuildWriter(db, file, name + '.' + kind, view.logical.domainVersion, {
        assertRunning: assertCurrent,
      }),
    ]),
  ) as Record<
    'units' | 'attempts' | 'accounted' | 'readingSkipped' | 'roles',
    ReturnType<typeof createEnvelopeBuildWriter>
  >;
  for (const map of Object.values(maps)) {
    await map.put('initializing', '1');
    await map.remove('initializing');
  }
  const accounted = maps.accounted,
    skipped = maps.readingSkipped;
  async function* ids() {
    let ordinal = 0;
    for (const unit of records(view, record, 'units')) {
      const member = inventory.member(ordinal++);
      if (!member || scalar(view, unit, 'id') !== packageMemberUnit(member).id)
        throw Error('Legacy package unit recipe disagrees with retained inventory');
      for (const attempt of records(view, unit, 'attempts')) {
        let text = '';
        for (const chunk of view.recordChunks(attempt)) {
          text += chunk;
          if (Buffer.byteLength(text) > 8192)
            throw Error('Legacy attempt ID exceeds bounded header');
        }
        const batchId: unknown = JSON.parse(text);
        if (typeof batchId !== 'string') throw Error('Invalid legacy attempt ID');
        await maps.attempts.put(workflowHash([packageMemberUnit(member).id, batchId]), '1');
      }
      if (view.has(unit, 'processingException')) {
        const exception = view.child(unit, 'processingException');
        const value = exception
          ? { reason: scalar(view, exception, 'reason'), at: scalar(view, exception, 'at') }
          : optional<{ reason: string; at: string }>(view, unit, 'processingException');
        if (value) {
          if (value.reason !== 'processing_stalled' || typeof value.at !== 'string')
            throw Error('Invalid legacy processing exception');
          await skipped.put(String(member.ordinal).padStart(16, '0'), packageMemberUnit(member).id);
        }
      }
      yield scalar<string>(view, unit, 'id');
    }
  }
  const identity = await streamedExtractionPlanId(db, file.id, plan.pins, ids(), assertCurrent);
  if (identity.id !== plan.id)
    throw Error('Legacy package plan identity disagrees with retained units');
  // Retain only verified per-unit batch evidence; no aggregate attempts array.
  for (const batch of records(view, record, 'batches')) {
    const batchId = scalar<string>(view, batch, 'id');
    let ordinal = 0;
    for (const receipt of records(view, batch, 'coverage')) {
      assertCurrent();
      const coverage = retainedCoverage(view, receipt),
        unit = view.find('unit', record, coverage.unitId);
      const selected = unit && view.child(unit, 'coverage');
      if (
        unit &&
        selected &&
        view.contains(unit, 'attempts', batchId) &&
        JSON.stringify(retainedCoverage(view, selected)) === JSON.stringify(coverage)
      ) {
        await writer.put(
          'proof:' + coverage.unitId,
          JSON.stringify({ batchId, coverageOrdinal: ordinal }),
        );
        await maps.units.put(
          coverage.unitId,
          JSON.stringify({
            batchId,
            coverageOrdinal: ordinal,
            attemptCount: view.childCount(unit, 'attempts'),
          } satisfies UnitSelection),
        );
        const member = inventory.byUnit(coverage.unitId);
        if (member && ['extracted', 'context', 'unreadable'].includes(coverage.kind)) {
          await accounted.put(String(member.ordinal).padStart(16, '0'), coverage.unitId);
          await skipped.remove(String(member.ordinal).padStart(16, '0'));
        }
      }
      ordinal++;
    }
  }
  for (const role of records(view, record, 'packageRoles')) {
    assertCurrent();
    const key = 'role:' + scalar<string>(view, role, 'memberId');
    const hashKey = 'roleHash:' + scalar<string>(view, role, 'memberId');
    if (writer.peek(key) === undefined || writer.peek(hashKey) === undefined) {
      const canonical = await prepareIntakeJsonCanonical(view.recordChunks(role), {
        mode: 'stringify',
        assertRunning: assertCurrent,
        onWork: intakeJsonCanonicalWorkObserver(db, 'warm'),
      });
      const hash = createHash('sha256');
      try {
        for (const text of canonical.chunks()) hash.update(text);
      } finally {
        canonical.close();
      }
      withIntakeWork(db, 'warm', () => {
        recordIntakeWork('hashCalls');
        recordIntakeWork('hashedBytes', canonical.bytes);
      });
      await writer.put(hashKey, hash.digest('hex'));
      await writer.put(key, view.address(role));
    }
  }
  assertCurrent();
  await accounted.flush();
  await skipped.flush();
  for (const map of Object.values(maps)) await map.flush();
  await writer.put('complete', plan.id);
  await writer.flush();
  assertCurrent();
}

/** One-time source-bound compatibility work. It changes no logical/public version.
 * Call before synchronous native reads of a migrated inventory-v1 legacy plan. */
export async function preparePagedPackagePlanCompatibility(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  options: { assertRunning?: () => void } = {},
) {
  const file = source(db, profileId, id),
    collections = selectedEnvelopeStore(db, file).collections;
  const control = collections.get(
    collections.openView(),
    'logical',
    'envelope.control',
    'representation',
  );
  if (
    typeof control !== 'string' ||
    JSON.parse(control).format !== 'health-intake-record-envelope-v1'
  )
    await buildIntakeCollectionEnvelope(db, file, { assertRunning: options.assertRunning });
  const before = intakeSourceVersion(db, id);
  const assertCurrent = () => {
    options.assertRunning?.();
    assertIntakeOwner(db, profileId);
    const current = intakeSourceVersion(db, id);
    if (current.version !== before.version || current.logicalBinding !== before.logicalBinding)
      throw new HttpError(409, 'PLAN_CHANGED', 'This plan changed. Reload it before continuing.');
  };
  const view = openIntakeCollectionEnvelope(db, file),
    record = activeRecord(db, file, view);
  if (!record || optional(view, record, 'format') === 'health-intake-package-plan-v2') return;
  const { inventory } = await buildDurablePackageInventory({
    db,
    root,
    profileId,
    id,
    rawDomainVersion: before.rawVersion,
    assertRunning: assertCurrent,
  });
  await prepareLegacyPlan(db, file, view, record, inventory, assertCurrent);
}

export function readPackagePlanScope(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  options: { planId?: string; recordAddress?: string } = {},
) {
  return selectedPackagePlanScope(db, profileId, id, root, options.planId, options.recordAddress);
}

/** Pure selected metadata lookup. Cold preparation belongs at an async caller. */
export function readSelectedPackageRoleHash(
  db: Database,
  profileId: string,
  id: string,
  memberId: string,
): string | null {
  const file = source(db, profileId, id),
    view = openIntakeCollectionEnvelope(db, file),
    record = activeRecord(db, file, view);
  if (!record) return null;
  if (optional(view, record, 'format') !== 'health-intake-package-plan-v2') {
    try {
      return (
        readRetainedPlanScope(db, profileId, id, {
          recordAddress: view.address(record),
        })?.roleRecord(memberId)?.hash ?? null
      );
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'PLAN_PREPARATION_REQUIRED') throw error;
    }
  }
  return selectedPackagePlanScope(db, profileId, id)?.roleHash(memberId) ?? null;
}

function selectedPackagePlanScope(
  db: Database,
  profileId: string,
  id: string,
  root?: string,
  planId?: string,
  recordAddress?: string,
) {
  const file = source(db, profileId, id),
    version = intakeSourceVersion(db, id),
    view = openIntakeCollectionEnvelope(db, file),
    flow = workflow(view).workflow,
    record =
      recordAddress !== undefined
        ? view.resolve(recordAddress)
        : planId === undefined
          ? activeRecord(db, file, view)
          : flow && view.find('plan', flow, planId);
  if (!record) return undefined;
  if (record.kind !== 'plan' || (planId !== undefined && scalar(view, record, 'id') !== planId))
    throw Error('Selected package plan occurrence is invalid');
  if (recordAddress !== undefined) {
    const ordinal = intakeEnvelopeRecordOrder(view, record).at(-1),
      selected = flow && ordinal !== undefined && view.childAt(flow, 'plans', ordinal);
    if (!selected || view.address(selected) !== recordAddress)
      throw Error('Selected package plan does not belong to this workflow');
  }
  const context = { db, root, profileId, id, rawDomainVersion: version.rawVersion },
    inventory = readDurablePackageInventory(context);
  if (!inventory) throw Error('Selected plan inventory is unavailable');
  const plan = readPlan(view, record, inventory),
    state = selectedEnvelopeStore(db, file).collections;
  const legacy = optional(view, record, 'format') !== 'health-intake-package-plan-v2';
  const compatible = legacy ? compatibility(db, file, view, record) : undefined;
  if (legacy && !compatible)
    throw Error('Prepare legacy package plan compatibility before native reads');
  const compatibilityValue = (key: string) =>
    compatible && state.get(state.openView(), compatible.area, compatible.name, key);
  if (
    !inventory ||
    inventory.inventoryId !== plan.inventory.id ||
    inventory.binding.sourceHash !== plan.pins.sourceHash ||
    inventory.summary.members !== plan.unitCount
  )
    throw Error('Selected plan inventory is unavailable');
  const assertCurrent = () => {
    assertIntakeOwner(db, profileId);
    const current = intakeSourceVersion(db, id);
    if (current.logicalBinding !== version.logicalBinding || current.version !== version.version)
      throw new HttpError(409, 'PLAN_CHANGED', 'This plan changed. Reload it before continuing.');
  };
  const unit = (memberId: string): IntakePackageUnitSummary | undefined => {
    assertCurrent();
    const member = inventory.byId(memberId);
    if (!member) return undefined;
    const { attempts: _, ...initial } = packageMemberUnit(member),
      decision = inline<UnitSelection>(
        state.get(state.openView(), 'logical', decisionCollection('units', plan.id), initial.id),
      );
    const retained = legacy ? view.find('unit', record, initial.id) : undefined;
    if (legacy && !retained) throw Error('Legacy package unit is missing');
    const exceptionRecord = retained && view.child(retained, 'processingException');
    const exceptionIndex = selectedReadingStateIndex(state, view.address(record), 'exceptions');
    const selectedException = inline<IntakePackageUnitSummary['processingException']>(
      exceptionIndex
        ? decisionIndexGet(state, exceptionIndex, initial.id)
        : state.get(
            state.openView(),
            'logical',
            decisionCollection('exceptions', plan.id),
            initial.id,
          ),
    );
    if (
      selectedException &&
      (selectedException.reason !== 'processing_stalled' ||
        typeof selectedException.at !== 'string')
    )
      throw Error('Invalid selected processing exception');
    const exception = exceptionIndex
      ? selectedException
      : (selectedException ??
        (exceptionRecord
          ? {
              reason: scalar<'processing_stalled'>(view, exceptionRecord, 'reason'),
              at: scalar<string>(view, exceptionRecord, 'at'),
            }
          : retained
            ? optional<IntakePackageUnitSummary['processingException']>(
                view,
                retained,
                'processingException',
              )
            : undefined));
    if (!decision) {
      if (!legacy)
        return {
          ...initial,
          attemptCount: 0,
          ...(exception ? { processingException: exception } : {}),
        };
      const coverage = view.child(retained!, 'coverage');
      return {
        ...initial,
        status: scalar<IntakePackageUnitSummary['status']>(view, retained!, 'status'),
        attemptCount: view.childCount(retained!, 'attempts'),
        ...(coverage ? { coverage: retainedCoverage(view, coverage) } : {}),
        ...(exception ? { processingException: exception } : {}),
      };
    }
    if (
      !Number.isSafeInteger(decision.attemptCount) ||
      decision.attemptCount < 1 ||
      !Number.isSafeInteger(decision.coverageOrdinal) ||
      decision.coverageOrdinal < 0 ||
      state.get(
        state.openView(),
        'logical',
        decisionCollection('attempts', plan.id),
        workflowHash([initial.id, decision.batchId]),
      ) !== '1'
    )
      throw Error('Selected unit attempt is not retained');
    const batch = view.find('batch', record, decision.batchId),
      receipt = batch && view.childAt(batch, 'coverage', decision.coverageOrdinal);
    if (!receipt || scalar(view, receipt, 'unitId') !== initial.id)
      throw Error('Selected unit coverage disagrees with its batch receipt');
    const coverage: IntakeExtractionCoverage = {
      unitId: initial.id,
      kind: scalar(view, receipt, 'kind'),
      notes: scalar(view, receipt, 'notes', 32768),
    };
    if (!['inspected', 'extracted', 'context', 'unreadable'].includes(coverage.kind))
      throw Error('Invalid retained unit coverage');
    return {
      ...initial,
      status: coverage.kind === 'extracted' ? 'completed' : 'partial',
      coverage,
      attemptCount: decision.attemptCount,
      ...(exception ? { processingException: exception } : {}),
    };
  };
  const roleRecord = (memberId: string) => {
    assertCurrent();
    if (!inventory.byId(memberId)) return undefined;
    const selected = inline<RoleSelection>(
      state.get(state.openView(), 'logical', decisionCollection('roles', plan.id), memberId),
    );
    if (selected) {
      const history = view.find('packageRoleHistory', record, selected.historyId);
      const retained =
        history && Number.isSafeInteger(selected.ordinal) && selected.ordinal >= 0
          ? view.childAt(history, 'roles', selected.ordinal)
          : undefined;
      if (
        !retained ||
        scalar(view, retained, 'memberId') !== memberId ||
        view.childCount(retained, 'references') !== selected.referenceCount
      )
        throw Error('Package role selection disagrees with retained history');
      return { reader: view, record: retained };
    }
    const address = compatibilityValue('role:' + memberId);
    if (address === undefined) return undefined;
    if (typeof address !== 'string') throw Error('Invalid legacy package role pointer');
    const retained = view.resolve(address);
    if (retained.kind !== 'packageRole' || scalar(view, retained, 'memberId') !== memberId)
      throw Error('Legacy package role binding disagrees');
    return { reader: view, record: retained };
  };
  return {
    planId: plan.id,
    version: version.version,
    plan,
    inventory,
    compatibilityChanges() {
      assertCurrent();
      return compatibilityAdoptions(db, file, view, record);
    },
    decisionIndex(
      kind: 'units' | 'attempts' | 'accounted' | 'readingSkipped' | 'roles',
    ): IntakeDecisionIndex {
      assertCurrent();
      if (kind === 'readingSkipped') {
        const selected = selectedReadingStateIndex(state, view.address(record), kind);
        if (selected) return selected;
      }
      return compatible?.area === 'builds'
        ? { area: 'builds' as const, collection: compatible.name + '.' + kind }
        : { area: 'logical' as const, collection: decisionCollection(kind, plan.id) };
    },
    unit,
    roleRecord,
    roleHash(memberId: string): string | null {
      const retained = roleRecord(memberId);
      if (!retained) return null;
      const selected = inline<RoleSelection>(
        state.get(state.openView(), 'logical', decisionCollection('roles', plan.id), memberId),
      );
      const hash = selected ? selected.roleHash : compatibilityValue('roleHash:' + memberId);
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
        throw Error('Package role hash requires asynchronous preparation');
      return hash;
    },
    memberState(memberId: string) {
      const current = unit(memberId);
      if (!current) return undefined;
      const selected = inline<RoleSelection>(
        state.get(state.openView(), 'logical', decisionCollection('roles', plan.id), memberId),
      );
      let role: NonNullable<import('../shared/intake.ts').IntakePackageMember['role']> | null =
        null;
      const legacyRole = compatibilityValue('role:' + memberId);
      if (!selected && typeof legacyRole === 'string') {
        const retained = view.resolve(legacyRole);
        if (retained.kind !== 'packageRole' || scalar(view, retained, 'memberId') !== memberId)
          throw Error('Legacy package role binding disagrees');
        let missingReferenceCount = 0,
          ambiguousReferenceCount = 0;
        for (const reference of records(view, retained, 'references')) {
          const status = scalar(view, reference, 'status');
          if (status === 'not_supplied') missingReferenceCount++;
          if (status === 'ambiguous') ambiguousReferenceCount++;
        }
        role = {
          role: scalar(view, retained, 'role'),
          reason: scalar(view, retained, 'reason', 32768),
          coverage: scalar(view, retained, 'coverage'),
          referenceCount: view.childCount(retained, 'references'),
          missingReferenceCount,
          ambiguousReferenceCount,
        };
      }
      if (selected) {
        const history = view.find('packageRoleHistory', record, selected.historyId),
          roles = history && view.child(history, 'roles');
        if (!history || !roles || !Number.isSafeInteger(selected.ordinal) || selected.ordinal < 0)
          throw Error('Selected package role history is missing');
        const retained = view.childAt(history, 'roles', selected.ordinal);
        if (
          !retained ||
          scalar(view, retained, 'memberId') !== memberId ||
          view.childCount(retained, 'references') !== selected.referenceCount
        )
          throw Error('Package role selection disagrees with retained history');
        role = {
          role: scalar(view, retained, 'role'),
          reason: scalar(view, retained, 'reason', 32768),
          coverage: scalar(view, retained, 'coverage'),
          referenceCount: selected.referenceCount,
          missingReferenceCount: selected.missingReferenceCount,
          ambiguousReferenceCount: selected.ambiguousReferenceCount,
        };
      }
      return {
        unitId: current.id,
        status: current.status,
        coverage: current.coverage ?? null,
        role,
      };
    },
    unitById(unitId: string) {
      assertCurrent();
      const member = inventory.byUnit(unitId);
      return member && unit(member.memberId);
    },
    accountedKind(unitId: string) {
      assertCurrent();
      const member = inventory.byUnit(unitId),
        current = member && unit(member.memberId);
      if (!current) throw new HttpError(404, 'NOT_FOUND', 'Extraction unit not found');
      if (
        legacy &&
        state.get(state.openView(), 'logical', decisionCollection('units', plan.id), unitId) ===
          undefined
      ) {
        const proof = inline<{ batchId: string; coverageOrdinal: number }>(
          compatibilityValue('proof:' + unitId),
        );
        return accountedUnitKindInScope(current, (coverage) => {
          if (!proof) return false;
          const retained = view.find('unit', record, unitId),
            batch = view.find('batch', record, proof.batchId),
            receipt = batch && view.childAt(batch, 'coverage', proof.coverageOrdinal);
          return (
            !!retained &&
            view.contains(retained, 'attempts', proof.batchId) &&
            !!receipt &&
            JSON.stringify(retainedCoverage(view, receipt)) === JSON.stringify(coverage)
          );
        });
      }
      // unit() already checked exact unit->attempt->selected batch coverage.
      return accountedUnitKindInScope(current, () => true);
    },
  };
}

export async function savePagedPackageRoles(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  input: {
    version: number;
    operationId: string;
    planId: string;
    roles: IntakePackageRole[];
    assertRunning?: () => void;
  },
): Promise<IntakePackagePlanResult> {
  input.assertRunning?.();
  await preparePagedPackagePlanCompatibility(db, root, profileId, id, {
    assertRunning: input.assertRunning,
  });
  const { prepareRetainedPlanAccess } = await import('./intake-retained-plan.ts');
  await prepareRetainedPlanAccess(db, profileId, id, { assertRunning: input.assertRunning });
  const file = source(db, profileId, id),
    view = openIntakeCollectionEnvelope(db, file),
    before = intakeSourceVersion(db, id),
    flow = workflow(view),
    { version: _, assertRunning: _assertRunning, ...request } = input,
    fingerprint = workflowHash(request),
    collections = selectedEnvelopeStore(db, file).collections;
  if (
    typeof input.operationId !== 'string' ||
    !input.operationId.trim() ||
    input.operationId.length > 200
  )
    throw new HttpError(
      400,
      'OPERATION_ID',
      'Use a stable package role operation ID of at most 200 characters',
    );
  const key = workflowHash(input.operationId),
    prior = inline<{ fingerprint: string; planId: string }>(
      collections.get(collections.openView(), 'logical', 'package.commands', key),
    );
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'This operation already records a different request',
      );
    const plan = flow.workflow && view.find('plan', flow.workflow, prior.planId);
    if (!plan) throw Error('Retained package role command plan is missing');
    return {
      format: 'health-intake-package-plan-result-v2',
      intakeId: id,
      version: before.version,
      plan: readPlan(
        view,
        plan,
        readDurablePackageInventory({
          db,
          root,
          profileId,
          id,
          rawDomainVersion: before.rawVersion,
        }) ?? undefined,
      ),
      replayed: true,
    };
  }
  const oldOperation = flow.workflow && view.find('operation', flow.workflow, input.operationId);
  if (oldOperation) {
    if (scalar(view, oldOperation, 'fingerprint') !== fingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'This operation already records a different request',
      );
    const record = view.find('plan', flow.workflow!, input.planId);
    if (!record) throw Error('Retained legacy package role plan is missing');
    return {
      format: 'health-intake-package-plan-result-v2',
      intakeId: id,
      version: before.version,
      plan: readPlan(
        view,
        record,
        readDurablePackageInventory({
          db,
          root,
          profileId,
          id,
          rawDomainVersion: before.rawVersion,
        }) ?? undefined,
      ),
      replayed: true,
    };
  }
  if (input.version !== before.version)
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'This intake changed. Reload it before continuing.',
    );
  const scope = readPackagePlanScope(db, root, profileId, id);
  if (!scope || scope.planId !== input.planId)
    throw new HttpError(409, 'PLAN_CHANGED', 'Active extraction plan not found');
  const { validatePackageRolePlanPaged } = await import('./intake-package.ts');
  const roles = validatePackageRolePlanPaged(scope.inventory, input),
    planRecord = view.find('plan', flow.workflow!, scope.planId)!;
  const assertCurrent = () => {
    input.assertRunning?.();
    assertIntakeOwner(db, profileId);
    const current = intakeSourceVersion(db, id);
    if (current.version !== before.version || current.logicalBinding !== before.logicalBinding)
      throw new HttpError(
        409,
        'VERSION_CONFLICT',
        'This intake changed. Reload it before continuing.',
      );
  };
  assertCurrent();
  const at = new Date().toISOString(),
    operationId = randomUUID();
  const derived = await roleDerivedPreparation(
    db,
    root,
    profileId,
    id,
    file,
    scope.planId,
    view.address(planRecord),
    roles.map((x) => x.memberId),
    input.operationId,
    assertCurrent,
  );
  const prepared = await prepareIntakeEnvelopeMutation(db, file, {
    prepareDerived: derived.prepare,
    reader: view,
    changes: [
      {
        op: 'append',
        record: planRecord,
        field: 'packageRolesHistory',
        jsonText: JSON.stringify({ id: input.operationId, roles, at }),
      },
      {
        op: 'append',
        record: flow.workflow!,
        field: 'operations',
        jsonText: JSON.stringify({ id: input.operationId, fingerprint, at }),
      },
    ],
    additionalLogicalChanges: [
      ...scope.compatibilityChanges(),
      ...roles.map((role, ordinal) => ({
        area: 'logical' as const,
        collection: decisionCollection('roles', scope.planId),
        op: 'put' as const,
        key: role.memberId,
        value: JSON.stringify({
          historyId: input.operationId,
          ordinal,
          referenceCount: role.references.length,
          missingReferenceCount: role.references.filter((ref) => ref.status === 'not_supplied')
            .length,
          ambiguousReferenceCount: role.references.filter((ref) => ref.status === 'ambiguous')
            .length,
          roleHash: workflowHash(role, (text) =>
            withIntakeWork(db, 'warm', () => {
              recordIntakeWork('hashCalls');
              recordIntakeWork('hashedBytes', Buffer.byteLength(text));
            }),
          ),
        } satisfies RoleSelection),
      })),
      {
        area: 'logical',
        collection: 'package.commands',
        op: 'put',
        key,
        value: JSON.stringify({ fingerprint, planId: scope.planId }),
      },
    ],
    operationId,
    requestDigest: fingerprint,
    domainVersion: before.rawVersion + 1,
    assertRunning: assertCurrent,
  });
  assertCurrent();
  intakeTransaction(
    db,
    () => {
      assertCurrent();
      derived.assertCurrent();
      collections.stage(prepared.prepared!);
      invalidateCollectionReaderRoleDependencies(
        db,
        id,
        roles.map((role) => role.memberId),
      );
    },
    { operationId, fingerprint },
  );
  const after = intakeSourceVersion(db, id);
  observeIntakeLogicalVersion(
    db,
    id,
    { version: before.version, logicalBinding: before.logicalBinding! },
    { version: after.version, logicalBinding: after.logicalBinding! },
    'plan',
  );
  return {
    format: 'health-intake-package-plan-result-v2',
    intakeId: id,
    version: after.version,
    plan: scope.plan,
    replayed: false,
  };
}

export function readPackageUnitPage(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  options: {
    offset?: number;
    limit?: number;
    bytes?: number;
    inlineBytes?: number;
    planId?: string;
  } = {},
): IntakePackageUnitPage {
  const offset = options.offset ?? 0,
    limit = options.limit ?? 50,
    byteBudget = options.bytes ?? 40000,
    inlineBytes = options.inlineBytes ?? Math.min(32768, byteBudget);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !Number.isSafeInteger(byteBudget) ||
    byteBudget < 2048 ||
    byteBudget > 40000 ||
    !Number.isSafeInteger(inlineBytes) ||
    inlineBytes < 0 ||
    inlineBytes > Math.min(32768, byteBudget)
  )
    throw new HttpError(400, 'PACKAGE_WINDOW', 'Read 1–50 units at a nonnegative integer offset');
  const scope = readPackagePlanScope(db, root, profileId, id, { planId: options.planId });
  if (!scope) throw new HttpError(404, 'NOT_FOUND', 'Active extraction plan not found');
  const units: IntakePackageUnitPage['units'] = [];
  let bytes = 0;
  for (const member of scope.inventory.range({ offset, limit })) {
    const unit = scope.unit(member.memberId)!;
    const text = serializedUnit(db, unit);
    const item =
      text.length <= inlineBytes
        ? unit
        : {
            format: 'health-intake-package-unit-reference-v1' as const,
            id: unit.id,
            memberId: member.memberId,
            filenamePreview: member.filename.slice(0, 160),
            filenameTruncated: member.filename.length > 160,
            metadata: unitMetadataReference(db, scope, member, text),
          };
    const size = Buffer.byteLength(JSON.stringify(item));
    if (units.length && bytes + size > byteBudget) break;
    bytes += size;
    units.push(item);
  }
  const nextOffset = offset + units.length < scope.plan.unitCount ? offset + units.length : null;
  return {
    format: 'health-intake-package-unit-page-v1',
    intakeId: id,
    planId: scope.planId,
    version: scope.version,
    inventoryId: scope.inventory.inventoryId,
    units,
    total: scope.plan.unitCount,
    offset,
    nextOffset,
    pageComplete: nextOffset === null,
  };
}

function serializedUnit(db: Database, unit: IntakePackageUnitSummary): Buffer {
  const text = Buffer.from(JSON.stringify(unit));
  withIntakeWork(db, 'warm', () => {
    recordIntakeWork('serializationCalls');
    recordIntakeWork('serializedBytes', text.length);
  });
  return text;
}
function unitMetadataReference(
  db: Database,
  scope: NonNullable<ReturnType<typeof readPackagePlanScope>>,
  member: NonNullable<
    ReturnType<NonNullable<ReturnType<typeof readPackagePlanScope>>['inventory']['member']>
  >,
  text: Buffer,
): IntakeMetadataFragmentReference {
  const metadataHash = createHash('sha256').update(text).digest('hex');
  withIntakeWork(db, 'warm', () => {
    recordIntakeWork('hashCalls');
    recordIntakeWork('hashedBytes', text.length);
  });
  return {
    format: 'health-intake-metadata-reference-v1',
    kind: 'package_unit',
    planId: scope.planId,
    intakeId: scope.inventory.binding.intakeId,
    inventoryId: scope.inventory.inventoryId,
    memberId: member.memberId,
    ordinal: member.ordinal,
    sourceHash: scope.inventory.binding.sourceHash,
    version: scope.version,
    metadataHash,
    bytes: text.length,
  };
}

/** Exact byte-offset fragments are rederived from current selected authority.
 * References never authorize a filesystem path or an arbitrary archive offset. */
export function readPackageUnitMetadataFragment(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  reference: IntakeMetadataFragmentReference,
  { offset = 0, limit = 32768 }: { offset?: number; limit?: number } = {},
): IntakeMetadataFragment {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 4 ||
    limit > 32768
  )
    throw new HttpError(
      400,
      'PACKAGE_WINDOW',
      'Use a nonnegative byte offset and 4–32768 bytes per fragment',
    );
  const scope = readPackagePlanScope(db, root, profileId, id, { planId: reference?.planId }),
    member =
      scope && Number.isSafeInteger(reference?.ordinal)
        ? scope.inventory.member(reference.ordinal)
        : undefined;
  if (!scope || !member)
    throw new HttpError(
      409,
      'METADATA_CHANGED',
      'This file metadata changed. Reload the current page.',
    );
  const unit = scope.unit(member.memberId)!,
    text = serializedUnit(db, unit),
    expected = unitMetadataReference(db, scope, member, text);
  if (
    Object.keys(reference).length !== Object.keys(expected).length ||
    Object.entries(expected).some(
      ([key, value]) => reference[key as keyof typeof reference] !== value,
    )
  )
    throw new HttpError(
      409,
      'METADATA_CHANGED',
      'This file metadata changed. Reload the current page.',
    );
  if (offset > text.length || (offset < text.length && (text[offset]! & 0xc0) === 0x80))
    throw new HttpError(
      400,
      'PACKAGE_WINDOW',
      'Use the next byte offset returned by the previous fragment',
    );
  let end = Math.min(text.length, offset + limit);
  while (end < text.length && (text[end]! & 0xc0) === 0x80) end--;
  const complete = end === text.length;
  return {
    format: 'health-intake-metadata-fragment-v1',
    reference: expected,
    text: text.subarray(offset, end).toString('utf8'),
    offset,
    nextOffset: complete ? null : end,
    totalBytes: text.length,
    complete,
  };
}

/** Explicit native entry point until all public consumers have migrated. */
export async function createPagedPackagePlan(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  input: PackagePlanInput,
): Promise<IntakePackagePlanResult> {
  const file = source(db, profileId, id),
    { version: _, assertRunning: _assert, ...request } = input,
    fingerprint = workflowHash(request),
    externalId = input.operationId;
  if (
    externalId !== undefined &&
    (typeof externalId !== 'string' || !externalId.trim() || externalId.length > 200)
  )
    throw new HttpError(400, 'OPERATION_ID', 'Use a stable operation ID of at most 200 characters');
  // Preserve the legacy plan options' validation, although inventory units do
  // not divide members using these options.
  const count = input.unitSize ?? 25,
    overlap = input.overlap ?? Math.min(1, count - 1);
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 50 ||
    !Number.isSafeInteger(overlap) ||
    overlap < 0 ||
    overlap >= count
  )
    throw new HttpError(
      400,
      'PLAN_INPUT',
      'Choose a unit size of 1–50 and smaller nonnegative context overlap',
    );
  const initialVersion = intakeSourceVersion(db, id);
  const { collections } = selectedEnvelopeStore(db, file);
  const control =
    initialVersion.logicalBinding === undefined
      ? undefined
      : collections.get(collections.openView(), 'logical', 'envelope.control', 'representation');
  if (
    typeof control !== 'string' ||
    JSON.parse(control).format !== 'health-intake-record-envelope-v1'
  ) {
    if (input.version !== initialVersion.version)
      throw new HttpError(
        409,
        'VERSION_CONFLICT',
        'This intake changed. Reload it before continuing.',
      );
    await buildIntakeCollectionEnvelope(db, file, { assertRunning: input.assertRunning });
  }
  const view = openIntakeCollectionEnvelope(db, file),
    before = intakeSourceVersion(db, id),
    flow = workflow(view);
  const commandKey = externalId ? workflowHash(externalId) : undefined;
  const prior = commandKey
    ? inline<{ fingerprint: string; planId: string }>(
        collections.get(collections.openView(), 'logical', 'package.commands', commandKey),
      )
    : undefined;
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'This operation already records a different request',
      );
    const record = flow.workflow && view.find('plan', flow.workflow, prior.planId);
    if (!record) throw Error('Retained package command plan is missing');
    return {
      format: 'health-intake-package-plan-result-v2',
      intakeId: id,
      version: before.version,
      plan: readPlan(
        view,
        record,
        readDurablePackageInventory({
          db,
          root,
          profileId,
          id,
          rawDomainVersion: before.rawVersion,
        }) ?? undefined,
      ),
      replayed: true,
    };
  }
  const oldOperation =
    externalId && flow.workflow && view.find('operation', flow.workflow, externalId);
  if (oldOperation) {
    if (scalar(view, oldOperation, 'fingerprint') !== fingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'This operation already records a different request',
      );
    await preparePagedPackagePlanCompatibility(db, root, profileId, id, {
      assertRunning: input.assertRunning,
    });
    const current = activeRecord(db, file, view);
    if (!current) throw Error('Retained legacy operation has no active package plan');
    return {
      format: 'health-intake-package-plan-result-v2',
      intakeId: id,
      version: before.version,
      plan: readPlan(
        view,
        current,
        readDurablePackageInventory({
          db,
          root,
          profileId,
          id,
          rawDomainVersion: before.rawVersion,
        }) ?? undefined,
      ),
      replayed: true,
    };
  }
  if (!Number.isSafeInteger(input.version) || input.version !== before.version)
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'This intake changed. Reload it before continuing.',
    );
  const pins = extractionPins(db, file),
    pinsHash = workflowHash(pins),
    logical = before.logicalBinding;
  const assertCurrent = () => {
    input.assertRunning?.();
    assertIntakeOwner(db, profileId);
    const current = source(db, profileId, id),
      version = intakeSourceVersion(db, id);
    if (
      version.version !== before.version ||
      version.logicalBinding !== logical ||
      workflowHash(extractionPins(db, current)) !== pinsHash
    )
      throw new HttpError(
        409,
        'EXTRACTION_CONFIG_CHANGED',
        'Source or extraction settings changed. Reload before creating the plan.',
      );
  };
  const { inventory } = await buildDurablePackageInventory({
    db,
    root,
    profileId,
    id,
    rawDomainVersion: before.rawVersion,
    assertRunning: assertCurrent,
  });
  const current = activeRecord(db, file, view),
    currentId = current ? scalar<string>(view, current, 'id') : undefined;
  if (current) await prepareLegacyPlan(db, file, view, current, inventory, assertCurrent);
  const recipeKey = workflowHash([inventory.inventoryId, pins]),
    knownId = collections.get(collections.openView(), 'logical', 'package.recipes', recipeKey),
    known =
      typeof knownId === 'string' && flow.workflow
        ? view.find('plan', flow.workflow, knownId)
        : undefined;
  if (knownId !== undefined && !known) throw Error('Retained package recipe plan is missing');
  let plan: IntakePackagePlanV2;
  // A selected descriptor already proves this complete ordered unit recipe.
  // Repeating the same pins needs no second O(N) identity pass.
  if (
    current &&
    workflowHash(readPlan(view, current, inventory).pins) === pinsHash &&
    readPlan(view, current, inventory).inventory.id === inventory.inventoryId
  )
    plan = readPlan(view, current, inventory);
  else if (known) {
    plan = readPlan(view, known, inventory);
    if (workflowHash(plan.pins) !== pinsHash || plan.inventory.id !== inventory.inventoryId)
      throw Error('Retained package recipe binding disagrees');
  } else {
    function* ids() {
      for (let offset = 0; offset < inventory.summary.members; offset += 100)
        for (const member of inventory.range({ offset, limit: 100 }))
          yield packageMemberUnit(member).id;
    }
    const identity = await streamedExtractionPlanId(db, id, pins, ids(), assertCurrent);
    const retained = flow.workflow && view.find('plan', flow.workflow, identity.id);
    if (retained) {
      await prepareLegacyPlan(db, file, view, retained, inventory, assertCurrent);
      plan = readPlan(view, retained, inventory);
    } else {
      if (currentId && input.replacePlanId !== currentId)
        throw new HttpError(
          409,
          'PLAN_CHANGED',
          'Explicitly replace the prior extraction plan; completed work remains retained',
        );
      plan = {
        format: 'health-intake-package-plan-v2',
        id: identity.id,
        createdAt: new Date().toISOString(),
        status: 'active',
        pins,
        inventory: {
          id: inventory.inventoryId,
          sourceHash: inventory.binding.sourceHash,
          memberCount: inventory.summary.members,
          totalExpandedBytes: inventory.summary.expandedBytes,
          uniqueByteContents: inventory.uniqueByteContents,
        },
        unitRecipe: 'health-intake-package-member-unit-v1',
        unitCount: identity.unitCount,
      };
    }
  }
  assertCurrent();
  const retained = flow.workflow && view.find('plan', flow.workflow, plan.id);
  const selectionId = retained ? currentId : plan.id;
  if (!selectionId) throw Error('Retained package plan has no active selection');
  const at = new Date().toISOString(),
    operation = externalId ? { id: externalId, fingerprint, at } : undefined,
    changes: IntakeEnvelopeMutation[] = [];
  if (flow.workflow) {
    if (!retained) {
      if (current)
        changes.push({
          op: 'set',
          record: current,
          field: 'status',
          jsonText: JSON.stringify('superseded'),
        });
      changes.push({
        op: 'append',
        record: flow.workflow,
        field: 'plans',
        jsonText: JSON.stringify(plan),
      });
    }
    if (operation)
      changes.push({
        op: 'append',
        record: flow.workflow,
        field: 'operations',
        jsonText: JSON.stringify(operation),
      });
  } else
    changes.push({
      op: 'set',
      record: flow.intake,
      field: 'workflow',
      jsonText: JSON.stringify({
        format: 'health-intake-workflow-v1',
        plans: [plan],
        operations: operation ? [operation] : [],
      }),
    });
  const storageOperationId = randomUUID();
  const prepared = await prepareIntakeEnvelopeMutation(db, file, {
    reader: view,
    changes,
    additionalLogicalChanges: [
      ...(current ? compatibilityAdoptions(db, file, view, current) : []),
      ...(retained && plan.id !== currentId
        ? compatibilityAdoptions(db, file, view, retained)
        : []),
      { area: 'logical', collection: 'package.recipes', op: 'put', key: recipeKey, value: plan.id },
      {
        area: 'logical',
        collection: 'package.selection',
        op: 'put',
        key: 'active',
        value: selectionId,
      },
      ...(commandKey
        ? [
            {
              area: 'logical' as const,
              collection: 'package.commands',
              op: 'put' as const,
              key: commandKey,
              value: JSON.stringify({ fingerprint, planId: plan.id }),
            },
          ]
        : []),
    ],
    operationId: storageOperationId,
    requestDigest: fingerprint,
    domainVersion: before.rawVersion + 1,
    assertRunning: assertCurrent,
    prepareDerived: async (derived) => {
      const stagedFlow = workflow(derived.reader),
        addresses: string[] = [];
      if (!retained) {
        if (current) addresses.push(view.address(current));
        const appended = derived.reader.childAt(
          stagedFlow.workflow!,
          'plans',
          flow.workflow ? view.childCount(flow.workflow, 'plans') : 0,
        );
        if (!appended) throw Error('New package reader plan is missing');
        addresses.push(derived.reader.address(appended));
      }
      return recordCollectionReaderCoverageTransition(db, file, derived, {
        planAddresses: addresses,
      });
    },
  });
  assertCurrent();
  intakeTransaction(
    db,
    () => {
      assertCurrent();
      collections.stage(prepared.prepared!);
    },
    { operationId: storageOperationId, fingerprint },
  );
  const after = intakeSourceVersion(db, id);
  observeIntakeLogicalVersion(
    db,
    id,
    { version: before.version, logicalBinding: before.logicalBinding! },
    { version: after.version, logicalBinding: after.logicalBinding! },
    'plan',
  );
  return {
    format: 'health-intake-package-plan-result-v2',
    intakeId: id,
    version: after.version,
    plan,
    replayed: false,
  };
}

/** Host dispatch preserves retained expanded units and the legacy role merge.
 * Preparation is explicit; publication remains one ordinary transaction. */
export async function saveIntakePackageRolesRead(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  input: Parameters<typeof savePagedPackageRoles>[4],
) {
  const { prepareRetainedPlanAccess, readRetainedPlanScope } =
    await import('./intake-retained-plan.ts');
  await prepareRetainedPlanAccess(db, profileId, id, { assertRunning: input.assertRunning });
  const file = source(db, profileId, id),
    view = openIntakeCollectionEnvelope(db, file),
    flow = workflow(view),
    before = intakeSourceVersion(db, id);
  const { getIntakeRead, flushIntake } = await import('./intake.ts');
  const finish = () => ({
    ...getIntakeRead(db, root, profileId, id),
    durability: flushIntake(db, root, profileId),
  });
  const { version: _version, assertRunning: _assertRunning, ...request } = input,
    fingerprint = workflowHash(request);
  if (
    typeof input.operationId !== 'string' ||
    !input.operationId.trim() ||
    input.operationId.length > 200
  )
    throw new HttpError(
      400,
      'OPERATION_ID',
      'Use a stable package role operation ID of at most 200 characters',
    );
  const previous = flow.workflow && view.find('operation', flow.workflow, input.operationId);
  if (previous) {
    if (scalar(view, previous, 'fingerprint') !== fingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'This operation already records a different request',
      );
    return finish();
  }
  const scope = readRetainedPlanScope(db, profileId, id, {
    planId: input.planId,
    activeOnly: true,
  });
  if (!scope) {
    await savePagedPackageRoles(db, root, profileId, id, input);
    return finish();
  }
  if (before.version !== input.version)
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'This intake changed. Reload it before continuing.',
    );
  const { validatePackageRolesInScope } = await import('./intake-package.ts');
  const roles = validatePackageRolesInScope(
    {
      inventoried:
        !!scope.indexRecord && optional(scope.reader, scope.indexRecord, 'inventoryVersion') === 1,
      byId: scope.memberById,
      byExactName: scope.membersByExactName,
    },
    input,
  );
  const assertCurrent = () => {
    input.assertRunning?.();
    scope.assertCurrent();
  };
  assertCurrent();
  const operationId = randomUUID(),
    at = new Date().toISOString();
  const derived = await roleDerivedPreparation(
    db,
    root,
    profileId,
    id,
    file,
    scope.planId,
    scope.reader.address(scope.record),
    roles.map((x) => x.memberId),
    input.operationId,
    assertCurrent,
  );
  const prepared = await prepareIntakeEnvelopeMutation(db, file, {
    reader: view,
    operationId,
    requestDigest: fingerprint,
    domainVersion: before.rawVersion + 1,
    assertRunning: assertCurrent,
    changes: [
      {
        op: 'append',
        record: view.resolve(scope.reader.address(scope.record)),
        field: 'packageRolesHistory',
        jsonText: JSON.stringify({ id: input.operationId, roles, at }),
      },
      {
        op: 'append',
        record: flow.workflow!,
        field: 'operations',
        jsonText: JSON.stringify({ id: input.operationId, fingerprint, at }),
      },
    ],
    additionalLogicalChanges: [
      ...scope.roleMergeChanges(),
      ...roles.map((role, ordinal) => ({
        area: 'logical' as const,
        collection: scope.decisionCollection('roles'),
        op: 'put' as const,
        key: role.memberId,
        value: JSON.stringify({
          historyId: input.operationId,
          ordinal,
          referenceCount: role.references.length,
          missingReferenceCount: role.references.filter((x) => x.status === 'not_supplied').length,
          ambiguousReferenceCount: role.references.filter((x) => x.status === 'ambiguous').length,
          roleHash: workflowHash(role),
        }),
      })),
    ],
    prepareDerived: derived.prepare,
  });
  assertCurrent();
  intakeTransaction(
    db,
    () => {
      assertCurrent();
      derived.assertCurrent();
      selectedEnvelopeStore(db, file).collections.stage(prepared.prepared!);
      invalidateCollectionReaderRoleDependencies(
        db,
        id,
        roles.map((role) => role.memberId),
      );
    },
    { operationId, fingerprint },
  );
  const after = intakeSourceVersion(db, id);
  observeIntakeLogicalVersion(
    db,
    id,
    { version: before.version, logicalBinding: before.logicalBinding! },
    { version: after.version, logicalBinding: after.logicalBinding! },
    'plan',
  );
  return finish();
}

async function roleDerivedPreparation(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  file: ReturnType<typeof source>,
  planId: string,
  planAddress: string,
  memberIds: string[],
  historyId: string,
  assertCurrent: () => void,
) {
  const { prepareRetainedPlanDerived } = await import('./intake-retained-plan.ts'),
    { prepareSourceContextClassificationDerived } =
      await import('./intake-source-context-state.ts'),
    { prepareWorkflowCommandDerived } = await import('./intake-workflow-update.ts'),
    { activeMappingRules } = await import('./clinical-import.ts');
  const view = openIntakeCollectionEnvelope(db, file),
    intake = workflow(view).intake,
    metadata = intake && view.child(intake, 'metadata');
  const provider = metadata
    ? (optional<string>(view, metadata, 'sourceProviderId') ?? file.provider_id)
    : file.provider_id;
  const mappingVersion = () => workflowHash(activeMappingRules(db, provider)),
    selectedMapping = mappingVersion();
  let check: (() => void) | undefined;
  return {
    assertCurrent() {
      assertCurrent();
      check?.();
    },
    async prepare(
      derived: import('./intake-envelope-mutation.ts').IntakeEnvelopeDerivedPreparation,
    ) {
      const plans = await prepareRetainedPlanDerived(db, profileId, id, {
          ...derived,
          impact: { kind: 'package-roles', planId, planAddress, historyId, memberIds },
        }),
        affected = {
          candidateChanges: [],
          questionAddresses: [],
          reportGroupAddresses: [],
          proposalIds: [],
        };
      const classifier = await prepareSourceContextClassificationDerived(db, root, profileId, id, {
        ...derived,
        affected,
        impact: 'metadata',
        assertRunning: assertCurrent,
      });
      if (classifier.state !== 'ready') return plans;
      check = classifier.assertPublicationCurrent;
      const changes = await prepareWorkflowCommandDerived(db, file, {
        ...derived,
        affected,
        impact: 'metadata',
        mappingVersion: selectedMapping,
        currentMappingVersion: mappingVersion,
        isSourceContextVersion: classifier.isSourceContextVersion,
        assertRunning: () => {
          assertCurrent();
          classifier.assertCurrent();
        },
      });
      return [...plans, ...classifier.changes, ...changes];
    },
  };
}
