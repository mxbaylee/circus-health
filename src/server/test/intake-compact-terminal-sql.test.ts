import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:sqlite';
import { openDatabase } from '../database.ts';
import { compactTerminalSql } from '../intake-compact-terminal-sql.ts';
import {
  prepareTerminalStatements,
  terminalStatement,
  withTerminalStatements,
} from '../database-terminal-statements.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';

test('compact terminal inventory transports exact main storage reads without adopting TEMP shadows', () => {
  const profileId = 'fictional-compact-terminal',
    db = openDatabase(':memory:', profileId);
  try {
    memoryRecordAuthority(db);
    const source = { id: 'fictional-original', sha256: 'a'.repeat(64) };
    registerRawIntakeFixture(db, source.id, JSON.stringify({ intake: { version: 1 } }));
    const metadataSql = 'SELECT value FROM main.app_meta WHERE key=?',
      sourceSql = 'SELECT sha256,kind FROM main.source_files WHERE id=?',
      shadowSql =
        "SELECT 1 FROM sqlite_temp_schema WHERE type IN ('table','view') AND (lower(name) IN ('source_files','app_meta','__record_state','__record_current','__record_versions','__record_transactions','__record_fields') OR lower(name) GLOB '__record_intake_lookup_*') LIMIT 1";
    assert.ok(compactTerminalSql.includes(metadataSql));
    assert.ok(compactTerminalSql.includes(sourceSql));
    // Unqualified reads genuinely resolve to the adversarial TEMP rows. The
    // finite transport must retain main resolution and the separate refusal query.
    db.exec(
      'CREATE TEMP TABLE app_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO temp.app_meta SELECT * FROM main.app_meta; CREATE TEMP TABLE source_files AS SELECT * FROM main.source_files;',
    );
    db.prepare('UPDATE temp.app_meta SET value=? WHERE key=?').run(
      'fictional-foreign',
      'owner_profile_id',
    );
    db.prepare('UPDATE temp.source_files SET sha256=? WHERE id=?').run('0'.repeat(64), source.id);
    assert.equal(
      db.prepare('SELECT value FROM app_meta WHERE key=?').get('owner_profile_id')!.value,
      'fictional-foreign',
    );
    assert.equal(
      db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(source.id)!.sha256,
      '0'.repeat(64),
    );
    const cachedMeta = db.prepare(metadataSql),
      cachedSource = db.prepare(sourceSql),
      decisions: Array<{ table: string | null; database: string | null }> = [];
    let sealed = false;
    db.setAuthorizer((action, table, _column, database) => {
      assert.equal(sealed, false, 'the actual installed policy runs before terminal closure');
      if (action === constants.SQLITE_READ && (table === 'app_meta' || table === 'source_files'))
        decisions.push({ table, database });
      return constants.SQLITE_OK;
    });
    const prepared = prepareTerminalStatements(db, {
      statements: compactTerminalSql.map((sql) => ({ sql })),
    });
    assert.ok(decisions.some((row) => row.table === 'app_meta' && row.database === 'main'));
    assert.ok(decisions.some((row) => row.table === 'source_files' && row.database === 'main'));
    sealed = true;
    try {
      withTerminalStatements(db, prepared, () => {
        assert.equal(
          terminalStatement(db, metadataSql, cachedMeta).get('owner_profile_id')!.value,
          profileId,
        );
        assert.deepEqual(
          { ...terminalStatement(db, sourceSql, cachedSource).get(source.id)! },
          { sha256: source.sha256, kind: 'intake_original' },
        );
        assert.ok(
          terminalStatement(db, shadowSql).get(),
          'the original TEMP-shadow refusal query still identifies the changed namespace',
        );
        assert.throws(
          () =>
            terminalStatement(db, 'SELECT sha256,kind FROM main.source_files WHERE id=? LIMIT 1'),
          /unprepared terminal/,
        );
      });
    } finally {
      sealed = false;
    }
  } finally {
    db.close();
  }
});
