import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentTransactionToken, transaction } from '../database.ts';
import {
  assertPortableProjectionTarget,
  assertPortableProjectionTransfer,
  createPortableProjectionTransfer,
} from '../portable-projection-transfer.ts';

test('portable transfer stages a large fictional row inside one target transaction', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-portable-projection-'));
  const db = new DatabaseSync(join(directory, 'target.sqlite'));
  const transfer = createPortableProjectionTransfer(
    new Map([['items', ['id', 'note', 'quantity', 'weight', 'optional']]]),
    () => {},
  );
  const note = 'a'.repeat(40_000) + '😀\u0000Ω'.repeat(60_000);
  const pieces = () =>
    (function* () {
      for (let at = 0; at < note.length;) {
        let end = Math.min(note.length, at + 4096);
        if (end < note.length && /[\uD800-\uDBFF]/.test(note[end - 1]!)) end--;
        yield note.slice(at, end);
        at = end;
      }
    })();
  try {
    db.exec(
      `CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
       INSERT INTO app_meta VALUES('revision','0'),('clinical_review_revision','0');
       CREATE TABLE items(id TEXT PRIMARY KEY,note TEXT,quantity INTEGER,weight REAL,optional TEXT)`,
    );
    assertPortableProjectionTransfer(transfer);
    assert.throws(() => assertPortableProjectionTransfer({ ...transfer }), /identity changed/);
    transfer.putRow('items', 0, [
      { name: 'id', kind: 'text', pieces: () => ['fictional'] },
      { name: 'note', kind: 'text', pieces },
      { name: 'quantity', kind: 'number', value: 7 },
      { name: 'weight', kind: 'number', value: 1.25 },
      { name: 'optional', kind: 'null' },
    ]);
    transfer.putRow('items', 1, [
      { name: 'id', kind: 'text', pieces: () => ['split'] },
      { name: 'note', kind: 'text', pieces: () => ['\ud83d', '\ude00'] },
    ]);
    assert.throws(() => transfer.assertInventory(new Map([['items', 1]])), /inventory changed/);
    transfer.assertInventory(new Map([['items', 2]]));
    assert.throws(
      () => transfer.putRow('items', 2, [{ name: 'id', kind: 'null' }]),
      /Invalid portable projection row/,
    );
    transfer.seal();
    assert.throws(
      () =>
        transaction(db, () => {
          transfer.withTarget(db, currentTransactionToken(db)!, (target) => {
            assertPortableProjectionTarget(target, transfer, db, currentTransactionToken(db)!);
            assert.throws(
              () =>
                assertPortableProjectionTarget(
                  { ...target },
                  transfer,
                  db,
                  currentTransactionToken(db)!,
                ),
              /identity changed/,
            );
            assert.equal(target.apply('items'), 2);
          });
          throw Error('fictional late abort');
        }),
      /fictional late abort/,
    );
    transfer.assertReleased();
    assert.equal(db.prepare('SELECT count(*) AS n FROM items').get()!.n, 0);
    transaction(db, () => {
      transfer.withTarget(db, currentTransactionToken(db)!, (target) => {
        assert.equal(target.apply('items'), 2);
      });
    });
    transfer.assertReleased();
    const row = db.prepare("SELECT * FROM items WHERE id='fictional'").get()!;
    assert.equal(row.id, 'fictional');
    assert.equal(row.note, note);
    assert.equal(row.quantity, 7);
    assert.equal(row.weight, 1.25);
    assert.equal(row.optional, null);
    assert.equal(db.prepare("SELECT note FROM items WHERE id='split'").get()!.note, '😀');
  } finally {
    transfer.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('portable transfer refuses changed source pieces without sealing', () => {
  let calls = 0;
  const transfer = createPortableProjectionTransfer(new Map([['items', ['note']]]), () => {});
  try {
    assert.throws(
      () =>
        transfer.putRow('items', 0, [
          {
            name: 'note',
            kind: 'text',
            pieces: () => [++calls === 1 ? 'before' : 'after'],
          },
        ]),
      /source changed during write/,
    );
    assert.throws(() => transfer.seal(), /unavailable/);
  } finally {
    transfer.close();
  }
});
