import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { rebuildRecordDatabase } from '../record-versions.ts';
import { createIntakeStateStorage } from '../intake-state-storage.ts';
import {
  readIntakeEnvelope,
  readIntakeEnvelopeText,
  stageIntakeEnvelope,
} from '../intake-authority.ts';
import {
  intakeDetails,
  writeIntakeDetails,
  type IntakeDetails,
  maximumReportDiscoveryOrder,
  retainedReportAcceptance,
} from '../intake-state-access.ts';
import { readIntakeSourcePin, writeIntakeSourcePin } from '../intake-source-pin.ts';
import { createSourceDetailsSearch } from '../source-details-search.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';

const raw =
  '{ "before":"\\u0041", "dup":"hidden", "dup":"shown", "intake": { "originalName":"fictional.txt", "createdAt":"2026-01-01", "version":4, "proposals":[], "workflow":{"reportGroups":[{"discoveryOrder":17}],"reportAcceptances":[{"receipt":{"operationId":"fictional-retained"}}]} }, "after":"Ω" }';
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-activation-'));
  const profileId = 'fictional-activation';
  const db = openDatabase(join(root, 'cache.sqlite'), profileId);
  const authority = memoryRecordAuthority(db);
  const opened = [db];
  t.after(() => {
    for (const db of opened) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  registerRawIntakeFixture(db, 'original', raw);
  function rebuild() {
    const target = join(root, `reconstructed-${opened.length}.sqlite`);
    rebuildRecordDatabase(target, { profileId, storage: authority.storage });
    const next = openDatabase(target, profileId);
    authority.attach(next);
    opened.push(next);
    return next;
  }
  return { db, authority, rebuild };
}
function search(db: ReturnType<typeof openDatabase>, query: string) {
  const plan = createSourceDetailsSearch(db, query);
  try {
    return db
      .prepare(`SELECT f.id FROM source_files f ${plan.joins} WHERE ${plan.predicate}`)
      .all(...plan.parameters)
      .map((row) => row.id);
  } finally {
    plan.dispose();
  }
}

test('raw initial envelope stays exact through reads, lookup, search, pin-only writes and total cache reconstruction', (t) => {
  const { db, rebuild } = fixture(t);
  const compact = db
    .prepare('SELECT details_json FROM source_files WHERE id=?')
    .get('original')!.details_json;
  assert.equal(JSON.parse(String(compact)).intakeAuthority.mode, 'raw');
  assert.equal(Object.hasOwn(JSON.parse(String(compact)).intake, 'workflow'), false);
  const originalHead = db
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_v1:*:head'")
    .get()!;
  assert.equal(readIntakeEnvelopeText(db, { id: 'original' }), raw);
  assert.deepEqual(
    createIntakeStateStorage(db, {
      profileId: 'fictional-activation',
      intakeId: 'original',
      sourceHash: 'a'.repeat(64),
    }).read(),
    { raw },
  );
  assert.equal(maximumReportDiscoveryOrder(db), 17);
  assert.deepEqual(retainedReportAcceptance(db, 'fictional-retained'), {
    receipt: { operationId: 'fictional-retained' },
  });
  for (const query of ['hidden', '\\u0041', 'Ω', '"dup":"hidden", "dup":"shown"']) {
    const expected = Number(db.prepare('SELECT ? LIKE ? matched').get(raw, `%${query}%`)!.matched)
      ? ['original']
      : [];
    assert.deepEqual(search(db, query), expected);
  }
  transaction(db, () =>
    writeIntakeSourcePin(db, 'original', {
      revisionId: 'fictional-pin',
      dependencyToken: 'fictional-dependency',
      version: 2,
      requiresInterpretation: true,
    }),
  );
  assert.equal(
    intakeDetails(db, {
      id: 'original',
      kind: 'intake_original',
      details_json: String(compact),
      source_pin: JSON.stringify(readIntakeSourcePin(db, 'original')),
    }).version,
    6,
  );
  assert.equal(readIntakeEnvelopeText(db, { id: 'original' }), raw);
  assert.deepEqual(
    db.prepare('SELECT key,value FROM app_meta WHERE key=?').get(originalHead.key!),
    originalHead,
  );
  const next = rebuild();
  assert.equal(readIntakeEnvelopeText(next, { id: 'original' }), raw);
  assert.equal(maximumReportDiscoveryOrder(next), 17);
});

test('first supported rewrite normalizes once; failed publication preserves raw bytes and retry publishes coherent mode and state', (t) => {
  const { db, authority, rebuild } = fixture(t);
  const expected = JSON.parse(raw);
  expected.intake.version++;
  expected.intake.workflow.reportGroups[0].discoveryOrder = 18;
  const immutable = authority.storage.writeImmutable;
  authority.storage.writeImmutable = () => {
    throw Error('fictional immutable-write failure');
  };
  assert.throws(
    () =>
      transaction(db, () => {
        stageIntakeEnvelope(db, { id: 'original' }, expected);
      }),
    /immutable-write/,
  );
  authority.storage.writeImmutable = immutable;
  assert.equal(readIntakeEnvelopeText(db, { id: 'original' }), raw);
  const publish = authority.storage.publishHead;
  authority.storage.publishHead = () => {
    throw Error('fictional before-publication failure');
  };
  assert.throws(
    () =>
      transaction(db, () => {
        stageIntakeEnvelope(db, { id: 'original' }, expected);
      }),
    /before-publication/,
  );
  authority.storage.publishHead = publish;
  assert.equal(readIntakeEnvelopeText(db, { id: 'original' }), raw);
  assert.equal(
    JSON.parse(
      String(
        db.prepare('SELECT details_json FROM source_files WHERE id=?').get('original')!
          .details_json,
      ),
    ).intakeAuthority.mode,
    'raw',
  );
  transaction(db, () => {
    stageIntakeEnvelope(db, { id: 'original' }, expected);
  });
  assert.equal(readIntakeEnvelopeText(db, { id: 'original' }), JSON.stringify(expected));
  assert.equal(maximumReportDiscoveryOrder(db), 18);
  assert.equal(
    JSON.parse(
      String(
        db.prepare('SELECT details_json FROM source_files WHERE id=?').get('original')!
          .details_json,
      ),
    ).intakeAuthority.mode,
    'normalized',
  );
  assert.throws(
    () =>
      transaction(db, () => {
        stageIntakeEnvelope(db, { id: 'original' }, { raw });
      }),
    /intake|envelope/i,
  );
  assert.deepEqual(readIntakeEnvelope(rebuild(), { id: 'original' }), expected);
});

test('published normalized authority wins after SQL rollback and lost acknowledgement; reopen retains exact receipts', (t) => {
  const { db, authority, rebuild } = fixture(t);
  const expected = JSON.parse(raw);
  expected.intake.version++;
  expected.intake.workflow.reportGroups[0].discoveryOrder = 19;
  const publish = authority.storage.publishHead;
  authority.storage.publishHead = (bytes) => {
    publish(bytes);
    throw Error('fictional publication acknowledgement lost');
  };
  assert.throws(
    () =>
      transaction(db, () => {
        stageIntakeEnvelope(db, { id: 'original' }, expected);
      }),
    /acknowledgement lost/,
  );
  authority.storage.publishHead = publish;
  assert.throws(
    () => readIntakeEnvelopeText(db, { id: 'original' }),
    /accepted|authority|current|dirty|recovery/i,
  );
  const restored = rebuild();
  assert.equal(readIntakeEnvelopeText(restored, { id: 'original' }), JSON.stringify(expected));
  assert.equal(maximumReportDiscoveryOrder(restored), 19);
  assert.deepEqual(retainedReportAcceptance(restored, 'fictional-retained'), {
    receipt: { operationId: 'fictional-retained' },
  });
  transaction(restored, () => {
    stageIntakeEnvelope(restored, { id: 'original' }, expected);
  });
  assert.deepEqual(retainedReportAcceptance(restored, 'fictional-retained'), {
    receipt: { operationId: 'fictional-retained' },
  });
});

test('warm readers refuse selected-head corruption, source rebinding and duplicated operational source metadata', (t) => {
  const { db } = fixture(t);
  maximumReportDiscoveryOrder(db);
  search(db, 'hidden');
  const head = db
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_v1:*:head'")
    .get()!;
  for (const mutation of [
    () => db.prepare('DELETE FROM app_meta WHERE key=?').run(head.key!),
    () =>
      db
        .prepare('UPDATE app_meta SET value=? WHERE key=?')
        .run('{"format":"unsupported-fictional-v999"}', head.key!),
    () => db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('b'.repeat(64), 'original'),
    () => db.prepare('UPDATE source_files SET kind=? WHERE id=?').run('derived', 'original'),
    () => {
      const compact = JSON.parse(
        String(
          db.prepare('SELECT details_json FROM source_files WHERE id=?').get('original')!
            .details_json,
        ),
      );
      compact.intake.workflow = { reportGroups: [] };
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
        JSON.stringify(compact),
        'original',
      );
    },
  ]) {
    assert.throws(
      () =>
        transaction(db, () => {
          mutation();
          maximumReportDiscoveryOrder(db);
        }),
      /authority|intake|source|head|missing|schema/i,
    );
    assert.throws(
      () =>
        transaction(db, () => {
          mutation();
          search(db, 'hidden');
        }),
      /authority|intake|source|head|missing|schema/i,
    );
    assert.equal(readIntakeEnvelopeText(db, { id: 'original' }), raw);
  }
});

test('warm lookup and search follow actual selected app_meta head changes and restore after rollback', (t) => {
  const { db } = fixture(t);
  const initial = JSON.parse(raw);
  transaction(db, () => {
    stageIntakeEnvelope(db, { id: 'original' }, initial);
  });
  const selected = db
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_v1:*:head'")
    .get()!;
  assert.equal(maximumReportDiscoveryOrder(db), 17);
  assert.deepEqual(search(db, 'fictional-head-only-term'), []);
  assert.throws(
    () =>
      transaction(db, () => {
        const changed = JSON.parse(JSON.stringify(initial));
        changed.intake.workflow.reportGroups[0].discoveryOrder = 33;
        changed.intake.workflow.fictional = 'fictional-head-only-term';
        stageIntakeEnvelope(db, { id: 'original' }, changed);
        assert.equal(maximumReportDiscoveryOrder(db), 33);
        assert.deepEqual(search(db, 'fictional-head-only-term'), ['original']);
        db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(selected.value!, selected.key!);
        assert.equal(maximumReportDiscoveryOrder(db), 17);
        assert.deepEqual(search(db, 'fictional-head-only-term'), []);
        throw Error('fictional selected-head rollback');
      }),
    /selected-head rollback/,
  );
  assert.equal(readIntakeEnvelopeText(db, { id: 'original' }), JSON.stringify(initial));
  assert.equal(maximumReportDiscoveryOrder(db), 17);
  assert.deepEqual(search(db, 'fictional-head-only-term'), []);
});

test('raw normalization has one initial full cost; later distant operational edits omit unchanged middle and compact source writes', (t) => {
  const { db, authority } = fixture(t);
  const middle = 'Independently fictional retained middle Ω. '.repeat(3000);
  const original = {
    intake: { originalName: 'locality.txt', version: 1, middle, workflow: { scalar: 'initial' } },
  };
  const initialRaw = ' { "intake" : ' + JSON.stringify(original.intake) + ' } ';
  registerRawIntakeFixture(db, 'locality', initialRaw);
  db.exec(`CREATE TEMP TABLE locality_writes(kind TEXT,bytes INTEGER);
    CREATE TEMP TRIGGER locality_source_updates AFTER UPDATE ON main.source_files WHEN NEW.id='locality' BEGIN INSERT INTO locality_writes VALUES('source',length(CAST(NEW.details_json AS BLOB))); END;
    CREATE TEMP TRIGGER locality_frames AFTER INSERT ON main.app_meta WHEN NEW.key GLOB 'intake_state_v1:*:frame:*' BEGIN INSERT INTO locality_writes VALUES('frame',length(CAST(NEW.value AS BLOB))); END;`);
  const immutable = authority.storage.writeImmutable;
  const publish = authority.storage.publishHead;
  let acceptedBytes = 0;
  authority.storage.writeImmutable = (name, bytes) => {
    acceptedBytes += bytes.length;
    immutable(name, bytes);
  };
  authority.storage.publishHead = (bytes) => {
    acceptedBytes += bytes.length;
    publish(bytes);
  };
  const write = (next: typeof original) =>
    transaction(db, () => {
      const row = db
        .prepare('SELECT id,kind,details_json FROM source_files WHERE id=?')
        .get('locality')! as { id: string; kind: string; details_json: string };
      writeIntakeDetails(db, row, next.intake as unknown as IntakeDetails, { effective: false });
    });
  const first = { intake: { ...original.intake, version: 2, workflow: { scalar: 'first' } } };
  write(first);
  const initialCost = Number(
    db.prepare("SELECT sum(bytes) n FROM locality_writes WHERE kind='frame'").get()!.n,
  );
  assert.ok(
    initialCost > Buffer.byteLength(middle),
    'the first authorized normalization discloses the full envelope cost',
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM locality_writes WHERE kind='source'").get()!.n,
    1,
  );
  assert.equal(readIntakeEnvelopeText(db, { id: 'locality' }), JSON.stringify(first));
  db.exec('DELETE FROM locality_writes');
  acceptedBytes = 0;
  const second = { intake: { ...first.intake, version: 3, workflow: { scalar: 'second' } } };
  write(second);
  const laterCost = Number(
    db.prepare("SELECT sum(bytes) n FROM locality_writes WHERE kind='frame'").get()!.n,
  );
  assert.ok(laterCost < 4096, `later distant edit emitted ${laterCost} primitive frame bytes`);
  assert.ok(
    acceptedBytes < 16 * 1024,
    `later distant edit published ${acceptedBytes} total accepted bytes`,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM locality_writes WHERE kind='source'").get()!.n,
    0,
    'unchanged compact metadata does not receive a new source row version',
  );
  assert.equal(readIntakeEnvelopeText(db, { id: 'locality' }), JSON.stringify(second));
});
