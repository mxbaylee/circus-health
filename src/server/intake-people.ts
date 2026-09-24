import { canonicalIdentityName, savedKnownNames } from '../shared/self-identity.ts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError, json, safeText } from './database.ts';
import type { Note, PersonProfile } from '../shared/api.ts';
import type {
  IntakePeopleQueue,
  IntakePersonApplyRequest,
  IntakePersonApplyResult,
  IntakePersonDispositionRequest,
  IntakePersonEnvelopeProposal,
  IntakePersonMatch,
  IntakePersonProposal,
  IntakePersonProposalState,
} from '../shared/intake-people.ts';
import type { IntakeReportGroup, IntakeWorkflow } from '../shared/intake.ts';
import { inspectIntakeFile } from './intake-files.ts';
import { canonicalLiteral, validateJSONL } from './intake-format.ts';
import type { IntakeEntry } from './intake-format.ts';
import { intakePersonDisplayTitle, validatedIntakePeople } from './intake-people-format.ts';
import {
  flushIntake,
  getIntake,
  intakeDurability,
  intakeTransaction,
  verifyIntakeOriginal,
  workflowMutation,
} from './intake.ts';
import { createNote, getNote, saveNote } from './notes.ts';
import { personalDurabilityStatus } from './portable.ts';
import { profileOriginal } from './profile-storage.ts';

type UnknownRecord = Record<string, unknown>;
interface SourceFileRow {
  id: string;
  provider_id: string;
  path: string;
  sha256: string;
  bytes: number;
  mime_type: string;
  batch_id: string | null;
  details_json: string;
}
interface IntakeDetails {
  originalName: string;
  version: number;
  validation?: { valid?: boolean };
  proposals: { id: string; fileId: string }[];
  workflow?: IntakeWorkflow & {
    peopleDrafts?: IntakePersonDraft[];
  };
}
interface IntakePersonDraft {
  proposalId: string;
  proposalVersion: string;
  state: Exclude<IntakePersonProposalState, 'saved'>;
  at: string;
}
interface PersonalImportReceipt {
  profileId: string;
  proposalId: string;
  noteId: string;
  kind: 'person';
  version: number;
  personId: string;
  intakePersonProposalId: string;
  intakePersonProposalVersion: string;
  operationId: string;
  requestFingerprint: string;
  action: 'add' | 'update';
  sourceRecordId: string;
  appliedAt: string;
}
interface ResolvedProposal {
  dto: IntakePersonProposal;
  entry: IntakeEntry;
  rawProposal: IntakePersonEnvelopeProposal;
  original: SourceFileRow;
  inputFile: SourceFileRow;
}

const hash = (value: unknown): string =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : canonicalLiteral(value))
    .digest('hex');
const object = (value: unknown): value is UnknownRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !JSON.isRawJSON(value);
const normalizedName = (value: string): string =>
  value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
const personMatchName = (note: Note): string =>
  typeof note.person.fullName === 'string' && note.person.fullName.trim()
    ? note.person.fullName
    : note.title;
const details = (row: SourceFileRow): IntakeDetails => {
  const value = json(row.details_json, {}) as UnknownRecord;
  if (!object(value.intake)) throw new Error('Intake source metadata is incomplete');
  return value.intake as unknown as IntakeDetails;
};
const uuidFromHash = (value: string): string => {
  const h = hash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const receiptKey = (proposalId: string): string =>
  `personal_assistant_${uuidFromHash(`intake-person:${proposalId}`)}`;
const resultUrl = (noteId: string): string => `#/people?id=${encodeURIComponent(noteId)}`;

function owner(db: DatabaseSync, profileId: string): void {
  const row = db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get() as
    { value: string } | undefined;
  if (row?.value !== profileId)
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'People proposals belong to a different profile');
}

function originalRows(db: DatabaseSync): SourceFileRow[] {
  return db
    .prepare("SELECT * FROM source_files WHERE kind='intake_original' ORDER BY id")
    .all() as unknown as SourceFileRow[];
}

function inputFile(
  db: DatabaseSync,
  original: SourceFileRow,
  proposalId: string | null,
): SourceFileRow {
  if (!proposalId) return original;
  const intake = details(original);
  if (
    !intake.proposals.some(
      (proposal) => proposal.id === proposalId && proposal.fileId === proposalId,
    )
  )
    throw new HttpError(404, 'INTAKE_PERSON_NOT_FOUND', 'People proposal source is unavailable');
  const row = db.prepare('SELECT * FROM source_files WHERE id=?').get(proposalId) as
    SourceFileRow | undefined;
  if (!row)
    throw new HttpError(404, 'INTAKE_PERSON_NOT_FOUND', 'People proposal source is unavailable');
  return row;
}

function verifiedEntries(
  db: DatabaseSync,
  root: string,
  profileId: string,
  original: SourceFileRow,
  proposalId: string | null,
): { inputFile: SourceFileRow; entries: IntakeEntry[] } {
  verifyIntakeOriginal(db, root, profileId, original.id);
  const selected = inputFile(db, original, proposalId);
  const path = profileOriginal(root, selected.path, profileId);
  inspectIntakeFile(path, selected);
  const parsed = validateJSONL(readFileSync(path));
  if (!parsed.valid || !parsed.entries)
    throw new HttpError(409, 'INTAKE_PERSON_SOURCE', 'Retained People proposal is no longer valid');
  return { inputFile: selected, entries: parsed.entries };
}

function exactMatches(
  db: DatabaseSync,
  fullName: string,
): { matches: IntakePersonMatch[]; matchCount: number } {
  const wanted = normalizedName(fullName);
  const matches: IntakePersonMatch[] = [];
  let matchCount = 0;
  for (const row of db
    .prepare(
      "SELECT id FROM notes WHERE kind='person' AND person_id<>'patient' ORDER BY updated_at DESC,id",
    )
    .all() as unknown as { id: string }[]) {
    const note = getNote(db, row.id);
    const candidate = personMatchName(note);
    if (normalizedName(candidate) !== wanted) continue;
    matchCount++;
    if (matches.length < 20)
      matches.push({
        noteId: note.id,
        personId: note.personId!,
        title: note.title,
        fullName: candidate,
        relationship:
          typeof note.person.relationship === 'string' ? note.person.relationship : null,
        version: note.version,
        reason: 'Exact full-name match; choose Add or Update.',
      });
  }
  return { matches, matchCount };
}

function canonicalSelfMatch(db: DatabaseSync, fullName: string): boolean {
  const self = getNote(db, 'patient');
  const canonical = typeof self.person.fullName === 'string' ? self.person.fullName.trim() : '';
  return [canonical, ...savedKnownNames(self.person.knownNames)].some(
    (name) => !!name && canonicalIdentityName(name) === canonicalIdentityName(fullName),
  );
}

function groupsForRecord(
  workflow: IntakeDetails['workflow'],
  proposalId: string | null,
  recordId: string,
): {
  group: IntakeReportGroup;
  groupVersionId: string;
  candidateId: string;
  candidateVersionId: string;
}[] {
  const matches: ReturnType<typeof groupsForRecord> = [];
  for (const group of workflow?.reportGroups || [])
    for (const version of group.versions.slice(-1))
      for (const member of version.members)
        if (
          member.occurrences.some(
            (occurrence) =>
              occurrence.recordId === recordId && occurrence.proposalId === proposalId,
          )
        )
          matches.push({
            group,
            groupVersionId: version.id,
            candidateId: member.candidateId,
            candidateVersionId: member.candidateVersionId,
          });
  return matches;
}

function parsedReceipt(db: DatabaseSync, proposalId: string): PersonalImportReceipt | null {
  const row = db.prepare('SELECT value FROM app_meta WHERE key=?').get(receiptKey(proposalId)) as
    { value: string } | undefined;
  if (!row) return null;
  const value = json(row.value, null);
  if (
    !object(value) ||
    value.intakePersonProposalId !== proposalId ||
    typeof value.noteId !== 'string' ||
    typeof value.personId !== 'string' ||
    typeof value.version !== 'number'
  )
    throw new HttpError(409, 'INTAKE_PERSON_RECEIPT', 'Saved People receipt is invalid');
  return value as unknown as PersonalImportReceipt;
}

function personState(
  db: DatabaseSync,
  intake: IntakeDetails,
  proposalId: string,
  version: string,
): IntakePersonProposalState {
  if (parsedReceipt(db, proposalId)) return 'saved';
  return (
    intake.workflow?.peopleDrafts?.findLast(
      (draft) => draft.proposalId === proposalId && draft.proposalVersion === version,
    )?.state || 'pending'
  );
}

function savedReference(
  db: DatabaseSync,
  proposalId: string,
): IntakePersonProposal['saved'] | undefined {
  const receipt = parsedReceipt(db, proposalId);
  if (!receipt) return undefined;
  const note = getNote(db, receipt.noteId);
  return {
    noteId: note.id,
    personId: note.personId!,
    version: receipt.version,
    resultUrl: resultUrl(note.id),
  };
}

function memberReference(
  workflow: IntakeDetails['workflow'],
  memberId: string | null,
): IntakePersonProposal['source']['member'] {
  if (!memberId) return null;
  const member = workflow?.plans
    .flatMap((plan) => plan.index.members || [])
    .find((item) => item.memberId === memberId);
  return {
    memberId,
    filename: member?.filename || null,
    locator: member?.locator || null,
  };
}

function collectForOriginal(
  db: DatabaseSync,
  root: string,
  profileId: string,
  original: SourceFileRow,
): ResolvedProposal[] {
  const intake = details(original);
  const sources: (string | null)[] = [
    ...(intake.validation?.valid ? [null] : []),
    ...intake.proposals.map((item) => item.id),
  ];
  const result = new Map<string, ResolvedProposal>();
  for (const proposalId of sources) {
    const verified = verifiedEntries(db, root, profileId, original, proposalId);
    for (const entry of verified.entries) {
      const recordId = `${verified.inputFile.id}:line:${entry.line}`;
      const groups = groupsForRecord(intake.workflow, proposalId, recordId);
      for (const rawProposal of validatedIntakePeople(entry.value)) {
        for (const { group, groupVersionId, candidateId, candidateVersionId } of groups) {
          // Repeated delivery of the exact candidate is one review item even when
          // it has another retained occurrence in a later conversion proposal.
          const id = `intake-person:${hash([
            original.id,
            candidateId,
            candidateVersionId,
            rawProposal.id,
          ])}`;
          const version = `intake-person-version:${hash([candidateVersionId, rawProposal])}`;
          if (
            entry.value.report?.memberId !== undefined &&
            entry.value.report.memberId !== group.memberId
          )
            throw new HttpError(
              409,
              'INTAKE_PERSON_SCOPE',
              'Named Person evidence no longer matches its retained report member',
            );
          const proposedFields = Object.fromEntries(
            ['fullName', 'relationship', 'phone', 'email', 'schedulingUrl', 'medicalHistory']
              .filter(
                (key) => typeof rawProposal[key as keyof IntakePersonEnvelopeProposal] === 'string',
              )
              .map((key) => [key, rawProposal[key as keyof IntakePersonEnvelopeProposal]]),
          ) as IntakePersonProposal['person'];
          proposedFields.tags = [rawProposal.role === 'clinician' ? 'Professional' : 'Family'];
          const matching = exactMatches(db, rawProposal.fullName);
          const selfMatch = canonicalSelfMatch(db, rawProposal.fullName);
          const dto: IntakePersonProposal = {
            id,
            version,
            state: personState(db, intake, id, version),
            intakeId: original.id,
            intakeVersion: intake.version,
            proposalId,
            envelopeRecordId: recordId,
            envelopeId: entry.value.id,
            groupId: group.id,
            groupVersionId,
            title: intakePersonDisplayTitle(rawProposal),
            person: proposedFields,
            uncertainties: [...new Set(rawProposal.uncertainties || [])],
            evidence: rawProposal.evidence.map((item) => ({
              label: 'Named person in original source',
              locator: item.locator || entry.value.provenance.locator,
              contentUrl: `/api/sources/${encodeURIComponent(original.id)}/content`,
              textAnchor: item.textAnchor,
              supports: item.supports,
              ...(item.memberId ? { memberId: item.memberId } : {}),
              ...(item.page ? { page: item.page } : {}),
            })),
            source: {
              sourceRecordId: recordId,
              filename: intake.originalName,
              contentUrl: `/api/sources/${encodeURIComponent(original.id)}/content`,
              originalSourceFileId: original.id,
              originalSha256: original.sha256,
              member: memberReference(intake.workflow, group.memberId),
            },
            matches: matching.matches,
            matchCount: matching.matchCount,
            matchesTruncated: matching.matchCount > matching.matches.length,
            ...(selfMatch
              ? {
                  selfMatch: {
                    reason:
                      'This name matches Self. Keep it as source evidence instead of creating another Person.',
                  },
                }
              : {}),
            ...(savedReference(db, id) ? { saved: savedReference(db, id) } : {}),
          };
          if (!result.has(id))
            result.set(id, { dto, entry, rawProposal, original, inputFile: verified.inputFile });
        }
      }
    }
  }
  return [...result.values()];
}

export function listIntakePeopleForIntake(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
): IntakePersonProposal[] {
  owner(db, profileId);
  const original = originalRows(db).find((item) => item.id === intakeId);
  if (!original) throw new HttpError(404, 'INTAKE_PERSON_NOT_FOUND', 'Source intake not found');
  return collectForOriginal(db, root, profileId, original).map((item) => item.dto);
}

function window(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum)
    throw new HttpError(400, 'INTAKE_PERSON_WINDOW', `Choose 1–${maximum} People proposals`);
  return number;
}

export function getIntakePeopleQueue(
  db: DatabaseSync,
  root: string,
  profileId: string,
  groupId: string,
  input: { limit?: unknown; cursor?: unknown } = {},
): IntakePeopleQueue {
  owner(db, profileId);
  safeText(groupId, 'report group id', 500);
  const limit = window(input.limit, 50, 100);
  const cursor =
    input.cursor == null || input.cursor === '' ? null : safeText(input.cursor, 'cursor', 500);
  const proposals = originalRows(db)
    .filter((row) => details(row).workflow?.reportGroups?.some((group) => group.id === groupId))
    .flatMap((row) => collectForOriginal(db, root, profileId, row))
    .map((item) => item.dto)
    .filter((item) => item.groupId === groupId)
    .sort((a, b) => a.id.localeCompare(b.id));
  const remaining = cursor ? proposals.filter((item) => item.id > cursor) : proposals;
  const people = remaining.slice(0, limit);
  return {
    groupId,
    people,
    totalPeople: proposals.length,
    peopleNextCursor: remaining.length > people.length ? people.at(-1)!.id : null,
  };
}

function findProposal(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  proposalId: string,
): ResolvedProposal {
  const original = db
    .prepare("SELECT * FROM source_files WHERE id=? AND kind='intake_original'")
    .get(intakeId) as SourceFileRow | undefined;
  if (!original) throw new HttpError(404, 'INTAKE_PERSON_NOT_FOUND', 'People proposal not found');
  const matches = collectForOriginal(db, root, profileId, original).filter(
    (item) => item.dto.id === proposalId,
  );
  if (matches.length !== 1)
    throw new HttpError(
      404,
      'INTAKE_PERSON_NOT_FOUND',
      'People proposal is unavailable or ambiguous',
    );
  return matches[0]!;
}

export function saveIntakePersonDisposition(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: IntakePersonDispositionRequest,
) {
  owner(db, profileId);
  if (
    typeof input.operationId !== 'string' ||
    !input.operationId.trim() ||
    !['pending', 'later', 'excluded'].includes(input.state)
  )
    throw new HttpError(
      400,
      'INTAKE_PERSON_INPUT',
      'Supply an operation ID and choose pending, later or excluded',
    );
  const proposal = findProposal(db, root, profileId, input.intakeId, input.proposalId);
  if (proposal.dto.version !== input.proposalVersion)
    throw new HttpError(409, 'INTAKE_PERSON_CHANGED', 'Reload this named Person proposal');
  if (proposal.dto.state === 'saved')
    throw new HttpError(409, 'INTAKE_PERSON_SAVED', 'A saved Person proposal cannot be deferred');
  return workflowMutation(
    db,
    root,
    profileId,
    input.intakeId,
    {
      version: input.intakeVersion,
      operationId: input.operationId,
      proposalId: input.proposalId,
      proposalVersion: input.proposalVersion,
      state: input.state,
    },
    (workflow) => {
      const target = workflow as unknown as { peopleDrafts?: IntakePersonDraft[] };
      target.peopleDrafts ||= [];
      target.peopleDrafts.push({
        proposalId: input.proposalId,
        proposalVersion: input.proposalVersion,
        state: input.state,
        at: new Date().toISOString(),
      });
    },
  );
}

function receipt(
  db: DatabaseSync,
  profileId: string,
  proposal: ResolvedProposal,
  input: IntakePersonApplyRequest,
): PersonalImportReceipt | null {
  const saved = parsedReceipt(db, proposal.dto.id);
  if (!saved) return null;
  const requestFingerprint = hash(input);
  if (
    saved.profileId !== profileId ||
    saved.intakePersonProposalVersion !== proposal.dto.version ||
    saved.requestFingerprint !== requestFingerprint
  )
    throw new HttpError(
      409,
      'INTAKE_PERSON_RECEIPT',
      'This Person proposal was already applied with a different reviewed choice',
    );
  return saved;
}

function appendHistory(existing: unknown, incoming: string | undefined): string {
  if (!incoming) return typeof existing === 'string' ? existing : '';
  if (typeof existing !== 'string' || !existing.trim()) return incoming;
  return existing.includes(incoming) ? existing : `${existing}\n\n${incoming}`;
}

function reviewedPersonContent(proposal: IntakePersonProposal): string[] {
  return [
    ...proposal.evidence.map((item) => item.textAnchor),
    ...proposal.uncertainties.map((item) => `Uncertainty: ${item}`),
  ];
}

function appendReviewedPersonContent(existing: unknown, proposal: IntakePersonProposal): string {
  return reviewedPersonContent(proposal).reduce(
    (content, item) => appendHistory(content, item),
    typeof existing === 'string' ? existing : '',
  );
}

function mergedPerson(
  current: PersonProfile,
  proposal: IntakePersonProposal['person'],
): PersonProfile {
  const merged = { ...current };
  for (const key of ['fullName', 'relationship', 'phone', 'email', 'schedulingUrl'] as const)
    if (Object.hasOwn(proposal, key)) merged[key] = proposal[key];
  if (proposal.medicalHistory)
    merged.medicalHistory = appendHistory(current.medicalHistory, proposal.medicalHistory);
  merged.tags = [
    ...new Set([...(Array.isArray(current.tags) ? current.tags : []), ...proposal.tags]),
  ];
  return merged;
}

function publishSourceRecord(db: DatabaseSync, proposal: ResolvedProposal): void {
  const existing = db
    .prepare('SELECT * FROM source_records WHERE id=?')
    .get(proposal.dto.source.sourceRecordId) as UnknownRecord | undefined;
  if (existing) {
    if (
      existing.source_file_id !== proposal.inputFile.id ||
      existing.raw_json !== proposal.entry.raw
    )
      throw new HttpError(409, 'INTAKE_PERSON_SOURCE', 'Retained source record changed');
    return;
  }
  db.prepare(
    'INSERT INTO source_records(id,source_file_id,provider_id,source_key,kind,label,raw_json,locator_json,extraction_status,batch_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(
    proposal.dto.source.sourceRecordId,
    proposal.inputFile.id,
    proposal.original.provider_id,
    `line:${proposal.entry.line}`,
    'intake_' + proposal.entry.value.kind,
    proposal.entry.value.id.slice(0, 500),
    proposal.entry.raw,
    JSON.stringify({
      line: proposal.entry.line,
      originalSourceFileId: proposal.original.id,
      selectedProposalId: proposal.dto.proposalId,
      sourceEnvelopeId: proposal.entry.value.id,
      literal: true,
    }),
    'retained_unprojected',
    proposal.original.batch_id,
  );
}

function appliedResult(
  db: DatabaseSync,
  proposal: ResolvedProposal,
  value: PersonalImportReceipt,
  replayed: boolean,
): IntakePersonApplyResult {
  const note = getNote(db, value.noteId);
  return {
    proposalId: proposal.dto.id,
    status: 'saved',
    action: value.action,
    noteId: note.id,
    personId: note.personId!,
    version: value.version,
    resultUrl: resultUrl(note.id),
    replayed,
    durability: {
      ...intakeDurability(db),
      personal: personalDurabilityStatus(db),
    },
  };
}

export function applyIntakePerson(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: IntakePersonApplyRequest,
): IntakePersonApplyResult {
  owner(db, profileId);
  if (!/^[0-9a-f-]{36}$/iu.test(input.operationId))
    throw new HttpError(400, 'INTAKE_PERSON_INPUT', 'Supply an Apply operation UUID');
  const proposal = findProposal(db, root, profileId, input.intakeId, input.proposalId);
  if (proposal.dto.version !== input.proposalVersion)
    throw new HttpError(409, 'INTAKE_PERSON_CHANGED', 'Reload this named Person proposal');
  const prior = receipt(db, profileId, proposal, input);
  if (prior) return appliedResult(db, proposal, prior, true);
  if (proposal.dto.selfMatch)
    throw new HttpError(
      409,
      'INTAKE_PERSON_SELF',
      'This name matches Self and cannot create or update another Person',
    );
  if (!['add', 'update'].includes(input.action))
    throw new HttpError(400, 'INTAKE_PERSON_INPUT', 'Choose Add or Update');
  let current: Note | null = null;
  if (input.action === 'update') {
    if (typeof input.noteId !== 'string' || !Number.isSafeInteger(input.version))
      throw new HttpError(400, 'INTAKE_PERSON_INPUT', 'Choose a current Person version to update');
    current = getNote(db, input.noteId);
    if (
      current.kind !== 'person' ||
      current.isSelf ||
      normalizedName(personMatchName(current)) !== normalizedName(proposal.rawProposal.fullName)
    )
      throw new HttpError(
        400,
        'INTAKE_PERSON_MATCH',
        'Choose one of the suggested named People matches or add a new Person',
      );
    if (current.version !== input.version)
      throw new HttpError(409, 'VERSION_CONFLICT', 'This Person changed. Reload before applying.');
  } else if (input.noteId !== undefined || input.version !== undefined)
    throw new HttpError(
      400,
      'INTAKE_PERSON_INPUT',
      'Add does not accept an existing Person target',
    );

  intakeTransaction(db, () => publishSourceRecord(db, proposal), {});
  const curation = flushIntake(db, root, profileId);
  if (curation.pending || curation.error)
    throw new HttpError(
      503,
      'INTAKE_DURABILITY',
      curation.error || 'Retained Person source is not yet durable',
    );

  const requestFingerprint = hash(input);
  const saveReceipt = (saved: Note) => {
    const value: PersonalImportReceipt = {
      profileId,
      proposalId: receiptKey(proposal.dto.id).slice('personal_assistant_'.length),
      noteId: saved.id,
      kind: 'person',
      version: saved.version,
      personId: saved.personId!,
      intakePersonProposalId: proposal.dto.id,
      intakePersonProposalVersion: proposal.dto.version,
      operationId: input.operationId,
      requestFingerprint,
      action: input.action,
      sourceRecordId: proposal.dto.source.sourceRecordId,
      appliedAt: new Date().toISOString(),
    };
    if (!current)
      db.prepare('UPDATE notes SET source_record_id=? WHERE id=?').run(
        proposal.dto.source.sourceRecordId,
        saved.id,
      );
    db.prepare(
      "INSERT OR IGNORE INTO evidence(id,entity_type,entity_id,source_record_id,role,locator_json) VALUES(?, 'person', ?, ?, 'source', ?)",
    ).run(
      `evidence:${hash(['person', saved.personId, proposal.dto.source.sourceRecordId])}`,
      saved.personId,
      proposal.dto.source.sourceRecordId,
      JSON.stringify({
        locator: proposal.entry.value.provenance.locator,
        originalSourceFileId: proposal.original.id,
        memberId: proposal.rawProposal.evidence[0]?.memberId || null,
        evidence: proposal.rawProposal.evidence,
        reviewed: true,
      }),
    );
    db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
      receiptKey(proposal.dto.id),
      JSON.stringify(value),
    );
  };
  const saved = current
    ? saveNote(
        db,
        current.id,
        {
          version: input.version,
          content: appendReviewedPersonContent(current.content, proposal.dto),
          person: mergedPerson(current.person, proposal.dto.person),
        },
        saveReceipt,
        { operationId: input.operationId, fingerprint: requestFingerprint },
      )
    : createNote(
        db,
        {
          id: `note:${uuidFromHash(proposal.dto.id)}`,
          kind: 'person',
          title: proposal.dto.title,
          content: reviewedPersonContent(proposal.dto).join('\n\n'),
          person: mergedPerson({}, proposal.dto.person),
        },
        saveReceipt,
        { operationId: input.operationId, fingerprint: requestFingerprint },
      );
  const value = parsedReceipt(db, proposal.dto.id);
  if (!value || value.noteId !== saved.id)
    throw new HttpError(409, 'INTAKE_PERSON_RECEIPT', 'Saved Person receipt is unavailable');
  return appliedResult(db, proposal, value, false);
}

export function getIntakePersonById(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  proposalId: string,
): IntakePersonProposal {
  owner(db, profileId);
  return findProposal(db, root, profileId, intakeId, proposalId).dto;
}

export function intakeHasNamedPeople(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
): boolean {
  owner(db, profileId);
  return (
    listIntakePeopleForIntake(db, root, profileId, getIntake(db, root, profileId, intakeId).id)
      .length > 0
  );
}
