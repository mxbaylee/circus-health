import { existsSync, readFileSync, readdirSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { validProfileId, profileDefinition } from './profiles.ts';
import { durableWrite, syncDirectory, publishedPersonalLineage } from './portable.ts';
import { hasContributorAuthority } from './contributor-record-storage.ts';
import { verifyContributorProfileAuthority } from './contributor-durability.ts';
import {
  readDatabaseOwner,
  legacyDatabaseFile,
  safeLegacyDatabasePath,
} from './profile-ownership.ts';
export interface RegistryEntry {
  id: string;
  placebo: boolean;
  name?: string;
  icon?: string;
  version?: number;
  legacyDatabase?: string;
}
interface Registry {
  format: string;
  revision: number;
  profiles: RegistryEntry[];
}
const file = (root: string) => resolve(root, 'data/profiles.json');
export function readProfileRegistry(root: string) {
  if (existsSync(file(root))) {
    const value = JSON.parse(readFileSync(file(root), 'utf8')) as Registry;
    if (
      value.format !== 'health-profiles-v1' ||
      !Array.isArray(value.profiles) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1
    )
      throw Error('Invalid profile registry');
    const ids = new Set();
    for (const p of value.profiles) {
      if (
        !validProfileId(p.id) ||
        ids.has(p.id) ||
        typeof p.placebo !== 'boolean' ||
        (p.legacyDatabase !== undefined && !safeLegacyDatabasePath(p.legacyDatabase))
      )
        throw Error('Invalid profile registry entry');
      ids.add(p.id);
    }
    return value;
  }
  const directory = resolve(root, 'data/profiles');
  const profiles: RegistryEntry[] = [];
  // A generic historical filename never supplies a personal identity.
  const legacy = [
    'data/database.sqlite',
    ...(existsSync(directory)
      ? readdirSync(directory)
          .filter((name) => name.endsWith('.sqlite'))
          .sort()
          .map((name) => 'data/profiles/' + name)
      : []),
  ];
  for (const path of legacy) {
    const full = legacyDatabaseFile(root, path);
    if (!existsSync(full)) continue;
    const id = readDatabaseOwner(full);
    if (profiles.some((profile) => profile.id === id))
      throw Error('Multiple legacy databases claim the same profile');
    profiles.push({ id, placebo: profileDefinition(id).placebo, legacyDatabase: path });
  }
  if (existsSync(directory))
    for (const id of readdirSync(directory).filter(validProfileId).sort()) {
      const path = resolve(directory, id);
      if (!lstatSync(path).isDirectory()) throw Error('Profile directory must not be a link');
      const database = legacyDatabaseFile(root, `data/profiles/${id}/db/database.sqlite`);
      if (existsSync(database)) {
        if (readDatabaseOwner(database) !== id) throw Error('Profile directory owner mismatch');
      }
      if (hasContributorAuthority(root, id)) {
        if (profiles.some((profile) => profile.id === id))
          throw Error('Multiple durable archives claim the same profile');
        verifyContributorProfileAuthority(root, id);
      } else if (!existsSync(database) && !profiles.some((profile) => profile.id === id)) {
        const current = publishedPersonalLineage(root, id).next();
        if (current.done)
          throw Error('Profile has no verified owner metadata; recover its registry explicitly');
      }
      if (!profiles.some((profile) => profile.id === id))
        profiles.push({ id, placebo: profileDefinition(id).placebo });
    }
  return { format: 'health-profiles-v1', revision: 0, profiles };
}

export function writeProfileRegistry(root: string, profiles: RegistryEntry[]) {
  // An explicit first registry is supplied by a verified lifecycle/recovery caller.
  // Its database may live in a separate disposable encrypted runtime, so do not
  // substitute directory discovery for that explicit owner selection.
  const previous = existsSync(file(root)) ? readProfileRegistry(root) : { revision: 0 };
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (
      !validProfileId(profile.id) ||
      ids.has(profile.id) ||
      typeof profile.placebo !== 'boolean' ||
      (profile.legacyDatabase !== undefined && !safeLegacyDatabasePath(profile.legacyDatabase))
    )
      throw Error('Invalid profile registry entry');
    ids.add(profile.id);
  }
  mkdirSync(resolve(root, 'data'), { recursive: true, mode: 0o700 });
  const value = { format: 'health-profiles-v1', revision: previous.revision + 1, profiles };
  durableWrite(file(root), Buffer.from(JSON.stringify(value, null, 2) + '\n'));
  return value;
}
export function recoverProfileDeletions(root: string) {
  const directory = resolve(root, 'data/operations/profile-deletions');
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    const path = resolve(directory, name),
      receipt = JSON.parse(readFileSync(path, 'utf8'));
    if (receipt.format !== 'health-profile-deletion-v1' || !validProfileId(receipt.profileId))
      throw Error('Invalid deletion receipt');
    if (readProfileRegistry(root).profiles.some((p) => p.id === receipt.profileId))
      writeProfileRegistry(
        root,
        readProfileRegistry(root).profiles.filter((p) => p.id !== receipt.profileId),
      );
    const target = resolve(root, 'data/profiles', receipt.profileId);
    if (existsSync(target) && !lstatSync(target).isDirectory())
      throw Error('Deletion target must not be a link');
    rmSync(target, { recursive: true, force: true });
    if (existsSync(resolve(root, 'data/profiles'))) syncDirectory(resolve(root, 'data/profiles'));
    rmSync(path);
    syncDirectory(directory);
  }
}
