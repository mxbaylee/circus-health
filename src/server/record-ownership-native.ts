import { currentClinicalOperation, runExclusiveClinicalOperation } from './clinical-operation.ts';
import { type OwnershipBlockerStore } from './ownership-blocker-store.ts';
import type { OwnershipBlockerReference } from '../shared/ownership-report-reference.ts';
import { ownershipBlockerCount } from './ownership-preview-store.ts';
import {
  prepareOwnershipReportPlan,
  type PreparedOwnershipReportPlan,
} from './ownership-report-plan.ts';
import type { OwnershipReportPreviewReference } from '../shared/ownership-report-reference.ts';
import { ownershipReceiptReference } from './ownership-outcome-page.ts';
import type { Database } from './database.ts';
import { HttpError } from './database.ts';
import { hasIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
import { ownershipRequest, object, text, invalid } from './record-ownership-input.ts';
import { previewRecordOwnership, prepareRecordOwnershipPlannedUnit } from './record-ownership.ts';
import { type PreparedOwnershipNamePlan } from './ownership-name-plan.ts';
import { childOwnershipOperation, ownershipPlans } from './ownership-groups.ts';
import { ownershipHash } from './ownership-journal.ts';
import {
  authenticateRecordTransactionPreparation,
  captureRecordPublicationOriginals,
  closeRecordPublicationOriginals,
  commitRecordTransactionPreparation,
  discardRecordTransactionPreparation,
  prepareRecordTransactionWithOriginals,
  stageRecordTransactionPreparation,
  type RecordPublicationOriginals,
  type RecordTransactionPreparation,
} from './record-versions.ts';
import { captureOwnershipReportOriginalProof } from './ownership-report-plan.ts';
import type {
  OwnershipCommit,
  OwnershipPreview,
  OwnershipReceipt,
} from '../shared/record-ownership.ts';
import type { OwnershipPreviewReference } from '../shared/ownership-name-reference.ts';

const selectedPlans = new WeakMap<
  Database,
  {
    plan: PreparedOwnershipNamePlan;
    scopeToken: string;
    profileId: string;
    report?: PreparedOwnershipReportPlan;
    blockers?: OwnershipBlockerStore;
  }
>();
const preparingPlans = new WeakSet<Database>();
const committingPlans = new WeakSet<Database>();
const planEpochs = new WeakMap<Database, number>();
const planAssertions = new WeakMap<() => void, { db: Database; epoch: number }>();
const readContinuations = new WeakMap<Function, Database>();
export function ownershipReadContinuationCurrent(work: Function, db: Database): boolean {
  return readContinuations.get(work) === db && db.isOpen;
}
function runNativeOwnershipOperation<T>(
  db: Database,
  work: Parameters<typeof runExclusiveClinicalOperation<T>>[1],
  options: Parameters<typeof runExclusiveClinicalOperation<T>>[2],
) {
  readContinuations.set(work, db);
  return runExclusiveClinicalOperation(db, work, options);
}
export function ownershipPlanAssertionKnown(assertion: () => void, db: Database): boolean {
  return planAssertions.get(assertion)?.db === db;
}
/** Only the exact retained-plan issuer qualifies; this is liveness, not evidence. */
export function ownershipPlanAssertionCurrent(assertion: () => void, db: Database): boolean {
  const original = planAssertions.get(assertion);
  return (
    !!original && original.db === db && db.isOpen && (planEpochs.get(db) ?? 0) === original.epoch
  );
}
export function clearNativeOwnershipPlans(db: Database) {
  planEpochs.set(db, (planEpochs.get(db) ?? 0) + 1);
  const selected = selectedPlans.get(db);
  if (selected?.report) selected.report.close();
  else selected?.plan.close();
  selectedPlans.delete(db);
}
export function usesNativeOwnershipEvidence(db: Database) {
  for (const row of db
    .prepare("SELECT id,kind,sha256,details_json FROM source_files WHERE kind='intake_original'")
    .iterate())
    if (hasIntakeCollectionEnvelope(db, row as { id: string })) return true;
  return false;
}
async function referencePreview(
  preview: OwnershipPreview,
  plan: PreparedOwnershipNamePlan,
  report?: PreparedOwnershipReportPlan,
): Promise<OwnershipPreviewReference | OwnershipReportPreviewReference> {
  if (report) return report.withVerifiedRead(() => report.publicPreview());
  const { names, ...header } = preview;
  const selected = preview as OwnershipPreview & { blockerEvidence?: OwnershipBlockerReference };
  const publicRecords = preview.records.map((record) => {
    const { blockerEvidence, ...row } = record as typeof record & {
      blockerEvidence?: OwnershipBlockerReference;
    };
    return { ...row, blockers: blockerEvidence ?? row.blockers };
  });
  void names;
  return {
    ...header,
    blockers: selected.blockerEvidence?.count ? selected.blockerEvidence : header.blockers,
    records: publicRecords,
    namesIncluded: false,
    nameEvidence: plan.reference,
  };
}
async function prepare(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
  options: {
    onCheckpoint?: (stage: string) => void;
    approvedRelationshipDecisions?: () => Iterable<
      NonNullable<
        import('../shared/record-ownership.ts').OwnershipRequest['relationshipDecisions']
      >[number]
    >;
  } = {},
) {
  const epoch = planEpochs.get(db) ?? 0;
  const selectedRequest = ownershipRequest(input);
  const assertRunning = () => {
    if ((planEpochs.get(db) ?? 0) !== epoch)
      throw new HttpError(
        401,
        'PROFILE_LOCKED',
        'Unlock this profile and prepare the current ownership evidence',
      );
  };
  planAssertions.set(assertRunning, { db, epoch });
  const report = await prepareOwnershipReportPlan(db, root, profileId, selectedRequest, {
    ...options,
    assertRunning,
  });
  try {
    return {
      preview: await report.finalizeVerified(),
      plan: report.plan,
      report,
      blockers: undefined as OwnershipBlockerStore | undefined,
    };
  } catch (error) {
    report.close();
    throw error;
  }
}
export async function previewNativeRecordOwnership(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
  options: { onCheckpoint?: (stage: string) => void } = {},
) {
  return runNativeOwnershipOperation(
    db,
    async () => {
      if (preparingPlans.has(db) || committingPlans.has(db))
        throw new HttpError(
          409,
          'OWNERSHIP_PREPARING',
          'The selected ownership evidence is still being prepared',
        );
      preparingPlans.add(db);
      let prepared: Awaited<ReturnType<typeof prepare>> | undefined;
      try {
        prepared = await prepare(db, root, profileId, input, options);
        const previous = selectedPlans.get(db);
        if (
          previous &&
          previous.profileId === profileId &&
          ownershipHash(previous.plan.request.selection) ===
            ownershipHash(prepared.plan.request.selection) &&
          ownershipHash(previous.plan.request.destination) ===
            ownershipHash(prepared.plan.request.destination)
        ) {
          let currentPrevious = false;
          try {
            if (previous.report)
              await previous.report.withVerifiedRead(() => previous.plan.assertCurrent());
            else previous.plan.assertCurrent();
            currentPrevious = true;
          } catch {
            /* Stale previous authority supplies no decisions. */
          }
          if (currentPrevious) {
            try {
              for (const choice of previous.plan.choices())
                if (prepared.plan.has(choice.key)) prepared.plan.choose(choice.key, choice.outcome);
              if (previous.report && prepared.report)
                for (const choice of previous.report.choices())
                  await prepared.report.choose(choice);
            } catch (error) {
              if (prepared.report) prepared.report.close();
              else prepared.plan.close();
              throw error;
            }
          }
          prepared.preview = prepared.report
            ? await prepared.report.finalizeVerified()
            : previewRecordOwnership(db, root, profileId, prepared.plan.request, {
                namePlan: prepared.plan,
                blockerStore: prepared.blockers,
              });
        }
        if (previous?.report) previous.report.close();
        else previous?.plan.close();
        selectedPlans.set(db, { ...prepared, scopeToken: prepared.preview.scopeToken, profileId });
        return await referencePreview(prepared.preview, prepared.plan, prepared.report);
      } catch (error) {
        prepared?.report.close();
        if (prepared && selectedPlans.get(db)?.report === prepared.report) selectedPlans.delete(db);
        throw error;
      } finally {
        preparingPlans.delete(db);
      }
    },
    { operation: currentClinicalOperation(db) },
  );
}
export async function chooseNativeOwnershipName(
  db: Database,
  root: string,
  profileId: string,
  token: string,
  key: string,
  outcome: import('../shared/record-ownership.ts').OwnershipNameEffect['decision'],
) {
  return runNativeOwnershipOperation(
    db,
    async () => {
      const plan = nativeOwnershipNamePlan(db, profileId, token),
        report = selectedPlans.get(db)?.report,
        blockers = selectedPlans.get(db)?.blockers;
      preparingPlans.add(db);
      try {
        const finalize = () => {
          plan.choose(key, outcome);
          return report
            ? report.finalize()
            : previewRecordOwnership(db, root, profileId, plan.request, {
                namePlan: plan,
                blockerStore: blockers,
              });
        };
        const preview = report ? await report.withVerifiedPublication(finalize) : finalize();
        selectedPlans.set(db, {
          plan,
          report,
          blockers,
          scopeToken: preview.scopeToken,
          profileId,
        });
        return await referencePreview(preview, plan, report);
      } finally {
        preparingPlans.delete(db);
      }
    },
    { operation: currentClinicalOperation(db) },
  );
}
function selectedOwnershipNamePlan(db: Database, profileId: string, token: string) {
  if (committingPlans.has(db) || preparingPlans.has(db))
    throw new HttpError(409, 'OWNERSHIP_COMMITTING', 'The approved correction is being saved');
  const selected = selectedPlans.get(db);
  if (!selected || selected.profileId !== profileId || selected.plan.reference.token !== token)
    throw new HttpError(
      409,
      'OWNERSHIP_CHANGED',
      'Prepare the current ownership evidence before viewing it',
    );
  return selected.plan;
}
export function nativeOwnershipNamePlan(db: Database, profileId: string, token: string) {
  const plan = selectedOwnershipNamePlan(db, profileId, token);
  plan.assertCurrent();
  return plan;
}
export async function withNativeOwnershipNamePlan<T>(
  db: Database,
  profileId: string,
  token: string,
  complete: (plan: PreparedOwnershipNamePlan) => T,
  options: { signal?: AbortSignal } = {},
) {
  return runNativeOwnershipOperation(
    db,
    async () => {
      const plan = selectedOwnershipNamePlan(db, profileId, token),
        report = selectedPlans.get(db)?.report;
      return report ? report.withVerifiedRead(() => complete(plan)) : complete(plan);
    },
    { operation: currentClinicalOperation(db), signal: options.signal },
  );
}
export async function commitNativeRecordOwnership(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
) {
  return runNativeOwnershipOperation(
    db,
    async () => {
      if (committingPlans.has(db) || preparingPlans.has(db))
        throw new HttpError(
          409,
          'OWNERSHIP_PREPARING',
          'The selected correction is already being prepared or saved',
        );
      committingPlans.add(db);
      try {
        return await commitNativeOwnershipOwned(db, root, profileId, input);
      } finally {
        committingPlans.delete(db);
      }
    },
    { operation: currentClinicalOperation(db) },
  );
}
const approvedOwnershipChildren = new WeakMap<
  object,
  {
    parent: PreparedOwnershipReportPlan;
    originals: RecordPublicationOriginals;
    parentScope: string;
    group: string;
    operationId: string;
    selection: string;
    destination: string;
    relationships: string;
    names: string;
  }
>();
function approveOwnershipChild(
  parent: PreparedOwnershipReportPlan,
  originals: RecordPublicationOriginals,
  parentScope: string,
  group: OwnershipPreview['commitGroups'][number],
  operationId: string,
  childRequest: ReturnType<PreparedOwnershipReportPlan['requestForGroup']>,
  relationships: readonly { decisionId: string; action: 'withdraw' }[],
  names: readonly { key: string; outcome: string }[],
) {
  const capability = Object.freeze({});
  approvedOwnershipChildren.set(capability, {
    parent,
    originals,
    parentScope,
    group: ownershipHash(group),
    operationId,
    selection: ownershipHash(childRequest.selection),
    destination: ownershipHash(childRequest.destination),
    relationships: ownershipHash(
      [...relationships].sort((a, b) => a.decisionId.localeCompare(b.decisionId)),
    ),
    names: ownershipHash(names),
  });
  return capability;
}
function consumeApprovedOwnershipChild(
  capability: object,
  parent: PreparedOwnershipReportPlan,
  originals: RecordPublicationOriginals,
  parentScope: string,
  group: OwnershipPreview['commitGroups'][number],
  operationId: string,
  child: PreparedOwnershipReportPlan,
  current: OwnershipPreview,
  relationships: readonly { decisionId: string; action: 'withdraw' }[],
  approvedNames: readonly { key: string; outcome: string }[],
) {
  const grant = approvedOwnershipChildren.get(capability);
  approvedOwnershipChildren.delete(capability);
  const actualNames = [...child.plan.choices()].sort((a, b) => a.key.localeCompare(b.key));
  const expectedNames = approvedNames
    .filter((choice) => child.plan.has(choice.key))
    .sort((a, b) => a.key.localeCompare(b.key));
  const actualRelationships = [...child.choices()]
    .filter(
      (choice): choice is { relationshipId: string; withdraw: true } => 'relationshipId' in choice,
    )
    .map((choice) => ({ decisionId: choice.relationshipId, action: 'withdraw' as const }))
    .sort((a, b) => a.decisionId.localeCompare(b.decisionId));
  if (
    !grant ||
    grant.parent !== parent ||
    grant.originals !== originals ||
    grant.parentScope !== parentScope ||
    grant.group !== ownershipHash(group) ||
    grant.operationId !== operationId ||
    grant.selection !== ownershipHash(current.request.selection) ||
    grant.destination !== ownershipHash(current.request.destination) ||
    grant.relationships !==
      ownershipHash([...relationships].sort((a, b) => a.decisionId.localeCompare(b.decisionId))) ||
    grant.relationships !== ownershipHash(actualRelationships) ||
    grant.names !== ownershipHash(approvedNames) ||
    ownershipHash(expectedNames) !== ownershipHash(actualNames)
  )
    throw new HttpError(409, 'OWNERSHIP_CHANGED', 'The approved group changed before saving');
}
async function publishPreparedOwnershipUnit(
  db: Database,
  root: string,
  profileId: string,
  input: OwnershipCommit,
  namePlan: PreparedOwnershipNamePlan,
  report: PreparedOwnershipReportPlan,
  originals: RecordPublicationOriginals,
  parent?: { operationId: string; fingerprint: string; groups: OwnershipPreview['commitGroups'] },
): Promise<{
  receipt: OwnershipReceipt;
  destination?: { noteId: string; expectedVersion: number };
}> {
  const intent = prepareRecordOwnershipPlannedUnit(
    db,
    root,
    profileId,
    input,
    parent,
    namePlan,
    report,
  );
  if ('replayed' in intent) return { receipt: intent.replayed };
  let preparation: RecordTransactionPreparation | undefined;
  try {
    preparation = await prepareRecordTransactionWithOriginals(
      db,
      () => {
        const committed = intent.run();
        const destination = db
          .prepare("SELECT id,version FROM notes WHERE kind='person' AND person_id=?")
          .get(committed.destinationPersonId);
        if (!destination) throw Error('Accepted ownership destination has no People entry');
        return {
          committed,
          destination: {
            noteId: String(destination.id),
            expectedVersion: Number(destination.version),
          },
        };
      },
      intent.operation,
      originals,
    );
    await authenticateRecordTransactionPreparation(db, preparation);
    await stageRecordTransactionPreparation(db, preparation);
    const accepted = await commitRecordTransactionPreparation<{
      committed: ReturnType<typeof intent.run>;
      destination: { noteId: string; expectedVersion: number };
    }>(db, preparation);
    return { receipt: intent.finish(accepted.committed), destination: accepted.destination };
  } finally {
    if (preparation) discardRecordTransactionPreparation(db, preparation);
  }
}

async function commitNativeOwnershipOwned(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
) {
  if (
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !== profileId
  )
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'Ownership correction belongs to another profile');
  if (
    !object(input) ||
    Object.keys(input).some(
      (k) => !['operationId', 'request', 'scopeToken', 'version'].includes(k),
    ) ||
    typeof input.operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      input.operationId,
    ) ||
    !Number.isSafeInteger(input.version) ||
    !text(input.scopeToken)
  )
    return invalid('Commit the displayed preview with a stable operation ID');
  const supplied = input as unknown as OwnershipCommit;
  const selected = selectedPlans.get(db);
  if (!selected || selected.profileId !== profileId || selected.scopeToken !== supplied.scopeToken)
    throw new HttpError(
      409,
      'OWNERSHIP_CHANGED',
      'Review the current ownership evidence before saving',
    );
  selected.plan.assertCurrent();
  const request = ownershipRequest(supplied.request);
  const report = selected.report;
  if (!report) throw Error('Native ownership requires its complete selected plan');
  if (ownershipHash(request) !== ownershipHash(selected.plan.request))
    throw new HttpError(409, 'OWNERSHIP_CHANGED', 'Review the selected correction before saving');
  const preview = await report.finalizeVerified();
  if (preview.scopeToken !== supplied.scopeToken || preview.version !== supplied.version)
    throw new HttpError(
      409,
      'OWNERSHIP_CHANGED',
      'Review the current ownership evidence before saving',
    );
  if (ownershipBlockerCount(preview) || report.reference.recordBlockerTotal)
    throw new HttpError(409, 'OWNERSHIP_REVIEW', 'Resolve every displayed decision before saving');
  const published = () => {
    const receipt = ownershipReceiptReference(db, profileId, supplied.operationId);
    if (!receipt) throw Error('Accepted correction is missing its durable outcome reference');
    return { ...receipt, replayed: false };
  };
  const original = captureOwnershipReportOriginalProof(report, db, profileId);
  const originals = await captureRecordPublicationOriginals(db, profileId, original);
  try {
    if (preview.commitGroups.length <= 1) {
      await report.prepareSourceSnapshots(originals);
      await publishPreparedOwnershipUnit(
        db,
        root,
        profileId,
        supplied,
        selected.plan,
        report,
        originals,
      );
      return published();
    }
    const fingerprint = ownershipHash({ ...supplied, request }),
      approvedChoices = [...selected.plan.approvedChoices()()];
    let destination = request.destination;
    for (const group of preview.commitGroups) {
      let child: PreparedOwnershipReportPlan | undefined;
      try {
        const childOperationId = childOwnershipOperation(supplied.operationId, group.id),
          relationshipChoices = [...report.relationshipChoicesForGroup(group)],
          childRequest = { ...report.requestForGroup(group), destination },
          approvedChild = approveOwnershipChild(
            report,
            originals,
            preview.scopeToken,
            group,
            childOperationId,
            childRequest,
            relationshipChoices,
            approvedChoices,
          );
        const prepared = await prepare(db, root, profileId, childRequest, {
          approvedRelationshipDecisions: () => relationshipChoices,
        });
        child = prepared.report;
        const childPlan = child;
        for (const choice of approvedChoices)
          if (child.plan.has(choice.key)) child.plan.choose(choice.key, choice.outcome);
        const current = await child.finalizeVerified();
        consumeApprovedOwnershipChild(
          approvedChild,
          report,
          originals,
          preview.scopeToken,
          group,
          childOperationId,
          child,
          current,
          relationshipChoices,
          approvedChoices,
        );
        await child.prepareSourceSnapshots(originals);
        const accepted = await publishPreparedOwnershipUnit(
          db,
          root,
          profileId,
          {
            operationId: childOperationId,
            request: current.request,
            scopeToken: current.scopeToken,
            version: current.version,
          },
          childPlan.plan,
          childPlan,
          originals,
          { operationId: supplied.operationId, fingerprint, groups: preview.commitGroups },
        );
        if (!accepted.destination) throw Error('Accepted group destination version unavailable');
        destination = accepted.destination;
      } catch (error) {
        if (!ownershipPlans(db, supplied.operationId).length) throw error;
        return published();
      } finally {
        child?.close();
      }
    }
    return published();
  } finally {
    closeRecordPublicationOriginals(originals);
  }
}

function selectedOwnershipReportPlan(db: Database, profileId: string, token: string) {
  if (committingPlans.has(db) || preparingPlans.has(db))
    throw new HttpError(409, 'OWNERSHIP_COMMITTING', 'The report correction is being saved');
  const selected = selectedPlans.get(db);
  if (
    !selected?.report ||
    selected.profileId !== profileId ||
    selected.report.reference.token !== token
  )
    throw new HttpError(
      409,
      'OWNERSHIP_CHANGED',
      'Prepare current report evidence before viewing it',
    );
  return selected.report;
}
export function nativeOwnershipReportPlan(db: Database, profileId: string, token: string) {
  const report = selectedOwnershipReportPlan(db, profileId, token);
  report.assertCurrent();
  return report;
}
export async function withNativeOwnershipReportPlan<T>(
  db: Database,
  profileId: string,
  token: string,
  complete: (plan: PreparedOwnershipReportPlan) => T,
  options: { signal?: AbortSignal } = {},
) {
  return runNativeOwnershipOperation(
    db,
    async () => {
      const report = selectedOwnershipReportPlan(db, profileId, token);
      return report.withVerifiedRead(() => complete(report));
    },
    { operation: currentClinicalOperation(db), signal: options.signal },
  );
}
export async function chooseNativeOwnershipReport(
  db: Database,
  profileId: string,
  token: string,
  input: unknown,
) {
  return runNativeOwnershipOperation(
    db,
    async () => {
      const report = selectedOwnershipReportPlan(db, profileId, token),
        selected = selectedPlans.get(db)!;
      preparingPlans.add(db);
      try {
        await report.choose(input);
        selected.scopeToken = (await report.finalizeVerified()).scopeToken;
        return await report.withVerifiedRead(() => report.publicPreview());
      } finally {
        preparingPlans.delete(db);
      }
    },
    { operation: currentClinicalOperation(db) },
  );
}

export function usesNativeOwnershipReportEvidence(db: Database, input: unknown) {
  const selected = ownershipRequest(input);
  if (selected.selection.type !== 'report') return false;
  const source = db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(selected.selection.intakeId);
  return !!source && hasIntakeCollectionEnvelope(db, source as { id: string });
}

export function nativeOwnershipBlockerStore(db: Database, profileId: string, token: string) {
  const selected = selectedPlans.get(db);
  if (!selected || selected.profileId !== profileId || selected.blockers?.token !== token)
    throw new HttpError(409, 'OWNERSHIP_CHANGED', 'Refresh this ownership review');
  selected.plan.assertCurrent();
  return selected.blockers;
}

export async function withNativeOwnershipBlockerStore<T>(
  db: Database,
  profileId: string,
  token: string,
  complete: (store: OwnershipBlockerStore) => T,
) {
  return runNativeOwnershipOperation(
    db,
    async () => {
      const store = nativeOwnershipBlockerStore(db, profileId, token),
        report = selectedPlans.get(db)?.report;
      return report ? report.withVerifiedRead(() => complete(store)) : complete(store);
    },
    { operation: currentClinicalOperation(db) },
  );
}
