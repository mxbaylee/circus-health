import { Worker } from 'node:worker_threads';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, relative, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { unlockPhysicalIdentity } from './encrypted-unlock-physical.ts';
import { recordFieldDigest, recordStringFieldDigest } from './record-prior-fields.ts';

export interface VaultRecordBackingBinding {
  sourceId: string;
  previousVersion: string;
  preimage: { hash: string; bytes: number };
  fields: readonly { name: string; hash: string; bytes: number }[];
  metadata: readonly { key: string; value: string | undefined }[];
}
export interface VaultRecordBackingInput extends VaultRecordBackingBinding {
  mode: 'prepare' | 'verify';
  directory: string;
  database: string;
  physical: string;
  profileId: string;
  selectedHead: string;
  key: Uint8Array;
  signatureKey: Uint8Array;
  nonce: string;
  entries?: number;
  workspace?: string;
  workspaceNames?: readonly string[];
}

/** Transport owned only by the registered actual vault factory. Not authority. */
export async function prepareVaultRecordBackingTransport(
  directory: string,
  profileId: string,
  key: Uint8Array,
  selectedHead: string,
  binding: VaultRecordBackingBinding,
  assertCurrent: () => void,
  workspace?: string,
  workspaceNames?: readonly string[],
) {
  assertCurrent();
  if (
    binding.fields.length > 64 ||
    binding.metadata.length > 4 ||
    !/^[0-9a-f]{64}$/.test(binding.preimage.hash) ||
    !Number.isSafeInteger(binding.preimage.bytes) ||
    binding.preimage.bytes < 0 ||
    Buffer.byteLength(selectedHead) > 4096 ||
    binding.fields.some(
      (field) =>
        Buffer.byteLength(field.name) > 256 ||
        !/^[0-9a-f]{64}$/.test(field.hash) ||
        !Number.isSafeInteger(field.bytes) ||
        field.bytes < 0,
    ) ||
    new Set(binding.fields.map((field) => field.name)).size !== binding.fields.length ||
    binding.metadata.some(
      (row) =>
        Buffer.byteLength(row.key) > 16384 ||
        (row.value !== undefined && Buffer.byteLength(row.value) > 32768),
    )
  )
    throw Error('Vault backing fixed source binding invalid');
  const scratch = mkdtempSync(resolve(tmpdir(), 'circus-vault-record-backing-')),
    physical = resolve(scratch, 'physical.sqlite'),
    signatureKey = randomBytes(32),
    nonce = randomUUID();
  const retained = structuredClone(binding);
  const input: VaultRecordBackingInput = {
    ...retained,
    mode: 'prepare',
    directory,
    database: resolve(scratch, 'accepted.sqlite'),
    physical,
    profileId,
    selectedHead,
    key: Buffer.from(key),
    signatureKey,
    nonce,
    workspace,
    workspaceNames: workspaceNames && [...workspaceNames],
  };
  let closed = false;
  const run = async (mode: VaultRecordBackingInput['mode'], entries?: number) => {
    assertCurrent();
    if (closed) throw Error('Vault backing transport closed');
    const worker = new Worker(new URL('./vault-record-backing-worker.ts', import.meta.url), {
      workerData: { ...input, mode, entries },
    });
    let reply: { entries?: number; refused?: boolean } | undefined;
    let failed: unknown;
    let stopped = false;
    const checkpoint = () => {
      try {
        assertCurrent();
      } catch (error) {
        if (!stopped) {
          stopped = true;
          failed = error;
          void worker.terminate();
        }
      }
    };
    try {
      await new Promise<void>((complete, reject) => {
        worker.on('message', (message) => {
          if (message?.checkpoint === true) checkpoint();
          else if (reply) reject(Error('Vault backing worker repeated result'));
          else reply = message;
        });
        worker.once('error', reject);
        worker.once('exit', (code) => {
          if (stopped) reject(failed);
          else if (code || reply?.refused || !Number.isSafeInteger(reply?.entries))
            reject(Error('Vault original backing verification refused'));
          else complete();
        });
      });
      assertCurrent();
      return reply!.entries!;
    } finally {
      await worker.terminate();
    }
  };
  let sql: DatabaseSync | undefined;
  try {
    let entries = await run('prepare');
    sql = new DatabaseSync(physical);
    const lookup = sql.prepare('SELECT kind,identity,signature FROM physical WHERE path=?'),
      metadata = sql.prepare('SELECT * FROM accepted_metadata WHERE record_id=?'),
      insert = sql.prepare('INSERT INTO physical VALUES(?,?,?,?)'),
      update = sql.prepare('UPDATE physical SET identity=?,signature=? WHERE path=?');
    const changes = sql.prepare('SELECT CAST(total_changes() AS TEXT) AS n'),
      main = sql.prepare('PRAGMA main.schema_version'),
      temp = sql.prepare('PRAGMA temp.schema_version'),
      peer = sql.prepare('PRAGMA main.data_version');
    let expectedChanges = BigInt(String(changes.get()!.n));
    const schemas = [main.get()!.schema_version, temp.get()!.schema_version],
      dataVersion = peer.get()!.data_version;
    const scratchCurrent = () => {
      if (
        !sql!.isOpen ||
        BigInt(String(changes.get()!.n)) !== expectedChanges ||
        main.get()!.schema_version !== schemas[0] ||
        temp.get()!.schema_version !== schemas[1] ||
        peer.get()!.data_version !== dataVersion
      )
        throw Error('Vault backing scratch continuity changed');
    };
    const root = resolve(directory, 'vault');
    const sign = (path: string, kind: string, identity: string) =>
      createHmac('sha256', signatureKey)
        .update(JSON.stringify([nonce, path, kind, identity]))
        .digest('hex');
    let capturedParent: { path: string; identity: string } | undefined;
    return {
      async assertMetadataPrior(
        key: string,
        value: string | undefined,
        previous: { versionId: string; contents: string; deleted: number } | undefined,
      ) {
        scratchCurrent();
        const recordId = JSON.stringify([key]),
          row = metadata.get(recordId),
          digest = value === undefined ? undefined : recordFieldDigest(JSON.stringify(value)),
          preimage =
            previous &&
            (await recordStringFieldDigest(previous.contents, () => {
              assertCurrent();
              scratchCurrent();
            }));
        scratchCurrent();
        if (
          row
            ? row.version_id !== previous?.versionId ||
              row.hash !== (digest?.hash ?? null) ||
              row.bytes !== (digest?.bytes ?? null) ||
              row.preimage_hash !== preimage?.hash ||
              row.preimage_bytes !== preimage?.bytes ||
              row.deleted !== previous?.deleted ||
              row.signature !==
                sign(
                  'metadata:' + recordId,
                  previous!.versionId,
                  JSON.stringify([
                    digest?.hash ?? null,
                    digest?.bytes ?? null,
                    preimage!.hash,
                    preimage!.bytes,
                    previous!.deleted,
                  ]),
                )
            : previous !== undefined || value !== undefined
        )
          throw Error('Vault accepted metadata predecessor differs');
        scratchCurrent();
      },
      beforeNewRecord(path: string) {
        assertCurrent();
        scratchCurrent();
        const name = relative(root, path),
          parent = relative(root, dirname(path)),
          row = lookup.get(parent),
          identity = unlockPhysicalIdentity(dirname(path));
        if (
          parent !== 'versions' ||
          name.startsWith('../') ||
          lookup.get(name) ||
          !row ||
          row.kind !== 'directory' ||
          row.identity !== identity.value ||
          row.signature !== sign(parent, 'directory', identity.value)
        )
          throw Error('Vault original record namespace changed');
        capturedParent = { path: parent, identity: identity.value };
        scratchCurrent();
      },
      afterNewRecord(path: string) {
        scratchCurrent();
        const parent = relative(root, dirname(path)),
          name = relative(root, path),
          identity = unlockPhysicalIdentity(path),
          parentIdentity = unlockPhysicalIdentity(dirname(path));
        if (
          !capturedParent ||
          capturedParent.path !== parent ||
          identity.kind !== 'file' ||
          parentIdentity.kind !== 'directory' ||
          parentIdentity.value.split(':').slice(0, 2).join(':') !==
            capturedParent.identity.split(':').slice(0, 2).join(':')
        )
          throw Error('Vault owned record parent changed');
        if (
          insert.run(name, 'file', identity.value, sign(name, 'file', identity.value)).changes !==
            1 ||
          update.run(parentIdentity.value, sign(parent, 'directory', parentIdentity.value), parent)
            .changes !== 1
        )
          throw Error('Vault owned record backing recipe changed');
        expectedChanges += 2n;
        scratchCurrent();
        entries++;
        capturedParent = undefined;
      },
      async verify() {
        scratchCurrent();
        if (capturedParent) throw Error('Vault owned record transition unfinished');
        if ((await run('verify', entries)) !== entries)
          throw Error('Vault backing member count changed');
        scratchCurrent();
        assertCurrent();
        scratchCurrent();
      },
      close() {
        if (closed) return;
        closed = true;
        sql!.close();
        input.key.fill(0);
        signatureKey.fill(0);
        rmSync(scratch, { recursive: true, force: true });
      },
    };
  } catch (error) {
    closed = true;
    sql?.close();
    input.key.fill(0);
    signatureKey.fill(0);
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}
