/** Coupled acceptance uses one clinical projection and one selected envelope
 * fork per original; repeated blocks never compete for the same source head. */
import { createHash } from 'node:crypto';
import { HttpError, revision, type Database } from './database.ts';
import { canonicalLiteral, cloneLiteral } from './intake-format.ts';
import {
  collectionClinicalProjectionContextAsync,
  type CollectionClinicalReviewSession,
} from './intake-review-collection-session.ts';
import {
  prepareCollectionClinicalProjectionGroupWithEvidence,
  preparedClinicalEvidenceChanges,
  preparedClinicalProjectionMember,
  applyPreparedClinicalProjectionGroup,
  withVerifiedClinicalProjectionPublication,
  assertPreparedClinicalProjectionMember,
  disposePreparedClinicalProjection,
} from './intake-clinical-projection-plan.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  type IntakeCollectionEnvelopeReader,
} from './intake-collection-envelope.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import {
  prepareIntakeEnvelopeMutation,
  type IntakeEnvelopeDerivedPreparation,
} from './intake-envelope-mutation.ts';
import {
  createIntakeCollectionProposalChanges,
  type NativeProposalAffected,
  type NativeProposalReportEvidence,
} from './intake-collection-proposals.ts';
import { createReportSnapshotCatalog } from './intake-report-snapshot-catalog.ts';
import {
  createNativeAcceptanceEffects,
  beginOwnedGroupedAcceptanceTransition,
  nativeAcceptanceDecisions,
  nativeAcceptanceReceiptChanges,
  prepareNativeIntakeAcceptance,
  validateSingleAcceptanceReceipt,
  type NativeAcceptanceEffects,
} from './intake-collection-acceptance.ts';
import {
  nativeIntakeReceiptAppendBasis,
  retainNativeIntakeReceiptAppendBatch,
} from './intake-lookup-projection.ts';
import {
  expectIntakeFrontierMetaWrite,
  finishIntakeFrontierMetaWrite,
} from './intake-lookup-frontier-observer.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import type { IntakeReviewDecision, IntakeAtomicAcceptanceReceipt } from '../shared/intake.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';

export interface NativeAcceptanceGroupMember {
  session: CollectionClinicalReviewSession;
  expectedVersion: number;
  reviewToken: string;
  decisions: readonly IntakeReviewDecision[];
  reportEvidence: NativeProposalReportEvidence;
  nextDiscoveryOrder(): number;
}
export async function prepareNativeIntakeAcceptanceGroup(
  db: Database,
  root: string,
  profileId: string,
  input: {
    members: readonly NativeAcceptanceGroupMember[];
    operationId: string;
    fingerprint: string;
    retainReportReceipt?: boolean;
    prepareDerived(
      source: IntakeEnvelopeSource,
      value: IntakeEnvelopeDerivedPreparation & {
        affected: NativeProposalAffected;
        acceptance: NativeAcceptanceEffects;
      },
    ): Promise<{
      changes: readonly IntakeCollectionChange[];
      needsReview: boolean;
      receiptAppend?: object;
    }>;
    assertRunning?: () => void;
  },
) {
  if (!input.members.length || input.members.length > 100)
    throw new HttpError(400, 'REPORT_ACCEPTANCE_INPUT', 'Select 1–100 proposal blocks');
  const members = [] as (NativeAcceptanceGroupMember & {
    context: Awaited<ReturnType<typeof collectionClinicalProjectionContextAsync>>;
    source: Awaited<
      ReturnType<typeof collectionClinicalProjectionContextAsync>
    >['proposal']['file'];
    version: ReturnType<typeof intakeSourceVersion>;
    decisions: ReturnType<typeof nativeAcceptanceDecisions>;
  })[];
  for (const member of input.members) {
    input.assertRunning?.();
    const context = await collectionClinicalProjectionContextAsync(member.session);
    input.assertRunning?.();
    if (
      context.db !== db ||
      context.profileId !== profileId ||
      member.reviewToken !== member.session.review.reviewToken
    )
      throw new HttpError(409, 'REVIEW_CHANGED', 'Refresh the complete selected review');
    const decisions = nativeAcceptanceDecisions(
      member.session.review,
      cloneLiteral(member.decisions),
    );
    if (!decisions.length || decisions.some((d) => d.action !== 'accept'))
      throw Error('A coupled block requires explicit accepted selections');
    const source = context.proposal.file,
      version = intakeSourceVersion(db, source.id);
    if (version.version !== member.expectedVersion)
      throw new HttpError(
        409,
        'VERSION_CONFLICT',
        'This intake changed. Reload it before continuing.',
      );
    members.push({ ...member, context, source, version, decisions });
  }
  const count = members.reduce((sum, m) => sum + m.decisions.length, 0),
    bytes = members.reduce((sum, m) => sum + Number(m.context.proposal.inputFile.bytes), 0),
    candidates = new Set<string>(),
    proposals = new Set<string>();
  if (count > 1000 || bytes > 64 * 1024 * 1024)
    throw new HttpError(
      413,
      'REPORT_ACCEPTANCE_LIMIT',
      'Split this approval into bounded proposal groups',
    );
  for (const member of members) {
    const proposal = JSON.stringify([member.source.id, member.context.proposal.proposalId]);
    if (proposals.has(proposal)) throw Error('Repeated acceptance proposal block');
    proposals.add(proposal);
    for (const decision of member.decisions) {
      const record = member.session.record(decision.recordId);
      if (!record?.candidateId || !record.candidateVersionId)
        throw Error('Missing selected candidate identity');
      const key = JSON.stringify([member.source.id, record.candidateId]);
      if (candidates.has(key)) throw Error('A candidate may be selected only once per approval');
      candidates.add(key);
    }
  }
  const assertCurrent = () => {
    input.assertRunning?.();
    for (const member of members) {
      member.context.assertCurrent();
      const current = intakeSourceVersion(db, member.source.id);
      if (
        current.version !== member.version.version ||
        current.logicalBinding !== member.version.logicalBinding
      )
        throw new HttpError(409, 'VERSION_CONFLICT', 'The selected approval changed');
    }
  };
  assertCurrent();
  if (members.length === 1) {
    const member = members[0]!,
      prepared = await prepareNativeIntakeAcceptance(db, root, profileId, {
        ...member,
        operationId: input.operationId,
        fingerprint: input.fingerprint,
        retainReportReceipt: input.retainReportReceipt,
        assertRunning: input.assertRunning,
        prepareDerived: (value) => input.prepareDerived(member.source, value),
        reportReceipt({ imported, intakeVersionBefore, intakeVersionAfter, review }) {
          const records = member.decisions.map((decision) => {
            const actual = imported.clinical?.records?.find(
                (r) => r.recordId === decision.recordId,
              ),
              selected = review.records.find((r) => r.id === decision.recordId);
            if (!actual || !selected?.candidateId || !selected.candidateVersionId)
              throw Error('Missing actual approval record');
            return {
              ...actual,
              candidateId: selected.candidateId,
              candidateVersionId: selected.candidateVersionId,
            };
          });
          return {
            operationId: input.operationId,
            status: 'accepted',
            atomic: true,
            at: imported.at,
            selectedCount: records.length,
            acceptedCount: records.length,
            receipts: [
              {
                intakeId: member.source.id,
                proposalId: member.context.proposal.proposalId,
                intakeVersionBefore,
                intakeVersionAfter,
                reviewToken: member.reviewToken,
                records,
              },
            ],
          };
        },
      });
    if (!prepared.prepared || !prepared.reportReceipt)
      throw Error('Resolve complete approval replay before preparation');
    return {
      receipt: prepared.reportReceipt,
      blocks: [
        { intakeId: member.source.id, imported: prepared.imported, context: member.context },
      ],
      assertCurrent: prepared.assertCurrent,
      withVerifiedPublication: prepared.withVerifiedPublication,
      apply() {
        prepared.apply();
        return structuredClone(prepared.reportReceipt!);
      },
      dispose: prepared.dispose,
    };
  }
  const projection = await prepareCollectionClinicalProjectionGroupWithEvidence(
      db,
      root,
      profileId,
      members.map((m) => ({ session: m.session, decisions: m.decisions })),
    ),
    at = new Date().toISOString();
  const prepared: Array<{
    id: string;
    source: IntakeEnvelopeSource;
    before: string | undefined;
    after: string;
    basis?: object;
    receiptAppend?: {
      proof: object;
      reader: IntakeCollectionEnvelopeReader;
      logical: string;
    };
    value: Awaited<ReturnType<typeof prepareIntakeEnvelopeMutation>>;
  }> = [];
  try {
    const versions = new Map<string, number>();
    const blocks = members.map((member, index) => {
      const actual = preparedClinicalProjectionMember(db, projection, index, member.session),
        entries = member.context.proposal.entries,
        seen = new Set<string>();
      const imported = {
        records: entries.length,
        repeatedRows: entries.reduce((n, e) => {
          const duplicate = seen.has(e.canonical);
          seen.add(e.canonical);
          return n + Number(duplicate);
        }, 0),
        matchingEarlierRows: actual.matchingEarlierRows,
        at,
        fileId: member.context.proposal.inputFile.id,
        clinical: actual.clinical,
      };
      const before = versions.get(member.source.id) ?? member.version.version;
      versions.set(member.source.id, before + 1);
      const records = member.decisions.map((decision) => {
        const record = actual.clinical?.records?.find((r) => r.recordId === decision.recordId),
          selected = member.session.record(decision.recordId);
        if (!record || !selected?.candidateId || !selected.candidateVersionId)
          throw Error('Selected approval produced no exact clinical receipt');
        return {
          ...record,
          candidateId: selected.candidateId,
          candidateVersionId: selected.candidateVersionId,
        };
      });
      const receipt = {
        intakeId: member.source.id,
        proposalId: member.context.proposal.proposalId,
        intakeVersionBefore: before,
        intakeVersionAfter: before + 1,
        reviewToken: member.reviewToken,
        records,
      };
      validateSingleAcceptanceReceipt(
        {
          operationId: input.operationId,
          status: 'accepted',
          atomic: true,
          at,
          selectedCount: records.length,
          acceptedCount: records.length,
          receipts: [receipt],
        },
        {
          operationId: input.operationId,
          intakeId: member.source.id,
          proposalId: receipt.proposalId,
          before,
          review: member.session.review,
          imported,
          decisions: member.decisions,
        },
      );
      return {
        member,
        index,
        imported,
        receipt,
        decisionFingerprint: createHash('sha256')
          .update(canonicalLiteral({ proposalId: receipt.proposalId, decisions: member.decisions }))
          .digest('hex'),
      };
    });
    const receipt: IntakeAtomicAcceptanceReceipt = {
      operationId: input.operationId,
      status: 'accepted',
      atomic: true,
      at,
      selectedCount: count,
      acceptedCount: count,
      receipts: blocks.map((b) => b.receipt),
    };
    const grouped = new Map<string, typeof blocks>();
    for (const block of blocks) {
      let group = grouped.get(block.member.source.id);
      if (!group) grouped.set(block.member.source.id, (group = []));
      group.push(block);
    }
    const appendBases = new Map<string, object>();
    if (input.retainReportReceipt !== false)
      for (const [id, group] of grouped) {
        const first = group[0]!;
        if (!first.member.version.logicalBinding) break;
        const basis = nativeIntakeReceiptAppendBasis(
          db,
          first.member.source,
          first.member.version.logicalBinding,
        );
        if (!basis) break;
        appendBases.set(id, basis);
      }
    if (appendBases.size !== grouped.size) appendBases.clear();
    for (const [id, group] of grouped) {
      const first = group[0]!,
        source = first.member.source,
        reader = openIntakeCollectionEnvelope(db, source),
        catalog = createReportSnapshotCatalog(db, source, { assertRunning: assertCurrent }),
        acceptance = createNativeAcceptanceEffects();
      let needsReview: boolean | undefined;
      let receiptAppend:
        { proof: object; reader: IntakeCollectionEnvelopeReader; logical: string } | undefined;
      const contributors = group.map((block) => {
        const proposalId = block.member.context.proposal.proposalId,
          intake = reader.child(reader.root(), 'intake')!,
          proposal = proposalId ? reader.find('proposal', intake, proposalId) : undefined;
        if (proposalId && !proposal) throw Error('Approval proposal is not selected');
        const pin = (name: string) => {
          if (!proposal) return undefined;
          const result = reader.field(proposal, name, { bytes: 8192 });
          if (result.kind === 'missing') return undefined;
          if (
            result.kind !== 'value' ||
            (result.value !== null && typeof result.value !== 'string')
          )
            throw Error('Invalid proposal source-text pin');
          return result.value as string | null;
        };
        return createIntakeCollectionProposalChanges(
          db,
          source,
          {
            reader,
            file: source,
            proposalId,
            entries: block.member.context.proposal.entries,
            operationId: input.operationId,
            requestDigest: input.fingerprint,
            domainVersion: first.member.version.rawVersion + group.length,
            createdAt: at,
            reportEvidence: block.member.reportEvidence,
            nextDiscoveryOrder: block.member.nextDiscoveryOrder,
            sourceTextDependencyToken: pin('sourceTextDependencyToken'),
            sourceTextRevisionId: pin('sourceTextRevisionId'),
            assertRunning: assertCurrent,
            compose: {
              additionalLogicalChanges: [],
              changes: (staged) =>
                nativeAcceptanceReceiptChanges({
                  staged,
                  file: source,
                  review: block.member.session.review,
                  reviewed: true,
                  reviewToken: block.member.reviewToken,
                  decisions: block.member.decisions,
                  at,
                  effects: acceptance,
                  proposalId,
                  imported: block.imported,
                  decisionFingerprint: block.decisionFingerprint,
                  fingerprint: input.fingerprint,
                  reportReceipt:
                    block.index === 0 && input.retainReportReceipt !== false ? receipt : undefined,
                }),
            },
          },
          catalog,
        );
      });
      const affected = (): NativeProposalAffected => {
        const values = contributors.map((c) => c.affected());
        return {
          candidateChanges: values.flatMap((v) => v.candidateChanges),
          questionAddresses: values.flatMap((v) => v.questionAddresses),
          reportGroupAddresses: values.flatMap((v) => v.reportGroupAddresses),
          reportVersionChanges: values.flatMap((v) => v.reportVersionChanges ?? []),
          proposalIds: values.flatMap((v) => v.proposalIds),
        };
      };
      const value = await prepareIntakeEnvelopeMutation(db, source, {
        reader,
        operationId: input.operationId,
        requestDigest: input.fingerprint,
        domainVersion: first.member.version.rawVersion + group.length,
        assertRunning: assertCurrent,
        changes: async function* (staged) {
          for (const contributor of contributors) yield* contributor.changes(staged);
        },
        additionalLogicalChanges: () => catalog.finalChanges(),
        prepareDerived: async (value) => {
          receiptAppend = undefined;
          const derived = await input.prepareDerived(source, {
            ...value,
            affected: affected(),
            acceptance,
          });
          if (typeof derived.needsReview !== 'boolean')
            throw Error('Approval needs complete updated workflow facts');
          needsReview = derived.needsReview;
          if (derived.receiptAppend)
            receiptAppend = {
              proof: derived.receiptAppend,
              reader: value.reader,
              logical: JSON.stringify(value.logical),
            };
          return [...derived.changes, ...preparedClinicalEvidenceChanges(projection, id)];
        },
        derivedIntakeState: () => {
          if (needsReview === undefined) throw Error('Missing approval workflow facts');
          return needsReview ? 'needs_review' : 'imported';
        },
      });
      if (!value.prepared) throw Error('Resolve complete approval replay before preparation');
      prepared.push({
        id,
        source,
        before: first.member.version.logicalBinding,
        after: JSON.stringify(
          selectedEnvelopeStore(db, source).collections.inspectPrepared(value.prepared).logical,
        ),
        basis: appendBases.get(id),
        receiptAppend,
        value,
      });
    }
    assertCurrent();
    let disposed = false;
    return {
      receipt,
      blocks: blocks.map((b) => ({
        intakeId: b.member.source.id,
        imported: b.imported,
        context: b.member.context,
      })),
      assertCurrent,
      withVerifiedPublication<T>(complete: () => T): Promise<T> {
        if (disposed) throw Error('Disposed approval preparation');
        return withVerifiedClinicalProjectionPublication(db, projection, complete);
      },
      apply() {
        if (disposed) throw Error('Disposed approval preparation');
        assertCurrent();
        retainNativeIntakeReceiptAppendBatch(db, []);
        const append =
          input.retainReportReceipt !== false &&
          prepared.every(
            (item) =>
              !!item.before &&
              !!item.basis &&
              !!item.receiptAppend &&
              item.receiptAppend.logical === item.after,
          )
            ? prepared.map((item) => ({
                source: item.source,
                before: item.before!,
                after: item.after,
                basis: item.basis!,
                proof: item.receiptAppend!.proof,
                reader: item.receiptAppend!.reader,
              }))
            : undefined;
        const transition = append?.length ? beginOwnedGroupedAcceptanceTransition(db) : undefined;
        try {
          applyPreparedClinicalProjectionGroup(db, projection);
          for (const member of blocks)
            assertPreparedClinicalProjectionMember(
              db,
              projection,
              member.index,
              member.member.session,
            );
          for (const item of prepared)
            selectedEnvelopeStore(db, { id: item.id }).collections.stage(item.value.prepared!);
          for (const block of blocks) {
            const { context, source } = block.member,
              clinical = block.imported.clinical;
            db.prepare(
              "UPDATE manual_batches SET status='verified',verified_at=?,coverage_json=?,notes=? WHERE id=?",
            ).run(
              block.imported.at,
              JSON.stringify({
                sourceIntake: source.id,
                rawPreserved: true,
                validation: context.validation,
                imported: block.imported,
                clinicalProjection: clinical ? 'reviewed' : 'none',
              }),
              clinical
                ? 'Explicitly accepted clinical projection, original assertions and evidence preserved.'
                : 'Verified original hash and JSONL syntax/provenance. All source occurrences retained; repeated content is counted, not merged as clinical events. Clinical mapping and source truth are unreviewed.',
              source.batch_id,
            );
          }
          if (transition) {
            const expectedRevision = expectIntakeFrontierMetaWrite(db, 'intake_mutation_revision', [
              'insert',
              'update',
            ]);
            let revisionWritten = false;
            try {
              revisionWritten =
                db
                  .prepare(
                    "INSERT INTO app_meta(key,value) VALUES('intake_mutation_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                  )
                  .run(String(revision(db) + 1)).changes === 1;
            } finally {
              finishIntakeFrontierMetaWrite(db, expectedRevision, revisionWritten);
            }
            transition.seal({
              operationId: input.operationId,
              fingerprint: input.fingerprint,
              receipt,
              sources: append!,
            });
          }
          return structuredClone(receipt);
        } catch (error) {
          transition?.close();
          throw error;
        }
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        disposePreparedClinicalProjection(projection);
        for (const item of prepared)
          selectedEnvelopeStore(db, { id: item.id }).collections.disposePreparation(
            item.value.prepared!,
          );
      },
    };
  } catch (error) {
    disposePreparedClinicalProjection(projection);
    for (const item of prepared)
      selectedEnvelopeStore(db, { id: item.id }).collections.disposePreparation(
        item.value.prepared!,
      );
    throw error;
  }
}
