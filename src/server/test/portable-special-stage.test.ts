import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentTransactionToken, transaction } from '../database.ts';
import { createPortableProjectionTransfer } from '../portable-projection-transfer.ts';
import {
  selectedPortablePersonalSpecialFields,
  stagePortablePersonalSpecialRows,
} from '../portable-special-stage.ts';
import { packetPreferenceKey } from '../packet-preference-codec.ts';

test('selected special rows retain last occurrence and fixed app_meta order', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-portable-special-'));
  const file = join(directory, 'generation.json');
  const profileId = 'fictional-portable-special';
  const restoreId = '11111111-1111-4111-8111-111111111111';
  const assistantId = '22222222-2222-4222-8222-222222222222';
  const restoreKey = `personal_restore_${restoreId}`;
  const assistantKey = `personal_assistant_${assistantId}`;
  const preference = {
    personId: 'fictional-person',
    record: { kind: 'note' as const, recordId: 'fictional-note' },
    alwaysWithhold: false,
    tags: ['reviewed'],
    version: 1,
    actor: 'profile-user',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const preferenceKey = packetPreferenceKey(preference.personId, preference.record);
  const restore = JSON.stringify({
    profileId,
    noteId: 'fictional-note',
    operationId: restoreId,
    fingerprint: 'fictional',
    previousVersion: 1,
    currentVersion: 2,
  });
  const assistant = JSON.stringify({
    profileId,
    noteId: 'fictional-note',
    proposalId: assistantId,
    kind: 'fictional',
    version: 1,
  });
  const raw =
    '{"format":"fictional","' +
    'y'.repeat(1_100_000) +
    '":{"ignored":"small"},"tables":{"evidence":[{"note":"' +
    'x'.repeat(1_100_000) +
    '"}]},"assistantOperations":' +
    JSON.stringify([{ key: assistantKey, value: assistant }]) +
    ',' +
    '"restoreOperations":[{"key":"obsolete","value":"first"}],' +
    '"restoreOperations":' +
    JSON.stringify([{ key: restoreKey, value: restore }]) +
    ',"packetPreferences":' +
    JSON.stringify([{ key: preferenceKey, value: JSON.stringify(preference) }]) +
    '}';
  writeFileSync(file, raw);
  const db = new DatabaseSync(join(directory, 'target.sqlite'));
  const transfer = createPortableProjectionTransfer(
    new Map([['app_meta', ['key', 'value']]]),
    () => {},
  );
  try {
    db.exec('CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    const originalParse = JSON.parse;
    t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
      if (args[0].length > 64 * 1024) throw Error('fictional whole-value JSON parse');
      return Reflect.apply(originalParse, JSON, args);
    });
    const selected = stagePortablePersonalSpecialRows(
      file,
      { bytes: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex') },
      transfer,
      0,
      profileId,
      () => {},
    );
    assert.equal(selected.nextOrdinal, 3);
    assert.deepEqual([...selected.fields].sort(), [
      '$assistantOperations',
      '$packetPreferences',
      '$restoreOperations',
    ]);
    transfer.assertInventory(new Map([['app_meta', 3]]));
    transfer.seal();
    transaction(db, () => {
      transfer.withTarget(db, currentTransactionToken(db)!, (target) => {
        assert.equal(target.apply('app_meta'), 3);
      });
    });
    transfer.assertReleased();
    assert.deepEqual(
      db
        .prepare('SELECT key,value FROM app_meta ORDER BY rowid')
        .all()
        .map((row) => ({ ...row })),
      [
        { key: restoreKey, value: restore },
        { key: assistantKey, value: assistant },
        { key: preferenceKey, value: JSON.stringify(preference) },
      ],
    );
  } finally {
    transfer.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an empty selected preference array still replaces curation preference keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-portable-empty-preferences-'));
  try {
    const file = join(directory, 'generation.json');
    const raw = '{"tables":{},"packetPreferences":[]}';
    writeFileSync(file, raw);
    const fields = selectedPortablePersonalSpecialFields(
      file,
      { bytes: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex') },
      () => {},
    );
    assert.equal(fields.has('$packetPreferences'), true);
    assert.equal(fields.has('$restoreOperations'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
