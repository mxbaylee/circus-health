/** Ordered section maps share unchanged entries across typed domain commands. */
import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import type { IntakeEnvelopeDerivedPreparation } from './intake-envelope-mutation.ts';
import type { NativeProposalAffected } from './intake-collection-proposals.ts';
import type { NativeAcceptanceEffects } from './intake-collection-acceptance.ts';
import type { WorkflowDraftEffects } from './intake-workflow-draft-index.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import {
  collectionModelIntakePins,
  type ModelSectionManifest,
} from './intake-model-collection-backend.ts';
import { MODEL_INTAKE_SECTIONS, type ModelIntakeSection } from './intake-model-context.ts';
import { modelIntakeSectionOrder } from './intake-model-section-index.ts';

export async function prepareCollectionModelDerived(
  db: Database,
  source: IntakeEnvelopeSource,
  input: IntakeEnvelopeDerivedPreparation & {
    affected: NativeProposalAffected;
    acceptance?: NativeAcceptanceEffects;
    draft?: WorkflowDraftEffects;
    mappingVersion: string;
    packageBatch?: { planAddress: string; operationId: string };
    assertRunning?: () => void;
    onCheckpoint?: () => void | Promise<void>;
  },
) {
  const before = openIntakeCollectionEnvelope(db, source),
    after = input.reader;
  const { collections } = selectedEnvelopeStore(db, source);
  const pins = collectionModelIntakePins(db, source, input.mappingVersion);
  const get = (key: string) =>
    collections.get(collections.openView(), 'builds', 'model.sections', key);
  const raw = get('$complete');
  if (typeof raw !== 'string') return [];
  const control = JSON.parse(raw) as { format: string; pins: unknown; externalSections: string[] };
  if (
    control.format !== 'health-intake-model-index-v3' ||
    JSON.stringify(control.pins) !== JSON.stringify(pins)
  )
    return [];
  const nextPins = {
    ...pins,
    logicalRoot: input.logical.root?.hash || '',
    domainVersion: input.logical.domainVersion,
    version: pins.version + input.logical.domainVersion - pins.domainVersion,
  };
  const manifests = new Map<ModelIntakeSection, ModelSectionManifest>();
  for (const section of MODEL_INTAKE_SECTIONS) {
    if (section === 'mapping_rules' || control.externalSections.includes(section)) continue;
    const raw = get(section);
    if (typeof raw !== 'string') throw Error('Incomplete selected model section inventory');
    const value = JSON.parse(raw) as ModelSectionManifest;
    const descriptor = collections.collection(collections.openView(), 'builds', value.collection);
    if (
      value.format !== 'health-intake-model-section-v3' ||
      value.section !== section ||
      JSON.stringify(value.pins) !== JSON.stringify(pins) ||
      (descriptor && descriptor.kind !== 'map') ||
      (descriptor?.root?.hash || '') !== value.root ||
      (descriptor?.root?.count || 0) !== value.count
    )
      throw Error('Selected model section proof conflicts');
    manifests.set(section, value);
  }
  const prefix = 'model.' + randomUUID(),
    staged = new Map<ModelIntakeSection, string>();
  let changes: IntakeCollectionChange[] = [];
  const current = () => {
    input.assertRunning?.();
    before.address(before.root());
    if (
      JSON.stringify(collectionModelIntakePins(db, source, input.mappingVersion)) !==
      JSON.stringify(pins)
    )
      throw Error('Model section update pins changed');
  };
  const flush = async () => {
    current();
    if (changes.length) {
      const id = randomUUID();
      collections.commitMaintenance(
        collections.prepare(collections.openView(), {
          operationId: id,
          requestDigest: createHash('sha256').update(id).digest('hex'),
          domainVersion: before.logical.domainVersion,
          changes,
        }),
      );
      changes = [];
    }
    await input.onCheckpoint?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    current();
  };
  const emit = async (
    section: Exclude<ModelIntakeSection, 'mapping_rules'>,
    tag: string,
    records: IntakeEnvelopeRecord[],
  ) => {
    const prior = manifests.get(section);
    if (!prior) {
      if (control.externalSections.includes(section)) return;
      throw Error('Missing changed model section');
    }
    let collection = staged.get(section);
    if (!collection) {
      collection = prefix + '.' + section;
      staged.set(section, collection);
      if (prior.root)
        changes.push({
          area: 'builds',
          collection,
          op: 'adoptCollection',
          fromArea: 'builds',
          fromCollection: prior.collection,
        });
    }
    changes.push({
      area: 'builds',
      collection,
      op: 'put',
      key: modelIntakeSectionOrder(after, { section, tag, records }),
      value: JSON.stringify({ tag, records: records.map(after.address) }),
    });
    if (changes.length >= 15) await flush();
  };
  const oldIntake = before.child(before.root(), 'intake')!,
    intake = after.child(after.root(), 'intake')!;
  const oldFlow = before.child(oldIntake, 'workflow'),
    flow = after.child(intake, 'workflow');
  const oldSame = (
    kind: string,
    parent: IntakeEnvelopeRecord | undefined,
    id: string,
    address: string,
  ) => {
    const value = parent && before.find(kind, parent, id);
    return value && before.address(value) === address ? value : undefined;
  };
  const id = (record: IntakeEnvelopeRecord) => {
    const value = after.field(record, 'id', { bytes: 65536 });
    if (value.kind !== 'value' || typeof value.value !== 'string')
      throw Error('Changed model record has no public identity');
    return value.value;
  };
  for (const change of input.affected.candidateChanges) {
    const candidate = after.resolve(change.candidateAddress),
      version = after.resolve(change.versionAddress);
    const priorCandidate = oldSame(
      'candidate',
      oldFlow,
      change.candidateId,
      change.candidateAddress,
    );
    const prior = oldSame(
      'version',
      priorCandidate,
      change.candidateVersionId,
      change.versionAddress,
    );
    await emit('candidates', 'candidate_version', [candidate, version]);
    for (
      let i = prior ? before.childCount(prior, 'occurrences') : 0,
        end = after.childCount(version, 'occurrences');
      i < end;
      i++
    )
      await emit('occurrences', 'candidate_occurrence', [
        candidate,
        version,
        after.childAt(version, 'occurrences', i)!,
      ]);
  }
  for (const address of input.affected.questionAddresses) {
    const question = after.resolve(address),
      prior = oldSame('question', oldFlow, id(question), address);
    await emit('questions', 'question', [question]);
    for (
      let i = prior ? before.childCount(prior, 'answers') : 0,
        end = after.childCount(question, 'answers');
      i < end;
      i++
    )
      await emit('question_answers', 'question_answer', [
        question,
        after.childAt(question, 'answers', i)!,
      ]);
  }
  for (const address of input.affected.reportGroupAddresses) {
    const group = after.resolve(address),
      prior = oldSame('reportGroup', oldFlow, id(group), address);
    for (
      let i = prior ? before.childCount(prior, 'versions') : 0,
        end = after.childCount(group, 'versions');
      i < end;
      i++
    )
      await emit('report_scopes', 'report_group_version', [
        group,
        after.childAt(group, 'versions', i)!,
      ]);
  }
  for (
    let i = before.childCount(oldIntake, 'proposals'), end = after.childCount(intake, 'proposals');
    i < end;
    i++
  )
    await emit('proposals', 'proposal', [after.childAt(intake, 'proposals', i)!]);
  if (flow)
    for (
      let i = oldFlow ? before.childCount(oldFlow, 'operations') : 0,
        end = after.childCount(flow, 'operations');
      i < end;
      i++
    )
      await emit('operations', 'operation', [after.childAt(flow, 'operations', i)!]);
  if (input.packageBatch) {
    const plan = after.resolve(input.packageBatch.planAddress),
      batch = after.find('batch', plan, input.packageBatch.operationId);
    if (!batch) throw Error('Changed package model batch is unavailable');
    await emit('batches', 'batch', [plan, batch]);
  }
  if (input.acceptance) {
    if (!flow) throw Error('Missing accepted workflow');
    for (
      let i = oldFlow ? before.childCount(oldFlow, 'decisions') : 0,
        n = after.childCount(flow, 'decisions');
      i < n;
      i++
    )
      await emit('decisions', 'accepted_decision', [after.childAt(flow, 'decisions', i)!]);
    if (input.acceptance.importedAddress) await emit('acceptances', 'current_acceptance', [intake]);
    for (const address of input.acceptance.archivedImportAddresses)
      await emit('acceptances', 'import_history', [after.resolve(address)]);
  }
  if (input.draft) {
    for (const address of input.draft.decisionAddresses)
      await emit('decisions', 'accepted_decision', [after.resolve(address)]);
    for (const address of input.draft.draftAddresses)
      await emit('decisions', 'review_draft', [after.resolve(address)]);
  }
  await flush();
  const result: IntakeCollectionChange[] = [];
  for (const [section, previous] of manifests) {
    const collection = staged.get(section);
    const descriptor = collection
      ? collections.collection(collections.openView(), 'builds', collection)
      : undefined;
    const next = {
      ...previous,
      pins: nextPins,
      ...(collection
        ? { collection, root: descriptor?.root?.hash || '', count: descriptor?.root?.count || 0 }
        : {}),
    };
    result.push({
      area: 'builds',
      collection: 'model.sections',
      op: 'put',
      key: section,
      value: JSON.stringify(next),
    });
  }
  result.push({
    area: 'builds',
    collection: 'model.sections',
    op: 'put',
    key: '$complete',
    value: JSON.stringify({ ...control, pins: nextPins }),
  });
  return result;
}
