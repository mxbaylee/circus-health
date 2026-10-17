import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { openDatabase, transaction, type Database } from '../../database.ts';
import { ensureProfileDirectories } from '../../profile-storage.ts';
import {
  contributorAuthorityPath,
  openContributorRecordStorage,
} from '../../contributor-record-storage.ts';
import { attachRecordDurability } from '../../record-versions.ts';
import { clearIntakeStateCache } from '../../intake-state-storage.ts';
import { registerIntakeFile } from '../../intake-state-access.ts';

const originals = new WeakMap<Database, { root: string; relativeRoot: string }>();

/** Genuine contributor ownership, with retained-file inventory separate from
 * storage operations. No adapter wraps the factory or supplies its proofs. */
export function intakeLookupContributorFixture(t: TestContext) {
  let root = mkdtempSync(join(tmpdir(), 'fictional-native-lookup-'));
  let opened: Database | undefined;
  let closeStorage: (() => void) | undefined;
  t.after(() => {
    try {
      if (opened) {
        originals.delete(opened);
        clearIntakeStateCache(opened);
      }
    } finally {
      try {
        if (opened?.isOpen) opened.close();
      } finally {
        try {
          closeStorage?.();
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  });
  root = realpathSync.native(root);
  const profileId = 'fictional';
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  opened = db;
  const storage = openContributorRecordStorage(root, profileId, { initialize: true });
  closeStorage = () => storage.close();
  attachRecordDurability(db, { profileId, storage });
  originals.set(db, { root, relativeRoot: paths.relativeRoot });
  const base = contributorAuthorityPath(root, profileId);
  return {
    db,
    authority: {
      headPath: join(base, 'head'),
      // Count every retained immutable object and the mutable HEAD, matching
      // the old Map's namespace. Marker and lease files are not record objects.
      objectCount: () =>
        readdirSync(join(base, 'objects')).length + Number(existsSync(join(base, 'head'))),
    },
  };
}

/** Preserve the supplied raw envelope and register an actual physical original
 * through the same preparation and accepted-write path as the application. */
export function registerLookupOriginal(
  db: Database,
  id: string,
  raw: string,
  providerId: string | null = null,
) {
  const context = originals.get(db);
  if (!context) throw Error('Fictional lookup contributor fixture is unavailable');
  const bytes = Buffer.from(raw);
  const path = context.relativeRoot + '/sources/' + encodeURIComponent(id) + '.txt';
  writeFileSync(join(context.root, path), bytes);
  const register = () =>
    registerIntakeFile(db, {
      id,
      providerId,
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      mimeType: 'text/plain',
      kind: 'intake_original',
      coverage: 'unknown',
      details: raw,
    });
  if (db.isTransaction) register();
  else transaction(db, register);
}
