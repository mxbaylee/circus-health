import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, HttpError } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { uploadIntake, retainIntakeChildren, getIntakeOriginal } from '../intake.ts';
import { createPagedPackagePlan } from '../intake-package-plan.ts';
import { createNote, saveNote } from '../notes.ts';
import { createNoteExports, exportSnapshot } from '../note-exports.ts';
import { PacketOutputBudget, packetOutputLimit } from '../packet-output-budget.ts';
import {
  nativePacketReadingGaps,
  iterateNativePacketReadingGaps,
} from '../packet-reading-gaps-native.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import { fictionalModel } from './fictional-model.ts';

function fixture(t: test.TestContext, count: number) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-bounded-packet-')),
    profileId = 'cookie-dough',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const children = Array.from({ length: count }, (_, index) => ({
      filename: 'fictional-' + String(index).padStart(4, '0') + '.txt',
      locator: 'Fictional occurrence ' + index,
      bytes: Buffer.from('Exact fictional child ' + index),
    })),
    bytes = zipFixture(
      children.map((child) => ({ name: child.filename, data: child.bytes.toString() })),
    ),
    intake = uploadIntake(db, root, profileId, { filename: 'fictional.zip', bytes });
  return { db, root, profileId, intake, children, bytes };
}

test('native package disclosures enforce the existing packet output budget while generating each item', async (t) => {
  const f = fixture(t, 129),
    note = createNote(f.db, { kind: 'note', title: 'Fictional visit' }),
    linked = saveNote(f.db, note.id, {
      version: note.version,
      links: [{ targetType: 'source', targetId: f.intake.id, relation: 'references' }],
    }),
    input = {
      type: 'note',
      id: linked.id,
      noteVersion: linked.version,
      mode: 'brief',
      selected: ['source_file:' + f.intake.id],
    };
  const initial = exportSnapshot(f.db, input);
  const plan = await createPagedPackagePlan(f.db, f.root, f.profileId, f.intake.id, {
    version: f.intake.version,
    operationId: 'fictional-budget-plan',
  });
  assert.equal(plan.plan.unitCount, 129);
  const complete = nativePacketReadingGaps(f.db, f.intake.id);
  assert.equal(complete.length, 129);
  assert.deepEqual([...iterateNativePacketReadingGaps(f.db, f.intake.id)], complete);
  assert.throws(() => nativePacketReadingGaps(f.db, f.intake.id, new PacketOutputBudget(256)), {
    code: 'EXPORT_TOO_LARGE',
  });
  // Inject a smaller quota through the same admission method, keeping fixture
  // bytes small. Public routes cannot alter or increase the real 8M/64M limits.
  const quota = JSON.stringify(initial).length + 2000,
    characters = PacketOutputBudget.prototype.characters,
    add = PacketOutputBudget.prototype.add;
  let gapAdmissions = 0;
  PacketOutputBudget.prototype.characters = function (count: number) {
    if (this.used + count > quota)
      throw new HttpError(400, 'EXPORT_TOO_LARGE', 'Fictional output quota');
    return characters.call(this, count);
  };
  PacketOutputBudget.prototype.add = function (value: unknown, separator = 0) {
    if (value && typeof value === 'object' && 'locator' in value && 'reason' in value)
      gapAdmissions++;
    return add.call(this, value, separator);
  };
  const before = readdirSync(tmpdir())
    .filter((name) => name.startsWith('circus-packet-'))
    .sort();
  try {
    assert.throws(() => exportSnapshot(f.db, input), { code: 'EXPORT_TOO_LARGE' });
    assert.ok(
      gapAdmissions > 0 && gapAdmissions < 129,
      'refuse during generation, before all pending occurrences are buffered',
    );
    assert.deepEqual(
      readdirSync(tmpdir())
        .filter((name) => name.startsWith('circus-packet-'))
        .sort(),
      before,
      'failed output closes all scratch indexes',
    );
  } finally {
    PacketOutputBudget.prototype.characters = characters;
    PacketOutputBudget.prototype.add = add;
  }
  const snapshot = exportSnapshot(f.db, input);
  assert.equal(snapshot.readingGaps[0]!.gaps.length, 129);
  clearIntakeStateCache(f.db);
  assert.deepEqual(exportSnapshot(f.db, input).readingGaps, snapshot.readingGaps);
  assert.equal(packetOutputLimit(false), 8_000_000);
  assert.equal(packetOutputLimit(true), 64_000_000);
});

test('a source_file preference traverses a large retained collection through bounded SQL rows', async (t) => {
  const f = fixture(t, 257),
    retained = retainIntakeChildren(f.db, f.root, f.profileId, f.intake.id, f.children);
  await createPagedPackagePlan(f.db, f.root, f.profileId, f.intake.id, {
    version: f.intake.version,
    operationId: 'fictional-preference-plan',
  });
  const target = retained.at(-1)!;
  const note = createNote(f.db, { kind: 'note', title: 'Fictional visit' }),
    linked = saveNote(f.db, note.id, {
      version: note.version,
      links: [{ targetType: 'source', targetId: target.id, relation: 'references' }],
    });
  const prepare = f.db.prepare.bind(f.db);
  let largestRows = 0,
    descendants = 0;
  Object.defineProperty(f.db, 'prepare', {
    configurable: true,
    value: (sql: string) => {
      const statement = prepare(sql);
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            const result = Reflect.apply(value, target, args);
            if (key === 'all' && /^\s*SELECT/i.test(sql))
              largestRows = Math.max(largestRows, Array.isArray(result) ? result.length : 0);
            if (
              key === 'iterate' &&
              sql.includes("json_extract(details_json,'$.intake.parentSourceFileId')")
            )
              return (function* () {
                for (const row of result as Iterable<Record<string, unknown>>) {
                  descendants++;
                  yield row;
                }
              })();
            return result;
          };
        },
      });
    },
  });
  const handler = createNoteExports();
  let response: unknown;
  const request = {
    type: 'note',
    id: linked.id,
    noteVersion: linked.version,
    personId: 'patient',
    record: { kind: 'source_file', recordId: f.intake.id },
    alwaysWithhold: true,
    tags: [],
    expectedVersion: 0,
  };
  try {
    await handler({
      resource: 'note-exports',
      id: 'preferences',
      method: 'POST',
      db: f.db,
      root: f.root,
      profileId: f.profileId,
      req: {} as IncomingMessage,
      jsonBody: async () => request,
      respond: (value: unknown) => {
        response = value;
      },
    } as unknown as Parameters<typeof handler>[0]);
    assert.equal((response as { alwaysWithhold: boolean }).alwaysWithhold, true);
    assert.equal(
      descendants,
      514,
      'entry and transaction membership checks each traverse the exact 257 descendants',
    );
    assert.ok(
      largestRows <= 1,
      'one original preference must not load descendant/source/asset collections with all()',
    );
  } finally {
    Object.defineProperty(f.db, 'prepare', { configurable: true, value: prepare });
  }
  assert.deepEqual(getIntakeOriginal(f.db, f.root, f.profileId, f.intake.id).bytes, f.bytes);
  clearIntakeStateCache(f.db);
  const changed = { ...request, alwaysWithhold: false, expectedVersion: 1 };
  await handler({
    resource: 'note-exports',
    id: 'preferences',
    method: 'POST',
    db: f.db,
    root: f.root,
    profileId: f.profileId,
    req: {} as IncomingMessage,
    jsonBody: async () => changed,
    respond: (value: unknown) => {
      response = value;
    },
  } as unknown as Parameters<typeof handler>[0]);
  assert.equal((response as { alwaysWithhold: boolean }).alwaysWithhold, false);
});
