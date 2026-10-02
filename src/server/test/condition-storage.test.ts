import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { transaction } from '../database.ts';
import { hash } from '../assets.ts';
import { queryRecordHistory } from '../record-versions.ts';
import { vaultFixture, newProfile } from './helpers/vault-fixture.ts';

test('current-schema condition history and originals survive encrypted lock, cache reuse and complete cache loss', async (t) => {
  const { manager } = vaultFixture(t);
  const { profile, recoveryKit } = await newProfile(manager);
  const state = manager.opened.get(profile.id)!;
  const relative = `data/profiles/${profile.id}/sources/fictional-condition.json`;
  const original = Buffer.from(
    '{"kind":"problem-list","diagnosis":"Fictional condition","status":"provider active"}',
  );
  const path = resolve(state.root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, original);
  transaction(
    state.db,
    () => {
      state.db
        .prepare('INSERT INTO source_files(id,path,sha256,bytes) VALUES(?,?,?,?)')
        .run('file', relative, hash(original), original.length);
      state.db
        .prepare('INSERT INTO source_records(id,source_file_id,raw_json) VALUES(?,?,?)')
        .run('source', 'file', original.toString());
      state.db.exec(
        "INSERT INTO people(id,display_name) VALUES('relative','Fictional relative'); INSERT INTO conditions(id,source_record_id,person_id,label,status,extra_json) VALUES('condition','source','relative','Fictional condition','provider active','{\"nullable\":null}')",
      );
    },
    { actor: 'fictional-reviewer', origin: 'condition-storage-fixture' },
  );
  transaction(
    state.db,
    () => state.db.exec("UPDATE conditions SET effective_at='2020-03' WHERE id='condition'"),
    { actor: 'fictional-caregiver' },
  );
  const expected = state.db.prepare('SELECT * FROM conditions').all();
  const history = queryRecordHistory(state.db, {
    profileId: profile.id,
    entity: 'conditions',
    recordId: 'condition',
  });
  assert.equal(history.entries.length, 2);
  for (const loseCache of [false, true]) {
    manager.lock(profile.id);
    if (loseCache)
      rmSync(resolve(manager.pathFor(profile.id), 'cache'), { recursive: true, force: true });
    manager.unlock(profile.id, recoveryKit);
    const reopened = manager.opened.get(profile.id)!;
    assert.equal(reopened.metrics.cacheHit, !loseCache);
    assert.deepEqual(reopened.db.prepare('SELECT * FROM conditions').all(), expected);
    assert.deepEqual(
      queryRecordHistory(reopened.db, {
        profileId: profile.id,
        entity: 'conditions',
        recordId: 'condition',
      }),
      history,
    );
    assert.deepEqual(reopened.vault.readFile('sources/fictional-condition.json'), original);
    assert.equal(
      reopened.db.prepare("SELECT count(*) n FROM conditions WHERE person_id='patient'").get()?.n,
      0,
    );
  }
});
