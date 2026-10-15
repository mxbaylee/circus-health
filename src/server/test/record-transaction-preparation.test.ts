import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { constants } from 'node:sqlite';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import {
  currentTransactionToken,
  observeTransactionBeforePublication,
  observeTransactionOutcome,
  observeTransactionStart,
  openDatabase,
  registerTransactionDurability,
  transaction,
  type TransactionOutcome,
} from '../database.ts';
import { recordMutationStatement } from '../record-mutation-recipe.ts';
import {
  prepareTerminalStatementsInTransaction,
  withTerminalStatements,
  terminalStatement,
  type PreparedTerminalStatements,
} from '../database-terminal-statements.ts';
import {
  discardRecordTransactionPreparation,
  prepareRecordTransaction,
  authenticateRecordTransactionPreparation,
  attachRecordDurability,
  tryObservePreparedRecordPublication,
} from '../record-versions.ts';
import {
  contributorAuthorityPath,
  openContributorRecordStorage,
} from '../contributor-record-storage.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-record-preparation-')),
    db = openDatabase(join(root, 'profile.sqlite'), 'fictional'),
    authority = memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, authority };
}
const operation = () => ({ operationId: randomUUID(), fingerprint: 'fictional-recipe' });
const write = "INSERT INTO app_meta(key,value) VALUES('fictional-prepared',?)";

test('only a genuine released preparation can retain a publication observer', async (t) => {
  const { db, authority } = fixture(t),
    head = Buffer.from(authority.objects.get('head')!);
  let preparedToken: object | undefined,
    discarded = 0,
    published = 0;
  const observer = {
    published() {
      published++;
    },
    discarded() {
      discarded++;
      // Membership is removed before any notification can reenter.
      assert.equal(tryObservePreparedRecordPublication(db, preparedToken!, observer), undefined);
    },
  };
  const remove = observeTransactionOutcome(db, (outcome) => {
    if (!outcome.prepared) return;
    assert.equal(outcome.committed, false);
    assert.equal(outcome.succeeded, false);
    preparedToken = outcome.token;
    assert.equal(tryObservePreparedRecordPublication(db, {}, observer), undefined);
    assert.equal(
      typeof tryObservePreparedRecordPublication(db, outcome.token, observer),
      'function',
    );
  });
  t.after(remove);
  await runExclusiveClinicalOperation(db, async () => {
    const preparation = prepareRecordTransaction(
      db,
      () => {
        recordMutationStatement(db, write).run('tentative');
        return { changed: true };
      },
      operation(),
    );
    assert.ok(preparedToken);
    assert.equal(discarded, 0);
    assert.equal(published, 0);
    discardRecordTransactionPreparation(db, preparation);
    assert.equal(discarded, 1);
    assert.equal(published, 0);
    assert.equal(tryObservePreparedRecordPublication(db, preparedToken!, observer), undefined);
  });
  assert.equal(db.isTransaction, false);
  assert.deepEqual(authority.objects.get('head'), head);
  assert.equal(
    db.prepare("SELECT value FROM app_meta WHERE key='fictional-prepared'").get(),
    undefined,
  );
});

test('tentative compilation requires the actual token and survives rollback without policy reentry', async (t) => {
  const { db } = fixture(t),
    sql = "SELECT value FROM app_meta WHERE key='fictional-prepared'";
  let capability: PreparedTerminalStatements | undefined,
    policies = 0;
  db.setAuthorizer(() => {
    policies++;
    return constants.SQLITE_OK;
  });
  const remove = observeTransactionBeforePublication(db, (token) => {
    assert.throws(() => prepareTerminalStatementsInTransaction(db, {}, { statements: [{ sql }] }));
    capability = prepareTerminalStatementsInTransaction(db, token, { statements: [{ sql }] });
  });
  await runExclusiveClinicalOperation(db, async () => {
    const preparation = prepareRecordTransaction(
      db,
      () => {
        recordMutationStatement(db, write).run('tentative');
        return { changed: true };
      },
      operation(),
    );
    try {
      assert.ok(capability);
      remove();
      const before = policies;
      withTerminalStatements(db, capability!, () => {
        assert.equal(terminalStatement(db, sql).get(), undefined);
      });
      assert.equal(policies, before);
      assert.equal(db.isTransaction, false);
    } finally {
      remove();
      discardRecordTransactionPreparation(db, preparation);
    }
  });
});

test('journal compilation preserves genuine tentative-row policy decisions before rollback', async (t) => {
  const { db, authority } = fixture(t),
    original = Buffer.from(authority.objects.get('head')!),
    pending = db.prepare("SELECT value FROM app_meta WHERE key='fictional-prepared'");
  let inspected = 0,
    token: object | undefined,
    inTransaction = false,
    tentativeValue: unknown;
  db.setAuthorizer((action, table) => {
    if (action === constants.SQLITE_INSERT && table === '__record_versions') {
      inspected++;
      inTransaction = db.isTransaction;
      token = currentTransactionToken(db);
      tentativeValue = pending.get()?.value;
      return constants.SQLITE_DENY;
    }
    return constants.SQLITE_OK;
  });
  await runExclusiveClinicalOperation(db, async () => {
    assert.throws(() =>
      prepareRecordTransaction(
        db,
        () => {
          recordMutationStatement(db, write).run('tentative');
          return { changed: true };
        },
        operation(),
      ),
    );
  });
  assert.ok(inspected > 0, 'denying installed policy must actually inspect genuine tentative rows');
  assert.equal(inTransaction, true);
  assert.ok(token);
  assert.equal(tentativeValue, 'tentative');
  assert.equal(currentTransactionToken(db), undefined);
  assert.equal(db.isTransaction, false);
  assert.equal(pending.get(), undefined);
  assert.deepEqual(authority.objects.get('head'), original);
});

function contributorFixture(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-prepared-predecessors-'))),
    paths = ensureProfileDirectories(root, 'fictional'),
    db = openDatabase(paths.database, 'fictional'),
    storage = openContributorRecordStorage(root, 'fictional', { initialize: true });
  attachRecordDurability(db, { profileId: 'fictional', storage });
  t.after(() => {
    storage.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, head: join(contributorAuthorityPath(root, 'fictional'), 'head') };
}

test('preparatory changed keys authenticate latest predecessors and true new-key absence without selecting HEAD', async (t) => {
  const { db, head } = contributorFixture(t);
  transaction(db, () => db.prepare(write).run('original fictional value'));
  const original = readFileSync(head);
  await runExclusiveClinicalOperation(db, async () => {
    const proof = prepareRecordTransaction(
      db,
      () => {
        recordMutationStatement(
          db,
          "UPDATE app_meta SET value=? WHERE key='fictional-prepared'",
        ).run('changed');
        recordMutationStatement(db, "INSERT INTO app_meta VALUES('fictional-new',?)").run('new');
        return { changed: 2 };
      },
      operation(),
    );
    try {
      await authenticateRecordTransactionPreparation(db, proof);
      await assert.rejects(
        authenticateRecordTransactionPreparation(db, proof),
        /owner unavailable/,
      );
      assert.deepEqual(readFileSync(head), original);
      assert.equal(
        db.prepare("SELECT value FROM app_meta WHERE key='fictional-prepared'").get()!.value,
        'original fictional value',
      );
      assert.equal(db.prepare("SELECT 1 FROM app_meta WHERE key='fictional-new'").get(), undefined);
    } finally {
      discardRecordTransactionPreparation(db, proof);
    }
  });
});

test('preparatory predecessor proof refuses a concealed matching cached version locator', async (t) => {
  const { db, head } = contributorFixture(t);
  transaction(db, () => db.prepare(write).run('original fictional value'));
  const original = readFileSync(head),
    selected = db
      .prepare(
        "SELECT version_id FROM main.__record_current WHERE entity='app_meta' AND record_id=?",
      )
      .get(JSON.stringify(['fictional-prepared']))!;
  db.prepare('UPDATE main.__record_versions SET contents_json=? WHERE version_id=?').run(
    JSON.stringify({ key: 'fictional-prepared', value: 'forged predecessor' }),
    selected.version_id,
  );
  await runExclusiveClinicalOperation(db, async () => {
    const proof = prepareRecordTransaction(
      db,
      () => {
        recordMutationStatement(
          db,
          "UPDATE app_meta SET value=? WHERE key='fictional-prepared'",
        ).run('changed');
        return { changed: 1 };
      },
      operation(),
    );
    try {
      await assert.rejects(
        authenticateRecordTransactionPreparation(db, proof),
        /predecessors changed, mismatched/,
      );
      assert.deepEqual(readFileSync(head), original);
      assert.equal(db.isTransaction, false);
    } finally {
      discardRecordTransactionPreparation(db, proof);
    }
  });
});

test('record preparation runs real tentative observers, rolls back and does not select history', async (t) => {
  const { db, authority } = fixture(t),
    head = Buffer.from(authority.objects.get('head')!),
    objects = authority.objects.size,
    outcomes: TransactionOutcome[] = [];
  let decisionCalls = 0,
    observedToken: object | undefined;
  const stopBefore = observeTransactionBeforePublication(db, (token) => {
      assert.equal(db.isTransaction, true);
      assert.equal(currentTransactionToken(db), token);
      observedToken = token;
      assert.equal(
        db.prepare("SELECT value FROM app_meta WHERE key='fictional-prepared'").get()?.value,
        'one',
      );
    }),
    stopOutcome = observeTransactionOutcome(db, (outcome) => outcomes.push(outcome));
  await runExclusiveClinicalOperation(db, async () => {
    const proof = prepareRecordTransaction(
      db,
      () => {
        decisionCalls++;
        recordMutationStatement(db, write).run('one');
        return { fictionalResult: 'one' };
      },
      operation(),
    );
    assert.equal(decisionCalls, 1);
    assert.equal(db.isTransaction, false);
    assert.equal(
      db.prepare("SELECT value FROM app_meta WHERE key='fictional-prepared'").get(),
      undefined,
    );
    assert.equal(db.prepare('SELECT COUNT(*) n FROM temp.__record_changed').get()!.n, 0);
    assert.deepEqual(authority.objects.get('head'), head);
    assert.equal(authority.objects.size, objects);
    assert.equal(outcomes.length, 1);
    assert.deepEqual(outcomes[0], {
      token: observedToken,
      committed: false,
      succeeded: false,
      prepared: true,
    });
    discardRecordTransactionPreparation(db, proof);
    assert.throws(
      () => discardRecordTransactionPreparation(db, proof),
      /foreign record transaction preparation/,
    );
  });
  stopBefore();
  stopOutcome();
  transaction(db, () => db.prepare(write).run('accepted'));
  assert.equal(
    db.prepare("SELECT value FROM app_meta WHERE key='fictional-prepared'").get()?.value,
    'accepted',
  );
  assert.notDeepEqual(authority.objects.get('head'), head);
});

test('record preparation preserves rollback when business logic throws', async (t) => {
  const { db, authority } = fixture(t),
    head = Buffer.from(authority.objects.get('head')!);
  await runExclusiveClinicalOperation(db, async () => {
    assert.throws(
      () =>
        prepareRecordTransaction(
          db,
          () => {
            recordMutationStatement(db, write).run('not-accepted');
            throw Error('fictional decision refused');
          },
          operation(),
        ),
      /fictional decision refused/,
    );
  });
  assert.equal(db.isTransaction, false);
  assert.equal(
    db.prepare("SELECT 1 FROM app_meta WHERE key='fictional-prepared'").get(),
    undefined,
  );
  assert.deepEqual(authority.objects.get('head'), head);
});

test('record preparation refuses callback SQL after rollback cleanup without accepting it', async (t) => {
  const { db, authority } = fixture(t),
    head = Buffer.from(authority.objects.get('head')!);
  let injected = false;
  const stop = observeTransactionOutcome(db, (outcome) => {
    if (!outcome.prepared) return;
    injected = true;
    db.prepare("INSERT INTO app_meta(key,value) VALUES('fictional-unowned','changed')").run();
  });
  await runExclusiveClinicalOperation(db, async () => {
    assert.throws(
      () =>
        prepareRecordTransaction(
          db,
          () => {
            recordMutationStatement(db, write).run('not-accepted');
            return 'fictional-result';
          },
          operation(),
        ),
      /changed during rollback cleanup/,
    );
  });
  stop();
  assert.equal(injected, true);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(authority.objects.get('head'), head);
  assert.throws(() => transaction(db, () => {}), /uncommitted direct writes/);
});

test('record preparation requires its genuine active operation and refuses a journal TEMP shadow', async (t) => {
  const { db, authority } = fixture(t),
    head = Buffer.from(authority.objects.get('head')!);
  assert.throws(
    () => prepareRecordTransaction(db, () => 'unused', operation()),
    /genuine record owner/,
  );
  db.exec('CREATE TEMP TABLE __record_versions AS SELECT * FROM main.__record_versions');
  await runExclusiveClinicalOperation(db, async () => {
    assert.throws(
      () =>
        prepareRecordTransaction(
          db,
          () => {
            recordMutationStatement(db, write).run('not-accepted');
            return null;
          },
          operation(),
        ),
      /TEMP shadow/,
    );
  });
  assert.equal(db.isTransaction, false);
  assert.deepEqual(authority.objects.get('head'), head);
});

test('record preparation refuses a foreign durability participant before its effects', async (t) => {
  const { db, authority } = fixture(t),
    head = Buffer.from(authority.objects.get('head')!);
  let invoked = false;
  registerTransactionDurability(db, {
    prepare() {
      invoked = true;
    },
  });
  await runExclusiveClinicalOperation(db, async () => {
    assert.throws(
      () =>
        prepareRecordTransaction(
          db,
          () => {
            recordMutationStatement(db, write).run('not-accepted');
            return 'unused';
          },
          operation(),
        ),
      /genuine record owner/,
    );
  });
  assert.equal(invoked, false);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(authority.objects.get('head'), head);
});

test('record preparation refuses start-observer participant replacement before dispatch', async (t) => {
  const { db, authority } = fixture(t),
    head = Buffer.from(authority.objects.get('head')!);
  let start = false,
    foreign = false;
  const stop = observeTransactionStart(db, () => {
    start = true;
    registerTransactionDurability(db, {
      begin() {
        foreign = true;
      },
      prepare() {
        foreign = true;
      },
      release() {
        foreign = true;
      },
    });
  });
  await runExclusiveClinicalOperation(db, async () => {
    assert.throws(
      () =>
        prepareRecordTransaction(
          db,
          () => {
            recordMutationStatement(db, write).run('not-accepted');
            return 'unused';
          },
          operation(),
        ),
      /preparation owner changed/,
    );
  });
  stop();
  assert.equal(start, true);
  assert.equal(foreign, false);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(authority.objects.get('head'), head);
});
