import assert from 'node:assert/strict';
import test from 'node:test';
import {
  openDatabase,
  currentTransactionToken,
  installTransactionTerminalGuard,
  observeTransactionBeforePublication,
  rejectCurrentTransaction,
  transaction,
} from '../database.ts';

test('a terminal observer rejection rolls back before durability publication', () => {
  const db = openDatabase(':memory:', 'fictional-owner');
  try {
    db.exec('CREATE TABLE fictional_rows(value TEXT NOT NULL)');
    const stop = observeTransactionBeforePublication(db, () => {
      rejectCurrentTransaction(db, Error('Fictional physical evidence changed'));
    });
    try {
      assert.throws(
        () =>
          transaction(db, () =>
            db.prepare("INSERT INTO fictional_rows VALUES('not accepted')").run(),
          ),
        /Fictional physical evidence changed/,
      );
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM fictional_rows').get()!.n), 0);
    } finally {
      stop();
    }
  } finally {
    db.close();
  }
});

test('the final physical guard runs after observers and rolls back their mutation', () => {
  const db = openDatabase(':memory:', 'fictional-owner');
  try {
    db.exec('CREATE TABLE fictional_rows(value TEXT NOT NULL)');
    let epoch = 0;
    const stop = observeTransactionBeforePublication(db, () => {
      epoch++;
    });
    try {
      assert.throws(
        () =>
          transaction(db, () => {
            const token = currentTransactionToken(db)!;
            installTransactionTerminalGuard(db, token, () => {
              if (epoch !== 0) throw Error('Fictional physical evidence changed');
            });
            db.prepare("INSERT INTO fictional_rows VALUES('not accepted')").run();
          }),
        /Fictional physical evidence changed/,
      );
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM fictional_rows').get()!.n), 0);
    } finally {
      stop();
    }
  } finally {
    db.close();
  }
});

test('a competing terminal guard cannot replace the owning guard', () => {
  const db = openDatabase(':memory:', 'fictional-owner');
  try {
    transaction(db, () => {
      const token = currentTransactionToken(db)!;
      installTransactionTerminalGuard(db, token, () => {});
      assert.throws(
        () => installTransactionTerminalGuard(db, token, () => {}),
        /Foreign or competing/,
      );
    });
  } finally {
    db.close();
  }
});
