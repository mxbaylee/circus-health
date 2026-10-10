import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, registerTransactionDurability, transaction } from '../database.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import {
  consumeIntakeDiscoveryAdmission,
  disposeIntakeDiscoveryAdmission,
  prepareIntakeDiscoveryAdmission,
} from '../intake-discovery-admission.ts';
import {
  clearIntakeLookupCache,
  intakeLookupProjectionGeneration,
  prepareIntakeLookupProjection,
} from '../intake-lookup-projection.ts';
import { intakeDiscoveryRevision, prepareIntakeLookupIndices } from '../intake-lookup-state.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { clearIntakeCollectionCache } from '../intake-state-collections.ts';
import { clearIdentityGrounding } from '../intake-identity-grounding.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
  writeIntakeFixtureEnvelope,
} from './helpers/intake-authority-fixture.ts';

function fixture(t: import('node:test').TestContext, count: number) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-discovery-admission-'));
  const db = openDatabase(join(root, 'cache.sqlite'), 'fictional-profile');
  const authority = memoryRecordAuthority(db);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  if (count) {
    transaction(db, () => {
      for (let index = 0; index < count; index++) {
        const id = `fictional-original-${index}`;
        const envelope = { intake: { version: index + 1 } };
        registerRawIntakeFixture(db, id, JSON.stringify(envelope));
        writeIntakeFixtureEnvelope(db, id, envelope);
      }
    });
  }
  return { db, authority, path: join(root, 'cache.sqlite') };
}

test('current complete lookup proof admits without a second original frontier scan', async (t) => {
  const { db } = fixture(t, 8);
  for (let index = 0; index < 8; index++)
    await buildIntakeCollectionEnvelope(db, { id: `fictional-original-${index}` });
  const prepared = await prepareIntakeLookupIndices(db);
  const prepare = db.prepare.bind(db);
  let frontierStatements = 0;
  db.prepare = ((sql: string) => {
    if (sql.includes('frontier_rowid')) frontierStatements++;
    return prepare(sql);
  }) as typeof db.prepare;
  t.after(() => {
    db.prepare = prepare;
  });
  await runExclusiveClinicalOperation(db, async () => {
    const admission = await prepareIntakeDiscoveryAdmission(db, prepared.discoveryRevision);
    try {
      assert.equal(frontierStatements, 0);
      clearIntakeLookupCache(db);
      assert.throws(
        () => transaction(db, () => consumeIntakeDiscoveryAdmission(db, admission)),
        /frontier admission changed/,
      );
    } finally {
      disposeIntakeDiscoveryAdmission(admission);
    }
  });
});

test('unknown SQL invalidates the lookup shortcut and rechecks the complete frontier', async (t) => {
  const { db } = fixture(t, 1);
  await buildIntakeCollectionEnvelope(db, { id: 'fictional-original-0' });
  const prepared = await prepareIntakeLookupIndices(db);
  transaction(db, () => {
    db.exec("UPDATE source_files SET details_json=details_json WHERE kind='intake_original'");
  });
  const prepare = db.prepare.bind(db);
  let frontierRows = 0;
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.includes('frontier_rowid')) {
      const get = statement.get.bind(statement);
      statement.get = ((...args: Parameters<typeof get>) => {
        const value = get(...args);
        if (value) frontierRows++;
        return value;
      }) as typeof statement.get;
    }
    return statement;
  }) as typeof db.prepare;
  t.after(() => {
    db.prepare = prepare;
  });
  await runExclusiveClinicalOperation(db, async () => {
    const admission = await prepareIntakeDiscoveryAdmission(db, prepared.discoveryRevision);
    try {
      assert.equal(frontierRows, 1);
      transaction(db, () => consumeIntakeDiscoveryAdmission(db, admission));
    } finally {
      disposeIntakeDiscoveryAdmission(admission);
    }
  });
});

test('complete legacy frontier keeps the original digest and yields after at most 64 rows', async (t) => {
  const { db } = fixture(t, 65);
  await runExclusiveClinicalOperation(db, async () => {
    const expected = intakeDiscoveryRevision(db);
    const checkpoints: number[] = [];
    const admission = await prepareIntakeDiscoveryAdmission(db, expected, {
      onCheckpoint: (visited) => {
        checkpoints.push(visited);
      },
    });
    try {
      assert.deepEqual(checkpoints, [64]);
      transaction(db, () => consumeIntakeDiscoveryAdmission(db, admission));
    } finally {
      disposeIntakeDiscoveryAdmission(admission);
    }
  });
});

test('empty frontier is admitted once and cannot cross another transaction', async (t) => {
  const { db } = fixture(t, 0);
  await runExclusiveClinicalOperation(db, async () => {
    const admission = await prepareIntakeDiscoveryAdmission(db, intakeDiscoveryRevision(db));
    transaction(db, () => consumeIntakeDiscoveryAdmission(db, admission));
    assert.throws(
      () => transaction(db, () => consumeIntakeDiscoveryAdmission(db, admission)),
      /frontier admission changed/,
    );
    disposeIntakeDiscoveryAdmission(admission);

    const stale = await prepareIntakeDiscoveryAdmission(db, intakeDiscoveryRevision(db));
    transaction(db, () => undefined);
    assert.throws(
      () => transaction(db, () => consumeIntakeDiscoveryAdmission(db, stale)),
      /frontier admission changed/,
    );
    disposeIntakeDiscoveryAdmission(stale);
  });
});

test('a caught stale admission poisons the transaction', async (t) => {
  const { db } = fixture(t, 1);
  await runExclusiveClinicalOperation(db, async () => {
    const admission = await prepareIntakeDiscoveryAdmission(db, intakeDiscoveryRevision(db));
    assert.throws(
      () =>
        transaction(db, () => {
          consumeIntakeDiscoveryAdmission(db, admission);
          assert.throws(
            () => consumeIntakeDiscoveryAdmission(db, admission),
            /frontier admission changed/,
          );
        }),
      /frontier admission changed/,
    );
    disposeIntakeDiscoveryAdmission(admission);
  });
});

test('a callback mutation across the checkpoint cannot restamp the original proof', async (t) => {
  const { db } = fixture(t, 65);
  await runExclusiveClinicalOperation(db, async () => {
    const expected = intakeDiscoveryRevision(db);
    let reached = false;
    await assert.rejects(
      prepareIntakeDiscoveryAdmission(db, expected, {
        onCheckpoint: () => {
          reached = true;
          db.exec("UPDATE app_meta SET value=value WHERE key='owner_profile_id'");
        },
      }),
      /frontier admission changed/,
    );
    assert.equal(reached, true);
  });
});

test('a rolled-back no-op write across a host turn invalidates admission', async (t) => {
  const { db } = fixture(t, 65);
  await runExclusiveClinicalOperation(db, async () => {
    const expected = intakeDiscoveryRevision(db);
    await assert.rejects(
      prepareIntakeDiscoveryAdmission(db, expected, {
        onCheckpoint: () => {
          db.exec('BEGIN');
          db.exec("UPDATE app_meta SET value=value WHERE key='owner_profile_id'");
          db.exec('ROLLBACK');
        },
      }),
      /frontier admission changed/,
    );
  });
});

test('cache generation revocation after mint refuses without a new SQL stamp', async (t) => {
  const { db } = fixture(t, 1);
  await runExclusiveClinicalOperation(db, async () => {
    const admission = await prepareIntakeDiscoveryAdmission(db, intakeDiscoveryRevision(db));
    clearIntakeCollectionCache(db);
    assert.throws(
      () => transaction(db, () => consumeIntakeDiscoveryAdmission(db, admission)),
      /frontier admission changed/,
    );
    disposeIntakeDiscoveryAdmission(admission);
  });
});

test('a peer commit across the checkpoint invalidates the original connection proof', async (t) => {
  const { db, path } = fixture(t, 65);
  await runExclusiveClinicalOperation(db, async () => {
    const expected = intakeDiscoveryRevision(db);
    await assert.rejects(
      prepareIntakeDiscoveryAdmission(db, expected, {
        onCheckpoint: () => {
          const peer = openDatabase(path, 'fictional-profile');
          try {
            peer.exec("INSERT INTO app_meta(key,value) VALUES('fictional-peer-aux','changed')");
          } finally {
            peer.close();
          }
        },
      }),
      /frontier admission changed/,
    );
  });
});

test('loss of the physical accepted HEAD across a checkpoint refuses admission', async (t) => {
  const { db, authority } = fixture(t, 65);
  await runExclusiveClinicalOperation(db, async () => {
    const expected = intakeDiscoveryRevision(db);
    await assert.rejects(
      prepareIntakeDiscoveryAdmission(db, expected, {
        onCheckpoint: () => {
          authority.objects.set('head', Buffer.from('{}'));
        },
      }),
      /Record journal: invalid head/,
    );
  });
});

test('exact negative and unsafe-positive rowids preserve the original ordered digest', async (t) => {
  const { db } = fixture(t, 3);
  transaction(db, () => {
    db.prepare('UPDATE source_files SET rowid=? WHERE id=?').run(
      -9007199254740993n,
      'fictional-original-0',
    );
    db.prepare('UPDATE source_files SET rowid=? WHERE id=?').run(
      9007199254740993n,
      'fictional-original-2',
    );
  });
  await runExclusiveClinicalOperation(db, async () => {
    const admission = await prepareIntakeDiscoveryAdmission(db, intakeDiscoveryRevision(db));
    try {
      transaction(db, () => consumeIntakeDiscoveryAdmission(db, admission));
    } finally {
      disposeIntakeDiscoveryAdmission(admission);
    }
  });
});

for (const schema of ['main', 'TEMP'] as const) {
  test(`${schema} schema drift across a checkpoint invalidates admission`, async (t) => {
    const { db } = fixture(t, 65);
    await runExclusiveClinicalOperation(db, async () => {
      const expected = intakeDiscoveryRevision(db);
      await assert.rejects(
        prepareIntakeDiscoveryAdmission(db, expected, {
          onCheckpoint: () =>
            db.exec(`CREATE ${schema === 'TEMP' ? 'TEMP ' : ''}TABLE fictional_drift(x)`),
        }),
        /frontier admission changed/,
      );
    });
  });
}

test('an unconsumed admission expires on rollback, operation end, or another database', async (t) => {
  const { db } = fixture(t, 1);
  const other = fixture(t, 0).db;
  const expected = intakeDiscoveryRevision(db);
  const admission = await runExclusiveClinicalOperation(db, async () =>
    prepareIntakeDiscoveryAdmission(db, expected),
  );
  assert.throws(
    () => transaction(other, () => consumeIntakeDiscoveryAdmission(other, admission)),
    /frontier admission changed/,
  );
  assert.throws(
    () => transaction(db, () => consumeIntakeDiscoveryAdmission(db, admission)),
    /frontier admission changed/,
  );
  disposeIntakeDiscoveryAdmission(admission);
  await runExclusiveClinicalOperation(db, async () => {
    const fresh = await prepareIntakeDiscoveryAdmission(db, intakeDiscoveryRevision(db));
    assert.throws(
      () =>
        transaction(db, () => {
          throw Error('fictional rollback');
        }),
      /fictional rollback/,
    );
    assert.throws(
      () => transaction(db, () => consumeIntakeDiscoveryAdmission(db, fresh)),
      /frontier admission changed/,
    );
    disposeIntakeDiscoveryAdmission(fresh);
  });
});

for (const phase of ['begin', 'capture'] as const) {
  test(`${phase} hook writes before consume refuse even if the caller catches the error`, async (t) => {
    const { db } = fixture(t, 1);
    await runExclusiveClinicalOperation(db, async () => {
      const admission = await prepareIntakeDiscoveryAdmission(db, intakeDiscoveryRevision(db));
      const mutate = () => {
        db.exec("UPDATE app_meta SET value=value WHERE key='owner_profile_id'");
      };
      registerTransactionDurability(db, {
        begin: phase === 'begin' ? mutate : undefined,
        capture: phase === 'capture' ? mutate : undefined,
        prepare: () => {},
      });
      assert.throws(
        () =>
          transaction(db, () => {
            assert.throws(
              () => consumeIntakeDiscoveryAdmission(db, admission),
              /frontier admission changed/,
            );
          }),
        /frontier admission changed/,
      );
      disposeIntakeDiscoveryAdmission(admission);
    });
  });
}

test('late raw-read callback revocation closes the terminal generation seal', async (t) => {
  const { db } = fixture(t, 1);
  await runExclusiveClinicalOperation(db, async () => {
    prepareIntakeLookupProjection(db);
    assert.ok(intakeLookupProjectionGeneration(db));
    const admission = await prepareIntakeDiscoveryAdmission(db, intakeDiscoveryRevision(db));
    const prepare = db.prepare.bind(db);
    let rawReads = 0;
    db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (sql === 'PRAGMA temp.schema_version' && db.isTransaction) {
        const get = statement.get.bind(statement);
        statement.get = (() => {
          const result = get();
          if (++rawReads === 2) {
            clearIntakeCollectionCache(db);
            clearIdentityGrounding(db);
            clearIntakeLookupCache(db);
          }
          return result;
        }) as typeof statement.get;
      }
      return statement;
    }) as typeof db.prepare;
    try {
      assert.throws(
        () => transaction(db, () => consumeIntakeDiscoveryAdmission(db, admission)),
        /frontier admission changed/,
      );
      assert.equal(rawReads, 2);
    } finally {
      db.prepare = prepare;
      disposeIntakeDiscoveryAdmission(admission);
    }
  });
});

test('clinical-operation cancellation at a checkpoint leaves no admission', async (t) => {
  const { db } = fixture(t, 65);
  const controller = new AbortController();
  const expected = intakeDiscoveryRevision(db);
  let reached = false;
  await assert.rejects(
    runExclusiveClinicalOperation(
      db,
      async () => {
        await prepareIntakeDiscoveryAdmission(db, expected, {
          onCheckpoint: () => {
            reached = true;
            controller.abort(Error('fictional cancellation'));
          },
        });
      },
      { signal: controller.signal },
    ),
    /fictional cancellation/,
  );
  assert.equal(reached, true);
});

test('database close at a checkpoint refuses before a resumed SQL read', async (t) => {
  const { db } = fixture(t, 65);
  const expected = intakeDiscoveryRevision(db);
  let reached = false;
  await assert.rejects(
    runExclusiveClinicalOperation(db, async () => {
      await prepareIntakeDiscoveryAdmission(db, expected, {
        onCheckpoint: () => {
          reached = true;
          db.close();
        },
      });
    }),
    /frontier admission changed/,
  );
  assert.equal(reached, true);
  assert.equal(db.isOpen, false);
});
