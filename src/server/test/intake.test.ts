import test from 'node:test';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpError, openDatabase } from '../database.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import {
  uploadIntake,
  getIntake,
  getIntakeOriginal,
  listIntakes,
  readIntake,
  proposeConversion,
  importIntake,
  intakeDurability,
  flushIntake,
} from '../intake.ts';
import { validateJSONL, parseLiteralJSON, canonicalLiteral } from '../intake-format.ts';
import { rebuildProfile } from '../portable.ts';
import { createBackup, restoreBackup } from '../recovery.ts';
import { createApp } from '../index.ts';
const line = (
  id = 'test-one',
  payload = '{"value":1.000,"large":123456789012345678901,"date":"2026-09","literal":{"$health_archive_ref":"records:r1"}}',
  status = 'unknown',
) =>
  `{"format":"health-record-v1","id":${JSON.stringify(id)},"kind":"record","payload":${payload},"provenance":{"capturedVia":"Kaiser via Health","sourceSystem":null,"sourceRecordId":null,"evidenceClass":"health_response","locator":"response/items/0"},"coverage":{"status":"${status}","notes":["Source coverage remains unknown"]},"extra":{"unmapped":true}}`;
function fixture(t: TestContext, profileId = 'orchid') {
  const root = mkdtempSync(resolve(tmpdir(), 'health-intake-'));
  const paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId);
  db.prepare('INSERT INTO providers(id,name) VALUES(?,?)').run('issuer', 'Example source');
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, paths, db, profileId };
}
const upload = (
  f: ReturnType<typeof fixture>,
  bytes = Buffer.from(line()),
  input: Partial<Parameters<typeof uploadIntake>[3]> = {},
  options?: Parameters<typeof uploadIntake>[4],
) =>
  uploadIntake(
    f.db,
    f.root,
    f.profileId,
    { filename: 'report.jsonl', providerId: 'issuer', bytes, ...input },
    options,
  );

test('JSONL requires provenance, rejects duplicate keys, and preserves number spelling and literal references', () => {
  const a = line(),
    b = line('test-one', '{"value":1.0}');
  const result = validateJSONL(Buffer.from(a + '\r\n' + a + '\n' + b));
  assert.equal(result.valid, true);
  assert.equal(result.rows, 3);
  assert.equal(result.exactRepeatedRows, 1);
  assert.equal(result.partialRows, 3);
  assert.equal(result.entries[0].raw, a);
  assert.match(canonicalLiteral(parseLiteralJSON(a)), /123456789012345678901/);
  assert.match(canonicalLiteral(parseLiteralJSON(a)), /1\.000/);
  assert.throws(() => parseLiteralJSON('{"a":1,"a":2}'), /Duplicate JSON key/);
  assert.throws(() => parseLiteralJSON('{"a":1,"\\u0061":2}'), /Duplicate JSON key/);
  assert.equal(validateJSONL(Buffer.from('{"id":"x","payload":null}')).valid, false);
  assert.equal(validateJSONL(Buffer.from(line() + '\ninvalid trailing data')).valid, false);
  assert.equal(validateJSONL(Buffer.from([255, 0])).valid, false);
});

test('uploads preserve exact originals; repeated uploads/imports are idempotent and source versions stay separate', async (t) => {
  const f = fixture(t),
    original = Buffer.from(line() + '\r\n' + line() + '\n');
  let result = upload(f, original);
  assert.equal(result.state, 'ready');
  assert.equal(result.durability.pending, false);
  const before = f.db.prepare('SELECT COUNT(*) n FROM source_files').get()!.n;
  const repeated = upload(f, original);
  assert.equal(repeated.repeatedUpload, true);
  assert.equal(repeated.id, result.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM source_files').get()!.n, before);
  assert.deepEqual(getIntakeOriginal(f.db, f.root, f.profileId, result.id).bytes, original);
  const importedResult = importIntake(f.db, f.root, f.profileId, result.id, {
    version: result.version,
  });
  assert.ok(importedResult.imported);
  assert.deepEqual(importedResult.imported, {
    records: 2,
    repeatedRows: 1,
    matchingEarlierRows: 0,
    at: importedResult.imported.at,
    fileId: importedResult.id,
  });
  const records = f.db.prepare('SELECT raw_json FROM source_records ORDER BY id').all();
  assert.equal(records.length, 2);
  assert.equal(records[0]!.raw_json, line());
  assert.equal(
    importIntake(f.db, f.root, f.profileId, importedResult.id, { version: 1 }).version,
    importedResult.version,
  );
  const changed = upload(f, Buffer.from(line('test-one', '{"value":2}')));
  assert.notEqual(changed.id, importedResult.id);
  const anotherName = upload(f, original, { filename: 'another-copy.jsonl' });
  const copyImport = importIntake(f.db, f.root, f.profileId, anotherName.id, {
    version: anotherName.version,
  });
  assert.ok(copyImport.imported);
  assert.equal(copyImport.imported.matchingEarlierRows, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM observations').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM medications').get()!.n, 0);
  const receipt = await createBackup(f.db, f.root, f.profileId);
  const rebuilt = rebuildProfile(
    resolve(receipt.path, 'files'),
    f.profileId,
    resolve(f.root, 'rebuilt'),
  );
  const db = openDatabase(rebuilt.database, f.profileId);
  const rebuiltIntake = getIntake(db, resolve(f.root, 'rebuilt'), f.profileId, importedResult.id);
  assert.ok(rebuiltIntake.imported);
  assert.equal(rebuiltIntake.imported.records, 2);
  assert.equal(
    db
      .prepare('SELECT raw_json FROM source_records ORDER BY id')
      .all()
      .filter((r) => r.raw_json === line()).length,
    4,
  );
  assert.equal(intakeDurability(db).pending, false);
  db.close();
  restoreBackup(receipt.path, resolve(f.root, 'restored'));
  assert.ok(existsSync(profilePaths(resolve(f.root, 'restored'), f.profileId).database));
});

test('binary originals stay pending; bounded conversion proposals require review and stale versions cannot replace them', (t) => {
  const f = fixture(t),
    bytes = Buffer.from('%PDF-1.4\noriginal scan');
  const original = upload(f, bytes, { filename: 'original.pdf' });
  assert.equal(original.state, 'pending_conversion');
  assert.equal(readIntake(f.db, f.root, f.profileId, original.id).text, null);
  assert.throws(
    () => importIntake(f.db, f.root, f.profileId, original.id, { version: 1 }),
    (e: unknown) => e instanceof HttpError && e.code === 'INVALID_JSONL',
  );
  assert.throws(
    () =>
      proposeConversion(f.db, f.root, f.profileId, original.id, {
        version: 1,
        jsonlText: '{}',
        summary: 'Invalid',
      }),
    (e: unknown) => e instanceof HttpError && e.code === 'INVALID_JSONL',
  );
  let proposal = proposeConversion(f.db, f.root, f.profileId, original.id, {
    version: 1,
    jsonlText: line('scan', '"Uncertain reading from page 1"', 'partial'),
    summary: 'Page 1 transcription; remaining pages unreviewed',
    runId: 'run-1',
  });
  assert.equal(proposal.state, 'conversion_proposed');
  assert.equal(proposal.proposals[0].validation.partialRows, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM source_records').get()!.n, 0);
  assert.throws(
    () =>
      importIntake(f.db, f.root, f.profileId, original.id, {
        version: 1,
        proposalId: proposal.proposals[0].id,
      }),
    (e: unknown) => e instanceof HttpError && e.code === 'VERSION_CONFLICT',
  );
  assert.equal(
    proposeConversion(f.db, f.root, f.profileId, original.id, {
      version: 1,
      jsonlText: line('scan', '"Uncertain reading from page 1"', 'partial'),
      summary: 'Retry',
    }).version,
    proposal.version,
  );
  proposal = importIntake(f.db, f.root, f.profileId, original.id, {
    version: proposal.version,
    proposalId: proposal.proposals[0].id,
  });
  assert.ok(proposal.imported);
  assert.equal(proposal.imported.records, 1);
  assert.deepEqual(getIntakeOriginal(f.db, f.root, f.profileId, original.id).bytes, bytes);
  assert.equal(
    f.db.prepare('SELECT extraction_status FROM source_records').get()!.extraction_status,
    'retained_unprojected',
  );
});

test('pending curation publication is recoverable and source changes or profile escapes are rejected', (t) => {
  const f = fixture(t),
    fail = {
      exportFn() {
        throw new Error('Disk unavailable');
      },
    };
  const result = upload(f, undefined, {}, fail);
  assert.equal(result.durability.pending, true);
  assert.match(result.durability.error ?? '', /Disk unavailable/);
  assert.equal(listIntakes(f.db, f.profileId).intakeDurability.pending, true);
  assert.equal(flushIntake(f.db, f.root, f.profileId).pending, false);
  assert.throws(
    () => getIntake(f.db, f.root, 'cedar', result.id),
    (e: unknown) => e instanceof HttpError && e.code === 'PROFILE_BOUNDARY',
  );
  const original = getIntakeOriginal(f.db, f.root, f.profileId, result.id);
  writeFileSync(original.path, 'changed');
  assert.throws(
    () => importIntake(f.db, f.root, f.profileId, result.id, { version: 1 }),
    (e: unknown) => e instanceof HttpError && e.code === 'SOURCE_CHANGED',
  );
  const elsewhere = ensureProfileDirectories(f.root, 'cedar');
  const sourcePath = resolve(f.paths.sources, 'linked');
  symlinkSync(elsewhere.sources, sourcePath);
  f.db.prepare("INSERT INTO providers(id,name) VALUES('linked','Linked')").run();
  const before = readdirSync(elsewhere.sources);
  assert.throws(
    () => upload(f, Buffer.from(line()), { providerId: 'linked' }),
    (e: unknown) => e instanceof HttpError && e.code === 'PROFILE_BOUNDARY',
  );
  assert.deepEqual(
    readdirSync(elsewhere.sources),
    before,
    'Reject the link before creating directories in the other profile',
  );
});

test('text pagination never claims a partial slice is the entire source and new sources stay profile local', (t) => {
  const f = fixture(t);
  const result = upload(f, Buffer.from('abcdefghij'), {
    providerId: '',
    newProviderName: 'New clinic',
    filename: 'notes.txt',
  });
  const first = readIntake(f.db, f.root, f.profileId, result.id, { limit: 4 });
  assert.equal(first.text, 'abcd');
  assert.equal(first.complete, false);
  assert.equal(first.nextOffset, 4);
  const last = readIntake(f.db, f.root, f.profileId, result.id, { offset: 8, limit: 4 });
  assert.equal(last.text, 'ij');
  assert.equal(last.complete, false);
  assert.equal(last.nextOffset, null);
  assert.equal(readIntake(f.db, f.root, f.profileId, result.id).complete, true);
  assert.equal(result.provider, 'New clinic');
});

test('HTTP intake upload, preview and import honor origin and profile scope', async (t) => {
  const f = fixture(t),
    app = createApp({ root: f.root, databases: new Map([[f.profileId, f.db]]) });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => app.server.close(() => resolve())));
  const address = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}/api/profiles/orchid/intakes`;
  let response = await fetch(base, {
    method: 'POST',
    body: line(),
    headers: { 'Content-Type': 'application/x-ndjson', 'X-Source-Id': 'issuer' },
  });
  assert.equal(response.status, 403);
  const origin = 'http://127.0.0.1:5173';
  response = await fetch(base, {
    method: 'POST',
    body: line(),
    headers: {
      Origin: origin,
      'Content-Type': 'application/x-ndjson',
      'X-Source-Id': 'issuer',
      'X-Filename': 'new.jsonl',
    },
  });
  assert.equal(response.status, 201);
  const intake = (await response.json()).data;
  assert.match(intake.contentUrl, /^\/api\/profiles\/orchid\/sources\//);
  assert.equal(
    (await (await fetch(`${base}/${encodeURIComponent(intake.id)}/read?limit=10`)).json()).data
      .complete,
    false,
  );
  response = await fetch(`${base}/${encodeURIComponent(intake.id)}/import`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: intake.version }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.imported.records, 1);
  assert.equal((await (await fetch(base)).json()).meta.total, 1);
});

test('an interrupted unpublished upload does not block retrying the same original', (t) => {
  const f = fixture(t),
    bytes = Buffer.from(line()),
    sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const key = sha('issuer\0report.jsonl\0' + sha(bytes));
  const directory = resolve(f.paths.sources, 'issuer', 'intake', key);
  mkdirSync(directory, { recursive: true });
  const interrupted = resolve(directory, 'report.jsonl.pending');
  writeFileSync(interrupted, 'incomplete bytes from a stopped upload');
  const result = upload(f, bytes);
  assert.deepEqual(getIntakeOriginal(f.db, f.root, f.profileId, result.id).bytes, bytes);
  assert.equal(readFileSync(interrupted, 'utf8'), 'incomplete bytes from a stopped upload');
  assert.deepEqual(readdirSync(directory), ['report.jsonl.pending']);
  assert.notEqual(
    result.id,
    'intake:' + key,
    'New intake identity is independent of acquisition labels',
  );
});

test('WebP intake is recognized by its bytes and never treated as complete plain text', (t) => {
  const f = fixture(t),
    bytes = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([20, 0, 0, 0]),
      Buffer.from('WEBPVP8Lsynthetic'),
    ]);
  const result = upload(f, bytes, { filename: 'opaque-export.bin', mimeType: 'text/plain' });
  assert.equal(result.mimeType, 'image/webp');
  assert.equal(readIntake(f.db, f.root, f.profileId, result.id).text, null);
  assert.deepEqual(getIntakeOriginal(f.db, f.root, f.profileId, result.id).bytes, bytes);
  assert.equal(result.state, 'pending_conversion');
});

test('conversion model identity and instruction version survive rebuild without credentials', async (t) => {
  const f = fixture(t),
    original = upload(f, Buffer.from('Fictional letter'), { filename: 'letter.txt' });
  const modelIdentity = {
    backend: 'ollama',
    model: 'fictional:local',
    reasoningEffort: null,
    instructionVersion: 'a'.repeat(64),
  };
  const proposed = proposeConversion(f.db, f.root, f.profileId, original.id, {
    version: original.version,
    jsonlText: line(),
    summary: 'Fictional conversion',
    modelIdentity: { ...modelIdentity, apiKey: 'must-not-persist' },
  });
  const selected = proposed.proposals[0]! as (typeof proposed.proposals)[number] & {
    modelIdentity: typeof modelIdentity;
  };
  assert.deepEqual(selected.modelIdentity, modelIdentity);
  const details = JSON.parse(
    String(
      f.db.prepare('SELECT details_json FROM source_files WHERE id=?').get(selected.id)!
        .details_json,
    ),
  ) as { modelIdentity: typeof modelIdentity };
  assert.deepEqual(details.modelIdentity, modelIdentity);
  assert.ok(!JSON.stringify(details).includes('must-not-persist'));
  const backup = await createBackup(f.db, f.root, f.profileId);
  const target = resolve(f.root, 'model-rebuilt'),
    receipt = rebuildProfile(resolve(backup.path, 'files'), f.profileId, target);
  const rebuilt = openDatabase(receipt.database, f.profileId);
  try {
    assert.deepEqual(
      (
        getIntake(rebuilt, target, f.profileId, original.id).proposals[0] as
          | ((typeof proposed.proposals)[number] & { modelIdentity: typeof modelIdentity })
          | undefined
      )?.modelIdentity,
      modelIdentity,
    );
  } finally {
    rebuilt.close();
  }
});
