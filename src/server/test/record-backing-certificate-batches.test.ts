import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachRecordDurability } from '../record-versions.ts';
import { openVault } from '../vault-store.ts';
import { freshKey } from '../vault-crypto.ts';
import { uploadIntake } from '../intake.ts';
import {
  contributorAuthorityPath,
  contributorAuthorityMarker,
  openContributorRecordStorage,
} from '../contributor-record-storage.ts';
import {
  vaultRecordCertificates,
  VAULT_CERTIFICATE_SCHEMA,
  type VaultRecordCertificate,
} from '../vault-record-certificates.ts';
import type { IntakeTreeRoot } from '../intake-state-tree.ts';
import type { VaultRecordBackingInput } from '../vault-record-backing.ts';
import type { ContributorRecordBackingInput } from '../contributor-record-staging.ts';

function digest(value: string) {
  return {
    hash: createHash('sha256').update(value).digest('hex'),
    bytes: Buffer.byteLength(value),
  };
}
async function runWorker(
  adapter: string,
  input: VaultRecordBackingInput | ContributorRecordBackingInput,
) {
  const worker = new Worker(new URL(`../${adapter}-record-backing-worker.ts`, import.meta.url), {
    workerData: input,
  });
  try {
    return await new Promise<{
      entries: number;
      certificateRoot?: IntakeTreeRoot;
      refused?: boolean;
      decodedVersions?: number;
    }>((complete, reject) => {
      let result:
        | {
            entries: number;
            certificateRoot?: IntakeTreeRoot;
            refused?: boolean;
            decodedVersions?: number;
          }
        | undefined;
      worker.on('message', (message) => {
        if (message?.checkpoint) {
          const control = new Int32Array(input.checkpointControl);
          Atomics.store(control, 0, 0);
          Atomics.notify(control, 0);
        } else if (result) reject(Error('Fictional worker repeated result'));
        else result = message;
      });
      worker.once('error', reject);
      worker.once('exit', (code) =>
        code || !result ? reject(Error('Fictional worker failed')) : complete(result),
      );
    });
  } finally {
    await worker.terminate();
  }
}

for (const adapter of ['contributor', 'vault'] as const)
  test(`${adapter} cold worker batches actual certificate pages without changing complete recovery evidence`, async (t) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-backing-batch-'))),
      profileId = 'fictional-backing-batch',
      paths = ensureProfileDirectories(root, profileId),
      db = openDatabase(paths.database, profileId),
      key = freshKey(),
      vault =
        adapter === 'vault'
          ? openVault({ directory: paths.root, profileId, key, initialize: true })
          : undefined,
      storage =
        vault?.recordStorage() ??
        openContributorRecordStorage(root, profileId, { initialize: true });
    t.after(() => {
      db.close();
      if (vault) vault.close();
      else if ('close' in storage) storage.close();
      key.fill(0);
      rmSync(root, { recursive: true, force: true });
    });
    attachRecordDurability(db, { profileId, storage });
    const originalBytes = Buffer.from(
        'Independently fictional retained original for certificate batching.',
      ),
      original = uploadIntake(db, root, profileId, {
        filename: 'fictional.txt',
        bytes: originalBytes,
      });
    if (vault) {
      const path = String(
        db.prepare('SELECT path FROM source_files WHERE id=?').get(original.id)!.path,
      );
      vault.storeFile(path, originalBytes);
      vault.publish();
    }
    transaction(db, () => {
      const insert = db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)');
      for (let index = 0; index < 130; index++)
        insert.run(`fictional-person-${index}`, `Fictional Person ${index}`);
      const row = db.prepare('SELECT details_json FROM source_files WHERE id=?').get(original.id)!;
      const details = {
        ...JSON.parse(String(row.details_json)),
        fictionalOversized: 'Fictional retained scalar '.repeat(9000),
      };
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
        JSON.stringify(details),
        original.id,
      );
    });
    transaction(db, () => db.prepare('DELETE FROM people WHERE id=?').run('fictional-person-129'));
    const selectedHead = storage.read('head')!.toString('utf8'),
      nonce = randomUUID(),
      common = {
        mode: 'prepare' as const,
        profileId,
        selectedHead,
        database: join(root, 'recovered.sqlite'),
        physical: join(root, 'proof.sqlite'),
        nonce,
        signatureKey: randomBytes(32),
        checkpointControl: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
      },
      input: VaultRecordBackingInput | ContributorRecordBackingInput =
        adapter === 'vault'
          ? { ...common, directory: paths.root, key, kind: 'records', fields: [], metadata: [] }
          : {
              ...common,
              root,
              base: contributorAuthorityPath(root, profileId),
              marker: contributorAuthorityMarker(root, profileId),
            };
    // This calls the real prepare worker against real accepted storage. The
    // private input transport is not claimed to be a publication capability.
    const result = await runWorker(adapter, input);
    assert.equal(result.refused, undefined);
    assert.ok(result.entries > 0);
    assert.ok(result.decodedVersions! > 130);
    assert.ok(result.certificateRoot);
    const expected: VaultRecordCertificate[] = [];
    for (const row of db
      .prepare(
        'SELECT c.entity,c.record_id,c.version_id,v.contents_json,v.deleted FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id',
      )
      .iterate()) {
      const entity = String(row.entity),
        recordId = String(row.record_id),
        deleted = Number(row.deleted),
        contents = JSON.parse(String(row.contents_json)) as Record<string, unknown>,
        fieldNames = deleted
          ? []
          : entity === 'source_files'
            ? adapter === 'vault'
              ? Object.keys(contents)
              : ['id', 'kind', 'path', 'sha256', 'bytes']
            : adapter === 'vault' && entity === 'app_meta'
              ? Object.keys(contents)
              : [];
      expected.push({
        entity,
        recordId,
        versionId: String(row.version_id),
        deleted,
        preimage: digest(
          adapter === 'vault'
            ? JSON.stringify(String(row.contents_json))
            : String(row.contents_json),
        ),
        fields: fieldNames.map((name) => ({ name, ...digest(JSON.stringify(contents[name])) })),
      });
    }
    const proof = new DatabaseSync(input.physical, { readOnly: true }),
      serial = new DatabaseSync(':memory:'),
      recovered = openDatabase(input.database, profileId);
    try {
      const actual = vaultRecordCertificates(proof, profileId, nonce, () => {});
      assert.equal(result.certificateRoot!.count, expected.length);
      for (const certificate of expected)
        assert.deepEqual(
          actual.get(result.certificateRoot!, certificate.entity, certificate.recordId),
          certificate,
        );
      assert.equal(
        actual.get(result.certificateRoot!, 'people', '["fictional-absent"]'),
        undefined,
      );
      assert.equal(
        actual.get(result.certificateRoot!, 'people', '["fictional-person-129"]')?.deleted,
        1,
      );
      serial.exec(VAULT_CERTIFICATE_SCHEMA + ' BEGIN');
      const baseline = vaultRecordCertificates(serial, profileId, nonce, () => {});
      let serialRoot: IntakeTreeRoot = null;
      for (const certificate of expected) serialRoot = baseline.put(serialRoot, certificate).root;
      const pageRows = (sql: DatabaseSync) =>
          Number(sql.prepare('SELECT count(*) n FROM certificate_pages').get()!.n),
        actualPages = pageRows(proof),
        serialPages = pageRows(serial);
      assert.ok(
        actualPages < serialPages,
        'actual worker SQL stores fewer private pages than the old per-key algorithm',
      );
      assert.equal(proof.prepare('SELECT count(*) n FROM certificates').get()!.n, expected.length);
      for (const table of [
        'people',
        'source_files',
        '__record_current',
        '__record_versions',
        '__record_fields',
        '__record_transactions',
        '__record_state',
      ]) {
        const read = `SELECT * FROM ${table} ORDER BY rowid`;
        const sorted = (connection: DatabaseSync) =>
          connection
            .prepare(read)
            .all()
            .map((row) => JSON.stringify(row))
            .sort();
        assert.deepEqual(
          sorted(recovered),
          sorted(db),
          table + ': complete current/history recovery remains exact',
        );
      }
      assert.equal(storage.read('head')!.toString('utf8'), selectedHead);
      t.diagnostic(
        JSON.stringify({
          adapter,
          members: expected.length,
          actualPages,
          serialPages,
          decodedVersions: result.decodedVersions,
          physicalMembers: result.entries,
        }),
      );
    } finally {
      proof.close();
      serial.close();
      recovered.close();
    }
    const verified = await runWorker(adapter, {
      ...input,
      mode: 'verify',
      entries: result.entries,
    });
    assert.equal(verified.refused, undefined);
    assert.equal(
      verified.entries,
      result.entries,
      'same original full physical roster still verifies',
    );
  });
