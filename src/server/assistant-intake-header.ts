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
import { reviewReadStamp } from './intake-clinical-review-read-cache.ts';
import { recordDurabilityStatus } from './record-versions.ts';

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

const HEADER_CACHE_BYTES = 256 * 1024;
interface HeaderEntry {
  source: string;
  logical: string;
  value: NativeAssistantSourceHeader;
  bytes: number;
}
const headers = new WeakMap<
  Database,
  { stamp: string; values: Map<string, HeaderEntry>; bytes: number }
>();
function freezeHeader(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeHeader(child);
  Object.freeze(value);
}
function currentAuthority(db: Database): void {
  const durability = recordDurabilityStatus(db);
  if (!durability?.configured || durability.dirty)
    throw Error('The selected assistant source requires current accepted authority');
}

export function readNativeAssistantSourceHeader(
  db: Database,
  root: string,
  profileId: string,
  id: string,
): NativeAssistantSourceHeader | undefined {
  // Only detached, bounded header values are retained. Every reuse still checks
  // the actual profile/source and physical accepted head; SQL stamps alone do
  // not prove that encrypted/contributor authority remains available.
  const stamp = reviewReadStamp(db);
  if (!stamp) headers.delete(db);
  try {
    const source = getIntakeEvidenceHeader(db, root, profileId, id);
    if (source.workflowState !== 'selected') {
      headers.delete(db);
      return undefined;
    }
    const current = intakeSourceVersion(db, id);
    currentAuthority(db);
    const key = JSON.stringify([root, profileId, id]),
      sourceBinding = JSON.stringify(source);
    let cache = headers.get(db);
    if (!cache || cache.stamp !== stamp) {
      headers.delete(db);
      cache = stamp ? { stamp, values: new Map(), bytes: 0 } : undefined;
      if (cache) headers.set(db, cache);
    }
    const cached = cache?.values.get(key);
    if (
      cached &&
      cached.source === sourceBinding &&
      cached.logical === current.logicalBinding &&
      cached.value.version === current.version &&
      reviewReadStamp(db) === stamp
    ) {
      cache!.values.delete(key);
      cache!.values.set(key, cached);
      return cached.value;
    }
    const value = readSelectedHeader(db, root, profileId, id, source, current);
    const bytes =
      Buffer.byteLength(key) +
      Buffer.byteLength(sourceBinding) +
      Buffer.byteLength(current.logicalBinding || '') +
      Buffer.byteLength(JSON.stringify(value));
    if (
      cache &&
      current.logicalBinding &&
      value.activePlan.state === 'exact' &&
      value.activePlan.plan &&
      Buffer.byteLength(key) <= 4096 &&
      bytes <= HEADER_CACHE_BYTES &&
      reviewReadStamp(db) === stamp
    ) {
      freezeHeader(value);
      const prior = cache.values.get(key);
      if (prior) cache.bytes -= prior.bytes;
      cache.values.delete(key);
      cache.values.set(key, {
        source: sourceBinding,
        logical: current.logicalBinding,
        value,
        bytes,
      });
      cache.bytes += bytes;
      while (cache.values.size > 32 || cache.bytes > HEADER_CACHE_BYTES) {
        const first = cache.values.keys().next().value!;
        cache.bytes -= cache.values.get(first)!.bytes;
        cache.values.delete(first);
      }
    }
    return value;
  } catch (error) {
    // A temporary repair or a failed authority check cannot revive an older
    // successful stamp after rollback, cache disposal, profile lock or recovery.
    headers.delete(db);
    throw error;
  }
}

function readSelectedHeader(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  source: ReturnType<typeof getIntakeEvidenceHeader>,
  current: ReturnType<typeof intakeSourceVersion>,
): NativeAssistantSourceHeader {
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
  const pins = {
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
