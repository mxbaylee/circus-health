import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { openDatabase, revision } from '../database.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import {
  attachPersonalDurability,
  exportCuration,
  publishedPersonalLineage,
  copyPublishedPersonalHistory,
  rebuildProfile,
  writePortableSources,
} from '../portable.ts';
import { createNote, getNote, saveNote, finishNote } from '../notes.ts';
import { noteHistory, restoreNoteFields, previewNoteRestoration } from '../note-history.ts';
import { createBackup, restoreBackup } from '../recovery.ts';
import { writeChat, readChat } from '../assistant-journal.ts';

function fixture(t: TestContext, portableSnapshots = false) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-note-history-'));
  const profileId = 'cookie-dough',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId);
  attachPersonalDurability(db, { root, profileId, portableSnapshots });
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, paths, db, portableSnapshots };
}
type Fixture = ReturnType<typeof fixture>;
interface HistoryFieldView {
  path: string;
  previous: { value?: unknown };
  restorable: boolean;
}
interface HistoryEntryView {
  generationId: string;
  publication: string;
  fields: HistoryFieldView[];
}
type HistoryView = Omit<ReturnType<typeof noteHistory>, 'entries'> & {
  entries: HistoryEntryView[];
};
const viewHistory = (...args: Parameters<typeof noteHistory>): HistoryView =>
  noteHistory(...args) as HistoryView;
const errorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as Error & { code?: string }).code === code;
const currentId = (f: Fixture): string =>
  f.portableSnapshots
    ? [...publishedPersonalLineage(f.root, f.profileId)][0]!.manifest.file.slice(
        'snapshots/'.length,
      )
    : String(
        f.db
          .prepare(
            "SELECT version_id FROM __record_versions WHERE entity='notes' ORDER BY sequence DESC LIMIT 1",
          )
          .get()!.version_id,
      );
const restore = (
  f: Fixture,
  id: string,
  generationId: string,
  fields: string[],
  version: number,
  operationId = randomUUID(),
) =>
  restoreNoteFields(f.db, f.root, f.profileId, id, {
    generationId,
    fields,
    version,
    operationId,
    ...(f.portableSnapshots
      ? {}
      : previewNoteRestoration(f.db, f.root, f.profileId, id, {
          generationId,
          fields,
          version,
          operationId,
        })),
  });

test('field restoration preserves unrelated edits, absent values, links, unknown profile facts and identity', (t) => {
  const f = fixture(t),
    { db } = f;
  let person = createNote(db, {
    kind: 'person',
    title: 'Friend',
    content: 'Old content',
    person: {
      name: 'Friend',
      birthDate: '1988-04-07',
      pronouns: 'they/them',
      futureField: { keep: true },
      sourceRelative: { raw: 'unchanged' },
    },
  });
  const baseline = currentId(f);
  const link = createNote(db, {
    title: 'Keep link',
    links: [{ targetType: 'person', targetId: person.personId }],
  });
  person = saveNote(db, person.id, {
    ...person,
    content: 'New unrelated content',
    person: {
      ...person.person,
      birthDate: '1988',
      fullName: 'New name',
      pronouns: 'she/they',
      tags: ['Family'],
    },
  });
  const result = restore(
    f,
    person.id,
    baseline,
    ['person.birthDate', 'person.fullName'],
    person.version,
  );
  assert.equal(result.note.person.birthDate, '1988-04-07');
  assert.equal(
    Object.hasOwn(result.note.person, 'fullName'),
    false,
    'absent differs from empty text',
  );
  assert.equal(result.note.content, 'New unrelated content');
  assert.equal(result.note.person.pronouns, 'she/they');
  assert.deepEqual(result.note.person.tags, ['Family']);
  assert.deepEqual(result.note.person.futureField, { keep: true });
  assert.deepEqual(result.note.person.sourceRelative, { raw: 'unchanged' });
  assert.equal(result.note.id, person.id);
  assert.equal(result.note.personId, person.personId);
  assert.equal(getNote(db, link.id).links[0].id, link.links[0].id);
  assert.ok(result.operation);
  assert.equal(result.operation.previousVersion, person.version);
  assert.equal(result.operation.currentVersion, person.version + 1);
  assert.equal(result.recovery.published, true);
  const shown = viewHistory(db, f.root, f.profileId, person.id);
  assert.ok(shown.entries.some((entry) => entry.generationId === baseline));
  assert.ok(
    shown.entries.every((entry) =>
      entry.fields.every((field) => !field.path.includes('sourceRelative')),
    ),
  );
});

test('CAS conflict, immutable finished notes, profile isolation, unsafe fields and unpublished candidates are rejected', (t) => {
  const f = fixture(t, true),
    { db, paths } = f;
  let note = createNote(db, { kind: 'historical', title: 'Visit', content: 'Before' }),
    baseline = currentId(f);
  note = saveNote(db, note.id, { ...note, content: 'After' });
  const before = revision(db);
  assert.throws(
    () => restore(f, note.id, baseline, ['content'], note.version - 1),
    (e) => errorCode(e, 'VERSION_CONFLICT'),
  );
  for (const field of [
    'status',
    'id',
    'links',
    'attachments',
    'person.__proto__',
    'person.sourceRelative',
  ])
    assert.throws(
      () => restore(f, note.id, baseline, [field], note.version),
      (e) => errorCode(e, 'INVALID_FIELDS'),
    );
  const loose = `000000000000-${randomUUID()}.json`;
  writeFileSync(
    resolve(paths.personal, 'snapshots', loose),
    readFileSync(resolve(paths.personal, 'snapshots', baseline)),
  );
  assert.throws(
    () => restore(f, note.id, loose, ['content'], note.version),
    (e) => errorCode(e, 'HISTORY_NOT_FOUND'),
  );
  assert.throws(
    () => restore(f, note.id, '../../anything', ['content'], note.version),
    (e) => errorCode(e, 'INVALID_GENERATION'),
  );
  assert.throws(
    () => viewHistory(db, f.root, 'cedar', note.id),
    (e) => errorCode(e, 'NOT_FOUND'),
  );
  assert.equal(revision(db), before);
  note = finishNote(db, note.id, { ...note, links: [] });
  assert.throws(
    () => restore(f, note.id, baseline, ['content'], note.version),
    (e) => errorCode(e, 'NOTE_FINISHED'),
  );
  assert.ok(
    viewHistory(db, f.root, f.profileId, note.id).entries.every((entry) =>
      entry.fields.every((field) => !field.restorable),
    ),
  );
});

test('idempotent restores survive uncertain response, pending publication, and a later retry', (t) => {
  const f = fixture(t, true),
    { db, root, profileId } = f;
  let note = createNote(db, { title: 'Entry', content: 'Old' }),
    baseline = currentId(f);
  note = saveNote(db, note.id, { ...note, content: 'New' });
  const operationId = randomUUID();
  attachPersonalDurability(db, {
    portableSnapshots: true,
    root,
    profileId,
    writer() {
      throw new Error('Disk unavailable');
    },
  });
  const result = restore(f, note.id, baseline, ['content'], note.version, operationId);
  assert.equal(result.note.content, 'Old');
  assert.equal(result.durability.dirty, true);
  assert.equal(result.recovery.published, false);
  const rev = revision(db),
    version = result.note.version;
  const retry = restore(f, note.id, baseline, ['content'], note.version, operationId);
  assert.equal(retry.replayed, true);
  assert.equal(revision(db), rev);
  assert.equal(retry.note.version, version);
  assert.throws(
    () => restore(f, note.id, baseline, ['title'], note.version, operationId),
    (e) => errorCode(e, 'OPERATION_CONFLICT'),
  );
  attachPersonalDurability(db, { root, profileId, portableSnapshots: true });
  const durable = restore(f, note.id, baseline, ['content'], note.version, operationId);
  assert.equal(durable.recovery.published, true);
  assert.equal(durable.durability.dirty, false);
  assert.equal(revision(db), rev);
});

test('only the published lineage is shown after interrupted pointer writes; checksum failures do not invent history', (t) => {
  const f = fixture(t, true),
    { db, root, profileId, paths } = f;
  let note = createNote(db, { title: 'Entry', content: 'First' });
  const published = currentId(f);
  attachPersonalDurability(db, {
    portableSnapshots: true,
    root,
    profileId,
    writer(path, bytes) {
      if (path.endsWith('current.json')) throw new Error('Pointer interrupted');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    },
  });
  note = saveNote(db, note.id, { ...note, content: 'Unpublished candidate' });
  const history = viewHistory(db, root, profileId, note.id);
  assert.equal(history.entries[0]!.generationId, published);
  assert.ok(
    history.entries.every(
      (entry) =>
        entry.fields.find((field) => field.path === 'content')?.previous.value !==
        'Unpublished candidate',
    ),
  );
  attachPersonalDurability(db, { root, profileId, portableSnapshots: true });
  assert.equal(
    viewHistory(db, root, profileId, note.id).entries[0]!.fields.find(
      (field) => field.path === 'content',
    )?.previous.value,
    'Unpublished candidate',
  );
  const manifest = JSON.parse(readFileSync(resolve(paths.personal, 'current.json'), 'utf8'));
  const bytes = readFileSync(resolve(paths.personal, manifest.file));
  writeFileSync(resolve(paths.personal, manifest.file), Buffer.concat([bytes, Buffer.from(' ')]));
  assert.throws(
    () => noteHistory(db, root, profileId, note.id),
    (e) => errorCode(e, 'HISTORY_UNAVAILABLE'),
  );
});

test('portable backup output, actual backup/restore and rebuild retain lineage, receipts and restored values', async (t) => {
  const f = fixture(t, true),
    { db, root, profileId } = f;
  let note = createNote(db, { title: 'Entry', content: 'Before' });
  const baseline = currentId(f);
  note = saveNote(db, note.id, { ...note, content: 'After' });
  const operationId = randomUUID(),
    result = restore(f, note.id, baseline, ['content'], note.version, operationId);
  exportCuration(db, root, profileId);
  const out = resolve(root, 'portable-copy');
  const files = writePortableSources(db, root, profileId, out);
  assert.ok(files.some((path) => path.endsWith(baseline)));
  assert.ok([...publishedPersonalLineage(out, profileId)].length >= 4);
  const backup = await createBackup(db, root, profileId);
  const backupRoot = resolve(root, 'restored-backup');
  restoreBackup(backup.path, backupRoot);
  const backupDb = openDatabase(profilePaths(backupRoot, profileId).database, profileId);
  t.after(() => backupDb.close());
  assert.equal(getNote(backupDb, note.id).content, 'Before');
  assert.ok(
    viewHistory(backupDb, backupRoot, profileId, note.id).entries.some(
      (entry) => entry.generationId === baseline,
    ),
  );
  const rebuilt = resolve(root, 'rebuilt');
  rebuildProfile(root, profileId, rebuilt);
  const restored = openDatabase(profilePaths(rebuilt, profileId).database, profileId);
  t.after(() => restored.close());
  assert.equal(getNote(restored, note.id).content, 'Before');
  assert.ok(
    viewHistory(restored, rebuilt, profileId, note.id).entries.some(
      (entry) => entry.generationId === baseline,
    ),
  );
  const retry = restoreNoteFields(restored, rebuilt, profileId, note.id, {
    operationId,
    generationId: baseline,
    fields: ['content'],
    version: note.version,
  });
  assert.equal(retry.replayed, true);
  assert.equal(retry.note.version, result.note.version);
});

test('legacy published current is one known baseline and never adopts loose earlier snapshots', (t) => {
  const f = fixture(t, true),
    { db, root, profileId, paths } = f;
  let note = createNote(db, { title: 'Entry', content: 'Old loose state' });
  const loose = currentId(f);
  note = saveNote(db, note.id, { ...note, content: 'Legacy current' });
  const pointer = resolve(paths.personal, 'current.json');
  const manifest = JSON.parse(readFileSync(pointer, 'utf8'));
  const value = JSON.parse(readFileSync(resolve(paths.personal, manifest.file), 'utf8'));
  delete value.history;
  const bytes = Buffer.from(JSON.stringify(value));
  writeFileSync(resolve(paths.personal, manifest.file), bytes);
  writeFileSync(
    pointer,
    JSON.stringify({
      ...manifest,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }),
  );
  const old = viewHistory(db, root, profileId, note.id);
  assert.equal(old.entries.length, 1);
  assert.equal(old.entries[0]!.publication, 'baseline');
  assert.equal(old.baselineReached, true);
  assert.throws(
    () => restore(f, note.id, loose, ['content'], note.version),
    (error) => errorCode(error, 'HISTORY_NOT_FOUND'),
  );
  saveNote(db, note.id, { ...note, content: 'Next published change' });
  const current = viewHistory(db, root, profileId, note.id);
  assert.equal(current.entries.length, 2);
  assert.equal(
    current.entries[1]!.fields.find((field) => field.path === 'content')?.previous.value,
    'Legacy current',
  );
});

test('paged history stays profile scoped and an exact captured lineage can be copied after newer saves', (t) => {
  const f = fixture(t, true),
    { db, root, profileId } = f;
  let note = createNote(db, { title: 'Entry', content: 'One' });
  const chosen = [...publishedPersonalLineage(root, profileId)][0].manifest;
  note = saveNote(db, note.id, { ...note, content: 'Two' });
  note = saveNote(db, note.id, { ...note, content: 'Three' });
  const first = viewHistory(db, root, profileId, note.id, new URLSearchParams({ limit: '1' }));
  assert.ok(first.nextCursor);
  const second = viewHistory(
    db,
    root,
    profileId,
    note.id,
    new URLSearchParams({ limit: '1', cursor: String(first.nextCursor) }),
  );
  assert.equal(
    first.entries[0]!.fields.find((field) => field.path === 'content')?.previous.value,
    'Three',
  );
  assert.equal(
    second.entries[0]!.fields.find((field) => field.path === 'content')?.previous.value,
    'Two',
  );
  assert.notEqual(first.entries[0]!.generationId, second.entries[0]!.generationId);
  assert.throws(
    () =>
      viewHistory(db, root, profileId, note.id, new URLSearchParams({ cursor: 'not-published' })),
    (error) => errorCode(error, 'HISTORY_NOT_FOUND'),
  );
  const copied = resolve(root, 'captured-lineage');
  const result = copyPublishedPersonalHistory(root, profileId, copied, { manifest: chosen });
  assert.deepEqual(result.current, chosen);
  assert.equal(
    [...publishedPersonalLineage(copied, profileId)][0]!.value.tables.notes.find(
      (row) => row.id === note.id,
    )?.content,
    'One',
  );
  const bounded = resolve(root, 'bounded-lineage');
  copyPublishedPersonalHistory(root, profileId, bounded, { maxRevision: chosen.revision });
  assert.equal([...publishedPersonalLineage(bounded, profileId)][0]!.manifest.file, chosen.file);
});

test('rebuild preserves the selected profile assistant journal alongside the same personal lineage', (t) => {
  const f = fixture(t),
    { db, root, profileId } = f;
  const proposalId = randomUUID();
  let operation;
  createNote(db, { title: 'Retained entry', content: 'Fictional data only' }, (saved) => {
    operation = {
      profileId,
      proposalId,
      noteId: saved.id,
      kind: 'create_note',
      version: saved.version,
    };
    db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
      `personal_assistant_${proposalId}`,
      JSON.stringify(operation),
    );
  });
  exportCuration(db, root, profileId);
  const chat = {
    id: randomUUID(),
    updatedAt: '2026-09-11T11:00:00Z',
    messages: [{ role: 'user', text: 'Find this note' }],
  };
  const foreign = {
    id: randomUUID(),
    updatedAt: chat.updatedAt,
    messages: [{ role: 'user', text: 'Different owner' }],
  };
  ensureProfileDirectories(root, 'orchid');
  writeChat(root, profileId, chat, 'User message');
  writeChat(root, 'orchid', foreign, 'Foreign fixture');
  const target = resolve(root, 'rebuilt');
  rebuildProfile(root, profileId, target);
  assert.deepEqual(readChat(target, profileId, chat.id), chat);
  assert.equal(existsSync(profilePaths(target, 'orchid').root), false);
  const rebuiltDb = openDatabase(profilePaths(target, profileId).database, profileId);
  t.after(() => rebuiltDb.close());
  assert.deepEqual(
    JSON.parse(
      rebuiltDb
        .prepare('SELECT value FROM app_meta WHERE key=?')
        .get(`personal_assistant_${proposalId}`)?.value as string,
    ),
    operation,
  );
});

test('symlinked history cannot escape the personal directory even with matching checksums', (t) => {
  const f = fixture(t, true),
    { db, root, profileId, paths } = f;
  const note = createNote(db, { title: 'Entry', content: 'Local only' });
  const manifest = JSON.parse(readFileSync(resolve(paths.personal, 'current.json'), 'utf8'));
  const file = resolve(paths.personal, manifest.file),
    outside = resolve(root, 'elsewhere.json');
  writeFileSync(outside, readFileSync(file));
  rmSync(file);
  symlinkSync(outside, file);
  assert.throws(
    () => noteHistory(db, root, profileId, note.id),
    (error) => errorCode(error, 'HISTORY_UNAVAILABLE'),
  );
});

test('a failed restoration receipt write rolls the field update and version back together', (t) => {
  const { db } = fixture(t);
  const note = createNote(db, { title: 'Entry', content: 'Before' }),
    before = revision(db);
  assert.throws(
    () =>
      saveNote(db, note.id, { version: note.version, content: 'Must not survive' }, () => {
        throw new Error('Receipt write failed');
      }),
    /Receipt write failed/,
  );
  assert.equal(getNote(db, note.id).content, 'Before');
  assert.equal(getNote(db, note.id).version, note.version);
  assert.equal(revision(db), before);
  const id = `note:${randomUUID()}`;
  assert.throws(
    () =>
      createNote(db, { id, title: 'Creation must roll back' }, () => {
        throw new Error('Receipt write failed');
      }),
    /Receipt write failed/,
  );
  assert.equal(db.prepare('SELECT id FROM notes WHERE id=?').get(id), undefined);
  assert.equal(revision(db), before);
});
