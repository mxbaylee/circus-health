import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  observeTransactionOutcome,
  openDatabase,
  prepareTerminalTransactionCallbacks,
  terminalTransactionCallbacksCurrent,
  transaction,
} from '../database.ts';
import { createTransactionOutcomeIssuer } from '../transaction-observer-issuer.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachRecordDurability, type RecordStorage } from '../record-versions.ts';
import { uploadIntake } from '../intake.ts';
import {
  MAX_SOURCE_DELTA_ROWS,
  SOURCE_DELTA_PAGE_ROWS,
  retainRecordAcceptedSourceDeltaCandidate,
  takeRecordAcceptedSourceDeltaChain,
  takeRecordAcceptedSourceDeltaCandidate,
} from '../record-accepted-source-delta.ts';

test('accepted source candidates are one-use and cannot mix outcome tokens', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const first = {},
      second = {},
      source = {
        recordId: '["fictional-source"]',
        versionId: 'fictional-version',
        previousVersion: null,
        deleted: false,
        contentsHash: 'a'.repeat(64),
        contentsBytes: 20,
        fields: [{ name: 'id', hash: 'b'.repeat(64), bytes: 16 }],
      };
    assert.equal(
      retainRecordAcceptedSourceDeltaCandidate(db, first, 'prior-1', 'head-1', 1, [source]),
      true,
    );
    assert.equal(
      retainRecordAcceptedSourceDeltaCandidate(db, first, 'forged', 'forged', 2, [source]),
      false,
    );
    assert.equal(
      retainRecordAcceptedSourceDeltaCandidate(db, second, 'head-1', 'head-2', 2, [source]),
      true,
    );
    source.fields[0]!.hash = 'c'.repeat(64);
    assert.equal(takeRecordAcceptedSourceDeltaCandidate(db, {}), undefined);
    const accepted = takeRecordAcceptedSourceDeltaCandidate(db, first);
    assert.equal(accepted?.headJson, 'head-1');
    assert.equal(accepted?.previousHeadJson, 'prior-1');
    assert.equal(accepted?.sequence, 1);
    assert.equal(accepted?.sources[0]?.fields[0]?.hash, 'b'.repeat(64));
    assert.equal(takeRecordAcceptedSourceDeltaCandidate(db, first), undefined);
    assert.equal(takeRecordAcceptedSourceDeltaCandidate(db, second)?.headJson, 'head-2');
    const overflow = {};
    assert.equal(
      retainRecordAcceptedSourceDeltaCandidate(
        db,
        overflow,
        'head-2',
        'head-3',
        3,
        Array.from({ length: MAX_SOURCE_DELTA_ROWS + 1 }, () => source),
      ),
      false,
    );
    assert.equal(takeRecordAcceptedSourceDeltaCandidate(db, overflow), undefined);
    const sourceFree = {};
    assert.equal(
      retainRecordAcceptedSourceDeltaCandidate(db, sourceFree, 'head-3', 'head-4', 4, []),
      true,
    );
    assert.deepEqual(takeRecordAcceptedSourceDeltaCandidate(db, sourceFree)?.sources, []);
  } finally {
    db.close();
  }
});

test('accepted source candidates page past one page and bound all retained rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const source = {
      recordId: '["fictional-source"]',
      versionId: 'fictional-version',
      previousVersion: null,
      deleted: false,
      contentsHash: 'a'.repeat(64),
      contentsBytes: 20,
      fields: [{ name: 'id', hash: 'b'.repeat(64), bytes: 16 }],
    };
    const rows = (length: number) => Array.from({ length }, () => source);
    // One page over the old single-page cap is retained whole.
    const paged = {};
    assert.equal(
      retainRecordAcceptedSourceDeltaCandidate(
        db,
        paged,
        'h0',
        'h1',
        1,
        rows(SOURCE_DELTA_PAGE_ROWS + 1),
      ),
      true,
    );
    assert.equal(
      takeRecordAcceptedSourceDeltaCandidate(db, paged)?.sources.length,
      SOURCE_DELTA_PAGE_ROWS + 1,
    );
    // Exactly the bound is retained; a later candidate evicts it rather than
    // letting retained rows exceed the per-connection bound.
    const full = {},
      next = {};
    assert.equal(
      retainRecordAcceptedSourceDeltaCandidate(
        db,
        full,
        'h1',
        'h2',
        2,
        rows(MAX_SOURCE_DELTA_ROWS),
      ),
      true,
    );
    assert.equal(retainRecordAcceptedSourceDeltaCandidate(db, next, 'h2', 'h3', 3, rows(1)), true);
    assert.equal(takeRecordAcceptedSourceDeltaCandidate(db, full), undefined);
    assert.equal(takeRecordAcceptedSourceDeltaCandidate(db, next)?.sources.length, 1);
  } finally {
    db.close();
  }
});

test('accepted outcome links are contiguous and one-use across source-free commits', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const first = {},
      second = {};
    assert.equal(retainRecordAcceptedSourceDeltaCandidate(db, first, 'h0', 'h1', 1, []), true);
    assert.equal(retainRecordAcceptedSourceDeltaCandidate(db, second, 'h1', 'h2', 2, []), true);
    assert.deepEqual(
      takeRecordAcceptedSourceDeltaChain(db, [first, second], 'h0', 0, 'h2')?.map(
        (item) => item.headJson,
      ),
      ['h1', 'h2'],
    );
    assert.equal(takeRecordAcceptedSourceDeltaChain(db, [first, second], 'h0', 0, 'h2'), undefined);
    const wrong = {};
    assert.equal(retainRecordAcceptedSourceDeltaCandidate(db, wrong, 'not-h2', 'h3', 3, []), true);
    assert.equal(takeRecordAcceptedSourceDeltaChain(db, [wrong], 'h2', 2, 'h3'), undefined);
  } finally {
    db.close();
  }
});

test('accepted outcome links refuse a sequence gap, a foreign outcome and a wrong final head', () => {
  const db = new DatabaseSync(':memory:');
  const other = new DatabaseSync(':memory:');
  try {
    const first = {},
      skipped = {};
    assert.equal(retainRecordAcceptedSourceDeltaCandidate(db, first, 'h0', 'h1', 1, []), true);
    assert.equal(retainRecordAcceptedSourceDeltaCandidate(db, skipped, 'h1', 'h2', 3, []), true);
    assert.equal(
      takeRecordAcceptedSourceDeltaChain(db, [first, skipped], 'h0', 0, 'h2'),
      undefined,
    );

    const foreign = {};
    assert.equal(retainRecordAcceptedSourceDeltaCandidate(other, foreign, 'h0', 'h1', 1, []), true);
    assert.equal(takeRecordAcceptedSourceDeltaChain(db, [foreign], 'h0', 0, 'h1'), undefined);
    assert.ok(takeRecordAcceptedSourceDeltaCandidate(other, foreign));

    const exact = {};
    assert.equal(retainRecordAcceptedSourceDeltaCandidate(db, exact, 'h0', 'h1', 1, []), true);
    assert.equal(takeRecordAcceptedSourceDeltaChain(db, [exact], 'h0', 0, 'h-other'), undefined);
    // A refused link is still consumed; it cannot be offered again.
    assert.equal(takeRecordAcceptedSourceDeltaCandidate(db, exact), undefined);
    assert.equal(takeRecordAcceptedSourceDeltaChain(db, [], 'h0', 0, 'h0'), undefined);
  } finally {
    db.close();
    other.close();
  }
});

test('ordinary accepted source publication retains only its successful outcome', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-source-delta-'));
  const profileId = 'fictional-source-delta';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const objects = new Map<string, Buffer>();
  const storage: RecordStorage = {
    read: (name) => objects.get(name) ?? null,
    writeImmutable: (name, value) => {
      assert.equal(objects.has(name), false);
      objects.set(name, Buffer.from(value));
    },
    publishHead: (value) => objects.set('head', Buffer.from(value)),
  };
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  attachRecordDurability(db, { profileId, storage });
  const outcomes: { token: object; committed: boolean; succeeded: boolean }[] = [];
  const stop = observeTransactionOutcome(db, (outcome) => outcomes.push(outcome));
  t.after(stop);
  uploadIntake(db, root, profileId, {
    filename: 'fictional.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional administrative source.'),
  });
  const accepted = outcomes
    .filter((outcome) => outcome.committed && outcome.succeeded)
    .map((outcome) => takeRecordAcceptedSourceDeltaCandidate(db, outcome.token))
    .filter((candidate) => candidate !== undefined && candidate.sources.length > 0);
  assert.equal(accepted.length, 1);
  assert.equal(typeof accepted[0]!.previousHeadJson, 'string');
  assert.equal(accepted[0]!.sources.length, 1);
  assert.equal(accepted[0]!.sources[0]!.deleted, false);
  assert.deepEqual(
    accepted[0]!.sources[0]!.fields.map((field) => field.name),
    ['id', 'kind', 'path', 'sha256', 'bytes'],
  );
  assert.throws(() =>
    transaction(db, () => {
      db.prepare(
        'UPDATE source_files SET kind=kind WHERE id=(SELECT id FROM source_files LIMIT 1)',
      ).run();
      throw Error('fictional rollback');
    }),
  );
  const rollback = outcomes.at(-1)!;
  assert.equal(rollback.committed, false);
  assert.equal(takeRecordAcceptedSourceDeltaCandidate(db, rollback.token), undefined);
  assert.throws(() => prepareTerminalTransactionCallbacks(db), /unsupported transaction callbacks/);
  stop();
  const terminal = prepareTerminalTransactionCallbacks(db);
  assert.equal(terminalTransactionCallbacksCurrent(db, terminal), true);
  const stopUntrusted = createTransactionOutcomeIssuer().observe(db, () => {});
  assert.equal(terminalTransactionCallbacksCurrent(db, terminal), false);
  assert.throws(() => prepareTerminalTransactionCallbacks(db), /unsupported transaction callbacks/);
  stopUntrusted();
  assert.doesNotThrow(() => prepareTerminalTransactionCallbacks(db));
  attachRecordDurability(db, { profileId, storage });
  assert.doesNotThrow(() => prepareTerminalTransactionCallbacks(db));
});
