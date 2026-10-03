import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { outsideGit } from '../../deploy/run.ts';
import {
  preparePriorReleaseRuntime,
  qualifyReleaseUpdate,
  releaseSourceFingerprint,
} from './qualify-release-update.ts';
import { repository, restoreDrillEnvironment } from './archive-drill-runtime.ts';
import { readBuildSource } from './build-source.ts';

const neverDocker = '/fictional-tool-must-never-run';

test('sharing pinned launcher dependencies keeps a normal prior clone clean and its source fingerprint unchanged', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-prior-dependencies-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prior = join(root, 'prior');
  const environment = restoreDrillEnvironment(process.env);
  execFileSync('git', ['clone', '--quiet', '--shared', '--no-checkout', repository, prior], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execFileSync('git', ['-C', prior, 'checkout', '--quiet', '--detach', 'HEAD'], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const before = readBuildSource(prior);
  assert.equal(before.worktree, 'clean');
  const fingerprint = releaseSourceFingerprint(prior);
  assert(
    readFileSync(join(prior, 'package-lock.json')).equals(
      readFileSync(join(repository, 'package-lock.json')),
    ),
    'This host reuse regression requires the checked-in pinned dependency tree',
  );
  // This runs the actual prior npm help entry point, including its Koffi import.
  preparePriorReleaseRuntime(prior, repository, environment);
  assert.equal(lstatSync(join(prior, 'node_modules')).isDirectory(), true);
  assert.equal(lstatSync(join(prior, 'node_modules')).isSymbolicLink(), false);
  assert.equal(lstatSync(join(prior, 'node_modules/koffi')).isSymbolicLink(), true);
  assert.equal(
    realpathSync(join(prior, 'node_modules/koffi')),
    realpathSync(join(repository, 'node_modules/koffi')),
  );
  assert.deepEqual(readBuildSource(prior), before);
  assert.equal(releaseSourceFingerprint(prior), fingerprint);
});

test('release qualification requires exact opt-in before accessing tools or output', async () => {
  for (const value of [undefined, '', 'true', '0'])
    await assert.rejects(
      qualifyReleaseUpdate({ CRS_RELEASE_UPDATE_TEST: value, CRS_DOCKER: neverDocker }),
      /Set CRS_RELEASE_UPDATE_TEST=1/,
    );
});

test('release qualification refuses absent, relative and Git-contained output before selecting builds', async () => {
  for (const value of [undefined, '', 'relative-output', '../output'])
    await assert.rejects(
      qualifyReleaseUpdate({
        CRS_RELEASE_UPDATE_TEST: '1',
        CRS_UPDATE_OUTPUT_DIR: value,
        CRS_DOCKER: neverDocker,
      }),
      /fresh absolute external directory/,
    );
  await assert.rejects(
    qualifyReleaseUpdate({
      CRS_RELEASE_UPDATE_TEST: '1',
      CRS_UPDATE_OUTPUT_DIR: join(process.cwd(), 'never-create-release-output'),
      CRS_DOCKER: neverDocker,
    }),
    /outside Git/,
  );
  assert.equal(existsSync(join(process.cwd(), 'never-create-release-output')), false);
});

test('release qualification never overwrites an existing external evidence directory', async () => {
  const external = [tmpdir(), '/dev/shm'].find((path) => {
    try {
      outsideGit(path);
      return existsSync(path);
    } catch {
      return false;
    }
  });
  assert(external, 'An independently external directory is required for guard testing');
  await assert.rejects(
    qualifyReleaseUpdate({
      CRS_RELEASE_UPDATE_TEST: '1',
      CRS_UPDATE_OUTPUT_DIR: external,
      CRS_DOCKER: neverDocker,
    }),
    /never overwrites an existing output/,
  );
});

test('release qualification requires an explicit valid prior commit before creating output', async () => {
  const external = [tmpdir(), '/dev/shm'].find((path) => {
    try {
      outsideGit(path);
      return existsSync(path);
    } catch {
      return false;
    }
  });
  assert(external);
  const output = join(external, `fictional-release-never-created-${process.pid}`);
  assert.equal(existsSync(output), false);
  for (const prior of [undefined, '', 'main', '--help', 'HEAD~1']) {
    await assert.rejects(
      qualifyReleaseUpdate({
        CRS_RELEASE_UPDATE_TEST: '1',
        CRS_UPDATE_OUTPUT_DIR: output,
        CRS_UPDATE_PRIOR_REVISION: prior,
        CRS_DOCKER: neverDocker,
      }),
      /explicitly select the prior release commit|exact commit object ID/,
    );
    assert.equal(existsSync(output), false);
  }
});

test('real source fingerprint captures tracked edits, added candidate code and deletions without ignored output', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-release-source-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', directory]);
  writeFileSync(join(directory, '.gitignore'), 'ignored/\n');
  writeFileSync(join(directory, 'source.ts'), 'export const value = 1;\n');
  execFileSync('git', ['-C', directory, 'add', '.gitignore', 'source.ts']);
  const baseline = releaseSourceFingerprint(directory);
  mkdirSync(join(directory, 'ignored'));
  writeFileSync(join(directory, 'ignored/output'), 'Disposable output');
  assert.equal(releaseSourceFingerprint(directory), baseline);
  writeFileSync(join(directory, 'source.ts'), 'export const value = 2;\n');
  assert.notEqual(releaseSourceFingerprint(directory), baseline);
  writeFileSync(join(directory, 'source.ts'), 'export const value = 1;\n');
  assert.equal(releaseSourceFingerprint(directory), baseline);
  writeFileSync(join(directory, 'candidate.ts'), 'export const candidate = true;\n');
  assert.notEqual(releaseSourceFingerprint(directory), baseline);
  rmSync(join(directory, 'candidate.ts'));
  assert.equal(releaseSourceFingerprint(directory), baseline);
  rmSync(join(directory, 'source.ts'));
  assert.notEqual(releaseSourceFingerprint(directory), baseline);
  assert.equal(readFileSync(join(directory, '.gitignore'), 'utf8'), 'ignored/\n');
});
