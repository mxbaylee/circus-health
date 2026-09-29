import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError, openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { receiveIntakeUpload } from '../intake-upload.ts';
import { intakeLimits, inspectIntakeFile } from '../intake-files.ts';
import * as intake from '../intake.ts';
import { readIntakeEvidence } from '../intake-evidence.ts';
import { rebuildProfile } from '../portable.ts';
import { createBackup } from '../recovery.ts';
type UploadRequest = IncomingMessage;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function request(
  chunks: Parameters<typeof Readable.from>[0],
  headers: IncomingHttpHeaders = {},
): UploadRequest {
  const req = Readable.from(chunks);
  return Object.assign(req, { headers }) as unknown as UploadRequest;
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'health-stream-test-')),
    profileId = 'cookie-dough';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, db };
}
const input = {
  filename: 'fictional.pdf',
  newProviderName: 'Fictional clinic',
  mimeType: 'application/pdf',
};

test('streamed originals adopt the completed staging inode without a second plaintext copy', async (t) => {
  const f = fixture(t);
  const original = Buffer.from('%PDF-1.4\nFictional same-filesystem adoption');
  let stagedInode: number | undefined;
  const chunks = request(
    (async function* () {
      yield original;
      const stagingRoot = join(f.root, '.upload-staging');
      const [entry] = readdirSync(stagingRoot);
      stagedInode = statSync(join(stagingRoot, entry!, 'original')).ino;
    })(),
    { 'content-length': String(original.length), 'x-content-sha256': hash(original) },
  );
  const item = await intake.uploadIntakeStream(f.db, f.root, f.profileId, input, chunks);
  const retained = intake.verifyIntakeOriginal(f.db, f.root, f.profileId, item.id);
  assert.equal(statSync(retained.path).ino, stagedInode);
  assert.equal(statSync(retained.path).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(retained.path), original);
  assert.deepEqual(readdirSync(join(f.root, '.upload-staging')), []);
  assert.equal(item.sha256, hash(original));
});

test('streamed renamed ADTS uses retained file length beyond the sniff prefix and rejects incomplete frames', async (t) => {
  const f = fixture(t);
  const frame = Buffer.alloc(1024);
  // Fictional ADTS header declaring a 1024-byte frame: larger than the
  // receiver's 512-byte sniff prefix, but present in the complete upload.
  Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x80, 0x1f, 0xfc]).copy(frame);
  for (const [index, filename] of ['fictional-renamed.json', 'fictional-renamed.bin'].entries()) {
    const bytes = Buffer.from(frame);
    bytes[bytes.length - 1] = index;
    const item = await intake.uploadIntakeStream(
      f.db,
      f.root,
      f.profileId,
      { filename, newProviderName: 'Fictional media' },
      request([bytes.subarray(0, 100), bytes.subarray(100, 800), bytes.subarray(800)], {
        'content-length': String(bytes.length),
        'x-content-sha256': hash(bytes),
      }),
    );
    assert.equal(item.mimeType, 'audio/aac');
    await assert.rejects(readIntakeEvidence({ ...f, id: item.id, modelContext: true }), {
      code: 'INTAKE_RETAIN_ONLY',
    });
    assert.deepEqual(intake.getIntakeOriginal(f.db, f.root, f.profileId, item.id).bytes, bytes);
  }
  const incomplete = frame.subarray(0, 600);
  const unknown = await intake.uploadIntakeStream(
    f.db,
    f.root,
    f.profileId,
    { filename: 'fictional-incomplete.bin' },
    request([incomplete]),
  );
  assert.equal(unknown.mimeType, 'application/octet-stream');
});

test('staging adoption still rejects bytes changed after stream hashing before publication', async (t) => {
  const f = fixture(t);
  const original = Buffer.from('%PDF-1.4\nFictional integrity boundary');
  const chunks = request(
    (async function* () {
      yield original;
      const stagingRoot = join(f.root, '.upload-staging');
      const [entry] = readdirSync(stagingRoot);
      const stagedPath = join(stagingRoot, entry!, 'original');
      // Readable.from may prefetch the generator before the consumer writes.
      // Mutate only after the receiver actually hashed and wrote this chunk.
      for (
        let attempt = 0;
        statSync(stagedPath).size !== original.length && attempt < 20;
        attempt++
      )
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(readFileSync(stagedPath), original);
      writeFileSync(stagedPath, 'Fictional substituted bytes');
    })(),
  );
  await assert.rejects(
    intake.uploadIntakeStream(f.db, f.root, f.profileId, input, chunks),
    (error: unknown) => error instanceof HttpError && error.code === 'SOURCE_CHANGED',
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM source_files').get()!.n, 0);
  assert.deepEqual(readdirSync(join(f.root, '.upload-staging')), []);
});

test('receipt publishes only complete fsynced bytes and removes private staging after success', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'health-stream-stage-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const original = Buffer.from('%PDF-1.4\nFictional original'),
    req = request([original.subarray(0, 3), original.subarray(3)], {
      'content-length': String(original.length),
      'x-content-sha256': hash(original),
    });
  let published = 0;
  const result = await receiveIntakeUpload(
    req,
    (receipt) => {
      published++;
      assert.equal(statSync(receipt.path).mode & 0o777, 0o600);
      assert.equal(statSync(join(receipt.path, '..')).mode & 0o777, 0o700);
      assert.equal(receipt.sha256, hash(original));
      assert.deepEqual(readFileSync(receipt.path), original);
      return 'saved';
    },
    { tempRoot },
  );
  assert.equal(result, 'saved');
  assert.equal(published, 1);
  assert.deepEqual(readdirSync(tempRoot), []);
});

test('oversize, truncated, interrupted and hash-mismatched receipts never publish partial originals', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'health-stream-errors-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const cases: [UploadRequest, string][] = [
    [request([Buffer.alloc(11)]), 'FILE_SIZE'],
    [request([Buffer.alloc(3)], { 'content-length': '4' }), 'UPLOAD_LENGTH'],
    [request([Buffer.alloc(3)], { 'x-content-sha256': '0'.repeat(64) }), 'UPLOAD_HASH'],
    [
      request(
        (async function* () {
          yield Buffer.alloc(2);
          throw new Error('Disconnected');
        })(),
      ),
      'UPLOAD_INTERRUPTED',
    ],
    [request([]), 'FILE_SIZE'],
    [request([], { 'content-length': '999' }), 'FILE_SIZE'],
    [request([], { 'content-length': 'NaN' }), 'UPLOAD_LENGTH'],
    [request([], { 'x-content-sha256': 'not-a-hash' }), 'UPLOAD_HASH'],
  ];
  for (const [req, code] of cases) {
    await assert.rejects(
      receiveIntakeUpload(req, () => assert.fail('Must not publish'), { tempRoot, maxBytes: 10 }),
      (e: unknown) => e instanceof HttpError && e.code === code,
    );
    assert.deepEqual(readdirSync(tempRoot), []);
  }
});

test('original above JSONL cap survives streaming upload, conversion, backup and disposable SQLite rebuild', async (t) => {
  const f = fixture(t),
    chunk = Buffer.alloc(1024 * 1024, 32),
    prefix = Buffer.from('%PDF-1.4\nFictional large retained document\n'),
    digest = createHash('sha256').update(prefix);
  for (let i = 0; i < 26; i++) digest.update(chunk);
  const sha256 = digest.digest('hex');
  const chunks = () =>
    request(
      (async function* () {
        yield prefix;
        for (let i = 0; i < 26; i++) yield chunk;
      })(),
      { 'x-content-sha256': sha256 },
    );
  let item = await intake.uploadIntakeStream(f.db, f.root, f.profileId, input, chunks());
  assert.equal(item.sha256, sha256);
  assert.equal(item.bytes, 26 * chunk.length + prefix.length);
  assert.equal(item.state, 'pending_conversion');
  assert.equal(item.validation.previewComplete, false);
  assert.equal(
    (await intake.uploadIntakeStream(f.db, f.root, f.profileId, input, chunks())).repeatedUpload,
    true,
  );
  assert.throws(
    () => intake.reviewIntake(f.db, f.root, f.profileId, item.id),
    (e: unknown) => e instanceof HttpError && e.code === 'CONVERSION_REQUIRED',
  );
  const original = intake.verifyIntakeOriginal(f.db, f.root, f.profileId, item.id);
  assert.equal(inspectIntakeFile(original.path).sha256, sha256);
  const value = {
    format: 'health-record-v1',
    id: 'fixture',
    kind: 'document',
    payload: 'Fictional page 1',
    provenance: {
      capturedVia: null,
      sourceSystem: null,
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator: 'page 1',
    },
    coverage: { status: 'partial', notes: ['Remaining pages pending'] },
  };
  const proposed = intake.proposeConversion(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    jsonlText: JSON.stringify(value),
    summary: 'Only page 1 inspected',
  });
  assert.equal(proposed.proposals.length, 1);
  const backup = await createBackup(f.db, f.root, f.profileId),
    target = join(f.root, 'rebuilt'),
    rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
    db = openDatabase(rebuilt.database, f.profileId);
  try {
    const restored = intake.verifyIntakeOriginal(db, target, f.profileId, proposed.id);
    assert.equal(inspectIntakeFile(restored.path).sha256, sha256);
    assert.equal(intake.getIntake(db, target, f.profileId, proposed.id).proposals.length, 1);
  } finally {
    db.close();
  }
});

test('UTF-8 text windows remain exact across file chunks without loading the entire original', (t) => {
  const f = fixture(t),
    text = 'a'.repeat(256 * 1024 - 1) + '🧪' + '😀12.000\n'.repeat(50000),
    bytes = Buffer.from(text),
    item = intake.uploadIntake(f.db, f.root, f.profileId, {
      ...input,
      filename: 'fictional.txt',
      bytes,
    });
  for (const offset of [0, 256 * 1024 - 3, 256 * 1024 + 1, text.length - 30]) {
    const result = intake.readIntake(f.db, f.root, f.profileId, item.id, { offset, limit: 31 });
    assert.equal(result.text, text.slice(offset, offset + 31));
    assert.equal(result.totalCharacters, text.length);
  }
  const original = intake.verifyIntakeOriginal(f.db, f.root, f.profileId, item.id);
  writeFileSync(original.path, Buffer.alloc(bytes.length));
  assert.throws(
    () => intake.readIntake(f.db, f.root, f.profileId, item.id),
    (e: unknown) => e instanceof HttpError && e.code === 'SOURCE_CHANGED',
  );
});

test('limits reject invalid configuration and extraction limit leaves original available for bounded reads', (t) => {
  assert.deepEqual(intakeLimits({}), {
    uploadBytes: 128 * 1024 * 1024,
    extractionBytes: 64 * 1024 * 1024,
  });
  for (const value of ['0', '1.5', 'wrong', '1025'])
    assert.throws(
      () => intakeLimits({ CRS_INTAKE_UPLOAD_MIB: value }),
      (e: unknown) => e instanceof HttpError && e.code === 'INTAKE_CONFIG',
    );
  const previous = process.env.CRS_INTAKE_EXTRACTION_MIB;
  process.env.CRS_INTAKE_EXTRACTION_MIB = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.CRS_INTAKE_EXTRACTION_MIB;
    else process.env.CRS_INTAKE_EXTRACTION_MIB = previous;
  });
  const f = fixture(t),
    item = intake.uploadIntake(f.db, f.root, f.profileId, {
      ...input,
      filename: 'large.txt',
      bytes: Buffer.alloc(1024 * 1024 + 1, 65),
    });
  assert.throws(
    () => intake.getIntakeOriginal(f.db, f.root, f.profileId, item.id),
    (e: unknown) => e instanceof HttpError && e.code === 'EXTRACTION_LIMIT',
  );
  assert.equal(
    intake.readIntake(f.db, f.root, f.profileId, item.id, { limit: 10 }).text,
    'A'.repeat(10),
  );
  assert.equal(intake.verifyIntakeOriginal(f.db, f.root, f.profileId, item.id).size, item.bytes);
});

test('HTTP uploads expose configured limits, stream chunked originals and reject checksum mismatch without rows', async (t) => {
  const f = fixture(t),
    { createApp } = await import('../index.ts'),
    app = createApp({ root: f.root, databases: new Map([[f.profileId, f.db]]) });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => app.server.close(() => resolve())));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/${f.profileId}/intakes`,
    headers = {
      origin: 'http://127.0.0.1:5173',
      'x-filename': 'fictional.pdf',
      'x-source-name': 'Fictional%20clinic',
      'content-type': 'application/pdf',
    },
    bytes = Buffer.from('%PDF-1.4\nFictional HTTP fixture');
  const limits = (await (await fetch(base + '/limits')).json()).data;
  assert.equal(limits.uploadBytes, 128 * 1024 * 1024);
  const bad = await fetch(base, {
    method: 'POST',
    headers: { ...headers, 'x-content-sha256': '0'.repeat(64) },
    body: request([bytes]) as unknown as BodyInit,
    duplex: 'half',
  } as RequestInit);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'UPLOAD_HASH');
  assert.equal(f.db.prepare('SELECT count(*) n FROM source_files').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM providers').get()!.n, 0);
  const response = await fetch(base, {
    method: 'POST',
    headers: { ...headers, 'x-content-sha256': hash(bytes) },
    body: request([bytes.subarray(0, 2), bytes.subarray(2)]) as unknown as BodyInit,
    duplex: 'half',
  } as RequestInit);
  assert.equal(response.status, 201);
  const item = (await response.json()).data;
  assert.equal(item.sha256, hash(bytes));
  assert.deepEqual(intake.getIntakeOriginal(f.db, f.root, f.profileId, item.id).bytes, bytes);
});

test('an upload draining after profile database closure cannot publish into a locked workspace', async (t) => {
  const f = fixture(t),
    req = request(
      (async function* () {
        yield Buffer.from('%PDF-1.4');
        f.db.close();
        yield Buffer.from(' fictional complete original');
      })(),
    );
  await assert.rejects(intake.uploadIntakeStream(f.db, f.root, f.profileId, input, req));
  assert.deepEqual(readdirSync(join(f.root, '.upload-staging')), []);
  const reopened = openDatabase(
    ensureProfileDirectories(f.root, f.profileId).database,
    f.profileId,
  );
  try {
    assert.equal(reopened.prepare('SELECT count(*) n FROM source_files').get()!.n, 0);
    assert.equal(reopened.prepare('SELECT count(*) n FROM providers').get()!.n, 0);
  } finally {
    reopened.close();
  }
});

test('HTTP chunked oversize produces an explicit 413 and leaves no metadata or staged bytes', async (t) => {
  const previous = process.env.CRS_INTAKE_UPLOAD_MIB;
  process.env.CRS_INTAKE_UPLOAD_MIB = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.CRS_INTAKE_UPLOAD_MIB;
    else process.env.CRS_INTAKE_UPLOAD_MIB = previous;
  });
  const f = fixture(t),
    { createApp } = await import('../index.ts'),
    app = createApp({ root: f.root, databases: new Map([[f.profileId, f.db]]) });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => app.server.close(() => resolve())));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/${f.profileId}/intakes`,
    headers = {
      origin: 'http://127.0.0.1:5173',
      'x-filename': 'oversize.pdf',
      'x-source-name': 'Fictional%20clinic',
      'content-type': 'application/pdf',
    };
  const response = await fetch(base, {
    method: 'POST',
    headers,
    body: request(
      (async function* () {
        for (let i = 0; i < 24; i++) yield Buffer.alloc(64 * 1024);
      })(),
    ) as unknown as BodyInit,
    duplex: 'half',
  } as RequestInit);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'FILE_SIZE');
  assert.equal(f.db.prepare('SELECT count(*) n FROM source_files').get()!.n, 0);
  assert.deepEqual(readdirSync(join(f.root, '.upload-staging')), []);
});

test('storage failure is reported distinctly and cleanup never removes a completed published original', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'health-stream-storage-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const published = join(tempRoot, 'retained-original');
  await assert.rejects(
    receiveIntakeUpload(
      request([Buffer.from('Fictional retained bytes')]),
      (receipt) => {
        writeFileSync(published, readFileSync(receipt.path));
        throw Object.assign(new Error('Fictional durable publication failure'), { code: 'ENOSPC' });
      },
      { tempRoot },
    ),
    (e: unknown) => e instanceof HttpError && e.code === 'UPLOAD_STORAGE' && e.status === 507,
  );
  assert.equal(readFileSync(published, 'utf8'), 'Fictional retained bytes');
  assert.deepEqual(readdirSync(tempRoot), ['retained-original']);
});
