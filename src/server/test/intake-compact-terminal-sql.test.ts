import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:sqlite';
import { openDatabase } from '../database.ts';
import {
  compactTerminalBigIntSql,
  compactTerminalExecutions,
  compactTerminalSql,
  compactTerminalTempSql,
} from '../intake-compact-terminal-sql.ts';
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

test('compact terminal inventory prepares whether each optional TEMP table is absent or present', (t) => {
  const db = openDatabase(':memory:', 'fictional-compact-terminal-temp');
  t.after(() => db.close());
  memoryRecordAuthority(db);
  const tempTable = (table: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name=?").get(table);
  const tables = {
    __intake_lookup_authorities: 'authority_key TEXT PRIMARY KEY,source_id TEXT NOT NULL UNIQUE',
    __intake_lookup_dirty: 'source_id TEXT PRIMARY KEY',
    __source_text_dirty: 'source_id TEXT PRIMARY KEY',
    __source_text_authorities: 'authority_key TEXT PRIMARY KEY,source_id TEXT NOT NULL UNIQUE',
    __intake_clinical_cache_pin: 'id INTEGER PRIMARY KEY,value INTEGER',
  } as const;
  const names = Object.keys(tables) as (keyof typeof tables)[];
  // No pin triggers exist on this connection, so the pin table may be absent.
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_temp_master WHERE sql LIKE '%__intake_clinical_cache_pin%'",
      )
      .get()!.n,
    0,
  );
  const owned: Record<keyof typeof tables, { sql: string; bigInts?: boolean }[]> = {
    __intake_lookup_authorities: [
      {
        sql: 'SELECT source_id FROM temp.__intake_lookup_authorities WHERE authority_key=? LIMIT 2',
      },
      { sql: 'SELECT 1 FROM temp.__intake_lookup_dirty WHERE source_id=?' },
    ],
    __intake_lookup_dirty: [
      { sql: 'SELECT 1 AS present FROM temp.__intake_lookup_dirty WHERE source_id=?' },
    ],
    __source_text_dirty: [
      { sql: 'SELECT 1 AS present FROM temp.__source_text_dirty WHERE source_id=?' },
    ],
    __source_text_authorities: [
      { sql: 'SELECT source_id FROM temp.__source_text_authorities WHERE authority_key=? LIMIT 2' },
    ],
    __intake_clinical_cache_pin: [
      { sql: 'SELECT value FROM temp.__intake_clinical_cache_pin WHERE id=1', bigInts: true },
    ],
  };
  let cases = 0;
  for (let mask = 0; mask < 1 << names.length; mask++) {
    const present = new Set(names.filter((_, index) => mask & (1 << index)));
    for (const name of names)
      db.exec(
        present.has(name)
          ? `CREATE TEMP TABLE IF NOT EXISTS ${name}(${tables[name]})`
          : `DROP TABLE IF EXISTS temp.${name}`,
      );
    const temp = compactTerminalTempSql((table) => tempTable(table));
    // Lookup tracking always creates its authority and dirty tables together.
    if (present.has('__intake_lookup_authorities') && !present.has('__intake_lookup_dirty'))
      continue;
    const capability = prepareTerminalStatements(db, {
      statements: [
        ...compactTerminalSql.map((sql) => ({ sql })),
        ...compactTerminalBigIntSql.map((sql) => ({ sql, bigInts: true })),
        ...temp,
      ],
      executions: compactTerminalExecutions,
    });
    withTerminalStatements(db, capability, () => {
      for (const name of names)
        for (const item of owned[name]) {
          const listed = present.has(name);
          if (listed) terminalStatement(db, item.sql, undefined, item.bigInts === true);
          else
            assert.throws(
              () => terminalStatement(db, item.sql, undefined, item.bigInts === true),
              /unprepared terminal database statement/,
            );
        }
      // An unlisted spelling of a listed read still refuses.
      assert.throws(
        () => terminalStatement(db, 'SELECT source_id FROM temp.__intake_lookup_dirty'),
        /unprepared terminal database statement/,
      );
    });
    cases++;
  }
  assert.equal(cases, 32 - 8);
});
