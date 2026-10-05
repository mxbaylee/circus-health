import { collectionIntakePackageFailures } from '../intake-summary.ts';
import { recordIntakePackageFailurePaged } from '../intake-package-failures.ts';
import { MAX_INTAKE_BYTES } from '../intake-format.ts';
import { writeLargeFictionalPdf } from '../../tests/fixtures/large-streamed-zip.ts';
import { disposePdfEvidenceSessions } from '../intake-pdf-session.ts';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
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
import { uploadIntake, getRetainedIntakeOriginalReference } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { hasIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import { readDurablePackageInventory } from '../intake-package-state.ts';
import { clearPackageSourceSession } from '../intake-package-session.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';
import { handleIntakeRoute } from '../intake-routes.ts';
import { zipFixture, type ZipFixtureEntry } from '../../tests/fixtures/zip.ts';
// Preload the actual route's lazy modules before the controlled HTTP overlap.
import { inventoryIntakePackagePaged, readIntakePackageMemberPaged } from '../intake-package.ts';
import '../intake-package-plan.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(
  t: test.TestContext,
  count = 2,
  native = true,
  suppliedEntries?: ZipFixtureEntry[],
) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-package-request-'));
  const profileId = 'fictional-package-request';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const authority = memoryRecordAuthority(db);
  const entries =
    suppliedEntries ??
    Array.from({ length: count }, (_, ordinal) => ({
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
async function heldConversion(
  t: test.TestContext,
  f: Fixture,
  preparedSource?: ReturnType<typeof uploadIntake>,
) {
  const source =
    preparedSource ??
    uploadIntake(f.db, f.root, f.profileId, {
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
async function endpoint(
  t: test.TestContext,
  f: Fixture,
  owned = false,
  input: Record<string, unknown> = {},
) {
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
        method: 'POST',
        action: 'package-member',
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
        body: async () => Buffer.from(JSON.stringify(input)),
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
    const req = request(base + path, {
      method: path === '/health' ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
    });
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

function packageFailures(f: Fixture) {
  const source = f.db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(f.id) as { id: string; kind: string; sha256: string; details_json: string };
  return collectionIntakePackageFailures(f.db, source, { limit: 50 });
}

for (const action of [
  'publish',
  'cancel',
  'replace-parent',
  'close',
  'stage-error',
  'stage-error-replace-parent',
  'stage-error-cancel',
] as const)
  test(
    `actual ZIP worker finishes outside admission then ${action} its retained stage after a held conversion`,
    { timeout: 60_000 },
    async (t) => {
      const cancel = action === 'cancel' || action === 'stage-error-cancel';
      const stageError = action.startsWith('stage-error');
      const replaceParent = action === 'replace-parent' || action === 'stage-error-replace-parent';
      const f = await fixture(t),
        page = await inventoryIntakePackagePaged(f),
        member = page.members[0];
      const http = await endpoint(t, f, false, { memberId: member.memberId });
      const selected = gate(),
        releaseAck = gate(),
        stageClosed = gate();
      let stageFd: number | undefined,
        gateApplied = false,
        injectedStageError = false,
        workerClosed = false,
        workerCount = 0,
        workerPid: number | undefined,
        held: Awaited<ReturnType<typeof heldConversion>> | undefined;
      const spawn = childProcess.spawn,
        open = fs.openSync,
        close = fs.closeSync,
        fsync = fs.fsyncSync;
      const openMock = t.mock.method(fs, 'openSync', (...args: Parameters<typeof open>) => {
        const fd = open(...args);
        if (
          String(args[0]).includes('.intake-child-staging/') &&
          String(args[0]).endsWith('/original')
        )
          stageFd = fd;
        return fd;
      });
      const fsyncMock = t.mock.method(fs, 'fsyncSync', (fd: number) => {
        if (stageError && fd === stageFd && !injectedStageError) {
          injectedStageError = true;
          throw Object.assign(Error('Fictional verified-stage I/O failure'), { code: 'EIO' });
        }
        return fsync(fd);
      });
      const closeMock = t.mock.method(fs, 'closeSync', (fd: number) => {
        close(fd);
        if (fd === stageFd) {
          stageFd = undefined;
          stageClosed.resolve();
        }
      });
      const spawnMock = t.mock.method(
        childProcess,
        'spawn',
        (...args: Parameters<typeof spawn>) => {
          const child = spawn(...args);
          if (Array.isArray(args[1]) && args[1].includes('--checked-member')) {
            workerCount++;
            workerPid = child.pid;
            assert.equal(workerCount, 1, 'one actual selected-member worker');
            child.once('close', () => {
              workerClosed = true;
            });
            const input = child.stdin!;
            const write = input.write.bind(input);
            t.mock.method(input, 'write', (...values: Parameters<typeof input.write>) => {
              const frame = JSON.parse(String(values[0])) as { part: string; last: boolean };
              const record = JSON.parse(Buffer.from(frame.part, 'base64').toString()) as {
                type: string;
                sequence?: number;
              };
              if (record.type === 'ack' && !gateApplied) {
                assert.equal(frame.last, true, 'complete original ACK frame');
                assert.equal(record.sequence, 0, 'actual selected_verified ACK sequence');
                gateApplied = true;
                selected.resolve();
                void releaseAck.promise.then(() => write(...values));
                return true;
              }
              return write(...values);
            });
          }
          return child;
        },
      );
      syncBuiltinESMExports();
      const pending = http.get();
      try {
        await selected.promise;
        assert.ok(gateApplied, 'actual extracted selected-member acknowledgment reached');
        assert.ok(workerPid && workerPid !== process.pid, 'actual separate ZIP worker PID');
        held = await heldConversion(t, f);
        const stamp = reviewReadStamp(f.db),
          objects = f.authority.objects.size;
        releaseAck.resolve();
        await stageClosed.promise;
        for (let n = 0; n < 8; n++) assert.equal((await http.get('/health').result).body, 'ready');
        assert.ok(workerClosed, 'real extraction worker exited before publication admission');
        assert.equal(reviewReadStamp(f.db), stamp);
        assert.equal(f.authority.objects.size, objects);
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_files').get()?.n, 2);
        assert.equal(
          fs.readdirSync(join(f.root, '.intake-child-staging')).length,
          stageError ? 0 : 1,
          'verified stage remains owned only through pending publication',
        );
        assert.equal(injectedStageError, stageError, 'exact real stage fsync branch');
        if (replaceParent) {
          const original = getRetainedIntakeOriginalReference(f.db, f.root, f.profileId, f.id).path;
          const originalInode = fs.statSync(original, { bigint: true }).ino;
          const replacement = original + '.fictional-replacement';
          const bytes = fs.readFileSync(original);
          fs.writeFileSync(replacement, bytes, { flag: 'wx' });
          fs.renameSync(replacement, original);
          assert.notEqual(fs.statSync(original, { bigint: true }).ino, originalInode);
          assert.deepEqual(fs.readFileSync(original), bytes);
        }
        if (action === 'close') f.db.close();
        if (cancel) {
          pending.req.destroy();
          await http.calls[0].closed.promise;
          await http.calls[0].terminal.promise;
          assert.equal((http.calls[0].error as Error)?.name, 'AbortError');
        }
        held.release();
        const conversion = await held.terminal;
        if (action === 'close')
          assert.ok('error' in conversion, 'closed conversion refuses publication');
        else
          assert.ok(
            !('error' in conversion),
            String('error' in conversion ? conversion.error : ''),
          );
        await http.calls[0].terminal.promise;
        if (cancel) {
          assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_files').get()?.n, 2);
          assert.equal(
            packageFailures(f).total,
            0,
            'cancellation authorizes no located failure mutation',
          );
          await pending.result.catch(() => undefined);
        } else if (replaceParent) {
          const response = await pending.result;
          assert.equal(response.status, 500, response.body);
          assert.equal((http.calls[0].error as { code: string })?.code, 'SOURCE_CHANGED');
          assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_files').get()?.n, 2);
          assert.equal(
            packageFailures(f).total,
            0,
            'changed parent cannot authorize failure publication',
          );
          spawnMock.mock.restore();
          syncBuiltinESMExports();
          const retry = await http.get().result;
          assert.equal(retry.status, 200, retry.body);
          assert.equal(JSON.parse(retry.body).member.memberId, member.memberId);
          assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_files').get()?.n, 3);
        } else if (action === 'stage-error') {
          const response = await pending.result;
          assert.equal(response.status, 500, response.body);
          assert.equal((http.calls[0].error as { code: string })?.code, 'INTAKE_CHILD_IO');
          const failures = packageFailures(f);
          assert.equal(failures.total, 1);
          assert.equal(failures.entries[0].failure.memberId, member.memberId);
          assert.equal(failures.entries[0].failure.reasonCode, 'INTAKE_CHILD_IO');
          assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_files').get()?.n, 2);
          spawnMock.mock.restore();
          syncBuiltinESMExports();
          const retry = await http.get().result;
          assert.equal(retry.status, 200, retry.body);
          assert.equal(JSON.parse(retry.body).member.memberId, member.memberId);
          assert.equal(packageFailures(f).total, 0);
        } else if (action === 'close') {
          const response = await pending.result;
          assert.equal(response.status, 500, response.body);
          assert.equal(http.calls[0].delivered, false);
          assert.ok(http.calls[0].error);
          assert.deepEqual(staging(f), []);
        } else {
          const response = await pending.result;
          assert.equal(response.status, 200, response.body);
          const value = JSON.parse(response.body);
          assert.equal(value.member.memberId, member.memberId);
          const replay = JSON.parse((await http.get().result).body);
          assert.equal(replay.sourceFileId, value.sourceFileId);
          assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_files').get()?.n, 3);
        }
        assert.deepEqual(fs.readdirSync(join(f.root, '.intake-child-staging')), []);
      } finally {
        releaseAck.resolve();
        held?.release();
        const terminal = await held?.terminal;
        await http.calls[0]?.terminal.promise;
        t.diagnostic(
          JSON.stringify({
            phase: 'worker-stage-terminal',
            action,
            workerPid,
            workerCount,
            gateApplied,
            workerClosed,
            injectedStageError,
            conversionError: terminal && 'error' in terminal ? String(terminal.error) : null,
            memberError: http.calls[0]?.error ? String(http.calls[0].error) : null,
            delivered: http.calls[0]?.delivered,
          }),
        );
        await pending.result.catch(() => undefined);
        spawnMock.mock.restore();
        openMock.mock.restore();
        closeMock.mock.restore();
        fsyncMock.mock.restore();
        syncBuiltinESMExports();
      }
    },
  );

test(
  'actual native package member HTTP nests within its immediate clinical owner',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t),
      page = await inventoryIntakePackagePaged(f),
      http = await endpoint(t, f, true, { memberId: page.members[0].memberId });
    const result = await http.get().result;
    assert.equal(result.status, 200, result.body);
    assert.equal(JSON.parse(result.body).member.memberId, page.members[0].memberId);
    assert.equal(http.calls[0].error, undefined);
  },
);
test(
  'direct native inventory producer waits behind the real conversion owner',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t),
      held = await heldConversion(t, f),
      stamp = reviewReadStamp(f.db),
      objects = f.authority.objects.size;
    const pending = inventoryIntakePackagePaged(f);
    void pending.catch(() => undefined);
    try {
      for (let n = 0; n < 3; n++) await setImmediate();
      assert.equal(reviewReadStamp(f.db), stamp);
      assert.equal(f.authority.objects.size, objects);
      held.release();
      const terminal = await held.terminal;
      assert.ok(!('error' in terminal));
      const page = await pending;
      assert.ok(hasIntakeCollectionEnvelope(f.db, { id: held.source.id }));
      assert.equal(inventory(f)!.summary.members, f.entries.length);
      assert.equal(page.totalMembers, f.entries.length);
      assert.deepEqual(
        page.members.map((m) => {
          assert.ok('filename' in m);
          return m.filename;
        }),
        f.entries.map((e) => e.name),
      );
    } finally {
      held.release();
      await held.terminal;
      await pending.catch(() => undefined);
    }
  },
);
test(
  'native package PDF deferred fallback reacquires evidence after producer lease closes',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    t.after(() => disposePdfEvidenceSessions(f.profileId));
    const path = join(f.root, 'fictional-two-page.pdf');
    writeLargeFictionalPdf(path, 8192);
    const source = uploadIntake(f.db, f.root, f.profileId, {
      filename: 'fictional-pdf-package.zip',
      bytes: zipFixture([{ name: 'fictional-pages.pdf', data: fs.readFileSync(path) }]),
    });
    await buildIntakeCollectionEnvelope(f.db, { id: source.id });
    const context = { ...f, id: source.id },
      page = await inventoryIntakePackagePaged(context),
      memberId = page.members[0].memberId;
    const result = await readIntakePackageMemberPaged({
      ...context,
      memberId,
      page: 2,
      modelContext: true,
      pdf: true,
    });
    assert.ok('pdfContent' in result && result.pdfContent && result.pdfFallback);
    assert.equal(result.metadata.member.memberId, memberId);
    assert.ok('page' in result.metadata.original);
    assert.equal(result.metadata.original.page, 2);
    await setImmediate();
    const fallback = await result.pdfFallback();
    assert.match(fallback.imageContent, /^data:image\/png;base64,/);
    assert.equal(fallback.metadata.member.memberId, memberId);
    assert.equal(fallback.metadata.sourceFileId, result.metadata.sourceFileId);
    assert.equal(fallback.metadata.original.page, 2);
  },
);

for (const kind of ['invalid', 'resolve', 'limit'] as const)
  test(
    `native JSON ${kind} processing waits behind a real conversion and preserves located member state`,
    { timeout: 120_000 },
    async (t) => {
      const data =
        kind === 'limit'
          ? Buffer.concat([Buffer.from('['), Buffer.alloc(MAX_INTAKE_BYTES, 32)])
          : kind === 'invalid'
            ? '{ Fictional invalid JSON'
            : '{"fictional":1}';
      const f = await fixture(t, 1, true, [{ name: 'fictional.json', data }]);
      const page = await inventoryIntakePackagePaged(f),
        member = page.members[0];
      assert.ok('filename' in member && 'locator' in member);
      if (kind === 'resolve')
        await runExclusiveClinicalOperation(f.db, async () => {
          await recordIntakePackageFailurePaged(f.db, f.root, f.profileId, f.id, {
            operationKey: 'structure:' + member.memberId,
            memberId: member.memberId,
            ordinal: member.ordinal,
            filename: member.filename,
            locator: member.locator,
            reasonCode: 'JSON_STRUCTURE',
            detail: 'Fictional retained prior structure issue',
          });
        });
      const priorFailures = packageFailures(f),
        priorVersion = intakeSourceVersion(f.db, f.id).version;
      const conversionSource = uploadIntake(f.db, f.root, f.profileId, {
        filename: 'fictional-json-conversion.txt',
        bytes: Buffer.from('Fictional concurrent JSON conversion'),
      });
      const http = await endpoint(t, f, false, { memberId: member.memberId });
      const reached = gate();
      let heldPromise: Promise<Awaited<ReturnType<typeof heldConversion>>> | undefined;
      let triggered = false;
      const open = fs.openSync;
      const openMock = t.mock.method(fs, 'openSync', (...args: Parameters<typeof open>) => {
        const fd = open(...args);
        if (!triggered && String(args[0]).endsWith('/fictional.json')) {
          triggered = true;
          heldPromise = heldConversion(t, f, conversionSource);
          void heldPromise.catch(reached.resolve);
          reached.resolve();
        }
        return fd;
      });
      syncBuiltinESMExports();
      const pending = http.get();
      void pending.result.finally(reached.resolve).catch(() => undefined);
      let held: Awaited<ReturnType<typeof heldConversion>> | undefined;
      try {
        await reached.promise;
        assert.ok(triggered && heldPromise, 'actual child literal/JSON read reached');
        held = await heldPromise;
        const stamp = reviewReadStamp(f.db),
          objects = f.authority.objects.size;
        for (let n = 0; n < 4; n++) assert.equal((await http.get('/health').result).body, 'ready');
        assert.equal(
          http.calls[0].delivered,
          false,
          'JSON structure result waits for its publication',
        );
        assert.equal(
          reviewReadStamp(f.db),
          stamp,
          'waiting JSON state publication performs zero SQL writes',
        );
        assert.equal(f.authority.objects.size, objects);
        assert.deepEqual(packageFailures(f), priorFailures);
        assert.equal(intakeSourceVersion(f.db, f.id).version, priorVersion);
        held.release();
        const conversion = await held.terminal;
        assert.ok(!('error' in conversion), String('error' in conversion ? conversion.error : ''));
        const response = await pending.result;
        assert.equal(response.status, 200, response.body);
        const value = JSON.parse(response.body),
          failures = packageFailures(f);
        assert.equal(value.member.memberId, member.memberId);
        if (kind === 'resolve') {
          assert.ok(value.structure);
          assert.equal(failures.total, 0);
        } else {
          assert.equal(typeof value.structureIssue, 'string');
          assert.equal(failures.total, 1);
          assert.equal(
            failures.entries[0].failure.reasonCode,
            kind === 'limit' ? 'JSON_LIMIT' : 'JSON_STRUCTURE',
          );
          assert.equal(failures.entries[0].failure.memberId, member.memberId);
          assert.equal(failures.entries[0].failure.locator, member.locator);
        }
        const retry = JSON.parse((await http.get().result).body);
        assert.equal(retry.sourceFileId, value.sourceFileId);
        assert.equal(retry.member.memberId, member.memberId);
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_files').get()?.n, 3);
        assert.deepEqual(fs.readdirSync(join(f.root, '.intake-child-staging')), []);
      } finally {
        held?.release();
        if (!held && heldPromise) held = await heldPromise.catch(() => undefined);
        held?.release();
        await held?.terminal;
        await http.calls[0]?.terminal.promise;
        await pending.result.catch(() => undefined);
        openMock.mock.restore();
        syncBuiltinESMExports();
      }
    },
  );
