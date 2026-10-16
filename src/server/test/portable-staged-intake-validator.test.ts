import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePortableStagedIntakeDatabase } from '../portable-staged-intake-validator.ts';

const profileId = 'fictional-portable-owner';

function staged(run: (db: DatabaseSync, path: string) => void, uniqueMetadata = true): void {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-portable-staged-'));
  const path = join(directory, 'projection.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE app_meta(key TEXT ${uniqueMetadata ? 'PRIMARY KEY' : ''},value TEXT NOT NULL);
      CREATE TABLE source_files(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, sha256 TEXT NOT NULL,
        path TEXT NOT NULL, details_json TEXT NOT NULL, provider_id TEXT,
        bytes INTEGER NOT NULL, mime_type TEXT NOT NULL,
        coverage_status TEXT NOT NULL, batch_id TEXT
      );
    `);
    db.prepare('INSERT INTO app_meta VALUES(?,?)').run('owner_profile_id', profileId);
    run(db, path);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('private staged validator crosses large unrelated metadata without accepting it as authority', () => {
  staged((db) => {
    db.prepare('INSERT INTO app_meta VALUES(?,?)').run(
      'fictional_unrelated',
      'x'.repeat(1024 * 1024),
    );
    let checks = 0;
    validatePortableStagedIntakeDatabase(db, profileId, () => {
      checks++;
    });
    assert.ok(checks > 16, 'the private reader checks the completed file during traversal');
  });
});

test('private staged validator refuses the wrong owner without publication', () => {
  staged((db) => {
    assert.throws(
      () => validatePortableStagedIntakeDatabase(db, 'fictional-other-owner', () => {}),
      /portable intake owner/,
    );
  });
});

test('private staged validator refuses a pin without an original', () => {
  staged((db) => {
    db.prepare('INSERT INTO app_meta VALUES(?,?)').run('intake_source_pin:v1:missing', '{}');
    assert.throws(
      () => validatePortableStagedIntakeDatabase(db, profileId, () => {}),
      /unsupported portable source pin/,
    );
  });
});

test('private staged validator refuses duplicate metadata in a malformed target schema', () => {
  staged((db) => {
    db.prepare('INSERT INTO app_meta VALUES(?,?)').run('owner_profile_id', profileId);
    assert.throws(
      () => validatePortableStagedIntakeDatabase(db, profileId, () => {}),
      /portable metadata inventory/,
    );
  }, false);
});

test('private staged validator traverses a fictional original through piece-backed details', () => {
  staged((db) => {
    db.prepare('INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      'fictional-intake',
      'intake_original',
      'a'.repeat(64),
      `data/profiles/${profileId}/sources/fictional.pdf`,
      JSON.stringify({ note: 'x'.repeat(1024 * 1024) }),
      null,
      1024 * 1024,
      'application/pdf',
      'covered',
      null,
    );
    validatePortableStagedIntakeDatabase(db, profileId, () => {});
  });
});

test('private staged validator refuses same-byte replacement during a checkpoint', () => {
  staged((db, path) => {
    db.prepare('INSERT INTO app_meta VALUES(?,?)').run(
      'fictional_unrelated',
      'x'.repeat(1024 * 1024),
    );
    let checks = 0;
    assert.throws(
      () =>
        validatePortableStagedIntakeDatabase(db, profileId, () => {
          if (++checks !== 40) return;
          const replacement = `${path}.replacement`;
          copyFileSync(path, replacement);
          renameSync(replacement, path);
        }),
      /Incremental copy standalone identity changed/,
    );
    assert.ok(checks >= 40, 'the fault occurs during the pinned reader interval');
  });
});
