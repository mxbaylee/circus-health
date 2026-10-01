import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDiagnosticChunkStore, diagnosticChunkLimits } from '../diagnostic-chunk-store.ts';
import { freshKey, encryptObject } from '../vault-crypto.ts';
import { openVault } from '../vault-store.ts';

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-diagnostic-chunks-'));
  const key = freshKey();
  t.after(() => {
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, key, profileId: 'fictional-chunk-profile' };
}
const name = (sequence: number) => String(sequence).padStart(16, '0') + '.enc';
const payload = Buffer.from(JSON.stringify({ event: 'import.progress', accountedUnits: 12 }));

test('vault diagnostic chunks are encrypted, immutable, replayable and outside medical authority', (t) => {
  const f = fixture(t);
  const vault = openVault({ ...f, initialize: true });
  const before = vault.metadata();
  const store = vault.diagnosticChunks();
  assert.equal(store.append(1, payload), 'appended');
  const path = join(f.directory, 'diagnostics/events', name(1));
  const original = readFileSync(path);
  assert.equal(original.includes(payload), false);
  assert.equal(store.append(1, payload), 'replayed');
  assert.throws(() => store.append(1, Buffer.from('different')), /retry conflicts/);
  assert.throws(() => store.append(3, payload), /sequence conflict/);
  assert.equal(store.append(2, payload), 'appended');
  assert.deepEqual(readFileSync(path), original);
  assert.deepEqual(store.read(1), payload);
  assert.deepEqual(vault.metadata(), before);
  vault.close();
  assert.throws(() => store.read(1), /locked|closed/);
  assert.throws(() => store.append(3, payload), /locked|closed/);
  assert.throws(() => store.inventory(), /locked|closed/);
  const next = openVault(f);
  t.after(() => next.close());
  assert.deepEqual(next.diagnosticChunks().read(2), payload);
  assert.equal(next.diagnosticChunks().inventory().nextSequence, 3);
  assert.equal(next.diagnosticChunks().inventory().omittedBeforeInventory, null);
  assert.equal(next.diagnosticChunks().inventory().completeness, 'not_established');
});

test('append work grows only with new chunks, with no prior payload reads or index rewrites', (t) => {
  for (const size of [8, 32]) {
    const f = fixture(t);
    const store = openDiagnosticChunkStore(f);
    t.after(() => store.close());
    for (let i = 1; i <= size; i++) store.append(i, payload);
    assert.deepEqual(store.work(), {
      indexScans: 1,
      chunkReads: 0,
      chunkWrites: size,
      plaintextBytesWritten: payload.length * size,
      evictions: 0,
    });
    assert.equal(readdirSync(f.directory).length, size);
    assert.equal(
      store.inventory().encryptedBytes,
      readdirSync(f.directory).reduce(
        (sum, file) => sum + lstatSync(join(f.directory, file)).size,
        0,
      ),
    );
  }
});

test('retention bounds chunks and ciphertext bytes and rejects retries of evicted sequences', (t) => {
  const f = fixture(t);
  const store = openDiagnosticChunkStore({ ...f, limits: { maxChunks: 2 } });
  for (let i = 1; i <= 4; i++) store.append(i, payload);
  assert.deepEqual(
    store.inventory().chunks.map((c) => c.sequence),
    [3, 4],
  );
  assert.equal(store.work().evictions, 2);
  assert.throws(() => store.append(1, payload), /not retained/);
  store.close();
  const reopened = openDiagnosticChunkStore({ ...f, limits: { maxChunks: 2 } });
  t.after(() => reopened.close());
  assert.equal(reopened.inventory().nextSequence, 5);
  assert.deepEqual(reopened.read(3), payload);
  const other = fixture(t);
  const bytes = openDiagnosticChunkStore({
    ...other,
    limits: { maxChunkBytes: 4096, maxBytes: 8192 },
  });
  t.after(() => bytes.close());
  bytes.append(1, Buffer.alloc(4096));
  bytes.append(2, Buffer.alloc(4096));
  assert.deepEqual(
    bytes.inventory().chunks.map((c) => c.sequence),
    [2],
  );
  assert.ok(bytes.inventory().encryptedBytes <= 8192);
});

test('missing and corrupt chunks are explicit; profile and sequence swaps fail authentication', (t) => {
  const f = fixture(t);
  const store = openDiagnosticChunkStore(f);
  for (let i = 1; i <= 3; i++) store.append(i, payload);
  const other = openDiagnosticChunkStore({ ...f, profileId: 'fictional-other' });
  assert.throws(() => other.read(1), /authentication failed/);
  other.close();
  copyFileSync(join(f.directory, name(1)), join(f.directory, name(3)));
  assert.throws(() => store.read(3), /authentication failed/);
  rmSync(join(f.directory, name(2)));
  assert.throws(() => store.read(2), /ENOENT/);
  store.close();
  const reopened = openDiagnosticChunkStore(f);
  assert.equal(reopened.inventory().missingChunksWithinInventory, 1);
  assert.throws(() => reopened.read(2), /not retained/);
  assert.deepEqual(reopened.read(1), payload);
  reopened.close();
});

test('recovery handles interrupted publication and retention within one extra chunk allowance', (t) => {
  const f = fixture(t);
  const store = openDiagnosticChunkStore(f);
  store.inventory();
  // Simulate a successful atomic rename whose acknowledgement never reached the writer.
  encryptObject(join(f.directory, name(1)), payload, f.key, f.profileId, 'diagnostic-events-v1:1');
  const cipher = readFileSync(join(f.directory, name(1)));
  assert.equal(store.append(1, payload), 'replayed');
  assert.deepEqual(readFileSync(join(f.directory, name(1))), cipher);
  store.append(2, payload);
  store.append(3, payload);
  store.close();
  const orphan = join(f.directory, name(4) + '.pending-' + 'a'.repeat(24));
  writeFileSync(orphan, 'fictional interrupted ciphertext');
  const recovered = openDiagnosticChunkStore({ ...f, limits: { maxChunks: 2 } });
  t.after(() => recovered.close());
  assert.deepEqual(
    recovered.inventory().chunks.map((c) => c.sequence),
    [2, 3],
  );
  assert.equal(readdirSync(f.directory).length, 2);
  assert.deepEqual(recovered.read(3), payload);
});

test('malformed, oversized and ambiguous storage fails without accepting arbitrary paths', (t) => {
  const f = fixture(t);
  const store = openDiagnosticChunkStore(f);
  assert.throws(() => store.append(0, payload), /sequence/);
  assert.throws(() => store.append(1.5, payload), /sequence/);
  assert.throws(() => store.append(1, Buffer.alloc(0)), /size/);
  assert.throws(
    () => store.append(1, Buffer.alloc(diagnosticChunkLimits.maxChunkBytes + 1)),
    /size/,
  );
  store.close();
  for (const filename of ['../invalid', 'bad-name.enc']) {
    assert.throws(() => openDiagnosticChunkStore({ ...f, limits: { maxChunks: 0 } }), /limits/);
    if (filename === '../invalid') continue;
    writeFileSync(join(f.directory, filename), 'fictional');
    assert.throws(() => openDiagnosticChunkStore(f).inventory(), /identity/);
    rmSync(join(f.directory, filename));
  }
  writeFileSync(
    join(f.directory, name(1)),
    Buffer.alloc(diagnosticChunkLimits.maxChunkBytes + 4097),
  );
  assert.throws(() => openDiagnosticChunkStore(f).inventory(), /read bound/);
  rmSync(join(f.directory, name(1)));
  mkdirSync(join(f.directory, name(1)));
  assert.throws(() => openDiagnosticChunkStore(f).inventory(), /Invalid diagnostic chunk file/);
});
