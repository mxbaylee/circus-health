/** Native common identity uses complete repeatable authority and exact scoped references. */
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  HttpError,
  clinicalReviewRevision,
  revision as requestRevision,
  now,
  json,
} from './database.ts';
import { recordIntakeWork, withIntakeWork } from './intake-work-accounting.ts';
import { canonicalLiteral } from './intake-format.ts';
import { collectSelectedEvidencedIdentity } from './intake-identity-name-evidence.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { reviewReadStamp } from './intake-clinical-review-read-cache.ts';
import {
  beginNativeIdentityPreview,
  nativeIdentityPreviewCurrent,
  readNativeIdentityPreview,
  retainNativeIdentityPreview,
  clearNativeIdentityPreviews,
} from './intake-identity-preview-cache.ts';
import { verifyIntakeFileHash } from './intake-files.ts';
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
import { createReportSnapshotCatalog } from './intake-report-snapshot-catalog.ts';
import { openReportMemberSnapshot } from './intake-report-member-state.ts';
import { readNativeReviewDraft, prepareNativeDraftHistory } from './intake-review-draft-state.ts';
import { prepareRetainedPlanAccess, readRetainedPlanEvidence } from './intake-retained-plan.ts';
import {
  prepareCollectionClinicalReviewDependencies,
  prepareCollectionClinicalReview,
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
import { INTAKE_TREE_VALUE_BYTES } from './intake-state-tree.ts';
import {
  assessIdentityPolicy,
  collectEvidencedIdentity,
  currentIdentityRefusal,
  repeatedIdentityQuestionReceipt,
  exactCurrentIdentityResolutionOperationId,
  identityReceiptAppliesToCurrentBoundary,
  identityOriginalFingerprintForMember,
  identityPersonFingerprint,
  identityTargetHasIssue,
  isGenericNameConfirmation,
  iterateCompetingIdentityBoundaries,
  type IdentityPolicyReceipt,
  type IdentityPolicyMember,
  type IdentityPolicyTarget,
} from './intake-identity-policy.ts';
import { retainSelectedIdentityGrounding } from './intake-identity-grounding.ts';
import { selectedIdentityPeopleSnapshots } from './intake-identity-people.ts';
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
    await prepareRetainedPlanAccess(db, profileId, id, { assertRunning: assertCurrent });
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
  const catalog = createReportSnapshotCatalog(db, file);
  const scope = collectionWorkflowReviewScope({
    view,
    catalog,
    metadataBytes: 256 * 1024,
    identityReceiptWork: (metric) => withIntakeWork(db, 'warm', () => recordIntakeWork(metric)),
    packageEvidence: file.mime_type === 'application/zip' || !!plan?.hasMembers,
    readDraft: (record) =>
      readNativeReviewDraft(
        view,
        record,
        createReportSnapshotCatalog(db, file, { catalog: 'review.snapshots' }),
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
              const page = members.occurrences(selected, { after, items: 64, bytes: 256 * 1024 });
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
            ? { section: scalar<IdentityPolicyMember['section']>(view, selected, 'section') }
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
    const child = db
      .prepare(
        "SELECT id FROM source_files WHERE sha256=? AND json_extract(details_json,'$.intake.parentSourceFileId')=? AND json_extract(details_json,'$.intake.locator')=?",
      )
      .get(member.sourceHash, id, member.locator);
    if (!child)
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
      text = decodeOriginalIdentityText(text, reference.filename);
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
  scratch.db.exec(
    `CREATE TABLE pieces(section TEXT,key TEXT,ordinal INTEGER,value TEXT,PRIMARY KEY(section,key,ordinal));
    CREATE TABLE counts(section TEXT PRIMARY KEY,count INTEGER NOT NULL);
    CREATE TABLE rows(section TEXT NOT NULL,key TEXT NOT NULL,ordinal INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(section,key));
    CREATE INDEX ordered ON rows(section,ordinal);
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
  const putStream = (section: string, key: string, pieces: Iterable<string>) => {
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
      }
  };
  const raw = function* (section: string) {
    const order = section === 'competingSubjects' ? 'key' : 'ordinal';
    for (const row of scratch.db
      .prepare('SELECT key,value FROM rows WHERE section=? ORDER BY ' + order)
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
  function putTarget(section: string, key: string, value: Target, issues?: Iterable<string>) {
    const { issueIds: _issueIds, ...header } = value;
    const issueSection = 'targetIssues:' + section + ':' + key;
    scratch.db.prepare('DELETE FROM rows WHERE section=?').run(issueSection);
    if (issues) for (const issueId of issues) put(issueSection, issueId, issueId);
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
    count,
    get,
    put,
    putStream,
    target,
    putTarget,
    addTargetIssue,
    raw,
    sequence,
    chunks,
  };
}
type Rows = ReturnType<typeof rows>;
async function build(
  context: Context,
  original: Awaited<ReturnType<typeof evidence>>,
  stored: Rows,
) {
  withIntakeWork(context.db, 'warm', () => recordIntakeWork('identityPreviewFullPreparations'));
  const { db, root, profileId, id, view, workflow, group, scope } = context;
  const currentSelf = selfSnapshot(db),
    people = selectedIdentityPeopleSnapshots(db);
  for (const question of intakeReviewChildren(view, workflow, 'questions'))
    if (
      !scalar(view, question, 'candidateId') &&
      scalar(view, question, 'status') !== 'resolved' &&
      (scalar(view, question, 'field') === 'subject' ||
        /\b(patient|subject|identity)\b/i.test(scalar<string>(view, question, 'prompt') || ''))
    )
      reject('Resolve the delivery identity question before common confirmation');
  type GroundedQuestion = {
    issue: Pick<IntakeReviewIssue, 'prompt' | 'textAnchor'>;
    receipt: { operationId: string; scope: { scopeToken: string; profileId: string } };
  };
  const groundedQuestions = stored.sequence<GroundedQuestion>('groundedQuestions');
  const groundedNameQuestions =
    stored.sequence<Pick<IntakeReviewIssue, 'prompt' | 'textAnchor'>>('groundedNameQuestions');
  let hasUnstructuredIdentityQuestion = false;
  let assignedPerson: IntakeIdentityPerson | undefined;
  let occurrenceCount = 0,
    consistentAssignment = true,
    allEvidenced = true;
  let cached:
    | {
        proposalId: string | null;
        selected: Extract<ReturnType<typeof prepareCollectionClinicalReview>, { status: 'ready' }>;
      }
    | undefined;
  async function reviewRecord(
    proposalId: string | null,
    recordId: string,
    candidateId: string,
    candidateVersionId: string,
  ) {
    if (!cached || cached.proposalId !== proposalId) {
      cached?.selected.session.close();
      cached = undefined;
      await prepareCollectionClinicalReviewDependencies(db, root, profileId, id, proposalId, {
        assertRunning: context.assertCurrent,
      });
      const selected = prepareCollectionClinicalReview(db, root, profileId, id, proposalId);
      if (selected.status !== 'ready')
        return reject(
          'Prepare this exact retained clinical occurrence before identity confirmation',
        );
      cached = { proposalId, selected };
    }
    const record = cached.selected.session.record(recordId, candidateId, candidateVersionId);
    if (!record) return reject('The current report occurrence differs from the displayed member');
    return record;
  }
  try {
    for (const member of context.membership()) {
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
        const record = await reviewRecord(
          occurrence.proposalId,
          occurrence.recordId,
          member.candidateId,
          member.candidateVersionId,
        );
        const person = record.identityAttribution?.assignedPerson;
        if (!occurrenceCount) assignedPerson = person;
        else if (person?.personId !== assignedPerson?.personId) consistentAssignment = false;
        occurrenceCount++;
        allEvidenced &&= record.identityReview?.status === 'evidenced_match';
        for (const warning of reviewRecordIdentityWarnings(record))
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
        if (scalar(view, version!, 'status') !== 'pending') continue;
        const genericId =
          'issue:' +
          createHash('sha256')
            .update(JSON.stringify([member.candidateVersionId, 'identity', 'subject']))
            .digest('hex');
        const identity = reviewRecordIssues(record).filter((issue) => issue.kind === 'identity');
        for (const issue of identity) stored.put('issues', String(stored.count('issues')), issue);
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
          stored.putTarget(
            'assignmentTargets',
            key,
            target(
              identity.find((issue) => issue.id === genericId)?.id ||
                identity.at(0)?.id ||
                genericId,
            ),
            identity.length ? identity.map((issue) => issue.id) : undefined,
          );
        const unresolved = identity.filter((issue) => issue.status === 'unresolved');
        const explicitIssues = identity
          .filter((issue) => issue.id !== genericId && !issue.selfSuggestion)
          .filter((issue) => {
            if (
              original.pageText?.includes(issue.textAnchor || '\u0000') &&
              isGenericNameConfirmation(issue, group.report?.subject?.text, currentSelf, people)
            ) {
              stored.put('groundedNameQuestions', hash([issue.prompt, issue.textAnchor]), {
                prompt: issue.prompt,
                ...(issue.textAnchor ? { textAnchor: issue.textAnchor } : {}),
              });
              return false;
            }
            const receipt = repeatedIdentityQuestionReceipt({
              issue,
              group,
              receipts: scope.receipts,
              profileId,
              intakeId: id,
              sourceHash: context.file.sha256,
              originalFingerprint: original.originalFingerprint,
              grounded: () =>
                !!issue.textAnchor && original.pageText?.includes(issue.textAnchor) === true,
            });
            if (!receipt) return true;
            stored.put(
              'groundedQuestions',
              hash([issue.prompt, issue.textAnchor, receipt.operationId, receipt.scope.scopeToken]),
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
            return false;
          });
        for (const issue of explicitIssues) {
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
        if (!unresolved.length || record.reviewState !== 'pending') continue;
        const additional = unresolved.filter((issue) => issue.id !== genericId);
        for (const issue of additional) {
          const question = {
            prompt: issue.prompt,
            ...(issue.textAnchor ? { textAnchor: issue.textAnchor } : {}),
          };
          stored.put('questions', canonicalLiteral(question), question);
        }
        if (!stored.target('targets', key))
          stored.putTarget(
            'targets',
            key,
            target(unresolved.find((issue) => issue.id === genericId)?.id || unresolved.at(0)!.id),
            additional.length ? unresolved.map((issue) => issue.id) : undefined,
          );
      }
    }
  } finally {
    cached?.selected.session.close();
  }
  const dates = originalSubjectBirthDateEvidence(
    original.pageText,
    group.report!.subject!.text,
    group.report!.anchor.text,
  );
  const collected = collectEvidencedIdentity(
    stored.sequence<IntakeReviewIssue>('issues'),
    original.pageText === null || original.patientNameGrounded ? group.report?.subject?.text : '',
    dates,
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
  const receiptApplies = (receipt: IdentityPolicyReceipt) =>
    !!(receipt.scope.assignmentTargets || receipt.scope.targets).length &&
    identityReceiptAppliesToCurrentBoundary(receipt, {
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
    });
  type Explicit = Target & {
    issueIds: string[];
    issues: { id: string; prompt: string; textAnchor?: string }[];
    resolutions: NonNullable<IntakeReviewRecord['draft']>['resolutions'];
  };
  for (const occurrence of stored.sequence<Explicit>('explicit')) {
    const issueId = occurrence.issueIds[0]!;
    if (
      exactCurrentIdentityResolutionOperationId({
        receipts: scope.receipts,
        occurrences: [occurrence],
        receiptApplies,
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
  for (const other of iterateCompetingIdentityBoundaries(
    group,
    (function* () {
      for (const record of scope.groupRecords()) yield scope.groupHeader(record);
    })(),
  )) {
    const record = view.find('reportGroup', workflow, other.id)!,
      latest = scope.currentGroupVersion(record)!;
    stored.put('competingSubjects', other.id, {
      groupId: other.id,
      groupVersionId: scalar<string>(view, latest, 'id')!,
      subject: other.report!.subject!,
    });
  }
  if (stored.count('competingSubjects')) {
    // Preserve the complete alternative readings without concatenating an unbounded banner.
    const prompt =
      'Other extraction claims name a different subject at this same report boundary. Review the original and confirm the displayed subject and person for only the listed records.';
    stored.putStream(
      'questions',
      'competing-boundary',
      (function* () {
        yield '{"prompt":' + canonicalLiteral(prompt) + ',"textAnchor":"';
        let comma = false;
        for (const row of stored.raw('competingSubjects')) {
          const claim = JSON.parse([...row.chunks()].join('')) as { subject: { text: string } };
          if (comma) yield ' / ';
          comma = true;
          yield JSON.stringify(claim.subject.text).slice(1, -1);
        }
        yield '"}';
      })(),
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
  // Literal scope recipe retains complete ordered membership/targets/questions.
  function* canonicalSnapshot() {
    const keys = [
      ...Object.keys(header),
      'membership',
      'targets',
      'assignmentTargets',
      ...(stored.count('questions') ? ['questions'] : []),
      ...(stored.count('competingSubjects') ? ['competingSubjects'] : []),
    ].sort();
    yield '{';
    let comma = false;
    for (const name of keys) {
      if (comma) yield ',';
      comma = true;
      yield JSON.stringify(name) + ':';
      if (name === 'membership') yield* context.membershipChunks();
      else if (SECTIONS.includes(name as (typeof SECTIONS)[number])) yield* stored.chunks(name);
      else yield canonicalLiteral(header[name as keyof typeof header]);
    }
    yield '}';
  }
  const digest = createHash('sha256');
  digest.update('[');
  for (const piece of canonicalSnapshot()) digest.update(piece);
  digest.update(',' + canonicalLiteral(original.sourceHash) + ']');
  const scopeToken = digest.digest('hex');
  const display: IntakeIdentityScopeReference = {
    ...header,
    format: 'health-intake-identity-scope-v2',
    scopeToken,
    collection: {
      snapshotId: 'identity:' + scopeToken,
      membership: (() => {
        let count = 0;
        for (const _member of context.membership()) count++;
        return count;
      })(),
      targets: stored.count('targets'),
      assignmentTargets: stored.count('assignmentTargets'),
      questions: stored.count('questions'),
      competingSubjects: stored.count('competingSubjects'),
    },
  };
  let explicitlyConfirmedOperationId = stored.count('targets')
    ? undefined
    : exactCurrentIdentityResolutionOperationId({
        receipts: scope.receipts,
        occurrences: stored.sequence<Explicit>('explicit'),
        receiptApplies,
      });
  if (stored.count('competingSubjects')) {
    const claims =
      stored.sequence<NonNullable<IntakeIdentityScope['competingSubjects']>[number]>(
        'competingSubjects',
      );
    const repair = scope.receipts.findLast(
      (receipt) =>
        receiptApplies(receipt) &&
        receipt.scope.groupId === group.id &&
        receipt.attestation === 'confirmed_displayed_identity_questions' &&
        receipt.scope.competingSubjects?.length === claims.length &&
        claims.every((claim) =>
          receipt.scope.competingSubjects!.some(
            (prior) => canonicalLiteral(prior) === canonicalLiteral(claim),
          ),
        ) &&
        stored.count('assignmentTargets') > 0 &&
        stored
          .sequence<Target>('assignmentTargets')
          .every((target) =>
            (receipt.scope.assignmentTargets || receipt.scope.targets).some(
              (prior) =>
                prior.candidateId === target.candidateId &&
                prior.candidateVersionId === target.candidateVersionId &&
                prior.proposalId === target.proposalId &&
                prior.recordId === target.recordId &&
                selectedSequence(target.issueIds || [target.issueId]).every((issueId) =>
                  identityTargetHasIssue(prior, issueId),
                ),
            ),
          ),
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
  const assessment = assessIdentityPolicy({
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
    receipts: scope.receipts,
    hasUnstructuredIdentityQuestion,
    explicitlyConfirmedOperationId,
    currentRefusal: currentIdentityRefusal(stored.sequence<IntakeReviewIssue>('issues')),
  });
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
  return {
    display,
    current,
    assessment,
    groundedQuestions,
    groundedNameQuestions,
    dates,
    presentation,
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
  entries.set(reference.scopeToken, { reference, binding: previewBinding(db, reference.intakeId) });
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
  const review = await getNativeIntakeIdentityReview(db, root, profileId, id, groupId);
  return review.scopeReference || reject('The identity scope is unavailable');
}
async function writeSnapshot(
  context: Context,
  built: Awaited<ReturnType<typeof build>>,
  stored: Rows,
  catalog: ReturnType<typeof createReportSnapshotCatalog>,
) {
  const previous = catalog.open(built.display.collection.snapshotId);
  if (previous) {
    if (!identitySnapshotScopeMatches(previous, built.display))
      throw Error('Identity snapshot binding mismatch');
    return;
  }
  const writer = await catalog.fork();
  // Small JSON rows stay in bounded inline batches. Allocating a separate byte
  // collection for every issue ID or occurrence amplifies unchanged tree paths.
  let pending: { key: string; value: string }[] = [],
    pendingBytes = 0;
  const flush = async () => {
    if (pending.length) await writer.putMany(pending);
    pending = [];
    pendingBytes = 0;
  };
  const put = async (key: string, value: string) => {
    if (
      Buffer.byteLength(value) > INTAKE_TREE_VALUE_BYTES ||
      Buffer.byteLength(JSON.stringify({ kind: 'inline', text: value })) > INTAKE_TREE_VALUE_BYTES
    ) {
      await flush();
      await writer.putText(key, [value]);
      return;
    }
    const cost = Buffer.byteLength(key) + Buffer.byteLength(value);
    if (pending.length && (pending.length === 16 || pendingBytes + cost > 64 * 1024)) await flush();
    pending.push({ key, value });
    pendingBytes += cost;
  };
  const putText = async (key: string, pieces: Iterable<string>) => {
    const iterator = pieces[Symbol.iterator](),
      prefix: string[] = [];
    let bytes = 0;
    for (;;) {
      const next = iterator.next();
      if (next.done) {
        await put(key, prefix.join(''));
        return;
      }
      bytes += Buffer.byteLength(next.value);
      prefix.push(next.value);
      if (bytes > INTAKE_TREE_VALUE_BYTES) {
        await flush();
        await writer.putText(
          key,
          (function* () {
            yield* prefix;
            for (;;) {
              const next = iterator.next();
              if (next.done) return;
              yield next.value;
            }
          })(),
        );
        return;
      }
    }
  };
  await put('$format', IDENTITY_SNAPSHOT_FORMAT);
  await putText('$scope', [JSON.stringify(built.display)]);
  await put('$warningCount', String(stored.count('warnings')));
  let warningOrdinal = 0;
  for (const row of stored.raw('warnings'))
    await putText('warnings:' + schemaOrdinal(warningOrdinal++), row.chunks());
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
            await put(
              'targetIssue:' + targetKey + ':' + schemaOrdinal(count++),
              JSON.stringify(issueId),
            );
            await put(
              'targetLookup:' +
                targetKey +
                ':' +
                createHash('sha256').update(issueId).digest('hex'),
              '1',
            );
          }
        } else
          await put(
            'targetLookup:' +
              targetKey +
              ':' +
              createHash('sha256').update(target.issueId).digest('hex'),
            '1',
          );
        await putText('targetHeader:' + targetKey, [
          JSON.stringify({
            ...header,
            hasIssueIds: !!issueIds,
            issueCount: count,
            hasIssueLookup: true,
          }),
        ]);
      }
      if (section === 'questions') {
        const digest = createHash('sha256');
        for (const piece of row.chunks()) digest.update(piece);
        await put('questionHash:' + schemaOrdinal(index), digest.digest('hex'));
      }
      context.assertCurrent();
      await putText(section + ':' + schemaOrdinal(index++), row.chunks());
    }
  }
  let index = 0;
  for (const member of context.membership()) {
    const memberKey = schemaOrdinal(index++),
      { occurrences, ...header } = member;
    let occurrenceCount = 0;
    for (const occurrence of occurrences) {
      context.assertCurrent();
      await putText('occurrence:' + memberKey + ':' + schemaOrdinal(occurrenceCount++), [
        canonicalLiteral(occurrence),
      ]);
    }
    await putText('member:' + memberKey, [canonicalLiteral({ ...header, occurrenceCount })]);
    await flush();
    await putText(
      'membership:' + memberKey,
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
  await flush();
  await catalog.publish(built.display.collection.snapshotId, writer);
}
async function collectGroupIdentity(context: Context, stored: Rows) {
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
      const candidate = context.view.find('candidate', context.workflow, member.candidateId);
      if (!candidate) continue;
      const latest = context.view.childAt(
        candidate,
        'versions',
        context.view.childCount(candidate, 'versions') - 1,
      );
      if (!latest || scalar(context.view, latest, 'id') !== member.candidateVersionId) continue;
      for (const occurrence of member.occurrences) {
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
          const selected = prepareCollectionClinicalReview(
            context.db,
            context.root,
            context.profileId,
            context.id,
            occurrence.proposalId,
          );
          if (selected.status !== 'ready')
            return reject('Prepare this exact retained clinical occurrence before identity review');
          cached = { proposalId: occurrence.proposalId, session: selected.session };
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
        for (const issue of reviewRecordIssues(record))
          if (issue.kind === 'identity') {
            stored.put('initialIssues', String(stored.count('initialIssues')), issue);
            if (issue.id !== genericId && !issue.selfSuggestion)
              stored.put('initialExplicit', String(stored.count('initialExplicit')), issue);
          }
      }
    }
  } finally {
    cached?.session.close();
  }
  const collected = collectSelectedEvidencedIdentity(
    () => stored.sequence<IntakeReviewIssue>('initialIssues'),
    context.group.report?.subject?.text,
  );
  const hasIdentityContext = !!(
    context.group.report?.subject ||
    collected.evidence.fullName ||
    collected.evidence.birthDate ||
    collected.unreadableBirthDate ||
    collected.conflicts.length
  );
  return {
    ...collected,
    hasUnstructuredIdentityQuestion: stored
      .sequence<IntakeReviewIssue>('initialExplicit')
      .some(
        (issue) =>
          !!(
            hasIdentityContext ||
            issue.textAnchor ||
            issue.questionId ||
            issue.resolution?.outcome === 'unknown' ||
            issue.resolution?.outcome === 'other_person'
          ),
      ),
    currentRefusal: currentIdentityRefusal(stored.sequence<IntakeReviewIssue>('initialIssues')),
  };
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
/** Membership, including accepted/non-target occurrences, determines every required proposal. */
function verifyPreviewArtifacts(context: Context) {
  const { db, root, profileId, id } = context;
  const seen = rows();
  try {
    withIntakeWork(db, 'warm', () => recordIntakeWork('identityPreviewArtifactChecks'));
    verifyIntakeOriginal(db, root, profileId, id);
    for (const member of context.membership())
      for (const occurrence of member.occurrences) {
        context.assertCurrent();
        const proposalId = occurrence.proposalId;
        if (!proposalId || seen.get('verifiedProposals', proposalId)) continue;
        const file = db
          .prepare('SELECT path,sha256,bytes FROM source_files WHERE id=?')
          .get(proposalId);
        if (!file) reject('A required retained proposal no longer exists');
        withIntakeWork(db, 'warm', () => recordIntakeWork('identityPreviewArtifactChecks'));
        verifyIntakeFileHash(profileOriginal(root, String(file!.path), profileId), {
          bytes: Number(file!.bytes),
          sha256: String(file!.sha256),
        });
        seen.put('verifiedProposals', proposalId, true);
      }
    withIntakeWork(db, 'warm', () => recordIntakeWork('identityPreviewArtifactChecks'));
    verifyIntakeOriginal(db, root, profileId, id);
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
const sourceLanes = new WeakMap<DatabaseSync, Map<string, Promise<unknown>>>();
const previewFlights = new WeakMap<DatabaseSync, Map<string, Promise<IntakeIdentityReview>>>();
function sourceLane<T>(db: DatabaseSync, id: string, work: () => Promise<T>): Promise<T> {
  let lanes = sourceLanes.get(db);
  if (!lanes) sourceLanes.set(db, (lanes = new Map()));
  const previous = lanes.get(id),
    next = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(work);
  lanes.set(id, next);
  void next
    .finally(() => {
      if (lanes!.get(id) === next) lanes!.delete(id);
    })
    .catch(() => undefined);
  return next;
}
/** Shared snapshot publication captures fresh pins after an earlier source operation finishes. */
export function getNativeIntakeIdentityReview(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  groupId: string,
): Promise<IntakeIdentityReview> {
  try {
    source(db, profileId, id);
  } catch (error) {
    clearNativeIdentityPreviews(db);
    return Promise.reject(error);
  }
  let flights = previewFlights.get(db);
  if (!flights) previewFlights.set(db, (flights = new Map()));
  const key = JSON.stringify([profileId, root, id, groupId]);
  const current = flights.get(key);
  if (current) return current.then(detachIdentityPreview);
  const next = sourceLane(db, id, async () => {
    const epoch = beginNativeIdentityPreview(db),
      readKey = previewReadKey(db, root, profileId, id, groupId);
    const cached = readNativeIdentityPreview(db, readKey);
    if (cached) {
      const context = await open(db, root, profileId, id, groupId);
      try {
        verifyPreviewArtifacts(context);
        const value = detachIdentityPreview(cached.value);
        verifyPreviewArtifacts(context);
        if (
          cached.stamp === reviewReadStamp(db) &&
          readKey === previewReadKey(db, root, profileId, id, groupId) &&
          nativeIdentityPreviewCurrent(db, epoch)
        )
          return value;
      } catch (error) {
        clearNativeIdentityPreviews(db);
        throw error;
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
      (key, stamp) => {
        certificate = { key, stamp };
      },
    );
    if (certificate && nativeIdentityPreviewCurrent(db, epoch))
      retainNativeIdentityPreview(db, certificate.key, certificate.stamp, value, epoch);
    return value;
  }).catch((error) => {
    clearNativeIdentityPreviews(db);
    throw error;
  });
  flights.set(key, next);
  void next
    .finally(() => {
      if (flights!.get(key) === next) flights!.delete(key);
    })
    .catch(() => undefined);
  return next.then(detachIdentityPreview);
}
async function getNativeIntakeIdentityReviewInner(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  groupId: string,
  certified?: (key: string, stamp: string) => void,
): Promise<IntakeIdentityReview> {
  let context: Context;
  try {
    context = await open(db, root, profileId, id, groupId);
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
        ? (json(correctionRow.coverage_json) as { personId: string; noteId: string })
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
      const assessment = assessIdentityPolicy({
        self,
        people: selectedIdentityPeopleSnapshots(db),
        nameEvidenceGrounded: false,
        evidence: initial.evidence,
        evidenceConflicts: initial.conflicts,
        unreadableBirthDate: initial.unreadableBirthDate,
        group: context.group,
        groupVersionId: context.groupVersionId,
        originalFingerprint: context.scope.originalFingerprint(context.group),
        receipts: context.scope.receipts,
        hasUnstructuredIdentityQuestion: initial.hasUnstructuredIdentityQuestion,
        currentRefusal: initial.currentRefusal,
      });
      return { ...assessment, scope: null, self, correctedPerson, ...peoplePreview(db) };
    }
    try {
      const original = await evidence(context);
      let built = await build(context, original, stored);
      retainSelectedIdentityGrounding(
        db,
        context.scope.groundingBoundary(profileId, id, context.file.sha256),
        context.group,
        built.groundedQuestions,
        original.patientNameGrounded,
        built.groundedNameQuestions,
        built.dates,
      );
      // Rebuild after original proof so clinical and identity preview observe the same policy.
      stored.db
        .prepare("DELETE FROM rows WHERE section NOT IN ('initialIssues','initialExplicit')")
        .run();
      context.assertCurrent();
      // Capture before opening: even the asynchronous context read must belong
      // to the unchanged full reconstruction. Own writes suppress retention.
      const constructionStamp = reviewReadStamp(db),
        constructionKey = previewReadKey(db, root, profileId, id, groupId);
      context = await open(db, root, profileId, id, groupId);
      self = selfSnapshot(db);
      correctedPerson = correction();
      verifyPreviewArtifacts(context);
      const freshOriginal = await evidence(context);
      built = await build(context, freshOriginal, stored);
      const catalog = createReportSnapshotCatalog(db, context.file, {
        catalog: 'report.snapshots',
        catalogArea: 'builds',
        assertRunning: context.assertCurrent,
      });
      await writeSnapshot(context, built, stored, catalog);
      const changes = await catalog.finalChanges();
      const collections = selectedEnvelopeStore(db, context.file).collections,
        operationId = randomUUID();
      if (changes.length)
        collections.commitMaintenance(
          collections.prepare(collections.openView(), {
            operationId,
            requestDigest: hash(operationId),
            domainVersion: context.before.rawVersion,
            changes,
          }),
        );
      rememberPreview(db, built.display);
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
              warningsReference: {
                format: 'health-intake-identity-warnings-v1' as const,
                scopeToken: built.display.scopeToken,
                snapshotId: built.display.collection.snapshotId,
                count: stored.count('warnings'),
              },
            };
      const value: IntakeIdentityReview = {
        ...built.assessment,
        ...built.presentation,
        ...warnings,
        confirmationCount: context.scope.receipts.filter(
          (receipt) => receipt.scope.groupId === groupId,
        ).length,
        scope: null,
        scopeReference: built.display,
        self,
        correctedPerson,
        ...peoplePreview(db),
      };
      verifyPreviewArtifacts(context);
      if (
        constructionStamp !== undefined &&
        constructionStamp === reviewReadStamp(db) &&
        constructionKey === previewReadKey(db, root, profileId, id, groupId)
      )
        certified?.(constructionKey, constructionStamp);
      return value;
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
    stored.close();
  }
}
export async function readNativeIdentityScopePage(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  groupId: string,
  input: { scopeToken: string; section: string; cursor?: string; limit?: number },
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
  const reader = openIdentityScopeSnapshot(
    createReportSnapshotCatalog(db, source(db, profileId, id), {
      catalog: 'report.snapshots',
      catalogArea: 'builds',
    }),
    reference,
  );
  const total =
    section === 'warnings' ? Number(reader.get('$warningCount')) : reference.collection[section];
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
        value[0] !== reference.scopeToken ||
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
    let size = 0;
    for (const piece of reader.chunks(key)) size += Buffer.byteLength(piece);
    const item: IntakeIdentityScopePage['items'][number] =
      size > 64 * 1024
        ? {
            kind: 'reference',
            reference: {
              format: 'health-intake-identity-item-v2',
              scopeToken: reference.scopeToken,
              section,
              ordinal: offset,
              bytes: size,
            },
          }
        : { kind: 'value', value: readIdentitySnapshotValue(reader, key, 64 * 1024) };
    const cost = Buffer.byteLength(JSON.stringify(item));
    if (items.length && used + cost > 128 * 1024) break;
    used += cost;
    items.push(item);
  }
  return {
    format: 'health-intake-identity-scope-page-v2',
    scopeToken: reference.scopeToken,
    section,
    total,
    items,
    nextCursor:
      offset < total
        ? Buffer.from(JSON.stringify([reference.scopeToken, section, offset])).toString('base64url')
        : null,
  };
}
export async function readNativeIdentityScopeFragment(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  groupId: string,
  input: { scopeToken: string; section: string; ordinal: number; offset?: number },
) {
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
  const reader = openIdentityScopeSnapshot(
    createReportSnapshotCatalog(db, source(db, profileId, id), {
      catalog: 'report.snapshots',
      catalogArea: 'builds',
    }),
    reference,
  );
  const total =
    section === 'warnings' ? Number(reader.get('$warningCount')) : reference.collection[section];
  if (
    !Number.isSafeInteger(input.ordinal) ||
    input.ordinal < 0 ||
    input.ordinal >= total ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new HttpError(400, 'IDENTITY_SCOPE_FRAGMENT', 'Choose an exact scope item fragment');
  const chunks: Buffer[] = [];
  let position = 0,
    used = 0,
    complete = true;
  for (const piece of reader.chunks(section + ':' + schemaOrdinal(input.ordinal))) {
    const bytes = Buffer.from(piece),
      start = Math.max(0, offset - position);
    position += bytes.length;
    if (start >= bytes.length) continue;
    const take = Math.min(bytes.length - start, 32768 - used);
    if (take) {
      chunks.push(bytes.subarray(start, start + take));
      used += take;
    }
    if (take < bytes.length - start) {
      complete = false;
      break;
    }
  }
  if (offset > position)
    throw new HttpError(
      400,
      'IDENTITY_SCOPE_FRAGMENT',
      'The fragment offset is outside this scope item',
    );
  return {
    encoding: 'base64' as const,
    data: Buffer.concat(chunks).toString('base64'),
    complete,
    nextOffset: complete ? null : offset + used,
  };
}
export function confirmNativeIntakeIdentityScope(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: IntakeIdentityConfirmation,
) {
  source(db, profileId, id);
  return sourceLane(db, id, () =>
    confirmNativeIntakeIdentityScopeInner(db, root, profileId, id, input),
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
  if (retainedIntakeWorkflowCommand(db, file, { operationId: input.operationId, request }))
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
    async ({ assertRunning }) => {
      const context = await open(db, root, profileId, id, input.scope.groupId, assertRunning),
        stored = rows();
      try {
        const original = await evidence(context),
          built = await build(context, original, stored);
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
        });
        const draftCatalog = createReportSnapshotCatalog(db, file, {
          catalog: 'review.snapshots',
          assertRunning: context.assertCurrent,
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
            ? readNativeReviewDraft(context.view, previousRecord, draftCatalog, 256 * 1024, {
                db,
                source: file,
              })
            : undefined;
          const targetHash = createHash('sha256');
          for (const piece of canonicalReviewValueChunks(target)) targetHash.update(piece);
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
        await writeSnapshot(context, built, stored, catalog);
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
            { operationId: prepared.publicationId, fingerprint: prepared.fingerprint },
          );
        return response();
      } finally {
        stored.close();
      }
    },
  );
}
