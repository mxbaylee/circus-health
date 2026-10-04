/** SQL-first lookup deltas for owned append-only mutation families. */
import type { DatabaseSync } from 'node:sqlite';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { boundedIntakeLookupText } from './intake-lookup-contributions.ts';
import { readNativeIntakeLookupTarget } from './intake-lookup-state.ts';
import type { WorkflowIndexContribution } from './intake-workflow-index.ts';

/** `unchangedLookupScopes` is an owned compiler witness, not inferred from
 * equal addresses/counts: edits inside a record retain both. Proposal compilation
 * preserves existing discovery orders and never edits acceptance/identity trees.
 * This helper is deliberately unavailable to arbitrary envelope mutations. */
export function* proposalLookupIndexContributions(
  db: DatabaseSync,
  before: IntakeCollectionEnvelopeReader,
  after: IntakeCollectionEnvelopeReader,
  changedGroupAddresses: readonly string[],
  options: { source: IntakeEnvelopeSource; unchangedLookupScopes: true },
): Generator<WorkflowIndexContribution> {
  if (options.unchangedLookupScopes !== true)
    throw Error('Proposal lookup update requires an owned closed-set witness');
  const oldWorkflow = workflow(before),
    newWorkflow = workflow(after);
  if (!newWorkflow) throw Error('Proposal lookup workflow scope changed');
  for (const name of ['reportAcceptances', 'identityConfirmations']) {
    const old = collection(before, oldWorkflow, name),
      next = collection(after, newWorkflow, name);
    if ((oldWorkflow && old.address !== next.address) || old.count !== next.count)
      throw Error('Proposal changed a lookup receipt scope');
  }
  yield* maximumContribution(db, before, after, changedGroupAddresses, options.source);
}

const workflow = (view: IntakeCollectionEnvelopeReader) => {
  const intake = view.child(view.root(), 'intake');
  return intake && view.child(intake, 'workflow');
};
const collection = (
  view: IntakeCollectionEnvelopeReader,
  parent: IntakeEnvelopeRecord | undefined,
  name: string,
) => {
  if (!parent) return { address: undefined, count: 0 };
  const record = view.child(parent, name);
  if (!record) {
    const value = view.field(parent, name, { bytes: 128 * 1024 });
    if (value.kind === 'missing' || (value.kind === 'value' && value.value == null))
      return { address: undefined, count: 0 };
    throw Error('Proposal lookup collection is unavailable');
  }
  if (view.info(record).shape !== 'array')
    throw Error('Proposal lookup collection is not an array');
  return { address: view.address(record), count: view.childCount(parent, name) };
};

function* maximumContribution(
  db: DatabaseSync,
  before: IntakeCollectionEnvelopeReader,
  after: IntakeCollectionEnvelopeReader,
  changedGroupAddresses: readonly string[],
  source: IntakeEnvelopeSource,
): Generator<WorkflowIndexContribution> {
  const oldWorkflow = workflow(before),
    newWorkflow = workflow(after);
  if (!newWorkflow) throw Error('Lookup workflow scope is unavailable');
  const oldGroups = collection(before, oldWorkflow, 'reportGroups');
  const groups = collection(after, newWorkflow, 'reportGroups');
  if ((oldGroups.address && oldGroups.address !== groups.address) || groups.count < oldGroups.count)
    throw Error('Proposal replaced its SQL-first report-group scope');
  const previous = readNativeIntakeLookupTarget(db, source, before, 'lookup-discovery-maximum', []);
  const cast = db.prepare("SELECT CAST(json_extract(?,'$') AS INTEGER) n");
  cast.setReadBigInts(true);
  const value = (
    view: IntakeCollectionEnvelopeReader,
    group: IntakeEnvelopeRecord,
  ): bigint | null => {
    if (view.info(group).shape === 'scalar') {
      const scalar = db.prepare(
        "SELECT CAST(json_extract(j.value,'$.discoveryOrder') AS INTEGER) n FROM json_each(?) j",
      );
      scalar.setReadBigInts(true);
      return scalar.get('[' + boundedIntakeLookupText(view.recordChunks(group)) + ']')!.n as
        bigint | null;
    }
    if (!view.has(group, 'discoveryOrder')) return null;
    return cast.get(boundedIntakeLookupText(view.fieldChunks(group, 'discoveryOrder')))!.n as
      bigint | null;
  };
  let maximum = previous ? value(before, previous) : null;
  let target = previous ? after.resolve(before.address(previous)) : null;
  const changed = new Set(changedGroupAddresses);
  // Only appended first-selected groups are examined. A proposal targeting a
  // shadowed last-selected raw array therefore leaves this SQL-first index alone.
  for (let ordinal = oldGroups.count; ordinal < groups.count; ordinal++) {
    const group = after.childAt(newWorkflow, 'reportGroups', ordinal);
    if (!group || !changed.has(after.address(group)))
      throw Error('Proposal appended an unaccounted SQL-first report group');
    const n = value(after, group);
    if (n !== null && (maximum === null || n > maximum)) {
      maximum = n;
      target = group;
    }
  }
  before.address(before.root());
  after.address(after.root());
  yield { index: 'lookup-discovery-maximum', key: [], target };
}

/** Acceptance compilation appends complete immutable receipt records. It never
 * rewrites existing receipt descendants or discovery orders. Changed addresses
 * are supplied by that owned compiler, not by a public request. */
export function* acceptanceLookupIndexContributions(
  db: DatabaseSync,
  before: IntakeCollectionEnvelopeReader,
  after: IntakeCollectionEnvelopeReader,
  changedGroupAddresses: readonly string[],
  options: {
    source: IntakeEnvelopeSource;
    reportAcceptanceAddresses: readonly string[];
    identityReceiptAddresses: readonly string[];
  },
): Generator<WorkflowIndexContribution> {
  const oldWorkflow = workflow(before),
    newWorkflow = workflow(after);
  if (!newWorkflow) throw Error('Acceptance lookup workflow scope changed');
  const scopes = (name: string) => {
    const old = collection(before, oldWorkflow, name),
      next = collection(after, newWorkflow, name);
    if ((old.address && old.address !== next.address) || next.count < old.count)
      throw Error('Acceptance replaced its SQL-first receipt scope');
    return { old, next };
  };
  const acceptances = scopes('reportAcceptances'),
    identities = scopes('identityConfirmations');
  const acceptanceAddresses = new Set(options.reportAcceptanceAddresses),
    identityAddresses = new Set(options.identityReceiptAddresses);
  // Emit in reverse order: last-write application retains the first new record.
  // A checked existing point wins over every appended duplicate operation.
  for (let ordinal = acceptances.next.count - 1; ordinal >= acceptances.old.count; ordinal--) {
    const target = after.childAt(newWorkflow, 'reportAcceptances', ordinal);
    if (!target || !acceptanceAddresses.has(after.address(target)))
      throw Error('Acceptance appended an unaccounted SQL-first receipt');
    if (after.info(target).shape === 'scalar') {
      db.prepare("SELECT json_extract(j.value,'$.receipt.operationId') FROM json_each(?) j").get(
        '[' + boundedIntakeLookupText(after.recordChunks(target)) + ']',
      );
      continue;
    }
    const receipt = after.child(target, 'receipt');
    if (!receipt || !after.has(receipt, 'operationId')) continue;
    const text = boundedIntakeLookupText(after.fieldChunks(receipt, 'operationId'));
    const operation = db
      .prepare(
        "SELECT typeof(json_extract(?,'$')) type,hex(CAST(json_extract(?,'$') AS BLOB)) identity",
      )
      .get(text, text)!;
    if (operation.type !== 'null' && operation.type !== 'text')
      throw Error('Intake lookup invalid acceptance operation identity');
    if (operation.type !== 'text') continue;
    const key = [String(operation.identity)];
    if (
      !readNativeIntakeLookupTarget(
        db,
        options.source,
        before,
        'lookup-acceptance-operation-first',
        key,
      )
    )
      yield { index: 'lookup-acceptance-operation-first', key, target };
  }
  for (let ordinal = identities.old.count; ordinal < identities.next.count; ordinal++) {
    const target = after.childAt(newWorkflow, 'identityConfirmations', ordinal);
    if (!target || !identityAddresses.has(after.address(target)))
      throw Error('Acceptance appended an unaccounted SQL-first identity receipt');
    yield { index: 'lookup-identity-order', key: [String(ordinal)], target };
  }
  yield* maximumContribution(db, before, after, changedGroupAddresses, options.source);
}
