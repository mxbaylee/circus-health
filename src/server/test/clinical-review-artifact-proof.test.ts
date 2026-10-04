import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClinicalReviewArtifactProof } from '../clinical-review-artifact-proof.ts';
import { intakeFileIdentity } from '../intake-files.ts';

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
