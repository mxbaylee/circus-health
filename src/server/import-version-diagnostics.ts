import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

type Snapshot = {
  version: number;
  proposals?: unknown;
  imported?: unknown;
  sourceTextRevisionId?: unknown;
  workflow?: unknown;
};
type Change = { version: number; category: string; at: number; digest: string };
const histories = new WeakMap<DatabaseSync, Map<string, Change[]>>();
const digest = (raw: string) => createHash('sha256').update(raw).digest('hex');
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const size = (v: unknown) => (Array.isArray(v) ? v.length : 0);
function category(before: Snapshot, after: Snapshot): string {
  if (size(after.proposals) !== size(before.proposals)) return 'proposal';
  if (JSON.stringify(after.imported) !== JSON.stringify(before.imported)) return 'acceptance';
  if (after.sourceTextRevisionId !== before.sourceTextRevisionId) return 'source_text';
  const old = object(before.workflow),
    next = object(after.workflow);
  for (const [field, name] of [
    ['identityConfirmations', 'identity_confirmation'],
    ['reviewDrafts', 'review'],
    ['questions', 'question'],
    ['plans', 'plan'],
  ] as const)
    if (JSON.stringify(old[field]) !== JSON.stringify(next[field])) return name;
  return 'workflow_update';
}
/** Optional runtime observations only. Fingerprints prevent rolled-back writes from being cited. */
export function observeIntakeVersion(
  db: DatabaseSync,
  id: string,
  before: Snapshot,
  after: Snapshot,
  rawAfter: string,
  rawBefore = JSON.stringify(before),
): void {
  if (after.version === before.version) return;
  let sources = histories.get(db);
  if (!sources) histories.set(db, (sources = new Map()));
  const previous = sources.get(id) || [];
  // An unobserved write or rolled-back predecessor breaks the observed chain.
  const changes =
    previous.at(-1)?.version === before.version && previous.at(-1)?.digest === digest(rawBefore)
      ? [...previous]
      : [];
  changes.push({
    version: after.version,
    category: category(before, after),
    at: Date.now(),
    digest: digest(rawAfter),
  });
  sources.delete(id);
  sources.set(id, changes.slice(-32));
  if (sources.size > 64) sources.delete(sources.keys().next().value!);
}
export function intakeVersionConflictFacts(
  db: DatabaseSync,
  id: string,
  expected: unknown,
  current: number,
  rawCurrent: string | { logicalBinding: string },
) {
  const currentDigest =
    typeof rawCurrent === 'string'
      ? digest(rawCurrent)
      : 'logical:' + digest(rawCurrent.logicalBinding);
  const entries = histories.get(db)?.get(id) || [];
  const valid = entries.at(-1)?.version === current && entries.at(-1)?.digest === currentDigest;
  const changes =
    valid && Number.isSafeInteger(expected)
      ? entries.filter((entry) => entry.version > Number(expected) && entry.version <= current)
      : [];
  const complete =
    valid &&
    Number.isSafeInteger(expected) &&
    current > Number(expected) &&
    changes.length === current - Number(expected);
  return {
    expectedVersion: Number.isSafeInteger(expected) ? Number(expected) : null,
    currentVersion: current,
    versionHistoryComplete: !!complete,
    observedVersionChanges: changes.length,
    lastChangeCategory: valid ? entries.at(-1)!.category : 'unknown',
    lastChangeAgeMs: valid ? Math.max(0, Date.now() - entries.at(-1)!.at) : null,
    identityChanges: changes.filter((entry) => entry.category === 'identity_confirmation').length,
    proposalChanges: changes.filter((entry) => entry.category === 'proposal').length,
    reviewChanges: changes.filter((entry) => entry.category === 'review').length,
    planChanges: changes.filter((entry) => entry.category === 'plan').length,
    acceptanceChanges: changes.filter((entry) => entry.category === 'acceptance').length,
    sourceTextChanges: changes.filter((entry) => entry.category === 'source_text').length,
    questionChanges: changes.filter((entry) => entry.category === 'question').length,
    otherVersionChanges: changes.filter((entry) => entry.category === 'workflow_update').length,
  };
}

/** Bounded host mutation observation. The selected logical binding, not a full
 * exported workflow or auxiliary receipt head, proves the observed predecessor. */
export function observeIntakeLogicalVersion(
  db: DatabaseSync,
  id: string,
  before: { version: number; logicalBinding: string },
  after: { version: number; logicalBinding: string },
  change:
    | 'proposal'
    | 'acceptance'
    | 'source_text'
    | 'identity_confirmation'
    | 'review'
    | 'question'
    | 'plan'
    | 'workflow_update',
): void {
  if (before.version === after.version) return;
  let sources = histories.get(db);
  if (!sources) histories.set(db, (sources = new Map()));
  const previous = sources.get(id) || [];
  const changes =
    previous.at(-1)?.version === before.version &&
    previous.at(-1)?.digest === 'logical:' + digest(before.logicalBinding)
      ? [...previous]
      : [];
  changes.push({
    version: after.version,
    category: change,
    at: Date.now(),
    digest: 'logical:' + digest(after.logicalBinding),
  });
  sources.delete(id);
  sources.set(id, changes.slice(-32));
  if (sources.size > 64) sources.delete(sources.keys().next().value!);
}
