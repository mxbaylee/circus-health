/** Changed-proposal participant. Checkpoints stay auxiliary until the host selects
 * its final envelope, semantic joins, reverse scopes and summary atomically. */
import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  type IntakeCollectionEnvelopeReader,
} from './intake-collection-envelope.ts';
import type { IntakeEnvelopeDerivedPreparation } from './intake-envelope-mutation.ts';
import type { NativeProposalAffected } from './intake-collection-proposals.ts';
import type { NativeAcceptanceEffects } from './intake-collection-acceptance.ts';
import { workflowAcceptanceIndexContributions } from './intake-workflow-acceptance-index.ts';
import {
  workflowDraftIndexContributions,
  type WorkflowDraftEffects,
} from './intake-workflow-draft-index.ts';
import { readSelectedManualSourceReceipt } from './intake-manual-receipt.ts';
import { legacyDraftPolicyContributions } from './intake-draft-policy-index.ts';
import { recordCollectionReaderCoverageTransition } from './intake-source-reader-index.ts';
import { recordCollectionQueueTransition } from './intake-queue-transitions.ts';
import { collectionPeoplePreserveDerived } from './intake-people-collection.ts';
import { prepareReviewQuestionDerived } from './intake-review-question-state.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import { schemaKey } from './intake-envelope-schema.ts';
import { collectionModelIntakePins } from './intake-model-collection-backend.ts';
import { prepareCollectionModelDerived } from './intake-model-section-update.ts';
import { prepareCollectionReviewMembershipDerived } from './intake-review-membership-index.ts';
import { collectionWorkflowCountReader } from './intake-workflow-collection-reader.ts';
import {
  workflowQuestionNeedsAnswer,
  workflowVersionIsSourceContext,
} from './intake-workflow-reader.ts';
import { workflowCountsFromFacts, type WorkflowCountFacts } from './intake-workflow-counts.ts';
import {
  readVerifiedWorkflowSummary,
  WORKFLOW_COUNT_POLICY,
  type WorkflowSummaryManifest,
} from './intake-workflow-state.ts';
import {
  WORKFLOW_DEPENDENCY_POLICY,
  workflowDependencyPrefix,
  workflowDependencyOrder,
  workflowSubstantiveVersionKey,
  type WorkflowCandidateDependency,
  type WorkflowVersionDependency,
  type WorkflowQuestionDependency,
} from './intake-workflow-dependencies.ts';
import {
  proposalLookupIndexContributions,
  acceptanceLookupIndexContributions,
} from './intake-lookup-proposal.ts';
import type { WorkflowIndexContribution } from './intake-workflow-index.ts';
import {
  INTAKE_LOOKUP_INDEX_COLLECTION,
  INTAKE_LOOKUP_INDEX_POLICY,
} from './intake-lookup-state.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const empty = (): WorkflowCountFacts => ({
  pendingCount: 0,
  unansweredCount: 0,
  pendingWorkCount: 0,
  reviewLaterCount: 0,
  pendingPackageFailures: 0,
});
const fields = Object.keys(empty()) as (keyof WorkflowCountFacts)[];

export interface WorkflowProposalUpdate extends IntakeEnvelopeDerivedPreparation {
  affected: NativeProposalAffected;
  acceptance?: NativeAcceptanceEffects;
  draft?: WorkflowDraftEffects;
  acceptanceLookupReceipts?: {
    reportAcceptanceAddresses: readonly string[];
    identityReceiptAddresses: readonly string[];
  };
  onAcceptanceLookupContribution?: (
    contribution: WorkflowIndexContribution,
    reader: IntakeCollectionEnvelopeReader,
  ) => void;
  onAcceptanceLookupComplete?: () => void;
  mappingVersion: string;
  currentMappingVersion?: () => string;
  /** Complete retained source-context classification, with the staged occurrence view. */
  isSourceContextVersion(versionId: string, view: IntakeCollectionEnvelopeReader): boolean;
  /** Complete additional classifier dependency fan-out, streamed from checked membership. */
  additionalVersionIds?: Iterable<string> | AsyncIterable<string>;
  packageBatch?: { planAddress: string; operationId: string; pendingDelta: number };
  assertRunning?: () => void;
  onCheckpoint?: () => void | Promise<void>;
  /** Exact prospective facts, before the host selects this prepared root. */
  onFacts?: (facts: Readonly<WorkflowCountFacts>) => void;
}
interface ReceiptAppendProof {
  db: Database;
  sourceId: string;
  sourceHash: string | undefined;
  reader: IntakeCollectionEnvelopeReader;
  before: string;
  after: string;
  rows: readonly { operation: string; address: string }[];
}
const receiptAppendProofs = new WeakMap<object, ReceiptAppendProof>();
export function consumeWorkflowReceiptAppendProof(
  proof: object,
  db: Database,
  source: IntakeEnvelopeSource,
  reader: IntakeCollectionEnvelopeReader,
  before: string,
  after: string,
): readonly { operation: string; address: string }[] | undefined {
  const retained = receiptAppendProofs.get(proof);
  if (
    retained?.db === db &&
    retained.sourceId === source.id &&
    retained.sourceHash === source.sha256 &&
    retained.reader === reader &&
    retained.before === before &&
    retained.after === after
  ) {
    receiptAppendProofs.delete(proof);
    return retained.rows;
  }
  return undefined;
}

/** Owned command compilers supply the closed impact family. Receipt, review
 * draft and plan replacement mutations require their own dependency reducers. */
export async function prepareWorkflowCommandDerived(
  db: Database,
  source: IntakeEnvelopeSource,
  input: WorkflowProposalUpdate & { impact: 'proposal' | 'questions' | 'metadata' },
): Promise<readonly IntakeCollectionChange[]> {
  if (input.acceptance) throw Error('Use the owned acceptance participant for receipt mutations');
  if (input.draft) throw Error('Use the owned draft participant for review mutations');
  if (
    input.impact !== 'proposal' &&
    (input.affected.candidateChanges.length ||
      input.affected.reportGroupAddresses.length ||
      input.affected.proposalIds.length ||
      input.packageBatch ||
      input.additionalVersionIds)
  )
    throw Error('Workflow command changed fields outside its declared impact family');
  if (input.impact === 'metadata' && input.affected.questionAddresses.length)
    throw Error('Metadata command changed workflow questions');
  return prepareWorkflowProposalDerived(db, source, input);
}

export async function prepareWorkflowDraftDerived(
  db: Database,
  source: IntakeEnvelopeSource,
  input: WorkflowProposalUpdate & WorkflowDraftEffects,
) {
  if (
    input.acceptance ||
    input.packageBatch ||
    input.affected.reportGroupAddresses.length ||
    input.affected.proposalIds.length ||
    input.affected.candidateChanges.some((change) => change.kind !== 'update')
  )
    throw Error('Draft command changed fields outside its owned impact family');
  let needsReview: boolean | undefined;
  const changes = await prepareWorkflowProposalDerived(db, source, {
    ...input,
    draft: {
      draftAddresses: input.draftAddresses,
      decisionAddresses: input.decisionAddresses,
      resolutionChanges: input.resolutionChanges,
    },
    onFacts(facts) {
      needsReview = workflowCountsFromFacts(facts).needsReview;
      input.onFacts?.(facts);
    },
  });
  if (needsReview === undefined)
    throw Error('Draft mutation requires a checked complete workflow summary');
  return { changes, needsReview };
}

export async function prepareWorkflowAcceptanceDerived(
  db: Database,
  source: IntakeEnvelopeSource,
  input: WorkflowProposalUpdate & { acceptance: NativeAcceptanceEffects },
) {
  const receiptRows = new Map<string, string>();
  let boundedReceiptRows = true,
    completeReceiptScope = false;
  const candidates = new Map(
    input.affected.candidateChanges.map((item) => [item.versionAddress, item]),
  );
  for (const item of input.acceptance.candidateChanges) {
    const prior = candidates.get(item.versionAddress);
    candidates.set(item.versionAddress, prior?.kind === 'append' ? prior : item);
  }
  let needsReview: boolean | undefined;
  const changes = await prepareWorkflowProposalDerived(db, source, {
    ...input,
    affected: {
      ...input.affected,
      candidateChanges: [...candidates.values()],
      questionAddresses: [
        ...new Set([...input.affected.questionAddresses, ...input.acceptance.questionAddresses]),
      ],
    },
    onFacts(facts) {
      needsReview = workflowCountsFromFacts(facts).needsReview;
      input.onFacts?.(facts);
    },
    onAcceptanceLookupContribution(contribution, reader) {
      if (
        contribution.index !== 'lookup-acceptance-operation-first' ||
        !contribution.target ||
        !boundedReceiptRows
      )
        return;
      receiptRows.set(contribution.key[0]!, reader.address(contribution.target));
      if (receiptRows.size > 64) {
        boundedReceiptRows = false;
        receiptRows.clear();
      }
    },
    onAcceptanceLookupComplete() {
      completeReceiptScope = true;
    },
  });
  if (needsReview === undefined)
    throw Error('Acceptance requires a checked complete workflow summary');
  const receiptAppend = boundedReceiptRows && completeReceiptScope ? {} : undefined;
  if (receiptAppend) {
    const before = openIntakeCollectionEnvelope(db, source, { fieldSelection: 'first' });
    receiptAppendProofs.set(receiptAppend, {
      db,
      sourceId: source.id,
      sourceHash: source.sha256,
      reader: input.reader,
      before: JSON.stringify(before.logical),
      after: JSON.stringify(input.logical),
      rows: [...receiptRows].map(([operation, address]) => ({ operation, address })),
    });
  }
  return { changes, needsReview, receiptAppend };
}

/** No prior complete proof => no derived publication; the new domain reads pending. */
export async function prepareWorkflowProposalDerived(
  db: Database,
  source: IntakeEnvelopeSource,
  input: WorkflowProposalUpdate,
): Promise<readonly IntakeCollectionChange[]> {
  const readerBatch =
    input.packageBatch &&
    (() => {
      const plan = input.reader.resolve(input.packageBatch.planAddress),
        batch = input.reader.find('batch', plan, input.packageBatch.operationId);
      if (!batch) throw Error('Missing changed reader batch');
      const count = input.reader.childCount(batch, 'coverage');
      if (count > 50) throw Error('Oversized changed reader batch');
      return {
        planAddress: input.packageBatch.planAddress,
        unitIds: Array.from({ length: count }, (_, ordinal) => {
          const value = input.reader.field(
            input.reader.childAt(batch, 'coverage', ordinal)!,
            'unitId',
            { bytes: 8192 },
          );
          if (value.kind !== 'value' || typeof value.value !== 'string')
            throw Error('Missing changed reader unit identity');
          return value.value;
        }),
      };
    })();
  recordCollectionReaderCoverageTransition(db, source, input, {
    proposalIds: input.affected.proposalIds,
    ...(readerBatch ? { batches: [readerBatch] } : {}),
  });
  recordCollectionQueueTransition(db, source, input, {
    affected: input.affected,
    acceptance: input.acceptance,
    draft: input.draft,
    packageBatch: input.packageBatch,
  });
  const modelChanges = [
    ...(await prepareReviewQuestionDerived(db, source, {
      ...input,
      questionAddresses: input.affected.questionAddresses,
    })),
    ...(input.draft ? collectionPeoplePreserveDerived(db, source, input) : []),
    ...(await prepareCollectionModelDerived(db, source, input)),
    ...(await prepareCollectionReviewMembershipDerived(db, source, input)),
  ];
  const previous = readVerifiedWorkflowSummary(db, source, input);
  if (previous.state !== 'exact') return modelChanges;
  const before = openIntakeCollectionEnvelope(db, source);
  const { collections } = selectedEnvelopeStore(db, source);
  const get = (collection: string, key: string) => {
    const value = collections.get(collections.openView(), 'builds', collection, key);
    if (value !== undefined && typeof value !== 'string')
      throw Error('Invalid workflow update cell');
    return value;
  };
  if (
    get('workflow.dependencies', 'complete') !== JSON.stringify(before.logical) ||
    get('workflow.dependencies', 'binding') !== previous.binding ||
    get('workflow.dependencies', 'policy') !== WORKFLOW_DEPENDENCY_POLICY ||
    get('envelope.indexes', 'complete') !== JSON.stringify(before.logical) ||
    get('envelope.indexes', 'policy') !== 'health-intake-workflow-index-v6'
  )
    return modelChanges;
  const raw = get('workflow.summary', 'current');
  if (!raw) throw Error('Selected workflow summary disappeared');
  const manifest = JSON.parse(raw) as WorkflowSummaryManifest;
  const oldPins = collectionModelIntakePins(db, source, input.mappingVersion);
  const pins = {
    ...oldPins,
    logicalRoot: input.logical.root?.hash || '',
    domainVersion: input.logical.domainVersion,
    version: oldPins.version + input.logical.domainVersion - oldPins.domainVersion,
  };
  const binding = hash([WORKFLOW_COUNT_POLICY, pins]);
  const build = 'workflow.' + randomUUID();
  const indexes = build + '.indexes',
    dependencies = build + '.dependencies',
    facts = build + '.facts',
    questions = build + '.questions',
    versions = build + '.versions',
    lookup = build + '.lookup';
  const updateLookup =
    get(INTAKE_LOOKUP_INDEX_COLLECTION, 'complete') === JSON.stringify(before.logical) &&
    get(INTAKE_LOOKUP_INDEX_COLLECTION, 'policy') === INTAKE_LOOKUP_INDEX_POLICY;
  const total = { ...manifest.facts };
  let pending: IntakeCollectionChange[] = [],
    inspected = 0;
  const current = () => {
    input.assertRunning?.();
    before.address(before.root());
    if (
      JSON.stringify(collectionModelIntakePins(db, source, input.mappingVersion)) !==
        JSON.stringify(oldPins) ||
      (input.currentMappingVersion && input.currentMappingVersion() !== input.mappingVersion)
    )
      throw Error('Workflow update source or policy pins changed');
  };
  const commit = (changes: IntakeCollectionChange[]) => {
    current();
    const id = randomUUID();
    collections.commitMaintenance(
      collections.prepare(collections.openView(), {
        operationId: id,
        requestDigest: hash(id),
        domainVersion: before.logical.domainVersion,
        changes,
      }),
    );
  };
  commit([
    {
      area: 'builds',
      collection: indexes,
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: 'envelope.indexes',
    },
    {
      area: 'builds',
      collection: dependencies,
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: 'workflow.dependencies',
    },
    {
      area: 'builds',
      collection: facts,
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: manifest.collection,
    },
    ...(updateLookup
      ? [
          {
            area: 'builds',
            collection: lookup,
            op: 'adoptCollection',
            fromArea: 'builds',
            fromCollection: INTAKE_LOOKUP_INDEX_COLLECTION,
          } as const,
        ]
      : []),
  ]);
  const peek = (collection: string, key: string) => {
    for (let i = pending.length - 1; i >= 0; i--) {
      const change = pending[i]!;
      if (change.collection === collection && 'key' in change && change.key === key) {
        if (change.op === 'put') return change.value;
        if (change.op === 'delete') return undefined;
      }
    }
    return get(collection, key);
  };
  const read = <T>(collection: string, key: string): T | undefined => {
    const raw = peek(collection, key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  };
  const flush = async () => {
    if (pending.length) {
      commit(pending);
      pending = [];
    }
    await input.onCheckpoint?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    current();
  };
  const put = async (collection: string, key: string, value: string) => {
    pending.push({ area: 'builds', collection, op: 'put', key, value });
    if (pending.length >= 15) await flush();
  };
  const tick = async () => {
    if (++inspected % 64 === 0) await flush();
  };
  function* range(collection: string, prefix: string): Generator<{ key: string; value: string }> {
    let after = prefix;
    do {
      current();
      const page = collections.range(collections.openView(), 'builds', collection, {
        after,
        items: 64,
        bytes: 128 * 1024,
      });
      for (const item of page.items) {
        if (!item.key.startsWith(prefix)) return;
        if (typeof item.value !== 'string') throw Error('Invalid workflow closure target');
        yield { key: item.key, value: item.value };
      }
      if (page.complete) return;
      if (!page.after || page.after === after || !page.items.length)
        throw Error('Workflow closure failed to advance');
      after = page.after;
    } while (true);
  }
  const first = (prefix: string) => range(dependencies, prefix).next().value?.value;
  const applyFact = async (key: readonly string[], after: WorkflowCountFacts) => {
    const selectedKey = schemaKey(...key);
    const old = read<{ key: readonly string[]; facts: WorkflowCountFacts }>(facts, selectedKey);
    if (old && JSON.stringify(old.key) !== JSON.stringify(key))
      throw Error('Workflow fact key conflicts');
    workflowCountsFromFacts(after);
    if (old) workflowCountsFromFacts(old.facts);
    for (const name of fields) total[name] += after[name] - (old?.facts[name] ?? 0);
    workflowCountsFromFacts(total);
    await put(facts, selectedKey, JSON.stringify({ key, facts: after }));
  };
  const staged = input.reader;
  const intake = staged.child(staged.root(), 'intake');
  const workflow = intake && staged.child(intake, 'workflow');
  if (!workflow) throw Error('Missing proposal workflow');
  const candidateIds = new Set<string>();
  const newVersionOrdinals = new Map<string, number>();
  let candidateCount = Number(peek(dependencies, 'candidateCount'));
  let questionCount = Number(peek(dependencies, 'questionCount'));
  if (![candidateCount, questionCount].every((n) => Number.isSafeInteger(n) && n >= 0))
    throw Error('Missing workflow dependency counts');
  for (const change of input.affected.candidateChanges) {
    const candidate = staged.resolve(change.candidateAddress),
      version = staged.resolve(change.versionAddress);
    if (candidate.kind !== 'candidate' || version.kind !== 'version')
      throw Error('Invalid affected workflow occurrence');
    let c = read<WorkflowCandidateDependency>(dependencies, 'c:' + change.candidateAddress);
    if (!c) {
      if (
        staged.address(staged.childAt(workflow, 'candidates', candidateCount)!) !==
        change.candidateAddress
      )
        throw Error('Incomplete appended candidate event order');
      c = {
        address: change.candidateAddress,
        id: change.candidateId,
        ordinal: candidateCount,
        factKey: ['candidate', change.candidateId, String(candidateCount++)],
        pendingVersions: 0,
        reviewLaterCount: 0,
      };
      await put(dependencies, 'c:' + c.address, JSON.stringify(c));
      await put(
        dependencies,
        workflowDependencyPrefix('candidate', c.id) + workflowDependencyOrder(c.ordinal),
        c.address,
      );
    }
    let v = read<WorkflowVersionDependency>(dependencies, 'v:' + change.versionAddress);
    if (!v) {
      if (change.kind !== 'append') throw Error('Missing existing version dependency');
      let ordinal = newVersionOrdinals.get(c.address);
      if (ordinal === undefined) {
        const prior = before.find(
          'candidate',
          before.child(before.child(before.root(), 'intake')!, 'workflow')!,
          c.id,
        );
        ordinal =
          prior && before.address(prior) === c.address ? before.childCount(prior, 'versions') : 0;
      }
      if (staged.address(staged.childAt(candidate, 'versions', ordinal)!) !== change.versionAddress)
        throw Error('Incomplete appended version event order');
      newVersionOrdinals.set(c.address, ordinal + 1);
      v = {
        address: change.versionAddress,
        candidate: c.address,
        id: change.candidateVersionId,
        candidateOrdinal: c.ordinal,
        ordinal,
        pending: false,
        reviewLater: false,
      };
      await put(dependencies, 'v:' + v.address, JSON.stringify(v));
      await put(dependencies, workflowSubstantiveVersionKey(staged, c.address, version), '1');
      await put(
        dependencies,
        workflowDependencyPrefix('version', v.id) +
          workflowDependencyOrder(c.ordinal) +
          ':' +
          workflowDependencyOrder(ordinal),
        v.address,
      );
    }
    if (
      v.id !== change.candidateVersionId ||
      c.id !== change.candidateId ||
      v.candidate !== c.address
    )
      throw Error('Affected workflow identity conflicts with dependency proof');
    const previousOccurrences =
      change.kind === 'append'
        ? 0
        : before.childCount(before.resolve(change.versionAddress), 'occurrences');
    for (
      let ordinal = previousOccurrences, count = staged.childCount(version, 'occurrences');
      ordinal < count;
      ordinal++
    ) {
      const occurrence = staged.childAt(version, 'occurrences', ordinal)!,
        proposal = staged.field(occurrence, 'proposalId', { bytes: 8192 }),
        record = staged.field(occurrence, 'recordId', { bytes: 8192 });
      if (
        proposal.kind === 'fragmented' ||
        (proposal.kind === 'value' &&
          proposal.value !== null &&
          typeof proposal.value !== 'string') ||
        record.kind !== 'value' ||
        typeof record.value !== 'string'
      )
        throw Error('Invalid changed occurrence identity');
      await put(
        indexes,
        schemaKey(
          'version-occurrence-last',
          change.versionAddress,
          JSON.stringify(proposal.kind === 'value' ? proposal.value : null),
          record.value,
        ),
        staged.address(occurrence),
      );
      await tick();
    }
    await put(versions, schemaKey(v.id), v.id);
    candidateIds.add(c.id);
  }
  await put(dependencies, 'candidateCount', String(candidateCount));
  for await (const id of input.additionalVersionIds ?? []) {
    if (typeof id !== 'string' || Buffer.byteLength(id) > 65536)
      throw Error('Invalid classifier dependency identity');
    await put(versions, schemaKey(id), id);
    await tick();
  }
  if (input.acceptance) {
    for (const contribution of workflowAcceptanceIndexContributions(
      before,
      staged,
      input.acceptance,
      input.acceptanceLookupReceipts?.identityReceiptAddresses ??
        input.acceptance.identityReceiptAddresses,
    )) {
      if (!contribution.target) throw Error('Acceptance cannot delete a retained semantic target');
      const key = schemaKey(contribution.index, ...contribution.key);
      await put(indexes, key, staged.address(contribution.target));
      if (contribution.rank) await put(indexes, 'rank:' + key, JSON.stringify(contribution.rank));
      if (contribution.index === 'acceptance-version-last')
        await put(versions, schemaKey(contribution.key[0]), contribution.key[0]!);
      if (contribution.index === 'person-assignment-target')
        await put(versions, schemaKey(contribution.key[2]), contribution.key[2]!);
    }
  }
  if (input.draft) {
    for (const contribution of workflowDraftIndexContributions(before, staged, input.draft)) {
      if (!contribution.target)
        throw Error('Draft command cannot delete retained semantic history');
      await put(
        indexes,
        schemaKey(contribution.index, ...contribution.key),
        staged.address(contribution.target),
      );
      const versionId =
        contribution.index === 'draft-version-last'
          ? contribution.key[0]
          : contribution.index === 'draft-record-version-last'
            ? contribution.key[2]
            : contribution.key[1];
      if (!versionId) throw Error('Draft contribution has no version identity');
      await put(versions, schemaKey(versionId), versionId);
    }
    for (const contribution of legacyDraftPolicyContributions(
      staged,
      input.draft.draftAddresses.map((address) => staged.resolve(address)),
    )) {
      if ('checkpoint' in contribution) {
        await flush();
        await tick();
      } else await put(indexes, contribution.key, contribution.value);
    }
  }
  const oldIntakeForProposals = before.child(before.root(), 'intake')!;
  const proposalIds = new Set(input.affected.proposalIds);
  for (
    let ordinal = before.childCount(oldIntakeForProposals, 'proposals'),
      count = staged.childCount(intake!, 'proposals');
    ordinal < count;
    ordinal++
  ) {
    const proposal = staged.childAt(intake!, 'proposals', ordinal)!;
    const id = staged.field(proposal, 'id', { bytes: 8192 });
    if (id.kind !== 'value' || typeof id.value !== 'string' || !proposalIds.has(id.value))
      throw Error('Unaccounted appended manual proposal scope');
    const receipt = readSelectedManualSourceReceipt(staged, proposal);
    if (receipt?.operationId) {
      const key = schemaKey('manual-source-operation-first', receipt.operationId);
      if (peek(indexes, key) === undefined) await put(indexes, key, staged.address(proposal));
    }
  }
  await flush();
  for (const { value: id } of range(versions, '')) {
    const address = first(workflowDependencyPrefix('version', id));
    if (!address) continue;
    await put(indexes, schemaKey('workflow-version-last', id), address);
  }
  for (const id of candidateIds) {
    const address = first(workflowDependencyPrefix('candidate', id));
    if (!address) throw Error('Missing selected candidate occurrence');
    const candidate = staged.resolve(address),
      count = staged.childCount(candidate, 'versions');
    const key = schemaKey('candidate-version-last', id);
    if (count)
      await put(indexes, key, staged.address(staged.childAt(candidate, 'versions', count - 1)!));
    else pending.push({ area: 'builds', collection: indexes, op: 'delete', key });
  }
  const beforeFirst = openIntakeCollectionEnvelope(db, source, { fieldSelection: 'first' });
  const afterFirst = staged.subtree(staged.root(), { fieldSelection: 'first' });
  const lookupContributions = input.acceptance
    ? acceptanceLookupIndexContributions(
        db,
        beforeFirst,
        afterFirst,
        input.affected.reportGroupAddresses,
        {
          source,
          reportAcceptanceAddresses:
            input.acceptanceLookupReceipts?.reportAcceptanceAddresses ??
            input.acceptance.reportAcceptanceAddresses,
          identityReceiptAddresses:
            input.acceptanceLookupReceipts?.identityReceiptAddresses ??
            input.acceptance.identityReceiptAddresses,
        },
      )
    : proposalLookupIndexContributions(
        db,
        beforeFirst,
        afterFirst,
        input.affected.reportGroupAddresses,
        { source, unchangedLookupScopes: true },
      );
  for (const contribution of lookupContributions) {
    input.onAcceptanceLookupContribution?.(contribution, afterFirst);
    const key = schemaKey(contribution.index, ...contribution.key);
    for (const collection of updateLookup ? [indexes, lookup] : [indexes]) {
      if (contribution.target) await put(collection, key, afterFirst.address(contribution.target));
      else pending.push({ area: 'builds', collection, op: 'delete', key });
    }
  }
  if (input.acceptance) input.onAcceptanceLookupComplete?.();
  await flush();
  const overlay: IntakeCollectionEnvelopeReader = {
    ...staged,
    lookup(index, key) {
      const address = peek(indexes, schemaKey(index, ...key));
      return address === undefined ? undefined : staged.resolve(address);
    },
  };
  const reader = collectionWorkflowCountReader(overlay, {
    isSourceContextVersion: (id) => input.isSourceContextVersion(id, overlay),
  });
  for (const { value: id } of range(versions, '')) {
    for (const item of range(dependencies, workflowDependencyPrefix('version', id))) {
      const old = read<WorkflowVersionDependency>(dependencies, 'v:' + item.value);
      if (!old) throw Error('Incomplete version dependency proof');
      const version = reader.versionHeader(staged.resolve(old.address));
      const active =
        version.status === 'pending' &&
        !version.peopleOnly &&
        !workflowVersionIsSourceContext(reader, version);
      const later = active && reader.latestDraft(version.id)?.disposition === 'review_later';
      const c = read<WorkflowCandidateDependency>(dependencies, 'c:' + old.candidate);
      if (!c) throw Error('Missing version owner dependency');
      c.pendingVersions += Number(active) - Number(old.pending);
      c.reviewLaterCount += Number(later) - Number(old.reviewLater);
      if (![c.pendingVersions, c.reviewLaterCount].every((n) => Number.isSafeInteger(n) && n >= 0))
        throw Error('Invalid candidate aggregate delta');
      await put(
        dependencies,
        'v:' + old.address,
        JSON.stringify({ ...old, pending: active, reviewLater: later }),
      );
      await put(dependencies, 'c:' + c.address, JSON.stringify(c));
      await applyFact(c.factKey, {
        ...empty(),
        pendingCount: Number(c.pendingVersions > 0),
        reviewLaterCount: c.reviewLaterCount,
      });
      // A shared version ID can affect arbitrarily many candidate occurrences.
      // Keep its question fan-out on disk rather than growing an in-memory set.
      for (const question of range(
        dependencies,
        workflowDependencyPrefix('question-candidate', c.id),
      )) {
        await put(questions, question.value, question.value);
        await tick();
      }
      await tick();
    }
  }
  for (const address of input.affected.questionAddresses) {
    const record = staged.resolve(address),
      header = reader.questionHeader(record);
    let q = read<WorkflowQuestionDependency>(dependencies, 'q:' + address);
    if (!q) {
      if (staged.address(staged.childAt(workflow, 'questions', questionCount)!) !== address)
        throw Error('Incomplete appended question event order');
      q = {
        address,
        id: header.id,
        candidateId: header.candidateId,
        versionId: header.candidateVersionId,
        ordinal: questionCount,
        factKey: ['question', header.id, String(questionCount++)],
      };
      await put(dependencies, 'q:' + address, JSON.stringify(q));
      if (q.candidateId)
        await put(
          dependencies,
          workflowDependencyPrefix('question-candidate', q.candidateId) + address,
          address,
        );
      if (q.versionId)
        await put(
          dependencies,
          workflowDependencyPrefix('question-version', q.versionId) + address,
          address,
        );
    }
    await put(questions, address, address);
  }
  await put(dependencies, 'questionCount', String(questionCount));
  if (
    candidateCount !== staged.childCount(workflow, 'candidates') ||
    questionCount !== staged.childCount(workflow, 'questions')
  )
    throw Error('Incomplete proposal dependency event closure');
  await flush();
  function* changedVersionIds() {
    for (const item of range(versions, '')) yield item.value;
  }
  for (const [kind, ids] of [
    ['question-candidate', candidateIds],
    ['question-version', changedVersionIds()],
  ] as const)
    for (const id of ids)
      for (const item of range(dependencies, workflowDependencyPrefix(kind, id))) {
        await put(questions, item.value, item.value);
        await tick();
      }
  await flush();
  for (const item of range(questions, '')) {
    const q = read<WorkflowQuestionDependency>(dependencies, 'q:' + item.value);
    if (!q) throw Error('Missing affected question contribution');
    await applyFact(q.factKey, {
      ...empty(),
      unansweredCount: Number(
        workflowQuestionNeedsAnswer(reader, reader.questionHeader(staged.resolve(q.address))),
      ),
    });
    await tick();
  }
  if (input.packageBatch) {
    const { planAddress, operationId, pendingDelta } = input.packageBatch;
    if (!Number.isSafeInteger(pendingDelta) || Math.abs(pendingDelta) > 50)
      throw Error('Invalid package accounting delta');
    const plan = staged.resolve(planAddress),
      proof = read<{ factKey: readonly string[] }>(dependencies, 'p:' + planAddress);
    if (!proof) throw Error('Missing selected plan count dependency');
    const fact = read<{ key: readonly string[]; facts: WorkflowCountFacts }>(
      facts,
      schemaKey(...proof.factKey),
    );
    if (!fact) throw Error('Missing selected plan fact');
    await applyFact(proof.factKey, {
      ...fact.facts,
      pendingWorkCount: fact.facts.pendingWorkCount + pendingDelta,
    });
    const batch = staged.find('batch', plan, operationId);
    if (!batch) throw Error('Missing changed batch receipt');
    const count = staged.childCount(batch, 'coverage');
    if (count > 50) throw Error('Oversized changed batch scope');
    const oldBatchCount = Number(peek(dependencies, 'batchCount'));
    if (!Number.isSafeInteger(oldBatchCount) || oldBatchCount < 0)
      throw Error('Missing workflow batch-count proof');
    await put(dependencies, 'batchCount', String(oldBatchCount + 1));
    for (let i = 0; i < count; i++) {
      const coverage = staged.childAt(batch, 'coverage', i)!;
      const text = (name: string) => {
        const value = staged.field(coverage, name, { bytes: 65536 });
        if (value.kind !== 'value' || typeof value.value !== 'string')
          throw Error('Invalid batch coverage dependency');
        return value.value;
      };
      await put(
        indexes,
        schemaKey(
          'batch-unit-coverage',
          planAddress,
          operationId,
          text('unitId'),
          text('kind'),
          text('notes'),
        ),
        staged.address(coverage),
      );
    }
  }
  await put(indexes, 'complete', JSON.stringify(input.logical));
  if (updateLookup) await put(lookup, 'complete', JSON.stringify(input.logical));
  await put(dependencies, 'complete', JSON.stringify(input.logical));
  await put(dependencies, 'binding', binding);
  await flush();
  const descriptor = collections.collection(collections.openView(), 'builds', facts);
  if (!descriptor?.root) throw Error('Missing prepared workflow fact root');
  const next: WorkflowSummaryManifest = {
    format: WORKFLOW_COUNT_POLICY,
    binding,
    pins,
    facts: total,
    collection: facts,
    root: descriptor.root.hash,
    count: descriptor.root.count,
  };
  current();
  input.onFacts?.(Object.freeze({ ...total }));
  return [
    ...modelChanges,
    ...(updateLookup
      ? [
          {
            area: 'builds',
            collection: INTAKE_LOOKUP_INDEX_COLLECTION,
            op: 'adoptCollection',
            fromArea: 'builds',
            fromCollection: lookup,
          } as const,
        ]
      : []),
    {
      area: 'builds',
      collection: 'envelope.indexes',
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: indexes,
    },
    {
      area: 'builds',
      collection: 'workflow.dependencies',
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: dependencies,
    },
    {
      area: 'builds',
      collection: 'workflow.summary',
      op: 'put',
      key: 'current',
      value: JSON.stringify(next),
    },
  ];
}
