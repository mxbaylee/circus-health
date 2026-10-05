/** Focused fictional owner tests; this memory map is not a contributor/backend IO oracle. */
import assert from 'node:assert/strict';
import { copyFileSync, renameSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  createIdentitySnapshotDelta,
  identitySnapshotDeltaCertificate,
} from '../intake-identity-snapshot-delta.ts';
import type {
  ReportSnapshotMapReader,
  ReportSnapshotMapWriter,
  ReportSnapshotPage,
} from '../intake-report-snapshot-catalog.ts';

class FictionalMap implements ReportSnapshotMapWriter {
  readonly values: Map<string, string>;
  readonly changed: string[] = [];
  readonly removed: string[] = [];
  readonly batches: number[] = [];
  constructor(values: Iterable<[string, string]> = []) {
    this.values = new Map(values);
  }
  assertCurrent() {}
  get(key: string) {
    return this.values.get(key);
  }
  reference() {
    return undefined;
  }
  preceding(key: string) {
    const found = [...this.values.keys()]
      .sort()
      .filter((value) => value < key)
      .at(-1);
    return found === undefined ? undefined : { key: found, value: this.values.get(found)! };
  }
  range(page: ReportSnapshotPage) {
    const keys = [...this.values.keys()].sort().filter((key) => !page.after || key > page.after),
      items = keys.slice(0, page.items).map((key) => ({ key, value: this.values.get(key)! }));
    // Like the real byte-reference owner, page metadata stays small even for long text.
    const bytes = items.reduce(
        (total, item) => total + item.key.length + Math.min(64, item.value.length),
        0,
      ),
      complete = items.length === keys.length;
    return {
      items,
      bytes,
      count: this.values.size,
      complete,
      after: complete ? null : items.at(-1)!.key,
    };
  }
  bytePage(): never {
    throw Error('Fictional delta map does not expose byte pages');
  }
  *chunks(key: string) {
    const value = this.values.get(key);
    if (value === undefined) throw Error('Fictional missing retained text');
    for (let at = 0; at < value.length; at += 19) yield value.slice(at, at + 19);
  }
  async put(key: string, value: string) {
    this.changed.push(key);
    this.values.set(key, value);
  }
  async putMany(entries: readonly { key: string; value: string }[]) {
    this.batches.push(entries.length);
    for (const entry of entries) await this.put(entry.key, entry.value);
  }
  async putText(key: string, chunks: Iterable<string> | AsyncIterable<string>) {
    let value = '';
    for await (const piece of chunks) value += piece;
    await this.put(key, value);
  }
  async delete(key: string) {
    this.removed.push(key);
    this.values.delete(key);
  }
  async attach() {
    throw Error('Fictional map has no child references');
  }
}

function immutableSnapshot(writer: FictionalMap): ReportSnapshotMapReader {
  const retained = new FictionalMap(writer.values);
  return Object.freeze({
    assertCurrent: () => retained.assertCurrent(),
    get: (key: string) => retained.get(key),
    reference: () => undefined,
    preceding: (key: string) => retained.preceding(key),
    range: (page: ReportSnapshotPage) => retained.range(page),
    chunks: (key: string) => retained.chunks(key),
    bytePage: () => retained.bytePage(),
  });
}

function fixture(t: { after(fn: () => void): void }, entries: Iterable<[string, string]> = []) {
  const db = new DatabaseSync(':memory:'),
    writer = new FictionalMap(entries),
    delta = createIdentitySnapshotDelta({ db, writer });
  t.after(() => {
    delta.close();
    db.close();
  });
  return { db, writer, delta };
}

function createWithObservedScratch(db: DatabaseSync, writer: FictionalMap) {
  const original = DatabaseSync.prototype.exec;
  let path = '',
    scratchSql: DatabaseSync | undefined;
  DatabaseSync.prototype.exec = function (sql: string) {
    const result = original.call(this, sql);
    if (sql.startsWith('CREATE TABLE desired(')) {
      path = String(this.prepare('PRAGMA database_list').get()!.file);
      scratchSql = this;
    }
    return result;
  };
  try {
    const delta = createIdentitySnapshotDelta({ db, writer });
    assert.ok(scratchSql);
    return { delta, path, scratchSql };
  } finally {
    DatabaseSync.prototype.exec = original;
  }
}

test('delta skips unchanged values, preserves identical duplicate derived keys, and removes every obsolete key', async (t) => {
  const entries = Array.from({ length: 40 }, (_, n): [string, string] => [
      'member:' + String(n).padStart(4, '0'),
      'fictional-' + n,
    ]),
    { writer, delta } = fixture(t, [
      ...entries,
      ['targetLookup:obsolete', '1'],
      ['warnings:tail', 'old'],
    ]);
  for (const [key, value] of entries)
    await delta.put(key, key === 'member:0020' ? 'fictional-changed' : value);
  await delta.put('targetLookup:retained', '1');
  await delta.put('targetLookup:retained', '1');
  await delta.finishCleanup();
  await delta.certify(writer);
  assert.deepEqual(writer.changed, ['member:0020', 'targetLookup:retained']);
  assert.deepEqual(writer.removed, ['targetLookup:obsolete', 'warnings:tail']);
  assert.ok(writer.batches.every((count) => count <= 16));
  const immutable = immutableSnapshot(writer);
  await delta.certify(immutable);
  const certificate = identitySnapshotDeltaCertificate(immutable);
  assert.equal(certificate.count, 41);
  assert.match(certificate.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(certificate));
  assert.throws(
    () => identitySnapshotDeltaCertificate(new FictionalMap(writer.values)),
    /not certified|cannot certify/,
  );
});

test('delta flushes a pending occurrence before membership construction and rejects conflicting duplicate values', async (t) => {
  const { writer, delta } = fixture(t);
  await delta.put('occurrence:0000', '{"fictional":true}');
  assert.equal(writer.get('occurrence:0000'), undefined);
  await delta.flush();
  await delta.putText('membership:0000', () =>
    (function* () {
      yield '[';
      yield* writer.chunks('occurrence:0000');
      yield ']';
    })(),
  );
  await assert.rejects(delta.put('occurrence:0000', 'different'), /Conflicting/);
  await delta.finishCleanup();
  await delta.certify(writer);
  assert.equal(writer.get('membership:0000'), '[{"fictional":true}]');
});

test('delta exactly preserves oversized Unicode fragments and detects changed second-pass bytes', async (t) => {
  const text = JSON.stringify({
      personName: 'Fictional 🌿 \\" '.repeat(12000),
    }),
    { writer, delta } = fixture(t);
  await delta.putText('warnings:0000', () =>
    (function* () {
      for (let at = 0; at < text.length; at += 19) yield text.slice(at, at + 19);
    })(),
  );
  await delta.finishCleanup();
  await delta.certify(writer);
  assert.equal(writer.get('warnings:0000'), text);
  const other = fixture(t);
  let pass = 0;
  await assert.rejects(
    other.delta.putText('warnings:0000', () => [++pass === 1 ? text : text + 'x']),
    /bytes changed/,
  );
});

test('exact certification refuses extra, missing and changed retained rows', async (t) => {
  const { writer, delta } = fixture(t);
  await delta.put('targetHeader:0000', '{}');
  await delta.put('targetLookup:0000:expected', '1');
  await delta.finishCleanup();
  for (const kind of ['extra', 'missing', 'changed']) {
    const malformed = new FictionalMap(writer.values);
    if (kind === 'extra') malformed.values.set('targetLookup:0000:unexpected', '1');
    if (kind === 'missing') malformed.values.delete('targetLookup:0000:expected');
    if (kind === 'changed') malformed.values.set('targetHeader:0000', '{"changed":true}');
    await assert.rejects(delta.certify(malformed), /namespace|bytes changed/);
    assert.throws(
      () => identitySnapshotDeltaCertificate(malformed),
      /not certified|cannot certify/,
    );
  }
});

test('delta refuses externally changed or missing desired scratch rows before cleanup can borrow them', async (t) => {
  for (const statement of [
    'DELETE FROM desired',
    "UPDATE desired SET digest='" + '0'.repeat(64) + "'",
    "INSERT INTO desired VALUES(99,'targetLookup:unexpected',1,'" + '0'.repeat(64) + "')",
  ]) {
    const db = new DatabaseSync(':memory:'),
      writer = new FictionalMap(),
      { delta, path } = createWithObservedScratch(db, writer);
    t.after(() => {
      delta.close();
      db.close();
    });
    await delta.put('member:0000', 'fictional');
    const attacker = new DatabaseSync(path);
    try {
      attacker.exec(statement);
    } finally {
      attacker.close();
    }
    await assert.rejects(delta.finishCleanup(), /desired-key index changed/);
    assert.throws(() => identitySnapshotDeltaCertificate(writer), /not certified|cannot certify/);
  }
  // TEMP schema edits neither change the main file nor total_changes. They
  // must refuse even when restored, and when introduced during assertCurrent.
  for (const mode of ['view', 'restored-schema', 'during-guard']) {
    const db = new DatabaseSync(':memory:'),
      writer = new FictionalMap(),
      { delta, scratchSql } = createWithObservedScratch(db, writer);
    t.after(() => {
      delta.close();
      db.close();
    });
    await delta.put('member:0000', 'fictional');
    const readStamp = () =>
        scratchSql
          .prepare(
            'SELECT total_changes() AS changes,(SELECT data_version FROM pragma_data_version) AS external,(SELECT schema_version FROM pragma_schema_version) AS mainSchema',
          )
          .get(),
      before = readStamp();
    const mutate = () =>
      scratchSql.exec(
        mode === 'restored-schema'
          ? 'CREATE TEMP TABLE fictional_temp(dummy INTEGER); DROP TABLE temp.fictional_temp'
          : 'CREATE TEMP VIEW desired AS SELECT * FROM main.desired',
      );
    if (mode === 'during-guard') {
      let mutated = false;
      writer.assertCurrent = () => {
        if (!mutated) {
          mutated = true;
          mutate();
        }
      };
    } else mutate();
    await assert.rejects(delta.finishCleanup(), /desired-key index changed/);
    assert.deepEqual(readStamp(), before);
    assert.deepEqual(writer.changed, [], 'no pending desired put may publish after TEMP drift');
  }
});

test('delta refuses physical replacement of its disposable SQLite index', async (t) => {
  const db = new DatabaseSync(':memory:'),
    writer = new FictionalMap(),
    { delta, path } = createWithObservedScratch(db, writer);
  t.after(() => {
    delta.close();
    db.close();
  });
  await delta.put('member:0000', 'fictional');
  const moved = path + '.replaced';
  renameSync(path, moved);
  copyFileSync(moved, path);
  await assert.rejects(delta.finishCleanup(), /desired-key index changed/);
  rmSync(moved);
});

// This file intentionally supplies no caller-owned certification Boolean.

// Warning qualification here is owner-level synthetic data, not model-policy or
// contributor physical-write evidence. Native routes separately cover those.
class FictionalCatalog {
  readonly snapshots = new Map<string, FictionalMap>();
  readonly writers: FictionalMap[] = [];
  assertCurrent() {}
  open(key: string) {
    return this.snapshots.get(key);
  }
  async fork(key?: string) {
    const prior = key === undefined ? undefined : this.open(key);
    if (key !== undefined && !prior) throw Error('Fictional missing prior');
    const writer = new FictionalMap(
      prior?.values ?? [['$format', 'health-intake-report-snapshot-map-v1']],
    );
    this.writers.push(writer);
    return writer;
  }
  async forkReference(prior: ReportSnapshotMapReader) {
    if (!(prior instanceof FictionalMap) || ![...this.snapshots.values()].includes(prior))
      throw Error('Fictional foreign reference');
    const writer = new FictionalMap(prior.values);
    this.writers.push(writer);
    return writer;
  }
  async publish(key: string, writer: ReportSnapshotMapWriter) {
    if (this.snapshots.has(key) || !(writer instanceof FictionalMap))
      throw Error('Fictional invalid publication');
    this.snapshots.set(key, writer);
  }
  identityScopeReuseReader(): never {
    throw Error('Fictional warning owner has no scope reuse');
  }
  async bindCurrentIdentityScope() {
    throw Error('Fictional warning owner has no scope locator');
  }
  async finalChanges() {
    return [];
  }
}

test('warning owner reuses unchanged rows, deletes obsolete tails and refuses corrupted explicit prior content', async (t) => {
  const { retainIdentityWarningContent } = await import('../intake-identity-warnings-snapshot.ts'),
    { createHash } = await import('node:crypto'),
    db = new DatabaseSync(':memory:'),
    catalog = new FictionalCatalog(),
    initial = Array.from({ length: 40 }, (_, n) =>
      JSON.stringify({
        personName: 'Fictional ' + n,
        savedBirthDate: '1990-01-01',
      }),
    ),
    digest = (values: string[]) =>
      createHash('sha256')
        .update('[' + values.join(',') + ']')
        .digest('hex'),
    run = async <T>(work: Generator<void, T, void>) => {
      let step = work.next();
      while (!step.done) step = work.next();
      return step.value;
    },
    retain = (values: string[], priorContent?: ReportSnapshotMapReader) =>
      retainIdentityWarningContent({
        db,
        catalog,
        count: values.length,
        digest: digest(values),
        priorContent,
        rows: values.map((value) => ({ chunks: () => [value] })),
        run,
      });
  t.after(() => db.close());
  const first = await retain(initial),
    changed = [...initial];
  changed[20] = JSON.stringify({
    personName: 'Fictional 20',
    savedBirthDate: '1991-01-01',
  });
  const second = await retain(changed, first),
    secondWriter = catalog.writers.at(-1)!;
  assert.deepEqual(
    secondWriter.changed.filter((key) => key.startsWith('warnings:')),
    ['warnings:0000000000000020'],
  );
  assert.equal(first.get('warnings:0000000000000020'), initial[20]);
  assert.equal(second.get('warnings:0000000000000020'), changed[20]);
  await retain(changed.slice(0, -1), second);
  const shorterWriter = catalog.writers.at(-1)!;
  assert.deepEqual(
    shorterWriter.changed.filter((key) => key.startsWith('warnings:')),
    [],
  );
  assert.deepEqual(shorterWriter.removed, ['warnings:0000000000000039']);
  const writerCount = catalog.writers.length;
  await retainIdentityWarningContent({
    db,
    catalog,
    count: changed.length,
    digest: digest(changed),
    rows: {
      [Symbol.iterator]() {
        throw Error('unchanged content must not republish desired rows');
      },
    },
    run,
  });
  assert.equal(catalog.writers.length, writerCount);
  const corrupted = new FictionalMap(secondWriter.values);
  corrupted.values.set('targetLookup:unexpected', '1');
  await assert.rejects(retain(changed, corrupted), /warning namespace/);
  corrupted.values.delete('targetLookup:unexpected');
  corrupted.values.set('warnings:0000000000000020', 'changed bytes');
  await assert.rejects(retain(changed, corrupted), /warning content changed/);
  assert.equal(catalog.writers.length, writerCount);
});

test('unchanged and duplicate desired rows yield to heartbeat and respect cancellation on resume', async (t) => {
  for (const duplicate of [false, true]) {
    const entries = Array.from({ length: 80 }, (_, n): [string, string] => [
        'member:' + String(n).padStart(4, '0'),
        'fictional-' + n,
      ]),
      { writer, delta } = fixture(t, entries);
    let cancelled = false,
      heartbeat = 0,
      processed = 0;
    writer.assertCurrent = () => {
      if (cancelled) throw Error('Fictional identity cancelled');
    };
    setImmediate(() => {
      heartbeat++;
      cancelled = true;
    });
    await assert.rejects(
      (async () => {
        for (const [key, value] of entries) {
          await delta.put(duplicate ? 'member:0000' : key, duplicate ? 'fictional-0' : value);
          processed++;
        }
      })(),
      /cancelled/,
    );
    assert.equal(heartbeat, 1);
    assert.ok(processed <= 15);
    assert.deepEqual(writer.changed, []);
  }
});

test('a validated mutable writer cannot obtain an intrinsic alias certificate before or after mutation', async (t) => {
  const { writer, delta } = fixture(t);
  await delta.put('targetLookup:expected', '1');
  await delta.finishCleanup();
  await delta.certify(writer);
  assert.throws(() => identitySnapshotDeltaCertificate(writer), /Mutable identity snapshot/);
  await writer.put('targetLookup:unexpected', '1');
  assert.throws(() => identitySnapshotDeltaCertificate(writer), /Mutable identity snapshot/);
});
