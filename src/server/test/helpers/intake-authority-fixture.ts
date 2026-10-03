import assert from 'node:assert/strict';
import { type Database, transaction } from '../../database.ts';
import { attachRecordDurability, type RecordStorage } from '../../record-versions.ts';
import { registerIntakeFile } from '../../intake-state-access.ts';
import { stageIntakeEnvelope } from '../../intake-authority.ts';

/** Fictional accepted-record backend, with the same immutable/publication API as runtime storage. */
export function memoryRecordAuthority(db: Database) {
  const profileId = String(
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()!.value,
  );
  const objects = new Map<string, Buffer>();
  const storage: RecordStorage = {
    read(name) {
      const bytes = objects.get(name);
      return bytes ? Buffer.from(bytes) : null;
    },
    writeImmutable(name, bytes) {
      const previous = objects.get(name);
      if (previous) assert.deepEqual(previous, Buffer.from(bytes));
      else objects.set(name, Buffer.from(bytes));
    },
    publishHead(bytes) {
      objects.set('head', Buffer.from(bytes));
    },
  };
  attachRecordDurability(db, { profileId, storage });
  return {
    objects,
    storage,
    profileId,
    attach(next: Database) {
      return attachRecordDurability(next, { profileId, storage });
    },
  };
}

/** Preserve independently supplied original bytes until an actual supported rewrite. */
export function registerRawIntakeFixture(
  db: Database,
  id: string,
  raw: string,
  providerId: string | null = null,
) {
  const register = () =>
    registerIntakeFile(db, {
      id,
      providerId,
      path: id + '.txt',
      sha256: 'a'.repeat(64),
      size: 0,
      mimeType: 'text/plain',
      kind: 'intake_original',
      coverage: 'unknown',
      details: raw,
    });
  if (db.isTransaction) register();
  else transaction(db, register);
}

export function writeIntakeFixtureEnvelope(
  db: Database,
  id: string,
  envelope: Record<string, unknown>,
) {
  const write = () => {
    stageIntakeEnvelope(db, { id }, envelope);
  };
  if (db.isTransaction) write();
  else transaction(db, write);
}
