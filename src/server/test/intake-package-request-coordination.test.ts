import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { uploadIntake } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  hasIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { readDurablePackageInventory } from '../intake-package-state.ts';
import { clearPackageSourceSession } from '../intake-package-session.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';
import { handleIntakeRoute } from '../intake-routes.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
// Preload the actual route's lazy modules before the controlled HTTP overlap.
import '../intake-package.ts';
import '../intake-package-plan.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(t: test.TestContext, count = 2, native = true) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-package-request-'));
  const profileId = 'fictional-package-request';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const authority = memoryRecordAuthority(db);
  const entries = Array.from({ length: count }, (_, ordinal) => ({
    name: `fictional-${ordinal}.txt`,
    data: `Fictional original ${ordinal % 3}`,
  }));
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-request.zip',
    bytes: zipFixture(entries),
  });
  if (native) await buildIntakeCollectionEnvelope(db, { id: source.id });
  t.after(() => {
    clearPackageSourceSession(db);
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, root, profileId, id: source.id, authority, entries };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function heldConversion(t: test.TestContext, f: Fixture) {
  const source = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-conversion.txt',
    bytes: Buffer.from('Fictional concurrent retained evidence.'),
  });
  const entered = gate(),
    release = gate();
  let held = false;
  const building = buildIntakeCollectionEnvelope(
    f.db,
    { id: source.id },
    {
      onCheckpoint: async () => {
        if (held) return;
        held = true;
        entered.resolve();
        await release.promise;
      },
    },
  );
  // Attach rejection handling immediately; failure remains observable to the test.
  const terminal = building.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  void terminal.then(entered.resolve);
  t.signal.addEventListener('abort', release.resolve, { once: true });
  await entered.promise;
  assert.ok(held, 'actual accepted conversion checkpoint reached');
  return { terminal, release: release.resolve, source };
}
async function endpoint(t: test.TestContext, f: Fixture, owned = false) {
  const calls: {
    entered: ReturnType<typeof gate>;
    closed: ReturnType<typeof gate>;
    terminal: ReturnType<typeof gate>;
    response: ServerResponse;
    error?: unknown;
    delivered: boolean;
  }[] = [];
  const arrival = gate();
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.end('ready');
      return;
    }
    const call = {
      entered: gate(),
      closed: gate(),
      terminal: gate(),
      response: res,
      error: undefined as unknown,
      delivered: false,
    };
    calls.push(call);
    res.once('close', call.closed.resolve);
    call.entered.resolve();
    arrival.resolve();
    const route = () =>
      handleIntakeRoute({
        ...f,
        resource: 'intakes',
        method: 'GET',
        action: 'package',
        req,
        res,
        params: new URL(req.url!, 'http://fictional.invalid').searchParams,
        respond(value: unknown) {
          call.delivered = true;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(value));
        },
        list() {
          throw Error('Unexpected list');
        },
        body: async () => Buffer.alloc(0),
        assistant: undefined as never,
      });
    void (owned ? runExclusiveClinicalOperation(f.db, async () => route()) : route())
      .catch((error) => {
        call.error = error;
        if (!res.destroyed) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(error) }));
        }
      })
      .finally(call.terminal.resolve);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await Promise.all(calls.map((c) => c.terminal.promise));
  });
  function get(path = `/intakes/${f.id}/package?limit=2`) {
    const req = request(base + path);
    const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
      req.once('error', reject);
      req.once('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (bytes) => chunks.push(Buffer.from(bytes)));
        res.once('error', reject);
        res.once('end', () =>
          resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }),
        );
      });
    });
    void result.catch(() => undefined);
    req.end();
    return { req, result };
  }
  return { get, calls, arrival };
}
function inventory(f: Fixture) {
  return readDurablePackageInventory({
    ...f,
    rawDomainVersion: intakeSourceVersion(f.db, f.id).rawVersion,
  });
}
function staging(f: Fixture) {
  try {
    return readdirSync(join(f.root, '.package-index-staging'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

test(
  'actual package HTTP inventory waits behind a held real conversion without changing its raw witness',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t),
      http = await endpoint(t, f),
      held = await heldConversion(t, f);
    const stamp = reviewReadStamp(f.db),
      objects = f.authority.objects.size;
    const pending = http.get();
    try {
      await http.arrival.promise;
      // Actual independent requests establish that the server remains responsive
      // while this route is waiting; no time threshold is a product requirement.
      for (let n = 0; n < 4; n++) assert.equal((await http.get('/health').result).body, 'ready');
      assert.equal(reviewReadStamp(f.db), stamp, 'waiting package performs zero SQL writes');
      assert.equal(
        f.authority.objects.size,
        objects,
        'waiting package publishes no immutable objects',
      );
      assert.equal(http.calls[0].delivered, false);
      held.release();
      const conversion = await held.terminal;
      assert.ok(!('error' in conversion), String('error' in conversion ? conversion.error : ''));
      assert.ok(hasIntakeCollectionEnvelope(f.db, { id: held.source.id }));
      const response = await pending.result;
      assert.equal(response.status, 200);
      const page = JSON.parse(response.body);
      assert.equal(page.format, 'health-intake-package-inventory-v2');
      assert.equal(page.totalMembers, 2);
      assert.deepEqual(
        page.members.map((m: { filename: string }) => m.filename),
        f.entries.map((e) => e.name),
      );
      assert.equal(inventory(f)!.summary.members, 2);
      assert.deepEqual(staging(f), []);
    } finally {
      held.release();
      const finalConversion = await held.terminal;
      await http.calls[0]?.terminal.promise;
      await pending.result.catch(() => undefined);
      t.diagnostic(
        JSON.stringify({
          phase: 'held-conversion-package-terminal',
          conversionError: 'error' in finalConversion ? String(finalConversion.error) : null,
          packageError: http.calls[0]?.error ? String(http.calls[0].error) : null,
          delivered: http.calls[0]?.delivered,
        }),
      );
    }
  },
);

test(
  'abandoned waiting package HTTP request leaves no inventory work and releases its queue slot',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t),
      http = await endpoint(t, f),
      held = await heldConversion(t, f);
    const stamp = reviewReadStamp(f.db),
      objects = f.authority.objects.size;
    const pending = http.get();
    try {
      await http.arrival.promise;
      pending.req.destroy();
      await http.calls[0].closed.promise;
      await setImmediate();
      assert.equal(reviewReadStamp(f.db), stamp);
      assert.equal(f.authority.objects.size, objects);
      held.release();
      const conversion = await held.terminal;
      assert.ok(!('error' in conversion));
      await http.calls[0].terminal.promise;
      assert.equal((http.calls[0].error as Error)?.name, 'AbortError');
      assert.equal(http.calls[0].delivered, false);
      assert.equal(inventory(f), undefined);
      assert.deepEqual(staging(f), []);
      // A new subscriber can enter the same owner and complete independently.
      const response = await http.get().result;
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).totalMembers, 2);
    } finally {
      held.release();
      const finalConversion = await held.terminal;
      await http.calls[0]?.terminal.promise;
      await pending.result.catch(() => undefined);
      t.diagnostic(
        JSON.stringify({
          phase: 'held-conversion-package-terminal',
          conversionError: 'error' in finalConversion ? String(finalConversion.error) : null,
          packageError: http.calls[0]?.error ? String(http.calls[0].error) : null,
          delivered: http.calls[0]?.delivered,
        }),
      );
    }
  },
);

test(
  'abandoned active package HTTP request stops the real worker and resumes retained completed checkpoints',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, 24),
      http = await endpoint(t, f);
    let heads = 0,
      aborted = false;
    const original = f.authority.storage.publishHead;
    const mock = t.mock.method(f.authority.storage, 'publishHead', (bytes: Uint8Array) => {
      original(bytes);
      // The attempt checkpoint and a verified-member checkpoint are durable
      // before disconnecting during a later real publication. No worker substitute.
      if (++heads === 3) {
        aborted = true;
        http.calls[0].response.destroy();
      }
    });
    const pending = http.get();
    await http.arrival.promise;
    await http.calls[0].terminal.promise;
    await pending.result.catch(() => undefined);
    t.diagnostic(
      JSON.stringify({
        phase: 'active-package-terminal',
        heads,
        aborted,
        error: http.calls[0].error ? String(http.calls[0].error) : null,
        delivered: http.calls[0].delivered,
        completeInventory: inventory(f)?.summary.members ?? null,
        staging: staging(f).length,
      }),
    );
    assert.ok(aborted, 'disconnect reached a real durable worker checkpoint');
    assert.equal((http.calls[0].error as Error)?.name, 'AbortError');
    assert.equal(http.calls[0].delivered, false);
    assert.equal(inventory(f), undefined, 'an abandoned incomplete inventory is not selected');
    const collections = selectedEnvelopeStore(f.db, { id: f.id }).collections;
    const selected = collections.openView();
    const sourceHash = f.db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(f.id)!
      .sha256 as string;
    const attempt = collections.get(selected, 'builds', 'package.attempts', sourceHash);
    assert.equal(typeof attempt, 'string');
    const retained = collections.collection(selected, 'builds', `pkg.${attempt}.manifests`)!.root!
      .count;
    assert.ok(retained > 0 && retained < f.entries.length);
    assert.deepEqual(staging(f), []);
    const objects = f.authority.objects.size,
      terminalHeads = heads;
    await runExclusiveClinicalOperation(f.db, async () => {
      await setImmediate();
      assert.equal(
        f.authority.objects.size,
        objects,
        'no orphan immutable publication after rejection',
      );
      assert.equal(heads, terminalHeads, 'no orphan HEAD publication after rejection');
    });
    mock.mock.restore();
    const response = await http.get(`/intakes/${f.id}/package?limit=50`).result;
    assert.equal(response.status, 200);
    const complete = inventory(f)!;
    assert.equal(complete.inventoryId, attempt, 'retry resumes the same accepted attempt');
    assert.equal(complete.summary.members, f.entries.length);
    assert.deepEqual(
      [...complete.range()].map((m) => m.filename),
      f.entries.map((e) => e.name),
    );
    assert.equal(new Set([...complete.range()].map((m) => m.memberId)).size, f.entries.length);
    assert.deepEqual(staging(f), []);
  },
);

test(
  'legacy package HTTP inventory preserves the exact existing result',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t, 2, false),
      http = await endpoint(t, f);
    const response = await http.get().result;
    assert.equal(response.status, 200);
    const page = JSON.parse(response.body);
    assert.equal(page.totalMembers, 2);
    assert.deepEqual(
      page.members.map((m: { filename: string }) => m.filename),
      f.entries.map((e) => e.name),
    );
    assert.equal(http.calls[0].error, undefined);
  },
);

test(
  'native package HTTP route can await the immediate existing clinical owner without deadlock',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t),
      http = await endpoint(t, f, true);
    const response = await http.get().result;
    assert.equal(response.status, 200);
    const page = JSON.parse(response.body);
    assert.equal(page.format, 'health-intake-package-inventory-v2');
    assert.equal(page.totalMembers, 2);
    assert.deepEqual(
      page.members.map((m: { filename: string }) => m.filename),
      f.entries.map((e) => e.name),
    );
    assert.equal(http.calls[0].error, undefined);
    assert.deepEqual(staging(f), []);
  },
);
