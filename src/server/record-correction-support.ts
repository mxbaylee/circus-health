import {
  assertClinicalOperation,
  currentClinicalOperation,
  runExclusiveClinicalOperation,
} from './clinical-operation.ts';
/** Exact, bounded supporting-original preparation for direct clinical corrections. */
import { setImmediate } from 'node:timers/promises';
import { HttpError, revision, type Database } from './database.ts';
import { assertIntakeOwner } from './intake.ts';
import { verifyIntakeFileHash } from './intake-files.ts';
import { profileOriginal } from './profile-storage.ts';
import { iterateIntakeSourceAncestry } from './intake-source-ancestry.ts';
import { intakeSourceMetadata, intakeSourceVersion } from './intake-state-access.ts';
import {
  openIntakeCollectionEnvelope,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { intakeReviewChildren, readIntakeReviewValue } from './intake-review-collection.ts';
import {
  prepareCollectionClinicalReviewAsync,
  prepareCollectionClinicalReviewDependencies,
} from './intake-review-collection-host.ts';
import { collectionClinicalProjectionContext } from './intake-review-collection-session.ts';
import { readCollectionReviewMembership } from './intake-review-membership-index.ts';
import { readRetainedPlanEvidence } from './intake-retained-plan.ts';
import { createReportSnapshotCatalog } from './intake-report-snapshot-catalog.ts';
import { openReportMemberSnapshot } from './intake-report-member-state.ts';
import type { IntakeReportMembersReference } from '../shared/intake-report-version.ts';
import type {
  CorrectionSupportingEvidence,
  CorrectionSupportingReference,
} from '../shared/record-correction.ts';

const keys = [
  'intakeId',
  'proposalId',
  'recordId',
  'candidateId',
  'candidateVersionId',
  'originalSourceFileId',
] as const;
export function correctionSupportingReferences(input: unknown): CorrectionSupportingReference[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 8)
    throw new HttpError(
      400,
      'CORRECTION_EVIDENCE',
      'Choose at most eight scoped supporting originals',
    );
  const seen = new Set<string>();
  return input.map((value) => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key as (typeof keys)[number])) ||
      keys.some((key) =>
        key === 'proposalId' && value[key] === null
          ? false
          : typeof value[key] !== 'string' || !value[key] || value[key].length > 500,
      )
    )
      throw new HttpError(
        400,
        'CORRECTION_EVIDENCE',
        'Supply the exact incoming candidate, proposal and original reference',
      );
    const key = JSON.stringify(keys.map((key) => value[key]));
    if (seen.has(key))
      throw new HttpError(400, 'CORRECTION_EVIDENCE', 'Choose each supporting occurrence once');
    seen.add(key);
    return Object.fromEntries(
      keys.map((key) => [key, value[key]]),
    ) as unknown as CorrectionSupportingReference;
  });
}

function field<T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  key: string,
): T | undefined {
  const child = view.child(record, key);
  if (child) return readIntakeReviewValue<T>(view, child, 16 * 1024);
  const value = view.field(record, key, { bytes: 16 * 1024 });
  if (value.kind === 'fragmented')
    throw new HttpError(
      409,
      'CORRECTION_EVIDENCE',
      'Supporting evidence identity needs bounded metadata',
    );
  return value.kind === 'value' ? (value.value as T) : undefined;
}
function original(db: Database, root: string, profileId: string, id: string) {
  const row = db
    .prepare('SELECT id,kind,path,sha256,bytes,details_json FROM source_files WHERE id=?')
    .get(id);
  if (!row)
    throw new HttpError(
      404,
      'CORRECTION_EVIDENCE',
      'Supporting original is not retained in this profile',
    );
  verifyIntakeFileHash(profileOriginal(root, row.path, profileId), {
    sha256: String(row.sha256),
    bytes: Number(row.bytes),
  });
  const details =
    row.kind === 'intake_original'
      ? intakeSourceMetadata(db, id)
      : (
          JSON.parse(String(row.details_json)) as {
            intake?: { originalName?: string; parentSourceFileId?: string; locator?: string };
          }
        ).intake;
  return { row, details };
}
function* supportingAncestry(db: Database, profileId: string, id: string) {
  try {
    yield* iterateIntakeSourceAncestry(db, profileId, id);
  } catch (cause) {
    if (cause instanceof HttpError && cause.status === 403) throw cause;
    throw new HttpError(
      409,
      'CORRECTION_EVIDENCE',
      'Supporting source ancestry is unavailable or invalid',
    );
  }
}
/** Correction evidence has the same checked ancestry as explicit package inspection. */
export function correctionSupportingSourceRoot(
  db: Database,
  profileId: string,
  id: string,
): string {
  let root = id;
  for (const source of supportingAncestry(db, profileId, id)) root = source.id;
  return root;
}
async function prepareSupportingSourceRoot(
  db: Database,
  profileId: string,
  id: string,
  assertRunning: () => void,
): Promise<string> {
  const ancestry = supportingAncestry(db, profileId, id);
  let root = id,
    count = 0;
  try {
    for (;;) {
      assertRunning();
      const next = ancestry.next();
      assertRunning();
      if (next.done) return root;
      root = next.value.id;
      if (++count % 64 === 0) {
        await setImmediate();
        assertRunning();
      }
    }
  } finally {
    ancestry.return(undefined);
  }
}
/** The opaque host object never comes from an HTTP request or a display page. */
export interface PreparedCorrectionSupportingEvidence {
  readonly kind: 'prepared-correction-support';
  /** Release selected issue policies after the preview or correction consumes this proof. */
  dispose(): void;
}
const prepared = new WeakMap<
  PreparedCorrectionSupportingEvidence,
  {
    db: Database;
    root: string;
    profileId: string;
    key: string;
    evidence: CorrectionSupportingEvidence[];
    assertCurrent(): void;
  }
>();
export function readPreparedCorrectionSupport(
  proof: PreparedCorrectionSupportingEvidence,
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
): CorrectionSupportingEvidence[] {
  const selected = prepared.get(proof);
  if (
    !selected ||
    selected.db !== db ||
    selected.root !== root ||
    selected.profileId !== profileId ||
    selected.key !== JSON.stringify(correctionSupportingReferences(input))
  )
    throw new HttpError(
      409,
      'CORRECTION_EVIDENCE_CHANGED',
      'Prepare this exact supporting evidence again',
    );
  selected.assertCurrent();
  return selected.evidence.map((value) => ({ ...value }));
}

/** Expensive cold dependency work and complete group traversal happen before the clinical transaction. */
export async function prepareCorrectionSupportingEvidence(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
): Promise<PreparedCorrectionSupportingEvidence> {
  return runExclusiveClinicalOperation(
    db,
    async (operation) => {
      const assertPreparing = () => assertClinicalOperation(db, operation);
      assertPreparing();
      assertIntakeOwner(db, profileId);
      const refs = correctionSupportingReferences(input),
        dependencies = new Set<string>();
      for (const ref of refs) {
        const key = JSON.stringify([ref.intakeId, ref.proposalId]);
        if (dependencies.has(key)) continue;
        await prepareCollectionClinicalReviewDependencies(
          db,
          root,
          profileId,
          ref.intakeId,
          ref.proposalId,
          { assertRunning: assertPreparing },
        );
        assertPreparing();
        dependencies.add(key);
      }
      const initialRevision = revision(db),
        assertions: (() => void)[] = [],
        evidence: CorrectionSupportingEvidence[] = [];
      const assertCurrent = () => {
        assertIntakeOwner(db, profileId);
        if (revision(db) !== initialRevision)
          throw new HttpError(
            409,
            'CORRECTION_EVIDENCE_CHANGED',
            'Records or evidence changed; review the supporting original again',
          );
        for (const assertion of assertions) assertion();
      };
      // The retained proof checks evidence authority after this operation ends.
      const assertPreparation = () => {
        assertPreparing();
        assertCurrent();
      };
      const sessions: Extract<
        Awaited<ReturnType<typeof prepareCollectionClinicalReviewAsync>>,
        { status: 'ready' }
      >['session'][] = [];
      const dispose = () => {
        for (const session of sessions) session.close();
        sessions.length = 0;
      };
      try {
        for (const ref of refs) {
          assertPreparation();
          const view = openIntakeCollectionEnvelope(db, { id: ref.intakeId }),
            intake = view.child(view.root(), 'intake')!,
            workflow = view.child(intake, 'workflow'),
            candidate = workflow && view.find('candidate', workflow, ref.candidateId),
            version =
              candidate &&
              view.childAt(candidate, 'versions', view.childCount(candidate, 'versions') - 1);
          if (!version || field(view, version, 'id') !== ref.candidateVersionId)
            throw new HttpError(
              409,
              'CORRECTION_EVIDENCE_CHANGED',
              'Review the current incoming candidate before using its original',
            );
          const selected = await prepareCollectionClinicalReviewAsync(
            db,
            root,
            profileId,
            ref.intakeId,
            ref.proposalId,
            { assertRunning: assertPreparation },
          );
          if (selected.status !== 'ready')
            throw new HttpError(
              409,
              'CORRECTION_EVIDENCE',
              'Prepare the complete selected clinical review before choosing supporting evidence',
            );
          sessions.push(selected.session);
          assertPreparation();
          const record = selected.session.record(
            ref.recordId,
            ref.candidateId,
            ref.candidateVersionId,
          );
          if (!record)
            throw new HttpError(
              409,
              'CORRECTION_EVIDENCE_CHANGED',
              'The supporting record does not belong to this exact proposal',
            );
          const sourceVersion = intakeSourceVersion(db, ref.intakeId),
            contentUrl = `/api/sources/${encodeURIComponent(ref.originalSourceFileId)}/content`,
            selectedEvidence = record.evidence.find((item) => item.contentUrl === contentUrl),
            file = original(db, root, profileId, ref.originalSourceFileId),
            membership = readCollectionReviewMembership(db, { id: ref.intakeId }, view),
            catalog = createReportSnapshotCatalog(db, { id: ref.intakeId });
          let memberId: string | undefined,
            steps = 0;
          const checkpoint = () => {
            assertPreparing();
            return ++steps % 32 === 0;
          };
          // Preserve v1's first group with this candidate/version in any retained version,
          // independently of which particular occurrence established the group.
          group: for (const group of intakeReviewChildren(view, workflow, 'reportGroups')) {
            if (checkpoint()) {
              await setImmediate();
              assertPreparation();
            }
            const id = field<string>(view, group, 'memberId');
            for (const reportVersion of intakeReviewChildren(view, group, 'versions')) {
              if (checkpoint()) {
                await setImmediate();
                assertPreparation();
              }
              if (!id) continue;
              const native =
                field(view, reportVersion, 'format') === 'health-intake-report-group-version-v2';
              const found = native
                ? openReportMemberSnapshot(
                    catalog,
                    field<IntakeReportMembersReference>(view, reportVersion, 'members')!,
                  ).member(ref.candidateId, ref.candidateVersionId)
                : membership.member(reportVersion, ref.candidateId, ref.candidateVersionId);
              if (found) {
                memberId = id;
                break group;
              }
            }
          }
          const planMember =
            memberId && workflow && view.childCount(workflow, 'plans')
              ? readRetainedPlanEvidence(db, profileId, ref.intakeId).firstMember(memberId)
              : undefined;
          const member = !planMember
            ? undefined
            : planMember.kind === 'inventory'
              ? planMember.member
              : {
                  memberId: field<string>(planMember.view, planMember.record, 'memberId')!,
                  locator: field<string>(planMember.view, planMember.record, 'locator')!,
                  sourceHash: field<string>(planMember.view, planMember.record, 'sourceHash')!,
                };
          const exactMember =
            !!member &&
            file.details?.parentSourceFileId === ref.intakeId &&
            intakeMetadataScalarMatches(file.details.locator, member.locator) &&
            file.row.sha256 === member.sourceHash;
          if (
            (!selectedEvidence && !exactMember) ||
            (await prepareSupportingSourceRoot(
              db,
              profileId,
              ref.originalSourceFileId,
              assertPreparing,
            )) !== (await prepareSupportingSourceRoot(db, profileId, ref.intakeId, assertPreparing))
          )
            throw new HttpError(
              409,
              'CORRECTION_EVIDENCE',
              'The original is not evidence of this selected incoming occurrence',
            );
          if (
            db.prepare('SELECT mime_type FROM source_files WHERE id=?').get(ref.intakeId)
              ?.mime_type === 'application/zip' &&
            ref.originalSourceFileId === ref.intakeId
          )
            throw new HttpError(
              409,
              'CORRECTION_EVIDENCE',
              'Choose the exact retained package member, not the outer delivery',
            );
          assertions.push(() => {
            view.address(view.root());
            collectionClinicalProjectionContext(selected.session);
            const current = original(db, root, profileId, ref.originalSourceFileId);
            if (JSON.stringify(current) !== JSON.stringify(file))
              throw new HttpError(
                409,
                'CORRECTION_EVIDENCE_CHANGED',
                'The supporting original changed',
              );
          });
          evidence.push({
            ...ref,
            intakeVersion: sourceVersion.version,
            originalSourceHash: String(file.row.sha256),
            filename: file.details?.originalName
              ? intakeMetadataLabel(file.details.originalName)
              : String(file.row.path).split('/').at(-1)!,
            contentUrl,
            locator: exactMember ? member!.locator : selectedEvidence!.locator,
            memberId: exactMember ? member!.memberId : null,
            title: record.title,
          });
        }
        assertPreparation();
        const proof: PreparedCorrectionSupportingEvidence = Object.freeze({
          kind: 'prepared-correction-support',
          dispose() {
            prepared.delete(proof);
            dispose();
          },
        });
        prepared.set(proof, {
          db,
          root,
          profileId,
          key: JSON.stringify(refs),
          evidence,
          assertCurrent,
        });
        return proof;
      } catch (error) {
        dispose();
        throw error;
      }
    },
    { operation: currentClinicalOperation(db), onDiscardResult: (value) => value.dispose() },
  );
}
import { intakeMetadataLabel, intakeMetadataScalarMatches } from './intake-compact-scalar.ts';
