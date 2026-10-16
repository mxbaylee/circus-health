import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const exercise = String.raw`
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.realpathSync, native = original.native;
const calls = { javascript: 0, native: 0 };
let nativeFailure;
const belongs = () => new Error().stack.includes('/intake-batch-journal.ts:');
const wrapped = new Proxy(original, {
  apply(target, receiver, args) {
    if (belongs()) calls.javascript++;
    return Reflect.apply(target, receiver, args);
  },
  get(target, property, receiver) {
    return property === 'native' ? nativeWrapped : Reflect.get(target, property, receiver);
  },
});
const nativeWrapped = new Proxy(native, {
  apply(target, receiver, args) {
    if (belongs()) calls.native++;
    if (args[0] === nativeFailure) throw Error('fictional native resolver failure');
    return Reflect.apply(target, receiver, args);
  },
});
fs.realpathSync = wrapped;
syncBuiltinESMExports();
const journal = await import('./src/server/intake-batch-journal.ts');
const base = native(fs.mkdtempSync(join(tmpdir(), 'fictional-batch-path-')));
const root = join(base, 'fictional space caf\u00e9');
const profileId = 'fictional-person';
const id = '11111111-1111-4111-8111-111111111111';
const profile = join(root, 'data', 'profiles', profileId);
const events = join(profile, 'intake-batches', id, 'events');
const batch = journal.trackIntakeBatch({
  id, profileId, operationId: 'fictional-operation', status: 'paused', reason: null,
  currentIndex: 0, createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z', items: [],
});
const scenario = process.argv[1];
try {
  fs.mkdirSync(profile, { recursive: true });
  const work = journal.createIntakeBatchJournalWorkCounters();
  journal.withIntakeBatchJournalWork(work, () => {
    journal.writeIntakeBatch(root, profileId, batch, 'initial');
    batch.reason = 'changed';
    journal.writeIntakeBatch(root, profileId, batch, 'checkpoint');
    assert.deepEqual(journal.readIntakeBatch(root, profileId, id), batch);
    assert.deepEqual(journal.listIntakeBatches(root, profileId), [batch]);
    const copy = join(base, 'copy');
    fs.mkdirSync(copy);
    journal.copyIntakeBatchJournals(root, profileId, copy);
    assert.deepEqual(journal.readIntakeBatch(copy, profileId, id), batch);
  });
  const tail = join(events, fs.readdirSync(events).filter(name => name.endsWith('.json')).sort().at(-1));
  const read = () => journal.readIntakeBatch(root, profileId, id);
  if (scenario === 'paths') {
    // Root aliases remain supported; selected profile/event aliases do not.
    const alias = join(base, 'alias');
    fs.symlinkSync(root, alias, 'dir');
    assert.deepEqual(journal.readIntakeBatch(alias, profileId, id), batch);
    fs.unlinkSync(alias);
    const moved = join(base, 'moved-events');
    fs.renameSync(events, moved);
    fs.symlinkSync(moved, events, 'dir');
    assert.throws(read, /Invalid/);
    fs.unlinkSync(events);
    fs.renameSync(moved, events);
    const movedProfile = join(base, 'moved-profile');
    fs.renameSync(profile, movedProfile);
    fs.symlinkSync(movedProfile, profile, 'dir');
    assert.throws(read, /Invalid/);
    fs.unlinkSync(profile);
    fs.renameSync(movedProfile, profile);
    // The native resolver normalizes case on some filesystems while the
    // original resolver preserves spelling. Preserve the journal's behavior.
    const caseAlias = join(dirname(events), 'EVENTS');
    const insensitive = fs.existsSync(caseAlias);
    fs.renameSync(events, caseAlias);
    if (insensitive) assert.deepEqual(read(), batch);
    else assert.throws(read, error => error.code === 'INTAKE_BATCH_NOT_FOUND');
    fs.renameSync(caseAlias, events);
  } else if (scenario === 'fallback') {
    nativeFailure = events;
    assert.deepEqual(read(), batch);
    assert.ok(calls.javascript > 0);
  } else if (scenario === 'tamper') {
    const link = join(base, 'linked-event');
    fs.linkSync(tail, link);
    assert.throws(read, /Invalid/);
    fs.unlinkSync(link);
    fs.renameSync(tail, link);
    assert.throws(read);
    fs.renameSync(link, tail);
    const bytes = fs.readFileSync(tail);
    fs.unlinkSync(tail);
    fs.writeFileSync(tail, bytes);
    batch.reason = 'must-refuse';
    assert.throws(() => journal.writeIntakeBatch(root, profileId, batch, 'replaced'), /Invalid/);
  }
  console.log(JSON.stringify({ calls, work }));
} finally {
  journal.clearIntakeBatchJournalCache(root);
  fs.realpathSync = original;
  syncBuiltinESMExports();
  fs.rmSync(base, { recursive: true, force: true });
}
`;

function run(scenario: string) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', exercise, scenario], {
    encoding: 'utf8',
    timeout: 25_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout.trim()) as {
    calls: { javascript: number; native: number };
    work: Record<string, number>;
  };
}

test('batch journal resolves every authority path through the native resolver', (t) => {
  const { calls, work } = run('normal');
  t.diagnostic(JSON.stringify({ calls, work }));
  assert.equal(calls.javascript, 0);
  assert.ok(calls.native > 0);
  assert.equal(work.headWrites, 3);
  assert.equal(work.eventWrites, 2);
  assert.ok(work.authorityStats > 0);
});

test('batch journal preserves canonical paths, root aliases and selected alias refusal', () => {
  run('paths');
});

test('batch journal preserves missing, hardlinked and replaced authority refusal', () => {
  run('tamper');
});

test('batch journal keeps the original resolver when native resolution is unavailable', () => {
  run('fallback');
});
