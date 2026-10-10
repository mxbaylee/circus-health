import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createNote } from '../notes.ts';
import {
  exportEvidence,
  exportHtml,
  exportOptions,
  exportSnapshot,
  createNoteExports,
} from '../note-exports.ts';
import { writePacketPreference } from '../packet-preferences.ts';
import type { PacketReview, PacketSelection } from '../../shared/packet-selection.ts';
import { packetFixture, SAFE, SECRET, UNKNOWN } from './packet-selection-fixture.ts';

type Fixture = ReturnType<typeof packetFixture>;
function isolateSensitiveOriginal(f: Fixture) {
  const path = 'data/profiles/cookie-dough/sources/isolated-context.txt';
  const content = `Fictional separate source context: ${SECRET}`;
  writeFileSync(resolve(f.root, path), content);
  f.db
    .prepare('INSERT INTO source_files(id,provider_id,path,sha256,bytes) VALUES(?,?,?,?,?)')
    .run(
      'context-original',
      'capture',
      path,
      createHash('sha256').update(content).digest('hex'),
      Buffer.byteLength(content),
    );
  f.db
    .prepare(
      "UPDATE source_records SET source_file_id='context-original' WHERE id='sensitive-condition'",
    )
    .run();
  writePacketPreference(f.db, f.personId, {
    record: f.exclusion,
    alwaysWithhold: true,
    tags: [],
    expectedVersion: 0,
  });
}
type Route = Parameters<ReturnType<typeof createNoteExports>>[0];
interface Preview {
  token: string;
  fingerprint: string;
  html: string;
  assets: Array<{ id: string; contentUrl: string }>;
  packetReview: PacketReview;
}
const notice = /Some records were left out at the patient(?:'|’|&#39;)s request/;
const hasCode = (code: string) => (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === code;

function routes(f: Fixture) {
  const handler = createNoteExports();
  let response: unknown;
  let body = Buffer.alloc(0);
  let headers: Record<string, string> = {};
  const call = async (
    id: string,
    action?: string,
    input: object = {},
    overrides: Partial<Route> = {},
  ) => {
    response = undefined;
    body = Buffer.alloc(0);
    await handler({
      root: f.root,
      resource: 'note-exports',
      method: 'POST',
      id,
      action,
      db: f.db,
      profileId: 'cookie-dough',
      req: new EventEmitter() as IncomingMessage,
      res: Object.assign(new EventEmitter(), {
        writeHead: (_status: number, h: Record<string, string>) => {
          headers = h;
        },
        end: (value: string | Uint8Array) => {
          body = Buffer.from(value);
        },
      }) as unknown as ServerResponse,
      respond: (value: unknown) => {
        response = value;
      },
      jsonBody: async () => input,
      ...overrides,
    } as Route);
    return { response, body, headers };
  };
  const preview = async (packetSelection: PacketSelection, extra: object = {}) =>
    (await call('preview', undefined, { ...f.input, packetSelection, ...extra }))
      .response as Preview;
  const companion = (token: string, asset: string, overrides: Partial<Route> = {}) =>
    call(
      token,
      'companion',
      {},
      {
        method: 'GET',
        req: Object.assign(new EventEmitter(), {
          url: `/api/note-exports/${token}/companion?asset=${encodeURIComponent(asset)}`,
        }) as IncomingMessage,
        ...overrides,
      },
    );
  const inspection = (token: string, key: string, overrides: Partial<Route> = {}) =>
    call(
      token,
      'inspection',
      {},
      {
        method: 'GET',
        req: Object.assign(new EventEmitter(), {
          url: `/api/note-exports/${token}/inspection?key=${encodeURIComponent(key)}`,
        }) as IncomingMessage,
        ...overrides,
      },
    );
  return { call, preview, companion, inspection };
}

async function pdfText(pdf: Uint8Array) {
  assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), '%PDF-');
  const loading = getDocument({ data: new Uint8Array(pdf), useSystemFonts: true });
  try {
    const document = await loading.promise;
    const pages: string[] = [];
    for (let page = 1; page <= document.numPages; page++) {
      const content = await (await document.getPage(page)).getTextContent();
      pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
    }
    return pages.join('\n');
  } finally {
    await loading.destroy();
  }
}

for (const managed of [false, true])
  test(`selective ${managed ? 'managed-person' : 'Self'} packet keeps repeated sensitive evidence private across actual PDF, JSON and companions`, async (t) => {
    const f = packetFixture(t, managed);
    const before = {
      records: f.db.prepare('SELECT * FROM source_records ORDER BY id').all(),
      observations: f.db.prepare('SELECT * FROM observations ORDER BY id').all(),
      notes: f.db.prepare('SELECT * FROM notes ORDER BY id').all(),
      documents: f.db.prepare('SELECT * FROM documents ORDER BY id').all(),
      attachments: f.db.prepare('SELECT * FROM attachments ORDER BY id').all(),
    };
    const selection = { exclude: [f.exclusion] };
    const r = routes(f);
    const preview = await r.preview(selection);
    assert.match(JSON.stringify(preview.packetReview), new RegExp(SECRET));
    assert.ok(
      preview.packetReview.withheld.some((item) => item.key === 'source:sensitive-condition'),
    );
    assert.ok(preview.packetReview.includedCount > 0);
    const evidence = (await r.call(preview.token, 'evidence')).body.toString();
    const pdf = await pdfText((await r.call(preview.token, 'pdf')).body);
    const structured = JSON.parse(evidence) as {
      fingerprint: string;
      citationIndex: Array<{ id: string; number: number }>;
    };
    assert.equal(structured.fingerprint, preview.fingerprint);
    assert.deepEqual(
      structured.citationIndex.map((citation) => citation.id),
      ['raw'],
    );
    for (const citation of structured.citationIndex)
      assert.ok(pdf.includes(`[${citation.number}]`));
    for (const shared of [preview.html, evidence, pdf, JSON.stringify(preview.assets)]) {
      assert.doesNotMatch(shared, new RegExp(`${SECRET}|${UNKNOWN}|sensitive-condition`));
    }
    for (const shared of [preview.html, evidence, pdf]) {
      assert.match(shared, notice);
      assert.match(shared, /no verified single-person assignment/);
      assert.match(shared, new RegExp(SAFE));
      assert.match(shared, managed ? /Fictional Rowan Finch/ : /Cookie Dough/);
    }
    if (managed) assert.match(pdf, /caregiver/i);
    assert.doesNotMatch(evidence, /packetReview|withheldCount|opaqueItems/);
    assert.equal(
      preview.assets.length,
      0,
      'unchecked originals require a separate explicit choice',
    );
    await assert.rejects(r.companion(preview.token, 'secret-asset'));
    await assert.rejects(r.companion(preview.token, 'secret-duplicate'));
    assert.deepEqual(
      f.db.prepare('SELECT * FROM source_records ORDER BY id').all(),
      before.records,
    );
    assert.deepEqual(
      f.db.prepare('SELECT * FROM observations ORDER BY id').all(),
      before.observations,
    );
    assert.deepEqual(f.db.prepare('SELECT * FROM notes ORDER BY id').all(), before.notes);
    assert.deepEqual(f.db.prepare('SELECT * FROM documents ORDER BY id').all(), before.documents);
    assert.deepEqual(
      f.db.prepare('SELECT * FROM attachments ORDER BY id').all(),
      before.attachments,
    );
    assert.match(readFileSync(resolve(f.root, f.original.path), 'utf8'), new RegExp(SECRET));
    assert.equal(readFileSync(resolve(f.root, f.attachment.path), 'utf8'), SECRET);
  });

test('manual kind, date and personal-tag predicates freeze deterministic membership; explicit inclusion cannot override persistent withholding', (t) => {
  const f = packetFixture(t);
  const dated = exportSnapshot(f.db, {
    ...f.input,
    packetSelection: { kinds: ['observation'], from: '2026-07-01', to: '2026-08-01' },
  });
  assert.deepEqual(
    dated.records.map((record) => record.key),
    ['observation:lab-1', 'observation:lab-2'],
  );
  assert.ok(dated.packetReview!.withheld.some((item) => item.key === 'observation:lab-partial'));
  assert.ok(dated.packetReview!.withheld.some((item) => item.key === 'observation:lab-error'));
  writePacketPreference(f.db, f.personId, {
    record: { kind: 'observation', recordId: 'lab-1' },
    alwaysWithhold: false,
    tags: ['Appointment'],
    expectedVersion: 0,
  });
  writePacketPreference(f.db, f.personId, {
    record: { kind: 'observation', recordId: 'lab-2' },
    alwaysWithhold: true,
    tags: ['Appointment'],
    expectedVersion: 0,
  });
  const selection: PacketSelection = {
    kinds: ['observation'],
    from: '2026-07-01',
    to: '2026-08-01',
    tags: ['Appointment'],
    include: [{ kind: 'observation', recordId: 'lab-2' }],
  };
  const snapshot = exportSnapshot(f.db, { ...f.input, packetSelection: selection });
  assert.deepEqual(
    snapshot.records.map((record) => record.key),
    ['observation:lab-1'],
  );
  assert.ok(snapshot.packetReview!.withheld.some((item) => item.key === 'observation:lab-2'));
  const again = exportSnapshot(f.db, {
    ...f.input,
    packetSelection: {
      ...selection,
      kinds: ['observation', 'observation'],
      tags: ['Appointment', 'Appointment'],
    },
  });
  assert.equal(snapshot.fingerprint, again.fingerprint);
  const explicit = exportSnapshot(f.db, {
    ...f.input,
    packetSelection: {
      kinds: [],
      include: [
        { kind: 'observation', recordId: 'lab-1' },
        { kind: 'observation', recordId: 'lab-2' },
      ],
    },
  });
  assert.deepEqual(
    explicit.records.map((record) => record.key),
    ['observation:lab-1'],
  );
  const empty = exportSnapshot(f.db, {
    ...f.input,
    packetSelection: { kinds: ['observation'], from: '2030-01-01' },
  });
  assert.equal(empty.records.length, 0);
  assert.ok(empty.packetReview!.emptyKinds.includes('observation'));
  assert.match(exportHtml(empty), notice);
});

test('excluding the initiating note also removes its narrative and attachment while retaining selected clinical history', (t) => {
  const f = packetFixture(t);
  const snapshot = exportSnapshot(f.db, {
    type: 'note',
    id: f.note.id,
    noteVersion: f.note.version,
    mode: 'provider',
    packetSelection: { exclude: [{ kind: 'note', recordId: f.note.id }, f.exclusion] },
  });
  assert.match(exportHtml(snapshot), new RegExp(SAFE));
  assert.doesNotMatch(exportHtml(snapshot), new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(exportEvidence(snapshot)), new RegExp(SECRET));
  assert.ok(snapshot.packetReview!.withheld.some((item) => item.key === `note:${f.note.id}`));
});

test('single-person selection rejects explicit foreign records and never offers unresolved raw assertions as selected records', (t) => {
  const f = packetFixture(t);
  const other = createNote(f.db, { kind: 'person', title: 'Fictional Morgan Vale' });
  f.db
    .prepare(
      "INSERT INTO observations(id,test_type_id,person_id,source_record_id,label,value_text) VALUES('foreign-result','cbc',?,'raw','Foreign result','7')",
    )
    .run(other.personId!);
  const options = exportOptions(f.db, { type: 'person', id: f.personId });
  assert.ok(
    !options.packet!.candidates.some((candidate) =>
      ['foreign-result', 'unknown-owner'].includes(candidate.record.recordId),
    ),
  );
  assert.throws(
    () =>
      exportSnapshot(f.db, {
        ...f.input,
        packetSelection: { include: [{ kind: 'observation', recordId: 'foreign-result' }] },
      }),
    hasCode('EXPORT_SUBJECT'),
  );
});

test('explicit opaque-content consent is fingerprint bound and truthfully discloses unredacted exceptions', async (t) => {
  const f = packetFixture(t);
  const r = routes(f);
  const selection = { exclude: [f.exclusion] };
  const first = await r.preview(selection);
  const note = first.packetReview.opaqueItems.find(
    (item) => item.key === `record:note:${f.note.id}`,
  );
  assert.ok(note, 'selected note narrative requires review');
  assert.equal(note.blocked, false);
  const approved = await r.preview({
    ...selection,
    approvals: [{ key: note.key, fingerprint: note.fingerprint }],
  });
  assert.notEqual(approved.fingerprint, first.fingerprint);
  assert.match(approved.html, new RegExp(SECRET));
  const evidence = (await r.call(approved.token, 'evidence')).body.toString();
  assert.match(evidence, new RegExp(SECRET));
  const text = await pdfText((await r.call(approved.token, 'pdf')).body);
  for (const output of [approved.html, evidence, text]) {
    assert.match(output, /unredacted/i);
    assert.match(output, notice);
    assert.match(output, /may (?:still )?(?:contain|include|reveal)/i);
  }
  f.db.prepare('UPDATE notes SET content=? WHERE id=?').run(`Changed ${SECRET}`, f.note.id);
  await assert.rejects(
    r.preview({
      ...selection,
      approvals: [{ key: note.key, fingerprint: note.fingerprint }],
    }),
    hasCode('EXPORT_DISCLOSURE_STALE'),
  );
  const changed = await r.preview(selection);
  assert.doesNotMatch(changed.html, new RegExp(SECRET));
  assert.notEqual(
    changed.packetReview.opaqueItems.find((item) => item.key === note.key)?.fingerprint,
    note.fingerprint,
  );
});

test('token-bound companion downloads return only approved bytes and block duplicate-hash aliases of persistent conflicts', async (t) => {
  const f = packetFixture(t);
  f.db
    .prepare("UPDATE attachments SET caption=? WHERE id='safe-record-attachment'")
    .run(`${SECRET}-caption`);
  const r = routes(f);
  const selection = { exclude: [f.exclusion] };
  const first = await r.preview(selection);
  const safe = first.packetReview.opaqueItems.find((item) => item.key.includes('safe-asset'));
  assert.ok(safe, 'included clinical attachment must be reviewable');
  const approved = await r.preview({
    ...selection,
    approvals: [{ key: safe.key, fingerprint: safe.fingerprint }],
  });
  assert.equal(approved.assets.length, 1);
  assert.match(
    approved.assets[0].contentUrl,
    new RegExp(`/note-exports/${approved.token}/companion`),
  );
  const downloaded = await r.companion(approved.token, approved.assets[0].id);
  assert.equal(downloaded.body.toString(), 'Fictional safe companion bytes');
  assert.doesNotMatch(
    (await r.call(approved.token, 'evidence')).body.toString(),
    new RegExp(`${SECRET}-caption`),
    'consent to original bytes must not silently add private owner captions',
  );
  await assert.rejects(r.companion(approved.token, 'secret-asset'));
  await assert.rejects(
    r.companion(approved.token, approved.assets[0].id, { profileId: 'other' }),
    hasCode('EXPORT_EXPIRED'),
  );
  writeFileSync(resolve(f.root, f.safeAttachment.path), 'Fictional changed original bytes');
  await assert.rejects(r.companion(approved.token, approved.assets[0].id), hasCode('EXPORT_STALE'));
  writeFileSync(resolve(f.root, f.safeAttachment.path), 'Fictional safe companion bytes');
  writePacketPreference(f.db, f.personId, {
    record: { kind: 'observation', recordId: 'lab-1' },
    alwaysWithhold: true,
    tags: [],
    expectedVersion: 0,
  });
  await assert.rejects(
    r.preview({
      ...selection,
      approvals: first.packetReview.opaqueItems.map(({ key, fingerprint }) => ({
        key,
        fingerprint,
      })),
    }),
    hasCode('EXPORT_DISCLOSURE_STALE'),
  );
  const blocked = await r.preview(selection);
  assert.equal(blocked.assets.length, 0);
  assert.ok(blocked.packetReview.opaqueItems.some((item) => item.blocked));
  const duplicate = blocked.packetReview.opaqueItems.find((item) =>
    item.key.includes('secret-asset'),
  );
  assert.ok(
    duplicate?.blocked,
    'the attachment on an included note shares withheld attachment bytes',
  );
  await assert.rejects(
    r.preview({
      ...selection,
      approvals: [{ key: duplicate.key, fingerprint: duplicate.fingerprint }],
    }),
    hasCode('EXPORT_DISCLOSURE_STALE'),
  );
  for (const alias of ['secret-asset', 'secret-duplicate', 'safe-asset'])
    await assert.rejects(r.companion(blocked.token, alias));
});

test('a shared original defaults to withheld; an explicit exception discloses actual unredacted bytes and persistent conflict cannot be approved', async (t) => {
  const f = packetFixture(t);
  const r = routes(f);
  const selection = { exclude: [f.exclusion] };
  const first = await r.preview(selection);
  const original = first.packetReview.opaqueItems.find((item) =>
    item.key.includes('source-file:file'),
  );
  assert.ok(
    original,
    'the original shared by selected result and excluded condition must be offered for private review',
  );
  assert.equal(original.included, false);
  assert.equal(original.blocked, false);
  const approved = await r.preview({
    ...selection,
    approvals: [{ key: original.key, fingerprint: original.fingerprint }],
  });
  const asset = approved.assets.find((item) => item.id === 'source-file:file');
  assert.ok(asset);
  const content = (await r.companion(approved.token, asset.id)).body.toString();
  assert.match(content, new RegExp(SECRET));
  assert.match(content, new RegExp(UNKNOWN));
  assert.equal(content, readFileSync(resolve(f.root, f.original.path), 'utf8'));
  for (const shared of [
    approved.html,
    (await r.call(approved.token, 'evidence')).body.toString(),
  ]) {
    assert.match(shared, /unredacted/i);
    assert.match(shared, /may (?:still )?(?:contain|include|reveal)/i);
    assert.doesNotMatch(
      shared,
      new RegExp(SECRET),
      'generic exception disclosure must not name the excluded condition',
    );
  }
  writePacketPreference(f.db, f.personId, {
    record: f.exclusion,
    alwaysWithhold: true,
    tags: [],
    expectedVersion: 0,
  });
  const blocked = await r.preview(selection);
  const fresh = blocked.packetReview.opaqueItems.find((item) => item.key === original.key);
  assert.ok(fresh?.blocked);
  await assert.rejects(
    r.preview({
      ...selection,
      approvals: [{ key: fresh.key, fingerprint: fresh.fingerprint }],
    }),
    hasCode('EXPORT_DISCLOSURE_STALE'),
  );
  assert.ok(!blocked.assets.some((item) => item.id === 'source-file:file'));
  await assert.rejects(r.companion(blocked.token, 'source-file:file'));
});

test('changing a persistent choice invalidates reopened previews for validate, PDF, evidence and approved companion download', async (t) => {
  const f = packetFixture(t);
  const r = routes(f);
  const initial = await r.preview({ exclude: [f.exclusion] });
  const safe = initial.packetReview.opaqueItems.find((item) => item.key.includes('safe-asset'));
  assert.ok(safe);
  const old = await r.preview({
    exclude: [f.exclusion],
    approvals: [{ key: safe.key, fingerprint: safe.fingerprint }],
  });
  await r.call(old.token, 'validate');
  writePacketPreference(f.db, f.personId, {
    record: { kind: 'observation', recordId: 'lab-2' },
    alwaysWithhold: true,
    tags: [],
    expectedVersion: 0,
  });
  for (const action of ['validate', 'pdf', 'evidence'])
    await assert.rejects(r.call(old.token, action), hasCode('EXPORT_STALE'));
  await assert.rejects(r.companion(old.token, old.assets[0].id), hasCode('EXPORT_STALE'));
  const reopened = await r.preview({ exclude: [f.exclusion] });
  assert.notEqual(reopened.fingerprint, old.fingerprint);
  assert.ok(reopened.packetReview.withheld.some((item) => item.key === 'observation:lab-2'));
  assert.doesNotMatch((await r.call(reopened.token, 'evidence')).body.toString(), /"id": "lab-2"/);
  await assert.rejects(
    routes(f).call(old.token, 'validate'),
    hasCode('EXPORT_EXPIRED'),
    'tokens are not durable delivery receipts',
  );
});

test('record selection does not claim semantic redaction of separately included structured clinical fields', (t) => {
  const f = packetFixture(t);
  // A record-ID boundary cannot discover that this distinct included value repeats
  // another fact. This explicitly qualifies the stated limit rather than promising
  // universal removal of arbitrary matching text.
  f.db
    .prepare("UPDATE observations SET value_text=?,value_numeric=NULL WHERE id='lab-1'")
    .run(SECRET);
  const snapshot = exportSnapshot(f.db, {
    ...f.input,
    packetSelection: { exclude: [f.exclusion] },
  });
  assert.match(exportHtml(snapshot), new RegExp(SECRET));
  assert.match(JSON.stringify(exportEvidence(snapshot)), new RegExp(SECRET));
  assert.match(exportHtml(snapshot), /structured fields remain as recorded/i);
  assert.match(exportHtml(snapshot), /do not redact/i);
});

test('persistent withholding follows converted-source original pointers and duplicate hashes to the actual companion', async (t) => {
  const f = packetFixture(t);
  const proposalPath = 'data/profiles/cookie-dough/sources/converted.jsonl';
  const proposalBytes = '{"fictional":"converted selected result"}\n';
  writeFileSync(resolve(f.root, proposalPath), proposalBytes);
  f.db
    .prepare(
      'INSERT INTO source_files(id,provider_id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?,?)',
    )
    .run(
      'converted-proposal',
      'capture',
      proposalPath,
      createHash('sha256').update(proposalBytes).digest('hex'),
      Buffer.byteLength(proposalBytes),
      'intake_proposal',
      JSON.stringify({ originalSourceFileId: 'file' }),
    );
  f.db
    .prepare("UPDATE source_records SET source_file_id='converted-proposal' WHERE id='raw'")
    .run();
  const r = routes(f);
  const before = await r.preview({ exclude: [f.exclusion] });
  const original = before.packetReview.opaqueItems.find((item) =>
    item.key.includes('source-file:file'),
  );
  assert.ok(
    original,
    'a converted citation must offer the retained original, not merely its proposal',
  );
  const explicit = await r.preview({
    exclude: [f.exclusion],
    approvals: [{ key: original.key, fingerprint: original.fingerprint }],
  });
  assert.match(
    (await r.companion(explicit.token, 'source-file:file')).body.toString(),
    new RegExp(SECRET),
  );
  const aliasPath = 'data/profiles/cookie-dough/sources/original-alias.txt';
  writeFileSync(resolve(f.root, aliasPath), readFileSync(resolve(f.root, f.original.path)));
  f.db
    .prepare('INSERT INTO source_files(id,provider_id,path,sha256,bytes) VALUES(?,?,?,?,?)')
    .run('original-alias', 'capture', aliasPath, f.original.sha, f.original.bytes);
  f.db
    .prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?)')
    .run(
      'original-alias-asset',
      'Fictional copied original.txt',
      aliasPath,
      'text/plain',
      f.original.bytes,
      f.original.sha,
      '2026-10-01',
      'user-uploaded',
      'original-alias',
    );
  f.db
    .prepare(
      'INSERT INTO attachments(id,asset_id,owner_type,owner_id,caption,created_at) VALUES(?,?,?,?,?,?)',
    )
    .run(
      'alias-link',
      'original-alias-asset',
      'note',
      f.note.id,
      'Fictional copied report',
      '2026-10-01',
    );
  writePacketPreference(f.db, f.personId, {
    record: f.exclusion,
    alwaysWithhold: true,
    tags: [],
    expectedVersion: 0,
  });
  const blocked = await r.preview({ exclude: [f.exclusion] });
  for (const key of ['context:observation:lab-1', 'original-alias-asset']) {
    const item = blocked.packetReview.opaqueItems.find((item) => item.key.includes(key));
    assert.ok(item?.blocked, `known persistent conflict must follow ${key}`);
    await assert.rejects(
      r.preview({
        exclude: [f.exclusion],
        approvals: [{ key: item.key, fingerprint: item.fingerprint }],
      }),
      hasCode('EXPORT_DISCLOSURE_STALE'),
    );
  }
  await assert.rejects(r.companion(blocked.token, 'source-file:file'));
  await assert.rejects(r.companion(blocked.token, 'original-alias-asset'));
  assert.match(readFileSync(resolve(f.root, f.original.path), 'utf8'), new RegExp(SECRET));
});

test('several related opaque approvals from one private preview remain valid regardless of request order', async (t) => {
  const f = packetFixture(t);
  const r = routes(f);
  const selection = { exclude: [f.exclusion] };
  const first = await r.preview(selection);
  const keys = [
    'record:document:provider-note',
    'context:observation:lab-1',
    'original:source-file:file',
  ];
  const approvals = keys.map((key) => {
    const item = first.packetReview.opaqueItems.find((item) => item.key === key);
    assert.ok(item && !item.blocked);
    return { key: item.key, fingerprint: item.fingerprint };
  });
  const accepted = await r.preview({ ...selection, approvals });
  for (const key of keys)
    assert.ok(accepted.packetReview.opaqueItems.find((item) => item.key === key)?.included);
  const reordered = await r.preview({ ...selection, approvals: [...approvals].reverse() });
  for (const key of keys)
    assert.ok(reordered.packetReview.opaqueItems.find((item) => item.key === key)?.included);
  // Each HTTP approval creates its own actor/time receipt. Holding that receipt
  // constant isolates deterministic choice ordering from deliberate audit data.
  const packetApproval = { actor: 'profile-user', approvedAt: '2026-10-03T00:00:00Z' };
  const ordered = exportSnapshot(f.db, {
    ...f.input,
    packetApproval,
    packetSelection: { ...selection, approvals },
  });
  const reverse = exportSnapshot(f.db, {
    ...f.input,
    packetApproval,
    packetSelection: { ...selection, approvals: [...approvals].reverse() },
  });
  assert.equal(ordered.fingerprint, reverse.fingerprint);
  assert.match(accepted.html, /unredacted/i);
});

test('withholding freeform context preserves recorded reference ranges and the fact of a patient correction', (t) => {
  const f = packetFixture(t);
  const snapshot = exportSnapshot(f.db, {
    ...f.input,
    packetSelection: { exclude: [f.exclusion] },
  });
  const result = snapshot.records.find((record) => record.id === 'lab-1');
  assert.ok(result);
  assert.deepEqual(JSON.parse(String(result.row.reference_json)), { low: 12, high: 16 });
  assert.equal(result.fieldCorrections?.length, 1);
  assert.deepEqual(result.fieldCorrections[0].fields, ['valueText']);
  assert.equal(result.fieldCorrections[0].at, '2026-10-01T00:00:00Z');
  assert.equal(result.fieldCorrections[0].actor, 'profile-user');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
  assert.match(exportHtml(snapshot), /Corrected by/);
  assert.match(exportHtml(snapshot), /2026-10-01/);
  assert.match(JSON.stringify(exportEvidence(snapshot)), /fieldCorrections/);
});

test('explicit and legacy raw-source selectors cannot confer missing ownership or admit an unrelated original', async (t) => {
  const f = packetFixture(t);
  const foreign = createNote(f.db, { kind: 'person', title: 'Fictional Other Person' });
  f.db
    .prepare(
      "INSERT INTO source_records(id,source_file_id,provider_id,kind,label,raw_json) VALUES('foreign-assertion','file','issuer','condition','Foreign clinical assertion','{}')",
    )
    .run();
  f.db
    .prepare(
      "INSERT INTO evidence(id,entity_type,entity_id,source_record_id,role) VALUES('foreign-owner','person',?,'foreign-assertion','report_subject')",
    )
    .run(foreign.personId!);
  f.db
    .prepare(
      "INSERT INTO source_files(id,provider_id,path,sha256,bytes) VALUES('unrelated-file','capture','data/profiles/cookie-dough/sources/unrelated.txt','fictional-unrelated-hash',10)",
    )
    .run();
  const r = routes(f);
  const first = await r.preview({ exclude: [f.exclusion] });
  const note = first.packetReview.opaqueItems.find(
    (item) => item.key === `record:note:${f.note.id}`,
  )!;
  assert.ok(note);
  const scopeRejected = (error: unknown) =>
    hasCode('EXPORT_SUBJECT')(error) || hasCode('INVALID_PACKET_SELECTION')(error);
  const records = [
    { kind: 'source', recordId: 'unknown-owner' },
    { kind: 'source', recordId: 'foreign-assertion' },
    { kind: 'source_file', recordId: 'unrelated-file' },
  ];
  for (const ref of records) {
    for (const recipe of [
      {},
      { exclude: [f.exclusion] },
      { exclude: [f.exclusion], approvals: [{ key: note.key, fingerprint: note.fingerprint }] },
    ]) {
      assert.throws(
        () => exportSnapshot(f.db, { ...f.input, packetSelection: { ...recipe, include: [ref] } }),
        scopeRejected,
        `${ref.kind}:${ref.recordId} cannot acquire ownership from an include request`,
      );
    }
    assert.throws(
      () =>
        exportSnapshot(f.db, {
          type: 'note',
          id: f.note.id,
          noteVersion: f.note.version,
          mode: 'brief',
          selected: [`${ref.kind}:${ref.recordId}`],
        }),
      scopeRejected,
    );
    if (ref.kind === 'source_file') continue; // Notes support raw-source links, not source-file links.
    f.db
      .prepare('INSERT INTO note_links(id,note_id,target_type,target_id) VALUES(?,?,?,?)')
      .run('unowned-link', f.note.id, ref.kind, ref.recordId);
    assert.throws(
      () =>
        exportSnapshot(f.db, {
          type: 'note',
          id: f.note.id,
          noteVersion: f.note.version,
          mode: 'brief',
          includeLinked: true,
        }),
      scopeRejected,
    );
    f.db.prepare("DELETE FROM note_links WHERE id='unowned-link'").run();
  }
});

test('Person origins and note aliases use an identity wrapper without private profile text or excluded source citations', (t) => {
  const f = packetFixture(t);
  const personNote = f.db
    .prepare("SELECT id FROM notes WHERE person_id=? AND kind='person'")
    .get(f.personId)!;
  f.db
    .prepare(
      "UPDATE notes SET content=?,topics=?,raw_thoughts=?,source_record_id='sensitive-condition' WHERE id=?",
    )
    .run(SECRET, SECRET, SECRET, String(personNote.id));
  f.db
    .prepare("UPDATE source_records SET locator_json=? WHERE id='sensitive-condition'")
    .run(JSON.stringify({ path: SECRET }));
  for (const origin of [
    { type: 'note', id: String(personNote.id) },
    { type: 'person', id: f.personId },
  ]) {
    const options = exportOptions(f.db, origin);
    const snapshot = exportSnapshot(f.db, {
      ...origin,
      noteVersion: options.noteVersion,
      mode: 'provider',
      packetSelection: { exclude: [f.exclusion] },
    });
    assert.doesNotMatch(exportHtml(snapshot), new RegExp(`${SECRET}|sensitive-condition`));
    assert.doesNotMatch(
      JSON.stringify(exportEvidence(snapshot)),
      new RegExp(`${SECRET}|sensitive-condition`),
    );
    assert.deepEqual(snapshot.main.citations, []);
  }
  assert.equal(
    f.db.prepare('SELECT content FROM notes WHERE id=?').get(String(personNote.id))?.content,
    SECRET,
  );
});

test('a personal medication confirmation cannot replace a missing clinical date in a date filter', (t) => {
  const f = packetFixture(t);
  f.db.prepare("UPDATE medications SET start_at=NULL,end_at=NULL WHERE id='current-med'").run();
  const medication = exportOptions(f.db, {
    type: 'person',
    id: f.personId,
  }).packet!.candidates.find((item) => item.key === 'medication:current-med');
  assert.equal(medication?.date, null);
  assert.equal(medication?.dateBasis, 'undated');
  const dateWindow = { kinds: ['medication'], from: '2026-09-01', to: '2026-09-01' };
  const filtered = exportSnapshot(f.db, { ...f.input, packetSelection: dateWindow });
  assert.ok(!filtered.records.some((record) => record.id === 'current-med'));
  assert.ok(filtered.packetReview!.withheld.some((item) => item.key === 'medication:current-med'));
  const explicit = exportSnapshot(f.db, {
    ...f.input,
    packetSelection: { ...dateWindow, include: [{ kind: 'medication', recordId: 'current-med' }] },
  });
  assert.ok(explicit.records.some((record) => record.id === 'current-med'));
  assert.equal(
    f.db
      .prepare("SELECT updated_at FROM medication_preferences WHERE medication_id='current-med'")
      .get()?.updated_at,
    '2026-09-01',
  );
});

test('private consent inspection includes every shared note section and correction history outside the clinical row', async (t) => {
  const f = packetFixture(t);
  f.db
    .prepare('UPDATE notes SET content=?,topics=?,raw_thoughts=? WHERE id=?')
    .run('Fictional ordinary agenda', `${SECRET}-topics`, `${SECRET}-thoughts`, f.note.id);
  f.db
    .prepare(
      "INSERT INTO manual_batches(id,title,status,created_at,coverage_json,notes) VALUES('fictional-owner-correction','Record ownership event','verified','2026-10-01',?,?)",
    )
    .run(
      JSON.stringify({
        operationId: 'fictional-owner-operation',
        kind: 'observation',
        destinationRecordId: 'lab-1',
        action: 'move',
        fromPersonId: 'fictional-prior-person',
        fromPersonName: 'Fictional Prior Person',
        toPersonId: f.personId,
      }),
      `${SECRET}-ownership-reason`,
    );
  const r = routes(f);
  const first = await r.preview({ exclude: [f.exclusion] });
  const note = first.packetReview.opaqueItems.find(
    (item) => item.key === `record:note:${f.note.id}`,
  )!;
  assert.ok(note);
  assert.match(note.text || '', new RegExp(`${SECRET}-topics`));
  assert.match(note.text || '', new RegExp(`${SECRET}-thoughts`));
  const context = first.packetReview.opaqueItems.find(
    (item) => item.key === 'context:observation:lab-1',
  )!;
  assert.ok(context);
  assert.match(context.text || '', new RegExp(`${SECRET}-ownership-reason`));
  assert.match(context.text || '', /ownershipCorrections/);
  const approved = await r.preview({
    exclude: [f.exclusion],
    approvals: [
      { key: note.key, fingerprint: note.fingerprint },
      { key: context.key, fingerprint: context.fingerprint },
    ],
  });
  const evidence = (await r.call(approved.token, 'evidence')).body.toString();
  for (const suffix of ['topics', 'thoughts', 'ownership-reason'])
    assert.match(evidence, new RegExp(`${SECRET}-${suffix}`));
});

test('long private inspection is complete, token scoped and stale checked before unredacted consent', async (t) => {
  const f = packetFixture(t);
  f.db
    .prepare('UPDATE notes SET content=? WHERE id=?')
    .run(`${'Fictional ordinary context. '.repeat(1100)}${SECRET}-tail`, f.note.id);
  const r = routes(f);
  const first = await r.preview({ exclude: [f.exclusion] });
  const note = first.packetReview.opaqueItems.find(
    (item) => item.key === `record:note:${f.note.id}`,
  )!;
  assert.ok(note?.truncated);
  assert.doesNotMatch(note.text || '', new RegExp(`${SECRET}-tail`));
  assert.match(note.contentUrl || '', new RegExp(`/note-exports/${first.token}/inspection`));
  const inspected = await r.inspection(first.token, note.key);
  assert.match(inspected.headers['Content-Type'], /application\/json/);
  assert.match(inspected.body.toString(), new RegExp(`${SECRET}-tail`));
  assert.doesNotThrow(() => JSON.parse(inspected.body.toString()));
  await assert.rejects(
    r.inspection(first.token, note.key, { profileId: 'other' }),
    hasCode('EXPORT_EXPIRED'),
  );
  await assert.rejects(r.inspection(first.token, 'record:source:unknown-owner'));
  const approved = await r.preview({
    exclude: [f.exclusion],
    approvals: [{ key: note.key, fingerprint: note.fingerprint }],
  });
  assert.match(
    (await r.call(approved.token, 'evidence')).body.toString(),
    new RegExp(`${SECRET}-tail`),
  );
  f.db.prepare('UPDATE notes SET content=? WHERE id=?').run('Fictional changed agenda', f.note.id);
  await assert.rejects(r.inspection(first.token, note.key), hasCode('EXPORT_STALE'));
});

test('selective packets preserve generic incomplete-reading and incomplete-review notices without private titles or counts', async (t) => {
  const f = packetFixture(t);
  f.db.prepare("UPDATE source_files SET details_json=? WHERE id='file'").run(
    JSON.stringify({
      intake: {
        originalName: SECRET,
        workflow: {
          plans: [
            {
              status: 'active',
              batches: [],
              units: [
                {
                  id: 'fictional-unread',
                  locator: `${SECRET}-locator`,
                  status: 'pending',
                  processingException: { reason: 'processing_stalled', at: '2026-10-01' },
                },
              ],
            },
          ],
          candidates: [
            { id: 'reviewed', versions: [{ id: 'reviewed-v1', status: 'accepted' }] },
            { id: 'pending', versions: [{ id: 'pending-v1', status: 'pending' }] },
          ],
          reportGroups: [
            {
              id: 'private-report',
              basis: 'report_anchor',
              versions: [
                {
                  title: SECRET,
                  members: [
                    {
                      candidateId: 'reviewed',
                      candidateVersionId: 'reviewed-v1',
                      occurrences: [{ recordId: 'raw' }],
                    },
                    { candidateId: 'pending', candidateVersionId: 'pending-v1', occurrences: [] },
                  ],
                },
              ],
            },
          ],
        },
      },
    }),
  );
  const before = exportSnapshot(f.db, f.input);
  assert.equal(before.reportReview[0]?.savedCount, 1);
  assert.equal(before.reportReview[0]?.totalCount, 2);
  assert.ok(before.readingGaps.length > 0);
  const r = routes(f);
  const selected = await r.preview({ exclude: [f.exclusion] });
  const evidence = (await r.call(selected.token, 'evidence')).body.toString();
  const parsed = JSON.parse(evidence);
  assert.equal(parsed.sourceReadingIncomplete, true);
  assert.equal(parsed.sourceReviewIncomplete, true);
  assert.deepEqual(parsed.readingGaps, []);
  assert.deepEqual(parsed.reportReview, []);
  assert.doesNotMatch(evidence, new RegExp(`${SECRET}|private-report|savedCount|totalCount`));
  const text = await pdfText((await r.call(selected.token, 'pdf')).body);
  for (const shared of [selected.html, text]) {
    assert.match(shared, /items awaiting review/);
    assert.match(shared, /not fully read/);
    assert.match(shared, /separate from records left out/);
    assert.doesNotMatch(shared, new RegExp(`${SECRET}|1 of 2`));
  }
});

test('saving one packet preference through HTTP does bounded reads independent of the clinical collection size', async (t) => {
  const samples: Array<{ kind: string; queries: number; rows: number }> = [];
  for (const size of [20, 600]) {
    const f = packetFixture(t);
    const insert = f.db.prepare(
      "INSERT INTO observations(id,test_type_id,person_id,source_record_id,label,value_text) VALUES(?,'cbc',?,'raw','Fictional additional result','5')",
    );
    for (let index = 0; index < size; index++) insert.run(`fictional-extra-${index}`, f.personId);
    const original = f.db.prepare.bind(f.db);
    let queries = 0,
      rows = 0;
    Object.defineProperty(f.db, 'prepare', {
      configurable: true,
      value: (sql: string) => {
        const statement = original(sql);
        return new Proxy(statement, {
          get(target, key) {
            const method = Reflect.get(target, key);
            if (typeof method !== 'function') return method;
            return (...args: unknown[]) => {
              const result = Reflect.apply(method, target, args);
              if ((key === 'get' || key === 'all') && /^\s*SELECT\b/i.test(sql)) {
                queries++;
                rows += Array.isArray(result) ? result.length : result === undefined ? 0 : 1;
              }
              return result;
            };
          },
        });
      },
    });
    try {
      const r = routes(f);
      for (const record of [
        { kind: 'note', recordId: f.note.id },
        { kind: 'observation', recordId: 'lab-1' },
      ]) {
        queries = 0;
        rows = 0;
        const saved = (
          await r.call('preferences', undefined, {
            ...f.input,
            personId: f.personId,
            record,
            alwaysWithhold: true,
            tags: [],
            expectedVersion: 0,
          })
        ).response as { alwaysWithhold: boolean };
        assert.equal(saved.alwaysWithhold, true);
        samples.push({ kind: record.kind, queries, rows });
      }
    } finally {
      Object.defineProperty(f.db, 'prepare', { configurable: true, value: original });
    }
  }
  assert.deepEqual(
    samples.slice(2),
    samples.slice(0, 2),
    'one-record preference saves must not reread a growing packet inventory',
  );
  for (const sample of samples) assert.ok(sample.queries > 0 && sample.rows > 0);
});

test('a factored same-provider context reference carries persistent withholding across distinct original files', async (t) => {
  const f = packetFixture(t);
  isolateSensitiveOriginal(f);
  const r = routes(f);
  const unrelated = await r.preview({});
  assert.equal(
    unrelated.packetReview.opaqueItems.find((item) => item.key === 'context:observation:lab-1')
      ?.blocked,
    false,
    'separate files with no retained relationship are not a known conflict',
  );
  f.db
    .prepare(
      "INSERT INTO source_records(id,source_file_id,provider_id,kind,raw_json) VALUES('capture:context:c1','context-original','capture','context',?)",
    )
    .run(JSON.stringify({ data: { literal: SECRET } }));
  f.db
    .prepare("UPDATE source_records SET kind='source_capture',raw_json=? WHERE id='raw'")
    .run(JSON.stringify({ content: { $health_archive_ref: 'context:c1' } }));
  const linked = await r.preview({});
  for (const key of ['context:observation:lab-1', 'original:source-file:context-original']) {
    const item = linked.packetReview.opaqueItems.find((item) => item.key === key);
    assert.ok(item?.blocked, `retained factored context must establish ${key} conflict`);
    await assert.rejects(
      r.preview({ approvals: [{ key: item.key, fingerprint: item.fingerprint }] }),
      hasCode('EXPORT_DISCLOSURE_STALE'),
    );
  }
  await assert.rejects(r.companion(linked.token, 'source-file:context-original'));
  assert.doesNotMatch((await r.call(linked.token, 'evidence')).body.toString(), new RegExp(SECRET));
  assert.equal(
    f.db.prepare("SELECT raw_json FROM source_records WHERE id='capture:context:c1'").get()
      ?.raw_json,
    JSON.stringify({ data: { literal: SECRET } }),
  );
});

test('only accepted source relationships establish a persistent shared-context conflict, in either direction', async (t) => {
  const f = packetFixture(t);
  isolateSensitiveOriginal(f);
  const r = routes(f);
  f.db
    .prepare(
      "INSERT INTO record_relationships(id,from_record_id,to_record_id,relation,status,rationale) VALUES('fictional-shared-context','raw','sensitive-condition','reviewed_context','proposed','Fictional source relationship')",
    )
    .run();
  for (const status of ['proposed', 'rejected']) {
    f.db
      .prepare("UPDATE record_relationships SET status=? WHERE id='fictional-shared-context'")
      .run(status);
    const preview = await r.preview({});
    assert.equal(
      preview.packetReview.opaqueItems.find((item) => item.key === 'context:observation:lab-1')
        ?.blocked,
      false,
    );
  }
  for (const [from, to] of [
    ['raw', 'sensitive-condition'],
    ['sensitive-condition', 'raw'],
  ]) {
    f.db
      .prepare(
        "UPDATE record_relationships SET status='accepted',from_record_id=?,to_record_id=? WHERE id='fictional-shared-context'",
      )
      .run(from, to);
    const preview = await r.preview({});
    const item = preview.packetReview.opaqueItems.find(
      (item) => item.key === 'context:observation:lab-1',
    );
    assert.ok(item?.blocked);
    await assert.rejects(
      r.preview({ approvals: [{ key: item.key, fingerprint: item.fingerprint }] }),
      hasCode('EXPORT_DISCLOSURE_STALE'),
    );
    assert.doesNotMatch(
      (await r.call(preview.token, 'evidence')).body.toString(),
      new RegExp(SECRET),
    );
  }
});

test('factored dependency markers use the exact archive protocol and fail closed on missing or malformed same-provider references', async (t) => {
  const f = packetFixture(t);
  isolateSensitiveOriginal(f);
  const r = routes(f);
  const setRaw = (raw: unknown, kind = 'source_capture') =>
    f.db
      .prepare("UPDATE source_records SET kind=?,raw_json=? WHERE id='raw'")
      .run(kind, JSON.stringify(raw));
  // Literal strings and ordinary objects that merely contain the marker name
  // are not protocol references, matching the retained archive view contract.
  for (const content of [
    'context:c404',
    { $health_archive_ref: 'context:c404', literal: 'ordinary object' },
  ]) {
    setRaw({ content });
    const preview = await r.preview({});
    assert.equal(
      preview.packetReview.opaqueItems.find((item) => item.key === 'context:observation:lab-1')
        ?.blocked,
      false,
    );
  }
  setRaw({ content: { $health_archive_ref: 'context:c404' } }, 'clinical_object');
  await r.preview({}); // Arbitrary clinical JSON cannot declare a factored archive.
  setRaw({ content: { $health_archive_ref: 'context:c404' } });
  await assert.rejects(r.preview({}), hasCode('EXPORT_SOURCE_MISSING'));
  for (const value of ['unknown:thing', 42, null]) {
    setRaw({ content: { $health_archive_ref: value } });
    await assert.rejects(r.preview({}), hasCode('INVALID_ARCHIVE_REFERENCE'));
  }
  f.db
    .prepare(
      "INSERT INTO source_records(id,source_file_id,provider_id,kind,raw_json) VALUES('capture:context:c404','context-original','issuer','context','{\"data\":{}}')",
    )
    .run();
  setRaw({ content: { $health_archive_ref: 'context:c404' } });
  await assert.rejects(r.preview({}), hasCode('INVALID_ARCHIVE_REFERENCE'));
});

for (const ancestry of ['originalSourceFileId', 'parentSourceFileId'] as const)
  for (const duplicate of [false, true])
    test(`persistent original withholding follows asset ${ancestry} ancestry${duplicate ? ' through a first-sorting unparented duplicate' : ''}`, async (t) => {
      const f = packetFixture(t);
      const childPath = 'data/profiles/cookie-dough/sources/child-source.txt';
      const childBytes = 'Fictional harmless converted copy';
      writeFileSync(resolve(f.root, childPath), childBytes);
      const metadata =
        ancestry === 'originalSourceFileId'
          ? { originalSourceFileId: 'file' }
          : { intake: { parentSourceFileId: 'file' } };
      f.db
        .prepare(
          'INSERT INTO source_files(id,provider_id,path,sha256,bytes,details_json) VALUES(?,?,?,?,?,?)',
        )
        .run(
          'child-source',
          'capture',
          childPath,
          createHash('sha256').update(childBytes).digest('hex'),
          Buffer.byteLength(childBytes),
          JSON.stringify(metadata),
        );
      f.db.prepare("UPDATE assets SET source_file_id='child-source' WHERE id='safe-asset'").run();
      let representative = 'safe-asset';
      if (duplicate) {
        representative = 'aaa-unparented-alias';
        const aliasPath = 'data/profiles/cookie-dough/attachments/first-alias.txt';
        writeFileSync(
          resolve(f.root, aliasPath),
          readFileSync(resolve(f.root, f.safeAttachment.path)),
        );
        f.db
          .prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,NULL)')
          .run(
            representative,
            'Fictional identical copy.txt',
            aliasPath,
            'text/plain',
            f.safeAttachment.bytes,
            f.safeAttachment.sha,
            '2026-10-01',
            'user-uploaded',
          );
        f.db
          .prepare(
            'INSERT INTO attachments(id,asset_id,owner_type,owner_id,caption,created_at) VALUES(?,?,?,?,?,?)',
          )
          .run(
            'first-alias-link',
            representative,
            'observation',
            'lab-1',
            'Fictional copied original',
            '2026-10-01',
          );
      }
      const r = routes(f);
      await r.call('preferences', undefined, {
        ...f.input,
        personId: f.personId,
        record: { kind: 'source_file', recordId: 'file' },
        alwaysWithhold: true,
        tags: [],
        expectedVersion: 0,
      });
      const preview = await r.preview({});
      for (const key of [`original:${representative}`, 'original:source-file:child-source']) {
        const item = preview.packetReview.opaqueItems.find((item) => item.key === key);
        assert.ok(item?.blocked, `${key} must retain every known ancestor conflict`);
        await assert.rejects(
          r.preview({ approvals: [{ key: item.key, fingerprint: item.fingerprint }] }),
          hasCode('EXPORT_DISCLOSURE_STALE'),
        );
      }
      if (duplicate)
        assert.ok(
          !preview.packetReview.opaqueItems.some((item) => item.key === 'original:safe-asset'),
          'the tested representative must be the unparented alias',
        );
      await assert.rejects(r.companion(preview.token, representative));
      assert.equal(
        readFileSync(resolve(f.root, f.safeAttachment.path), 'utf8'),
        'Fictional safe companion bytes',
      );
    });

for (const ancestry of ['originalSourceFileId', 'parentSourceFileId'] as const)
  test(`a saved parent-original preference survives conversion through ${ancestry} after all direct sources move`, async (t) => {
    const f = packetFixture(t);
    const r = routes(f);
    await r.call('preferences', undefined, {
      ...f.input,
      personId: f.personId,
      record: { kind: 'source_file', recordId: 'file' },
      alwaysWithhold: true,
      tags: [],
      expectedVersion: 0,
    });
    const path = 'data/profiles/cookie-dough/sources/converted-membership.txt';
    const content = `Fictional converted source ${SECRET}`;
    writeFileSync(resolve(f.root, path), content);
    const metadata =
      ancestry === 'originalSourceFileId'
        ? { originalSourceFileId: 'file' }
        : { intake: { parentSourceFileId: 'file' } };
    f.db
      .prepare(
        'INSERT INTO source_files(id,provider_id,path,sha256,bytes,details_json) VALUES(?,?,?,?,?,?)',
      )
      .run(
        'converted-membership',
        'capture',
        path,
        createHash('sha256').update(content).digest('hex'),
        Buffer.byteLength(content),
        JSON.stringify(metadata),
      );
    f.db.prepare("UPDATE source_records SET source_file_id='converted-membership'").run();
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM source_records WHERE source_file_id='file'").get()?.n,
      0,
    );
    const options = exportOptions(f.db, { type: 'person', id: f.personId });
    const parent = options.packet!.candidates.find((item) => item.key === 'source_file:file');
    assert.ok(
      parent?.alwaysWithhold,
      'the retained parent remains a selectable, changeable preference target',
    );
    assert.equal(parent.preferenceVersion, 1);
    const preview = await r.preview({});
    assert.ok(preview.packetReview.withheld.some((item) => item.key === 'source_file:file'));
    const child = preview.packetReview.opaqueItems.find(
      (item) => item.key === 'original:source-file:converted-membership',
    );
    assert.ok(child?.blocked);
    await assert.rejects(
      r.preview({ approvals: [{ key: child.key, fingerprint: child.fingerprint }] }),
      hasCode('EXPORT_DISCLOSURE_STALE'),
    );
    assert.doesNotMatch(
      (await r.call(preview.token, 'evidence')).body.toString(),
      new RegExp(SECRET),
    );
    assert.match(preview.html, notice);
    const changed = (
      await r.call('preferences', undefined, {
        ...f.input,
        personId: f.personId,
        record: { kind: 'source_file', recordId: 'file' },
        alwaysWithhold: false,
        tags: [],
        expectedVersion: 1,
      })
    ).response as { alwaysWithhold: boolean; version: number };
    assert.equal(changed.alwaysWithhold, false);
    assert.equal(changed.version, 2);
  });

test('an original reachable only through an owned attachment is offered and supports the same saved preference route', async (t) => {
  const f = packetFixture(t);
  const path = 'data/profiles/cookie-dough/sources/attachment-only-original.txt';
  const content = 'Fictional attachment provenance original';
  writeFileSync(resolve(f.root, path), content);
  f.db
    .prepare('INSERT INTO source_files(id,provider_id,path,sha256,bytes) VALUES(?,?,?,?,?)')
    .run(
      'attachment-only-original',
      'capture',
      path,
      createHash('sha256').update(content).digest('hex'),
      Buffer.byteLength(content),
    );
  f.db
    .prepare("UPDATE assets SET source_file_id='attachment-only-original' WHERE id='safe-asset'")
    .run();
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM source_records WHERE source_file_id='attachment-only-original'",
      )
      .get()?.n,
    0,
  );
  const options = exportOptions(f.db, { type: 'person', id: f.personId });
  assert.ok(
    options.packet!.candidates.some((item) => item.key === 'source_file:attachment-only-original'),
  );
  const r = routes(f);
  const saved = (
    await r.call('preferences', undefined, {
      ...f.input,
      personId: f.personId,
      record: { kind: 'source_file', recordId: 'attachment-only-original' },
      alwaysWithhold: true,
      tags: [],
      expectedVersion: 0,
    })
  ).response as { alwaysWithhold: boolean };
  assert.equal(saved.alwaysWithhold, true);
  const preview = await r.preview({});
  assert.ok(
    preview.packetReview.withheld.some(
      (item) => item.key === 'source_file:attachment-only-original',
    ),
  );
  const original = preview.packetReview.opaqueItems.find(
    (item) => item.key === 'original:safe-asset',
  );
  assert.ok(original?.blocked);
  await assert.rejects(
    r.preview({ approvals: [{ key: original.key, fingerprint: original.fingerprint }] }),
    hasCode('EXPORT_DISCLOSURE_STALE'),
  );
});

test('authored note date metadata distinguishes last modification from event date while preserving filtering and explicit inclusion', async (t) => {
  const f = packetFixture(t);
  const undated = createNote(f.db, {
    title: 'Fictional undated agenda',
    content: 'Fictional undated agenda content',
  });
  const dated = createNote(f.db, {
    title: 'Fictional dated visit',
    content: 'Fictional dated visit content',
  });
  f.db
    .prepare('UPDATE notes SET event_date=?,updated_at=? WHERE id=?')
    .run(null, '2026-09-15T12:00:00Z', undated.id);
  f.db
    .prepare('UPDATE notes SET event_date=?,updated_at=? WHERE id=?')
    .run('2026-08-01', '2026-09-15T12:00:00Z', dated.id);
  const candidates = exportOptions(f.db, { type: 'person', id: f.personId }).packet!.candidates;
  const undatedCandidate = candidates.find((item) => item.record.recordId === undated.id)!;
  const datedCandidate = candidates.find((item) => item.record.recordId === dated.id)!;
  assert.equal(undatedCandidate.date, '2026-09-15T12:00:00Z');
  assert.equal(undatedCandidate.dateBasis, 'note-last-modified');
  assert.equal(datedCandidate.date, '2026-08-01');
  assert.equal(datedCandidate.dateBasis, 'event');
  const r = routes(f);
  const selection = { kinds: ['note'], from: '2026-09-01', to: '2026-09-30' };
  const extra = { noteIds: [undated.id, dated.id] };
  const first = await r.preview(selection, extra);
  const undatedReview = first.packetReview.opaqueItems.find(
    (item) => item.key === `record:note:${undated.id}`,
  );
  assert.ok(undatedReview, 'the last-modified date admits an undated note to private text review');
  assert.ok(
    first.packetReview.withheld.some(
      (item) => item.key === `note:${dated.id}` && /Date window/.test(item.reason),
    ),
  );
  assert.ok(!first.packetReview.opaqueItems.some((item) => item.key === `record:note:${dated.id}`));
  const approved = await r.preview(
    {
      ...selection,
      approvals: [{ key: undatedReview.key, fingerprint: undatedReview.fingerprint }],
    },
    extra,
  );
  const shared = JSON.parse((await r.call(approved.token, 'evidence')).body.toString()) as {
    records: Array<{ id: string }>;
  };
  assert.ok(shared.records.some((item) => item.id === undated.id));
  assert.ok(!shared.records.some((item) => item.id === dated.id));
  const explicitSelection = { ...selection, include: [{ kind: 'note', recordId: dated.id }] };
  const explicit = await r.preview(explicitSelection, extra);
  const datedReview = explicit.packetReview.opaqueItems.find(
    (item) => item.key === `record:note:${dated.id}`,
  );
  assert.ok(datedReview, 'individual inclusion overrides the event-date category filter');
  const approvedExplicit = await r.preview(
    {
      ...explicitSelection,
      approvals: [{ key: datedReview.key, fingerprint: datedReview.fingerprint }],
    },
    extra,
  );
  const explicitShared = JSON.parse(
    (await r.call(approvedExplicit.token, 'evidence')).body.toString(),
  ) as { records: Array<{ id: string; date: string }> };
  assert.equal(explicitShared.records.find((item) => item.id === dated.id)?.date, '2026-08-01');
});
