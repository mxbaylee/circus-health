/** Selected source/plan facts for internal conversion events. Public collection
 * summaries remain separate; an absent collection here makes no completeness claim. */
import { HttpError, type Database } from './database.ts';
import type { IntakeFilename, IntakeSummaryV2 } from '../shared/intake-summary.ts';
import { getIntakeEvidenceHeader, intakeDurability } from './intake.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from './intake-collection-envelope.ts';
import { summaryFilename } from './intake-summary-name.ts';
import { collectionActiveIntakePlanHeader } from './intake-summary.ts';
import { readDirectPlanHeader } from './intake-direct-plan.ts';
import { readPackagePlanScope } from './intake-package-plan.ts';

export type NativeAssistantSourceHeader = IntakeFilename & {
  format: 'health-intake-assistant-source-v1';
  id: string;
  sha256: string;
  version: number;
  providerId: string;
  candidateCount: number;
  activePlan: IntakeSummaryV2['activePlan'];
  durability: IntakeSummaryV2['durability'];
};

export function readNativeAssistantSourceHeader(
  db: Database,
  root: string,
  profileId: string,
  id: string,
): NativeAssistantSourceHeader | undefined {
  const source = getIntakeEvidenceHeader(db, root, profileId, id);
  if (source.workflowState !== 'selected') return undefined;
  const providerId = String(source.providerId || '');
  if (Buffer.byteLength(providerId) > 16384)
    throw new HttpError(
      409,
      'INTAKE_SUMMARY_UNAVAILABLE',
      'The selected source provider header is unavailable.',
    );
  const view = openIntakeCollectionEnvelope(db, { id }),
    intake = view.child(view.root(), 'intake');
  if (!intake) throw Error('The selected assistant source header is unavailable');
  const current = intakeSourceVersion(db, id),
    pins = {
      sourceHash: source.sourceHash,
      logicalRoot: view.logical.root?.hash || '',
      domainVersion: view.logical.domainVersion,
      version: current.version,
    };
  if (
    !pins.logicalRoot ||
    pins.domainVersion !== current.rawVersion ||
    current.version !== source.version
  )
    throw Error('The selected assistant source changed');
  const collections = selectedEnvelopeStore(db, { id }).collections,
    selected = collections.openView(),
    packageId = collections.get(selected, 'logical', 'package.selection', 'active'),
    directId = collections.get(selected, 'logical', 'direct.selection', 'active');
  let activePlan: NativeAssistantSourceHeader['activePlan'];
  if (source.mimeType === 'application/zip' && typeof packageId === 'string') {
    const scope = readPackagePlanScope(db, root, profileId, id);
    if (!scope || scope.planId !== packageId)
      throw Error('The selected package plan is unavailable');
    activePlan = { state: 'exact', plan: scope.plan };
  } else if (typeof directId === 'string') {
    const plan = readDirectPlanHeader(db, profileId, id);
    if (!plan || plan.id !== directId) throw Error('The selected direct plan is unavailable');
    activePlan = { state: 'exact', plan };
  } else activePlan = collectionActiveIntakePlanHeader(view);
  const workflow = view.child(intake, 'workflow');
  if (view.has(intake, 'workflow') && !workflow)
    throw Error('The selected assistant workflow header is unavailable');
  if (workflow && view.has(workflow, 'candidates') && !view.child(workflow, 'candidates'))
    throw Error('The selected assistant candidate header is unavailable');
  const candidateCount = workflow ? view.childCount(workflow, 'candidates') : 0;
  const filename = summaryFilename(db, { view, intake, pins, id, mimeType: source.mimeType });
  view.address(intake);
  const after = intakeSourceVersion(db, id);
  if (after.logicalBinding !== current.logicalBinding || after.version !== current.version)
    throw Error('The selected assistant source changed');
  return {
    format: 'health-intake-assistant-source-v1',
    id,
    sha256: source.sourceHash,
    version: current.version,
    providerId,
    candidateCount,
    activePlan,
    durability: intakeDurability(db),
    ...filename,
  };
}
