import test, { type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase, revision, transaction, type Database } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  queryRecordHistory,
  type RecordStorage,
} from '../record-versions.ts';
import { noteHistory, previewNoteRestoration, restoreNoteFields } from '../note-history.ts';
import { createNote, saveNote, getNote, finishNote } from '../notes.ts';
import { uploadAsset, createAttachment, editAttachment } from '../assets.ts';
import type { NoteHistory, NoteRestorationPreview, NoteRestoreResult } from '../../shared/api.ts';
import type { ProxyModelBridge, ProxyModelBridgeOptions } from '../proxy-model-bridge.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-record-note-history-')),
    profileId = 'cookie-dough',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId),
    objects = new Map<string, Buffer>(),
    opened: Database[] = [db];
  const storage: RecordStorage = {
    read: (key: string) => objects.get(key) || null,
    writeImmutable(key: string, bytes: Uint8Array) {
      assert.equal(objects.has(key), false);
      objects.set(key, Buffer.from(bytes));
    },
    publishHead(bytes: Uint8Array) {
      objects.set('head', Buffer.from(bytes));
    },
  };
  attachRecordDurability(db, { profileId, storage });
  t.after(() => {
    for (const db of opened)
      try {
        db.close();
      } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  const rebuild = () => {
    const path = resolve(root, randomUUID() + '.sqlite');
    rebuildRecordDatabase(path, { profileId, storage });
    const db = openDatabase(path, profileId);
    opened.push(db);
    attachRecordDurability(db, { profileId, storage });
    return db;
  };
  return { root, profileId, db, storage, objects, rebuild };
}
type Fixture = ReturnType<typeof fixture>;
interface RestoreSelection {
  [key: string]: unknown;
  generationId: string;
  fields: string[];
  associations?: { links?: string[]; attachments?: string[] };
  version: number;
}
const errorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as Error & { code?: string }).code === code;
const history = (f: Fixture, id: string): NoteHistory =>
  noteHistory(f.db, f.root, f.profileId, id) as unknown as NoteHistory;
const preview = (f: Fixture, id: string, input: RestoreSelection): NoteRestorationPreview =>
  previewNoteRestoration(f.db, f.root, f.profileId, id, input) as unknown as NoteRestorationPreview;
function apply(f: Fixture, id: string, input: RestoreSelection): NoteRestoreResult {
  const p = preview(f, id, input);
  return restoreNoteFields(f.db, f.root, f.profileId, id, {
    ...input,
    operationId: randomUUID(),
    expectedRevision: p.expectedRevision,
    previewToken: p.previewToken,
  }) as unknown as NoteRestoreResult;
}

test('indexed history groups explicit editing sessions and preserves every intervening A/B/A version', (t) => {
  const f = fixture(t),
    session = randomUUID();
  let person = createNote(f.db, {
    kind: 'person',
    title: 'Fictional friend',
    person: { name: 'Fictional friend', birthDate: '1988-04-07' },
    editingSessionId: session,
  });
  person = saveNote(f.db, person.id, {
    ...person,
    person: { ...person.person, birthDate: '1988' },
    editingSessionId: session,
  });
  person = saveNote(f.db, person.id, {
    ...person,
    person: { ...person.person, birthDate: '1988-04-07' },
    editingSessionId: session,
  });
  let shown = history(f, person.id);
  assert.equal(shown.groups?.length, 1);
  assert.equal(shown.groups?.[0]?.entries.length, 3);
  assert.deepEqual(
    shown.entries.map(
      (e) => e.fields.find((field) => field.path === 'person.birthDate')?.previous.value,
    ),
    ['1988-04-07', '1988', '1988-04-07'],
  );
  const other = randomUUID();
  person = saveNote(f.db, person.id, {
    ...person,
    content: 'Other session',
    editingSessionId: other,
  });
  person = saveNote(f.db, person.id, {
    ...person,
    content: 'Resumed first session',
    editingSessionId: session,
  });
  shown = history(f, person.id);
  assert.deepEqual(
    shown.groups?.map((g) => g.sessionId),
    [session, other, session],
  );
  const first = noteHistory(
    f.db,
    f.root,
    f.profileId,
    person.id,
    new URLSearchParams('limit=2'),
  ) as unknown as NoteHistory;
  assert.ok(first.nextCursor);
  const second = noteHistory(
    f.db,
    f.root,
    f.profileId,
    person.id,
    new URLSearchParams({ limit: '2', cursor: first.nextCursor }),
  ) as unknown as NoteHistory;
  assert.equal(new Set([...first.entries, ...second.entries].map((e) => e.generationId)).size, 4);
  const rebuilt = f.rebuild();
  assert.deepEqual(noteHistory(rebuilt, f.root, f.profileId, person.id).entries, shown.entries);
});

test('preview is read-only, selective restoration preserves unrelated fields and stale profile revisions fail', (t) => {
  const f = fixture(t);
  let person = createNote(f.db, {
    kind: 'person',
    title: 'Fictional friend',
    content: 'Original',
    person: { name: 'Fictional friend', birthDate: '1988-04-07', future: { keep: true } },
  });
  const old = history(f, person.id).entries[0].generationId;
  person = saveNote(f.db, person.id, {
    ...person,
    content: 'Preserve this edit',
    person: { ...person.person, birthDate: '1988', pronouns: 'they/them' },
  });
  const input = { generationId: old, fields: ['person.birthDate'], version: person.version };
  const head = f.storage.read('head'),
    p = preview(f, person.id, input);
  assert.deepEqual(f.storage.read('head'), head);
  assert.deepEqual(
    p.changes.map((c) => c.path),
    ['person.birthDate'],
  );
  assert.equal(p.changes[0].before.value, '1988');
  assert.equal(p.changes[0].after.value, '1988-04-07');
  createNote(f.db, { title: 'Unrelated concurrent edit' });
  assert.throws(
    () =>
      restoreNoteFields(f.db, f.root, f.profileId, person.id, {
        ...input,
        operationId: randomUUID(),
        expectedRevision: p.expectedRevision,
        previewToken: p.previewToken,
      }),
    (e) => errorCode(e, 'VERSION_CONFLICT'),
  );
  const result = apply(f, person.id, input);
  assert.equal(result.note.person.birthDate, '1988-04-07');
  assert.equal(result.note.content, 'Preserve this edit');
  assert.deepEqual(result.note.person.future, { keep: true });
  assert.equal(result.note.person.pronouns, 'they/them');
  assert.equal(result.recovery.published, true);
  const version = queryRecordHistory(f.db, {
    profileId: f.profileId,
    entity: 'notes',
    recordId: person.id,
  }).entries[0];
  assert.deepEqual((version.references as { restoredFrom: string[] }).restoredFrom, [old]);
  assert.equal(version.operationId, result.operation.operationId);
});

test('selected removed links and attachment associations recover retained originals without replacing newer associations', (t) => {
  const f = fixture(t);
  const friend = createNote(f.db, {
    kind: 'person',
    title: 'Fictional friend',
    person: { name: 'Fictional friend' },
  });
  let note = createNote(f.db, {
    title: 'Fictional note',
    links: [{ targetType: 'person', targetId: friend.personId }],
  });
  const link = note.links[0]!;
  const bytes = Buffer.from('%PDF-1.4\nFictional retained original\n'),
    asset = uploadAsset(f.db, f.root, f.profileId, bytes, 'fictional.pdf', 'application/pdf');
  const attachment = createAttachment(f.db, f.root, f.profileId, {
    assetId: asset.id,
    ownerType: 'note',
    ownerId: note.id,
    version: note.version,
    caption: 'Original caption',
  });
  note = getNote(f.db, note.id);
  const old = history(f, note.id).entries[0].generationId;
  editAttachment(f.db, attachment.id, { version: note.version }, true);
  note = getNote(f.db, note.id);
  note = saveNote(f.db, note.id, {
    ...note,
    links: [{ targetType: 'person', targetId: 'patient' }],
    content: 'Unrelated new text',
  });
  const newerLink = note.links[0]!;
  const input = {
    generationId: old,
    fields: [],
    associations: { links: [link.id], attachments: [attachment.id] },
    version: note.version,
  };
  const p = preview(f, note.id, input);
  assert.equal(p.associationChanges.length, 2);
  assert.equal(p.changes.length, 0);
  const count = f.db.prepare('SELECT COUNT(*) n FROM assets').get()?.n;
  const result = apply(f, note.id, input);
  assert.equal(result.note.content, 'Unrelated new text');
  assert.deepEqual(new Set(result.note.links.map((l) => l.id)), new Set([link.id, newerLink.id]));
  assert.equal(result.note.attachments[0]?.id, attachment.id);
  assert.equal(result.note.attachments[0]?.assetId, asset.id);
  assert.equal(result.note.attachments[0]?.caption, 'Original caption');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM assets').get()?.n, count);
  const rebuilt = f.rebuild();
  assert.deepEqual(getNote(rebuilt, note.id), result.note);
  const restored = queryRecordHistory(rebuilt, {
    profileId: f.profileId,
    entity: 'notes',
    recordId: note.id,
  }).entries[0]!;
  const restoredFrom = (restored.references as { restoredFrom: string[] }).restoredFrom;
  assert.equal(restoredFrom[0], old);
  assert.equal(restoredFrom.length, 3);
});

test('restoration retries survive cache loss and changed preview selections cannot reuse an operation ID', (t) => {
  const f = fixture(t);
  let note = createNote(f.db, { title: 'Original', content: 'Before' });
  const old = history(f, note.id).entries[0].generationId;
  note = saveNote(f.db, note.id, { ...note, title: 'Current', content: 'After' });
  const input = { generationId: old, fields: ['content'], version: note.version },
    p = preview(f, note.id, input),
    request = {
      ...input,
      operationId: randomUUID(),
      expectedRevision: p.expectedRevision,
      previewToken: p.previewToken,
    };
  const result = restoreNoteFields(f.db, f.root, f.profileId, note.id, request),
    rev = revision(f.db);
  assert.equal(restoreNoteFields(f.db, f.root, f.profileId, note.id, request).replayed, true);
  assert.equal(revision(f.db), rev);
  assert.throws(
    () => restoreNoteFields(f.db, f.root, f.profileId, note.id, { ...request, fields: ['title'] }),
    (e) => errorCode(e, 'OPERATION_CONFLICT'),
  );
  const rebuilt = f.rebuild(),
    retry = restoreNoteFields(rebuilt, f.root, f.profileId, note.id, request);
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.operation, result.operation);
  assert.equal(retry.recovery.published, true);
});

test('finished entries, wrong profiles, foreign versions, invalid targets and altered originals fail without changing history', (t) => {
  const f = fixture(t);
  let note = createNote(f.db, {
    kind: 'historical',
    title: 'Fictional history',
    content: 'Original',
  });
  const old = history(f, note.id).entries[0].generationId;
  note = finishNote(f.db, note.id, note);
  assert.throws(
    () => preview(f, note.id, { generationId: old, fields: ['content'], version: note.version }),
    (e) => errorCode(e, 'NOTE_FINISHED'),
  );
  assert.throws(
    () => noteHistory(f.db, f.root, 'cedar', note.id),
    (e) => errorCode(e, 'NOT_FOUND'),
  );
  let other = createNote(f.db, { title: 'Other', content: 'Initial' });
  other = saveNote(f.db, other.id, { ...other, content: 'Later' });
  assert.throws(
    () => preview(f, other.id, { generationId: old, fields: ['content'], version: other.version }),
    (e) => errorCode(e, 'HISTORY_NOT_FOUND'),
  );
  const bytes = Buffer.from('%PDF-1.4\nFictional\n'),
    asset = uploadAsset(f.db, f.root, f.profileId, bytes, 'fictional.pdf', 'application/pdf');
  const attachment = createAttachment(f.db, f.root, f.profileId, {
    assetId: asset.id,
    ownerType: 'note',
    ownerId: other.id,
    version: other.version,
  });
  other = getNote(f.db, other.id);
  const baseline = history(f, other.id).entries[0].generationId;
  editAttachment(f.db, attachment.id, { version: other.version }, true);
  other = getNote(f.db, other.id);
  const storedPath = f.db
    .prepare('SELECT stored_path FROM assets WHERE id=?')
    .get(asset.id)?.stored_path;
  assert.equal(typeof storedPath, 'string');
  writeFileSync(resolve(f.root, storedPath as string), 'Changed original');
  const before = revision(f.db);
  assert.throws(
    () =>
      preview(f, other.id, {
        generationId: baseline,
        fields: [],
        associations: { attachments: [attachment.id] },
        version: other.version,
      }),
    (e) => errorCode(e, 'ASSET_INTEGRITY'),
  );
  assert.equal(revision(f.db), before);
});

test('profile-scoped API previews and applies journal restoration with optimistic revision checks', async (t) => {
  const { createApp } = await import('../index.ts');
  const f = fixture(t);
  let note = createNote(f.db, { title: 'Fictional', content: 'Before' });
  const generationId = history(f, note.id).entries[0].generationId;
  note = saveNote(f.db, note.id, { ...note, content: 'After' });
  const app = createApp({ root: f.root, databases: new Map([[f.profileId, f.db]]) });
  await new Promise<void>((resolveListen) => app.server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise<void>((resolveClose) => app.server.close(() => resolveClose())));
  const address = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}/api/profiles/${f.profileId}/notes/${encodeURIComponent(note.id)}`;
  const headers = { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' },
    input = { generationId, fields: ['content'], version: note.version };
  const response = await fetch(base + '/history');
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { data: NoteHistory }).data.format, 'record-versions');
  const checked = await fetch(base + '/restore-preview', {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  assert.equal(checked.status, 200);
  const p = ((await checked.json()) as { data: NoteRestorationPreview }).data;
  const applied = await fetch(base + '/restore', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...input,
      operationId: randomUUID(),
      expectedRevision: p.expectedRevision,
      previewToken: p.previewToken,
    }),
  });
  assert.equal(applied.status, 200);
  assert.equal(((await applied.json()) as { data: NoteRestoreResult }).data.note.content, 'Before');
});

test('a removed link cannot restore an unavailable target and a forged preview cannot mutate an entry', (t) => {
  const f = fixture(t);
  transaction(f.db, () =>
    f.db
      .prepare("INSERT INTO test_types(id,label) VALUES('fictional-test','Fictional test')")
      .run(),
  );
  let note = createNote(f.db, {
    title: 'Fictional',
    content: 'Before',
    links: [{ targetType: 'test_type', targetId: 'fictional-test' }],
  });
  const generationId = history(f, note.id).entries[0].generationId,
    link = note.links[0]!;
  note = saveNote(f.db, note.id, { ...note, content: 'After', links: [] });
  transaction(f.db, () => f.db.prepare("DELETE FROM test_types WHERE id='fictional-test'").run());
  assert.throws(
    () =>
      preview(f, note.id, {
        generationId,
        fields: [],
        associations: { links: [link.id] },
        version: note.version,
      }),
    (e) => errorCode(e, 'ASSOCIATION_CONFLICT'),
  );
  const input = { generationId, fields: ['content'], version: note.version },
    p = preview(f, note.id, input),
    before = revision(f.db);
  assert.throws(
    () =>
      restoreNoteFields(f.db, f.root, f.profileId, note.id, {
        ...input,
        operationId: randomUUID(),
        expectedRevision: p.expectedRevision,
        previewToken: 'forged',
      }),
    (e) => errorCode(e, 'VERSION_CONFLICT'),
  );
  assert.equal(revision(f.db), before);
  assert.equal(getNote(f.db, note.id).content, 'After');
});

test('assistant restoration proposals retain the concrete indexed preview until explicit application', async (t) => {
  const { createAssistant } = await import('../assistant.ts');
  const f = fixture(t);
  let note = createNote(f.db, { title: 'Fictional', content: 'Before' });
  const generationId = history(f, note.id).entries[0].generationId;
  note = saveNote(f.db, note.id, { ...note, content: 'After' });
  let callbacks: Required<Pick<ProxyModelBridgeOptions, 'onEvent' | 'onTool'>> | undefined;
  const assistant = createAssistant({
    root: f.root,
    databases: new Map([[f.profileId, f.db]]),
    availability: async () => ({ available: true }),
    bridgeFactory(value) {
      assert.ok(value.onEvent);
      assert.ok(value.onTool);
      callbacks = { onEvent: value.onEvent, onTool: value.onTool };
      return {
        async start() {
          return { model: 'synthetic' };
        },
        async turn() {
          callbacks?.onEvent('turn/started', { turn: { id: 'test-turn' } });
        },
        close() {},
        async cancel() {},
      } as unknown as ProxyModelBridge;
    },
  });
  t.after(() => assistant.close());
  const chat = assistant.create(f.profileId, { message: 'Restore only the earlier content' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(callbacks);
  const proposal = (await callbacks.onTool({
    tool: 'health_propose_restore',
    arguments: {
      noteId: note.id,
      generationId,
      fields: ['content'],
      version: note.version,
      reason: 'Restore the selected earlier content',
    },
    callId: randomUUID(),
  })) as {
    id: string;
    preview: NoteRestorationPreview;
    changes: { previewToken: string; expectedRevision: number };
  };
  assert.equal(proposal.preview.changes[0].before.value, 'After');
  assert.equal(proposal.preview.changes[0].after.value, 'Before');
  assert.equal(proposal.changes.previewToken, proposal.preview.previewToken);
  assert.equal(proposal.changes.expectedRevision, revision(f.db));
  assert.equal(getNote(f.db, note.id).content, 'After');
  callbacks.onEvent('turn/completed', { turn: { status: 'completed' } });
  assistant.apply(f.profileId, chat.id, proposal.id);
  assert.equal(getNote(f.db, note.id).content, 'Before');
});
