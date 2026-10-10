import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  renameSync,
  realpathSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { backup } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability, rebuildProfile, writePortableSources } from '../portable.ts';
import {
  attachRecordDurability,
  queryRecordHistory,
  recordDurabilityStatus,
} from '../record-versions.ts';
import {
  openContributorRecordStorage,
  contributorAuthorityPath,
} from '../contributor-record-storage.ts';
import {
  rebuildContributorDatabase,
  assertContributorCopyCoherence,
  copyContributorAuthority,
  selectedContributorHead,
} from '../contributor-durability.ts';
import { createBackup, restoreBackup } from '../recovery.ts';
import { rebuildStartup } from '../startup-rebuild.ts';
import { readProfileRegistry } from '../profile-registry.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-contributor-record-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = ensureProfileDirectories(root, 'cedar');
  const db = openDatabase(paths.database, 'cedar');
  t.after(() => {
    if (db.isOpen) db.close();
  });
  return { root, paths, db };
}
test('normal contributor transactions select changed record evidence and reconstruct without portable snapshots', (t) => {
  const { root, paths, db } = fixture(t);
  db.prepare('INSERT INTO app_meta VALUES(?,?)').run('fictional:unchanged', 'x'.repeat(200_000));
  attachPersonalDurability(db, { root, profileId: 'cedar' });
  const directory = resolve(contributorAuthorityPath(root, 'cedar'), 'objects');
  const bytes = () =>
    readdirSync(directory).reduce((sum, file) => sum + statSync(resolve(directory, file)).size, 0);
  const baseline = bytes();
  for (let i = 0; i < 20; i++)
    transaction(db, () =>
      db
        .prepare('INSERT OR REPLACE INTO app_meta VALUES(?,?)')
        .run('fictional:decision', String(i)),
    );
  assert.ok(
    bytes() - baseline < 120_000,
    'unchanged large row must not be rewritten for each decision',
  );
  assert.equal(recordDurabilityStatus(db)?.configured, true);
  assert.throws(
    () => attachPersonalDurability(db, { root, profileId: 'cedar', portableSnapshots: true }),
    /second portable publisher/,
  );
  assert.equal(existsSync(resolve(paths.personal, 'current.json')), false);
  assert.equal(existsSync(resolve(paths.curation, 'current.json')), false);
  db.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(paths.database + suffix, { force: true });
  rebuildContributorDatabase(paths.database, root, 'cedar');
  const restored = openDatabase(paths.database, 'cedar');
  try {
    attachPersonalDurability(restored, { root, profileId: 'cedar', initialize: false });
    assert.equal(
      restored.prepare("SELECT value FROM app_meta WHERE key='fictional:decision'").get()?.value,
      '19',
    );
  } finally {
    restored.close();
  }
});
test('selected journal refuses missing head and never reseeds from its cache or portable exports', (t) => {
  const { root, db } = fixture(t);
  attachPersonalDurability(db, { root, profileId: 'cedar' });
  db.close();
  rmSync(resolve(contributorAuthorityPath(root, 'cedar'), 'head'));
  assert.throws(
    () => openContributorRecordStorage(root, 'cedar', { initialize: true }),
    /selected head is missing/,
  );
});
test('fresh journal refuses published portable authority', (t) => {
  const { root, db, paths } = fixture(t);
  writeFileSync(resolve(paths.personal, 'current.json'), '{}');
  assert.throws(
    () => attachPersonalDurability(db, { root, profileId: 'cedar' }),
    /automatic conversion is unsupported/,
  );
});
test('filesystem backend enforces exclusive writer, immutable objects and physical paths', (t) => {
  const { root } = fixture(t);
  const backend = openContributorRecordStorage(root, 'cedar', { initialize: true });
  try {
    assert.throws(
      () => openContributorRecordStorage(root, 'cedar', { initialize: true }),
      /another writer/,
    );
    const object = 'objects/' + randomUUID();
    backend.writeImmutable(object, Buffer.from('fictional'));
    backend.writeImmutable(object, Buffer.from('fictional'));
    assert.throws(
      () => backend.writeImmutable(object, Buffer.from('different')),
      /immutable collision/,
    );
    assert.throws(() => backend.read('../head'), /invalid object name/);
    const linked = 'objects/' + randomUUID();
    symlinkSync(
      resolve(contributorAuthorityPath(root, 'cedar'), object),
      resolve(contributorAuthorityPath(root, 'cedar'), linked),
    );
    assert.throws(() => backend.read(linked), /physical file/);
  } finally {
    backend.close();
  }
});
for (const afterPublication of [false, true])
  test(`publication failure ${afterPublication ? 'after' : 'before'} head preserves correct accepted state`, (t) => {
    const { root, paths, db } = fixture(t);
    const storage = openContributorRecordStorage(root, 'cedar', { initialize: true });
    let armed = false;
    attachRecordDurability(db, {
      profileId: 'cedar',
      storage: {
        read: storage.read,
        writeImmutable: storage.writeImmutable,
        publishHead(bytes) {
          if (armed && !afterPublication) throw Error('fictional publication failure');
          storage.publishHead(bytes);
          if (armed) throw Error('fictional ambiguous completion');
        },
      },
    });
    armed = true;
    const before = readFileSync(resolve(contributorAuthorityPath(root, 'cedar'), 'head'));
    assert.throws(
      () =>
        transaction(db, () =>
          db.prepare("INSERT INTO app_meta VALUES('fictional:accepted','yes')").run(),
        ),
      /fictional/,
    );
    assert.equal(
      db.prepare("SELECT value FROM app_meta WHERE key='fictional:accepted'").get(),
      undefined,
    );
    assert.equal(
      readFileSync(resolve(contributorAuthorityPath(root, 'cedar'), 'head')).equals(before),
      !afterPublication,
    );
    db.close();
    storage.close();
    const existing = openDatabase(paths.database, 'cedar');
    try {
      attachPersonalDurability(existing, { root, profileId: 'cedar', initialize: false });
      assert.equal(
        existing.prepare("SELECT value FROM app_meta WHERE key='fictional:accepted'").get()?.value,
        afterPublication ? 'yes' : undefined,
      );
    } finally {
      existing.close();
    }
    for (const suffix of ['', '-wal', '-shm']) rmSync(paths.database + suffix, { force: true });
    rebuildContributorDatabase(paths.database, root, 'cedar');
    const restored = openDatabase(paths.database, 'cedar');
    try {
      assert.equal(
        restored.prepare("SELECT value FROM app_meta WHERE key='fictional:accepted'").get()?.value,
        afterPublication ? 'yes' : undefined,
      );
    } finally {
      restored.close();
    }
  });
test('same-profile rebuild retains selected journal and permits later normal edits', (t) => {
  const { root, db } = fixture(t);
  attachPersonalDurability(db, { root, profileId: 'cedar' });
  transaction(db, () =>
    db.prepare("INSERT INTO app_meta VALUES('fictional:accepted','yes')").run(),
  );
  const target = resolve(root, 'restored');
  const result = rebuildProfile(root, 'cedar', target);
  const restored = openDatabase(result.database, 'cedar');
  try {
    attachPersonalDurability(restored, { root: target, profileId: 'cedar', initialize: false });
    transaction(restored, () =>
      restored.prepare("UPDATE app_meta SET value='later' WHERE key='fictional:accepted'").run(),
    );
    assert.equal(
      restored.prepare("SELECT value FROM app_meta WHERE key='fictional:accepted'").get()?.value,
      'later',
    );
  } finally {
    restored.close();
  }
});
test('backup and restore retain selected journal independently of stale portable artifacts', async (t) => {
  const { root, db } = fixture(t);
  attachPersonalDurability(db, { root, profileId: 'cedar' });
  transaction(db, () =>
    db.prepare("INSERT INTO app_meta VALUES('fictional:backup','accepted')").run(),
  );
  const backup = await createBackup(db, root, 'cedar', resolve(root, 'backup'));
  transaction(db, () =>
    db.prepare("UPDATE app_meta SET value='advanced' WHERE key='fictional:backup'").run(),
  );
  const target = resolve(root, 'restore');
  restoreBackup(backup.path, target);
  const paths = ensureProfileDirectories(target, 'cedar');
  const restored = openDatabase(paths.database, 'cedar');
  try {
    attachPersonalDurability(restored, { root: target, profileId: 'cedar', initialize: false });
    assert.equal(
      restored.prepare("SELECT value FROM app_meta WHERE key='fictional:backup'").get()?.value,
      'accepted',
    );
  } finally {
    restored.close();
  }
});
test('corrupt committed objects refuse reconstruction rather than selecting portable state', (t) => {
  const { root, db, paths } = fixture(t);
  attachPersonalDurability(db, { root, profileId: 'cedar' });
  db.close();
  const base = contributorAuthorityPath(root, 'cedar');
  const head = JSON.parse(readFileSync(resolve(base, 'head'), 'utf8')) as { name: string };
  writeFileSync(resolve(base, head.name), 'corrupt');
  rmSync(paths.database);
  assert.throws(() => readProfileRegistry(root), /corrupt committed object/);
  assert.throws(
    () => rebuildContributorDatabase(paths.database, root, 'cedar'),
    /corrupt committed object/,
  );
});
test('contributor startup reconstructs selected record history without requiring portable generations', (t) => {
  const { root, db } = fixture(t);
  attachPersonalDurability(db, { root, profileId: 'cedar' });
  transaction(db, () =>
    db.prepare("INSERT INTO app_meta VALUES('fictional:startup','retained')").run(),
  );
  db.close();
  const result = rebuildStartup({
    dataDirectory: resolve(root, 'data'),
    runtimeDirectory: resolve(root, 'runtime'),
    profileIds: ['cedar'],
  });
  assert.equal(result.receipt.outcome, 'success');
  assert.ok(result.receipt.profiles[0].recordHead);
  assert.ok((result.receipt.profiles[0].peakMemoryBytes ?? 0) > 0);
  const rebuilt = openDatabase(result.databases[0][1], 'cedar');
  try {
    assert.equal(
      rebuilt.prepare("SELECT value FROM app_meta WHERE key='fictional:startup'").get()?.value,
      'retained',
    );
  } finally {
    rebuilt.close();
  }
});
test('missing selected journal directory never falls back to retained portable exports', (t) => {
  const { root, db } = fixture(t);
  attachPersonalDurability(db, { root, profileId: 'cedar' });
  writePortableSources(db, root, 'cedar', root);
  db.close();
  rmSync(contributorAuthorityPath(root, 'cedar'), { recursive: true });
  assert.throws(() => rebuildProfile(root, 'cedar', resolve(root, 'refused')), /ENOENT|missing/);
});
test('behind cache with a conflicting unpublished edit refuses before accepted catch-up can overwrite it', (t) => {
  const { root, paths, db } = fixture(t);
  db.prepare("INSERT INTO app_meta VALUES('fictional:conflict','baseline')").run();
  const storage = openContributorRecordStorage(root, 'cedar', { initialize: true });
  let armed = false;
  attachRecordDurability(db, {
    profileId: 'cedar',
    storage: {
      read: storage.read,
      writeImmutable: storage.writeImmutable,
      publishHead(bytes) {
        storage.publishHead(bytes);
        if (armed) throw Error('fictional lost acknowledgment');
      },
    },
  });
  armed = true;
  assert.throws(
    () =>
      transaction(db, () =>
        db.prepare("UPDATE app_meta SET value='published' WHERE key='fictional:conflict'").run(),
      ),
    /lost acknowledgment/,
  );
  db.prepare(
    "UPDATE app_meta SET value='conflicting unpublished edit' WHERE key='fictional:conflict'",
  ).run();
  const indexedBefore = db.prepare('SELECT head_json FROM __record_state').get()!.head_json;
  const selectedBefore = readFileSync(resolve(contributorAuthorityPath(root, 'cedar'), 'head'));
  db.close();
  storage.close();
  const reopened = openDatabase(paths.database, 'cedar');
  try {
    assert.throws(
      () => attachPersonalDurability(reopened, { root, profileId: 'cedar', initialize: false }),
      /conflicts with its indexed accepted authority before recovery/,
    );
    assert.equal(
      reopened.prepare("SELECT value FROM app_meta WHERE key='fictional:conflict'").get()?.value,
      'conflicting unpublished edit',
    );
    assert.equal(
      reopened.prepare('SELECT head_json FROM __record_state').get()!.head_json,
      indexedBefore,
    );
    assert.deepEqual(
      readFileSync(resolve(contributorAuthorityPath(root, 'cedar'), 'head')),
      selectedBefore,
    );
  } finally {
    reopened.close();
  }
});
test('selected authority refuses an unindexed existing cache without resetting its rows', (t) => {
  const { root, paths, db } = fixture(t);
  attachPersonalDurability(db, { root, profileId: 'cedar' });
  db.close();
  const reopened = openDatabase(paths.database, 'cedar');
  try {
    reopened.exec('DROP TABLE __record_state');
    reopened.prepare("INSERT INTO app_meta VALUES('fictional:unindexed','unpublished')").run();
    assert.throws(
      () => attachPersonalDurability(reopened, { root, profileId: 'cedar', initialize: false }),
      /missing its accepted index/,
    );
    assert.equal(
      reopened.prepare("SELECT value FROM app_meta WHERE key='fictional:unindexed'").get()?.value,
      'unpublished',
    );
  } finally {
    reopened.close();
  }
});

test('old contributor projection refuses direct reuse and staged recovery preserves accepted history', (t) => {
  const { root, paths, db } = fixture(t);
  const authorityBytes = (archiveRoot: string) => {
    const authority = contributorAuthorityPath(archiveRoot, 'cedar');
    const files: Array<[string, Buffer]> = [
      ['record-authority.json', readFileSync(resolve(authority, '../record-authority.json'))],
    ];
    const visit = (directory: string, relative = '') => {
      for (const name of readdirSync(directory).sort()) {
        if (name === 'writer.lock') continue;
        const path = resolve(directory, name);
        const child = relative ? `${relative}/${name}` : name;
        if (statSync(path).isDirectory()) visit(path, child);
        else files.push([child, readFileSync(path)]);
      }
    };
    visit(authority);
    return files;
  };
  db.prepare("INSERT INTO app_meta VALUES('fictional:projection','initial')").run();
  attachPersonalDurability(db, { root, profileId: 'cedar' });
  transaction(db, () =>
    db.prepare("UPDATE app_meta SET value='accepted' WHERE key='fictional:projection'").run(),
  );
  const history = queryRecordHistory(db, {
    profileId: 'cedar',
    entity: 'app_meta',
    recordId: 'fictional:projection',
  });
  assert.equal(history.entries.length, 2);
  assert.deepEqual(
    history.entries[1]!.changes.map((change) => change.field),
    ['key', 'value'],
  );
  assert.deepEqual(history.entries[1]!.changes[1]!.after, {
    present: true,
    value: 'initial',
  });
  const head = selectedContributorHead(root, 'cedar');
  db.prepare('UPDATE __record_state SET projection=2 WHERE singleton=1').run();
  db.close();
  const acceptedBytes = authorityBytes(root);

  const reopened = openDatabase(paths.database, 'cedar');
  try {
    assert.throws(
      () => attachPersonalDurability(reopened, { root, profileId: 'cedar', initialize: false }),
      /unsupported or incomplete history projection; rebuild cache/,
    );
    assert.equal(
      reopened.prepare("SELECT value FROM app_meta WHERE key='fictional:projection'").get()?.value,
      'accepted',
    );
    assert.equal(reopened.prepare('SELECT projection FROM __record_state').get()?.projection, 2);
    assert.equal(selectedContributorHead(root, 'cedar'), head);
  } finally {
    reopened.close();
  }
  assert.deepEqual(authorityBytes(root), acceptedBytes);

  const target = resolve(root, 'recovered');
  rebuildProfile(root, 'cedar', target);
  assert.deepEqual(authorityBytes(root), acceptedBytes);
  assert.deepEqual(authorityBytes(target), acceptedBytes);
  const restored = openDatabase(resolve(target, 'data/profiles/cedar/db/database.sqlite'), 'cedar');
  try {
    attachPersonalDurability(restored, { root: target, profileId: 'cedar', initialize: false });
    assert.equal(
      restored.prepare("SELECT value FROM app_meta WHERE key='fictional:projection'").get()?.value,
      'accepted',
    );
    assert.deepEqual(
      queryRecordHistory(restored, {
        profileId: 'cedar',
        entity: 'app_meta',
        recordId: 'fictional:projection',
      }),
      history,
    );
  } finally {
    restored.close();
  }
  assert.equal(selectedContributorHead(root, 'cedar'), head);
  assert.equal(existsSync(paths.database), true);
  const source = openDatabase(paths.database, 'cedar');
  try {
    assert.equal(source.prepare('SELECT projection FROM __record_state').get()?.projection, 2);
    assert.equal(
      source.prepare("SELECT value FROM app_meta WHERE key='fictional:projection'").get()?.value,
      'accepted',
    );
  } finally {
    source.close();
  }

  const authority = contributorAuthorityPath(target, 'cedar');
  const committed = JSON.parse(readFileSync(resolve(authority, 'head'), 'utf8')) as {
    name: string;
  };
  writeFileSync(resolve(authority, committed.name), 'corrupt');
  assert.throws(
    () => rebuildProfile(target, 'cedar', resolve(root, 'refused')),
    /corrupt committed object/,
  );
  assert.equal(existsSync(resolve(root, 'refused')), false);
  assert.equal(selectedContributorHead(root, 'cedar'), head);
  assert.deepEqual(authorityBytes(root), acceptedBytes);
});

test('contributor copy compares exact streamed row multisets and publishes authority paths to a bounded sink', async (t) => {
  const { root, db } = fixture(t);
  const insert = db.prepare('INSERT INTO app_meta VALUES(?,?)');
  for (let ordinal = 0; ordinal < 1024; ordinal++)
    insert.run('fictional:retained:' + ordinal, 'opaque-' + 'x'.repeat(256));
  insert.run('fictional:astral', '𐀀');
  insert.run('fictional:bmp', '\ue000');
  attachPersonalDurability(db, { root, profileId: 'cedar' });
  const backupPath = resolve(root, 'copy.sqlite');
  await backup(db, backupPath);
  const copied = openDatabase(backupPath, 'cedar');
  try {
    assertContributorCopyCoherence(db, root, 'cedar', copied);
    copied
      .prepare("UPDATE app_meta SET value=? WHERE key='fictional:retained:1023'")
      .run('unpublished change');
    assert.throws(
      () => assertContributorCopyCoherence(db, root, 'cedar', copied),
      /conflicts with selected record authority/,
    );
  } finally {
    copied.close();
  }
  const target = resolve(root, 'authority-copy');
  let files = 0;
  const collected = copyContributorAuthority(root, 'cedar', target, {
    onFile(path) {
      files++;
      assert.equal(existsSync(resolve(target, path)), true);
    },
  });
  assert.equal(collected.length, 0);
  assert.ok(files > 3);
  assert.equal(selectedContributorHead(target, 'cedar'), selectedContributorHead(root, 'cedar'));
});

// These are physical reads through the real filesystem, not cached path claims.
test('authority reads retain every fresh native physical-path proof and current head bytes', async (t) => {
  const { root, paths } = fixture(t);
  const head = resolve(contributorAuthorityPath(root, 'cedar'), 'head');
  const physical = realpathSync.native;
  const observed: string[] = [];
  const probe = t.mock.method(realpathSync, 'native', (...args: Parameters<typeof physical>) => {
    observed.push(String(args[0]));
    return physical(...args);
  });
  let storage: ReturnType<typeof openContributorRecordStorage> | undefined;
  try {
    // The real resolver is captured at factory-module initialization. This
    // isolated reader observes that capture without making it mutable later.
    const isolated: typeof import('../contributor-record-storage.ts') = await import(
      new URL('../contributor-record-storage.ts?physical-path-proof', import.meta.url).href
    );
    storage = isolated.openContributorRecordStorage(root, 'cedar', { initialize: true });
    const opened = storage;
    t.after(() => opened.close());
    storage.publishHead(Buffer.from('first fictional head'));
    for (const value of ['second fictional head', 'third fictional head']) {
      writeFileSync(head, value);
      observed.length = 0;
      assert.equal(storage.read('head')?.toString(), value);
      assert.deepEqual(observed, [paths.root, paths.records, paths.records, head]);
    }
    // The OS resolver is required, not a positive pathname cached by this backend.
    probe.mock.mockImplementation(() => {
      throw Error('fictional native resolver refusal');
    });
    assert.throws(() => opened.read('head'), /native resolver refusal/);
  } finally {
    probe.mock.mockImplementation(physical);
    probe.mock.restore();
  }
  assert.ok(storage);
  assert.equal(storage.read('head')?.toString(), 'third fictional head');
});

for (const component of ['ancestor', 'profile', 'records', 'objects'] as const)
  test('open contributor backend rejects a linked ' + component + ' on its next read', (t) => {
    const { root, paths } = fixture(t);
    const storage = openContributorRecordStorage(root, 'cedar', { initialize: true });
    t.after(() => storage.close());
    const name = 'objects/' + randomUUID();
    storage.writeImmutable(name, Buffer.from('fictional unchanged object'));
    const selected =
      component === 'ancestor'
        ? resolve(root, 'data')
        : component === 'profile'
          ? paths.root
          : component === 'records'
            ? paths.records
            : resolve(paths.records, 'objects');
    const moved = selected + '.moved';
    renameSync(selected, moved);
    symlinkSync(moved, selected, 'dir');
    try {
      assert.throws(() => storage.read(name), /physical|profile scoped/);
    } finally {
      rmSync(selected);
      renameSync(moved, selected);
    }
    assert.equal(storage.read(name)?.toString(), 'fictional unchanged object');
  });

test('native path validation preserves missing, broken-link and nonregular-file refusal', (t) => {
  const { root, paths } = fixture(t);
  const storage = openContributorRecordStorage(root, 'cedar', { initialize: true });
  t.after(() => storage.close());
  const missing = 'objects/' + randomUUID();
  assert.equal(storage.read(missing), null);
  symlinkSync(resolve(paths.records, 'absent-target'), resolve(paths.records, missing));
  assert.throws(() => storage.read(missing), /nonregular authority/);
  rmSync(resolve(paths.records, missing));
  symlinkSync(resolve(paths.records, 'objects'), resolve(paths.records, missing), 'dir');
  assert.throws(() => storage.read(missing), /regular physical/);
});
