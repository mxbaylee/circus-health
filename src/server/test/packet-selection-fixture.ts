import type { TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { exportFixture } from './note-export-fixture.ts';
import { createNote, getNote } from '../notes.ts';
import { exportOptions } from '../note-exports.ts';

// Independently fictional strings, deliberately repeated across sharing surfaces.
export const SECRET = 'FICTIONAL-VIOLET-SECRET-216';
export const UNKNOWN = 'FICTIONAL-UNKNOWN-OWNER-216';
export const SAFE = 'Fictional selected result';

export function packetFixture(t: TestContext, managed = false) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-packet-selection-'));
  const f = exportFixture(resolve(root, 'database.sqlite'));
  const { db } = f;
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const person = managed
    ? createNote(db, { kind: 'person', title: 'Fictional Rowan Finch' })
    : getNote(db, String(db.prepare("SELECT id FROM notes WHERE person_id='patient'").get()!.id));
  const personId = person.personId!;
  db.prepare("UPDATE evidence SET entity_id=? WHERE id='fictional-raw-subject'").run(personId);
  db.prepare('UPDATE notes SET profile_json=? WHERE id=?').run(
    JSON.stringify({ medicalHistory: SECRET }),
    person.id,
  );
  db.prepare('UPDATE notes SET content=?,profile_json=? WHERE id=?').run(
    `Visit questions containing ${SECRET}`,
    JSON.stringify({ recordOwnerPersonId: personId }),
    f.note.id,
  );
  db.prepare('UPDATE notes SET title=?,content=?,profile_json=? WHERE id=?').run(
    SECRET,
    SECRET,
    JSON.stringify({ recordOwnerPersonId: personId }),
    f.sensitive.id,
  );
  db.prepare('UPDATE observations SET person_id=?').run(personId);
  db.prepare('UPDATE medications SET person_id=?').run(personId);
  db.prepare("UPDATE observations SET label=? WHERE test_type_id='cbc'").run(SAFE);
  db.prepare("UPDATE test_types SET label=? WHERE id='cbc'").run(SAFE);
  db.prepare("UPDATE observations SET extra_json=? WHERE id='lab-1'").run(
    JSON.stringify({
      context: { privateNarrative: SECRET },
      recordCorrections: [
        {
          before: { valueText: '12.3' },
          after: { valueText: '12.4' },
          reason: SECRET,
          at: '2026-10-01T00:00:00Z',
        },
      ],
    }),
  );
  db.prepare("UPDATE documents SET text_content=?,extra_json=? WHERE id='provider-note'").run(
    `Literal provider narrative ${SECRET}`,
    JSON.stringify({ import: { personId }, context: SECRET }),
  );
  db.prepare("UPDATE source_records SET raw_json=? WHERE id='raw'").run(
    `{"data":{"context":"${SECRET}","large":9007199254740993,"same":1,"same":2}}`,
  );
  db.prepare(
    "INSERT INTO source_records(id,source_file_id,provider_id,kind,label,raw_json) VALUES('sensitive-condition','file','issuer','condition',?,?)",
  ).run(SECRET, JSON.stringify({ data: { display: SECRET, context: SECRET } }));
  db.prepare(
    "INSERT INTO evidence(id,entity_type,entity_id,source_record_id,role) VALUES('condition-owner','person',?,'sensitive-condition','report_subject')",
  ).run(personId);
  db.prepare(
    "INSERT INTO source_records(id,source_file_id,provider_id,kind,label,raw_json) VALUES('unknown-owner','file','issuer','allergy',?,?)",
  ).run(UNKNOWN, JSON.stringify({ data: { display: UNKNOWN } }));
  const writeOriginal = (name: string, content: string) => {
    const path = `data/profiles/cookie-dough/${name}`;
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), content);
    return {
      path,
      bytes: Buffer.byteLength(content),
      sha: createHash('sha256').update(content).digest('hex'),
    };
  };
  const original = writeOriginal('sources/shared.txt', `${SAFE}\n${SECRET}\n${UNKNOWN}`);
  db.prepare("UPDATE source_files SET path=?,bytes=?,sha256=? WHERE id='file'").run(
    original.path,
    original.bytes,
    original.sha,
  );
  const attachment = writeOriginal('attachments/private.txt', SECRET);
  const duplicateAttachment = writeOriginal('attachments/private-duplicate.txt', SECRET);
  const safeAttachment = writeOriginal('attachments/safe.txt', 'Fictional safe companion bytes');
  for (const [id, name, file] of [
    ['secret-asset', `${SECRET}.txt`, attachment],
    ['secret-duplicate', 'ordinary-name.txt', duplicateAttachment],
    ['safe-asset', 'safe.txt', safeAttachment],
  ] as const) {
    db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,NULL)').run(
      id,
      name,
      file.path,
      'text/plain',
      file.bytes,
      file.sha,
      '2026-10-01',
      'user-uploaded',
    );
  }
  for (const [id, asset, type, owner, caption] of [
    ['secret-note-attachment', 'secret-asset', 'note', f.note.id, SECRET],
    ['secret-record-attachment', 'secret-duplicate', 'observation', 'lab-1', SECRET],
    ['safe-record-attachment', 'safe-asset', 'observation', 'lab-1', 'Fictional safe caption'],
  ])
    db.prepare(
      'INSERT INTO attachments(id,asset_id,owner_type,owner_id,caption,created_at) VALUES(?,?,?,?,?,?)',
    ).run(id, asset, type, owner, caption, '2026-10-01');
  const note = getNote(db, f.note.id);
  const options = exportOptions(db, { type: 'person', id: personId });
  return {
    ...f,
    root,
    personId,
    note,
    original,
    attachment,
    safeAttachment,
    input: {
      type: 'person',
      id: personId,
      noteVersion: options.noteVersion,
      mode: 'provider' as const,
      noteIds: [note.id],
    },
    exclusion: { kind: 'source', recordId: 'sensitive-condition' },
  };
}
