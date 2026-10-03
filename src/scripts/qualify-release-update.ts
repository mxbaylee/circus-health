import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { outsideGit } from '../../deploy/run.ts';
import { readBuildSource } from './build-source.ts';
import {
  assertArchiveInventory,
  copyArchiveForDrill,
  inventoryArchive,
} from './archive-restore-copy.ts';
import {
  seedArchiveRestoreFixture,
  verifyArchiveRestoreFixture,
} from './archive-restore-fixture.ts';
import {
  assertLocked,
  digest,
  Installation,
  newSession,
  repository,
  requestAdapter,
  restoreDrillEnvironment,
  summary,
  unusedPort,
} from './archive-drill-runtime.ts';
import { futureReleaseFixture, releaseArchiveFormats } from './release-update-fixture.ts';
import type { RecoveryKit } from '../server/vault-crypto.ts';

export function releaseSourceFingerprint(directory: string): string {
  const names = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: directory, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  )
    .split('\0')
    .filter(Boolean)
    .sort();
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(name + '\0');
    const file = join(directory, name);
    hash.update(existsSync(file) ? readFileSync(file) : '<deleted>');
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Prepare a fresh normal clone without changing its release source identity. */
export function preparePriorReleaseRuntime(
  priorRepository: string,
  candidateRepository: string,
  environment: NodeJS.ProcessEnv,
): void {
  // The host launcher imports native flock before Docker starts. Container builds
  // still install their own pinned dependencies, regardless of this host reuse.
  const matchingLock = readFileSync(join(priorRepository, 'package-lock.json')).equals(
    readFileSync(join(candidateRepository, 'package-lock.json')),
  );
  const installed = join(candidateRepository, 'node_modules');
  if (matchingLock && existsSync(installed)) {
    const destination = join(priorRepository, 'node_modules');
    // A node_modules/ Git ignore rule matches a real directory, not a symlink.
    // Keep that directory real and link each pinned dependency inside it.
    mkdirSync(destination, { mode: 0o700 });
    for (const entry of readdirSync(installed)) {
      symlinkSync(join(installed, entry), join(destination, entry));
    }
  } else {
    execFileSync('npm', ['ci', '--no-audit', '--no-fund'], {
      cwd: priorRepository,
      env: { ...environment, HUSKY: '0' },
      timeout: 300000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  execFileSync('npm', ['run', 'help'], {
    cwd: priorRepository,
    env: environment,
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function qualifyReleaseUpdate(env: NodeJS.ProcessEnv = process.env) {
  if (env.CRS_RELEASE_UPDATE_TEST !== '1')
    throw new Error(
      'Set CRS_RELEASE_UPDATE_TEST=1 to authorize the fictional release-update Compose drill.',
    );
  const requested = env.CRS_UPDATE_OUTPUT_DIR;
  if (!requested || !isAbsolute(requested))
    throw new Error('CRS_UPDATE_OUTPUT_DIR must be a fresh absolute external directory.');
  outsideGit(requested);
  assert.equal(existsSync(requested), false, 'Qualification never overwrites an existing output');
  assert.equal(realpathSync(dirname(requested)), dirname(resolve(requested)));
  const environment = restoreDrillEnvironment(env);
  const priorRef = env.CRS_UPDATE_PRIOR_REVISION;
  assert(priorRef, 'CRS_UPDATE_PRIOR_REVISION must explicitly select the prior release commit');
  assert.match(priorRef, /^[0-9a-f]{7,64}$/, 'Prior release must be an exact commit object ID');
  const priorRevision = execFileSync('git', ['rev-parse', '--verify', `${priorRef}^{commit}`], {
    cwd: repository,
    encoding: 'utf8',
    env: environment,
  }).trim();
  mkdirSync(requested, { mode: 0o700 });
  const root = realpathSync(requested);
  for (const path of [
    'source/data',
    'backup',
    'preflight',
    'candidate',
    'recovered',
    'future-registry',
    'missing-registry',
    'future-index',
    'kits',
    'receipts',
  ])
    mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
  const receipt: Record<string, unknown> = {
    format: 'circus-health-release-update-qualification-v1',
    outcome: 'incomplete',
    startedAt: new Date().toISOString(),
    limits: {
      postBackupWritesRecovered: false,
      generalDowngradeCompatibility: false,
      rollbackPrevention: false,
      scope:
        'one small fictional supported-format local Compose release pair; no migration, updater, live provider, power-loss or remote-deployment qualification',
    },
    dockerCommandOverride: Boolean(env.CRS_DOCKER && env.CRS_DOCKER !== 'docker'),
  };
  const save = () =>
    writeFileSync(
      join(root, 'receipts/qualification.json'),
      JSON.stringify(receipt, null, 2) + '\n',
      { mode: 0o600 },
    );
  const protectedJson = (name: string, value: unknown) =>
    writeFileSync(join(root, name), JSON.stringify(value, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
  save();
  let upstreamRequests = 0;
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Never retain request content. */
    }
    upstreamRequests++;
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Fictional unavailable upstream' } }));
  });
  const installations: Installation[] = [];
  const abort = new AbortController();
  let browser: Browser | undefined;
  const interrupt = () => {
    abort.abort(new Error('Release qualification interrupted.'));
    for (const instance of installations)
      if (instance.process?.pid) {
        try {
          process.kill(-instance.process.pid, 'SIGINT');
        } catch {
          /* Cleanup checks resources. */
        }
      }
    void browser?.close().catch(() => {});
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    receipt.phase = 'select-real-releases';
    save();
    const priorRepository = join(root, 'prior-release');
    const gitLog = join(root, 'receipts/prior-checkout.log');
    // A normal detached clone retains the real commit identity. No worktrees or invented build revisions.
    const git = (args: string[]) =>
      execFileSync('git', args, {
        encoding: 'utf8',
        env: environment,
        timeout: 120000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    writeFileSync(
      gitLog,
      git(['clone', '--shared', '--no-checkout', repository, priorRepository]),
      { mode: 0o600, flag: 'wx' },
    );
    git(['-C', priorRepository, 'checkout', '--detach', priorRevision]);
    preparePriorReleaseRuntime(priorRepository, repository, environment);

    const priorSource = readBuildSource(priorRepository);
    const candidateSource = readBuildSource(repository);
    assert.equal(priorSource.revision, priorRevision);
    assert.equal(priorSource.worktree, 'clean');
    assert(candidateSource.revision);
    const priorFingerprint = releaseSourceFingerprint(priorRepository);
    const candidateFingerprint = releaseSourceFingerprint(repository);
    assert.notEqual(
      candidateFingerprint,
      priorFingerprint,
      'Qualification requires genuinely different prior and candidate source trees',
    );
    receipt.sources = {
      prior: { ...priorSource, treeSha256: priorFingerprint },
      candidate: { ...candidateSource, treeSha256: candidateFingerprint },
    };
    await new Promise<void>((done) => upstream.listen(0, '0.0.0.0', done));
    const config = join(root, 'fictional-proxy.yaml');
    const providerEnv = join(root, 'fictional-provider.env');
    writeFileSync(
      config,
      `model_list:\n  - model_name: fictional-restore\n    litellm_params:\n      model: openai/fictional-restore-upstream\n      api_base: http://host.docker.internal:${(upstream.address() as AddressInfo).port}/v1\n      api_key: os.environ/FICTIONAL_PROVIDER_KEY\n    model_info:\n      supports_vision: false\n      supports_pdf_input: false\n`,
      { mode: 0o600, flag: 'wx' },
    );
    writeFileSync(providerEnv, 'FICTIONAL_PROVIDER_KEY=fictional-release-provider-key\n', {
      mode: 0o600,
      flag: 'wx',
    });
    receipt.configuration = {
      deployment: 'npm → Docker Compose → LiteLLM',
      archive: 'explicit separate stopped-copy data directories',
      proxyConfigSha256: digest(readFileSync(config, 'utf8')),
      model: 'fictional-restore',
      images: false,
      pdf: false,
      promptCache: false,
      provider: 'local unavailable fictional endpoint; credentials omitted',
    };
    const priorImage = 'circus-health:update-prior-' + digest(root).slice(0, 12);
    const candidateImage = 'circus-health:update-candidate-' + digest(root).slice(0, 12);
    const installation = async (name: string, data: string, prior = false) => {
      for (const instance of installations) {
        assert(!instance.process, 'Stop the sole drill writer before switching releases');
        instance.assertStopped();
      }
      const result = new Installation(
        data,
        join(root, name + '-proxy-state'),
        await unusedPort(),
        config,
        providerEnv,
        env.CRS_DOCKER || 'docker',
        prior ? priorImage : candidateImage,
        join(root, 'receipts', name + '-launcher.log'),
        environment,
        abort.signal,
        prior ? priorRepository : repository,
      );
      installations.push(result);
      return result;
    };
    const sourceData = join(root, 'source/data');
    const backupData = join(root, 'backup/data');
    const candidateData = join(root, 'candidate/data');
    browser = await chromium.launch({ headless: true });
    const source = await installation('source', sourceData, true);
    receipt.phase = 'seed-prior-release';
    save();
    await source.start();
    assert.equal(source.runtime?.revision, priorRevision);
    assert.equal(source.runtime?.worktree, 'clean');
    const sourceContext = await newSession(browser, source);
    const seeded = await seedArchiveRestoreFixture(requestAdapter(sourceContext, source.base));
    const { oracle } = seeded;
    protectedJson('kits/fictional-recovery.json', seeded.recoveryKit);
    protectedJson('receipts/fictional-oracle.json', oracle);
    await requestAdapter(sourceContext, source.base)(`/api/profiles/${oracle.profileId}/lock`, {
      method: 'POST',
      json: {},
    });
    await assertLocked(sourceContext, source.base, oracle);
    await sourceContext.close();
    await source.stop();
    assert.equal(upstreamRequests, 0, 'Fictional seeding must not request a model');
    const sourceInventory = await inventoryArchive(sourceData);
    const vaultRelative = join('profiles', oracle.profileId, 'vault');
    const vaultInventory = await inventoryArchive(join(sourceData, vaultRelative));
    const backupInventory = await copyArchiveForDrill(sourceData, backupData);
    protectedJson('receipts/backup-inventory.json', backupInventory);
    receipt.backup = {
      ...summary(backupInventory),
      soleWriterStopped: true,
      consistentCopyVerified: true,
    };
    const priorFormats = releaseArchiveFormats(backupData, seeded.recoveryKit);
    await copyArchiveForDrill(backupData, candidateData);
    const candidate = await installation('candidate', candidateData);
    const loadKit = () =>
      JSON.parse(readFileSync(join(root, 'kits/fictional-recovery.json'), 'utf8')) as RecoveryKit;
    const verify = async (instance: Installation, cacheMiss = false) => {
      for (const other of installations)
        if (other !== instance) {
          assert(!other.process);
          other.assertStopped();
        }
      await instance.start();
      const expected = instance === candidate ? candidateSource : priorSource;
      assert.equal(instance.runtime?.revision, expected.revision);
      assert.equal(instance.runtime?.worktree, expected.worktree);
      const context = await newSession(browser!, instance);
      await assertLocked(context, instance.base, oracle);
      const request = requestAdapter(context, instance.base);
      const unlocked = await request<{ metrics: { cacheHit: boolean } }>(
        `/api/profiles/${oracle.profileId}/unlock`,
        { method: 'POST', json: { recovery: loadKit() } },
      );
      if (cacheMiss)
        assert.equal(
          unlocked.metrics.cacheHit,
          false,
          'Incompatible disposable cache must reconstruct',
        );
      const counts = await verifyArchiveRestoreFixture(request, oracle);
      await request(`/api/profiles/${oracle.profileId}/lock`, { method: 'POST', json: {} });
      await assertLocked(context, instance.base, oracle);
      await context.close();
      await instance.stop();
      await assertArchiveInventory(join(instance.data, vaultRelative), vaultInventory);
      return counts;
    };
    receipt.phase = 'independent-backup-preflight';
    save();
    const preflightData = join(root, 'preflight/data');
    await copyArchiveForDrill(backupData, preflightData);
    const preflight = await installation('preflight', preflightData, true);
    const preflightCounts = await verify(preflight);
    assert.deepEqual(preflight.runtime, source.runtime);
    await assertArchiveInventory(backupData, backupInventory);
    receipt.backupPreflight = {
      priorApp: true,
      separateBackupCopy: true,
      independentKitUnlock: true,
      exactFixturePreserved: true,
    };
    receipt.phase = 'supported-candidate-update';
    save();
    const counts = await verify(candidate);
    assert.deepEqual(counts, preflightCounts);
    assert.notEqual(
      candidate.runtime?.buildId,
      source.runtime?.buildId,
      'Prior and candidate must be distinct real builds',
    );
    const candidateRuntime = candidate.runtime;
    const candidateFormats = releaseArchiveFormats(candidateData, loadKit());
    assert.deepEqual(
      candidateFormats,
      priorFormats,
      'This bounded drill requires unchanged supported authority/cache formats',
    );
    receipt.builds = {
      prior: {
        ...source.runtime,
        imageId: source.dockerRun(['image', 'inspect', priorImage, '--format', '{{.Id}}']),
      },
      candidate: {
        ...candidate.runtime,
        imageId: candidate.dockerRun(['image', 'inspect', candidateImage, '--format', '{{.Id}}']),
      },
    };
    receipt.formats = { prior: priorFormats, candidate: candidateFormats };
    receipt.phase = 'incompatible-disposable-cache';
    save();
    futureReleaseFixture(candidateData, loadKit(), 'cache');
    await assertArchiveInventory(join(candidateData, vaultRelative), vaultInventory);
    assert.deepEqual(await verify(candidate, true), counts);
    assert.deepEqual(
      candidate.runtime,
      candidateRuntime,
      'Recreation must use the same candidate artifact',
    );
    assert.deepEqual(releaseArchiveFormats(candidateData, loadKit()), priorFormats);
    receipt.cacheRecreation = {
      futureSchema: 999999,
      rebuiltFromSupportedAuthority: true,
      exactFixturePreserved: true,
      vaultUnchanged: true,
    };
    const refusals: Record<string, unknown> = {};
    for (const name of ['future-registry', 'missing-registry'] as const) {
      receipt.phase = name;
      save();
      const data = join(root, name, 'data');
      await copyArchiveForDrill(backupData, data);
      const registry = join(data, 'profiles.json');
      if (name === 'missing-registry') rmSync(registry);
      else {
        const value = JSON.parse(readFileSync(registry, 'utf8')) as { format: string };
        value.format = 'circus-health-profiles-v999';
        writeFileSync(registry, JSON.stringify(value), { mode: 0o600 });
      }
      const protectedInventory = await inventoryArchive(data);
      const refused = await installation(name, data);
      await refused.start(
        name === 'missing-registry'
          ? true
          : 'Archive registry is missing, invalid or unsupported. All profiles are unavailable. Preserve this archive and use a compatible app release, or restore a complete pre-update backup into a separate data directory. Do not reset or convert this archive.',
      );
      await assertArchiveInventory(data, protectedInventory);
      refusals[name] = { boundary: 'whole startup', refused: true, protectedCopyUnchanged: true };
    }
    receipt.phase = 'future-encrypted-index';
    save();
    const futureData = join(root, 'future-index/data');
    await copyArchiveForDrill(backupData, futureData);
    futureReleaseFixture(futureData, loadKit(), 'manifest');
    const futureInventory = await inventoryArchive(futureData);
    const future = await installation('future-index', futureData);
    await future.start();
    assert.deepEqual(future.runtime, candidateRuntime);
    const context = await newSession(browser, future);
    await assertLocked(context, future.base, oracle);
    const response = await context.request.post(
      `${future.base}/api/profiles/${oracle.profileId}/unlock`,
      { headers: { Origin: future.base }, data: { recovery: loadKit() } },
    );
    assert.equal(response.status(), 409);
    const refusal = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(refusal.error.code, 'ARCHIVE_UNSUPPORTED');
    assert.match(refusal.error.message, /encrypted index|manifest/);
    assert.match(refusal.error.message, /Preserve.*compatible app release/);
    await response.dispose();
    await assertLocked(context, future.base, oracle);
    await context.close();
    await future.stop();
    await assertArchiveInventory(futureData, futureInventory);
    refusals['future-index'] = {
      boundary: 'profile unlock; startup may list locked profiles',
      refused: true,
      privateScopeUnavailable: true,
      protectedCopyUnchanged: true,
    };
    receipt.refusals = refusals;
    receipt.phase = 'prior-app-independent-recovery';
    save();
    await assertArchiveInventory(backupData, backupInventory);
    const recoveredData = join(root, 'recovered/data');
    await copyArchiveForDrill(backupData, recoveredData);
    const recovered = await installation('recovered', recoveredData, true);
    assert.deepEqual(await verify(recovered), counts);
    assert.deepEqual(
      recovered.runtime,
      source.runtime,
      'Recovery must use the retained prior app artifact',
    );
    await assertArchiveInventory(sourceData, sourceInventory);
    await assertArchiveInventory(backupData, backupInventory);
    assert.equal(
      releaseSourceFingerprint(repository),
      candidateFingerprint,
      'Candidate source changed during qualification',
    );
    assert.equal(releaseSourceFingerprint(priorRepository), priorFingerprint);
    assert.equal(upstreamRequests, 0, 'Release qualification must not invoke a model');
    Object.assign(receipt, {
      phase: 'complete',
      outcome: 'passed',
      completedAt: new Date().toISOString(),
      counts,
      modelRequests: upstreamRequests,
      sourceAndBackupUnchanged: true,
      recovery:
        'prior app plus a fresh isolated untouched-backup copy and independently retained kit; candidate archive never downgraded',
      preserved: [
        'exact originals',
        'accepted records/history',
        'correction actor/time/source',
        'pending review',
        'explicit Stop',
      ],
    });
    save();
    return receipt;
  } catch (error) {
    Object.assign(receipt, {
      outcome: 'failed',
      completedAt: new Date().toISOString(),
      modelRequests: upstreamRequests,
    });
    writeFileSync(
      join(root, 'receipts/failure.log'),
      error instanceof Error ? error.stack || error.message : 'Qualification failed',
      { mode: 0o600 },
    );
    save();
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
    if (cleanup.some((result) => result.status === 'rejected')) {
      receipt.outcome = 'failed';
      receipt.cleanupFailed = true;
      save();
      throw new Error(
        'Release qualification cleanup failed; preserve artifacts and inspect project resources.',
      );
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  qualifyReleaseUpdate()
    .then((receipt) => console.log(JSON.stringify(receipt, null, 2)))
    .catch(() => {
      console.error(
        'Release-update qualification failed. Preserve its external artifacts and inspect the protected phase receipt/logs.',
      );
      process.exitCode = 1;
    });
}
