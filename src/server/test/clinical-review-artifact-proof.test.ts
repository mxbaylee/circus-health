import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import {
  createClinicalReviewArtifactProof,
  captureClinicalArtifactReadTerminal,
  assertClinicalArtifactReadTerminal,
} from '../clinical-review-artifact-proof.ts';
import { intakeFileIdentity } from '../intake-files.ts';
import { beginManagedPhysicalMutation } from '../clinical-review-physical-epoch.ts';

test('readonly artifact terminal provenance is issued only after the actual worker acknowledgement', async (t) => {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  const proof = createClinicalReviewArtifactProof(sql, 'proof');
  assert.throws(() => captureClinicalArtifactReadTerminal(() => {}));
  assert.throws(() => assertClinicalArtifactReadTerminal({} as never));
  let original: (() => void) | undefined;
  const receipt = await proof.withVerifiedTerminal({ assertCurrent() {} }, (current) => {
    original = current;
    return captureClinicalArtifactReadTerminal(current);
  });
  assertClinicalArtifactReadTerminal(receipt);
  assert.throws(() => captureClinicalArtifactReadTerminal(original!));
  sql.exec('CREATE TEMP TABLE changed(value TEXT)');
  assert.throws(() => assertClinicalArtifactReadTerminal(receipt), { code: 'SOURCE_CHANGED' });
  await proof.withVerifiedTerminal(
    { assertCurrent() {} },
    (current) => {
      assert.throws(() => captureClinicalArtifactReadTerminal(current));
    },
    'publication',
  );
});

test('captured artifact unions preserve original identities and refuse changed or closed scratch', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-artifact-union-')),
    sql = new DatabaseSync(':memory:');
  t.after(() => {
    if (sql.isOpen) sql.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'source');
  writeFileSync(path, 'Fictional original union');
  const original = { id: 'a', path, identity: intakeFileIdentity(path) },
    proof = createClinicalReviewArtifactProof(sql, 'proof');
  proof.retain([original]);
  const retained = proof.captureVerifiedArtifacts();
  writeFileSync(path, 'Changed fictional original union');
  assert.deepEqual([...retained()], [original], 'transport never adopts current physical identity');
  assert.throws(() => proof.assertCurrent(), { code: 'SOURCE_CHANGED' });
  const paused = retained();
  assert.deepEqual(paused.next().value, original);
  sql.exec('SAVEPOINT attempted');
  sql.prepare('UPDATE proof SET path=path').run();
  sql.exec('ROLLBACK TO attempted; RELEASE attempted');
  assert.throws(() => paused.next(), { code: 'SOURCE_CHANGED' });
  assert.throws(() => [...retained()], { code: 'SOURCE_CHANGED' });
  const beforeGrowth = proof.captureVerifiedArtifacts();
  proof.retain([{ ...original, id: 'b' }]);
  assert.throws(() => [...beforeGrowth()], { code: 'SOURCE_CHANGED' });
  const beforeSchema = proof.captureVerifiedArtifacts();
  sql.exec('CREATE TEMP TABLE fictional_shadow(value TEXT)');
  assert.throws(() => [...beforeSchema()], { code: 'SOURCE_CHANGED' });
  const beforeClose = proof.captureVerifiedArtifacts()();
  assert.deepEqual(beforeClose.next().value, original);
  sql.close();
  assert.throws(() => beforeClose.next());
});

test('artifact proof prepares one private HMAC key per owner without skipping verification', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-artifact-key-')),
    sql = new DatabaseSync(':memory:'),
    originalSecretKey = crypto.createSecretKey,
    originalHmac = crypto.createHmac;
  let preparations = 0;
  const usedKeys: Parameters<typeof crypto.createHmac>[1][] = [];
  crypto.createSecretKey = function (
    key: NodeJS.ArrayBufferView | string,
    encoding?: BufferEncoding,
  ) {
    preparations++;
    return typeof key === 'string' ? originalSecretKey(key, encoding!) : originalSecretKey(key);
  };
  crypto.createHmac = function (...args) {
    usedKeys.push(args[1]);
    return originalHmac(...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    crypto.createSecretKey = originalSecretKey;
    crypto.createHmac = originalHmac;
    syncBuiltinESMExports();
    sql.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'source');
  writeFileSync(path, 'Independently fictional proof-key source');
  const artifact = { id: 'source', path, identity: intakeFileIdentity(path) },
    first = createClinicalReviewArtifactProof(sql, 'first_proof'),
    second = createClinicalReviewArtifactProof(sql, 'second_proof');
  assert.equal(preparations, 2);
  first.retain([artifact]);
  for (let n = 0; n < 4; n++) {
    first.assertContains([artifact.id]);
    first.assertCurrent();
  }
  assert.equal(usedKeys.length, 9, 'retain and every membership/physical check still sign');
  assert.equal(new Set(usedKeys).size, 1);
  const key = usedKeys[0];
  assert.ok(key instanceof crypto.KeyObject);
  assert.equal(key.type, 'secret');
  assert.equal(key.symmetricKeySize, 32);
  assert.equal(
    sql.prepare('SELECT signature FROM first_proof WHERE id=?').get(artifact.id)!.signature,
    originalHmac('sha256', key.export())
      .update(JSON.stringify([artifact.id, artifact.path, artifact.identity]))
      .digest('hex'),
    'prepared and raw key forms produce the same exact signature',
  );
  second.retain([artifact]);
  assert.equal(usedKeys.length, 10);
  assert.notEqual(usedKeys[9], key, 'owners never share a prepared key');
  assert.equal(preparations, 2, 'repeated checks do not reprepare the key');
  sql.prepare('UPDATE first_proof SET signature=? WHERE id=?').run('forged', artifact.id);
  assert.throws(() => first.assertCurrent(), { code: 'SOURCE_CHANGED' });
  second.assertCurrent();
});

test('aggregate verified artifact proofs preserve prior sessions and reject forged or missing scratch rows', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-artifact-proof-')),
    sql = new DatabaseSync(':memory:');
  t.after(() => {
    sql.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const first = join(directory, 'first'),
    second = join(directory, 'second');
  writeFileSync(first, 'Independently fictional first source');
  writeFileSync(second, 'Independently fictional second source');
  const proof = createClinicalReviewArtifactProof(sql, 'proof'),
    a = { id: 'first', path: first, identity: intakeFileIdentity(first) },
    b = { id: 'second', path: second, identity: intakeFileIdentity(second) };
  proof.retain([a]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  proof.retain([b]);
  proof.assertCurrent();
  sql.exec('SAVEPOINT forged');
  sql.prepare('UPDATE proof SET identity=? WHERE id=?').run('forged', a.id);
  assert.throws(() => proof.assertCurrent(), { code: 'SOURCE_CHANGED' });
  sql.exec('ROLLBACK TO forged; RELEASE forged');
  sql.exec('SAVEPOINT missing');
  sql.prepare('DELETE FROM proof WHERE id=?').run(a.id);
  assert.throws(() => proof.assertCurrent(), { code: 'SOURCE_CHANGED' });
  sql.exec('ROLLBACK TO missing; RELEASE missing');
  proof.assertCurrent();
  writeFileSync(first, 'Changed independently fictional evidence');
  assert.throws(() => proof.assertCurrent(), { code: 'SOURCE_CHANGED' });
  assert.throws(() => proof.retain([{ ...a, identity: intakeFileIdentity(first) }]), {
    code: 'SOURCE_CHANGED',
  });
});

test('worker terminal proof completes only after every original signed physical identity', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-artifact-terminal-')),
    sql = new DatabaseSync(':memory:');
  t.after(() => {
    sql.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const proof = createClinicalReviewArtifactProof(sql, 'proof');
  for (let index = 0; index < 65; index++) {
    const path = join(directory, `source-${index}`);
    writeFileSync(path, `Independently fictional source ${index}`);
    proof.retain([{ id: `source-${index}`, path, identity: intakeFileIdentity(path) }]);
  }
  let checks = 0;
  const value = await proof.withVerifiedTerminal({ assertCurrent: () => checks++ }, () => {
    assert.ok(checks >= 6, 'two bounded worker pages were checked at their boundaries');
    return 'verified';
  });
  assert.equal(value, 'verified');
});

test('worker terminal proof refuses physical and scratch changes before completion', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-artifact-terminal-')),
    sql = new DatabaseSync(':memory:');
  t.after(() => {
    sql.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'source');
  writeFileSync(path, 'Independently fictional original');
  const proof = createClinicalReviewArtifactProof(sql, 'proof');
  proof.retain([{ id: 'source', path, identity: intakeFileIdentity(path) }]);
  let completed = false;
  let checks = 0;
  await assert.rejects(
    proof.withVerifiedTerminal(
      {
        assertCurrent: () => {
          if (++checks === 3) writeFileSync(path, 'Changed independently fictional original');
        },
      },
      () => {
        completed = true;
      },
    ),
    /physical evidence changed/,
  );
  assert.equal(completed, false);
  const scratchProof = createClinicalReviewArtifactProof(sql, 'scratch_proof');
  scratchProof.retain([{ id: 'source', path, identity: intakeFileIdentity(path) }]);
  checks = 0;
  await assert.rejects(
    scratchProof.withVerifiedTerminal(
      {
        assertCurrent: () => {
          if (++checks === 4) {
            sql.exec('SAVEPOINT fictional_scratch_change');
            sql.prepare("UPDATE scratch_proof SET path=path WHERE id='source'").run();
            sql.exec('ROLLBACK TO fictional_scratch_change; RELEASE fictional_scratch_change');
          }
        },
      },
      () => {
        completed = true;
      },
    ),
    { code: 'SOURCE_CHANGED' },
  );
  assert.equal(completed, false);
});

test('worker terminal proof rejects a managed mutation attempt between worker pages', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-artifact-terminal-')),
    sql = new DatabaseSync(':memory:');
  t.after(() => {
    sql.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'source');
  writeFileSync(path, 'Independently fictional original');
  const proof = createClinicalReviewArtifactProof(sql, 'proof');
  proof.retain([{ id: 'source', path, identity: intakeFileIdentity(path) }]);
  let checks = 0;
  await assert.rejects(
    proof.withVerifiedTerminal(
      {
        assertCurrent: () => {
          if (++checks === 4) beginManagedPhysicalMutation()();
        },
      },
      () => assert.fail('no result may be published after an attempted managed write'),
    ),
    { code: 'SOURCE_CHANGED' },
  );
});

test('worker terminal proof refuses a managed mutation in synchronous completion', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-artifact-terminal-')),
    sql = new DatabaseSync(':memory:');
  t.after(() => {
    sql.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'source');
  writeFileSync(path, 'Independently fictional original');
  const proof = createClinicalReviewArtifactProof(sql, 'proof');
  proof.retain([{ id: 'source', path, identity: intakeFileIdentity(path) }]);
  await assert.rejects(
    proof.withVerifiedTerminal({ assertCurrent: () => {} }, () => {
      beginManagedPhysicalMutation()();
      return 'unpublishable';
    }),
    { code: 'SOURCE_CHANGED' },
  );
});
