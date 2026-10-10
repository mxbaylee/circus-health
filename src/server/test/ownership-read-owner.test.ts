import assert from 'node:assert/strict';
import test from 'node:test';
import { constants } from 'node:sqlite';
import { openDatabase } from '../database.ts';
import {
  captureOwnershipReadInterval,
  assertOwnershipReadInterval,
  closeOwnershipReadInterval,
} from '../ownership-read-owner.ts';

test('ownership read native stamps never dispatch a policy after their original compilation', () => {
  const db = openDatabase(':memory:', 'fictional');
  let calls = 0;
  db.setAuthorizer(() => {
    calls++;
    return constants.SQLITE_OK;
  });
  try {
    const interval = captureOwnershipReadInterval(db),
      before = calls;
    assertOwnershipReadInterval(db, interval);
    assertOwnershipReadInterval(db, interval);
    assert.equal(calls, before);
    closeOwnershipReadInterval(interval);
    assert.throws(() => assertOwnershipReadInterval(db, interval));
  } finally {
    db.close();
  }
});

test('ownership read interval retains zero-row source attempts and failed builtin replacement', () => {
  const db = openDatabase(':memory:', 'fictional');
  try {
    let interval = captureOwnershipReadInterval(db);
    db.prepare('UPDATE source_files SET bytes=bytes WHERE 0').run();
    assert.throws(() => assertOwnershipReadInterval(db, interval));
    closeOwnershipReadInterval(interval);
    interval = captureOwnershipReadInterval(db);
    let calls = 0;
    assert.throws(() =>
      db.function('TOTAL_CHANGES', () => {
        calls++;
        return 0;
      }),
    );
    assert.throws(() => assertOwnershipReadInterval(db, interval));
    assert.equal(calls, 0);
    closeOwnershipReadInterval(interval);
  } finally {
    db.close();
  }
});
