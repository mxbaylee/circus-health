import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decryptObject,
  encryptObject,
  recoveryEntropy,
  unwrapKey,
  type RecoveryKit,
  type VaultKey,
} from '../server/vault-crypto.ts';

/** Only use on stopped, independently fictional qualification copies. Never emits secrets. */
function withKey<T>(
  data: string,
  kit: RecoveryKit,
  action: (directory: string, key: VaultKey) => T,
): T {
  const directory = join(data, 'profiles', kit.profileId);
  const keyring = JSON.parse(readFileSync(join(directory, 'keyring.json'), 'utf8')) as {
    recovery: unknown;
  };
  const entropy = recoveryEntropy(kit, kit.profileId);
  let key: VaultKey | undefined;
  try {
    key = unwrapKey(keyring.recovery, entropy, kit.profileId);
    return action(directory, key);
  } finally {
    entropy.fill(0);
    key?.fill(0);
  }
}

export function releaseArchiveFormats(data: string, kit: RecoveryKit) {
  return withKey(data, kit, (directory, key) => {
    const read = (path: string, purpose: string) =>
      JSON.parse(
        decryptObject(join(directory, path), key, kit.profileId, purpose).toString(),
      ) as Record<string, unknown>;
    const registry = JSON.parse(readFileSync(join(data, 'profiles.json'), 'utf8')) as {
      format: string;
    };
    const keyring = JSON.parse(readFileSync(join(directory, 'keyring.json'), 'utf8')) as {
      format: string;
    };
    const manifest = read('vault/manifest.enc', 'manifest');
    const tip = manifest.indexTip as { id: string };
    assert.match(tip.id, /^[0-9a-f-]{36}$/);
    const index = read(`vault/indices/${tip.id}.enc`, `index:${tip.id}`);
    const head = JSON.parse(Buffer.from(manifest.recordsHead as string, 'base64').toString()) as {
      name: string;
    };
    assert.match(head.name, /^objects\/[0-9a-f-]{36}$/);
    const history = read(`vault/versions/${head.name.slice(8)}.enc`, `record:${head.name}`);
    const cache = read('cache/metadata.enc', 'sqlite-cache-meta');
    // Whitelist concrete known format identifiers rather than publishing arbitrary archive strings.
    assert.equal(registry.format, 'circus-health-profiles-v1');
    assert.equal(keyring.format, 'circus-health-keyring-v1');
    assert.equal(manifest.format, 'circus-health-vault-head-v2');
    assert.equal(index.format, 'circus-health-vault-index-delta-v2');
    assert.equal(history.format, 'health-record-versions-v1');
    assert(Number.isSafeInteger(history.schemaVersion));
    assert.equal(
      readFileSync(join(directory, 'vault/manifest.enc')).subarray(0, 8).toString(),
      'CIRCUS01',
    );
    assert.equal(kit.format, 'circus-health-recovery-v1');
    assert(Number.isSafeInteger(cache.schemaVersion));
    return {
      registry: registry.format,
      keyring: keyring.format,
      manifest: manifest.format,
      index: index.format,
      history: history.format,
      acceptedHistorySchema: history.schemaVersion,
      encryptedFraming: 'CIRCUS01',
      recoveryKit: kit.format,
      disposableCacheSchema: cache.schemaVersion,
    };
  });
}

/** Manufacture an authenticated future format; ciphertext corruption would test a different failure. */
export function futureReleaseFixture(
  data: string,
  kit: RecoveryKit,
  target: 'cache' | 'manifest',
): void {
  withKey(data, kit, (directory, key) => {
    const path = join(directory, target === 'cache' ? 'cache/metadata.enc' : 'vault/manifest.enc');
    const purpose = target === 'cache' ? 'sqlite-cache-meta' : 'manifest';
    const value = JSON.parse(decryptObject(path, key, kit.profileId, purpose).toString()) as Record<
      string,
      unknown
    >;
    if (target === 'cache') value.schemaVersion = 999999;
    else value.format = 'circus-health-vault-head-v999';
    encryptObject(path, Buffer.from(JSON.stringify(value)), key, kit.profileId, purpose);
  });
}
