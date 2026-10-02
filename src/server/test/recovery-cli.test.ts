import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { vaultFixture, newProfile } from './helpers/vault-fixture.ts';
import { uploadIntake } from '../intake.ts';
import { createNote, saveNote, finishNote, correctionNote } from '../notes.ts';
import { queryRecordHistory } from '../record-versions.ts';
import { HELP } from '../../../deploy/run.ts';

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  function walk(relative: string) {
    for (const entry of readdirSync(resolve(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        files[path + '/'] = '';
        walk(path);
      } else files[path] = readFileSync(resolve(root, path)).toString('hex');
    }
  }
  walk('');
  return files;
}

test('retired recovery CLI refuses every action without archive access or argument disclosure', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'circus-recovery-refusal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // An isolated copy has no server modules: refusal cannot initialize storage or a projection.
  const cli = resolve(root, 'recovery-cli.ts');
  copyFileSync(new URL('../recovery-cli.ts', import.meta.url), cli);
  const archive = resolve(root, 'fictional-archive');
  const target = resolve(root, 'nonempty-target');
  mkdirSync(archive);
  mkdirSync(target);
  for (const name of [
    'registry.json',
    'keyring.enc',
    'manifest.enc',
    'original.pdf',
    'accepted.enc',
  ])
    writeFileSync(resolve(archive, name), `Fictional protected bytes: ${name}`);
  writeFileSync(resolve(target, 'retain.txt'), 'Fictional target content');
  const before = snapshot(root);
  const preload = `const guarded = ${JSON.stringify([archive, target])}; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    for (const name of ['readFileSync','writeFileSync','openSync','statSync','lstatSync',
      'readdirSync','mkdirSync','rmSync','renameSync','unlinkSync','realpathSync'])
      { const original = fs[name]; fs[name] = (...args) => {
        if (guarded.some(path => String(args[0]).includes(path))) throw new Error('FILESYSTEM_ACCESS_TRIPWIRE');
        return original(...args);
      }; }
    syncBuiltinESMExports();`;
  let expected = '';
  for (const args of [
    ['backup', 'FICTIONAL_SECRET'],
    ['restore', archive, target],
    ['restore', 'missing-input', target],
    ['restore', archive, resolve(root, 'new-target')],
    ['restore'],
    ['backup'],
    ['rebuild', 'FICTIONAL_SECRET', target],
    ['export-sources', 'FICTIONAL_SECRET'],
    ['unknown', 'FICTIONAL_SECRET'],
    ['--help'],
    [],
  ]) {
    const result = spawnSync(
      process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, cli, ...args],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, CRS_DATA_DIR: archive, CRS_MODEL: 'FICTIONAL_SECRET' },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Offline recovery commands are retired/);
    assert.match(result.stderr, /npm run help/);
    assert.match(result.stderr, /docs\/setup\/deployment.md/);
    assert.doesNotMatch(result.stderr, /FICTIONAL_SECRET|FILESYSTEM_ACCESS_TRIPWIRE/);
    assert.ok(!result.stderr.includes(root));
    expected ||= result.stderr;
    assert.equal(result.stderr, expected);
    assert.deepEqual(snapshot(root), before);
  }
});

test('public npm commands and Compose help identify the supported encrypted backup procedure', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.backup, undefined);
  assert.equal(pkg.scripts.restore, undefined);
  assert.equal(pkg.scripts.help, 'node deploy/run.ts help');
  assert.match(HELP, /stop the writer.*complete encrypted CRS_DATA_DIR/);
  assert.match(HELP, /recovery kits.*not archive backups/);
  assert.match(HELP, /docs\/setup\/deployment.md/);
});

test('direct retired commands leave a current encrypted archive and restore destinations unchanged', async (t) => {
  const { manager, base, dataDirectory } = vaultFixture(t);
  const created = await newProfile(manager, 'Fictional recovery refusal owner');
  const state = manager.opened.get(created.profile.id)!;
  uploadIntake(state.db, state.root, created.profile.id, {
    filename: 'fictional-original.txt',
    newProviderName: 'Fictional provider',
    bytes: Buffer.from('FICTIONAL_PRIVATE_ORIGINAL_213'),
  });
  let note = createNote(state.db, {
    kind: 'historical',
    title: 'Fictional accepted visit',
    content: 'FICTIONAL_CLINICAL_BEFORE_213',
  });
  note = saveNote(state.db, note.id, { ...note, content: 'FICTIONAL_CLINICAL_AFTER_213' });
  note = finishNote(state.db, note.id, note);
  const correction = correctionNote(state.db, note.id, { content: 'FICTIONAL_CORRECTION_213' });
  finishNote(state.db, correction.id, correction);
  const history = queryRecordHistory(state.db, {
    profileId: created.profile.id,
    entity: 'notes',
    recordId: note.id,
  });
  assert.ok(history.entries.length >= 3, 'accepted create, edit and finish history exists');
  assert.ok(
    queryRecordHistory(state.db, {
      profileId: created.profile.id,
      entity: 'notes',
      recordId: correction.id,
    }).entries.length >= 2,
    'accepted correction history exists',
  );
  manager.close();
  const target = resolve(base, 'existing-target');
  mkdirSync(target);
  writeFileSync(resolve(target, 'keep.txt'), 'FICTIONAL_TARGET_213');
  const before = snapshot(base);
  assert.ok(Object.keys(before).some((path) => path.endsWith('manifest.enc')));
  for (const args of [
    ['backup', created.profile.id],
    ['restore', dataDirectory, target],
    ['restore', dataDirectory, resolve(base, 'new-target')],
    ['rebuild', created.profile.id, target],
    ['backup', 'FICTIONAL_SECRET'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [new URL('../recovery-cli.ts', import.meta.url).pathname, ...args],
      {
        encoding: 'utf8',
        env: { ...process.env, CRS_DATA_DIR: dataDirectory },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Offline recovery commands are retired/);
    assert.doesNotMatch(result.stderr, /FICTIONAL_|recoveryKit/);
    assert.ok(!result.stderr.includes(dataDirectory));
    assert.deepEqual(snapshot(base), before);
  }
});
