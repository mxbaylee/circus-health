import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, truncateSync } from 'node:fs';
import { resolve } from 'node:path';
import { revision } from '../database.ts';
import { getNote, saveNote } from '../notes.ts';
import { queryRecordHistory } from '../record-versions.ts';
import type { TransactionOperation } from '../database.ts';
import type { OpenedProfile } from '../encrypted-profiles.ts';
import { vaultFixture, newProfile } from './helpers/vault-fixture.ts';

function changePronouns(state: OpenedProfile, pronouns: string, operation?: TransactionOperation) {
  const self = getNote(state.db, 'patient');
  return saveNote(
    state.db,
    self.id,
    { ...self, person: { ...self.person, pronouns }, version: self.version },
    undefined,
    operation,
  );
}

test('a partial orphan object cannot replace acknowledged current records or history', async (t) => {
  const { manager } = vaultFixture(t);
  const { profile, recoveryKit } = await newProfile(manager);
  const state = manager.opened.get(profile.id);
  assert.ok(state);
  changePronouns(state, 'A');
  changePronouns(state, 'B');
  const head = state.recordStorage.read('head');
  const acceptedRevision = revision(state.db);
  const write = state.recordStorage.writeImmutable;
  let orphan: string | undefined;
  state.recordStorage.writeImmutable = (name, bytes) => {
    write(name, bytes);
    orphan = resolve(manager.pathFor(profile.id), 'vault/versions', name.slice(8) + '.enc');
    truncateSync(orphan, 13); // Interrupted ciphertext is not an accepted commit.
    throw Error('Injected interruption after partial immutable object');
  };
  assert.throws(() => changePronouns(state, 'UNACCEPTED'), /Injected interruption/);
  state.recordStorage.writeImmutable = write;
  assert.deepEqual(state.recordStorage.read('head'), head);
  assert.equal(revision(state.db), acceptedRevision);
  assert.equal(getNote(state.db, 'patient').person.pronouns, 'B');
  manager.lock(profile.id);
  rmSync(resolve(manager.pathFor(profile.id), 'cache'), { recursive: true, force: true });
  manager.unlock(profile.id, recoveryKit);
  const rebuiltState = manager.opened.get(profile.id);
  assert.ok(rebuiltState);
  const rebuilt = rebuiltState.db;
  assert.equal(getNote(rebuilt, 'patient').person.pronouns, 'B');
  const values = queryRecordHistory(rebuilt, {
    profileId: profile.id,
    entity: 'notes',
    recordId: getNote(rebuilt, 'patient').id,
    field: 'profile_json.pronouns',
  })
    .entries.toReversed()
    .map((entry) => entry.changes.find((change) => change.field === 'profile_json.pronouns')?.after)
    .flatMap((value) => (value?.present ? [value.value] : []));
  assert.deepEqual(values.slice(-2), ['A', 'B']);
  assert.equal(values.includes('UNACCEPTED'), false);
  assert.ok(orphan);
  assert.equal(
    existsSync(orphan),
    true,
    'reconstruction must ignore unattached objects without guessing or deleting evidence',
  );
});

test('published versions survive a failure before SQLite commit and replay only once after rebuild', async (t) => {
  const { manager } = vaultFixture(t);
  const { profile, recoveryKit } = await newProfile(manager);
  const state = manager.opened.get(profile.id);
  assert.ok(state);
  changePronouns(state, 'Before');
  const operation = {
    operationId: randomUUID(),
    fingerprint: 'synthetic-once',
    expectedRevision: revision(state.db),
  };
  const publish = state.recordStorage.publishHead;
  state.recordStorage.publishHead = (bytes) => {
    publish(bytes);
    throw Error('Injected loss after durable publication');
  };
  assert.throws(() => changePronouns(state, 'Accepted', operation), /Injected loss/);
  state.recordStorage.publishHead = publish;
  assert.equal(
    getNote(state.db, 'patient').person.pronouns,
    'Before',
    'SQLite rolled back while the vault acceptance survived',
  );
  manager.lock(profile.id);
  rmSync(resolve(manager.pathFor(profile.id), 'cache'), { recursive: true, force: true });
  manager.unlock(profile.id, recoveryKit);
  const recovered = manager.opened.get(profile.id);
  assert.ok(recovered);
  assert.equal(getNote(recovered.db, 'patient').person.pronouns, 'Accepted');
  const acceptedRevision = revision(recovered.db);
  changePronouns(recovered, 'Accepted', operation);
  assert.equal(
    revision(recovered.db),
    acceptedRevision,
    'a retry with the old expected revision reuses the committed operation',
  );
  assert.equal(
    recovered.db
      .prepare('SELECT count(*) AS n FROM __record_transactions WHERE operation_id=?')
      .get(operation.operationId)?.n,
    1,
  );
});

test('failed public-card publication leaves a locked profile and retries the durable card update', async (t) => {
  const { manager, dataDirectory, runtimeDirectory } = vaultFixture(t);
  const { profile, recoveryKit } = await newProfile(manager, 'Original synthetic name');
  const state = manager.opened.get(profile.id);
  assert.ok(state);
  const self = getNote(state.db, 'patient');
  saveNote(state.db, self.id, {
    ...self,
    title: 'Changed synthetic name',
    person: { ...self.person, name: 'Changed synthetic name' },
    version: self.version,
  });
  manager.lock(profile.id);
  const path = resolve(dataDirectory, 'profiles.json'),
    saved = path + '.fault-fixture';
  renameSync(path, saved);
  mkdirSync(path); // Atomic rename of the public card now fails deterministically.
  try {
    assert.throws(() => manager.unlock(profile.id, recoveryKit));
    assert.equal(manager.opened.has(profile.id), false);
    assert.equal(manager.card(profile.id).locked, true);
    assert.equal(existsSync(resolve(runtimeDirectory, profile.id)), false);
  } finally {
    rmSync(path, { recursive: true });
    renameSync(saved, path);
  }
  assert.equal(manager.unlock(profile.id, recoveryKit).name, 'Changed synthetic name');
  assert.equal(
    (JSON.parse(readFileSync(path, 'utf8')) as { profiles: Array<{ name: string }> }).profiles[0]
      ?.name,
    'Changed synthetic name',
    'retry must publish the card that failed to reach disk',
  );
  assert.equal(
    getNote(manager.opened.get(profile.id)!.db, 'patient').title,
    'Changed synthetic name',
  );
});

test('failed profile removal publication retains the recoverable profile until a successful retry', async (t) => {
  const { manager, dataDirectory } = vaultFixture(t);
  const { profile, recoveryKit } = await newProfile(manager);
  const path = resolve(dataDirectory, 'profiles.json'),
    saved = path + '.fault-fixture';
  renameSync(path, saved);
  mkdirSync(path);
  const confirmation = { confirmationName: profile.name, version: profile.version };
  try {
    assert.throws(() => manager.remove(profile.id, confirmation));
    assert.equal(manager.card(profile.id).locked, true);
    assert.equal(existsSync(manager.pathFor(profile.id)), true);
  } finally {
    rmSync(path, { recursive: true });
    renameSync(saved, path);
  }
  assert.equal(manager.unlock(profile.id, recoveryKit).locked, false);
  assert.equal(manager.remove(profile.id, confirmation).deleted, true);
  assert.deepEqual(manager.list(), []);
  assert.deepEqual(
    (JSON.parse(readFileSync(path, 'utf8')) as { profiles: unknown[] }).profiles,
    [],
  );
  assert.equal(existsSync(manager.pathFor(profile.id)), false);
});

test('failed activation card publication remains unpublished and can be retried once', async (t) => {
  const { manager, dataDirectory } = vaultFixture(t);
  const setup = manager.begin({
    fullName: 'Synthetic staged person',
    birthDate: '1982-04-17',
    name: 'Synthetic staged person',
    placebo: false,
  });
  const path = resolve(dataDirectory, 'profiles.json');
  mkdirSync(path);
  const verification = { acknowledged: true, recovery: setup.recoveryKit };
  try {
    await assert.rejects(manager.verify(setup.setupId, verification));
    assert.deepEqual(
      manager.list(),
      [],
      'failed activation must not become a public card in memory',
    );
  } finally {
    rmSync(path, { recursive: true });
  }
  const profile = await manager.verify(setup.setupId, verification);
  assert.equal(profile.id, setup.profileId);
  assert.equal((await manager.verify(setup.setupId, verification)).id, setup.profileId);
  assert.equal(manager.list().length, 1);
  assert.equal(
    (JSON.parse(readFileSync(path, 'utf8')) as { profiles: unknown[] }).profiles.length,
    1,
  );
});
