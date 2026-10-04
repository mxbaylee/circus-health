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
import { previewRecordOwnership, commitRecordOwnershipPlannedUnit } from './record-ownership.ts';
import { type PreparedOwnershipNamePlan } from './ownership-name-plan.ts';
import { getNote } from './notes.ts';
import { childOwnershipOperation, ownershipPlans } from './ownership-groups.ts';
import { ownershipHash } from './ownership-journal.ts';
import type { OwnershipCommit, OwnershipPreview } from '../shared/record-ownership.ts';
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
function referencePreview(
  preview: OwnershipPreview,
  plan: PreparedOwnershipNamePlan,
  report?: PreparedOwnershipReportPlan,
): OwnershipPreviewReference | OwnershipReportPreviewReference {
  if (report) return report.publicPreview();
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
  const report = await prepareOwnershipReportPlan(db, root, profileId, selectedRequest, {
    ...options,
    assertRunning() {
      if ((planEpochs.get(db) ?? 0) !== epoch)
        throw new HttpError(
          401,
          'PROFILE_LOCKED',
          'Unlock this profile and prepare the current ownership evidence',
        );
    },
  });
  return {
    preview: report.finalize(),
    plan: report.plan,
    report,
    blockers: undefined as OwnershipBlockerStore | undefined,
  };
}
export async function previewNativeRecordOwnership(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
  options: { onCheckpoint?: (stage: string) => void } = {},
) {
  if (preparingPlans.has(db) || committingPlans.has(db))
    throw new HttpError(
      409,
      'OWNERSHIP_PREPARING',
      'The selected ownership evidence is still being prepared',
    );
  preparingPlans.add(db);
  try {
    const prepared = await prepare(db, root, profileId, input, options);
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
        previous.plan.assertCurrent();
        currentPrevious = true;
      } catch {
        /* Stale previous authority supplies no decisions. */
      }
      if (currentPrevious) {
        try {
          for (const choice of previous.plan.choices())
            if (prepared.plan.has(choice.key)) prepared.plan.choose(choice.key, choice.outcome);
          if (previous.report && prepared.report)
            for (const choice of previous.report.choices()) await prepared.report.choose(choice);
        } catch (error) {
          if (prepared.report) prepared.report.close();
          else prepared.plan.close();
          throw error;
        }
      }
      prepared.preview = prepared.report
        ? prepared.report.finalize()
        : previewRecordOwnership(db, root, profileId, prepared.plan.request, {
            namePlan: prepared.plan,
            blockerStore: prepared.blockers,
          });
    }
    if (previous?.report) previous.report.close();
    else previous?.plan.close();
    selectedPlans.set(db, { ...prepared, scopeToken: prepared.preview.scopeToken, profileId });
    return referencePreview(prepared.preview, prepared.plan, prepared.report);
  } finally {
    preparingPlans.delete(db);
  }
}
export function chooseNativeOwnershipName(
  db: Database,
  root: string,
  profileId: string,
  token: string,
  key: string,
  outcome: import('../shared/record-ownership.ts').OwnershipNameEffect['decision'],
) {
  const plan = nativeOwnershipNamePlan(db, profileId, token);
  plan.choose(key, outcome);
  const report = selectedPlans.get(db)?.report,
    blockers = selectedPlans.get(db)?.blockers;
  const preview = report
    ? report.finalize()
    : previewRecordOwnership(db, root, profileId, plan.request, {
        namePlan: plan,
        blockerStore: blockers,
      });
  selectedPlans.set(db, { plan, report, blockers, scopeToken: preview.scopeToken, profileId });
  return referencePreview(preview, plan, report);
}
export function nativeOwnershipNamePlan(db: Database, profileId: string, token: string) {
  if (committingPlans.has(db) || preparingPlans.has(db))
    throw new HttpError(409, 'OWNERSHIP_COMMITTING', 'The approved correction is being saved');
  const selected = selectedPlans.get(db);
  if (!selected || selected.profileId !== profileId || selected.plan.reference.token !== token)
    throw new HttpError(
      409,
      'OWNERSHIP_CHANGED',
      'Prepare the current ownership evidence before viewing it',
    );
  selected.plan.assertCurrent();
  return selected.plan;
}
export async function commitNativeRecordOwnership(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
) {
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
  const preview = report.finalize();
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
  if (preview.commitGroups.length <= 1) {
    await report.prepareSourceSnapshots();
    commitRecordOwnershipPlannedUnit(db, root, profileId, input, selected.plan, undefined, report);
    return published();
  }
  const fingerprint = ownershipHash({ ...supplied, request }),
    approvedChoices = selected.plan.approvedChoices();
  let destination = request.destination;
  for (const group of preview.commitGroups) {
    let child: PreparedOwnershipReportPlan | undefined;
    try {
      if ('noteId' in destination)
        destination = { ...destination, expectedVersion: getNote(db, destination.noteId).version };
      const childRequest = { ...report.requestForGroup(group), destination };
      const prepared = await prepare(db, root, profileId, childRequest, {
        approvedRelationshipDecisions: () => report.relationshipChoicesForGroup(group),
      });
      child = prepared.report;
      for (const choice of approvedChoices())
        if (child.plan.has(choice.key)) child.plan.choose(choice.key, choice.outcome);
      const current = child.finalize();
      await child.prepareSourceSnapshots();
      const receipt = commitRecordOwnershipPlannedUnit(
        db,
        root,
        profileId,
        {
          operationId: childOwnershipOperation(supplied.operationId, group.id),
          request: current.request,
          scopeToken: current.scopeToken,
          version: current.version,
        },
        child.plan,
        { operationId: supplied.operationId, fingerprint, groups: preview.commitGroups },
        child,
      );
      if ('newPerson' in destination) {
        const note = db
          .prepare("SELECT id FROM notes WHERE kind='person' AND person_id=?")
          .get(receipt.destinationPersonId);
        if (!note) throw Error('Ownership destination is unavailable');
        destination = {
          noteId: String(note.id),
          expectedVersion: getNote(db, String(note.id)).version,
        };
      }
    } catch (error) {
      if (!ownershipPlans(db, supplied.operationId).length) throw error;
      return published();
    } finally {
      child?.close();
    }
  }
  return published();
}

export function nativeOwnershipReportPlan(db: Database, profileId: string, token: string) {
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
  selected.report.assertCurrent();
  return selected.report;
}
export async function chooseNativeOwnershipReport(
  db: Database,
  profileId: string,
  token: string,
  input: unknown,
) {
  const report = nativeOwnershipReportPlan(db, profileId, token),
    selected = selectedPlans.get(db)!;
  preparingPlans.add(db);
  try {
    await report.choose(input);
    selected.scopeToken = report.finalize().scopeToken;
    return report.publicPreview();
  } finally {
    preparingPlans.delete(db);
  }
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
