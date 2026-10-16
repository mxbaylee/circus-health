import test from 'node:test';
import assert from 'node:assert/strict';
import timers from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { writeFileSync as managedWrite } from '../journal-physical-write.ts';
import { createHash } from 'node:crypto';
import { deferred } from './helpers/vault-fixture.ts';
import { getIntakeOriginal } from '../intake.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createVaultApp } from '../vault-app.ts';
import type { createApp } from '../index.ts';
import { HttpError } from '../database.ts';
import { createImportDiagnostics } from '../import-diagnostics.ts';
import {
  captureRecordAuthorityWitness,
  recordAuthorityWitnessCurrent,
} from '../record-versions.ts';
import {
  captureManagedPhysicalEpoch,
  managedPhysicalEpochCurrent,
} from '../clinical-review-physical-epoch.ts';

test('authorized encrypted upload admits a prior model-preflight journal continuation after its original bridge proof', async (t) => {
  const entered = deferred<void>(),
    check = deferred<{ available: boolean }>(),
    saved = deferred<void>(),
    errorEntered = deferred<void>(),
    errorCheck = deferred<void>(),
    errorSaved = deferred<void>();
  let preflights = 0,
    publications = 0,
    diagnosticOriginal = '';
  const diagnostics = createImportDiagnostics({
    enabled: true,
    onEvent(event) {
      if (event.event === 'import.progress' && event.fields.reasonCode === 'source-review-conflict')
        errorSaved.resolve();
      if (!diagnosticOriginal && event.fields.phase === 'model_preflight')
        diagnosticOriginal = event.context.importId || '';
      if (
        event.event === 'import.progress' &&
        event.fields.reasonCode === 'model-unavailable' &&
        event.context.importId === diagnosticOriginal
      ) {
        publications++;
        saved.resolve();
      }
    },
  });
  const base = mkdtempSync(join(tmpdir(), 'fictional-upload-bridge-'));
  mkdirSync(join(base, 'data'));
  const app = createVaultApp({
    dataDirectory: join(base, 'data'),
    runtimeDirectory: join(base, 'runtime'),
    diagnostics,
    assistantOptions: {
      availability: async () => ({ available: false }),
      connectionCheck: async () => {
        preflights++;
        entered.resolve();
        return check.promise;
      },
    },
  });
  t.after(() => {
    check.resolve({ available: false });
    errorCheck.resolve();
    app.close();
    diagnostics.close();
    rmSync(base, { recursive: true, force: true });
  });
  await new Promise<void>((ready) => app.server.listen(0, '127.0.0.1', ready));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  let cookie = '';
  async function send(path: string, body?: string | Blob, headers: Record<string, string> = {}) {
    const response = await fetch(url + path, {
      ...(body === undefined ? {} : { method: 'POST', body }),
      headers: {
        Origin: 'http://127.0.0.1:5173',
        'Content-Type': 'application/json',
        ...headers,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    return response;
  }
  const setup = await send(
    '/api/profile-setups',
    JSON.stringify({
      fullName: 'Fictional Linden Doe',
      birthDate: '1971-03-09',
      name: 'Fictional Linden Doe',
      placebo: false,
    }),
  );
  assert.equal(setup.status, 201);
  const kit = (await setup.json()) as { data: { setupId: string; recoveryKit: unknown } };
  const verified = await send(
    `/api/profile-setups/${kit.data.setupId}/verify`,
    JSON.stringify({ acknowledged: true, recovery: kit.data.recoveryKit }),
  );
  assert.equal(verified.status, 201);
  const profileId = ((await verified.json()) as { data: { id: string } }).data.id;
  const state = app.manager.opened.get(profileId)!;
  const prefix = `/api/profiles/${profileId}`;
  async function upload(name: string) {
    return send(
      prefix + '/intakes',
      new Blob([`Fictional ${name} source.\n`], { type: 'text/plain' }),
      { 'Content-Type': 'text/plain', 'X-Filename': name },
    );
  }
  const first = await upload('fictional-linden.txt');
  assert.equal(first.status, 201, await first.clone().text());
  const original = ((await first.json()) as { data: { id: string } }).data.id;
  await entered.promise;
  // A held model request does not occupy the host's clinical-operation lane.
  assert.equal((await send(prefix + '/intakes/' + original)).status, 200);
  const whileHeld = await upload('fictional-maple.txt');
  assert.equal(whileHeld.status, 201, await whileHeld.text());
  assert.equal(
    publications,
    0,
    'an ordinary upload completes while the prior model preflight remains held',
  );
  assert.equal(preflights, 1);
  const priorOriginal = getIntakeOriginal(state.db, state.root, profileId, original);
  const originalBytes = readFileSync(priorOriginal.path);
  const history = () =>
    state.db
      .prepare(
        "SELECT version_id,contents_json,metadata_json FROM __record_versions WHERE entity='source_files' AND record_id=? ORDER BY version_id",
      )
      .all(JSON.stringify([original]));
  const accepted = history();
  assert.ok(accepted.length > 0);
  const nativeImmediate = timers.setImmediate;
  let releases = 0,
    foreignChanges = 0;
  let intervention: 'preflight' | 'stop' | 'pump-error' | 'foreign' = 'preflight';
  let stopTask: Promise<Response> | undefined;
  let stopBatchId = '';
  const observations: Record<string, boolean>[] = [];
  t.mock.method(timers, 'setImmediate', async (...args: Parameters<typeof timers.setImmediate>) => {
    if (!releases && new Error().stack?.includes('prepareIntakeLegacyBridgeProofAsync')) {
      releases++;
      const stamp = () => ({
        main: state.db.prepare('PRAGMA main.schema_version').get()!.schema_version,
        temp: state.db.prepare('PRAGMA temp.schema_version').get()!.schema_version,
        peer: state.db.prepare('PRAGMA main.data_version').get()!.data_version,
        writes: state.db.prepare('SELECT total_changes() AS n').get()!.n,
      });
      const before = stamp(),
        epoch = captureManagedPhysicalEpoch()!,
        authority = captureRecordAuthorityWitness(state.db);
      if (intervention === 'foreign') {
        const manifest = join(base, 'data', 'profiles', profileId, 'vault', 'manifest.enc');
        const bytes = readFileSync(manifest);
        managedWrite(manifest, bytes);
        foreignChanges++;
      } else if (intervention === 'stop') {
        stopTask = send(`${prefix}/intake-batches/${stopBatchId}/stop`, '{}');
      } else if (intervention === 'pump-error') {
        errorCheck.resolve();
      } else check.resolve({ available: false });
      // One real host yield drains the released preflight continuation. The
      // gate is the named bridge phase, never an elapsed-time approximation.
      await nativeImmediate();
      const after = stamp();
      observations.push({
        main: before.main === after.main,
        temp: before.temp === after.temp,
        peer: before.peer === after.peer,
        writes: before.writes === after.writes,
        physical: managedPhysicalEpochCurrent(epoch),
        authority: recordAuthorityWitnessCurrent(state.db, authority),
      });
    }
    return nativeImmediate(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const next = await upload('fictional-magnolia.txt');
  const result = await next.text();
  t.diagnostic(JSON.stringify({ preflights, releases, publications, observations }));
  assert.equal(
    releases,
    1,
    'release the previous background preflight inside the new original bridge proof',
  );
  assert.equal(next.status, 201, result);
  assert.deepEqual(observations, [
    { main: true, temp: true, peer: true, writes: true, physical: true, authority: true },
  ]);
  await saved.promise;
  assert.equal(publications, 1);
  assert.equal((await send(prefix + '/intakes/' + original)).status, 200);
  assert.deepEqual(
    readFileSync(getIntakeOriginal(state.db, state.root, profileId, original).path),
    originalBytes,
  );
  assert.deepEqual(history(), accepted, 'earlier accepted source versions are unchanged');
  assert.equal(createHash('sha256').update(originalBytes).digest('hex'), priorOriginal.sourceHash);
  const unauthenticated = await fetch(url + prefix + '/intakes/' + original);
  assert.equal(unauthenticated.status, 423);

  // Public Stop starts during the same original-proof phase, then waits for
  // the admitted upload before changing and publishing the batch.
  const batchesResponse = await send(prefix + '/intake-batches');
  assert.equal(batchesResponse.status, 200);
  const batches = (await batchesResponse.json()) as { data: { id: string; status: string }[] };
  stopBatchId = batches.data.find((batch) => batch.status === 'running')!.id;
  releases = 0;
  intervention = 'stop';
  const whileStopping = await upload('fictional-willow.txt');
  assert.equal(whileStopping.status, 201, await whileStopping.text());
  assert.equal(releases, 1);
  assert.equal((await stopTask!).status, 200);
  const stoppedResponse = await send(`${prefix}/intake-batches/${stopBatchId}`);
  assert.equal(stoppedResponse.status, 200);
  assert.equal(
    ((await stoppedResponse.json()) as { data: { status: string } }).data.status,
    'stopped',
  );
  assert.deepEqual(observations.at(-1), {
    main: true,
    temp: true,
    peer: true,
    writes: true,
    physical: true,
    authority: true,
  });

  // Exercise the detached pump error path with the real encrypted batch issuer.
  // A source-review error is not converted to the model-unavailable branch.
  const profileApp = state.app as ReturnType<typeof createApp>;
  const ensureConnection = t.mock.method(profileApp.assistant, 'ensureConnection', async () => {
    errorEntered.resolve();
    await errorCheck.promise;
    throw new HttpError(409, 'SOURCE_TEXT_REVIEW_CONFLICT', 'Fictional source review changed.');
  });
  const errorSource = await upload('fictional-spruce.txt');
  assert.equal(errorSource.status, 201, await errorSource.clone().text());
  const errorId = ((await errorSource.json()) as { data: { id: string } }).data.id;
  await errorEntered.promise;
  releases = 0;
  intervention = 'pump-error';
  const duringError = await upload('fictional-birch.txt');
  assert.equal(duringError.status, 201, await duringError.text());
  assert.equal(releases, 1);
  await errorSaved.promise;
  ensureConnection.mock.restore();
  assert.deepEqual(observations.at(-1), {
    main: true,
    temp: true,
    peer: true,
    writes: true,
    physical: true,
    authority: true,
  });
  assert.equal(
    diagnostics
      .snapshot(profileId)
      .filter(
        (event) =>
          event.event === 'import.progress' &&
          event.fields.reasonCode === 'source-review-conflict' &&
          event.context.importId === errorId,
      ).length,
    1,
  );

  // A real managed rewrite, even with equal ciphertext bytes, remains a
  // foreign authority change. Coordination never renews or weakens this proof.
  releases = 0;
  intervention = 'foreign';
  const refused = await upload('fictional-oak.txt');
  assert.equal(refused.status, 500, await refused.text());
  assert.equal(releases, 1);
  assert.equal(foreignChanges, 1);
  assert.deepEqual(observations.at(-1), {
    main: true,
    temp: true,
    peer: true,
    writes: true,
    physical: false,
    authority: false,
  });
  assert.deepEqual(history(), accepted);
  assert.deepEqual(
    readFileSync(getIntakeOriginal(state.db, state.root, profileId, original).path),
    originalBytes,
  );
  t.diagnostic(
    JSON.stringify({ preflights, releases, foreignChanges, publications, observations }),
  );
});
