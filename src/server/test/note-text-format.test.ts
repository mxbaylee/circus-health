import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { TestContext } from 'node:test';
import type { Note, NoteHistoryEntry } from '../../shared/api.ts';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import {
  attachPersonalDurability,
  publishedPersonalLineage,
  exportCuration,
  rebuildProfile,
} from '../portable.ts';
import { createNote, saveNote, getNote, finishNote } from '../notes.ts';
import { noteHistory, restoreNoteFields } from '../note-history.ts';
const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;
function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-text-format-')),
    profileId = 'cookie-dough',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, paths, db };
}
const generation = (f: ReturnType<typeof fixture>) =>
  [...publishedPersonalLineage(f.root, f.profileId)][0].manifest.file.slice('snapshots/'.length);

test('format markers preserve literal legacy bodies, idempotent creation, partial edits and finished content', (t) => {
  const { db } = fixture(t),
    literal = '# Literal *words* <script>unchanged</script>\n🌙';
  let legacy = createNote(db, { title: 'Literal', content: literal });
  assert.equal(legacy.content, literal);
  assert.deepEqual(legacy.textFormats, {});
  legacy = saveNote(db, legacy.id, { version: legacy.version, title: 'Updated title' });
  assert.equal(legacy.content, literal);
  assert.deepEqual(legacy.textFormats, {});
  const input = {
    id: `note:${randomUUID()}`,
    title: 'Markdown',
    kind: 'historical',
    content: '# Visit\n\n**Notes**',
    topics: '- Question',
    rawThoughts: 'Literal # thought',
    textFormats: { topics: 'markdown-v1', content: 'markdown-v1' },
  };
  let note = createNote(db, input);
  assert.equal(createNote(db, input).id, note.id);
  assert.throws(
    () => createNote(db, { ...input, textFormats: { content: 'plain-v1' } }),
    (e: unknown) => hasCode(e, 'ID_CONFLICT'),
  );
  note = saveNote(db, note.id, {
    version: note.version,
    content: '# Latest 🌙\n\n[Visit](/notes?id=abc)',
  });
  assert.equal(note.textFormats?.content, 'markdown-v1');
  note = finishNote(db, note.id, {
    ...note,
    content: '# Final immediately before Finish',
    links: [],
  });
  assert.equal(note.content, '# Final immediately before Finish');
  assert.equal(note.textFormats?.topics, 'markdown-v1');
  assert.throws(
    () => saveNote(db, note.id, { version: note.version, textFormats: {} }),
    (e: unknown) => hasCode(e, 'NOTE_FINISHED'),
  );
  for (const textFormats of [null, [], { content: 'html-v1' }, { unknown: 'markdown-v1' }])
    assert.throws(
      () => createNote(db, { title: 'Invalid', textFormats }),
      (e: unknown) => hasCode(e, 'INVALID_INPUT'),
    );
});

test('selected field restore moves the original marker with its body, including legacy absent formats', (t) => {
  const f = fixture(t),
    { db } = f;
  let note = createNote(db, {
      kind: 'historical',
      title: 'Visit',
      content: '# Literal',
      topics: '* literal topic',
      rawThoughts: '# raw',
    }),
    old = generation(f);
  note = saveNote(db, note.id, {
    ...note,
    content: '# Heading',
    topics: '**New**',
    textFormats: { content: 'markdown-v1', topics: 'markdown-v1', rawThoughts: 'markdown-v1' },
  });
  const history = (
    noteHistory(db, f.root, f.profileId, note.id).entries as unknown as NoteHistoryEntry[]
  ).find((x) => x.generationId === old);
  assert.ok(history);
  assert.equal(history.fields.find((x) => x.path === 'content')?.previous.format, 'plain-v1');
  note = restoreNoteFields(db, f.root, f.profileId, note.id, {
    generationId: old,
    fields: ['content', 'rawThoughts'],
    version: note.version,
    operationId: randomUUID(),
  }).note as Note;
  assert.equal(note.content, '# Literal');
  assert.equal(note.textFormats?.content, 'plain-v1');
  assert.equal(note.textFormats?.rawThoughts, 'plain-v1');
  assert.equal(note.topics, '**New**');
  assert.equal(note.textFormats?.topics, 'markdown-v1');
  let person = createNote(db, {
      kind: 'person',
      title: 'Family',
      content: 'Body',
      person: { medicalHistory: '# Literal family' },
      textFormats: { content: 'markdown-v1' },
    }),
    personOld = generation(f);
  person = saveNote(db, person.id, {
    ...person,
    person: { ...person.person, medicalHistory: '# Formatted family' },
    textFormats: { ...person.textFormats, medicalHistory: 'markdown-v1' },
  });
  person = restoreNoteFields(db, f.root, f.profileId, person.id, {
    generationId: personOld,
    fields: ['person.medicalHistory'],
    version: person.version,
    operationId: randomUUID(),
  }).note as Note;
  assert.equal(person.person.medicalHistory, '# Literal family');
  assert.equal(person.textFormats?.medicalHistory, 'plain-v1');
  assert.equal(person.textFormats?.content, 'markdown-v1');
});

test('portable rebuild preserves Markdown source, markers, personal unknown fields and links', (t) => {
  const f = fixture(t),
    { db, root, profileId } = f;
  const linked = createNote(db, { title: 'Linked', content: 'Body' });
  const body =
    '# Heading\n\n![asset reference](attachment:abc)\n\n| A | B |\n|---|---|\n| x | y |\n\n<unknown>keep</unknown>\n';
  const note = createNote(db, {
    title: 'Preserve all source',
    content: body,
    textFormats: { content: 'markdown-v1' },
    person: { futureFact: { keep: true } },
    links: [{ targetType: 'note', targetId: linked.id }],
  });
  exportCuration(db, root, profileId);
  // Rebuild into a separate temporary database; original fixture stays available.
  const output = resolve(root, 'rebuilt');
  rebuildProfile(root, profileId, output);
  const rebuilt = openDatabase(profilePaths(output, profileId).database, profileId);
  try {
    const actual = getNote(rebuilt, note.id);
    assert.equal(actual.content, body);
    assert.deepEqual(actual.textFormats, { content: 'markdown-v1' });
    assert.deepEqual(actual.person.futureFact, { keep: true });
    assert.equal(actual.links[0].targetId, linked.id);
  } finally {
    rebuilt.close();
  }
});
