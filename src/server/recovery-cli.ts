import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { validateDataDirectory } from './startup-rebuild.ts';
import { resolve } from 'node:path';
import { openDatabase } from './database.ts';
import { createBackup, restoreBackup } from './recovery.ts';
import { profileDefinition } from './profiles.ts';
import { readProfileRegistry } from './profile-registry.ts';
import { acquireStorageLock } from './storage-lock.ts';
import { loadPortable, projectPortableDatabase, rebuildProfile } from './portable.ts';
import type { CompleteLoadedPortable } from './portable.ts';
const [command, ...args] = process.argv.slice(2);
const archiveRoot = command === 'restore' ? null : validateDataDirectory(process.env.DATA_DIR, []);
const lease = ['backup', 'export-sources', 'rebuild'].includes(command)
  ? await acquireStorageLock(resolve(archiveRoot!, 'data'))
  : null;
try {
  if (
    ['backup', 'rebuild'].includes(command) &&
    !readProfileRegistry(archiveRoot!).profiles.some((profile) => profile.id === args[0])
  )
    throw new Error('Unknown profile in the archive registry');
  if (command === 'backup') {
    const profile = args[0];
    profileDefinition(profile);
    // This legacy portable-archive command already writes a plaintext backup.
    // Stage only its disposable database beside the destination, never an
    // additional full original-file projection in the container's tiny /tmp.
    const backupRoot = resolve(archiveRoot!, 'data/backups');
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    const temporary = mkdtempSync(resolve(backupRoot, '.health-backup-projection-'));
    let db;
    try {
      const database = resolve(temporary, 'database.sqlite');
      projectPortableDatabase(
        database,
        profile,
        loadPortable(archiveRoot!, profile) as CompleteLoadedPortable,
      );
      db = openDatabase(database, profile);
      console.log(JSON.stringify(await createBackup(db, archiveRoot!, profile), null, 2));
    } finally {
      db?.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  } else if (command === 'restore') {
    if (args.length !== 2)
      throw new Error('Usage: npm run restore -- <backup-directory> <new-empty-target-directory>');
    console.log(JSON.stringify(restoreBackup(resolve(args[0]), resolve(args[1])), null, 2));
  } else if (command === 'export-sources') {
    throw new Error(
      'Offline database export is retired. App writes already publish portable generations; use the running app for edits.',
    );
  } else if (command === 'rebuild') {
    if (args.length !== 2)
      throw new Error(
        'Usage: node server/recovery-cli.ts rebuild <profile> <new-empty-target-root>',
      );
    console.log(JSON.stringify(rebuildProfile(archiveRoot!, args[0], resolve(args[1])), null, 2));
  } else throw new Error('Unknown recovery command');
} finally {
  await lease?.release();
}
