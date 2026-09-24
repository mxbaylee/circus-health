import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { ServerResponse, IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { exportFixture } from './note-export-fixture.ts';
import {
  exportOptions,
  exportSnapshot,
  exportHtml,
  exportEvidence,
  createNoteExports,
} from '../note-exports.ts';
import { saveNote, getNote, finishNote } from '../notes.ts';
import type { ClinicalKind } from '../clinical-references.ts';
type ExportRouteContext = Parameters<ReturnType<typeof createNoteExports>>[0];
interface PreviewResult {
  token: string;
  valid?: boolean;
  evidenceAvailable?: boolean;
}
const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;
const hasStatus = (error: unknown, status: number): boolean =>
  error instanceof Error && 'status' in error && error.status === status;
const route = (value: object): ExportRouteContext => value as unknown as ExportRouteContext;
interface EvidenceCompanion {
  format: string;
  main: { links: unknown[] };
  records: Array<{ id: string; row: { raw_json?: string; reference_json?: string } }>;
  citationIndex: Array<{ number: number; file?: string }>;
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(resolve(tmpdir(), 'health-export-test-')),
    f = exportFixture(resolve(dir, 'database.sqlite'));
  t.after(() => {
    f.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    ...f,
    input: {
      type: 'note',
      id: f.note.id,
      noteVersion: f.note.version,
      mode: 'brief',
      selected: [],
    },
  };
}
test('note-only is safe rendered markdown, draft-preserving and excludes unselected sensitive history', (t) => {
  const { db, note, sensitive, input } = fixture(t),
    before = getNote(db, note.id),
    snapshot = exportSnapshot(db, input),
    html = exportHtml(snapshot);
  assert.deepEqual(snapshot.records, []);
  assert.deepEqual(snapshot.assets, []);
  assert.deepEqual(getNote(db, note.id), before);
  assert.match(html, /DRAFT/);
  assert.match(html, /<h1>What I want to discuss<\/h1>/);
  assert.match(html, /<strong>recent results<\/strong>/);
  assert.doesNotMatch(html, /<script|<img|EXPLICIT SENSITIVE HISTORY/);
  assert.match(html, /Image reference: do not fetch/);
  assert.match(html, /Questions for my appointment/);
  assert.ok(!JSON.stringify(snapshot).includes(sensitive.content));
});
test('current medication options use personal confirmation, retain doses and provenance; source issuer differs from acquisition', (t) => {
  const { db, input } = fixture(t),
    options = exportOptions(db, input);
  assert.equal(options.choices.find((r) => r.id === 'old-order')?.current, false);
  assert.equal(options.choices.find((r) => r.id === 'current-med')?.current, true);
  const snapshot = exportSnapshot(db, {
      ...input,
      selected: ['medication:current-med', 'observation:lab-1'],
    }),
    html = exportHtml(snapshot);
  assert.match(html, /5 mg daily/);
  assert.match(html, /2026-09-01/);
  assert.match(html, /Source prescription status/);
  assert.match(html, /inactive/);
  assert.equal(snapshot.records[0].citations[0].issuer, 'Fictional Clinic');
  assert.equal(snapshot.records[0].citations[0].acquisition, 'Fictional Import Service');
  assert.match(html, /g\/dL/);
  assert.match(html, /&quot;low&quot;:12/);
  assert.match(html, /Pages 2, 3/);
});
test('an older archived/current conflict is excluded from current prescription packets and summaries', (t) => {
  const { db, input } = fixture(t);
  const original = db.prepare("SELECT * FROM medications WHERE id='current-med'").get();
  const assertion = db
    .prepare("SELECT * FROM medication_preferences WHERE medication_id='current-med'")
    .get();
  db.exec(
    "INSERT INTO visibility_events VALUES('legacy-archive','medication','current-med',1,1,'2026-09-11','Profile owner')",
  );
  const options = exportOptions(db, input);
  assert.equal(options.choices.find((row) => row.id === 'current-med')?.current, false);
  assert.equal(options.choices.find((row) => row.id === 'current-med')?.archived, true);
  const packet = exportSnapshot(db, { ...input, includePrescriptions: true });
  assert.equal(
    packet.records.some((row) => row.type === 'medication'),
    false,
  );
  const provider = exportSnapshot(db, { ...input, mode: 'provider', includeArchived: true });
  assert(
    provider.records.some((row) => row.id === 'current-med'),
    'provider history still retains the archived original',
  );
  const html = exportHtml(provider);
  assert.match(html, /No personally confirmed current prescriptions recorded/);
  assert.match(html, /Personal state: Archived/);
  assert.deepEqual(db.prepare("SELECT * FROM medications WHERE id='current-med'").get(), original);
  assert.deepEqual(
    db.prepare("SELECT * FROM medication_preferences WHERE medication_id='current-med'").get(),
    assertion,
  );
});
test('selection is deterministic, full test history respects exact dates and trends exclude errors and partial dates', (t) => {
  const { db, input } = fixture(t);
  const first = exportSnapshot(db, {
    ...input,
    selected: ['observation:lab-2', 'observation:lab-1', 'observation:lab-1'],
    trends: true,
  });
  const second = exportSnapshot(db, {
    ...input,
    selected: ['observation:lab-1', 'observation:lab-2'],
    trends: true,
  });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.match(exportHtml(first), /<svg/);
  const history = exportSnapshot(db, {
    ...input,
    selected: ['test_type:cbc'],
    from: '2026-01-01',
    to: '2026-09-01',
    trends: true,
  });
  assert.deepEqual(
    history.records.map((r) => r.id),
    ['lab-1', 'lab-2', 'lab-error'],
  );
  const trend = exportHtml(history).split('<h2>Simple trends')[1];
  assert.doesNotMatch(trend, />999</);
  assert.match(trend, /1 selected results are not plotted/);
  assert.throws(
    () =>
      exportSnapshot(db, { ...input, selected: ['observation:lab-partial'], from: '2026-01-01' }),
    (e: unknown) => hasCode(e, 'EXPORT_DATE_SCOPE'),
  );
  assert.throws(
    () => exportSnapshot(db, { ...input, from: '2026-02-31' }),
    (e: unknown) => hasCode(e, 'INVALID_EXPORT'),
  );
});
test('preview detects changed note and selected revisions, requires explicit archive inclusion and fingerprints identity', (t) => {
  const { db, note, input, sensitive } = fixture(t),
    old = exportSnapshot(db, input);
  db.prepare('UPDATE people SET display_name=? WHERE id=?').run(
    'Renamed fictional person',
    'patient',
  );
  assert.notEqual(exportSnapshot(db, input).fingerprint, old.fingerprint);
  db.prepare('UPDATE notes SET archived=1 WHERE id=?').run(sensitive.id);
  assert.throws(
    () => exportSnapshot(db, { ...input, selected: [`note:${sensitive.id}`] }),
    (e: unknown) => hasCode(e, 'ARCHIVED_EXPORT'),
  );
  assert.equal(
    exportSnapshot(db, { ...input, selected: [`note:${sensitive.id}`], includeArchived: true })
      .records[0].archived,
    true,
  );
  saveNote(db, note.id, { version: note.version, content: 'New saved revision' });
  assert.throws(
    () => exportSnapshot(db, input),
    (e: unknown) => hasCode(e, 'EXPORT_STALE'),
  );
});
test('provider and finished notes remain immutable, retain title, literal source text and authorship', (t) => {
  const { db, input, note } = fixture(t),
    options = exportOptions(db, { type: 'document', id: 'provider-note' });
  const html = exportHtml(
    exportSnapshot(db, {
      type: 'document',
      id: 'provider-note',
      noteVersion: options.noteVersion,
      mode: 'detailed',
    }),
  );
  assert.match(html, /Reviewed visit title/);
  assert.match(html, /Fictional Clinician/);
  assert.match(html, /&lt;script&gt;never run/);
  assert.match(html, /Contents and overview/);
  const finished = finishNote(db, note.id, { ...note, version: note.version });
  exportSnapshot(db, { ...input, noteVersion: finished.version });
  assert.equal(getNote(db, note.id).status, 'finished');
});
test('profile scoped preview tokens reject another profile and changed selected records', async (t) => {
  const { db, input } = fixture(t),
    handler = createNoteExports();
  let result: PreviewResult | undefined;
  const base = {
    resource: 'note-exports',
    method: 'POST',
    db,
    profileId: 'cookie-dough',
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    respond: (data: unknown) => {
      result = data as PreviewResult;
    },
    jsonBody: async () => ({ ...input, selected: ['observation:lab-1'] }),
  };
  await handler(route({ ...base, id: 'preview' }));
  assert.ok(result);
  const token = result.token;
  await assert.rejects(
    handler(route({ ...base, id: token, action: 'validate', profileId: 'cedar' })),
    (e: unknown) => hasCode(e, 'EXPORT_EXPIRED'),
  );
  await handler(route({ ...base, id: token, action: 'validate' }));
  assert.equal(result.valid, true);
  db.prepare('UPDATE observations SET value_text=? WHERE id=?').run('Corrected', 'lab-1');
  await assert.rejects(handler(route({ ...base, id: token, action: 'validate' })), (e: unknown) =>
    hasCode(e, 'EXPORT_STALE'),
  );
});
test('foreign-profile and unknown selectors fail; selections never traverse linked notes implicitly', (t) => {
  const { db, input, note, sensitive } = fixture(t);
  db.prepare('INSERT INTO note_links(id,note_id,target_type,target_id) VALUES(?,?,?,?)').run(
    'link',
    note.id,
    'note',
    sensitive.id,
  );
  assert.equal(exportSnapshot(db, input).records.length, 0);
  assert.throws(
    () => exportSnapshot(db, { ...input, selected: ['note:belongs-to-other-profile'] }),
    (e: unknown) => hasStatus(e, 404),
  );
  assert.throws(
    () => exportSnapshot(db, { ...input, selected: ['notes; DROP TABLE notes:bad'] }),
    (e: unknown) => hasCode(e, 'INVALID_EXPORT'),
  );
});
test('clinical selection and complete histories never merge another person under Self', (t) => {
  const { db, input } = fixture(t);
  db.exec(
    "INSERT INTO people VALUES('relative','Fictional relative','sibling',0); INSERT INTO observations(id,test_type_id,person_id,source_record_id,label,effective_at,date_precision,value_text,value_numeric,unit) VALUES('relative-lab','cbc','relative','raw','Relative private result','2026-08-01','day','17',17,'g/dL')",
  );
  assert.ok(!exportOptions(db, input).choices.some((c) => c.id === 'relative-lab'));
  assert.ok(
    !exportSnapshot(db, { ...input, selected: ['test_type:cbc'] }).records.some(
      (r) => r.id === 'relative-lab',
    ),
  );
  assert.throws(
    () => exportSnapshot(db, { ...input, selected: ['observation:relative-lab'] }),
    (e: unknown) => hasCode(e, 'EXPORT_SUBJECT'),
  );
});
test('literal source JSON preserves large numbers and linked source files have an explicit companion selection', (t) => {
  const { db, input, note } = fixture(t);
  db.prepare('UPDATE source_records SET raw_json=? WHERE id=?').run(
    '{"value":9007199254740993,"repeated":1,"repeated":2}',
    'raw',
  );
  assert.match(
    exportHtml(exportSnapshot(db, { ...input, selected: ['source:raw'] })),
    /9007199254740993/,
  );
  db.prepare('INSERT INTO note_links(id,note_id,target_type,target_id) VALUES(?,?,?,?)').run(
    'file-link',
    note.id,
    'source',
    'file',
  );
  const choice = exportOptions(db, input).choices.find((c) => c.key === 'source_file:file');
  assert.equal(choice?.linked, true);
  const packet = exportSnapshot(db, { ...input, selected: ['source_file:file'] });
  assert.equal(packet.records[0].type, 'source_file');
  assert.equal(packet.assets[0].contentUrl, '/api/sources/file/content');
  assert.equal(
    exportSnapshot(db, { ...input, selected: ['source:file'] }).records[0].type,
    'source_file',
  );
});
test('latest visibility events override legacy archives and constrain history expansion', (t) => {
  const { db, input, sensitive } = fixture(t);
  db.exec(
    'CREATE TABLE IF NOT EXISTS visibility_events(id TEXT PRIMARY KEY,target_type TEXT,target_id TEXT,archived INTEGER,version INTEGER,created_at TEXT,actor TEXT)',
  );
  db.prepare('UPDATE notes SET archived=1 WHERE id=?').run(sensitive.id);
  db.prepare(
    'INSERT INTO visibility_events(id,target_type,target_id,archived,version,created_at,actor) VALUES(?,?,?,?,?,?,?)',
  ).run('restore-note', 'note', sensitive.id, 0, 1, '2026-09-11', 'Profile owner');
  assert.equal(
    exportSnapshot(db, { ...input, selected: [`note:${sensitive.id}`] }).records[0].archived,
    false,
  );
  db.prepare(
    'INSERT INTO visibility_events(id,target_type,target_id,archived,version,created_at,actor) VALUES(?,?,?,?,?,?,?)',
  ).run('archive-lab', 'observation', 'lab-1', 1, 1, '2026-09-11', 'Profile owner');
  assert.throws(
    () => exportSnapshot(db, { ...input, selected: ['observation:lab-1'] }),
    (e: unknown) => hasCode(e, 'ARCHIVED_EXPORT'),
  );
  const history = exportSnapshot(db, { ...input, selected: ['test_type:cbc'] });
  assert.ok(!history.records.some((r) => r.id === 'lab-1'));
});
test('brief medication confirmation stays current and concise while detailed retains literal prior assertions', (t) => {
  const { db, input } = fixture(t);
  const literal =
    '{"statement":"Currently taking","author":"Fictional patient","basis":"Confirmed at appointment","previousAssertion":{"statement":"OLD PRIVATE EXPLANATION","number":9007199254740993}}';
  db.prepare('UPDATE medication_preferences SET assertion_json=? WHERE medication_id=?').run(
    literal,
    'current-med',
  );
  const brief = exportHtml(exportSnapshot(db, { ...input, selected: ['medication:current-med'] }));
  assert.match(brief, /Currently taking/);
  assert.match(brief, /Fictional patient/);
  assert.match(brief, /Confirmed at appointment/);
  assert.match(brief, /2026-09-01/);
  assert.doesNotMatch(brief, /OLD PRIVATE EXPLANATION|previousAssertion|9007199254740993/);
  const detailed = exportHtml(
    exportSnapshot(db, { ...input, mode: 'detailed', selected: ['medication:current-med'] }),
  );
  assert.match(detailed, /OLD PRIVATE EXPLANATION/);
  assert.match(detailed, /9007199254740993/);
  assert.equal(
    db
      .prepare('SELECT assertion_json FROM medication_preferences WHERE medication_id=?')
      .get('current-med')?.assertion_json,
    literal,
  );
});

test('provider packet includes clinical history and unmatched assertions, excluding unselected personal history', (t) => {
  const { db, input, sensitive } = fixture(t);
  db.exec(`INSERT INTO procedures(id,source_record_id,label) VALUES('procedure','raw','Recorded procedure');
    INSERT INTO source_records(id,source_file_id,provider_id,kind,raw_json) VALUES('allergy','file','issuer','clinical_object','{"data":{"display":"Recorded allergy"}}');
    INSERT INTO people VALUES('doctor','Dr Fiction','professional',0);
    INSERT INTO notes(id,kind,status,title,content,person_id,profile_json,created_at,updated_at) VALUES('doctor-note','person','editable','Doctor','PRIVATE DOCTOR THOUGHTS','doctor','{"tags":["Primary Care Provider"],"phone":"555-0100","medicalHistory":"PRIVATE DOCTOR HISTORY"}','2026-01-01','2026-01-01');`);
  db.exec(
    "INSERT INTO providers VALUES('personal','Person · personal sources'); INSERT INTO documents(id,source_record_id,provider_id,title,text_content) VALUES('personal-doc','raw','personal','Personal source','PRIVATE PERSONAL DOCUMENT'),('unknown-doc','raw',NULL,'Unknown provider','PRIVATE UNKNOWN DOCUMENT');",
  );
  const snapshot = exportSnapshot(db, { ...input, mode: 'provider' }),
    html = exportHtml(snapshot);
  for (const id of [
    'old-order',
    'current-med',
    'lab-1',
    'lab-partial',
    'provider-note',
    'procedure',
    'allergy',
  ])
    assert.ok(
      snapshot.records.some((r) => r.id === id),
      id,
    );
  assert.ok(!snapshot.records.some((r) => r.id === 'raw'));
  assert.match(html, /Recorded allergy|Recorded procedure/);
  assert.match(html, /555-0100/);
  assert.doesNotMatch(
    html,
    /EXPLICIT SENSITIVE HISTORY|PRIVATE DOCTOR THOUGHTS|PRIVATE DOCTOR HISTORY|PRIVATE PERSONAL DOCUMENT|PRIVATE UNKNOWN DOCUMENT/,
  );
  assert.ok(!JSON.stringify(snapshot).includes(sensitive.content));
});
test('simple visit toggles select current use and direct links, deduplicating assets without recursion', (t) => {
  const { db, input, note, sensitive } = fixture(t);
  const second = saveNote(db, sensitive.id, {
    version: sensitive.version,
    content: 'Chosen linked note',
  });
  db.exec(`INSERT INTO note_links(id,note_id,target_type,target_id) VALUES('direct','${note.id}','note','${second.id}'),('lab','${note.id}','observation','lab-1'),('nested','${second.id}','medication','old-order');
    INSERT INTO assets VALUES('asset','photo.png','assets/photo.png','image/png',10,'hash','2026-01-01','user-uploaded',NULL);
    INSERT INTO attachments(id,asset_id,owner_type,owner_id,created_at) VALUES('attachment-a','asset','note','${note.id}','2026-01-01'),('attachment-b','asset','note','${second.id}','2026-01-01');`);
  const snapshot = exportSnapshot(db, {
    ...input,
    includeLinked: true,
    includeAttachments: true,
    includePrescriptions: true,
  });
  assert.ok(snapshot.records.some((r) => r.id === second.id));
  assert.ok(snapshot.records.some((r) => r.id === 'current-med'));
  assert.ok(!snapshot.records.some((r) => r.id === 'old-order'));
  assert.equal(snapshot.records.filter((r) => r.id === 'lab-1').length, 1);
  assert.equal(snapshot.assets.length, 1);
  assert.equal(snapshot.assets[0]?.id, 'asset');
  const disabled = exportSnapshot(db, {
    ...input,
    includeLinked: false,
    includeAttachments: false,
  });
  assert.equal(disabled.records.length, 0);
  assert.equal(disabled.assets.length, 0);
});
test('Self provider packet only shares patient fields, selected notes and direct links; source version is guarded', (t) => {
  const { db, note, sensitive } = fixture(t);
  const self = db.prepare("SELECT id FROM notes WHERE person_id='patient'").get();
  assert.ok(self);
  db.prepare('UPDATE notes SET content=?,topics=?,profile_json=? WHERE id=?').run(
    'PRIVATE SELF JOURNAL',
    'PRIVATE TOPICS',
    '{"birthDate":"1992-04-15","privateMisc":"PRIVATE EXTRA"}',
    self.id,
  );
  const options = exportOptions(db, { type: 'person', id: 'patient' });
  const input = {
    type: 'person',
    id: 'patient',
    mode: 'provider',
    noteVersion: options.noteVersion,
    noteIds: [note.id, note.id],
  };
  const snapshot = exportSnapshot(db, input),
    html = exportHtml(snapshot);
  assert.match(html, /1992-04-15/);
  assert.match(html, /Questions for my appointment/);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /PRIVATE SELF JOURNAL|PRIVATE TOPICS|PRIVATE EXTRA|EXPLICIT SENSITIVE HISTORY/,
  );
  assert.equal(snapshot.records.filter((r) => r.id === note.id).length, 1);
  assert.throws(
    () => exportSnapshot(db, { ...input, noteIds: ['missing-other-profile'] }),
    (e: unknown) => hasStatus(e, 404),
  );
  assert.throws(
    () => exportSnapshot(db, { ...input, noteIds: [self.id] }),
    (e: unknown) => hasCode(e, 'INVALID_EXPORT'),
  );
  const first = snapshot.fingerprint;
  saveNote(db, sensitive.id, { version: sensitive.version, content: 'Unselected edit' });
  assert.equal(exportSnapshot(db, input).fingerprint, first);
  saveNote(db, note.id, { version: note.version, content: 'Selected edit' });
  assert.notEqual(exportSnapshot(db, input).fingerprint, first);
});
test('provider rendering compacts clinical rows and repeated narratives while keeping distinct assertions and attribution', (t) => {
  const { db, input } = fixture(t);
  db.exec(
    `INSERT INTO documents(id,source_record_id,provider_id,title,effective_at,text_content) SELECT 'same-narrative',source_record_id,provider_id,'Second attributed copy','2026-08-02',text_content FROM documents WHERE id='provider-note'`,
  );
  const snapshot = exportSnapshot(db, { ...input, mode: 'provider' }),
    html = exportHtml(snapshot);
  assert.match(html, /class="clinical-table"/);
  assert.match(html, /class="result-table"/);
  for (const value of [
    '12.4',
    '13.1',
    '999',
    'g/dL',
    'entered-in-error',
    'P1: year',
    '5 mg daily',
    'inactive',
  ])
    assert.ok(html.includes(value), value);
  assert.equal(
    html.split('Provider literal text &lt;script&gt;never run&lt;/script&gt;').length - 1,
    1,
  );
  assert.match(html, /Second attributed copy/);
  assert.match(html, /Reviewed visit title/);
  assert.match(JSON.stringify(exportEvidence(snapshot)), /Fictional Import Service/);
  assert.match(html, /Fictional Clinic/);
  assert.match(JSON.stringify(exportEvidence(snapshot)), /synthetic-sha256/);
  assert.equal(snapshot.records.filter((r) => r.type === 'document').length, 2);
});
test('evidence companion keeps literal source tokens and indexed citations, rejects stale or foreign previews', async (t) => {
  const { db, input } = fixture(t);
  db.exec(
    `INSERT INTO source_records(id,source_file_id,provider_id,kind,raw_json) VALUES('unmapped','file','issuer','clinical_object','{"data":{"value":9007199254740993,"same":1,"same":2}}')`,
  );
  const handler = createNoteExports();
  let response: PreviewResult | undefined,
    headers: Record<string, string> | undefined,
    body: string | undefined;
  const base = {
    resource: 'note-exports',
    method: 'POST',
    db,
    profileId: 'cookie-dough',
    req: {} as IncomingMessage,
    res: {
      writeHead: (_status: number, h: Record<string, string>) => {
        headers = h;
      },
      end: (b: string) => {
        body = b;
      },
    } as unknown as ServerResponse,
    respond: (r: unknown) => {
      response = r as PreviewResult;
    },
    jsonBody: async () => ({ ...input, mode: 'provider' }),
  };
  await handler(route({ ...base, id: 'preview' }));
  assert.ok(response);
  const token = response.token;
  assert.equal(response.evidenceAvailable, true);
  await handler(route({ ...base, id: token, action: 'evidence' }));
  assert.equal(headers?.['Content-Type'], 'application/json');
  assert.ok(body);
  const evidence = JSON.parse(body) as EvidenceCompanion;
  assert.equal(evidence.format, 'circus-health-provider-evidence-v1');
  assert.match(
    evidence.records.find((r) => r.id === 'unmapped')?.row.raw_json ?? '',
    /9007199254740993,"same":1,"same":2/,
  );
  assert.equal(evidence.citationIndex[0].number, 1);
  assert.ok(evidence.citationIndex[0].file);
  await assert.rejects(
    handler(route({ ...base, id: token, action: 'evidence', profileId: 'other' })),
    (e: unknown) => hasCode(e, 'EXPORT_EXPIRED'),
  );
  db.prepare('UPDATE observations SET value_text=? WHERE id=?').run('corrected', 'lab-1');
  await assert.rejects(handler(route({ ...base, id: token, action: 'evidence' })), (e: unknown) =>
    hasCode(e, 'EXPORT_STALE'),
  );
});
test('sharing an attachment never exposes its unselected private owner captions in evidence JSON', (t) => {
  const { db, input, note, sensitive } = fixture(t);
  db.exec(`INSERT INTO assets VALUES('shared','photo.png','assets/shared.png','image/png',10,'shared-hash','2026-01-01','user-uploaded',NULL);
    INSERT INTO attachments(id,asset_id,owner_type,owner_id,caption,created_at) VALUES('chosen-owner','shared','note','${note.id}','Selected caption','2026-01-01'),('private-owner','shared','note','${sensitive.id}','PRIVATE OWNER CAPTION','2026-01-01');`);
  db.prepare('INSERT INTO note_links(id,note_id,target_type,target_id) VALUES(?,?,?,?)').run(
    'private-backlink',
    sensitive.id,
    'note',
    note.id,
  );
  const snapshot = exportSnapshot(db, { ...input, mode: 'provider' });
  assert.doesNotMatch(JSON.stringify(exportEvidence(snapshot)), /Private family context/);
  assert.equal(snapshot.assets[0].owners.length, 1);
  assert.equal(snapshot.assets[0].owners[0].id, 'chosen-owner');
  assert.doesNotMatch(JSON.stringify(exportEvidence(snapshot)), /PRIVATE OWNER CAPTION/);
});

test('packet display labels empty reference wrappers without changing the evidence', (t) => {
  const { db, input } = fixture(t);
  db.prepare('UPDATE observations SET reference_json=? WHERE id=?').run('{"raw":null}', 'lab-1');
  const snapshot = exportSnapshot(db, { ...input, mode: 'provider' });
  assert.doesNotMatch(exportHtml(snapshot), /&quot;raw&quot;:null/);
  assert.equal(
    (exportEvidence(snapshot) as unknown as EvidenceCompanion).records.find((r) => r.id === 'lab-1')
      ?.row.reference_json,
    '{"raw":null}',
  );
});

test('long narrative test results use full-width rows instead of narrow numeric cells', (t) => {
  const { db, input } = fixture(t),
    narrative = 'Unique pathology narrative. '.repeat(20);
  db.prepare('UPDATE observations SET value_text=? WHERE id=?').run(narrative, 'lab-1');
  const html = exportHtml(exportSnapshot(db, { ...input, mode: 'provider' }));
  assert.match(html, /<td>Narrative below<\/td>/);
  assert.ok(html.includes('<td colspan="5"><div class="literal">' + narrative));
});

test('finished note exports resolve old clinical kinds while preserving link attribution, evidence and stale-preview checks', async (t) => {
  const { vaultFixture, newProfile } = await import('./helpers/vault-fixture.ts');
  const { uploadIntake, reviewIntake, importIntake } = await import('../intake.ts');
  const { createNote } = await import('../notes.ts');
  const { previewRecordCorrection } = await import('../record-corrections.ts');
  const { applyClinicalDecision } = await import('../mapping-actions.ts');
  const { manager } = vaultFixture(t),
    { profile } = await newProfile(manager, 'Fictional export reclassification');
  const opened = manager.opened.get(profile.id);
  assert.ok(opened);
  const { db, root } = opened;
  const envelope = {
    format: 'health-record-v1',
    id: 'creatinine',
    kind: 'record',
    payload: { verbatim: 'Creatinine 1.20 mg/dL' },
    clinical: {
      kind: 'procedure',
      subject: 'self',
      procedureLabel: 'Creatinine',
      procedureCategory: 'laboratory',
      date: '2025-01',
      valueText: '1.20',
      unit: 'mg/dL',
    },
    provenance: {
      capturedVia: 'Fictional patient export',
      sourceSystem: 'Fictional issuing hospital',
      sourceRecordId: 'creatinine',
      evidenceClass: 'provider_export',
      locator: 'page 1 row 1',
    },
    coverage: { status: 'complete_response', notes: [] },
  };
  const intake = uploadIntake(db, root, profile.id, {
      filename: 'fictional-export.jsonl',
      newProviderName: 'Fictional acquiring clinic',
      bytes: Buffer.from(JSON.stringify(envelope)),
    }),
    review = reviewIntake(db, root, profile.id, intake.id);
  importIntake(db, root, profile.id, intake.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: review.records.map((record) => ({
      recordId: record.id,
      action: 'accept',
      mapping: {},
    })),
  });
  const accepted = db.prepare('SELECT * FROM procedures').get();
  assert.ok(accepted);
  if (typeof accepted.id !== 'string') throw new Error('Expected an accepted procedure ID');
  const acceptedId = accepted.id;
  let note = createNote(db, {
    kind: 'historical',
    title: 'Fictional completed appointment',
    content: 'My original questions about the retained result.',
    links: [{ targetType: 'procedure', targetId: accepted.id, relation: 'references' }],
  });
  note = finishNote(db, note.id, note);
  const oldNote = db.prepare('SELECT * FROM notes WHERE id=?').get(note.id),
    oldLinks = db.prepare('SELECT * FROM note_links WHERE note_id=?').all(note.id),
    oldSources = db.prepare('SELECT * FROM source_records').all(),
    oldFiles = db.prepare('SELECT * FROM source_files').all();
  const correct = (kind: ClinicalKind, set: Record<string, unknown>, operationId: string) => {
    const input = {
        kind,
        recordId: acceptedId,
        set,
        reason: 'Reviewed the retained fictional report.',
      },
      preview = previewRecordCorrection(db, input);
    return applyClinicalDecision(db, root, profile.id, 'clinical_correction', {
      ...input,
      previewToken: preview.token,
      version: preview.version,
      operationId,
    });
  };
  correct(
    'procedure',
    {
      kind: 'observation',
      testLabel: 'Reviewed creatinine result',
      valueText: '1.20',
      unit: 'mg/dL',
    },
    'export-to-lab',
  );
  const input = {
    type: 'note',
    id: note.id,
    noteVersion: note.version,
    mode: 'brief',
    includeLinked: true,
  };
  const options = exportOptions(db, input),
    matching = options.choices.filter((choice) => choice.id === accepted.id);
  assert.equal(
    matching.length,
    1,
    'one canonical selectable record, no unavailable old-kind duplicate',
  );
  assert.equal(matching[0]?.type, 'observation');
  assert.equal(matching[0]?.linked, true);
  assert.ok(!matching[0]?.missing);
  const snapshot = exportSnapshot(db, input);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].type, 'observation');
  assert.equal(snapshot.records[0].row.value_text, '1.20');
  assert.deepEqual(snapshot.main.row, oldNote);
  const html = exportHtml(snapshot);
  assert.match(html, /Reviewed creatinine result/);
  assert.match(html, /1\.20/);
  assert.match(html, /Personal note; finished/);
  assert.match(html, /Fictional acquiring clinic/);
  assert.equal(snapshot.records[0].citations[0].id, accepted.source_record_id);
  assert.equal(
    snapshot.records[0].citations[0].sha256,
    oldFiles.find((file) => file.id === intake.id)?.sha256,
  );
  const companion = exportEvidence(
    exportSnapshot(db, { ...input, mode: 'provider' }),
  ) as unknown as EvidenceCompanion;
  assert.deepEqual(companion.main.links, [
    {
      targetType: 'procedure',
      targetId: accepted.id,
      relation: 'references',
      resolvedTargetType: 'observation',
    },
  ]);
  assert.equal(companion.records.filter((record) => record.id === accepted.id).length, 1);
  const explicit = exportSnapshot(db, {
    type: 'note',
    id: note.id,
    noteVersion: note.version,
    mode: 'detailed',
    selected: [`procedure:${accepted.id}`, `observation:${accepted.id}`],
  });
  assert.equal(explicit.records.length, 1);
  assert.equal(explicit.records[0].type, 'observation');
  const handler = createNoteExports();
  let previewResult: PreviewResult | undefined;
  const request = {
    resource: 'note-exports',
    method: 'POST',
    db,
    profileId: profile.id,
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    respond: (value: unknown) => {
      previewResult = value as PreviewResult;
    },
    jsonBody: async () => input,
  };
  await handler(route({ ...request, id: 'preview' }));
  assert.ok(previewResult);
  const token = previewResult.token;
  correct(
    'observation',
    {
      kind: 'procedure',
      procedureLabel: 'Reviewed creatinine order',
      procedureCategory: 'laboratory',
    },
    'export-back-to-order',
  );
  await assert.rejects(
    handler(route({ ...request, id: token, action: 'validate' })),
    (error: unknown) => hasCode(error, 'EXPORT_STALE'),
    'reclassification after preview requires a refreshed print',
  );
  const returned = exportSnapshot(db, input);
  assert.equal(returned.records[0].type, 'procedure');
  assert.match(exportHtml(returned), /Reviewed creatinine order/);
  assert.deepEqual(db.prepare('SELECT * FROM notes WHERE id=?').get(note.id), oldNote);
  assert.deepEqual(db.prepare('SELECT * FROM note_links WHERE note_id=?').all(note.id), oldLinks);
  assert.deepEqual(db.prepare('SELECT * FROM source_records').all(), oldSources);
  assert.deepEqual(db.prepare('SELECT * FROM source_files').all(), oldFiles);
});
