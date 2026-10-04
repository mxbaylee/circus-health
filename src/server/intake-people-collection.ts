/** Complete selected People evidence; retained JSONL remains authoritative. */
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { HttpError, clinicalReviewRevision } from './database.ts';
import { assertIntakeOwner, verifyIntakeOriginal } from './intake.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  type IntakeEnvelopeRecord,
  type IntakeCollectionEnvelopeReader,
} from './intake-collection-envelope.ts';
import { createEnvelopeBuildWriter } from './intake-envelope-build.ts';
import {
  intakeReviewChildren,
  type IntakeReviewFragmentReference,
  readIntakeReviewValue,
} from './intake-review-collection.ts';
import { createReportSnapshotCatalog } from './intake-report-snapshot-catalog.ts';
import { openReportMemberSnapshot } from './intake-report-member-state.ts';
import { prepareRetainedPlanAccess, readRetainedPlanEvidence } from './intake-retained-plan.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { profileOriginal } from './profile-storage.ts';
import { verifyIntakeFileHash } from './intake-files.ts';
import {
  canonicalLiteral,
  validateJSONL,
  MAX_INTAKE_BYTES,
  type IntakeEntry,
} from './intake-format.ts';
import { validatedIntakePeople } from './intake-people-format.ts';
import {
  intakePersonProposalIdentity,
  intakePersonReviewCore,
  selectedIntakePersonState,
} from './intake-people.ts';
import { workflowHash } from './intake-workflow.ts';
import {
  prepareIntakeJsonCanonical,
  intakeJsonCanonicalWorkObserver,
} from './intake-json-canonical.ts';
import type { IntakePersonProposal, IntakePersonProposalState } from '../shared/intake-people.ts';
import type { IntakeReportMembersReference } from '../shared/intake-report-version.ts';
import type { IntakeReportQueueView } from '../shared/intake.ts';
import type { IntakeEnvelopeDerivedPreparation } from './intake-envelope-mutation.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';

const POLICY = 'health-intake-people-index-v1';
/** A clinical draft changes no extracted People, report membership or People disposition. */
export function collectionPeoplePreserveDerived(
  db: DatabaseSync,
  source: IntakeEnvelopeSource,
  derived: IntakeEnvelopeDerivedPreparation,
): IntakeCollectionChange[] {
  const before = openIntakeCollectionEnvelope(db, source),
    collections = selectedEnvelopeStore(db, source).collections,
    oldName = 'people.index.' + workflowHash(before.logical),
    name = 'people.index.' + workflowHash(derived.logical);
  if (
    collections.get(collections.openView(), 'builds', oldName, 'complete') !==
    JSON.stringify(POLICY)
  )
    return [];
  return [
    {
      area: 'builds',
      collection: name,
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: oldName,
    },
  ];
}
/** The disposition compiler changes no source, membership or person identity. */
export function collectionPeopleDispositionDerived(
  db: DatabaseSync,
  source: IntakeEnvelopeSource,
  derived: IntakeEnvelopeDerivedPreparation,
  change: { id: string; version: string; state: IntakePersonProposalState },
): IntakeCollectionChange[] {
  const before = openIntakeCollectionEnvelope(db, source),
    collections = selectedEnvelopeStore(db, source).collections,
    oldName = 'people.index.' + workflowHash(before.logical),
    name = 'people.index.' + workflowHash(derived.logical);
  if (
    collections.get(collections.openView(), 'builds', oldName, 'complete') !==
    JSON.stringify(POLICY)
  )
    throw new HttpError(
      409,
      'PEOPLE_PREPARATION_REQUIRED',
      'Prepare complete retained People evidence',
    );
  return [
    {
      area: 'builds',
      collection: name,
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: oldName,
    },
    {
      area: 'builds',
      collection: name,
      op: 'put',
      key: 'draft:' + workflowHash([change.id, change.version]),
      value: JSON.stringify(change.state),
    },
  ];
}
type File = {
  id: string;
  kind: string;
  sha256: string;
  path: string;
  bytes: number;
  details_json: string;
};
export interface CollectionPersonPointer {
  id: string;
  version: string;
  order: number;
  proposalId: string | null;
  line: number;
  personOrdinal: number;
  groupId: string;
  groupVersionId: string;
  memberId: string | null;
  candidateId: string;
  candidateVersionId: string;
}
type Text = string | IntakeReviewFragmentReference;
export type CollectionPersonProposal = Omit<IntakePersonProposal, 'source'> & {
  source: Omit<IntakePersonProposal['source'], 'filename' | 'member'> & {
    filename: Text;
    member: { memberId: string; filename: Text | null; locator: Text | null } | null;
  };
};
function file(db: DatabaseSync, id: string): File {
  const row = db
    .prepare('SELECT id,kind,sha256,path,bytes,details_json FROM source_files WHERE id=?')
    .get(id);
  if (!row)
    throw new HttpError(404, 'INTAKE_PERSON_NOT_FOUND', 'People proposal source is unavailable');
  return row as unknown as File;
}
function scalar<T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): T | undefined {
  const value = view.field(record, name, { bytes: 16384 });
  if (value.kind === 'missing') return undefined;
  if (value.kind !== 'value') throw Error('Selected People identity requires preparation: ' + name);
  return value.value as T;
}
function context(db: DatabaseSync, root: string, profileId: string, intakeId: string) {
  assertIntakeOwner(db, profileId);
  const source = file(db, intakeId);
  if (source.kind !== 'intake_original')
    throw new HttpError(404, 'INTAKE_PERSON_NOT_FOUND', 'Source intake not found');
  const view = openIntakeCollectionEnvelope(db, source),
    version = intakeSourceVersion(db, intakeId),
    collections = selectedEnvelopeStore(db, source).collections,
    name = 'people.index.' + workflowHash(view.logical),
    intake = view.child(view.root(), 'intake')!,
    flow = view.child(intake, 'workflow');
  const assertCurrent = () => {
    assertIntakeOwner(db, profileId);
    const current = intakeSourceVersion(db, intakeId);
    if (current.logicalBinding !== version.logicalBinding || current.version !== version.version)
      throw new HttpError(409, 'INTAKE_PERSON_CHANGED', 'Refresh these People proposals');
  };
  const get = <T>(key: string): T | undefined => {
    assertCurrent();
    const value = collections.get(collections.openView(), 'builds', name, key);
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw Error('Invalid People index pointer');
    return JSON.parse(value) as T;
  };
  const entries = (proposalId: string | null) => {
    const selected = proposalId ? file(db, proposalId) : source;
    if (selected.bytes > MAX_INTAKE_BYTES)
      throw new HttpError(413, 'CONVERSION_REQUIRED', 'Review a bounded JSONL conversion proposal');
    const path = profileOriginal(root, selected.path, profileId);
    verifyIntakeFileHash(path, selected);
    const parsed = validateJSONL(readFileSync(path));
    if (!parsed.valid || !parsed.entries)
      throw new HttpError(
        409,
        'INTAKE_PERSON_SOURCE',
        'Retained People proposal is no longer valid',
      );
    return { file: selected, entries: parsed.entries };
  };
  return {
    db,
    root,
    profileId,
    source,
    view,
    version,
    collections,
    name,
    intake,
    flow,
    assertCurrent,
    get,
    entries,
  };
}

export interface CollectionPersonReference {
  format: 'health-intake-person-reference-v2';
  intakeId: string;
  id: string;
  binding: string;
  bytes: number;
  saved?: IntakePersonProposal['saved'];
  selection: {
    id: string;
    version: string;
    intakeVersion: number;
    state: IntakePersonProposalState;
  };
  policy: { selfMatch: boolean; canAdd: boolean };
  matches: {
    items: { noteId: string; version: number; title: string }[];
    total: number;
    truncated: boolean;
  };
}
export interface CollectionPeoplePage {
  format: 'health-intake-people-page-v2';
  intakeId: string;
  groupId: string | null;
  selectedPersonId: string | null;
  people: (
    | { kind: 'person'; person: CollectionPersonProposal }
    | { kind: 'reference'; reference: CollectionPersonReference }
  )[];
  totalPeople: number;
  counts: Record<IntakePersonProposalState, number>;
  nextCursor: string | null;
}
export function readCollectionPeoplePage(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  input: {
    groupId?: string;
    personId?: string;
    cursor?: string;
    limit?: number;
    bytes?: number;
    view?: IntakeReportQueueView;
  } = {},
): CollectionPeoplePage {
  const reader = openCollectionPeopleRead(db, root, profileId, intakeId),
    limit = input.limit ?? 50,
    budget = input.bytes ?? 128 * 1024;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(budget) ||
    budget < 1024 ||
    budget > 256 * 1024
  )
    throw new HttpError(
      400,
      'INTAKE_PERSON_WINDOW',
      'Choose 1 to 100 People proposals and 1024 to 262144 bytes',
    );
  if (input.view && !['active', 'deferred', 'all'].includes(input.view))
    throw new HttpError(400, 'INTAKE_PERSON_WINDOW', 'Choose active, deferred or all People');
  const binding = canonicalLiteral([
    reader.binding,
    input.groupId || null,
    input.view || 'all',
    input.personId || null,
  ]);
  if (input.personId !== undefined && (typeof input.personId !== 'string' || !input.personId))
    throw new HttpError(400, 'INTAKE_PERSON_INPUT', 'Choose a retained Person proposal');
  let after = '';
  if (input.cursor) {
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
    } catch {
      throw new HttpError(409, 'INTAKE_PERSON_CHANGED', 'Refresh these People proposals');
    }
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      value[0] !== binding ||
      typeof value[1] !== 'string'
    )
      throw new HttpError(409, 'INTAKE_PERSON_CHANGED', 'Refresh these People proposals');
    after = value[1];
  }
  const people: CollectionPeoplePage['people'] = [],
    counts: CollectionPeoplePage['counts'] = { pending: 0, later: 0, excluded: 0, saved: 0 };
  let totalPeople = 0,
    last = '',
    used = 0,
    full = false,
    more = false;
  for (const pointer of reader.pointers(input.groupId)) {
    const state = reader.state(pointer);
    counts[state]++;
    if (
      input.view &&
      input.view !== 'all' &&
      state !== (input.view === 'active' ? 'pending' : 'later')
    )
      continue;
    totalPeople++;
    if (input.personId && pointer.id !== input.personId) continue;
    if (pointer.id <= after) continue;
    if (full || people.length >= limit) {
      more = true;
      continue;
    }
    const person = reader.person(pointer),
      size = Buffer.byteLength(canonicalLiteral(person));
    const item: CollectionPeoplePage['people'][number] =
      size > budget
        ? {
            kind: 'reference',
            reference: {
              format: 'health-intake-person-reference-v2',
              intakeId,
              id: pointer.id,
              binding: reader.binding,
              bytes: size,
              ...(person.saved ? { saved: person.saved } : {}),
              selection: {
                id: person.id,
                version: person.version,
                intakeVersion: person.intakeVersion,
                state: person.state,
              },
              policy: {
                selfMatch: !!person.selfMatch,
                canAdd: !person.selfMatch && person.state !== 'saved',
              },
              matches: {
                items: person.matches.map((match) => ({
                  noteId: match.noteId,
                  version: match.version,
                  title: match.title.length > 200 ? match.title.slice(0, 197) + '…' : match.title,
                })),
                total: person.matchCount,
                truncated: person.matchesTruncated,
              },
            },
          }
        : { kind: 'person', person };
    const cost = Buffer.byteLength(canonicalLiteral(item));
    if (people.length && used + cost > budget) {
      more = true;
      full = true;
      continue;
    }
    people.push(item);
    used += cost;
    last = pointer.id;
  }
  reader.assertCurrent();
  if (input.personId && !people.length)
    throw new HttpError(
      404,
      'INTAKE_PERSON_NOT_FOUND',
      'The selected People proposal is unavailable in this report view',
    );
  return {
    format: 'health-intake-people-page-v2',
    intakeId,
    groupId: input.groupId || null,
    selectedPersonId: input.personId || null,
    people,
    totalPeople,
    counts,
    nextCursor: more ? Buffer.from(JSON.stringify([binding, last])).toString('base64url') : null,
  };
}
export function readCollectionPersonFragment(
  db: DatabaseSync,
  root: string,
  profileId: string,
  reference: CollectionPersonReference,
  offset: number,
  bytes: number,
) {
  const reader = openCollectionPeopleRead(db, root, profileId, reference.intakeId),
    pointer = reader.pointer(reference.id);
  if (
    reference.format !== 'health-intake-person-reference-v2' ||
    reference.binding !== reader.binding ||
    !pointer ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > 256 * 1024
  )
    throw new HttpError(409, 'INTAKE_PERSON_CHANGED', 'Refresh this People evidence');
  const value = Buffer.from(canonicalLiteral(reader.person(pointer)));
  if (reference.bytes !== value.length || offset > value.length)
    throw new HttpError(409, 'INTAKE_PERSON_CHANGED', 'Refresh this People evidence');
  const end = Math.min(value.length, offset + bytes);
  return {
    encoding: 'base64' as const,
    data: value.subarray(offset, end).toString('base64'),
    complete: end === value.length,
    nextOffset: end === value.length ? null : end,
  };
}

/** Explicit cold preparation; GET never treats an incomplete prefix as the People scope. */
export async function prepareCollectionPeopleIndex(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  options: { assertRunning?: () => void } = {},
) {
  const ctx = context(db, root, profileId, intakeId),
    { view, flow } = ctx;
  if (ctx.get('complete') === POLICY) return;
  verifyIntakeOriginal(db, root, profileId, intakeId);
  const assertCurrent = () => {
    options.assertRunning?.();
    ctx.assertCurrent();
  };
  if (flow && view.childCount(flow, 'plans'))
    await prepareRetainedPlanAccess(db, profileId, intakeId, { assertRunning: assertCurrent });
  const scratch = disposableSqlite('circus-people-index-');
  const writer = createEnvelopeBuildWriter(db, ctx.source, ctx.name, ctx.version.rawVersion, {
    assertRunning: assertCurrent,
  });
  try {
    const sql = scratch.db;
    sql.exec(
      'CREATE TABLE membership(proposal TEXT,record TEXT,ordinal INTEGER,groupId TEXT,groupVersionId TEXT,memberId TEXT,candidate TEXT,version TEXT);CREATE INDEX byOccurrence ON membership(proposal,record);CREATE TABLE seen(id TEXT PRIMARY KEY);CREATE TABLE sources(ordinal INTEGER PRIMARY KEY,id TEXT);CREATE TABLE allowed(id TEXT PRIMARY KEY);',
    );
    let ordinal = 0;
    const add = sql.prepare('INSERT INTO membership VALUES(?,?,?,?,?,?,?,?)');
    const catalog = createReportSnapshotCatalog(db, ctx.source);
    for (const group of intakeReviewChildren(view, flow, 'reportGroups')) {
      const count = view.childCount(group, 'versions'),
        current = count ? view.childAt(group, 'versions', count - 1) : undefined;
      if (!current) continue;
      const groupId = scalar<string>(view, group, 'id')!,
        groupVersionId = scalar<string>(view, current, 'id')!,
        memberId = scalar<string | null>(view, group, 'memberId') ?? null;
      if (scalar(view, current, 'format') === 'health-intake-report-group-version-v2') {
        const snapshot = openReportMemberSnapshot(
          catalog,
          view.child(current, 'members')
            ? readIntakeReviewValue<IntakeReportMembersReference>(
                view,
                view.child(current, 'members')!,
                16384,
              )
            : scalar<IntakeReportMembersReference>(view, current, 'members')!,
        );
        for (let index = 0; index < snapshot.reference.memberCount; index++) {
          const member = snapshot.memberAt(index)!;
          let after: string | undefined;
          do {
            const page = snapshot.occurrenceDescriptors(member, { after, items: 64, bytes: 32768 });
            for (const occurrence of page.occurrences) {
              add.run(
                JSON.stringify(occurrence.proposalId),
                occurrence.recordId,
                ordinal++,
                groupId,
                groupVersionId,
                memberId,
                member.candidateId,
                member.candidateVersionId,
              );
            }
            if (page.complete) break;
            if (!page.after || page.after === after)
              throw Error('People occurrence scope did not advance');
            after = page.after;
          } while (true);
        }
      } else
        for (const member of intakeReviewChildren(view, current, 'members')) {
          // SQL DISTINCT below implements occurrence.some without materializing history.
          for (const occurrence of intakeReviewChildren(view, member, 'occurrences'))
            add.run(
              JSON.stringify(scalar(view, occurrence, 'proposalId') ?? null),
              scalar(view, occurrence, 'recordId')!,
              ordinal++,
              groupId,
              groupVersionId,
              memberId,
              scalar(view, member, 'candidateId')!,
              scalar(view, member, 'candidateVersionId')!,
            );
        }
    }
    const validation = view.child(ctx.intake, 'validation');
    let sourceOrdinal = 0;
    if (validation && scalar(view, validation, 'valid'))
      sql.prepare('INSERT INTO sources VALUES(?,NULL)').run(sourceOrdinal++);
    for (const proposal of intakeReviewChildren(view, ctx.intake, 'proposals')) {
      const id = scalar<string>(view, proposal, 'id')!;
      sql.prepare('INSERT INTO sources VALUES(?,?)').run(sourceOrdinal++, id);
      if (scalar(view, proposal, 'fileId') === id)
        sql.prepare('INSERT OR IGNORE INTO allowed VALUES(?)').run(id);
    }
    let order = 0;
    for (const source of sql.prepare('SELECT id FROM sources ORDER BY ordinal').iterate()) {
      assertCurrent();
      const proposalId = source.id === null ? null : String(source.id);
      if (proposalId && !sql.prepare('SELECT 1 FROM allowed WHERE id=?').get(proposalId))
        throw new HttpError(
          404,
          'INTAKE_PERSON_NOT_FOUND',
          'People proposal source is unavailable',
        );
      const selected = ctx.entries(proposalId);
      for (const entry of selected.entries) {
        const people = validatedIntakePeople(entry.value),
          recordId = selected.file.id + ':line:' + entry.line;
        for (let personOrdinal = 0; personOrdinal < people.length; personOrdinal++) {
          const person = people[personOrdinal]!;
          for (const member of sql
            .prepare(
              'SELECT groupId,groupVersionId,memberId,candidate,version,min(ordinal) AS firstOrdinal FROM membership WHERE proposal=? AND record=? GROUP BY groupId,groupVersionId,memberId,candidate,version ORDER BY firstOrdinal',
            )
            .iterate(JSON.stringify(proposalId), recordId)) {
            if (
              entry.value.report?.memberId !== undefined &&
              entry.value.report.memberId !== member.memberId
            )
              throw new HttpError(
                409,
                'INTAKE_PERSON_SCOPE',
                'Named Person evidence no longer matches its retained report member',
              );
            const identity = intakePersonProposalIdentity(
              intakeId,
              String(member.candidate),
              String(member.version),
              person,
            );
            if (!sql.prepare('INSERT OR IGNORE INTO seen VALUES(?)').run(identity.id).changes)
              continue;
            const pointer: CollectionPersonPointer = {
              ...identity,
              order: order++,
              proposalId,
              line: entry.line,
              personOrdinal,
              groupId: String(member.groupId),
              groupVersionId: String(member.groupVersionId),
              memberId: member.memberId === null ? null : String(member.memberId),
              candidateId: String(member.candidate),
              candidateVersionId: String(member.version),
            };
            const text = JSON.stringify(pointer);
            await writer.put('all:' + pointer.id, text);
            await writer.put('g:' + workflowHash(pointer.groupId) + ':' + pointer.id, text);
          }
        }
      }
    }
    if (flow && view.has(flow, 'peopleDrafts')) {
      const draftRecords = view.child(flow, 'peopleDrafts');
      const drafts = await prepareIntakeJsonCanonical(
        draftRecords ? view.recordChunks(draftRecords) : view.fieldChunks(flow, 'peopleDrafts'),
        {
          assertRunning: assertCurrent,
          onWork: intakeJsonCanonicalWorkObserver(db, 'reconstruction'),
        },
      );
      try {
        for (const draft of drafts.arrayItems(drafts.root)) {
          const field = (name: string) => {
            const handle = drafts.field(draft, name);
            if (!handle) return undefined;
            let text = '';
            for (const piece of drafts.pieces(handle)) {
              if (Buffer.byteLength(text) + Buffer.byteLength(piece) > 16384)
                throw Error('Selected People draft identity exceeds metadata budget');
              text += piece;
            }
            return JSON.parse(text);
          };
          await writer.put(
            'draft:' + workflowHash([field('proposalId'), field('proposalVersion')]),
            JSON.stringify(field('state')),
          );
        }
      } finally {
        drafts.close();
      }
    }
    await writer.put('total', JSON.stringify(order));
    await writer.flush();
    assertCurrent();
    await writer.put('complete', JSON.stringify(POLICY));
    await writer.flush();
    assertCurrent();
  } finally {
    scratch.close();
  }
}

export function openCollectionPeopleRead(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
) {
  const ctx = context(db, root, profileId, intakeId),
    { view } = ctx;
  if (ctx.get('complete') !== POLICY)
    throw new HttpError(
      409,
      'PEOPLE_PREPARATION_REQUIRED',
      'Prepare complete retained People evidence',
    );
  const policy = clinicalReviewRevision(db),
    assertCurrent = () => {
      ctx.assertCurrent();
      if (clinicalReviewRevision(db) !== policy)
        throw new HttpError(409, 'INTAKE_PERSON_CHANGED', 'Refresh these People proposals');
    };
  const draft = (id: string, version: string) =>
    ctx.get<IntakePersonProposalState>('draft:' + workflowHash([id, version])) || 'pending';
  let cachedId: string | null | undefined,
    cached: { file: File; entries: IntakeEntry[] } | undefined;
  const text = (
    reader: IntakeCollectionEnvelopeReader,
    record: IntakeEnvelopeRecord,
    name: string,
  ): Text | null => {
    const value = reader.field(record, name, { bytes: 8192 });
    if (value.kind === 'missing' || (value.kind === 'value' && value.value === null)) return null;
    if (value.kind === 'value')
      return typeof value.value === 'string' ? value.value : String(value.value);
    return {
      format: 'health-intake-review-fragment-v1',
      logical: reader.logical,
      address: reader.address(record),
      field: name,
    };
  };
  return {
    binding: canonicalLiteral([
      profileId,
      intakeId,
      ctx.version.logicalBinding,
      ctx.version.version,
      policy,
    ]),
    assertCurrent,
    pointer(id: string) {
      return ctx.get<CollectionPersonPointer>('all:' + id);
    },
    retained(pointer: CollectionPersonPointer) {
      assertCurrent();
      if (canonicalLiteral(ctx.get('all:' + pointer.id)) !== canonicalLiteral(pointer))
        throw Error('Foreign People pointer');
      verifyIntakeOriginal(db, root, profileId, intakeId);
      const selected = ctx.entries(pointer.proposalId),
        entry = selected.entries.find((entry) => entry.line === pointer.line),
        rawProposal = entry && validatedIntakePeople(entry.value)[pointer.personOrdinal];
      if (!entry || !rawProposal)
        throw new HttpError(409, 'INTAKE_PERSON_SOURCE', 'Retained People proposal changed');
      return { entry, rawProposal, inputFileId: selected.file.id };
    },
    state(pointer: CollectionPersonPointer) {
      assertCurrent();
      return selectedIntakePersonState(db, pointer.id, pointer.version, draft);
    },
    *pointers(groupId?: string): Generator<CollectionPersonPointer> {
      const prefix = groupId ? 'g:' + workflowHash(groupId) + ':' : 'all:';
      let after: string | undefined = prefix;
      do {
        assertCurrent();
        const page = ctx.collections.range(ctx.collections.openView(), 'builds', ctx.name, {
          after,
          items: 64,
          bytes: 65536,
        });
        for (const item of page.items) {
          if (!item.key.startsWith(prefix)) return;
          if (typeof item.value !== 'string') throw Error('Invalid People pointer');
          yield JSON.parse(item.value) as CollectionPersonPointer;
        }
        if (page.complete) return;
        if (!page.after || page.after === after) throw Error('People index page did not advance');
        after = page.after;
      } while (true);
    },
    person(pointer: CollectionPersonPointer): CollectionPersonProposal {
      assertCurrent();
      if (canonicalLiteral(ctx.get('all:' + pointer.id)) !== canonicalLiteral(pointer))
        throw Error('Foreign People pointer');
      verifyIntakeOriginal(db, root, profileId, intakeId);
      if (!cached || cachedId !== pointer.proposalId) {
        cached = ctx.entries(pointer.proposalId);
        cachedId = pointer.proposalId;
      }
      const entry = cached.entries.find((entry) => entry.line === pointer.line),
        raw = entry && validatedIntakePeople(entry.value)[pointer.personOrdinal];
      if (!entry || !raw)
        throw new HttpError(409, 'INTAKE_PERSON_SOURCE', 'Retained People proposal changed');
      const core = intakePersonReviewCore(db, {
        original: ctx.source,
        intakeVersion: ctx.version.version,
        proposalId: pointer.proposalId,
        recordId: cached.file.id + ':line:' + entry.line,
        entry,
        rawProposal: raw,
        group: { id: pointer.groupId, memberId: pointer.memberId },
        groupVersionId: pointer.groupVersionId,
        candidateId: pointer.candidateId,
        candidateVersionId: pointer.candidateVersionId,
        draftState: draft,
      });
      if (core.id !== pointer.id || core.version !== pointer.version)
        throw Error('People identity changed');
      let member: CollectionPersonProposal['source']['member'] = null;
      if (pointer.memberId) {
        const selected =
          ctx.flow && view.childCount(ctx.flow, 'plans')
            ? readRetainedPlanEvidence(db, profileId, intakeId).firstMember(pointer.memberId)
            : undefined;
        member = {
          memberId: pointer.memberId,
          filename:
            selected?.kind === 'retained'
              ? text(selected.view, selected.record, 'filename')
              : selected?.member.filename || null,
          locator:
            selected?.kind === 'retained'
              ? text(selected.view, selected.record, 'locator')
              : selected?.member.locator || null,
        };
      }
      return {
        ...core,
        source: {
          sourceRecordId: core.envelopeRecordId,
          filename: text(view, ctx.intake, 'originalName') ?? '',
          contentUrl: '/api/sources/' + encodeURIComponent(intakeId) + '/content',
          originalSourceFileId: intakeId,
          originalSha256: ctx.source.sha256,
          member,
        },
      };
    },
  };
}
