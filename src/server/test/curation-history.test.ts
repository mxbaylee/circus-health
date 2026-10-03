import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import {
  attachPersonalDurability,
  exportCuration,
  rebuildProfile,
  copyRetainedCurationHistory,
} from '../portable.ts';
import { createBackup, restoreBackup } from '../recovery.ts';
import { hash } from '../assets.ts';
function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'curation-history-')),
    paths = ensureProfileDirectories(root, 'cedar'),
    db = openDatabase(paths.database, 'cedar');
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  const oldPath = paths.relativeRoot + '/sources/earlier.json',
    newPath = paths.relativeRoot + '/sources/current.json';
  const oldRaw = '{"unmodeled":"Earlier unique clinical wording","number":1.0000}',
    newRaw = '{"unmodeled":"Current wording","number":2.0000}';
  writeFileSync(resolve(root, oldPath), oldRaw);
  writeFileSync(resolve(root, newPath), newRaw);
  db.prepare('INSERT INTO source_files(id,path,sha256,bytes,details_json) VALUES(?,?,?,?,?)').run(
    'file',
    oldPath,
    hash(Buffer.from(oldRaw)),
    Buffer.byteLength(oldRaw),
    '{"unmodeledCurationOnly":"unique prior reviewed value"}',
  );
  db.prepare("INSERT INTO source_records(id,source_file_id,raw_json) VALUES('raw','file',?)").run(
    oldRaw,
  );
  attachPersonalDurability(db, { portableSnapshots: true, root, profileId: 'cedar' });
  exportCuration(db, root, 'cedar');
  const oldPointer = readFileSync(resolve(paths.curation, 'current.json')),
    oldManifest = JSON.parse(oldPointer.toString('utf8')) as { file: string },
    oldGeneration = readFileSync(resolve(paths.curation, oldManifest.file));
  transaction(db, () => {
    db.prepare('UPDATE source_files SET path=?,sha256=?,bytes=?,details_json=? WHERE id=?').run(
      newPath,
      hash(Buffer.from(newRaw)),
      Buffer.byteLength(newRaw),
      '{"unmodeledCurationOnly":"current reviewed value"}',
      'file',
    );
    db.prepare('UPDATE source_records SET raw_json=? WHERE id=?').run(newRaw, 'raw');
  });
  const currentPointer = readFileSync(resolve(paths.curation, 'current.json'));
  // An old retained pointer is a candidate, never an alternate active pointer.
  writeFileSync(resolve(paths.curation, 'prior-pointer.json'), oldPointer);
  // Even an uninterpretable retained candidate remains recoverable as bytes.
  writeFileSync(
    resolve(paths.curation, 'snapshots/opaque-history.json'),
    'retained opaque bytes\n',
  );
  return {
    root,
    paths,
    db,
    oldPath,
    oldRaw,
    newRaw,
    oldPointer,
    oldManifest,
    oldGeneration,
    currentPointer,
  };
}
type Fixture = ReturnType<typeof fixture>;
interface HistoryReceipt {
  files: Array<{
    sourcePath: string;
    path: string;
    sha256: string;
    bytes: number;
    acceptance: string;
  }>;
  originals: Array<{ path: string | null; status: string }>;
}

function verify(target: string, f: Fixture) {
  const paths = profilePaths(target, 'cedar');
  assert.deepEqual(readFileSync(resolve(paths.curation, f.oldManifest.file)), f.oldGeneration);
  assert.deepEqual(readFileSync(resolve(paths.curation, 'prior-pointer.json')), f.oldPointer);
  assert.equal(
    readFileSync(resolve(paths.curation, 'snapshots/opaque-history.json'), 'utf8'),
    'retained opaque bytes\n',
  );
  assert.equal(readFileSync(resolve(target, f.oldPath), 'utf8'), f.oldRaw);
  const pointer = JSON.parse(readFileSync(resolve(paths.curation, 'current.json'), 'utf8')) as {
      file: string;
    },
    current = readFileSync(resolve(paths.curation, pointer.file), 'utf8');
  assert.match(current, /current reviewed value/);
  assert.doesNotMatch(current, /unique prior reviewed value/);
  const receipts = readdirSync(resolve(paths.curation, 'history-receipts')).map(
    (file): HistoryReceipt =>
      JSON.parse(readFileSync(resolve(paths.curation, 'history-receipts', file), 'utf8')),
  );
  const receipt = receipts.find((r) =>
    r.files.some((file) => file.sourcePath === f.oldManifest.file),
  );
  assert.ok(receipt);
  assert.ok(receipt.files.every((file) => file.acceptance === 'not-inferred'));
  assert.equal(receipt.originals.find((file) => file.path === f.oldPath)?.status, 'copied');
  for (const file of receipt.files) {
    const bytes = readFileSync(resolve(target, file.path));
    assert.equal(hash(bytes), file.sha256);
    assert.equal(bytes.length, file.bytes);
  }
}
test('backup and restore retain curation-only prior wording, pointers, opaque candidates and historical originals', async (t) => {
  const f = fixture(t),
    backup = await createBackup(f.db, f.root, 'cedar'),
    target = resolve(f.root, 'restored');
  const manifest = JSON.parse(readFileSync(resolve(backup.path, 'manifest.json'), 'utf8')) as {
    files: Array<{ path: string }>;
    profileSources: Array<{ path: string }>;
  };
  assert.ok(manifest.files.some((file) => file.path === f.oldPath));
  assert.ok(manifest.profileSources.some((file) => file.path.endsWith('/' + f.oldManifest.file)));
  restoreBackup(backup.path, target);
  verify(target, f);
  const current = openDatabase(profilePaths(target, 'cedar').database, 'cedar');
  try {
    assert.equal(current.prepare('SELECT raw_json FROM source_records').get()?.raw_json, f.newRaw);
  } finally {
    current.close();
  }
  // Historical files are covered by backup checksums as rigorously as current ones.
  writeFileSync(
    resolve(backup.path, 'files', f.paths.relativeRoot, 'curation', f.oldManifest.file),
    'tampered',
  );
  assert.throws(() => restoreBackup(backup.path, resolve(f.root, 'bad-restore')), /checksum/);
});
test('direct rebuild preserves old candidates and originals without promoting them into the current projection', (t) => {
  const f = fixture(t),
    target = resolve(f.root, 'rebuilt'),
    receipt = rebuildProfile(f.root, 'cedar', target);
  verify(target, f);
  assert.deepEqual(
    readFileSync(resolve(profilePaths(target, 'cedar').curation, 'current.json')),
    f.currentPointer,
  );
  assert.ok(receipt.curationHistory);
  assert.ok(receipt.curationHistory.originals >= 2);
  const current = openDatabase(receipt.database, 'cedar');
  try {
    assert.equal(current.prepare('SELECT raw_json FROM source_records').get()?.raw_json, f.newRaw);
  } finally {
    current.close();
  }
});
test('unavailable historical references are recorded without losing candidate bytes or reading another profile', (t) => {
  const f = fixture(t),
    candidate = {
      format: 'circus-health-profile-source-v1',
      kind: 'curation',
      profileId: 'cedar',
      tables: {
        source_files: [
          {
            path: 'data/profiles/cookie-dough/sources/private.json',
            sha256: 'unverified',
            bytes: 1,
          },
        ],
      },
    };
  const name = 'snapshots/unavailable-candidate.json',
    bytes = Buffer.from(JSON.stringify(candidate));
  writeFileSync(resolve(f.paths.curation, name), bytes);
  const target = resolve(f.root, 'historical-copy'),
    result = copyRetainedCurationHistory(f.root, 'cedar', target);
  assert.deepEqual(readFileSync(resolve(profilePaths(target, 'cedar').curation, name)), bytes);
  assert.equal(existsSync(resolve(profilePaths(target, 'cedar').curation, 'current.json')), false);
  assert.ok(result.receipt);
  assert.equal(result.receipt.unavailableOriginals, 1);
});
