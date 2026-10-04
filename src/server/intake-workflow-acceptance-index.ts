/** Closed acceptance compiler effects: append decisions, archive current receipt,
 * and install only this command's bounded new clinical records. */
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import type { NativeAcceptanceEffects } from './intake-collection-acceptance.ts';
import type { WorkflowIndexContribution } from './intake-workflow-index.ts';

export function* workflowAcceptanceIndexContributions(
  before: IntakeCollectionEnvelopeReader,
  after: IntakeCollectionEnvelopeReader,
  effects: NativeAcceptanceEffects,
  identityReceiptAddresses: readonly string[] = [],
): Generator<WorkflowIndexContribution> {
  const oldIntake = before.child(before.root(), 'intake')!,
    intake = after.child(after.root(), 'intake')!;
  const oldFlow = before.child(oldIntake, 'workflow'),
    flow = after.child(intake, 'workflow')!;
  const read = (record: IntakeEnvelopeRecord, name: string) => {
    const value = after.field(record, name, { bytes: 65536 });
    if (value.kind === 'fragmented')
      throw Error('Acceptance index identity requires a bounded scalar');
    return value.kind === 'value' ? value.value : undefined;
  };
  const text = (record: IntakeEnvelopeRecord, name: string) => {
    const value = read(record, name);
    if (typeof value !== 'string') throw Error('Invalid acceptance index identity');
    return value;
  };
  const decisions = new Set(effects.decisionAddresses);
  for (
    let i = oldFlow ? before.childCount(oldFlow, 'decisions') : 0,
      n = after.childCount(flow, 'decisions');
    i < n;
    i++
  ) {
    const decision = after.childAt(flow, 'decisions', i)!;
    if (!decisions.has(after.address(decision)))
      throw Error('Unaccounted appended acceptance decision');
    if (text(decision, 'action') !== 'accept') throw Error('Unexpected acceptance decision action');
    const versionId = text(decision, 'candidateVersionId');
    yield { index: 'acceptance-version-last', key: [versionId], target: decision };
    yield {
      index: 'accepted-candidate-version',
      key: [JSON.stringify(read(decision, 'candidateId')), versionId],
      target: decision,
    };
  }
  const identityEffects = new Set(identityReceiptAddresses);
  for (
    let i = oldFlow ? before.childCount(oldFlow, 'identityConfirmations') : 0,
      n = after.childCount(flow, 'identityConfirmations');
    i < n;
    i++
  ) {
    const receipt = after.childAt(flow, 'identityConfirmations', i)!;
    if (!identityEffects.has(after.address(receipt)))
      throw Error('Unaccounted appended identity receipt');
    if (text(receipt, 'outcome') !== 'this_is_person' || !after.child(receipt, 'assignedPerson'))
      continue;
    const scope = after.child(receipt, 'scope');
    if (!scope) throw Error('Identity receipt scope is unavailable');
    const field =
      after.child(scope, 'assignmentTargets') || read(scope, 'assignmentTargets')
        ? 'assignmentTargets'
        : 'targets';
    for (let j = 0, count = after.childCount(scope, field); j < count; j++) {
      const target = after.childAt(scope, field, j)!;
      const candidateId = read(target, 'candidateId');
      if (candidateId !== null && typeof candidateId !== 'string')
        throw Error('Invalid assignment candidate ID');
      const prefix = [
        text(receipt, 'operationId'),
        JSON.stringify(candidateId),
        text(target, 'candidateVersionId'),
      ];
      const plural = after.child(target, 'issueIds') || read(target, 'issueIds');
      const count = plural ? after.childCount(target, 'issueIds') : 1;
      for (let k = 0; k < count; k++) {
        const issueId = plural
          ? text(after.childAt(target, 'issueIds', k)!, 'value')
          : text(target, 'issueId');
        const key = [...prefix, issueId];
        yield { index: 'person-assignment-receipt', key, target: receipt };
        yield { index: 'person-assignment-target', key, target };
      }
    }
  }
  const previous = before.child(oldIntake, 'imported');
  const oldCount = before.childCount(oldIntake, 'importHistory'),
    count = after.childCount(intake, 'importHistory');
  const archivedAddresses = effects.archivedImportAddresses,
    newAddresses = effects.importedReceiptAddresses;
  if (
    !newAddresses.length ||
    count !== oldCount + archivedAddresses.length ||
    archivedAddresses.length !== newAddresses.length - 1 + Number(!!previous)
  )
    throw Error('Acceptance changed older receipt history');
  for (let i = 0; i < archivedAddresses.length; i++) {
    const archived = after.childAt(intake, 'importHistory', oldCount + i);
    const expected =
      previous && i === 0 ? before.address(previous) : newAddresses[i - Number(!!previous)];
    if (
      !archived ||
      after.address(archived) !== archivedAddresses[i] ||
      archivedAddresses[i] !== expected
    )
      throw Error('Acceptance did not retain the receipt occurrence chain');
  }
  const imported = after.child(intake, 'imported');
  if (
    !imported ||
    after.address(imported) !== effects.importedAddress ||
    effects.importedAddress !== newAddresses.at(-1)
  )
    throw Error('New accepted receipt is unavailable');
  // The old current receipt retains its rank. Each new receipt gets its actual
  // history ordinal, or the final current rank, even in a coupled command.
  let offset = 0;
  for (let receiptOrdinal = 0; receiptOrdinal < newAddresses.length; receiptOrdinal++) {
    const current = receiptOrdinal === newAddresses.length - 1;
    const receipt = current ? imported : after.resolve(newAddresses[receiptOrdinal]!);
    const clinical = after.child(receipt, 'clinical');
    if (!clinical) throw Error('Accepted clinical receipt is unavailable');
    const recordCount = after.childCount(clinical, 'records');
    const proposalId = read(current ? intake : receipt, 'acceptedProposalId');
    if (proposalId !== null && typeof proposalId !== 'string')
      throw Error('Invalid accepted proposal ID');
    const rank = current ? count : oldCount + Number(!!previous) + receiptOrdinal;
    for (let i = recordCount - 1; i >= 0; i--) {
      const record = after.childAt(clinical, 'records', i)!;
      if (after.address(record) !== effects.acceptedRecordAddresses[offset + i])
        throw Error('Accepted record order conflicts');
      const attribution = after.child(record, 'identityAttribution'),
        groupId = attribution ? read(attribution, 'groupId') : undefined;
      if (groupId !== undefined && groupId !== null && typeof groupId !== 'string')
        throw Error('Invalid accepted attribution group');
      yield {
        index: 'accepted-destination',
        key: [JSON.stringify(proposalId), text(record, 'recordId'), (groupId || '') as string],
        target: record,
        rank: [rank, -i],
      };
    }
    offset += recordCount;
  }
  if (offset !== effects.acceptedRecordAddresses.length)
    throw Error('Accepted record effect scope is incomplete');
}
