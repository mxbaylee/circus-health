/** Explicit preparation for the coordinator's existential interpretation check.
 * A positive witness is addressed; a negative is reused only while all SQLite
 * changes and the selected source pins remain unchanged. */
import { setImmediate } from 'node:timers/promises';
import type { Database } from './database.ts';
import { assertIntakeOwner } from './intake.ts';
import {
  openIntakeCollectionEnvelope,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { proposalDependenciesCurrent } from './intake-proposal-dependencies.ts';
import { readIntakeSourcePin } from './intake-source-pin.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
interface Result {
  original: boolean;
  originalValid: boolean;
  hasCurrentProposal: boolean;
  proposalTotal: number;
}
interface Cached {
  binding: string;
  changes: number;
  proposalId?: string;
  result: Result;
}
const caches = new WeakMap<Database, Map<string, Cached>>();
function field<T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): T | undefined {
  const value = view.field(record, name, { bytes: 8192 });
  if (value.kind === 'missing') return undefined;
  if (value.kind !== 'value')
    throw Error('Interpretation metadata requires selected scalar preparation');
  return value.value as T;
}
export async function prepareCurrentIntakeInterpretations(
  db: Database,
  profileId: string,
  id: string,
  options: { assertRunning?: () => void; onProposal?: () => void } = {},
): Promise<Result> {
  assertIntakeOwner(db, profileId);
  options.assertRunning?.();
  const view = openIntakeCollectionEnvelope(db, { id }),
    intake = view.child(view.root(), 'intake');
  if (!intake) throw Error('Selected intake metadata unavailable');
  const pin = readIntakeSourcePin(db, id),
    version = intakeSourceVersion(db, id).version,
    binding = JSON.stringify([view.logical, version, pin]),
    changes = Number(db.prepare('SELECT total_changes() AS count').get()!.count);
  const current = () => {
    assertIntakeOwner(db, profileId);
    options.assertRunning?.();
    view.info(intake);
    if (
      intakeSourceVersion(db, id).version !== version ||
      JSON.stringify(readIntakeSourcePin(db, id)) !== JSON.stringify(pin) ||
      Number(db.prepare('SELECT total_changes() AS count').get()!.count) !== changes
    )
      throw Error('Interpretation selection changed during preparation');
  };
  let cache = caches.get(db);
  if (!cache) {
    cache = new Map();
    caches.set(db, cache);
  }
  const previous = cache.get(id);
  const selectedRevision = pin
      ? pin.revisionId
      : (field<string | null>(view, intake, 'sourceTextRevisionId') ?? null),
    selectedDependency = pin
      ? pin.dependencyToken
      : (field<string | null>(view, intake, 'sourceTextDependencyToken') ?? null);
  const valid = (record: IntakeEnvelopeRecord) => {
    const proposalId = field<string>(view, record, 'id');
    if (!proposalId) throw Error('Invalid selected proposal identity');
    return (
      proposalDependenciesCurrent(db, proposalId) ??
      ((field<string | null>(view, record, 'sourceTextRevisionId') || null) === selectedRevision &&
        (field<string | null>(view, record, 'sourceTextDependencyToken') || null) ===
          selectedDependency)
    );
  };
  const validation = view.child(intake, 'validation');
  const result: Result = {
    original:
      !pin?.requiresInterpretation &&
      !field<boolean>(view, intake, 'sourceTextRequiresInterpretation'),
    originalValid: !!validation && field<boolean>(view, validation, 'valid') === true,
    hasCurrentProposal: false,
    proposalTotal: view.childCount(intake, 'proposals'),
  };
  if (previous?.binding === binding && previous.changes === changes) {
    current();
    return previous.result;
  }
  let proposalId: string | undefined;
  if (previous?.proposalId) {
    const proposal = view.find('proposal', intake, previous.proposalId);
    if (proposal && valid(proposal)) proposalId = previous.proposalId;
  }
  if (!proposalId) {
    let after: string | undefined;
    scan: while (true) {
      current();
      const page = view.children(intake, 'proposals', { after, items: 16, bytes: 32768 });
      for (const proposal of page.records) {
        options.onProposal?.();
        if (valid(proposal)) {
          proposalId = field<string>(view, proposal, 'id');
          break scan;
        }
      }
      if (page.complete) break;
      if (!page.after || page.after === after) throw Error('Interpretation cursor did not advance');
      after = page.after;
      await setImmediate();
    }
  }
  current();
  result.hasCurrentProposal = proposalId !== undefined;
  if (cache.size >= 8 && !cache.has(id)) cache.delete(cache.keys().next().value!);
  cache.set(id, { binding, changes, proposalId, result });
  return result;
}
