import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { uploadIntake, getIntakeOriginal } from '../intake.ts';
import { rebuildRecordDatabase } from '../record-versions.ts';
import { exportCuration } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  readSourceTextProjection,
  sourceTextProjectionCounters,
} from '../source-text-projection.ts';
import { newProfile, vaultFixture } from './helpers/vault-fixture.ts';

test('actual legacy portable snapshot excludes warmed source-text cache tables and retains source authority', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'fictional-rope-portable-')),
    profileId = 'fictional-rope-portable';
  const paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const original = Buffer.from('Independently fictional portable source evidence.'),
    path = `${paths.relativeRoot}/sources/fictional.txt`;
  writeFileSync(resolve(root, path), original);
  const details = '{ "fictional": "exact retained source metadata Ω" }';
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run(
    'fictional-source',
    path,
    createHash('sha256').update(original).digest('hex'),
    original.length,
    'derived',
    details,
  );
  assert.equal(readSourceTextProjection(db, 'fictional-source'), details);
  assert.ok(
    db
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name GLOB '__record_source_text_*'",
      )
      .get()!.n,
  );
  const exported = exportCuration(db, root, profileId);
  assert.ok('path' in exported && typeof exported.path === 'string');
  const snapshot = JSON.parse(readFileSync(exported.path, 'utf8')) as {
    tables: Record<string, Array<Record<string, unknown>>>;
  };
  assert.equal(
    Object.keys(snapshot.tables).some((name) => name.startsWith('__record_source_text_')),
    false,
  );
  assert.equal(
    snapshot.tables.source_files!.find((row) => row.id === 'fictional-source')!.details_json,
    details,
  );
});

test('real warmed private copy, target rebinding and total encrypted cache loss preserve source authority', async (t) => {
  const { manager } = vaultFixture(t),
    created = await newProfile(manager, 'Fictional rope owner');
  const id = created.profile.id,
    state = manager.opened.get(id)!,
    bytes = Buffer.from('Independently fictional source rope copy evidence Ω.');
  const intake = uploadIntake(state.db, state.root, id, {
    filename: 'fictional-rope.txt',
    bytes,
    newProviderName: 'Fictional clinic',
  });
  transaction(state.db, () => {
    const details = JSON.parse(
      String(
        state.db.prepare('SELECT details_json FROM source_files WHERE id=?').get(intake.id)!
          .details_json,
      ),
    );
    details.intake.workflow = {
      format: 'health-intake-workflow-v1',
      fictionalText: 'Fictional repeated passage Ω 😀 '.repeat(500),
    };
    state.db
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run(JSON.stringify(details), intake.id);
  });
  const sourceDetails = String(
    state.db.prepare('SELECT details_json FROM source_files WHERE id=?').get(intake.id)!
      .details_json,
  );
  assert.equal(readSourceTextProjection(state.db, intake.id), sourceDetails);
  const sourceHead = state.recordStorage.read('head');
  const copy = manager.begin({ name: 'Fictional rope copy owner', copyFrom: id });
  await manager.verify(copy.setupId, { acknowledged: true, recovery: copy.recoveryKit });
  const expected = new Map<string, string>();
  const check = (profileId: string) => {
    const current = manager.opened.get(profileId)!;
    const raw = String(
      current.db.prepare('SELECT details_json FROM source_files WHERE id=?').get(intake.id)!
        .details_json,
    );
    if (!expected.has(profileId)) expected.set(profileId, raw);
    assert.equal(raw, expected.get(profileId));
    assert.equal(readSourceTextProjection(current.db, intake.id), raw);
    assert.deepEqual(
      Buffer.from(readSourceTextProjection(current.db, intake.id)),
      Buffer.from(raw),
    );
    assert.equal(
      current.db
        .prepare('SELECT profile_id FROM __record_source_text_heads WHERE source_id=?')
        .get(intake.id)!.profile_id,
      profileId,
    );
    assert.deepEqual(
      getIntakeOriginal(current.db, current.root, profileId, intake.id).bytes,
      bytes,
    );
    assert.ok(
      String(
        current.db.prepare('SELECT path FROM source_files WHERE id=?').get(intake.id)!.path,
      ).includes(profileId),
    );
    assert.equal(
      current.db
        .prepare(
          "SELECT count(*) n FROM __record_versions WHERE entity GLOB '__record_source_text_*'",
        )
        .get()!.n,
      0,
    );
  };
  check(id);
  check(copy.profileId);
  assert.deepEqual(state.recordStorage.read('head'), sourceHead);
  assert.equal(
    String(
      state.db.prepare('SELECT details_json FROM source_files WHERE id=?').get(intake.id)!
        .details_json,
    ),
    sourceDetails,
  );
  for (const [profileId, recovery] of [
    [id, created.recoveryKit],
    [copy.profileId, copy.recoveryKit],
  ] as const) {
    const oldDb = manager.opened.get(profileId)!.db;
    manager.lock(profileId);
    assert.equal(
      sourceTextProjectionCounters(oldDb).authorityReads,
      0,
      'lock discards connection readiness and counters',
    );
    rmSync(resolve(manager.pathFor(profileId), 'cache'), { recursive: true, force: true });
    manager.unlock(profileId, recovery);
    check(profileId);
  }
});

test('missing, corrupt and unsupported selected durable evidence cannot recover a successful text projection', async (t) => {
  for (const fault of ['missing', 'corrupt', 'unsupported'] as const) {
    await t.test(fault, async (t) => {
      const { manager, base } = vaultFixture(t),
        created = await newProfile(manager, 'Fictional authority failure');
      const state = manager.opened.get(created.profile.id)!;
      const intake = uploadIntake(state.db, state.root, created.profile.id, {
        filename: 'fictional.txt',
        bytes: Buffer.from('Fictional authority fault.'),
        newProviderName: 'Fictional provider',
      });
      readSourceTextProjection(state.db, intake.id);
      const original = state.recordStorage.read.bind(state.recordStorage);
      const reference = JSON.parse(original('head')!.toString('utf8')) as {
        name: string;
        sha256: string;
        bytes: number;
      };
      const unsupported = JSON.parse(original(reference.name)!.toString('utf8'));
      unsupported.format = 'unsupported-fictional-authority-v999';
      const unsupportedBytes = Buffer.from(JSON.stringify(unsupported));
      const unsupportedHead = Buffer.from(
        JSON.stringify({
          ...reference,
          sha256: createHash('sha256').update(unsupportedBytes).digest('hex'),
          bytes: unsupportedBytes.length,
        }),
      );
      const storage = {
        ...state.recordStorage,
        read(name: string) {
          if (fault === 'unsupported' && name === 'head') return unsupportedHead;
          const value = original(name);
          if (name !== reference.name) return value;
          if (fault === 'missing') return null;
          if (fault === 'corrupt') return Buffer.from('fictional corrupt committed evidence');
          return unsupportedBytes;
        },
      };
      assert.throws(
        () =>
          rebuildRecordDatabase(resolve(base, `unrecoverable-${fault}.sqlite`), {
            profileId: created.profile.id,
            storage,
          }),
        /missing|corrupt|hash|format|unsupported|commit/i,
      );
    });
  }
});
