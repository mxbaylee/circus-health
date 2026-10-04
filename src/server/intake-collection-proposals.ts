/** Native proposal persistence: addressed records and shared report member snapshots. */
import { createHash } from 'node:crypto';
import type { Database } from './database.ts';
import { HttpError } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import {
  prepareIntakeEnvelopeMutation,
  type IntakeEnvelopeMutation,
  type IntakeEnvelopeDerivedPreparation,
} from './intake-envelope-mutation.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import { canonicalLiteral, type IntakeEntry } from './intake-format.ts';
import {
  intakeCandidateId,
  intakeCandidateVersionIdForRevision,
  intakeWorkflowQuestionValue,
} from './intake-workflow.ts';
import { clinicalMappingEnvelope, sourceContextEnvelope } from './clinical-import.ts';
import { validatedIntakePeople } from './intake-people-format.ts';
import { issueKind } from './intake-review.ts';
import {
  resolveReportContextsWithLookup,
  type ReportContextLookup,
  type ReportContextPackageScope,
  type ResolvedReportContext,
} from './intake-report-context.ts';
import {
  createReportSnapshotCatalog,
  type ReportSnapshotCatalog,
  type ReportSnapshotMapWriter,
} from './intake-report-snapshot-catalog.ts';
import {
  createReportMemberSnapshot,
  openReportMemberSnapshot,
  type ReportMemberSnapshotReader,
} from './intake-report-member-state.ts';
import type { IntakeReportGroupMember, IntakeReportReference } from '../shared/intake.ts';
import type {
  IntakeReportGroupVersionV2,
  IntakeReportMembersReference,
} from '../shared/intake-report-version.ts';
import { schemaKey } from './intake-envelope-schema.ts';
import { prepareNativeReportSourceExtensions } from './intake-report-source-state.ts';
import { migrateReportMemberSnapshot } from './intake-report-member-migration.ts';
import { intakeJsonCanonicalWorkObserver } from './intake-json-canonical.ts';
import { recordIntakeWork, withIntakeWork } from './intake-work-accounting.ts';

export interface NativeProposalReportEvidence extends ReportContextPackageScope {
  contextLookup: ReportContextLookup;
}
export interface NativeReportExtensionInput {
  db: Database;
  source: IntakeEnvelopeSource;
  view: IntakeCollectionEnvelopeReader;
  workflow: IntakeEnvelopeRecord;
  group: IntakeEnvelopeRecord;
  version: IntakeReportGroupVersionV2;
  current: ReportMemberSnapshotReader;
  prior?: ReportMemberSnapshotReader;
  contributed: ReadonlySet<string>;
  catalog: ReportSnapshotCatalog;
  assertCurrent(): void;
}
export interface PrepareIntakeCollectionProposalInput {
  reader: IntakeCollectionEnvelopeReader;
  file: { id: string; sha256: string; mime_type?: string };
  proposalId: string | null;
  proposalHeader?: Record<string, unknown> & { id: string };
  entries: readonly IntakeEntry[];
  batchId?: string | null;
  /** Closed host batch participant; never read from proposal JSONL or tool arguments. */
  readingBatch?: { planAddress: string; operationId: string };
  operationId: string;
  requestDigest: string;
  domainVersion: number;
  createdAt: string;
  prepareDerived?: (
    input: IntakeEnvelopeDerivedPreparation & { affected: NativeProposalAffected },
  ) => Promise<readonly IntakeCollectionChange[]>;
  derivedIntakeState?: () => 'needs_review' | 'imported';
  sourceTextDependencyToken?: string | null;
  sourceTextRevisionId?: string | null;
  reportEvidence: NativeProposalReportEvidence;
  nextDiscoveryOrder(): number;
  compose?: {
    changes: (
      view: IntakeCollectionEnvelopeReader,
    ) => Iterable<IntakeEnvelopeMutation> | AsyncIterable<IntakeEnvelopeMutation>;
    additionalLogicalChanges: readonly IntakeCollectionChange[];
  };
  extendReportSources?: (
    input: NativeReportExtensionInput,
  ) => AsyncIterable<IntakeEnvelopeMutation>;
  migrateReportMembers?: (
    catalog: ReportSnapshotCatalog,
    view: IntakeCollectionEnvelopeReader,
    version: IntakeEnvelopeRecord,
    snapshotId: string,
  ) => Promise<IntakeReportMembersReference>;
  assertRunning?: () => void;
  onCheckpoint?: () => void | Promise<void>;
}
export interface NativeProposalAffected {
  candidateChanges: Array<{
    candidateId: string;
    candidateVersionId: string;
    candidateAddress: string;
    versionAddress: string;
    kind: 'append' | 'update';
  }>;
  questionAddresses: string[];
  reportGroupAddresses: string[];
  reportVersionChanges?: Array<{
    groupAddress: string;
    versionAddress: string;
    previousVersionAddress?: string;
    members: IntakeReportMembersReference;
    previousMembers?: IntakeReportMembersReference;
    changed: Array<{
      candidateId: string;
      candidateVersionId: string;
      occurrence: IntakeReportGroupMember['occurrences'][number];
    }>;
  }>;
  proposalIds: string[];
}
const proposalReadingProofs = new WeakMap<
  NativeProposalAffected,
  {
    db: Database;
    sourceId: string;
    sourceHash: string;
    reader: IntakeCollectionEnvelopeReader;
    before: string;
    next: string;
    batchId: string | null;
    batch?: Readonly<{ planAddress: string; operationId: string }>;
  }
>();

/** A private compiler-issued closure, rather than a caller's list of changed keys,
 * authorizes literal recounting. The selected source/root checks remain separate. */
export function assertNativeProposalReadingEffects(
  db: Database,
  source: IntakeEnvelopeSource,
  input: IntakeEnvelopeDerivedPreparation & { affected: NativeProposalAffected },
  batch?: { planAddress: string; operationId: string },
) {
  const proof = proposalReadingProofs.get(input.affected);
  if (
    !proof ||
    proof.db !== db ||
    proof.sourceId !== source.id ||
    (source.sha256 !== undefined && proof.sourceHash !== source.sha256) ||
    proof.reader !== input.reader ||
    proof.before !== JSON.stringify(input.reader.logical) ||
    proof.next !== JSON.stringify(input.logical) ||
    (proof.batchId === null && proof.batch !== undefined) ||
    (proof.batchId !== null && (!proof.batch || proof.batch.operationId !== proof.batchId)) ||
    JSON.stringify(batch ? [batch.planAddress, batch.operationId] : null) !==
      JSON.stringify(proof.batch ? [proof.batch.planAddress, proof.batch.operationId] : null)
  )
    throw Error('Literal reading requires the immutable native proposal compiler effects');
}
const digest = (text: string) => {
  recordIntakeWork('hashCalls');
  recordIntakeWork('hashedBytes', Buffer.byteLength(text));
  return createHash('sha256').update(text).digest('hex');
};
const literalHash = (value: unknown) => digest(canonicalLiteral(value));
function field(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): unknown {
  const result = view.field(record, name);
  if (result.kind === 'missing') return undefined;
  if (result.kind !== 'value') throw Error('Proposal header requires fragment access: ' + name);
  return result.value;
}
function stringField(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): string {
  const value = field(view, record, name);
  if (typeof value !== 'string') throw Error('Invalid proposal record ' + name);
  return value;
}
function* children(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): Generator<IntakeEnvelopeRecord> {
  let after: string | undefined;
  do {
    const page = view.children(record, name, { after, items: 64, bytes: 65536 });
    for (const item of page.records) yield item;
    if (page.complete) return;
    if (!page.after || page.after === after) throw Error('Proposal child page did not advance');
    after = page.after;
  } while (true);
}
interface Contribution {
  entry: IntakeEntry;
  candidateId: string;
  versionId: string;
  occurrence: IntakeReportGroupMember['occurrences'][number];
}
interface Grouped {
  id: string;
  report: IntakeReportReference | null;
  items: Contribution[];
  context: ResolvedReportContext | null;
  contextState: 'none' | 'uniform' | 'mixed';
}

/** No proposal bytes or files are published here. The host selects prepared state with its file/dependency transaction. */
export function createIntakeCollectionProposalChanges(
  db: Database,
  source: IntakeEnvelopeSource,
  input: PrepareIntakeCollectionProposalInput,
  sharedCatalog?: ReportSnapshotCatalog,
) {
  const migrate: NonNullable<PrepareIntakeCollectionProposalInput['migrateReportMembers']> =
    input.migrateReportMembers ??
    ((catalog, view, version, snapshotId) =>
      migrateReportMemberSnapshot(catalog, view, version, snapshotId, {
        onWork: intakeJsonCanonicalWorkObserver(db, 'reconstruction'),
      }));
  const countedDigest = (text: string) => withIntakeWork(db, 'warm', () => digest(text));
  const countedLiteralHash = (value: unknown) =>
    withIntakeWork(db, 'warm', () => literalHash(value));
  const catalog =
    sharedCatalog ??
    createReportSnapshotCatalog(db, source, {
      assertRunning: input.assertRunning,
      onCheckpoint: input.onCheckpoint,
    });
  const intake = input.reader.child(input.reader.root(), 'intake');
  if (!intake) throw Error('Missing intake envelope');
  const proposalAlreadyPresent =
    input.proposalId !== null && !!input.reader.find('proposal', intake, input.proposalId);
  if (input.proposalHeader && input.proposalHeader.id !== input.proposalId)
    throw Error('Proposal header identity mismatch');
  let newGroupCount = 0;
  const candidateChanges = new Map<string, NativeProposalAffected['candidateChanges'][number]>(),
    questionAddresses = new Set<string>(),
    reportGroupAddresses = new Set<string>();
  const reportVersionChanges: NonNullable<NativeProposalAffected['reportVersionChanges']> = [];
  const affected = (): NativeProposalAffected => ({
    candidateChanges: [...candidateChanges.values()],
    questionAddresses: [...questionAddresses],
    reportGroupAddresses: [...reportGroupAddresses],
    reportVersionChanges: [...reportVersionChanges],
    proposalIds: input.proposalId === null ? [] : [input.proposalId],
  });
  const changes = async function* (
    view: IntakeCollectionEnvelopeReader,
  ): AsyncGenerator<IntakeEnvelopeMutation> {
    const currentIntake = view.child(view.root(), 'intake')!;
    if (input.proposalHeader && !proposalAlreadyPresent)
      yield {
        op: 'append',
        record: currentIntake,
        field: 'proposals',
        jsonText: JSON.stringify(input.proposalHeader),
      };
    let workflow = view.child(currentIntake, 'workflow');
    if (!workflow) {
      yield {
        op: 'set',
        record: currentIntake,
        field: 'workflow',
        jsonText:
          '{"format":"health-intake-workflow-v1","candidates":[],"questions":[],"plans":[],"operations":[]}',
      };
      workflow = view.child(currentIntake, 'workflow');
    }
    if (!workflow) throw Error('Missing staged workflow');
    const contributions: Contribution[] = [];
    // Only changed proposal entries are retained here; existing candidate arrays are never materialized.
    for (const entry of input.entries) {
      catalog.assertCurrent();
      withIntakeWork(db, 'warm', () => recordIntakeWork('proposalEntriesProcessed'));
      const candidateId = intakeCandidateId(input.file, entry),
        versionId = withIntakeWork(db, 'warm', () =>
          intakeCandidateVersionIdForRevision(
            entry,
            input.sourceTextDependencyToken || input.sourceTextRevisionId,
          ),
        );
      let candidate = view.find('candidate', workflow, candidateId),
        version = candidate && view.find('version', candidate, versionId);
      const appended = !version;
      const touch = () => {
        if (!candidate || !version) return;
        const versionAddress = view.address(version);
        if (!candidateChanges.has(versionAddress))
          candidateChanges.set(versionAddress, {
            candidateId,
            candidateVersionId: versionId,
            candidateAddress: view.address(candidate),
            versionAddress,
            kind: appended ? 'append' : 'update',
          });
      };
      if (sourceContextEnvelope(entry.value)) {
        if (version) yield { op: 'set', record: version, field: 'sourceContext', jsonText: 'true' };
        touch();
        continue;
      }
      if (!candidate) {
        yield {
          op: 'append',
          record: workflow,
          field: 'candidates',
          jsonText: JSON.stringify({
            id: candidateId,
            envelopeId: entry.value.id,
            sourceSystem: entry.value.provenance.sourceSystem,
            sourceRecordId: entry.value.provenance.sourceRecordId,
            versions: [],
          }),
        };
        candidate = view.find('candidate', workflow, candidateId);
      }
      if (!candidate) throw Error('Missing staged candidate');
      if (!version) {
        yield {
          op: 'append',
          record: candidate,
          field: 'versions',
          jsonText: JSON.stringify({
            id: versionId,
            contentDigest: countedDigest(canonicalLiteral(entry.value)),
            status: 'pending',
            createdAt: input.createdAt,
            occurrences: [],
          }),
        };
        version = view.find('version', candidate, versionId);
      }
      if (!version) throw Error('Missing staged candidate version');
      touch();
      const peopleCount = validatedIntakePeople(entry.value).length;
      if (peopleCount) {
        yield { op: 'set', record: version, field: 'peopleCount', jsonText: String(peopleCount) };
        yield {
          op: 'set',
          record: version,
          field: 'peopleOnly',
          jsonText: JSON.stringify(Object.keys(clinicalMappingEnvelope(entry.value)).length === 0),
        };
      }
      const occurrence = {
        proposalId: input.proposalId,
        recordId: `${input.proposalId || input.file.id}:line:${entry.line}`,
        batchId: input.batchId ?? null,
        locator: entry.value.provenance.locator,
      };
      const count = view.childCount(version, 'occurrences'),
        snapshotId = 'candidate-occurrences:' + view.address(version) + ':' + count;
      let index = catalog.open(snapshotId),
        writer: ReportSnapshotMapWriter | undefined;
      if (!index) {
        writer = await catalog.fork();
        for (const old of children(view, version, 'occurrences'))
          await writer.put(
            schemaKey(field(view, old, 'recordId'), field(view, old, 'batchId')),
            '1',
          );
        index = writer;
      }
      const key = schemaKey(occurrence.recordId, occurrence.batchId);
      if (index.get(key) === undefined) {
        writer ??= await catalog.fork(snapshotId);
        await writer.put(key, '1');
        yield {
          op: 'append',
          record: version,
          field: 'occurrences',
          jsonText: JSON.stringify(occurrence),
        };
        await catalog.publish(
          'candidate-occurrences:' + view.address(version) + ':' + (count + 1),
          writer,
        );
      } else if (writer) await catalog.publish(snapshotId, writer);
      contributions.push({ entry, candidateId, versionId, occurrence });
      const clinical = clinicalMappingEnvelope(entry.value);
      for (const uncertainty of Array.isArray(clinical.uncertainties)
        ? clinical.uncertainties
        : []) {
        if (
          typeof uncertainty !== 'string' ||
          !uncertainty.trim() ||
          issueKind(uncertainty) === 'information' ||
          clinical.reviewIssues ||
          entry.value.reviewIssues
        )
          continue;
        const value = intakeWorkflowQuestionValue(input.file, {
          key: countedDigest(JSON.stringify([candidateId, versionId, uncertainty])),
          candidateId,
          candidateVersionId: versionId,
          prompt: uncertainty,
          locator: entry.value.provenance.locator,
        });
        const old = view.find('question', workflow, value.id);
        if (old) {
          for (const [key, expected] of Object.entries(value))
            if (field(view, old, key) !== expected)
              throw new HttpError(
                409,
                'QUESTION_CONFLICT',
                'This question key already refers to different evidence',
              );
        } else
          yield {
            op: 'append',
            record: workflow,
            field: 'questions',
            jsonText: JSON.stringify({
              ...value,
              status: 'unanswered',
              createdAt: input.createdAt,
              answers: [],
            }),
          };
        const retainedQuestion = view.find('question', workflow, value.id);
        if (!retainedQuestion) throw Error('Missing staged question');
        questionAddresses.add(view.address(retainedQuestion));
      }
    }
    const contexts = resolveReportContextsWithLookup(
        input.reportEvidence,
        input.entries,
        input.reportEvidence.contextLookup,
      ),
      groups = new Map<string, Grouped>();
    for (const item of contributions) {
      const linked = contexts.get(item.entry.line);
      let report = item.entry.value.report || linked?.report || null;
      if (
        report &&
        ((input.reportEvidence.packageEvidence && !report.memberId) ||
          (report.memberId && !input.reportEvidence.hasMember(report.memberId)))
      )
        report = null;
      const clinical = clinicalMappingEnvelope(item.entry.value),
        subject = clinical.subject === undefined ? item.entry.value.subject : clinical.subject;
      const scope = report
          ? [
              input.file.id,
              input.file.sha256,
              item.entry.value.provenance.sourceSystem,
              report.memberId || null,
              report.anchor,
              report.subject,
              typeof subject === 'string' ? subject : null,
            ]
          : ['candidate', item.candidateId],
        id = 'report-group:' + countedLiteralHash(scope),
        old = groups.get(id);
      if (old) {
        old.items.push(item);
        if (canonicalLiteral(old.context) !== canonicalLiteral(linked || null)) {
          old.context = null;
          old.contextState = 'mixed';
        }
      } else
        groups.set(id, {
          id,
          report,
          items: [item],
          context: linked || null,
          contextState: linked ? 'uniform' : 'none',
        });
    }
    for (const groupInput of groups.values()) {
      const { id, report, items, context, contextState } = groupInput;
      let group = view.find('reportGroup', workflow, id, { match: 'last' });
      if (!group) {
        const discoveryOrder = input.nextDiscoveryOrder();
        if (!Number.isSafeInteger(discoveryOrder) || discoveryOrder < 0)
          throw Error('Invalid report discovery order');
        yield {
          op: 'append',
          record: workflow,
          field: 'reportGroups',
          jsonText: JSON.stringify({
            id,
            basis: report ? 'report_anchor' : 'candidate_fallback',
            sourceFileId: input.file.id,
            sourceHash: input.file.sha256,
            sourceSystem: items[0]!.entry.value.provenance.sourceSystem,
            memberId: report?.memberId || null,
            report: report ? structuredClone(report) : null,
            versions: [],
            discoveryOrder,
          }),
        };
        group = view.find('reportGroup', workflow, id, { match: 'last' });
        newGroupCount++;
      }
      if (!group) throw Error('Missing staged report group');
      reportGroupAddresses.add(view.address(group));
      const contributed = items
          .map((item) => ({
            candidateId: item.candidateId,
            candidateVersionId: item.versionId,
            occurrence: item.occurrence,
            section: report ? item.entry.value.report?.section || null : null,
          }))
          .sort((a, b) => {
            const x = canonicalLiteral(a),
              y = canonicalLiteral(b);
            return x < y ? -1 : x > y ? 1 : 0;
          }),
        title = report?.title || items[0]!.entry.value.id,
        retainedContext = context?.context || null,
        contributionId =
          'report-contribution:' + countedLiteralHash([id, title, contributed, retainedContext]);
      const versionCount = view.childCount(group, 'versions'),
        receiptSnapshot = 'report-contributions:' + view.address(group) + ':' + versionCount;
      let receiptIndex = catalog.open(receiptSnapshot),
        receiptWriter: ReportSnapshotMapWriter | undefined;
      if (!receiptIndex) {
        receiptWriter = await catalog.fork();
        for (const previous of children(view, group, 'versions')) {
          const receipt = field(view, previous, 'contributionId');
          if (typeof receipt === 'string') await receiptWriter.put(schemaKey(receipt), '1');
        }
        receiptIndex = receiptWriter;
      }
      if (receiptIndex.get(schemaKey(contributionId)) !== undefined) {
        if (receiptWriter) await catalog.publish(receiptSnapshot, receiptWriter);
        continue;
      }
      let priorReference: IntakeReportMembersReference | undefined;
      const latest = versionCount ? view.childAt(group, 'versions', versionCount - 1) : undefined;
      if (latest) {
        const format = field(view, latest, 'format');
        if (format === 'health-intake-report-group-version-v2')
          priorReference = field(view, latest, 'members') as IntakeReportMembersReference;
        else {
          priorReference = await migrate(
            catalog,
            view,
            latest,
            'legacy-report-members:' + view.address(latest),
          );
        }
      }
      const snapshotId = 'report-members:' + contributionId,
        memberWriter = await createReportMemberSnapshot(catalog, snapshotId, priorReference),
        prior = priorReference ? openReportMemberSnapshot(catalog, priorReference) : undefined;
      for (const item of items) {
        let member = await memberWriter.include({
          candidateId: item.candidateId,
          candidateVersionId: item.versionId,
          ...(report && item.entry.value.report?.section
            ? { section: structuredClone(item.entry.value.report.section) }
            : {}),
        });
        await memberWriter.occurrence(member, item.occurrence);
      }
      const snapshot = memberWriter.reader(),
        hash = createHash('sha256');
      withIntakeWork(db, 'warm', () => {
        recordIntakeWork('hashCalls');
        recordIntakeWork('reportMemberHashItems', snapshot.reference.memberCount);
      });
      const writeHash = (piece: string) => {
        withIntakeWork(db, 'warm', () => {
          recordIntakeWork('hashedBytes', Buffer.byteLength(piece));
          recordIntakeWork('reportMemberHashBytes', Buffer.byteLength(piece));
        });
        hash.update(piece);
      };
      writeHash('[' + canonicalLiteral(id) + ',' + canonicalLiteral(contributionId) + ',');
      for (const piece of snapshot.canonicalMembers()) writeHash(piece);
      writeHash(']');
      const members = await memberWriter.finish();
      let createdAt = '';
      for (const item of items) {
        const candidate = view.find('candidate', workflow, item.candidateId),
          version = candidate && view.find('version', candidate, item.versionId),
          at = version ? stringField(view, version, 'createdAt') : '';
        if (at > createdAt) createdAt = at;
      }
      const version: IntakeReportGroupVersionV2 = {
        format: 'health-intake-report-group-version-v2',
        id: 'report-group-version:' + hash.digest('hex'),
        contributionId,
        context: retainedContext ? structuredClone(retainedContext) : null,
        contextState,
        title,
        createdAt,
        members,
      };
      yield { op: 'append', record: group, field: 'versions', jsonText: JSON.stringify(version) };
      const appendedVersion = view.childAt(group, 'versions', versionCount);
      if (!appendedVersion) throw Error('Missing appended report version');
      reportVersionChanges.push({
        groupAddress: view.address(group),
        versionAddress: view.address(appendedVersion),
        ...(latest ? { previousVersionAddress: view.address(latest) } : {}),
        members,
        ...(priorReference ? { previousMembers: priorReference } : {}),
        changed: items.map((item) => ({
          candidateId: item.candidateId,
          candidateVersionId: item.versionId,
          occurrence: item.occurrence,
        })),
      });
      receiptWriter ??= await catalog.fork(receiptSnapshot);
      await receiptWriter.put(schemaKey(contributionId), '1');
      await catalog.publish(
        'report-contributions:' + view.address(group) + ':' + (versionCount + 1),
        receiptWriter,
      );
      if (view.childCount(workflow, 'reportSourceConfirmations')) {
        const unionId = 'report-source-occurrences:' + view.address(group) + ':' + versionCount;
        let union = catalog.open(unionId);
        if (!union) {
          const writer = await catalog.fork();
          for (let ordinal = 0; ordinal < versionCount; ordinal++) {
            const old = view.childAt(group, 'versions', ordinal)!;
            const reference =
              field(view, old, 'format') === 'health-intake-report-group-version-v2'
                ? (field(view, old, 'members') as IntakeReportMembersReference)
                : await migrate(catalog, view, old, 'legacy-report-members:' + view.address(old));
            const retained = openReportMemberSnapshot(catalog, reference);
            let memberAfter: string | undefined;
            do {
              const page = retained.members({ after: memberAfter, items: 64, bytes: 65536 });
              for (const member of page.members) {
                let occurrenceAfter: string | undefined;
                do {
                  const occurrences = retained.occurrenceDescriptors(member, {
                    after: occurrenceAfter,
                    items: 64,
                    bytes: 16384,
                  });
                  for (const occurrence of occurrences.occurrences) {
                    const key = schemaKey(
                      member.candidateId,
                      member.candidateVersionId,
                      occurrence.sourceIdentity,
                    );
                    if (writer.get(key) === undefined) await writer.put(key, '1');
                  }
                  if (occurrences.complete) break;
                  occurrenceAfter = occurrences.after!;
                } while (true);
              }
              if (page.complete) break;
              memberAfter = page.after!;
            } while (true);
          }
          await catalog.publish(unionId, writer);
          union = catalog.open(unionId)!;
        }
        const historicalPrior: ReportMemberSnapshotReader = {
          ...(prior ?? snapshot),
          hasAnySourceOccurrenceIdentity(candidateId, candidateVersionId, identity) {
            if (!/^[a-f0-9]{64}$/.test(identity))
              throw Error('Invalid report source occurrence identity');
            return union!.get(schemaKey(candidateId, candidateVersionId, identity)) !== undefined;
          },
        };
        yield* (input.extendReportSources ?? prepareNativeReportSourceExtensions)({
          db,
          source,
          view,
          workflow,
          group,
          version,
          current: openReportMemberSnapshot(catalog, members),
          prior: historicalPrior,
          contributed: new Set(items.map((item) => schemaKey(item.candidateId, item.versionId))),
          catalog,
          assertCurrent: catalog.assertCurrent,
        });
        const nextUnion = await catalog.fork(unionId);
        for (const item of items) {
          const occurrence = item.occurrence,
            key = schemaKey(
              item.candidateId,
              item.versionId,
              schemaKey(
                occurrence.proposalId,
                occurrence.recordId,
                occurrence.batchId,
                occurrence.locator,
              ),
            );
          if (nextUnion.get(key) === undefined) await nextUnion.put(key, '1');
        }
        await catalog.publish(
          'report-source-occurrences:' + view.address(group) + ':' + (versionCount + 1),
          nextUnion,
        );
      }
    }
    if (input.compose) yield* input.compose.changes(view);
    yield { op: 'set', record: currentIntake, field: 'state', jsonText: '"conversion_proposed"' };
  };
  return { changes, catalog, proposalAlreadyPresent, affected, newGroupCount: () => newGroupCount };
}

/** Publish one proposal contribution set through the existing bounded owner. */
export async function prepareIntakeCollectionProposal(
  db: Database,
  source: IntakeEnvelopeSource,
  input: PrepareIntakeCollectionProposalInput,
) {
  const contribution = createIntakeCollectionProposalChanges(db, source, input);
  const result = await prepareIntakeEnvelopeMutation(db, source, {
    reader: input.reader,
    operationId: input.operationId,
    requestDigest: input.requestDigest,
    domainVersion: input.domainVersion,
    assertRunning: input.assertRunning,
    onCheckpoint: input.onCheckpoint,
    prepareDerived: input.prepareDerived
      ? (value) => {
          const affected = contribution.affected();
          affected.candidateChanges = affected.candidateChanges.map((change) =>
            Object.freeze({ ...change }),
          );
          Object.freeze(affected.candidateChanges);
          Object.freeze(affected);
          proposalReadingProofs.set(affected, {
            db,
            sourceId: source.id,
            sourceHash: input.file.sha256,
            reader: value.reader,
            before: JSON.stringify(value.reader.logical),
            next: JSON.stringify(value.logical),
            batchId: input.batchId ?? null,
            ...(input.readingBatch
              ? {
                  batch: Object.freeze({
                    planAddress: input.readingBatch.planAddress,
                    operationId: input.readingBatch.operationId,
                  }),
                }
              : {}),
          });
          return input.prepareDerived!({ ...value, affected });
        }
      : undefined,
    derivedIntakeState: input.derivedIntakeState,
    additionalLogicalChanges: async () => [
      ...(await contribution.catalog.finalChanges()),
      ...(input.compose?.additionalLogicalChanges ?? []),
    ],
    changes: contribution.changes,
  });
  return {
    ...result,
    proposalAlreadyPresent: contribution.proposalAlreadyPresent,
    newGroupCount: contribution.newGroupCount(),
    affected: contribution.affected(),
  };
}
