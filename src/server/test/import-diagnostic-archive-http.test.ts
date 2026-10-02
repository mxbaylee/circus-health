import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createVaultApp } from '../vault-app.ts';
import { createImportDiagnostics, type ImportDiagnosticEvent } from '../import-diagnostics.ts';
import type { ImportDiagnosticArchive } from '../../shared/import-performance.ts';

interface Download {
  enabled: boolean;
  events: ImportDiagnosticEvent[];
  eventArchive: ImportDiagnosticArchive<ImportDiagnosticEvent>;
}
interface Setup {
  setupId: string;
  profileId: string;
  recoveryKit: unknown;
}

test('retained HTTP export requires the owning session and survives fresh runtime with SQLite cache loss', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-archive-http-'));
  const data = join(root, 'data'),
    runtime = join(root, 'runtime');
  mkdirSync(data);
  let diagnostics = createImportDiagnostics({ enabled: true });
  let failAfterPublication = false;
  const attach = diagnostics.attachEventStore.bind(diagnostics);
  diagnostics.attachEventStore = (profileId, store) =>
    attach(profileId, {
      ...store,
      append(sequence, bytes) {
        const result = store.append(sequence, bytes);
        if (failAfterPublication) {
          failAfterPublication = false;
          throw Error('Fictional lost publication acknowledgement');
        }
        return result;
      },
    });
  const options = {
    dataDirectory: data,
    runtimeDirectory: runtime,
    assistantOptions: {
      availability: () => ({ available: false, readiness: 'unavailable' as const }),
    },
  };
  let app = createVaultApp({ ...options, diagnostics });
  t.after(() => {
    app.close();
    diagnostics.close();
    rmSync(root, { recursive: true, force: true });
  });
  let base = '';
  async function listen() {
    await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  }
  await listen();
  let cookie = '';
  async function send<T = Download>(path: string, input?: unknown, authorized = true) {
    const response = await fetch(base + path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        Cookie: authorized ? cookie : '',
        'Content-Type': 'application/json',
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    if (authorized && response.headers.get('set-cookie'))
      cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return { status: response.status, payload: (await response.json()) as { data: T } };
  }
  async function create(name: string) {
    const setup = (
      await send<Setup>('/api/profile-setups', { name, fullName: name, birthDate: '1982-04-17' })
    ).payload.data;
    assert.equal(
      (
        await send(`/api/profile-setups/${setup.setupId}/verify`, {
          acknowledged: true,
          recovery: setup.recoveryKit,
        })
      ).status,
      201,
    );
    return setup;
  }
  const first = await create('Fictional Cedar');
  const path = `/api/profiles/${first.profileId}/import-diagnostics`;
  diagnostics.record(
    'import.progress',
    { accountedUnits: 42, unsafeText: 'Fictional medical canary' },
    { profileId: first.profileId, importId: 'fictional-private-source.pdf' },
  );
  assert.equal((await send(path, undefined, false)).status, 423);
  failAfterPublication = true;
  const initial = await send(path);
  assert.equal(initial.status, 200);
  const archive = initial.payload.data.eventArchive;
  assert.ok(archive.events.length > 0);
  assert.equal(archive.windowCoverageScope, 'retained_readable_checkpoints');
  assert.equal(archive.windowCoverage[0]!.exportedEvents, archive.events.length);
  assert.equal(archive.windowCoverage[0]!.knownPersistedNotExportedEvents, 0);
  assert.equal(archive.currentWindow.writeFailures, 1);
  assert.equal(archive.status, 'partial');
  assert.doesNotMatch(
    JSON.stringify(initial.payload),
    /Fictional medical canary|fictional-private-source|Fictional Cedar/,
  );
  const second = await create('Fictional Willow');
  assert.equal((await send(path)).status, 423);
  const other = await send(`/api/profiles/${second.profileId}/import-diagnostics`);
  assert.ok(
    !other.payload.data.eventArchive.events.some((row) => row.event.fields.accountedUnits === 42),
  );
  assert.equal(
    (await send(`/api/profiles/${first.profileId}/unlock`, { recovery: first.recoveryKit })).status,
    200,
  );
  assert.ok(
    (await send(path)).payload.data.eventArchive.events.some(
      (row) => row.event.fields.accountedUnits === 42,
    ),
  );
  // A pending tail is flushed by normal lock without requiring an export.
  diagnostics.record('import.progress', { accountedUnits: 43 }, { profileId: first.profileId });
  assert.equal((await send(`/api/profiles/${first.profileId}/lock`, {})).status, 200);
  assert.equal((await send(path)).status, 423);
  assert.equal((await diagnostics.exportArchive(first.profileId)).status, 'not_attached');
  app.close();
  diagnostics.close();
  rmSync(runtime, { recursive: true, force: true });
  rmSync(join(data, 'profiles', first.profileId, 'cache'), { recursive: true, force: true });
  diagnostics = createImportDiagnostics();
  app = createVaultApp({ ...options, diagnostics });
  cookie = '';
  await listen();
  assert.equal((await send(path)).status, 423);
  assert.equal(
    (await send(`/api/profiles/${first.profileId}/unlock`, { recovery: first.recoveryKit })).status,
    200,
  );
  const restored = (await send(path)).payload.data;
  assert.equal(restored.enabled, false);
  assert.equal(restored.events.length, 0);
  assert.equal(restored.eventArchive.recording, 'disabled');
  assert.ok(restored.eventArchive.events.some((row) => row.event.fields.accountedUnits === 42));
  assert.ok(restored.eventArchive.events.some((row) => row.event.fields.accountedUnits === 43));
  assert.equal(restored.eventArchive.completeness, 'not_established');
  assert.equal(restored.eventArchive.currentWindow.writeFailures, 0);
  assert.ok(restored.eventArchive.windowCheckpoints.some((item) => item.writeFailures === 1));
  assert.ok(
    restored.eventArchive.windowCoverage.some(
      (item) =>
        item.windowId === archive.currentWindow.windowId &&
        item.exportedEvents >= archive.events.length &&
        item.knownPersistedNotExportedEvents === 0,
    ),
  );
  assert.equal(restored.eventArchive.status, 'partial');
  assert.equal(restored.eventArchive.crashTailEvents, null);
  assert.doesNotMatch(
    JSON.stringify(restored),
    /Fictional medical canary|fictional-private-source|Fictional Cedar|lost publication acknowledgement/,
  );
  assert.notEqual(restored.eventArchive.currentWindow.windowId, archive.currentWindow.windowId);
});
