/** Literal retained-work totals; this map makes no clinical classification claim. */
import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import type { IntakeEnvelopeDerivedPreparation } from './intake-envelope-mutation.ts';
import type { NativeProposalAffected } from './intake-collection-proposals.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from './intake-collection-envelope.ts';
import {
  WORKFLOW_DEPENDENCY_POLICY,
  workflowSubstantiveVersionKey,
} from './intake-workflow-dependencies.ts';

export const WORKFLOW_READING_POLICY = 'health-intake-literal-reading-v1';
export const WORKFLOW_READING_COLLECTION = 'workflow.reading';

/** Only a complete selected generation can supply literal totals. Source-text
 * and mapping classification bindings are deliberately not authority here. */
export function currentWorkflowReadingCollection(
  get: (collection: string, key: string) => unknown,
  logical: string,
): string | undefined {
  for (const [collection, policy] of [
    ['workflow.dependencies', WORKFLOW_DEPENDENCY_POLICY],
    [WORKFLOW_READING_COLLECTION, WORKFLOW_READING_POLICY],
  ] as const)
    if (get(collection, 'policy') === policy && get(collection, 'complete') === logical)
      return collection;
  return undefined;
}

/** Called only by the native proposal compiler with its complete affected
 * occurrence descriptor. It never accepts client-supplied changed-key claims.
 * Proposal history is append-only: an existing version's digest is immutable.
 * Missing prior proof stays pending until explicit cold workflow preparation. */
export async function prepareWorkflowReadingDerived(
  db: Database,
  source: IntakeEnvelopeSource,
  input: IntakeEnvelopeDerivedPreparation & {
    affected: NativeProposalAffected;
    packageBatch?: { planAddress: string; operationId: string };
    assertRunning?: () => void;
    onCheckpoint?: () => void | Promise<void>;
  },
): Promise<readonly IntakeCollectionChange[]> {
  const { assertNativeProposalReadingEffects } = await import('./intake-collection-proposals.ts');
  assertNativeProposalReadingEffects(db, source, input, input.packageBatch);
  input.assertRunning?.();
  const before = openIntakeCollectionEnvelope(db, source),
    { collections } = selectedEnvelopeStore(db, source),
    logical = JSON.stringify(before.logical),
    staged = input.reader,
    get = (collection: string, key: string) =>
      collections.get(collections.openView(), 'builds', collection, key),
    base = currentWorkflowReadingCollection(get, logical);
  if (!base) return [];
  const baseRoot = collections.collection(collections.openView(), 'builds', base)?.root?.hash;
  if (!baseRoot) throw Error('Missing complete literal reading root');
  if (
    JSON.stringify(staged.logical) !== logical ||
    input.logical.domainVersion !== before.logical.domainVersion + 1 ||
    !input.logical.root
  )
    throw Error('Literal reading update requires the exact next workflow generation');
  const oldIntake = before.child(before.root(), 'intake')!,
    oldWorkflow = before.child(oldIntake, 'workflow'),
    intake = staged.child(staged.root(), 'intake')!,
    workflow = staged.child(intake, 'workflow');
  if (!workflow) return [];
  const current = () => {
    assertNativeProposalReadingEffects(db, source, input, input.packageBatch);
    input.assertRunning?.();
    before.address(before.root());
    if (
      currentWorkflowReadingCollection(get, logical) !== base ||
      collections.collection(collections.openView(), 'builds', base)?.root?.hash !== baseRoot
    )
      throw Error('Literal reading base changed during preparation');
  };
  const name = 'workflow.reading.' + randomUUID(),
    pending = new Map<string, string | null>();
  const commit = (changes: readonly IntakeCollectionChange[]) => {
    current();
    const operationId = randomUUID();
    collections.commitMaintenance(
      collections.prepare(collections.openView(), {
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: before.logical.domainVersion,
        changes,
      }),
    );
  };
  commit([
    {
      area: 'builds',
      collection: name,
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: base,
    },
  ]);
  const peek = (key: string) =>
    pending.has(key) ? (pending.get(key) ?? undefined) : get(name, key);
  const count = (key: string) => {
    const raw = peek(key),
      value = Number(raw);
    if (typeof raw !== 'string' || !Number.isSafeInteger(value) || value < 0)
      throw Error('Missing literal reading count proof');
    return value;
  };
  const flush = async () => {
    if (pending.size) {
      commit(
        Array.from(pending, ([key, value]) =>
          value === null
            ? { area: 'builds', collection: name, op: 'delete', key }
            : { area: 'builds', collection: name, op: 'put', key, value },
        ),
      );
      pending.clear();
    }
    await input.onCheckpoint?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    current();
  };
  const put = async (key: string, value: string) => {
    pending.set(key, value);
    if (pending.size >= 24) await flush();
  };
  const oldCandidateCount = count('candidateCount');
  if (oldCandidateCount !== (oldWorkflow ? before.childCount(oldWorkflow, 'candidates') : 0))
    throw Error('Literal reading candidate count disagrees with its selected workflow');
  let candidateCount = oldCandidateCount,
    inspected = 0;
  for (const change of input.affected.candidateChanges) {
    current();
    const candidate = staged.resolve(change.candidateAddress),
      version = staged.resolve(change.versionAddress),
      candidateKey = 'c:' + change.candidateAddress,
      versionKey = 'v:' + change.versionAddress,
      substantiveKey = workflowSubstantiveVersionKey(staged, change.candidateAddress, version);
    for (const [record, id] of [
      [candidate, change.candidateId],
      [version, change.candidateVersionId],
    ] as const) {
      const field = staged.field(record, 'id', { bytes: 65536 });
      if (field.kind !== 'value' || field.value !== id)
        throw Error('Literal reading occurrence descriptor changed');
    }
    const selectedCandidate = staged.find('candidate', workflow, change.candidateId),
      selectedVersion = staged.find('version', candidate, change.candidateVersionId);
    if (
      !selectedCandidate ||
      staged.address(selectedCandidate) !== change.candidateAddress ||
      !selectedVersion ||
      staged.address(selectedVersion) !== change.versionAddress
    )
      throw Error('Literal reading occurrence has a different selected parent');
    if (change.kind === 'update') {
      if (
        peek(candidateKey) === undefined ||
        peek(versionKey) === undefined ||
        peek(substantiveKey) === undefined
      )
        throw Error('An updated literal reading occurrence must retain its identities and digest');
      if (
        workflowSubstantiveVersionKey(
          before,
          change.candidateAddress,
          before.resolve(change.versionAddress),
        ) !== substantiveKey
      )
        throw Error('An updated literal reading occurrence changed its retained digest');
    } else {
      if (peek(versionKey) !== undefined)
        throw Error('An appended literal reading version was already represented');
      if (peek(candidateKey) === undefined) {
        const appended = staged.childAt(workflow, 'candidates', candidateCount);
        if (!appended || staged.address(appended) !== change.candidateAddress)
          throw Error('Literal reading candidate append order changed');
        candidateCount++;
        await put(candidateKey, '1');
      }
      const retained = get(base, candidateKey) !== undefined,
        oldCount = retained
          ? before.childCount(before.resolve(change.candidateAddress), 'versions')
          : 0,
        key = 'reading-added:' + change.candidateAddress,
        added = Number(peek(key) ?? '0'),
        appended = staged.childAt(candidate, 'versions', oldCount + added);
      if (!appended || staged.address(appended) !== change.versionAddress)
        throw Error('Literal reading version append order changed');
      await put(versionKey, '1');
      // This temporary counter is removed before selection; it bounds working
      // memory while proving every new version of each affected candidate.
      await put(key, String(added + 1));
      await put(substantiveKey, '1');
    }
    if (++inspected % 24 === 0) await flush();
  }
  if (candidateCount !== staged.childCount(workflow, 'candidates'))
    throw Error('Literal reading requires the complete appended candidate scope');
  for (const change of input.affected.candidateChanges) {
    const candidate = staged.resolve(change.candidateAddress),
      retained = get(base, 'c:' + change.candidateAddress) !== undefined,
      oldCount = retained
        ? before.childCount(before.resolve(change.candidateAddress), 'versions')
        : 0;
    if (
      staged.childCount(candidate, 'versions') !==
      oldCount + Number(peek('reading-added:' + change.candidateAddress) ?? '0')
    )
      throw Error('Literal reading requires the complete appended version scope');
    if (++inspected % 24 === 0) await flush();
  }
  for (const change of input.affected.candidateChanges) {
    pending.set('reading-added:' + change.candidateAddress, null);
    if (pending.size >= 24) await flush();
  }
  await put('candidateCount', String(candidateCount));
  let batches = count('batchCount');
  if (input.packageBatch) {
    const { planAddress, operationId } = input.packageBatch,
      old = before.resolve(planAddress),
      plan = staged.resolve(planAddress),
      oldCount = before.childCount(old, 'batches'),
      appended = staged.childAt(plan, 'batches', oldCount);
    const id = appended && staged.field(appended, 'id', { bytes: 65536 });
    if (
      !oldWorkflow ||
      staged.childCount(workflow, 'plans') !== before.childCount(oldWorkflow, 'plans') ||
      staged.childCount(plan, 'batches') !== oldCount + 1 ||
      before.find('batch', old, operationId) ||
      !id ||
      id.kind !== 'value' ||
      id.value !== operationId
    )
      throw Error('Literal reading requires one new batch in the selected retained plan');
    batches++;
  }
  await put('batchCount', String(batches));
  await put('policy', WORKFLOW_READING_POLICY);
  await put('complete', JSON.stringify(input.logical));
  await flush();
  return [
    {
      area: 'builds',
      collection: WORKFLOW_READING_COLLECTION,
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: name,
    },
  ];
}
