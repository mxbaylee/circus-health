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
import { intakeCollectionCacheGeneration } from './intake-state-collections.ts';
interface Result {
  original: boolean;
  originalValid: boolean;
  hasCurrentProposal: boolean;
  proposalTotal: number;
}
interface Cached {
  binding: string;
  stamp: string;
  generation: object;
  proposalId?: string;
  result: Result;
}
const caches = new WeakMap<Database, Map<string, Cached>>();
const stampQueries = new WeakMap<
  Database,
  {
    main: ReturnType<Database['prepare']>;
    temp: ReturnType<Database['prepare']>;
  }
>();
function stamp(db: Database) {
  let query = stampQueries.get(db);
  if (!query) {
    query = {
      main: db.prepare(
        'SELECT total_changes() AS changes,(SELECT data_version FROM pragma_data_version) AS external,(SELECT schema_version FROM pragma_schema_version) AS schema',
      ),
      temp: db.prepare('PRAGMA temp.schema_version'),
    };
    query.main.setReadBigInts(true);
    query.temp.setReadBigInts(true);
    stampQueries.set(db, query);
  }
  const value = query.main.get()!,
    temp = query.temp.get()!;
  return `${value.changes}:${value.external}:${value.schema}:${temp.schema_version}`;
}
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
  // A rolled-back temporary repair may leave total_changes unchanged. Do not
  // retain or reuse transaction-local positive or negative evidence.
  const transaction = db.isTransaction;
  if (transaction) caches.delete(db);
  const initialStamp = stamp(db),
    generation = intakeCollectionCacheGeneration(db);
  const view = openIntakeCollectionEnvelope(db, { id }),
    intake = view.child(view.root(), 'intake');
  if (!intake) throw Error('Selected intake metadata unavailable');
  const pin = readIntakeSourcePin(db, id),
    version = intakeSourceVersion(db, id).version,
    binding = JSON.stringify([profileId, view.logical, version, pin]);
  const current = () => {
    assertIntakeOwner(db, profileId);
    options.assertRunning?.();
    view.info(intake);
    if (
      intakeSourceVersion(db, id).version !== version ||
      JSON.stringify(readIntakeSourcePin(db, id)) !== JSON.stringify(pin) ||
      stamp(db) !== initialStamp ||
      db.isTransaction !== transaction ||
      intakeCollectionCacheGeneration(db) !== generation
    )
      throw Error('Interpretation selection changed during preparation');
  };
  let cache = caches.get(db);
  if (!cache) {
    cache = new Map();
    caches.set(db, cache);
  }
  const previous = transaction ? undefined : cache.get(id);
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
  if (
    previous?.binding === binding &&
    previous.stamp === initialStamp &&
    previous.generation === generation
  ) {
    current();
    return { ...previous.result };
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
  if (!transaction) {
    if (cache.size >= 8 && !cache.has(id)) cache.delete(cache.keys().next().value!);
    cache.set(id, {
      binding,
      stamp: initialStamp,
      generation,
      proposalId,
      result: { ...result },
    });
  }
  return result;
}
