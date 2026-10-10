import {
  runExclusiveClinicalOperation,
  currentClinicalOperation,
  assertClinicalOperation,
  type ClinicalOperation,
} from './clinical-operation.ts';
import { collectionClinicalProjectionContextAsync } from './intake-review-collection-session.ts';
import {
  tryBorrowPreparedCollectionClinicalPolicy,
  checkedRetainedCollectionClinicalPolicyContext,
  type RetainedCollectionClinicalPolicy,
} from './intake-report-group-collection.ts';
import { createClinicalReviewArtifactProof } from './clinical-review-artifact-proof.ts';
import { ClinicalPhysicalEvidenceChanged } from './clinical-review-physical-worker.ts';
import {
  captureManagedPhysicalEpoch,
  managedPhysicalEpochCurrent,
} from './clinical-review-physical-epoch.ts';
import { runClinicalReviewWork } from './clinical-review-work.ts';
/** Native common identity uses complete repeatable authority and exact scoped references. */
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  HttpError,
  clinicalReviewRevision,
  managedDatabaseMethodEpoch,
  revision as requestRevision,
  now,
  json,
} from './database.ts';
import { recordIntakeWork, withIntakeWork } from './intake-work-accounting.ts';
import { canonicalLiteral } from './intake-format.ts';
import {
  identityScopeCommitmentsWork,
  identitySnapshotQuestionHashWork,
} from './intake-identity-commitment.ts';
import { createIdentitySnapshotDelta } from './intake-identity-snapshot-delta.ts';
import {
  currentIdentityScopeAlias,
  exactIdentityScopeAlias,
  identityScopeAliasMatches,
  publishIdentityScopeAlias,
  identityCompleteSnapshotId,
} from './intake-identity-snapshot-alias.ts';
import {
  retainIdentityWarningsSnapshot,
  retainIdentityWarningContent,
  openIdentityWarningsSnapshot,
} from './intake-identity-warnings-snapshot.ts';
import { collectSelectedEvidencedIdentityWork } from './intake-identity-name-evidence.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { reviewReadStamp } from './intake-clinical-review-read-cache.ts';
import {
  reviewPreparationMethodStamp,
  reviewPreparationStamp,
} from './clinical-review-maintenance.ts';
import {
  beginNativeIdentityPreview,
  nativeIdentityPreviewCurrent,
  readNativeIdentityPreview,
  retainNativeIdentityPreview,
  clearNativeIdentityPreviews,
  openNativeIdentityFragmentCursor,
  sealNativeIdentityFragmentCursor,
} from './intake-identity-preview-cache.ts';
import { verifyIntakeFileHashWork } from './intake-files.ts';
import { profileOriginal } from './profile-storage.ts';
import {
  assertIntakeOwner,
  verifyIntakeOriginal,
  getIntakeOriginal,
  getRetainedIntakeOriginalReference,
  getIntakeRead,
  flushIntake,
  intakeTransaction,
  withVerifiedIntakeOriginalDescriptor,
} from './intake.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  type IntakeEnvelopeRecord,
  type IntakeCollectionEnvelopeReader,
} from './intake-collection-envelope.ts';
import { intakeSourceVersion, intakeSourceMetadata } from './intake-state-access.ts';
import {
  readIntakeReviewValue,
  IntakeReviewFragmentRequired,
  intakeReviewChildren,
  collectionWorkflowReviewScope,
} from './intake-review-collection.ts';
import {
  createReportSnapshotCatalog,
  reportSnapshotInlineTextFits,
} from './intake-report-snapshot-catalog.ts';
import { openReportMemberSnapshot } from './intake-report-member-state.ts';
import {
  readNativeReviewDraft,
  readNativeReviewDraftWork,
  prepareNativeDraftHistory,
} from './intake-review-draft-state.ts';
import { prepareRetainedPlanAccess, readRetainedPlanEvidence } from './intake-retained-plan.ts';
import { prepareIntakeFilenameSummary } from './intake-summary-name.ts';
import {
  prepareCollectionClinicalReviewDependencies,
  prepareCollectionClinicalReview,
  prepareCollectionClinicalReviewAsync,
} from './intake-review-collection-host.ts';
import { prepareCollectionWorkflowReadiness } from './intake-workflow-readiness.ts';
import {
  prepareIntakeWorkflowCommand,
  retainedIntakeWorkflowCommand,
} from './intake-workflow-command.ts';
import { activeMappingRules } from './clinical-import.ts';
import { workflowHash } from './intake-workflow.ts';
import {
  IDENTITY_SNAPSHOT_FORMAT,
  openIdentityScopeSnapshot,
  readIdentitySnapshotValue,
  identitySnapshotScopeMatches,
} from './intake-identity-snapshot.ts';
import { schemaOrdinal } from './intake-envelope-schema.ts';
import {
  assessIdentityPolicyWork,
  collectEvidencedIdentityWork,
  repeatedIdentityQuestionReceiptWork,
  exactCurrentIdentityResolutionOperationIdWork,
  identityReceiptAppliesToCurrentBoundaryWork,
  identityOriginalFingerprintForMember,
  identityPersonFingerprint,
  identityTargetHasIssueWork,
  isGenericNameConfirmationWork,
  iterateCompetingIdentityBoundaries,
  identityCompetingClaimsEqualWork,
  type IdentityPolicyReceipt,
  type IdentityPolicyMember,
  type IdentityPolicyTarget,
} from './intake-identity-policy.ts';
import {
  retainSelectedIdentityGroundingWork,
  identityGroundingGeneration,
} from './intake-identity-grounding.ts';
import { selectedIdentityPeopleSnapshots } from './intake-identity-people.ts';
import { intakeCollectionCacheGeneration } from './intake-state-collections.ts';
import {
  selfSnapshot,
  applyIdentityConfirmationPeople,
  type IdentityConfirmationScope,
} from './intake-identity.ts';
import { getNote } from './notes.ts';
import { noteVisibilitySQL } from './visibility.ts';
import {
  decodeOriginalIdentityText,
  originalSubjectBirthDateEvidence,
  originalSubjectNameGrounded,
} from './intake-evidence-dates.ts';
import { readPdfIdentityPageText } from './intake-pdf-session.ts';
import { latestReviewDraftResolution } from './intake-review-draft-selection.ts';
import { reviewRecordIssues } from './intake-review-issue-state.ts';
import { reviewRecordIdentityWarnings } from './intake-review-identity-warnings.ts';
import {
  canonicalReviewValueChunks,
  registerReviewCanonicalValue,
} from './intake-review-question-state.ts';
import { selectedSequence } from './intake-selected-sequence.ts';
import type { IntakeReportMembersReference } from '../shared/intake-report-version.ts';
import type { IntakeReviewDraft, IntakeReviewIssue, IntakeReviewRecord } from '../shared/intake.ts';
import type {
  IntakeIdentityConfirmation,
  IntakeIdentityReview,
  IntakeIdentityScope,
  IntakeIdentityScopeReference,
  IntakeIdentityScopeSection,
  IntakeIdentityScopePage,
  IntakeIdentityWarning,
  IntakeIdentityPerson,
} from '../shared/intake-identity.ts';

const reject = (message: string): never => {
  throw new HttpError(409, 'IDENTITY_SCOPE', message);
};
const hash = (value: unknown) => createHash('sha256').update(canonicalLiteral(value)).digest('hex');
const SECTIONS = [
  'membership',
  'targets',
  'assignmentTargets',
  'questions',
  'competingSubjects',
] as const;
type Target = IdentityPolicyTarget;
type Context = Awaited<ReturnType<typeof open>>;
function scalar<T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): T | undefined {
  const child = view.child(record, name);
  if (child) return readIntakeReviewValue<T>(view, child, 256 * 1024);
  const result = view.field(record, name, { bytes: 256 * 1024 });
  if (result.kind === 'fragmented')
    throw new IntakeReviewFragmentRequired({
      format: 'health-intake-review-fragment-v1',
      logical: view.logical,
      address: view.address(record),
      field: name,
    });
  return result.kind === 'value' ? (result.value as T) : undefined;
}
function source(db: DatabaseSync, profileId: string, id: string) {
  assertIntakeOwner(db, profileId);
  const row = db
    .prepare("SELECT * FROM source_files WHERE id=? AND kind='intake_original'")
    .get(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Source intake not found');
  return row as unknown as {
    id: string;
    sha256: string;
    mime_type: string;
    provider_id: string;
    details_json: string;
  };
}
async function open(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  groupId: string,
  assertRunning?: () => void,
) {
  assertRunning?.();
  const file = source(db, profileId, id),
    before = intakeSourceVersion(db, id),
    revision = clinicalReviewRevision(db);
  const assertCurrent = () => {
    assertRunning?.();
    assertIntakeOwner(db, profileId);
    const current = intakeSourceVersion(db, id);
    if (
      current.version !== before.version ||
      current.logicalBinding !== before.logicalBinding ||
      clinicalReviewRevision(db) !== revision
    )
      reject('The identity scope changed; review the current original and exact members again');
  };
  const view = openIntakeCollectionEnvelope(db, file),
    intake = view.child(view.root(), 'intake')!,
    workflow = view.child(intake, 'workflow');
  const groupRecord = workflow && view.find('reportGroup', workflow, groupId);
  if (!groupRecord) throw new HttpError(404, 'REPORT_GROUP_NOT_FOUND', 'Report group not found');
  if (workflow && view.childCount(workflow, 'plans'))
    await prepareRetainedPlanAccess(db, profileId, id, {
      assertRunning: assertCurrent,
    });
  const plan =
    workflow && view.childCount(workflow, 'plans')
      ? readRetainedPlanEvidence(db, profileId, id)
      : undefined;
  const member = (memberId: string) => {
    const selected = plan?.firstMember(memberId);
    if (!selected) return undefined;
    return selected.kind === 'inventory'
      ? selected.member
      : {
          locator: scalar<string>(selected.view, selected.record, 'locator')!,
          sourceHash: scalar<string>(selected.view, selected.record, 'sourceHash')!,
        };
  };
  const memberId = scalar<string>(view, groupRecord, 'memberId');
  const selectedMember = memberId && member(memberId);
  if (selectedMember) {
    const child = identityChild(db, id, selectedMember);
    if (child) {
      const methods = managedDatabaseMethodEpoch(db);
      const assertPreparation = () => {
        assertCurrent();
        if (!methods || managedDatabaseMethodEpoch(db) !== methods)
          reject('The identity metadata preparation policy changed');
      };
      assertPreparation();
      await prepareIntakeFilenameSummary(
        db,
        { id: String(child.id), sha256: selectedMember.sourceHash },
        {
          assertRunning: assertPreparation,
        },
      );
      assertPreparation();
    }
  }
  const catalog = createReportSnapshotCatalog(db, file, {
    assertRunning: assertCurrent,
  });
  const scope = collectionWorkflowReviewScope({
    view,
    catalog,
    metadataBytes: 256 * 1024,
    readIdentityReceiptScopeState: () => {
      if (db.isTransaction) return undefined;
      assertCurrent();
      return reviewReadStamp(db);
    },
    readProofState: () => {
      if (db.isTransaction) return undefined;
      assertCurrent();
      return reviewPreparationStamp(db);
    },
    readIdentityReceiptScopeProofState: () => {
      if (db.isTransaction) return undefined;
      assertCurrent();
      return reviewPreparationStamp(db);
    },
    identityReceiptWork: (metric) => withIntakeWork(db, 'warm', () => recordIntakeWork(metric)),
    packageEvidence: file.mime_type === 'application/zip' || !!plan?.hasMembers,
    readDraft: (record) =>
      readNativeReviewDraft(
        view,
        record,
        createReportSnapshotCatalog(db, file, {
          catalog: 'review.snapshots',
          assertRunning: assertCurrent,
        }),
        256 * 1024,
        { db, source: file },
      ),
    readDraftWork: (record) =>
      readNativeReviewDraftWork(
        view,
        record,
        createReportSnapshotCatalog(db, file, {
          catalog: 'review.snapshots',
          assertRunning: assertCurrent,
        }),
        256 * 1024,
        { db, source: file },
      ),
    activeReceipt: (receipt) =>
      !db
        .prepare(
          "SELECT 1 FROM manual_batches WHERE title='Identity receipt supersession' AND json_extract(coverage_json,'$.supportOperationId')=? LIMIT 1",
        )
        .get(receipt.operationId),
    originalFingerprint: (group) =>
      identityOriginalFingerprintForMember(
        id,
        file.sha256,
        group.memberId,
        group.memberId ? member(group.memberId) : undefined,
      ),
    reportSource: () => undefined,
  });
  const group = scope.groupHeader(groupRecord),
    version = scope.currentGroupVersion(groupRecord);
  if (!version) return reject('This report has no selected membership');
  const groupVersionId = scalar<string>(view, version, 'id')!;
  const members =
    scalar(view, version, 'format') === 'health-intake-report-group-version-v2'
      ? openReportMemberSnapshot(
          catalog,
          scalar<IntakeReportMembersReference>(view, version, 'members')!,
        )
      : undefined;
  function* membership(): Generator<IdentityPolicyMember> {
    if (members) {
      for (let index = 0; index < members.reference.memberCount; index++) {
        const selected = members.memberAt(index)!;
        const sectionPieces: string[] = [];
        let sectionBytes = 0;
        for (const piece of members.canonicalSection(selected)) {
          sectionBytes += Buffer.byteLength(piece);
          if (sectionBytes > 256 * 1024)
            reject('Inspect this exact report section through its retained fragment');
          sectionPieces.push(piece);
        }
        const section = JSON.parse(sectionPieces.join(''));
        yield {
          candidateId: selected.candidateId,
          candidateVersionId: selected.candidateVersionId,
          ...(selected.sectionPresent ? { section } : {}),
          occurrences: selectedSequence(function* () {
            let after: string | undefined;
            while (true) {
              const page = members.occurrences(selected, {
                after,
                items: 64,
                bytes: 256 * 1024,
              });
              yield* page.occurrences;
              if (page.complete) return;
              if (!page.after || page.after === after)
                throw Error('Identity occurrences did not advance');
              after = page.after;
            }
          }),
        };
      }
    } else
      for (const selected of intakeReviewChildren(view, version, 'members'))
        yield {
          candidateId: scalar<string>(view, selected, 'candidateId')!,
          candidateVersionId: scalar<string>(view, selected, 'candidateVersionId')!,
          ...(view.has(selected, 'section')
            ? {
                section: scalar<IdentityPolicyMember['section']>(view, selected, 'section'),
              }
            : {}),
          occurrences: selectedSequence(function* () {
            for (const occurrence of intakeReviewChildren(view, selected, 'occurrences'))
              yield readIntakeReviewValue<
                IntakeIdentityScope['membership'][number]['occurrences'][number]
              >(view, occurrence, 256 * 1024);
          }),
        };
  }
  function* membershipChunks() {
    if (members) {
      yield* members.canonicalMembers();
      return;
    }
    yield '[';
    let comma = false;
    for (const member of membership()) {
      if (comma) yield ',';
      comma = true;
      const { occurrences, ...header } = member;
      yield '{';
      let fieldComma = false;
      for (const name of [...Object.keys(header), 'occurrences'].sort()) {
        if (fieldComma) yield ',';
        fieldComma = true;
        yield JSON.stringify(name) + ':';
        if (name !== 'occurrences') yield canonicalLiteral(header[name as keyof typeof header]);
        else {
          yield '[';
          let comma = false;
          for (const occurrence of occurrences) {
            if (comma) yield ',';
            comma = true;
            yield canonicalLiteral(occurrence);
          }
          yield ']';
        }
      }
      yield '}';
    }
    yield ']';
  }
  return {
    db,
    root,
    profileId,
    id,
    file,
    before,
    revision,
    view,
    intake,
    workflow: workflow!,
    groupRecord,
    group,
    version,
    groupVersionId,
    scope,
    member,
    membership,
    membershipChunks,
    assertCurrent,
  };
}
function identityChild(
  db: DatabaseSync,
  id: string,
  member: { sourceHash: string; locator: string },
) {
  return db
    .prepare(
      "SELECT id FROM source_files WHERE sha256=? AND json_extract(details_json,'$.intake.parentSourceFileId')=? AND (json_extract(details_json,'$.intake.locator')=? OR (json_extract(details_json,'$.intake.locator.format')=? AND json_extract(details_json,'$.intake.locator.field')='locator' AND json_extract(details_json,'$.intake.locator.scalarHash')=?))",
    )
    .get(
      member.sourceHash,
      id,
      member.locator,
      COMPACT_SCALAR_FORMAT,
      locatorScalarHash(member.locator),
    );
}
async function evidence(context: Context) {
  const { db, root, profileId, id, file, group, scope } = context;
  if (group.basis !== 'report_anchor' || !group.report?.subject)
    return reject(
      'A report and printed subject claim are required; review these records individually',
    );
  if (group.sourceFileId !== id || group.sourceHash !== file.sha256)
    return reject('This report no longer belongs to this exact original');
  let evidenceId = id;
  if (group.memberId) {
    const member = context.member(group.memberId);
    if (!member) return reject('This package occurrence is not in the retained inventory');
    const child = identityChild(db, id, member);
    if (!child || !intakeFirstLocatorMatches(db, String(child.id), member.locator))
      return reject('Open and retain this exact package member before confirming its identity');
    evidenceId = String(child.id);
  } else if (file.mime_type === 'application/zip')
    return reject('An outer package cannot supply common patient identity');
  const reference = getRetainedIntakeOriginalReference(db, root, profileId, evidenceId),
    subject = group.report.subject,
    anchor = group.report.anchor;
  let page: number | null = null,
    text: string | null = null;
  if (reference.mimeType === 'application/pdf') {
    const subjectPage = /\bpage\s+(\d+)\b/i.exec(subject.locator)?.[1],
      anchorPage = /\bpage\s+(\d+)\b/i.exec(anchor.locator)?.[1];
    if (!subjectPage || !anchorPage || subjectPage !== anchorPage)
      reject('Common PDF identity needs report and subject claims on one explicit original page');
    page = Number(subjectPage);
    text = (await readPdfIdentityPageText({ ...reference, profileId }, page)).text;
    if (!text.trim()) text = null;
  } else {
    const original = getIntakeOriginal(db, root, profileId, evidenceId);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(original.mimeType)) {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(original.bytes);
      } catch {
        return reject('This original needs individual identity review');
      }
      text = decodeOriginalIdentityText(
        text,
        reference.filenameDescriptor?.suffix ?? reference.filename,
      );
      if (original.mimeType === 'text/html')
        text = text
          .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
          .replace(/<[^>]*>/g, ' ');
    }
  }
  if (text !== null && (!text.includes(subject.text) || !text.includes(anchor.text)))
    reject(
      'The report or subject quote was not found in the original text; inspect it individually',
    );
  context.assertCurrent();
  return {
    sourceHash: reference.sourceHash,
    original: {
      filename: reference.filename,
      contentUrl: `/api/sources/${encodeURIComponent(evidenceId)}/content${page ? '#page=' + page : ''}`,
      page,
    },
    verificationMode:
      text === null ? ('human_reviewed_original' as const) : ('literal_text_match' as const),
    originalFingerprint: scope.originalFingerprint(group),
    pageText: text?.trim() ? text : null,
    patientNameGrounded: originalSubjectNameGrounded(text, subject.text, anchor.text),
  };
}
/** Private scratch holds cumulative counts and ordered policy facts, never recovery authority. */
function rows() {
  const scratch = disposableSqlite('fictional-identity-scope-');
  let artifacts: ReturnType<typeof createClinicalReviewArtifactProof> | undefined;
  scratch.db.exec(
    `CREATE TABLE pieces(section TEXT,key TEXT,ordinal INTEGER,value TEXT,PRIMARY KEY(section,key,ordinal));
    CREATE TABLE counts(section TEXT PRIMARY KEY,count INTEGER NOT NULL);
    CREATE TABLE rows(section TEXT NOT NULL,key TEXT NOT NULL,ordinal INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(section,key));
    CREATE INDEX ordered ON rows(section,ordinal);
    CREATE TABLE competing_order(key TEXT PRIMARY KEY,id TEXT,ordinal INTEGER);
    CREATE TRIGGER inserted AFTER INSERT ON rows BEGIN INSERT INTO counts VALUES(NEW.section,1) ON CONFLICT(section) DO UPDATE SET count=count+1; END;
    CREATE TRIGGER removed AFTER DELETE ON rows BEGIN UPDATE counts SET count=count-1 WHERE section=OLD.section; END;`,
  );
  const count = (section: string) =>
    Number(scratch.db.prepare('SELECT count FROM counts WHERE section=?').get(section)?.count || 0);
  const get = <T>(section: string, key: string) => {
    const row = scratch.db
      .prepare('SELECT value FROM rows WHERE section=? AND key=?')
      .get(section, key);
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  };
  const put = (section: string, key: string, value: unknown) =>
    scratch.db
      .prepare(
        'INSERT INTO rows VALUES(?,?,?,?) ON CONFLICT(section,key) DO UPDATE SET value=excluded.value',
      )
      .run(section, key, count(section), canonicalLiteral(JSON.parse(JSON.stringify(value))));
  const putStreamWork = function* (section: string, key: string, pieces: Iterable<string>) {
    scratch.db
      .prepare('INSERT OR IGNORE INTO rows VALUES(?,?,?,?)')
      .run(section, key, count(section), '');
    scratch.db.prepare('DELETE FROM pieces WHERE section=? AND key=?').run(section, key);
    let ordinal = 0;
    for (const piece of pieces)
      for (let offset = 0; offset < piece.length;) {
        let end = Math.min(piece.length, offset + 16384);
        if (end < piece.length && /[\uD800-\uDBFF]/.test(piece[end - 1]!)) end--;
        scratch.db
          .prepare('INSERT INTO pieces VALUES(?,?,?,?)')
          .run(section, key, ordinal++, piece.slice(offset, end));
        offset = end;
        yield;
      }
  };
  const putStream = (...args: Parameters<typeof putStreamWork>) => {
    const work = putStreamWork(...args);
    while (!work.next().done) {}
  };

  const putCompeting = (
    key: string,
    claim: NonNullable<IntakeIdentityScope['competingSubjects']>[number],
  ) => {
    const ordinal = count('competingSubjects');
    put('competingSubjects', key, claim);
    scratch.db
      .prepare(
        'INSERT INTO competing_order VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET id=excluded.id',
      )
      .run(key, claim.groupId, ordinal);
  };
  const sortCompeting = function* (): Generator<void, void, void> {
    // Same stable localeCompare order as legacy, with fixed-size sorted runs.
    // Keep occurrence addresses as row keys; public IDs are not unique here.
    scratch.db.exec(
      'CREATE TABLE competing_runs(level INTEGER,run INTEGER,ordinal INTEGER,key TEXT,id TEXT,PRIMARY KEY(level,run,ordinal))',
    );
    const insert = scratch.db.prepare('INSERT INTO competing_runs VALUES(?,?,?,?,?)');
    let run = 0,
      bytes = 0,
      batch: { key: string; id: string }[] = [];
    const flush = () => {
      batch.sort((a, b) => a.id.localeCompare(b.id));
      for (const [ordinal, item] of batch.entries()) insert.run(0, run, ordinal, item.key, item.id);
      run++;
      batch = [];
      bytes = 0;
    };
    for (const row of scratch.db
      .prepare('SELECT key,id FROM competing_order ORDER BY ordinal')
      .iterate()) {
      const item = { key: String(row.key), id: String(row.id) },
        size = Buffer.byteLength(item.key) + Buffer.byteLength(item.id);
      if (batch.length && (batch.length === 32 || bytes + size > 65536)) flush();
      batch.push(item);
      bytes += size;
      yield;
    }
    if (batch.length) flush();
    let level = 0;
    while (run > 1) {
      for (let left = 0; left < run; left += 2) {
        const a = scratch.db
            .prepare('SELECT key,id FROM competing_runs WHERE level=? AND run=? ORDER BY ordinal')
            .iterate(level, left),
          b = scratch.db
            .prepare('SELECT key,id FROM competing_runs WHERE level=? AND run=? ORDER BY ordinal')
            .iterate(level, left + 1);
        let x = a.next(),
          y = b.next(),
          ordinal = 0;
        while (!x.done || !y.done) {
          const chooseA =
              y.done || (!x.done && String(x.value.id).localeCompare(String(y.value.id)) <= 0),
            item = chooseA ? x.value! : y.value!;
          insert.run(level + 1, Math.floor(left / 2), ordinal++, item.key, item.id);
          if (chooseA) x = a.next();
          else y = b.next();
          yield;
        }
      }
      scratch.db.prepare('DELETE FROM competing_runs WHERE level=?').run(level++);
      run = Math.ceil(run / 2);
    }
    const update = scratch.db.prepare(
      "UPDATE rows SET ordinal=? WHERE section='competingSubjects' AND key=?",
    );
    let ordinal = 0;
    for (const row of scratch.db
      .prepare('SELECT key FROM competing_runs WHERE level=? ORDER BY ordinal')
      .iterate(level)) {
      update.run(ordinal++, row.key);
      yield;
    }
    scratch.db.exec('DROP TABLE competing_runs');
  };
  const raw = function* (section: string) {
    for (const row of scratch.db
      .prepare('SELECT key,value FROM rows WHERE section=? ORDER BY ordinal')
      .iterate(section)) {
      const key = String(row.key);
      yield {
        key,
        chunks: function* () {
          if (section === 'targets' || section === 'assignmentTargets') {
            yield* canonicalReviewValueChunks(target(section, key)!);
            return;
          }
          if (row.value !== '') {
            yield String(row.value);
            return;
          }
          for (const piece of scratch.db
            .prepare('SELECT value FROM pieces WHERE section=? AND key=? ORDER BY ordinal')
            .iterate(section, key))
            yield String(piece.value);
        },
      };
    }
  };
  function target(section: string, key: string): Target | undefined {
    const header = get<Target & { $issues?: boolean }>(section, key);
    if (!header) return undefined;
    const { $issues, ...value } = header;
    if ($issues) {
      const issueIds = sequence<string>('targetIssues:' + section + ':' + key);
      registerReviewCanonicalValue(issueIds, () => chunks('targetIssues:' + section + ':' + key));
      value.issueIds = issueIds;
    }
    return value;
  }
  function putTarget(...args: Parameters<typeof putTargetWork>) {
    const work = putTargetWork(...args);
    while (!work.next().done) {}
  }
  function* putTargetWork(section: string, key: string, value: Target, issues?: Iterable<string>) {
    const { issueIds: _issueIds, ...header } = value;
    const issueSection = 'targetIssues:' + section + ':' + key;
    scratch.db.prepare('DELETE FROM rows WHERE section=?').run(issueSection);
    if (issues)
      for (const issueId of issues) {
        put(issueSection, issueId, issueId);
        yield;
      }
    put(section, key, { ...header, ...(issues ? { $issues: true } : {}) });
  }
  function addTargetIssue(section: string, key: string, issueId: string) {
    const previous = target(section, key)!;
    const issueSection = 'targetIssues:' + section + ':' + key;
    if (!previous.issueIds) put(issueSection, previous.issueId, previous.issueId);
    put(issueSection, issueId, issueId);
    const { issueIds: _ids, ...header } = previous;
    put(section, key, { ...header, $issues: true });
  }
  const sequence = <T>(section: string) =>
    Object.defineProperty(
      selectedSequence(function* () {
        for (const row of scratch.db
          .prepare('SELECT key,value FROM rows WHERE section=? ORDER BY ordinal')
          .iterate(section))
          yield (
            section === 'targets' || section === 'assignmentTargets'
              ? target(section, String(row.key))
              : JSON.parse(String(row.value))
          ) as T;
      }),
      'length',
      { get: () => count(section) },
    );
  const chunks = function* (section: string) {
    yield '[';
    let comma = false;
    for (const row of raw(section)) {
      if (comma) yield ',';
      comma = true;
      yield* row.chunks();
    }
    yield ']';
  };
  return {
    ...scratch,
    retainArtifacts(
      values: Parameters<ReturnType<typeof createClinicalReviewArtifactProof>['retain']>[0],
    ) {
      artifacts ??= createClinicalReviewArtifactProof(scratch.db, 'identity_artifact_proof');
      artifacts.retain(values);
    },
    assertArtifacts() {
      artifacts?.assertCurrent();
    },
    *verifiedArtifacts() {
      if (artifacts) yield* artifacts.verifiedArtifacts();
    },
    withVerifiedTerminal<T>(
      controls: { assertCurrent(): void; signal?: AbortSignal },
      complete: (terminalPhysicalCurrent: () => void) => T,
      mode: 'read-only' | 'publication' = 'read-only',
    ): Promise<T> {
      if (!artifacts) throw Error('Retained artifact proof is unavailable');
      return artifacts.withVerifiedTerminal(controls, complete, mode);
    },
    count,
    get,
    put,
    putStream,
    putStreamWork,
    putCompeting,
    sortCompeting,
    target,
    putTarget,
    putTargetWork,
    addTargetIssue,
    raw,
    sequence,
    chunks,
  };
}
type Rows = ReturnType<typeof rows>;
function verifiedIdentityPublication(context: Context, stored: Rows) {
  return (commit: (terminalPhysicalCurrent: () => void) => void) => {
    const methods = managedDatabaseMethodEpoch(context.db);
    if (!methods) reject('Identity publication requires current database methods');
    const assertCurrent = () => {
      context.assertCurrent();
      if (managedDatabaseMethodEpoch(context.db) !== methods)
        reject('Identity publication methods changed');
    };
    return stored.withVerifiedTerminal(
      { assertCurrent },
      (terminalPhysicalCurrent) => {
        commit(terminalPhysicalCurrent);
        assertCurrent();
      },
      'publication',
    );
  };
}
function runNativeIdentityWork<T>(
  context: Context,
  stored: Rows,
  work: Generator<void, T, void>,
  assertBorrowed?: () => void,
) {
  const db = context.db;
  return runClinicalReviewWork(work, {
    capture() {
      context.assertCurrent();
      stored.assertArtifacts();
      assertBorrowed?.();
      const stamp = reviewPreparationStamp(db);
      if (stamp === undefined) reject('Identity scope preparation requires current authority');
      return () => {
        context.assertCurrent();
        if (reviewPreparationStamp(db) !== stamp)
          reject('Identity scope changed during preparation');
        stored.assertArtifacts();
        assertBorrowed?.();
      };
    },
  });
}
async function runNativeIdentityArtifactVerification(context: Context, stored: Rows) {
  const { db } = context;
  context.assertCurrent();
  const stamp = reviewPreparationStamp(db),
    methods = managedDatabaseMethodEpoch(db),
    epoch = captureManagedPhysicalEpoch();
  if (stamp === undefined || !methods || !epoch)
    reject('Identity artifact verification requires current authority');
  const originalEpoch = epoch!;
  const assertAuthority = () => {
    context.assertCurrent();
    if (
      reviewPreparationStamp(db) !== stamp ||
      managedDatabaseMethodEpoch(db) !== methods ||
      !managedPhysicalEpochCurrent(originalEpoch)
    )
      reject('Identity artifact authority changed during verification');
  };
  const originalScratch = disposableSqlite('fictional-identity-original-proof-');
  try {
    const original = createClinicalReviewArtifactProof(originalScratch.db, 'original_artifacts');
    await runClinicalReviewWork(
      (function* () {
        for (const artifact of stored.verifiedArtifacts()) {
          original.retain([artifact]);
          yield;
        }
      })(),
      { capture: () => (assertAuthority(), assertAuthority) },
    );
    assertAuthority();
    const originalCurrent = await original.withVerifiedTerminal(
      { assertCurrent: assertAuthority },
      (physicalCurrent) => physicalCurrent,
    );
    const current = () => {
      assertAuthority();
      originalCurrent();
    };
    await runClinicalReviewWork(verifyPreviewArtifactsWork(context, stored), {
      capture: () => (current(), current),
    });
    current();
    await stored.withVerifiedTerminal({ assertCurrent: current }, () => undefined);
  } finally {
    originalScratch.close();
  }
}
/** Only unpublished identity DTO work may use this growing physical proof. */
async function nativeIdentitySpeculativePhase(context: Context, stored: Rows) {
  const { db } = context;
  context.assertCurrent();
  const stamp = reviewPreparationStamp(db),
    methods = reviewPreparationMethodStamp(db),
    epoch = captureManagedPhysicalEpoch();
  if (stamp === undefined || methods === undefined || !epoch)
    reject('Identity speculative work requires current authority');
  const originalEpoch = epoch!;
  const scratch = disposableSqlite('fictional-identity-build-original-proof-');
  try {
    const original = createClinicalReviewArtifactProof(scratch.db, 'original_artifacts');
    const assertAuthority = () => {
      context.assertCurrent();
      if (
        reviewPreparationStamp(db) !== stamp ||
        reviewPreparationMethodStamp(db) !== methods ||
        !managedPhysicalEpochCurrent(originalEpoch)
      )
        reject('Identity evidence changed during speculative preparation');
    };
    await runClinicalReviewWork(
      (function* () {
        for (const artifact of stored.verifiedArtifacts()) {
          original.retain([artifact]);
          yield;
        }
      })(),
      { capture: () => (assertAuthority(), assertAuthority) },
    );
    const originalCurrent = await original.withVerifiedTerminal(
      { assertCurrent: assertAuthority },
      (physicalCurrent) => physicalCurrent,
    );
    const assertCurrent = () => {
      assertAuthority();
      originalCurrent();
    };
    stored.retainArtifacts([]);
    return {
      assertCurrent,
      async run<T>(work: Generator<void, T, void>, assertBorrowed?: () => void) {
        const current = () => {
          assertCurrent();
          assertBorrowed?.();
        };
        current();
        const result = await runClinicalReviewWork(work, {
          capture: () => (current(), current),
        });
        current();
        return result;
      },
      async finish() {
        assertCurrent();
        await stored.withVerifiedTerminal({ assertCurrent }, () => undefined);
      },
      [Symbol.dispose]() {
        scratch.close();
      },
    };
  } catch (error) {
    scratch.close();
    throw error;
  }
}
async function build(
  context: Context,
  original: Awaited<ReturnType<typeof evidence>>,
  stored: Rows,
) {
  withIntakeWork(context.db, 'warm', () => recordIntakeWork('identityPreviewFullPreparations'));
  const { db, root, profileId, id, view, workflow, group, scope } = context;
  const currentSelf = selfSnapshot(db),
    people = selectedIdentityPeopleSnapshots(db);
  const prerequisites = disposableSqlite('fictional-identity-prerequisites-');
  try {
    context.assertCurrent();
    const selectionStamp = reviewPreparationStamp(db);
    if (selectionStamp === undefined)
      reject('Identity prerequisite selection requires current authority');
    const assertSelectionCurrent = () => {
      context.assertCurrent();
      if (reviewPreparationStamp(db) !== selectionStamp)
        reject('Identity prerequisite selection changed');
    };
    prerequisites.db.exec(
      'CREATE TABLE proposal(ordinal INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL)',
    );
    const add = prerequisites.db.prepare('INSERT OR IGNORE INTO proposal VALUES(?,?)');
    let ordinal = 0;
    await runClinicalReviewWork(
      (function* () {
        for (const member of context.membership()) {
          yield;
          const candidate = view.find('candidate', workflow, member.candidateId),
            version = candidate && view.find('version', candidate, member.candidateVersionId);
          if (!candidate || !version) reject('A report member no longer exists');
          const latest = view.childAt(
            candidate!,
            'versions',
            view.childCount(candidate!, 'versions') - 1,
          );
          if (!latest || scalar(view, latest, 'id') !== member.candidateVersionId) continue;
          for (const occurrence of member.occurrences) {
            add.run(ordinal++, canonicalLiteral(occurrence.proposalId));
            yield;
          }
        }
      })(),
      {
        capture: () => (assertSelectionCurrent(), assertSelectionCurrent),
      },
    );
    assertSelectionCurrent();
    let after = -1;
    for (;;) {
      const page = prerequisites.db
        .prepare('SELECT id,ordinal FROM proposal WHERE ordinal>? ORDER BY ordinal LIMIT 64')
        .all(after);
      if (!page.length) break;
      for (const row of page) {
        context.assertCurrent();
        stored.assertArtifacts();
        const grounding = identityGroundingGeneration(db);
        const assertPreparationCurrent = () => {
          context.assertCurrent();
          stored.assertArtifacts();
          if (identityGroundingGeneration(db) !== grounding)
            reject('Identity grounding changed during prerequisite preparation');
        };
        await prepareCollectionClinicalReviewDependencies(
          db,
          root,
          profileId,
          id,
          JSON.parse(String(row.id)) as string | null,
          { assertRunning: assertPreparationCurrent },
        );
        assertPreparationCurrent();
        after = Number(row.ordinal);
      }
    }
  } finally {
    prerequisites.close();
  }
  using phase = await nativeIdentitySpeculativePhase(context, stored);
  let cached:
    | {
        proposalId: string | null;
        selected?: Extract<ReturnType<typeof prepareCollectionClinicalReview>, { status: 'ready' }>;
        borrowed?: RetainedCollectionClinicalPolicy;
        checkedBorrow?: ReturnType<typeof checkedRetainedCollectionClinicalPolicyContext>;
      }
    | undefined;
  const closeCached = () => {
    if (cached?.borrowed) cached.borrowed.close();
    else cached?.selected?.session.close();
    cached = undefined;
  };
  const assertBorrowed = () => {
    if (cached?.checkedBorrow) cached.checkedBorrow.assertAuthorityCurrent();
    else cached?.borrowed?.assertCurrent();
  };
  const run = async <T>(work: Generator<void, T, void>) => {
    return phase.run(work, assertBorrowed);
  };
  let receipts: Iterable<IdentityPolicyReceipt> | undefined;
  const currentReceipts = () =>
    receipts || reject('Prepare the complete current identity receipt selection');
  let inspections = 0;
  const step = () =>
    ++inspections % 16 === 0
      ? run(
          (function* () {
            for (let n = 0; n < 16; n++) yield;
          })(),
        )
      : undefined;
  await run(
    (function* () {
      for (const question of intakeReviewChildren(view, workflow, 'questions')) {
        yield;
        if (
          !scalar(view, question, 'candidateId') &&
          scalar(view, question, 'status') !== 'resolved' &&
          (scalar(view, question, 'field') === 'subject' ||
            /\b(patient|subject|identity)\b/i.test(scalar<string>(view, question, 'prompt') || ''))
        )
          reject('Resolve the delivery identity question before common confirmation');
      }
    })(),
  );
  type GroundedQuestion = {
    issue: Pick<IntakeReviewIssue, 'prompt' | 'textAnchor'>;
    receipt: {
      operationId: string;
      scope: { scopeToken: string; profileId: string };
    };
  };
  const groundedQuestions = stored.sequence<GroundedQuestion>('groundedQuestions');
  const groundedNameQuestions =
    stored.sequence<Pick<IntakeReviewIssue, 'prompt' | 'textAnchor'>>('groundedNameQuestions');
  let hasUnstructuredIdentityQuestion = false;
  let assignedPerson: IntakeIdentityPerson | undefined;
  let occurrenceCount = 0,
    consistentAssignment = true,
    allEvidenced = true;

  async function reviewRecord(
    proposalId: string | null,
    recordId: string,
    candidateId: string,
    candidateVersionId: string,
  ) {
    if (!cached || cached.proposalId !== proposalId) {
      // Prerequisite preparation may publish accepted derived catalogs. An older
      // borrowed receipt proof is never rebased across those real SQL writes.
      receipts = undefined;
      assertBorrowed();
      closeCached();
      const grounding = identityGroundingGeneration(db);
      const assertPreparationCurrent = () => {
        phase.assertCurrent();
        if (identityGroundingGeneration(db) !== grounding)
          reject('Identity grounding changed during occurrence preparation');
      };
      const borrowed = tryBorrowPreparedCollectionClinicalPolicy(
        db,
        root,
        profileId,
        id,
        proposalId,
        assertPreparationCurrent,
      );
      if (borrowed) {
        const checkedBorrow = checkedRetainedCollectionClinicalPolicyContext(db, borrowed);
        phase.assertCurrent();
        stored.retainArtifacts(checkedBorrow.verifiedArtifacts());
        phase.assertCurrent();
        cached = { proposalId, borrowed, checkedBorrow };
      } else {
        const selected = await prepareCollectionClinicalReviewAsync(
          db,
          root,
          profileId,
          id,
          proposalId,
          { assertRunning: assertPreparationCurrent },
        );
        if (selected.status !== 'ready')
          return reject(
            'Prepare this exact retained clinical occurrence before identity confirmation',
          );
        cached = { proposalId, selected };
        assertPreparationCurrent();
        stored.retainArtifacts(
          (await collectionClinicalProjectionContextAsync(selected.session)).verifiedArtifacts(),
        );
        assertPreparationCurrent();
      }
      // Acquire a new complete selection only after prerequisites and physical
      // authority are verified. Previously borrowed providers stay invalid.
      receipts = await run(scope.receiptsWork!());
    }
    assertBorrowed();
    const record = cached.checkedBorrow
      ? cached.checkedBorrow.record(recordId, candidateId, candidateVersionId)
      : cached.selected!.session.record(recordId, candidateId, candidateVersionId);
    if (!record) return reject('The current report occurrence differs from the displayed member');
    return record;
  }
  try {
    for (const member of context.membership()) {
      const pending = step();
      if (pending) await pending;
      context.assertCurrent();
      const candidate = view.find('candidate', workflow, member.candidateId),
        version = candidate && view.find('version', candidate, member.candidateVersionId);
      if (!candidate || !version) reject('A report member no longer exists');
      const latest = view.childAt(
        candidate!,
        'versions',
        view.childCount(candidate!, 'versions') - 1,
      );
      if (!latest || scalar(view, latest, 'id') !== member.candidateVersionId) continue;
      for (const occurrence of member.occurrences) {
        const pending = step();
        if (pending) await pending;
        const record = await reviewRecord(
          occurrence.proposalId,
          occurrence.recordId,
          member.candidateId,
          member.candidateVersionId,
        );
        const person = record.identityAttribution?.assignedPerson;
        // This bounded plain DTO is the only record-owned object kept after policy release.
        if (!occurrenceCount) assignedPerson = person && { ...person };
        else if (person?.personId !== assignedPerson?.personId) consistentAssignment = false;
        occurrenceCount++;
        allEvidenced &&= record.identityReview?.status === 'evidenced_match';
        await run(
          (function* () {
            for (const warning of reviewRecordIdentityWarnings(record)) {
              yield;
              stored.put(
                'warnings',
                canonicalLiteral([
                  warning.kind,
                  warning.modelBirthDate,
                  warning.savedBirthDate,
                  warning.personName,
                ]),
                warning,
              );
            }
          })(),
        );
        if (scalar(view, version!, 'status') !== 'pending') continue;
        const genericId =
          'issue:' +
          createHash('sha256')
            .update(JSON.stringify([member.candidateVersionId, 'identity', 'subject']))
            .digest('hex');
        const issueSection = 'occurrenceIssues:' + occurrenceCount,
          unresolvedSection = issueSection + ':unresolved',
          additionalSection = issueSection + ':additional';
        let firstIdentity: IntakeReviewIssue | undefined,
          genericIdentity: IntakeReviewIssue | undefined,
          firstUnresolved: IntakeReviewIssue | undefined,
          genericUnresolved: IntakeReviewIssue | undefined;
        await run(
          (function* () {
            for (const issue of reviewRecordIssues(record)) {
              yield;
              if (issue.kind !== 'identity') continue;
              firstIdentity ??= issue;
              if (issue.id === genericId) genericIdentity ??= issue;
              stored.put(issueSection, String(stored.count(issueSection)), issue);
              if (issue.status === 'unresolved') {
                firstUnresolved ??= issue;
                if (issue.id === genericId) genericUnresolved ??= issue;
                stored.put(unresolvedSection, String(stored.count(unresolvedSection)), issue);
                if (issue.id !== genericId)
                  stored.put(additionalSection, String(stored.count(additionalSection)), issue);
              }
              stored.put('issues', String(stored.count('issues')), issue);
            }
          })(),
        );
        const identity = stored.sequence<IntakeReviewIssue>(issueSection);
        const target = (issueId: string): Target => ({
          candidateId: member.candidateId,
          candidateVersionId: member.candidateVersionId,
          proposalId: occurrence.proposalId,
          recordId: record.id,
          title: record.title,
          issueId,
        });
        const key = hash([
          member.candidateId,
          member.candidateVersionId,
          occurrence.proposalId,
          record.id,
        ]);
        if (record.reviewState === 'pending')
          await run(
            stored.putTargetWork(
              'assignmentTargets',
              key,
              target(genericIdentity?.id || firstIdentity?.id || genericId),
              identity.length ? identity.map((issue) => issue.id) : undefined,
            ),
          );
        const unresolved = stored.sequence<IntakeReviewIssue>(unresolvedSection);
        const explicitSection = 'occurrenceExplicit:' + occurrenceCount;
        await run(
          (function* () {
            for (const issue of identity) {
              yield;
              if (issue.id === genericId || issue.selfSuggestion) continue;
              if (
                original.pageText?.includes(issue.textAnchor || '\u0000') &&
                (yield* isGenericNameConfirmationWork(
                  issue,
                  group.report?.subject?.text,
                  currentSelf,
                  people,
                ))
              ) {
                stored.put('groundedNameQuestions', hash([issue.prompt, issue.textAnchor]), {
                  prompt: issue.prompt,
                  ...(issue.textAnchor ? { textAnchor: issue.textAnchor } : {}),
                });
                continue;
              }
              const receipt = yield* repeatedIdentityQuestionReceiptWork({
                issue,
                group,
                receipts: currentReceipts(),
                profileId,
                intakeId: id,
                sourceHash: context.file.sha256,
                originalFingerprint: original.originalFingerprint,
                grounded: () =>
                  !!issue.textAnchor && original.pageText?.includes(issue.textAnchor) === true,
              });
              if (!receipt) {
                stored.put(explicitSection, String(stored.count(explicitSection)), issue);
                continue;
              }
              stored.put(
                'groundedQuestions',
                hash([
                  issue.prompt,
                  issue.textAnchor,
                  receipt.operationId,
                  receipt.scope.scopeToken,
                ]),
                {
                  issue: {
                    prompt: issue.prompt,
                    ...(issue.textAnchor ? { textAnchor: issue.textAnchor } : {}),
                  },
                  receipt: {
                    operationId: receipt.operationId,
                    scope: {
                      scopeToken: receipt.scope.scopeToken,
                      profileId: receipt.scope.profileId,
                    },
                  },
                },
              );
              continue;
            }
          })(),
        );
        const explicitIssues = stored.sequence<IntakeReviewIssue>(explicitSection);
        await run(
          (function* () {
            for (const issue of explicitIssues) {
              yield;
              hasUnstructuredIdentityQuestion = true;
              const resolution = record.draft
                ? latestReviewDraftResolution(record.draft, issue.id)
                : undefined;
              stored.put('explicit', String(stored.count('explicit')), {
                ...target(issue.id),
                issueIds: [issue.id],
                issues: [
                  {
                    id: issue.id,
                    prompt: issue.prompt,
                    ...(issue.textAnchor ? { textAnchor: issue.textAnchor } : {}),
                  },
                ],
                resolutions: resolution ? [resolution] : [],
              });
            }
          })(),
        );
        if (!unresolved.length || record.reviewState !== 'pending') continue;
        const additional = stored.sequence<IntakeReviewIssue>(additionalSection);
        await run(
          (function* () {
            for (const issue of additional) {
              yield;
              const question = {
                prompt: issue.prompt,
                ...(issue.textAnchor ? { textAnchor: issue.textAnchor } : {}),
              };
              stored.put('questions', canonicalLiteral(question), question);
            }
          })(),
        );
        if (!stored.target('targets', key))
          await run(
            stored.putTargetWork(
              'targets',
              key,
              target(genericUnresolved?.id || firstUnresolved!.id),
              additional.length ? unresolved.map((issue) => issue.id) : undefined,
            ),
          );
      }
    }
    assertBorrowed();
  } finally {
    closeCached();
  }
  stored.assertArtifacts();
  // A report with no current occurrence still inspects all retained receipts.
  if (!receipts) receipts = await run(scope.receiptsWork!());
  const dates = originalSubjectBirthDateEvidence(
    original.pageText,
    group.report!.subject!.text,
    group.report!.anchor.text,
  );
  const collected = await run(
    collectEvidencedIdentityWork(
      stored.sequence<IntakeReviewIssue>('issues'),
      original.pageText === null || original.patientNameGrounded ? group.report?.subject?.text : '',
      dates,
    ),
  );
  const personFingerprint = identityPersonFingerprint(
    original.originalFingerprint,
    collected.evidence,
    group.report!.subject!.text,
  );
  const evidencedIdentity = {
    ...collected.evidence,
    ...(personFingerprint ? { personFingerprint } : {}),
  };
  const receiptAppliesWork = function* (
    receipt: IdentityPolicyReceipt,
  ): Generator<void, boolean, void> {
    return (
      !!(receipt.scope.assignmentTargets || receipt.scope.targets).length &&
      (yield* identityReceiptAppliesToCurrentBoundaryWork(receipt, {
        profileId,
        intakeId: id,
        groupId: group.id,
        groupVersionId: context.groupVersionId,
        sourceHash: context.file.sha256,
        memberId: group.memberId,
        original: original.original,
        report: group.report!.anchor,
        subject: group.report!.subject!,
        verificationMode: original.verificationMode,
        evidencedIdentity,
        evidenceOriginalFingerprint: original.originalFingerprint,
        membership: scope.membership(group),
      }))
    );
  };
  const receiptApplies = (receipt: IdentityPolicyReceipt) => {
    const work = receiptAppliesWork(receipt);
    let result = work.next();
    while (!result.done) result = work.next();
    return result.value;
  };
  type Explicit = Target & {
    issueIds: string[];
    issues: { id: string; prompt: string; textAnchor?: string }[];
    resolutions: NonNullable<IntakeReviewRecord['draft']>['resolutions'];
  };
  await run(
    (function* () {
      for (const occurrence of stored.sequence<Explicit>('explicit')) {
        yield;
        const issueId = occurrence.issueIds[0]!;
        if (
          yield* exactCurrentIdentityResolutionOperationIdWork({
            receipts: currentReceipts(),
            occurrences: [occurrence],
            receiptApplies,
            receiptAppliesWork,
          })
        )
          continue;
        const key = hash([
          occurrence.candidateId,
          occurrence.candidateVersionId,
          occurrence.proposalId,
          occurrence.recordId,
        ]);
        const existing = stored.target('targets', key);
        if (existing) stored.addTargetIssue('targets', key, issueId);
        else
          stored.putTarget(
            'targets',
            key,
            {
              candidateId: occurrence.candidateId,
              candidateVersionId: occurrence.candidateVersionId,
              proposalId: occurrence.proposalId,
              recordId: occurrence.recordId,
              title: occurrence.title,
              issueId,
            },
            [issueId],
          );
        const issue = occurrence.issues[0]!,
          question = {
            prompt: issue.prompt,
            ...(issue.textAnchor ? { textAnchor: issue.textAnchor } : {}),
          };
        stored.put('questions', canonicalLiteral(question), question);
      }
    })(),
  );
  await runClinicalReviewWork(
    (function* () {
      for (const record of scope.groupRecords()) {
        yield;
        const other = iterateCompetingIdentityBoundaries(group, [scope.groupHeader(record)]).next()
          .value;
        if (!other) continue;
        const latest = scope.currentGroupVersion(record)!;
        stored.putCompeting(view.address(record), {
          groupId: other.id,
          groupVersionId: scalar<string>(view, latest, 'id')!,
          subject: other.report!.subject!,
        });
      }
      yield* stored.sortCompeting();
    })(),
    {
      capture() {
        context.assertCurrent();
        const stamp = reviewPreparationStamp(db);
        if (stamp === undefined)
          reject('Identity scope preparation requires a current authority boundary');
        return () => {
          context.assertCurrent();
          if (reviewPreparationStamp(db) !== stamp)
            reject('Identity scope changed during preparation');
          stored.assertArtifacts();
        };
      },
    },
  );
  if (stored.count('competingSubjects')) {
    // Preserve the complete alternative readings without concatenating an unbounded banner.
    const prompt =
      'Other extraction claims name a different subject at this same report boundary. Review the original and confirm the displayed subject and person for only the listed records.';
    await run(
      stored.putStreamWork(
        'questions',
        'competing-boundary',
        (function* () {
          yield '{"prompt":' + canonicalLiteral(prompt) + ',"textAnchor":"';
          let comma = false;
          for (const row of stored.raw('competingSubjects')) {
            const claim = JSON.parse([...row.chunks()].join('')) as {
              subject: { text: string };
            };
            if (comma) yield ' / ';
            comma = true;
            yield JSON.stringify(claim.subject.text).slice(1, -1);
          }
          yield '"}';
        })(),
      ),
    );
    hasUnstructuredIdentityQuestion = true;
  }
  const birthDateReview =
    collected.unreadableBirthDate ||
    collected.conflicts.some((conflict) => conflict.field === 'birthDate')
      ? {
          choices: [...new Set([...dates.dates, ...(dates.suggestions || [])])],
          ...(dates.suggestions?.length ? { suggested: dates.suggestions[0] } : {}),
        }
      : undefined;
  const header = {
    profileId,
    intakeId: id,
    intakeVersion: context.before.version,
    selfVersion: currentSelf.version,
    groupId: group.id,
    groupVersionId: context.groupVersionId,
    sourceHash: context.file.sha256,
    memberId: group.memberId,
    original: original.original,
    report: structuredClone(group.report!.anchor),
    subject: structuredClone(group.report!.subject!),
    verificationMode: original.verificationMode,
    evidencedIdentity,
    evidenceOriginalFingerprint: original.originalFingerprint,
    ...(birthDateReview ? { birthDateReview } : {}),
  };
  // Both commitments consume each complete ordered scope collection once.
  // The existing version-specific token and retained snapshot remain authority.
  const { scopeToken, evidenceCommitment, warningsSha256 } = await run(
    identityScopeCommitmentsWork({
      header,
      sections: {
        membership: context.membershipChunks(),
        targets: stored.chunks('targets'),
        assignmentTargets: stored.chunks('assignmentTargets'),
        ...(stored.count('questions') ? { questions: stored.chunks('questions') } : {}),
        ...(stored.count('competingSubjects')
          ? { competingSubjects: stored.chunks('competingSubjects') }
          : {}),
      },
      sourceHash: original.sourceHash,
      warnings: stored.chunks('warnings'),
      onHash: (kind, bytes) =>
        recordIntakeWork(
          kind === 'scope'
            ? 'identityFreshnessScopeHashBytes'
            : 'identityFreshnessWarningHashBytes',
          bytes,
        ),
    }),
  );
  const memberCount = await run(
    (function* () {
      let count = 0;
      for (const _member of context.membership()) {
        count++;
        yield;
      }
      return count;
    })(),
  );
  const display: IntakeIdentityScopeReference = {
    ...header,
    format: 'health-intake-identity-scope-v2',
    scopeToken,
    collection: {
      snapshotId: 'identity:' + scopeToken,
      membership: memberCount,
      targets: stored.count('targets'),
      assignmentTargets: stored.count('assignmentTargets'),
      questions: stored.count('questions'),
      competingSubjects: stored.count('competingSubjects'),
    },
  };
  let explicitlyConfirmedOperationId = stored.count('targets')
    ? undefined
    : await run(
        exactCurrentIdentityResolutionOperationIdWork({
          receipts: currentReceipts(),
          occurrences: stored.sequence<Explicit>('explicit'),
          receiptApplies,
          receiptAppliesWork,
        }),
      );
  if (stored.count('competingSubjects')) {
    const claims =
      stored.sequence<NonNullable<IntakeIdentityScope['competingSubjects']>[number]>(
        'competingSubjects',
      );
    const repair = await run(
      (function* () {
        let last: IdentityPolicyReceipt | undefined;
        for (const receipt of currentReceipts()) {
          yield;
          if (
            !(yield* receiptAppliesWork(receipt)) ||
            receipt.scope.groupId !== group.id ||
            receipt.attestation !== 'confirmed_displayed_identity_questions' ||
            receipt.scope.competingSubjects?.length !== claims.length ||
            !(yield* identityCompetingClaimsEqualWork(claims, receipt.scope.competingSubjects!)) ||
            !stored.count('assignmentTargets')
          )
            continue;
          let complete = true;
          for (const target of stored.sequence<Target>('assignmentTargets')) {
            yield;
            let found = false;
            for (const prior of receipt.scope.assignmentTargets || receipt.scope.targets) {
              yield;
              if (
                prior.candidateId !== target.candidateId ||
                prior.candidateVersionId !== target.candidateVersionId ||
                prior.proposalId !== target.proposalId ||
                prior.recordId !== target.recordId
              )
                continue;
              let issues = true;
              for (const issueId of target.issueIds || [target.issueId]) {
                yield;
                if (!(yield* identityTargetHasIssueWork(prior, issueId))) {
                  issues = false;
                  break;
                }
              }
              if (issues) {
                found = true;
                break;
              }
            }
            if (!found) {
              complete = false;
              break;
            }
          }
          if (complete) last = receipt;
        }
        return last;
      })(),
    );
    if (repair) explicitlyConfirmedOperationId = repair.operationId;
  }
  const current: IdentityConfirmationScope = {
    ...header,
    scopeToken,
    membership: scope.membership(group),
    targets: stored.sequence<Target>('targets'),
    assignmentTargets: stored.sequence<Target>('assignmentTargets'),
    ...(stored.count('questions')
      ? {
          questions: stored.sequence<
            IntakeIdentityScope['questions'] extends (infer Q)[] | undefined ? Q : never
          >('questions') as unknown as NonNullable<IntakeIdentityScope['questions']>,
        }
      : {}),
  };
  const currentRefusal = await run(
    (function* () {
      let answer: 'unknown' | 'other_person' | undefined;
      for (const issue of stored.sequence<IntakeReviewIssue>('issues')) {
        yield;
        if (issue.resolution?.outcome === 'other_person') return 'other_person' as const;
        if (issue.resolution?.outcome === 'unknown') answer = 'unknown';
      }
      return answer;
    })(),
  );
  const assessment = await run(
    assessIdentityPolicyWork({
      self: currentSelf,
      people,
      nameEvidenceGrounded: original.patientNameGrounded,
      evidence: evidencedIdentity,
      evidenceConflicts: collected.conflicts.filter((conflict) => conflict.field !== 'birthDate'),
      unreadableBirthDate: !!birthDateReview,
      bannerBirthDates: collected.bannerBirthDates,
      group,
      groupVersionId: context.groupVersionId,
      originalFingerprint: original.originalFingerprint,
      receipts: currentReceipts(),
      hasUnstructuredIdentityQuestion,
      explicitlyConfirmedOperationId,
      currentRefusal,
    }),
  );
  const confirmationCount = await run(
    (function* () {
      let count = 0;
      for (const receipt of currentReceipts()) {
        yield;
        if (receipt.scope.groupId === group.id) count++;
      }
      return count;
    })(),
  );
  const presentation =
    occurrenceCount && consistentAssignment && assignedPerson
      ? {
          assignedPerson,
          status: allEvidenced ? ('evidenced_match' as const) : ('prior_confirmation' as const),
          blocking: false,
          message: allEvidenced
            ? 'The printed name uniquely matches a saved name for ' + assignedPerson.fullName + '.'
            : 'This report was assigned to ' + assignedPerson.fullName + '.',
        }
      : {};
  await phase.finish();
  return {
    display,
    evidenceCommitment,
    originalSourceHash: original.sourceHash,
    warningsSha256,
    current,
    assessment,
    groundedQuestions,
    groundedNameQuestions,
    dates,
    presentation,
    confirmationCount,
  };
}

const previewReferences = new WeakMap<
  DatabaseSync,
  Map<string, { reference: IntakeIdentityScopeReference; binding: string }>
>();
function previewBinding(db: DatabaseSync, id: string) {
  const version = intakeSourceVersion(db, id);
  return hash([version.version, version.logicalBinding, clinicalReviewRevision(db)]);
}
function rememberPreview(db: DatabaseSync, reference: IntakeIdentityScopeReference) {
  let entries = previewReferences.get(db);
  if (!entries) previewReferences.set(db, (entries = new Map()));
  entries.delete(reference.scopeToken);
  entries.set(reference.scopeToken, {
    reference,
    binding: previewBinding(db, reference.intakeId),
  });
  while (entries.size > 256) entries.delete(entries.keys().next().value!);
}
async function pageReference(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  groupId: string,
  token: string,
) {
  source(db, profileId, id);
  verifyIntakeOriginal(db, root, profileId, id);
  const retained = previewReferences.get(db)?.get(token);
  if (
    retained &&
    retained.reference.profileId === profileId &&
    retained.reference.intakeId === id &&
    retained.reference.groupId === groupId &&
    retained.binding === previewBinding(db, id)
  )
    return retained.reference;
  const review = await getNativeIntakeIdentityReview(db, root, profileId, id, groupId, {
    operation: currentClinicalOperation(db),
  });
  return review.scopeReference || reject('The identity scope is unavailable');
}
async function writeSnapshot(
  context: Context,
  built: Awaited<ReturnType<typeof build>>,
  stored: Rows,
  catalog: ReturnType<typeof createReportSnapshotCatalog>,
  purpose: 'preview' | 'confirmation',
) {
  const scope = built.display,
    proof = built.evidenceCommitment,
    warningCount = stored.count('warnings'),
    run = <T>(work: Generator<void, T, void>) => runNativeIdentityWork(context, stored, work),
    previous = catalog.open(scope.collection.snapshotId);
  if (previous && !identitySnapshotScopeMatches(previous, scope))
    throw Error('Identity snapshot binding mismatch');
  // Present malformed locators refuse even if a separate exact-proof alias exists.
  const current = currentIdentityScopeAlias(catalog, scope),
    exact = exactIdentityScopeAlias(catalog, scope, proof);
  if (exact) {
    identityScopeAliasMatches(
      exact,
      scope,
      built.originalSourceHash,
      built.warningsSha256,
      warningCount,
    );
    if (!previous) {
      const writer = await catalog.forkReference(exact.snapshot);
      const text = JSON.stringify(scope);
      if (reportSnapshotInlineTextFits(text)) await writer.put('$scope', text);
      else await writer.putText('$scope', [text]);
      await catalog.publish(scope.collection.snapshotId, writer);
    }
    if (purpose === 'preview' && current?.proof.sha256 !== exact.proof.sha256)
      await catalog.bindCurrentIdentityScope(scope.groupId, exact.reader);
    withIntakeWork(context.db, 'warm', () => recordIntakeWork('identitySnapshotAliasHits'));
    return;
  }
  const warnings = await retainIdentityWarningContent({
    db: context.db,
    catalog,
    digest: built.warningsSha256,
    count: warningCount,
    rows: stored.raw('warnings'),
    priorContent: current?.warningContent,
    run,
  });
  // A legacy same-token main can retain historical warnings. Only the private
  // fork is updated/certified; that immutable main and its old readers stay exact.
  const prior = current?.snapshot ?? previous,
    writer = prior ? await catalog.forkReference(prior) : await catalog.forkReference(warnings),
    delta = createIdentitySnapshotDelta({ db: context.db, writer });
  try {
    await delta.put('$format', IDENTITY_SNAPSHOT_FORMAT);
    await delta.putText('$scope', () => [JSON.stringify(scope)]);
    await delta.put('$warningCount', String(warningCount));
    let warningOrdinal = 0;
    for (const row of stored.raw('warnings'))
      await delta.putText('warnings:' + schemaOrdinal(warningOrdinal++), () => row.chunks());
    for (const section of SECTIONS) {
      if (section === 'membership') continue;
      let index = 0;
      for (const row of stored.raw(section)) {
        if (section === 'targets' || section === 'assignmentTargets') {
          const target = stored.target(section, row.key)!,
            { issueIds, ...header } = target;
          const targetKey = section + ':' + schemaOrdinal(index);
          let count = 0;
          if (issueIds) {
            for (const issueId of issueIds) {
              await delta.put(
                'targetIssue:' + targetKey + ':' + schemaOrdinal(count++),
                JSON.stringify(issueId),
              );
              await delta.put(
                'targetLookup:' +
                  targetKey +
                  ':' +
                  createHash('sha256').update(issueId).digest('hex'),
                '1',
              );
            }
          } else
            await delta.put(
              'targetLookup:' +
                targetKey +
                ':' +
                createHash('sha256').update(target.issueId).digest('hex'),
              '1',
            );
          await delta.putText('targetHeader:' + targetKey, () => [
            JSON.stringify({
              ...header,
              hasIssueIds: !!issueIds,
              issueCount: count,
              hasIssueLookup: true,
            }),
          ]);
        }
        if (section === 'questions') {
          const digest = await run(identitySnapshotQuestionHashWork(row.chunks()));
          await delta.put('questionHash:' + schemaOrdinal(index), digest);
        }
        context.assertCurrent();
        await delta.putText(section + ':' + schemaOrdinal(index++), () => row.chunks());
      }
    }
    let index = 0;
    for (const member of context.membership()) {
      const memberKey = schemaOrdinal(index++),
        { occurrences, ...header } = member;
      let occurrenceCount = 0;
      for (const occurrence of occurrences) {
        context.assertCurrent();
        await delta.putText(
          'occurrence:' + memberKey + ':' + schemaOrdinal(occurrenceCount++),
          () => [canonicalLiteral(occurrence)],
        );
      }
      await delta.putText('member:' + memberKey, () => [
        canonicalLiteral({ ...header, occurrenceCount }),
      ]);
      await delta.flush();
      await delta.putText('membership:' + memberKey, () =>
        (function* () {
          yield '{';
          let comma = false;
          for (const name of [...Object.keys(header), 'occurrences'].sort()) {
            if (comma) yield ',';
            comma = true;
            yield JSON.stringify(name) + ':';
            if (name !== 'occurrences') yield canonicalLiteral(header[name as keyof typeof header]);
            else {
              yield '[';
              let comma = false;
              for (let ordinal = 0; ordinal < occurrenceCount; ordinal++) {
                if (comma) yield ',';
                comma = true;
                yield* writer.chunks('occurrence:' + memberKey + ':' + schemaOrdinal(ordinal));
              }
              yield ']';
            }
          }
          yield '}';
        })(),
      );
    }

    await delta.finishCleanup();
    // Bind certification to an immutable map reference, never to a mutable writer.
    const completeId = identityCompleteSnapshotId(proof.sha256, scope.scopeToken);
    await catalog.publish(completeId, writer);
    const complete = catalog.open(completeId);
    if (!complete) throw Error('Missing newly retained complete identity scope');
    await delta.certify(complete);
    const alias = await publishIdentityScopeAlias({
      db: context.db,
      catalog,
      snapshot: complete,
      warningContent: warnings,
      scope,
      proof,
      originalSourceHash: built.originalSourceHash,
      warningsSha256: built.warningsSha256,
      warningCount,
      run,
    });
    if (!previous) await catalog.publish(scope.collection.snapshotId, writer);
    if (purpose === 'preview') await catalog.bindCurrentIdentityScope(scope.groupId, alias.reader);
  } finally {
    delta.close();
  }
}
async function collectGroupIdentity(context: Context, stored: Rows) {
  const run = <T>(work: Generator<void, T, void>) => runNativeIdentityWork(context, stored, work);
  let inspections = 0;
  const step = () =>
    ++inspections % 16 === 0
      ? run(
          (function* () {
            for (let n = 0; n < 16; n++) yield;
          })(),
        )
      : undefined;
  let cached:
    | {
        proposalId: string | null;
        session: Extract<
          ReturnType<typeof prepareCollectionClinicalReview>,
          { status: 'ready' }
        >['session'];
      }
    | undefined;
  try {
    for (const member of context.membership()) {
      const pending = step();
      if (pending) await pending;
      const candidate = context.view.find('candidate', context.workflow, member.candidateId);
      if (!candidate) continue;
      const latest = context.view.childAt(
        candidate,
        'versions',
        context.view.childCount(candidate, 'versions') - 1,
      );
      if (!latest || scalar(context.view, latest, 'id') !== member.candidateVersionId) continue;
      for (const occurrence of member.occurrences) {
        const pending = step();
        if (pending) await pending;
        if (!cached || cached.proposalId !== occurrence.proposalId) {
          cached?.session.close();
          await prepareCollectionClinicalReviewDependencies(
            context.db,
            context.root,
            context.profileId,
            context.id,
            occurrence.proposalId,
            { assertRunning: context.assertCurrent },
          );
          const selected = await prepareCollectionClinicalReviewAsync(
            context.db,
            context.root,
            context.profileId,
            context.id,
            occurrence.proposalId,
            { assertRunning: context.assertCurrent },
          );
          if (selected.status !== 'ready')
            return reject('Prepare this exact retained clinical occurrence before identity review');
          cached = {
            proposalId: occurrence.proposalId,
            session: selected.session,
          };
          context.assertCurrent();
          stored.retainArtifacts(
            (await collectionClinicalProjectionContextAsync(selected.session)).verifiedArtifacts(),
          );
          context.assertCurrent();
        }
        const record = cached.session.record(
          occurrence.recordId,
          member.candidateId,
          member.candidateVersionId,
        );
        if (!record) continue;
        const genericId =
          'issue:' +
          createHash('sha256')
            .update(JSON.stringify([member.candidateVersionId, 'identity', 'subject']))
            .digest('hex');
        await run(
          (function* () {
            for (const issue of reviewRecordIssues(record)) {
              yield;
              if (issue.kind === 'identity') {
                stored.put('initialIssues', String(stored.count('initialIssues')), issue);
                if (issue.id !== genericId && !issue.selfSuggestion)
                  stored.put('initialExplicit', String(stored.count('initialExplicit')), issue);
              }
            }
          })(),
        );
      }
    }
  } finally {
    cached?.session.close();
  }
  const collected = await run(
    collectSelectedEvidencedIdentityWork(
      () => stored.sequence<IntakeReviewIssue>('initialIssues'),
      context.group.report?.subject?.text,
    ),
  );
  const hasIdentityContext = !!(
    context.group.report?.subject ||
    collected.evidence.fullName ||
    collected.evidence.birthDate ||
    collected.unreadableBirthDate ||
    collected.conflicts.length
  );
  const hasUnstructuredIdentityQuestion = await run(
    (function* () {
      for (const issue of stored.sequence<IntakeReviewIssue>('initialExplicit')) {
        yield;
        if (
          hasIdentityContext ||
          issue.textAnchor ||
          issue.questionId ||
          issue.resolution?.outcome === 'unknown' ||
          issue.resolution?.outcome === 'other_person'
        )
          return true;
      }
      return false;
    })(),
  );
  const currentRefusal = await run(
    (function* () {
      let answer: 'unknown' | 'other_person' | undefined;
      for (const issue of stored.sequence<IntakeReviewIssue>('initialIssues')) {
        yield;
        if (issue.resolution?.outcome === 'other_person') return 'other_person' as const;
        if (issue.resolution?.outcome === 'unknown') answer = 'unknown';
      }
      return answer;
    })(),
  );
  stored.assertArtifacts();
  return { ...collected, hasUnstructuredIdentityQuestion, currentRefusal };
}
function peoplePreview(db: DatabaseSync) {
  const rows = db
    .prepare(
      `SELECT n.id FROM notes n WHERE n.kind='person' AND n.person_id!='patient' AND ${noteVisibilitySQL('n')}=0 ORDER BY n.title,n.id LIMIT 101`,
    )
    .all();
  return {
    people: rows.slice(0, 100).map((row) => {
      const note = getNote(db, String(row.id));
      return {
        noteId: note.id,
        personId: note.personId!,
        version: note.version,
        birthDate: typeof note.person.birthDate === 'string' ? note.person.birthDate : null,
        relationship:
          typeof note.person.relationship === 'string' ? note.person.relationship : null,
        fullName:
          typeof note.person.fullName === 'string' && note.person.fullName.trim()
            ? note.person.fullName.trim()
            : note.title,
      };
    }),
    peopleTruncated: rows.length > 100,
  };
}
function previewReadKey(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  groupId: string,
) {
  source(db, profileId, id);
  return JSON.stringify([
    root,
    profileId,
    id,
    groupId,
    intakeSourceVersion(db, id),
    clinicalReviewRevision(db),
    requestRevision(db),
  ]);
}
function sameOriginalEvidence(
  first: Awaited<ReturnType<typeof evidence>>,
  second: Awaited<ReturnType<typeof evidence>>,
) {
  return (
    first.sourceHash === second.sourceHash &&
    first.originalFingerprint === second.originalFingerprint &&
    first.verificationMode === second.verificationMode &&
    first.original.filename === second.original.filename &&
    first.original.contentUrl === second.original.contentUrl &&
    first.original.page === second.original.page &&
    first.pageText === second.pageText &&
    first.patientNameGrounded === second.patientNameGrounded
  );
}
/** Membership, including accepted/non-target occurrences, determines every required proposal. */
function* verifyPreviewArtifactsWork(context: Context, stored: Rows): Generator<void, void, void> {
  const { db, root, profileId, id } = context;
  const seen = rows();
  try {
    context.assertCurrent();
    const original = getRetainedIntakeOriginalReference(db, root, profileId, id);
    withIntakeWork(db, 'warm', () => recordIntakeWork('identityPreviewArtifactChecks'));
    const originalIdentity = yield* verifyIntakeFileHashWork(original.path, {
      bytes: original.size,
      sha256: original.sourceHash,
    });
    stored.retainArtifacts([{ id, path: original.path, identity: originalIdentity }]);
    yield;
    for (const member of context.membership()) {
      yield;
      for (const occurrence of member.occurrences) {
        // Checkpoints include empty and duplicate proposals: they still belong
        // to the complete selected membership and can grow independently.
        withIntakeWork(db, 'warm', () => recordIntakeWork('identityPreviewArtifactOccurrences'));
        yield;
        context.assertCurrent();
        const proposalId = occurrence.proposalId;
        if (!proposalId || seen.get('verifiedProposals', proposalId)) continue;
        const file = db
          .prepare('SELECT path,sha256,bytes FROM source_files WHERE id=?')
          .get(proposalId);
        if (!file) reject('A required retained proposal no longer exists');
        const path = profileOriginal(root, String(file!.path), profileId);
        withIntakeWork(db, 'warm', () => recordIntakeWork('identityPreviewArtifactChecks'));
        const identity = yield* verifyIntakeFileHashWork(path, {
          bytes: Number(file!.bytes),
          sha256: String(file!.sha256),
        });
        // Retain the identity returned by verification, never a later stat.
        // Existing cold-build proofs refuse a different identity for this id.
        stored.retainArtifacts([{ id: proposalId, path, identity }]);
        seen.put('verifiedProposals', proposalId, true);
      }
    }
    context.assertCurrent();
  } finally {
    seen.close();
  }
}

function detachIdentityPreview(value: IntakeIdentityReview): IntakeIdentityReview {
  return JSON.parse(JSON.stringify(value), (_key, item, context) =>
    typeof item === 'number' && context?.source && JSON.stringify(item) !== context.source
      ? JSON.rawJSON(context.source)
      : item,
  ) as IntakeIdentityReview;
}
export interface NativeIdentityReadOptions {
  signal?: AbortSignal;
  operation?: ClinicalOperation;
}
type PreviewFlight = {
  controller: AbortController;
  subscribers: number;
  settled: boolean;
  promise: Promise<IntakeIdentityReview>;
};
const previewFlights = new WeakMap<DatabaseSync, Map<string, PreviewFlight>>();
function subscribePreview(
  flight: PreviewFlight,
  signal?: AbortSignal,
): Promise<IntakeIdentityReview> {
  signal?.throwIfAborted();
  flight.subscribers++;
  return new Promise((resolve, reject) => {
    let done = false;
    const release = () => {
      if (done) return false;
      done = true;
      signal?.removeEventListener('abort', abort);
      flight.subscribers--;
      return true;
    };
    const abort = () => {
      if (!release()) return;
      reject(signal!.reason);
      if (!flight.settled && flight.subscribers === 0) flight.controller.abort();
    };
    signal?.addEventListener('abort', abort, { once: true });
    flight.promise.then(
      (value) => {
        if (!release()) return;
        try {
          resolve(detachIdentityPreview(value));
        } catch (error) {
          reject(error);
        }
      },
      (error) => {
        if (release()) reject(error);
      },
    );
    if (signal?.aborted) abort();
  });
}
/** Every preparation owns the database lane; coalesced cancellation belongs to subscribers. */
export function getNativeIntakeIdentityReview(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  groupId: string,
  options: NativeIdentityReadOptions = {},
): Promise<IntakeIdentityReview> {
  const prepare = (signal: AbortSignal | undefined, parent?: ClinicalOperation) =>
    runExclusiveClinicalOperation(
      db,
      async (operation) => {
        const assertRunning = () => {
          signal?.throwIfAborted();
          assertClinicalOperation(db, operation);
        };
        assertRunning();
        source(db, profileId, id);
        const epoch = beginNativeIdentityPreview(db),
          readKey = previewReadKey(db, root, profileId, id, groupId);
        const cached = readNativeIdentityPreview(db, readKey);
        if (cached) {
          const context = await open(db, root, profileId, id, groupId, assertRunning);
          let proof: Rows | undefined;
          try {
            proof = rows();
            await runNativeIdentityArtifactVerification(context, proof);
            const value = detachIdentityPreview(cached.value);
            const current = await proof.withVerifiedTerminal(
              {
                assertCurrent: () => {
                  assertRunning();
                  context.assertCurrent();
                },
                signal,
              },
              () =>
                cached.stamp === reviewReadStamp(db) &&
                readKey === previewReadKey(db, root, profileId, id, groupId) &&
                nativeIdentityPreviewCurrent(db, epoch),
            );
            if (current) return value;
          } catch (error) {
            if (!signal?.aborted) clearNativeIdentityPreviews(db);
            throw error;
          } finally {
            try {
              proof?.close();
            } finally {
              context.scope.close?.();
            }
          }
          clearNativeIdentityPreviews(db);
        }
        let certificate: { key: string; stamp: string } | undefined;
        const value = await getNativeIntakeIdentityReviewInner(
          db,
          root,
          profileId,
          id,
          groupId,
          assertRunning,
          signal,
          (key, stamp) => {
            certificate = { key, stamp };
          },
        );
        assertRunning();
        if (certificate && nativeIdentityPreviewCurrent(db, epoch))
          retainNativeIdentityPreview(db, certificate.key, certificate.stamp, value, epoch);
        return value;
      },
      { signal, operation: parent },
    ).catch((error: unknown) => {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof ClinicalPhysicalEvidenceChanged)
        throw new HttpError(409, 'SOURCE_CHANGED', 'Retained clinical evidence changed');
      throw error;
    });
  // A held owner cannot wait on a foreign flight queued behind itself.
  if (options.operation)
    return prepare(options.signal, options.operation).then(detachIdentityPreview);
  options.signal?.throwIfAborted();
  let flights = previewFlights.get(db);
  if (!flights) previewFlights.set(db, (flights = new Map()));
  const key = JSON.stringify([profileId, root, id, groupId]);
  const current = flights.get(key);
  if (current && !current.controller.signal.aborted)
    return subscribePreview(current, options.signal);
  const flight: PreviewFlight = {
    controller: new AbortController(),
    subscribers: 0,
    settled: false,
    promise: undefined!,
  };
  flights.set(key, flight);
  // Defer admission until the first subscriber has attached its lifetime.
  flight.promise = Promise.resolve()
    .then(() => prepare(flight.controller.signal))
    .catch((error) => {
      if (!flight.controller.signal.aborted) clearNativeIdentityPreviews(db);
      throw error;
    })
    .finally(() => {
      flight.settled = true;
      if (flights!.get(key) === flight) flights!.delete(key);
    });
  return subscribePreview(flight, options.signal);
}
async function getNativeIntakeIdentityReviewInner(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  groupId: string,
  assertRunning: () => void,
  signal?: AbortSignal,
  certified?: (key: string, stamp: string) => void,
): Promise<IntakeIdentityReview> {
  let context: Context;
  try {
    context = await open(db, root, profileId, id, groupId, assertRunning);
  } catch (error) {
    if (!(error instanceof IntakeReviewFragmentRequired)) throw error;
    return {
      status: 'conflict',
      blocking: true,
      message:
        'Inspect this exact retained identity evidence through its bounded fragments before individual review.',
      scope: null,
      scopeFragmentReference: error.reference,
      evidencedIdentity: {},
      self: selfSnapshot(db),
      offeredSelfFields: {},
      conflicts: [],
      ...peoplePreview(db),
    };
  }
  const stored = rows();
  try {
    let self = selfSnapshot(db);
    const correction = () => {
      const correctionRow = db
        .prepare(
          "SELECT coverage_json FROM manual_batches WHERE title='Report ownership default' AND json_extract(coverage_json,'$.intakeId')=? AND json_extract(coverage_json,'$.groupId')=? ORDER BY json_extract(coverage_json,'$.revision') DESC,id DESC LIMIT 1",
        )
        .get(id, groupId);
      const correctedAuthority = correctionRow
        ? (json(correctionRow.coverage_json) as {
            personId: string;
            noteId: string;
          })
        : null;
      const correctedNote = correctedAuthority ? getNote(db, correctedAuthority.noteId) : null;
      return correctedAuthority && correctedNote
        ? {
            personId: correctedAuthority.personId,
            fullName: correctedNote.person.fullName || correctedNote.title,
          }
        : undefined;
    };
    let correctedPerson = correction();
    if (context.group.basis !== 'report_anchor' || !context.group.report?.subject) {
      const initial = await collectGroupIdentity(context, stored);
      const assessment = await runNativeIdentityWork(
        context,
        stored,
        assessIdentityPolicyWork({
          self,
          people: selectedIdentityPeopleSnapshots(db),
          nameEvidenceGrounded: false,
          evidence: initial.evidence,
          evidenceConflicts: initial.conflicts,
          unreadableBirthDate: initial.unreadableBirthDate,
          group: context.group,
          groupVersionId: context.groupVersionId,
          originalFingerprint: context.scope.originalFingerprint(context.group),
          receipts: await runNativeIdentityWork(context, stored, context.scope.receiptsWork!()),
          hasUnstructuredIdentityQuestion: initial.hasUnstructuredIdentityQuestion,
          currentRefusal: initial.currentRefusal,
        }),
      );
      stored.assertArtifacts();
      return {
        ...assessment,
        scope: null,
        self,
        correctedPerson,
        ...peoplePreview(db),
      };
    }
    try {
      const original = await evidence(context);
      const firstStamp = reviewReadStamp(db),
        firstKey =
          firstStamp === undefined ? undefined : previewReadKey(db, root, profileId, id, groupId),
        firstGrounding = identityGroundingGeneration(db),
        firstOperation = currentClinicalOperation(db),
        firstRegistry = intakeCollectionCacheGeneration(db);
      // Callback-capable operation checks precede the closing SQL stamp; only
      // callback-free liveness and generation checks follow it.
      const firstBuildCurrent = () => {
        if (
          firstStamp === undefined ||
          firstOperation === undefined ||
          firstOperation !== currentClinicalOperation(db) ||
          firstStamp !== reviewReadStamp(db) ||
          firstKey !== previewReadKey(db, root, profileId, id, groupId) ||
          firstStamp !== reviewReadStamp(db)
        )
          return false;
        assertClinicalOperation(db, firstOperation);
        return (
          firstGrounding === identityGroundingGeneration(db) &&
          firstRegistry === intakeCollectionCacheGeneration(db)
        );
      };
      let built = await build(context, original, stored);
      let reuseFirstBuild = firstBuildCurrent();
      await runNativeIdentityWork(
        context,
        stored,
        retainSelectedIdentityGroundingWork(
          db,
          context.scope.groundingBoundary(profileId, id, context.file.sha256),
          context.group,
          built.groundedQuestions,
          original.patientNameGrounded,
          built.groundedNameQuestions,
          built.dates,
        ),
      );
      reuseFirstBuild = reuseFirstBuild && firstBuildCurrent();
      context.assertCurrent();
      // Capture before opening: even the asynchronous context read must belong
      // to the unchanged full reconstruction. Own writes suppress retention.
      const constructionStamp = reviewReadStamp(db),
        constructionKey = previewReadKey(db, root, profileId, id, groupId);
      context.scope.close?.();
      context = await open(db, root, profileId, id, groupId, assertRunning);
      self = selfSnapshot(db);
      correctedPerson = correction();
      await runNativeIdentityArtifactVerification(context, stored);
      const freshOriginal = await evidence(context);
      reuseFirstBuild =
        reuseFirstBuild && firstBuildCurrent() && sameOriginalEvidence(original, freshOriginal);
      if (!reuseFirstBuild) {
        stored.db
          .prepare("DELETE FROM rows WHERE section NOT IN ('initialIssues','initialExplicit')")
          .run();
        built = await build(context, freshOriginal, stored);
      } else stored.assertArtifacts();
      const catalog = createReportSnapshotCatalog(db, context.file, {
        catalog: 'report.snapshots',
        catalogArea: 'builds',
        assertRunning: context.assertCurrent,
        withVerifiedPublication: verifiedIdentityPublication(context, stored),
      });
      await writeSnapshot(context, built, stored, catalog, 'preview');
      const inlineWarnings: IntakeIdentityWarning[] = [];
      let warningBytes = 0;
      for (const warning of stored.sequence<IntakeIdentityWarning>('warnings')) {
        warningBytes += Buffer.byteLength(JSON.stringify(warning));
        if (inlineWarnings.length >= 100 || warningBytes > 64 * 1024) break;
        inlineWarnings.push(warning);
      }
      const warnings =
        inlineWarnings.length === stored.count('warnings')
          ? inlineWarnings.length
            ? { warnings: inlineWarnings }
            : {}
          : {
              warningsReference: await retainIdentityWarningsSnapshot({
                db: context.db,
                catalog,
                scope: built.display,
                digest: built.warningsSha256,
                count: stored.count('warnings'),
                rows: stored.raw('warnings'),
                run: (work) => runNativeIdentityWork(context, stored, work),
              }),
            };
      const changes = await catalog.finalChanges();
      const collections = selectedEnvelopeStore(db, context.file).collections,
        operationId = randomUUID();
      assertRunning();
      if (changes.length) {
        const prepared = collections.prepare(collections.openView(), {
          operationId,
          requestDigest: hash(operationId),
          domainVersion: context.before.rawVersion,
          changes,
        });
        try {
          await verifiedIdentityPublication(
            context,
            stored,
          )((terminalPhysicalCurrent) => {
            terminalPhysicalCurrent();
            collections.commitMaintenance(prepared, { assertCurrent: terminalPhysicalCurrent });
          });
        } finally {
          collections.disposePreparation(prepared);
        }
      }
      rememberPreview(db, built.display);
      const value: IntakeIdentityReview = {
        ...built.assessment,
        ...built.presentation,
        ...warnings,
        confirmationCount: built.confirmationCount,
        scope: null,
        scopeReference: built.display,
        evidenceCommitment: built.evidenceCommitment,
        self,
        correctedPerson,
        ...peoplePreview(db),
      };
      await runNativeIdentityArtifactVerification(context, stored);
      return await stored.withVerifiedTerminal(
        {
          assertCurrent: () => {
            assertRunning();
            context.assertCurrent();
          },
          signal,
        },
        () => {
          if (
            constructionStamp !== undefined &&
            constructionStamp === reviewReadStamp(db) &&
            constructionKey === previewReadKey(db, root, profileId, id, groupId)
          )
            certified?.(constructionKey, constructionStamp);
          return value;
        },
      );
    } catch (error) {
      if (error instanceof IntakeReviewFragmentRequired)
        return {
          status: 'conflict',
          blocking: true,
          message:
            'Inspect this exact retained identity evidence through its bounded fragments before individual review.',
          scope: null,
          scopeFragmentReference: error.reference,
          evidencedIdentity: {},
          self,
          correctedPerson,
          offeredSelfFields: {},
          conflicts: [],
          ...peoplePreview(db),
        };
      if (!(error instanceof HttpError) || error.code !== 'IDENTITY_SCOPE') throw error;
      const initial = await collectGroupIdentity(context, stored);
      return {
        status: 'conflict',
        blocking: true,
        message: error.message,
        scope: null,
        evidencedIdentity: initial.evidence,
        self,
        correctedPerson,
        offeredSelfFields: {},
        conflicts: initial.conflicts,
        ...peoplePreview(db),
      };
    }
  } finally {
    context.scope.close?.();
    stored.close();
  }
}
export async function readNativeIdentityScopePage(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  groupId: string,
  input: {
    scopeToken: string;
    section: string;
    snapshotId?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<IntakeIdentityScopePage> {
  return runExclusiveClinicalOperation(
    db,
    async () => readNativeIdentityScopePageInner(db, root, profileId, id, groupId, input),
    { operation: currentClinicalOperation(db) },
  );
}
async function readNativeIdentityScopePageInner(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  groupId: string,
  input: {
    scopeToken: string;
    section: string;
    snapshotId?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<IntakeIdentityScopePage> {
  const reference = await pageReference(db, root, profileId, id, groupId, input.scopeToken);
  if (!reference || reference.scopeToken !== input.scopeToken)
    reject('The identity scope changed; review its current pages');
  if (
    input.section !== 'warnings' &&
    !SECTIONS.includes(input.section as (typeof SECTIONS)[number])
  )
    throw new HttpError(400, 'IDENTITY_SCOPE_PAGE', 'Choose a scope collection');
  const section = input.section as IntakeIdentityScopeSection,
    limit = input.limit ?? 25;
  if (input.snapshotId && section !== 'warnings')
    throw new HttpError(
      400,
      'IDENTITY_SCOPE_PAGE',
      'A warning snapshot selects only advisory warnings',
    );
  const catalog = createReportSnapshotCatalog(db, source(db, profileId, id), {
    catalog: 'report.snapshots',
    catalogArea: 'builds',
  });
  const base = openIdentityScopeSnapshot(catalog, reference);
  const selected = input.snapshotId
    ? openIdentityWarningsSnapshot(catalog, reference, input.snapshotId)
    : undefined;
  const reader = selected?.reader || base;
  const total =
    selected?.count ??
    (section === 'warnings' ? Number(reader.get('$warningCount')) : reference.collection[section]);
  if (!Number.isSafeInteger(total) || total < 0)
    throw Error('Invalid retained identity collection count');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new HttpError(400, 'IDENTITY_SCOPE_PAGE', 'Read 1 to 100 scope items');
  let offset = 0;
  if (input.cursor) {
    try {
      const value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
      if (
        !Array.isArray(value) ||
        value.length !== 3 ||
        value[0] !== (input.snapshotId || reference.scopeToken) ||
        value[1] !== section ||
        !Number.isSafeInteger(value[2]) ||
        value[2] < 0 ||
        value[2] > total
      )
        throw Error();
      offset = value[2];
    } catch {
      throw new HttpError(409, 'IDENTITY_SCOPE_CURSOR', 'Reload these identity scope pages');
    }
  }
  const items: IntakeIdentityScopePage['items'] = [];
  let used = 0;
  for (; offset < total && items.length < limit; offset++) {
    const key = section + ':' + schemaOrdinal(offset);
    const value = reader.get(key);
    if (value === undefined) throw Error('Missing report snapshot text');
    // The owner's checked inline value or branded byte descriptor already pins
    // this exact length; deciding between a value and reference needs no drain.
    const size = typeof value === 'string' ? Buffer.byteLength(value) : value.bytes;
    const item: IntakeIdentityScopePage['items'][number] =
      size > 64 * 1024
        ? {
            kind: 'reference',
            reference: {
              format: 'health-intake-identity-item-v2',
              scopeToken: reference.scopeToken,
              ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
              section,
              ordinal: offset,
              bytes: size,
            },
          }
        : {
            kind: 'value',
            value: readIdentitySnapshotValue(reader, key, 64 * 1024),
          };
    const cost = Buffer.byteLength(JSON.stringify(item));
    if (items.length && used + cost > 128 * 1024) break;
    used += cost;
    items.push(item);
  }
  return {
    format: 'health-intake-identity-scope-page-v2',
    scopeToken: reference.scopeToken,
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    section,
    total,
    items,
    nextCursor:
      offset < total
        ? Buffer.from(
            JSON.stringify([input.snapshotId || reference.scopeToken, section, offset]),
          ).toString('base64url')
        : null,
  };
}
export async function readNativeIdentityScopeFragment(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  groupId: string,
  input: {
    scopeToken: string;
    section: string;
    snapshotId?: string;
    ordinal: number;
    offset?: number;
    cursor?: string;
  },
  options: { signal?: AbortSignal } = {},
) {
  return runExclusiveClinicalOperation(
    db,
    async () =>
      withVerifiedIntakeOriginalDescriptor(
        {
          db,
          root,
          profileId,
          id,
          assertRunning: () => {
            options.signal?.throwIfAborted();
            assertClinicalOperation(db);
          },
        },
        async ({ assertRunning: assertOriginal }) =>
          readNativeIdentityScopeFragmentInner(
            db,
            root,
            profileId,
            id,
            groupId,
            input,
            assertOriginal,
            options.signal,
          ),
      ),
    { operation: currentClinicalOperation(db), signal: options.signal },
  );
}
async function readNativeIdentityScopeFragmentInner(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  groupId: string,
  input: {
    scopeToken: string;
    section: string;
    snapshotId?: string;
    ordinal: number;
    offset?: number;
    cursor?: string;
  },
  assertOriginal: () => void,
  signal?: AbortSignal,
) {
  assertOriginal();
  const reference =
    (await pageReference(db, root, profileId, id, groupId, input.scopeToken)) ||
    reject('The identity scope is unavailable');
  if (
    !reference ||
    reference.scopeToken !== input.scopeToken ||
    (input.section !== 'warnings' && !SECTIONS.includes(input.section as (typeof SECTIONS)[number]))
  )
    reject('The identity scope changed; review its current pages');
  const section = input.section as IntakeIdentityScopeSection,
    offset = input.offset ?? 0;
  if (input.snapshotId && section !== 'warnings')
    throw new HttpError(
      400,
      'IDENTITY_SCOPE_PAGE',
      'A warning snapshot selects only advisory warnings',
    );
  const catalog = createReportSnapshotCatalog(db, source(db, profileId, id), {
    catalog: 'report.snapshots',
    catalogArea: 'builds',
  });
  const base = openIdentityScopeSnapshot(catalog, reference);
  const selected = input.snapshotId
    ? openIdentityWarningsSnapshot(catalog, reference, input.snapshotId)
    : undefined;
  const reader = selected?.reader || base;
  const total =
    selected?.count ??
    (section === 'warnings' ? Number(reader.get('$warningCount')) : reference.collection[section]);
  if (
    !Number.isSafeInteger(input.ordinal) ||
    input.ordinal < 0 ||
    input.ordinal >= total ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new HttpError(400, 'IDENTITY_SCOPE_FRAGMENT', 'Choose an exact scope item fragment');
  assertOriginal();
  const key = section + ':' + schemaOrdinal(input.ordinal),
    value = reader.get(key);
  if (value === undefined) throw Error('Missing report snapshot text');
  const size = typeof value === 'string' ? Buffer.byteLength(value) : value.bytes;
  if (input.cursor !== undefined) {
    // Only explicit first-page mode mints a new transport key. An expired or
    // malformed continuation never restarts or falls back to a prefix scan.
    if (db.isTransaction) reject('Identity fragments require current selected authority');
    const epoch = beginNativeIdentityPreview(db),
      binding = hash([
        'health-intake-identity-fragment-v1',
        profileId,
        id,
        groupId,
        source(db, profileId, id).sha256,
        reference.scopeToken,
        input.snapshotId || reference.collection.snapshotId,
        section,
        input.ordinal,
        size,
        previewBinding(db, id),
      ]);
    const position =
      input.cursor === 'start'
        ? offset === 0
          ? { offset: 0, after: null, skip: 0 }
          : reject('Start identity fragments at byte zero')
        : openNativeIdentityFragmentCursor(db, epoch, binding, input.cursor, offset);
    if (offset > size) reject('The identity fragment continuation is outside this item');
    if (offset === size) {
      if (offset !== 0) reject('This identity fragment continuation is already complete');
      return {
        encoding: 'base64' as const,
        data: '',
        complete: true,
        nextOffset: null,
        nextCursor: null,
      };
    }
    const page = reader.bytePage(key, position),
      nextOffset = offset + page.data.length;
    if (!page.data.length || nextOffset > size || page.complete !== (nextOffset === size))
      throw Error('Identity fragment byte length changed');
    catalog.assertCurrent();
    assertOriginal();
    if (!nativeIdentityPreviewCurrent(db, epoch)) reject('The identity fragment changed');
    return {
      encoding: 'base64' as const,
      data: page.data.toString('base64'),
      complete: page.complete,
      nextOffset: page.complete ? null : nextOffset,
      nextCursor: page.complete
        ? null
        : sealNativeIdentityFragmentCursor(db, epoch, binding, {
            offset: nextOffset,
            after: page.after,
            skip: page.skip,
          }),
    };
  }
  if (offset > size)
    throw new HttpError(
      400,
      'IDENTITY_SCOPE_FRAGMENT',
      'The fragment offset is outside this scope item',
    );
  // Numeric-only compatibility requests retain exact arbitrary byte offsets.
  // They scan the prefix cooperatively; sequential clients use cursors above.
  return runClinicalReviewWork(
    (function* () {
      const chunks: Buffer[] = [];
      let position = 0,
        used = 0;
      for (const piece of reader.chunks(key)) {
        const bytes = Buffer.from(piece),
          start = Math.max(0, offset - position);
        position += bytes.length;
        withIntakeWork(db, 'warm', () =>
          recordIntakeWork('identityFragmentLegacyReadBytes', bytes.length),
        );
        yield;
        if (start >= bytes.length) continue;
        const take = Math.min(bytes.length - start, 32768 - used);
        if (take) {
          chunks.push(bytes.subarray(start, start + take));
          used += take;
        }
        if (used === 32768) break;
      }
      if (used !== Math.min(32768, size - offset))
        throw Error('Identity fragment byte length changed');
      assertOriginal();
      const complete = offset + used === size;
      return {
        encoding: 'base64' as const,
        data: Buffer.concat(chunks).toString('base64'),
        complete,
        nextOffset: complete ? null : offset + used,
      };
    })(),
    {
      signal,
      capture() {
        assertOriginal();
        catalog.assertCurrent();
        const stamp = reviewPreparationStamp(db);
        if (stamp === undefined) reject('Identity fragments require current authority');
        return () => {
          assertOriginal();
          catalog.assertCurrent();
          if (reviewPreparationStamp(db) !== stamp)
            reject('Identity fragment changed during preparation');
        };
      },
    },
  );
}
export function confirmNativeIntakeIdentityScope(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: IntakeIdentityConfirmation,
) {
  source(db, profileId, id);
  return runExclusiveClinicalOperation(
    db,
    async () => confirmNativeIntakeIdentityScopeInner(db, root, profileId, id, input),
    { operation: currentClinicalOperation(db) },
  );
}
async function confirmNativeIntakeIdentityScopeInner(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: IntakeIdentityConfirmation,
) {
  const file = source(db, profileId, id),
    { version: _version, ...request } = input;
  const response = () => ({
    ...getIntakeRead(db, root, profileId, id),
    durability: flushIntake(db, root, profileId),
  });
  if (
    retainedIntakeWorkflowCommand(db, file, {
      operationId: input.operationId,
      request,
    })
  )
    return response();
  if (!Number.isSafeInteger(input.version) || intakeSourceVersion(db, id).version !== input.version)
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'This intake changed. Reload it before continuing.',
    );
  if (!('format' in input.scope) || input.scope.format !== 'health-intake-identity-scope-v2')
    reject('Review the current complete native identity scope before confirming');
  return withVerifiedIntakeOriginalDescriptor(
    { db, root, profileId, id },
    async ({ assertRunning: assertOriginal }) => {
      const assertRunning = () => {
        assertClinicalOperation(db);
        assertOriginal();
      };
      const context = await open(db, root, profileId, id, input.scope.groupId, assertRunning),
        stored = rows();
      try {
        const original = await evidence(context),
          built = await build(context, original, stored);
        await runNativeIdentityArtifactVerification(context, stored);
        const preparedPerson =
          input.personSelection && 'newPerson' in input.personSelection
            ? {
                noteId: 'note:' + randomUUID(),
                personId: 'person:' + randomUUID(),
                icon: undefined as string | undefined,
              }
            : undefined;
        // Run ordinary People validation in a rolled-back preview, then publish
        // those exact planned destinations inside the accepted transaction.
        let planned: ReturnType<typeof applyIdentityConfirmationPeople>;
        db.exec('SAVEPOINT identity_people_preview');
        try {
          planned = applyIdentityConfirmationPeople(
            db,
            profileId,
            id,
            input,
            built.current,
            built.display,
            built.assessment,
            context.scope.receipts,
            preparedPerson,
          );
        } finally {
          db.exec('ROLLBACK TO identity_people_preview');
          db.exec('RELEASE identity_people_preview');
        }
        if (preparedPerson && planned.createdPerson)
          preparedPerson.icon = planned.createdPerson.person.icon;
        context.assertCurrent();
        const mappingVersion = () =>
            workflowHash(
              activeMappingRules(
                db,
                intakeSourceMetadata(db, id).metadata?.sourceProviderId || file.provider_id,
              ),
            ),
          selectedMappingVersion = mappingVersion();
        const ready = await prepareCollectionWorkflowReadiness(db, root, profileId, id, {
          mappingVersion: selectedMappingVersion,
          currentMappingVersion: mappingVersion,
          assertRunning: context.assertCurrent,
        });
        if (ready.state !== 'ready')
          throw new HttpError(
            409,
            'WORKFLOW_PREPARATION_REQUIRED',
            'Prepare the complete retained review before confirming identity',
          );
        const catalog = createReportSnapshotCatalog(db, file, {
          assertRunning: context.assertCurrent,
          withVerifiedPublication: verifiedIdentityPublication(context, stored),
        });
        const draftCatalog = createReportSnapshotCatalog(db, file, {
          catalog: 'review.snapshots',
          assertRunning: context.assertCurrent,
          withVerifiedPublication: verifiedIdentityPublication(context, stored),
        });
        const at = now(),
          correction = planned.assignedPerson
            ? { subject: 'other', personId: planned.assignedPerson.personId }
            : { subject: 'self', personId: undefined };
        for (const target of planned.confirmationTargets) {
          context.assertCurrent();
          const previousRecord = context.view.lookup('draft-record-version-last', [
            target.proposalId || '',
            target.recordId,
            target.candidateVersionId,
          ]);
          const previous = previousRecord
            ? await runNativeIdentityWork(
                context,
                stored,
                readNativeReviewDraftWork(context.view, previousRecord, draftCatalog, 256 * 1024, {
                  db,
                  source: file,
                }),
              )
            : undefined;
          const targetHash = createHash('sha256');
          await runNativeIdentityWork(
            context,
            stored,
            (function* () {
              for (const piece of canonicalReviewValueChunks(target)) {
                yield;
                targetHash.update(piece);
              }
            })(),
          );
          const draftId = input.operationId + ':' + targetHash.digest('hex');
          const draft: IntakeReviewDraft = {
            ...previous,
            id: draftId,
            proposalId: target.proposalId,
            recordId: target.recordId,
            candidateId: target.candidateId,
            candidateVersionId: target.candidateVersionId,
            mapping: { ...previous?.mapping, ...correction },
            resolutions: [],
            disposition: previous?.disposition || 'pending',
            at,
          };
          const history = await prepareNativeDraftHistory(
            db,
            file,
            context.view,
            previousRecord,
            draft,
            {
              assertRunning: context.assertCurrent,
              catalog: draftCatalog,
              resolutionOperationId: input.operationId,
              newResolutions: (function* () {
                for (const issueId of target.issueIds || [target.issueId])
                  yield {
                    issueId,
                    outcome: planned.assignedPerson
                      ? ('other_person' as const)
                      : ('this_is_me' as const),
                    mapping: correction,
                    at,
                    operationId: input.operationId,
                  };
              })(),
            },
          );
          stored.put('drafts', String(stored.count('drafts')), history.draft);
        }
        await writeSnapshot(context, built, stored, catalog, 'confirmation');
        const draftSnapshotId =
          built.display.collection.snapshotId + ':drafts:' + hash(input.operationId);
        const draftWriter = await catalog.fork();
        await draftWriter.put('$format', 'health-intake-identity-drafts-v1');
        let draftOrdinal = 0;
        for (const draft of stored.sequence<IntakeReviewDraft>('drafts'))
          await draftWriter.put(
            'draftId:' + schemaOrdinal(draftOrdinal++),
            JSON.stringify(draft.id),
          );
        await draftWriter.put('$count', String(draftOrdinal));
        await catalog.publish(draftSnapshotId, draftWriter);
        const prepared = await prepareIntakeWorkflowCommand(db, file, {
          version: input.version,
          operationId: input.operationId,
          request,
          createdAt: at,
          additionalLogicalChanges: [
            ...(await catalog.finalChanges()),
            ...(await draftCatalog.finalChanges()),
          ],
          assertRunning: context.assertCurrent,
          *changes({ workflow }) {
            for (const draft of stored.sequence<IntakeReviewDraft>('drafts'))
              yield {
                op: 'append',
                record: workflow,
                field: 'reviewDrafts',
                jsonText: JSON.stringify(draft),
              };
            yield {
              op: 'append',
              record: workflow,
              field: 'identityConfirmations',
              jsonText: JSON.stringify({
                format: 'health-intake-identity-receipt-v2',
                operationId: input.operationId,
                at,
                scope: built.display,
                outcome: input.outcome,
                attestation: input.attestation,
                ...(planned.answers ? { identityAnswers: structuredClone(planned.answers) } : {}),
                draftCollection: {
                  snapshotId: draftSnapshotId,
                  count: stored.count('drafts'),
                },
                ...(planned.assignedPerson ? { assignedPerson: planned.assignedPerson } : {}),
                ...(planned.knownNameAdded ? { knownNameAdded: planned.knownNameAdded } : {}),
                confirmedPrintedName: planned.confirmedPrintedName,
                ...(planned.selfUpdate ? { selfUpdate: planned.selfUpdate } : {}),
              }),
            };
          },
        });
        // No partial fan-out descriptor is published. This root remains visibly
        // pending until the existing complete bounded projection preparation runs.
        if (!prepared.replayed)
          intakeTransaction(
            db,
            () => {
              prepared.assertCurrent();
              context.assertCurrent();
              stored.assertArtifacts();
              catalog.assertCurrent();
              draftCatalog.assertCurrent();
              const applied = applyIdentityConfirmationPeople(
                db,
                profileId,
                id,
                input,
                built.current,
                built.display,
                built.assessment,
                context.scope.receipts,
                preparedPerson,
              );
              for (const field of [
                'assignedPerson',
                'knownNameAdded',
                'confirmedPrintedName',
                'selfUpdate',
              ] as const)
                if (
                  canonicalLiteral(applied[field] ?? null) !==
                  canonicalLiteral(planned[field] ?? null)
                )
                  reject('The selected People destination changed during confirmation');
              selectedEnvelopeStore(db, file).collections.stage(prepared.prepared);
            },
            {
              operationId: prepared.publicationId,
              fingerprint: prepared.fingerprint,
            },
          );
        return response();
      } finally {
        context.scope.close?.();
        stored.close();
      }
    },
  );
}
import { intakeFirstLocatorMatches } from './intake-state-access.ts';
import { COMPACT_SCALAR_FORMAT } from './intake-compact-scalar.ts';
import { schemaKey as locatorScalarHash } from './intake-envelope-schema.ts';
