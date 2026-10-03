import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { outsideGit } from '../../deploy/run.ts';
import { LATEST_SCHEMA_VERSION } from '../server/database.ts';
import { readBuildSource } from './build-source.ts';
import {
  assertArchiveInventory,
  copyArchiveForDrill,
  inventoryArchive,
  type ArchiveInventory,
} from './archive-restore-copy.ts';
import {
  seedArchiveRestoreFixture,
  verifyArchiveRestoreFixture,
} from './archive-restore-fixture.ts';
import {
  repository,
  digest,
  summary,
  restoreDrillEnvironment,
  unusedPort,
  Installation,
  requestAdapter,
  newSession,
  assertLocked,
  lockedKitFailure,
} from './archive-drill-runtime.ts';
export { restoreDrillEnvironment } from './archive-drill-runtime.ts';

export async function qualifyArchiveRestore(env: NodeJS.ProcessEnv = process.env) {
  if (env.CRS_ARCHIVE_RESTORE_TEST !== '1')
    throw new Error('Set CRS_ARCHIVE_RESTORE_TEST=1 to authorize the fictional Compose drill.');
  const requested = env.CRS_RESTORE_OUTPUT_DIR;
  if (!requested || !isAbsolute(requested))
    throw new Error('CRS_RESTORE_OUTPUT_DIR must be a fresh absolute external directory.');
  outsideGit(requested);
  assert.equal(existsSync(requested), false, 'Qualification never overwrites an existing output');
  // Resolve the existing parent before exclusive creation; the path guard rejects symlinks.
  assert.equal(realpathSync(dirname(requested)), dirname(resolve(requested)));
  mkdirSync(requested, { mode: 0o700 });
  const root = realpathSync(requested);
  const environment = restoreDrillEnvironment(env);
  const docker = env.CRS_DOCKER || 'docker';
  const image = 'circus-health:restore-' + digest(root).slice(0, 12);
  const sourceIdentity = readBuildSource(repository);
  assert(sourceIdentity.revision, 'Qualification needs a repository commit identity');
  const sourceData = join(root, 'source/data');
  const backupData = join(root, 'backup/data');
  const restoredData = join(root, 'restored/data');
  const damagedData = join(root, 'missing-component/data');
  for (const directory of [
    'source/data',
    'backup',
    'restored',
    'missing-component',
    'kits',
    'receipts',
  ])
    mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
  const config = join(root, 'fictional-proxy.yaml');
  const providerEnv = join(root, 'fictional-provider.env');
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume without storing content. This endpoint never generates model output.
    }
    upstreamRequests++;
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Fictional unavailable upstream' } }));
  });
  let upstreamRequests = 0;
  await new Promise<void>((done) => upstream.listen(0, '0.0.0.0', done));
  writeFileSync(
    config,
    `model_list:\n  - model_name: fictional-restore\n    litellm_params:\n      model: openai/fictional-restore-upstream\n      api_base: http://host.docker.internal:${(upstream.address() as AddressInfo).port}/v1\n      api_key: os.environ/FICTIONAL_PROVIDER_KEY\n    model_info:\n      supports_vision: false\n      supports_pdf_input: false\n`,
    { mode: 0o600, flag: 'wx' },
  );
  writeFileSync(providerEnv, 'FICTIONAL_PROVIDER_KEY=fictional-restore-provider-key\n', {
    mode: 0o600,
    flag: 'wx',
  });
  const installations: Installation[] = [];
  const interrupted = new AbortController();
  const installation = async (name: string, data: string) => {
    const result = new Installation(
      data,
      join(root, name + '-proxy-state'),
      await unusedPort(),
      config,
      providerEnv,
      docker,
      image,
      join(root, 'receipts', name + '-launcher.log'),
      environment,
      interrupted.signal,
    );
    installations.push(result);
    return result;
  };
  let browser: Browser | undefined;
  const interrupt = () => {
    interrupted.abort(new Error('Archive restore qualification interrupted.'));
    for (const instance of installations) {
      if (!instance.process?.pid) continue;
      try {
        process.kill(-instance.process.pid, 'SIGINT');
      } catch {
        // Final cleanup checks the project and reports any remaining resources.
      }
    }
    void browser?.close().catch(() => {});
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const receipt: Record<string, unknown> = {
    format: 'circus-health-archive-restore-qualification-v1',
    startedAt: new Date().toISOString(),
    outcome: 'incomplete',
    sourceIdentity,
    dockerCommandOverride: docker !== 'docker',
    inference: 'local unavailable fictional upstream only',
  };
  const saveReceipt = () =>
    writeFileSync(
      join(root, 'receipts', 'qualification.json'),
      JSON.stringify(receipt, null, 2) + '\n',
      {
        mode: 0o600,
      },
    );
  saveReceipt();
  try {
    browser = await chromium.launch({ headless: true });
    const source = await installation('source', sourceData);
    receipt.phase = 'create-fictional-source';
    await source.start();
    assert.equal(source.runtime?.revision, sourceIdentity.revision);
    assert.equal(source.runtime?.worktree, sourceIdentity.worktree);
    const context = await newSession(browser, source);
    const seeded = await seedArchiveRestoreFixture(requestAdapter(context, source.base));
    const sourceCookies = await context.cookies();
    const kitPath = join(root, 'kits', 'fictional-recovery.json');
    writeFileSync(kitPath, JSON.stringify(seeded.recoveryKit), { mode: 0o600, flag: 'wx' });
    const oracle = seeded.oracle;
    writeFileSync(join(root, 'receipts', 'fictional-oracle.json'), JSON.stringify(oracle), {
      mode: 0o600,
      flag: 'wx',
    });
    await requestAdapter(context, source.base)(`/api/profiles/${oracle.profileId}/lock`, {
      method: 'POST',
      json: {},
    });
    await assertLocked(context, source.base, oracle);
    await context.close();
    await source.stop();
    source.assertStopped();
    const sourceInventory = await inventoryArchive(sourceData);
    const sourceVault = await inventoryArchive(
      join(sourceData, 'profiles', oracle.profileId, 'vault'),
    );
    const backupInventory = await copyArchiveForDrill(sourceData, backupData);
    assert.deepEqual(summary(backupInventory), summary(sourceInventory));
    writeFileSync(
      join(root, 'receipts', 'backup-inventory.json'),
      JSON.stringify(backupInventory),
      {
        mode: 0o600,
        flag: 'wx',
      },
    );
    await copyArchiveForDrill(backupData, restoredData);
    const restored = await installation('restored', restoredData);
    assert.notEqual(restored.project, source.project);
    assert.notEqual(restored.state, source.state);
    const registry = JSON.parse(readFileSync(join(backupData, 'profiles.json'), 'utf8')) as {
      format: string;
    };
    const keyring = JSON.parse(
      readFileSync(join(backupData, 'profiles', oracle.profileId, 'keyring.json'), 'utf8'),
    ) as { format: string };
    receipt.build = source.runtime;
    receipt.imageId = source.dockerRun(['image', 'inspect', image, '--format', '{{.Id}}']);
    receipt.formats = {
      registry: registry.format,
      keyring: keyring.format,
      recoveryKit: seeded.recoveryKit.format,
      disposableCacheSchema: LATEST_SCHEMA_VERSION,
    };
    receipt.backup = summary(backupInventory);
    receipt.phase = 'unusable-kit';
    const requestsBeforeRestore = upstreamRequests;
    await restored.start();
    assert.deepEqual(
      restored.runtime,
      source.runtime,
      'Every stage must use the same built artifact',
    );
    let restoredContext = await newSession(browser, restored);
    await assertLocked(restoredContext, restored.base, oracle);
    await lockedKitFailure(restoredContext, restored, oracle);
    const foreignContext = await browser.newContext();
    await foreignContext.addCookies(sourceCookies);
    await assertLocked(foreignContext, restored.base, oracle);
    await foreignContext.close();
    await restoredContext.close();
    await restored.stop();
    await assertArchiveInventory(restoredData, backupInventory);
    receipt.unusableKit = { refused: true, privateScopeUnavailable: true, archiveUnchanged: true };

    receipt.phase = 'independent-restore';
    await restored.start();
    assert.deepEqual(
      restored.runtime,
      source.runtime,
      'Every stage must use the same built artifact',
    );
    restoredContext = await newSession(browser, restored);
    let request = requestAdapter(restoredContext, restored.base);
    await assertLocked(restoredContext, restored.base, oracle);
    await request(`/api/profiles/${oracle.profileId}/unlock`, {
      method: 'POST',
      json: { recovery: JSON.parse(readFileSync(kitPath, 'utf8')) },
    });
    const staleSourceSession = await browser.newContext();
    await staleSourceSession.addCookies(sourceCookies);
    await assertLocked(staleSourceSession, restored.base, oracle);
    await staleSourceSession.close();
    const counts = await verifyArchiveRestoreFixture(request, oracle);
    await request(`/api/profiles/${oracle.profileId}/lock`, { method: 'POST', json: {} });
    await assertLocked(restoredContext, restored.base, oracle);
    await restoredContext.close();
    await restored.stop();
    await assertArchiveInventory(
      join(restoredData, 'profiles', oracle.profileId, 'vault'),
      sourceVault,
    );
    receipt.phase = 'cache-loss-recreation';
    const cache = join(restoredData, 'profiles', oracle.profileId, 'cache');
    assert(existsSync(cache), 'The drill must actually remove an existing disposable cache');
    rmSync(cache, { recursive: true });
    await restored.start();
    restoredContext = await newSession(browser, restored);
    assert.deepEqual(
      restored.runtime,
      source.runtime,
      'Cache reconstruction must use the same built artifact',
    );
    request = requestAdapter(restoredContext, restored.base);
    await assertLocked(restoredContext, restored.base, oracle);
    await request(`/api/profiles/${oracle.profileId}/unlock`, {
      method: 'POST',
      json: { recovery: JSON.parse(readFileSync(kitPath, 'utf8')) },
    });
    assert.deepEqual(await verifyArchiveRestoreFixture(request, oracle), counts);
    await request(`/api/profiles/${oracle.profileId}/lock`, { method: 'POST', json: {} });
    await assertLocked(restoredContext, restored.base, oracle);
    await restoredContext.close();
    await restored.stop();
    await assertArchiveInventory(
      join(restoredData, 'profiles', oracle.profileId, 'vault'),
      sourceVault,
    );
    assert.equal(
      upstreamRequests,
      requestsBeforeRestore,
      'Restore/cache rebuild must not invoke inference',
    );

    receipt.phase = 'missing-registry';
    await copyArchiveForDrill(backupData, damagedData);
    rmSync(join(damagedData, 'profiles.json'));
    await assert.rejects(assertArchiveInventory(damagedData, backupInventory));
    const missingInventory: ArchiveInventory = await inventoryArchive(damagedData);
    const damaged = await installation('missing-component', damagedData);
    await damaged.start(true);
    await assertArchiveInventory(damagedData, missingInventory);
    source.assertStopped();
    await assertArchiveInventory(sourceData, sourceInventory);
    await assertArchiveInventory(backupData, backupInventory);
    assert.equal(upstreamRequests, requestsBeforeRestore);
    Object.assign(receipt, {
      phase: 'complete',
      outcome: 'passed',
      completedAt: new Date().toISOString(),
      counts,
      missingComponent: {
        refused: true,
        privateScopeUnavailable: true,
        remainingAuthorityUnchanged: true,
      },
      sourceAndBackupUnchanged: true,
      restoredVaultUnchanged: true,
      sourceSessionRejectedByRestore: true,
      restoreAndRebuildInferenceRequests: 0,
      restoredState: 'clinical and key state retained by this independent backup',
      rollbackPrevention: false,
      scope:
        'one small fictional current-format Compose installation; not filesystem/power-loss/provider/device qualification',
    });
    saveReceipt();
    return receipt;
  } catch (error) {
    receipt.outcome = 'failed';
    receipt.completedAt = new Date().toISOString();
    writeFileSync(
      join(root, 'receipts', 'failure.log'),
      error instanceof Error ? (error.stack ?? error.message) : 'Qualification failed',
      { mode: 0o600 },
    );
    saveReceipt();
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      browser?.close(),
      ...installations.map((instance) => instance.stop()),
      new Promise<void>((done) => {
        upstream.closeAllConnections();
        upstream.close(() => done());
      }),
    ]);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    const failures = cleanup.filter((result) => result.status === 'rejected');
    if (failures.length) {
      receipt.outcome = 'failed';
      receipt.cleanupFailed = true;
      saveReceipt();
      throw new Error(
        'Qualification cleanup failed; preserve artifacts and inspect project resources.',
      );
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Counts and identities only; kits, file inventories and logs remain external.
  qualifyArchiveRestore()
    .then((receipt) => console.log(JSON.stringify(receipt, null, 2)))
    .catch(() => {
      console.error(
        'Archive restore qualification failed. Preserve its external artifacts and inspect the protected phase receipt/logs.',
      );
      process.exitCode = 1;
    });
}
