import { validateIntakeStateCopyRows, type IntakeCopyOriginal } from './intake-state-bootstrap.ts';
import { IntakeStateManifest } from './intake-state-manifest.ts';
import { intakeSourcePinKey, parseIntakeSourcePin } from './intake-source-pin.ts';
import { invalid } from './intake-state-evidence.ts';
import { validatePortableIntakeSourceTextRows } from './intake-source-text.ts';

type Row = Record<string, unknown>;
export interface PortableIntakeRows {
  rows(table: string): Iterable<Row>;
}

/** Portable generations retain exact metadata strings, validated through a disposable index. */
export function validatePortableIntakeRows(source: PortableIntakeRows, profileId: string): void {
  const manifest = new IntakeStateManifest();
  try {
    const db = manifest.db;
    db.exec(
      'CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE original_ids(id TEXT PRIMARY KEY);',
    );
    for (const row of source.rows('app_meta')) {
      if (typeof row.key !== 'string' || typeof row.value !== 'string')
        invalid('portable metadata inventory');
      if (db.prepare('SELECT 1 FROM metadata WHERE key=?').get(row.key))
        invalid('portable metadata inventory');
      db.prepare('INSERT INTO metadata VALUES(?,?)').run(row.key, row.value);
    }
    if (
      db.prepare("SELECT value FROM metadata WHERE key='owner_profile_id'").get()?.value !==
      profileId
    )
      invalid('portable intake owner');
    function* originals(): Generator<IntakeCopyOriginal> {
      for (const row of source.rows('source_files')) {
        if (row.kind !== 'intake_original') continue;
        if (
          typeof row.id !== 'string' ||
          db.prepare('SELECT 1 FROM original_ids WHERE id=?').get(row.id)
        )
          invalid('portable original identity');
        db.prepare('INSERT INTO original_ids VALUES(?)').run(row.id);
        yield {
          id: row.id,
          kind: row.kind,
          sha256: row.sha256,
          path: row.path,
          detailsJson: row.details_json,
          sourcePin:
            db.prepare('SELECT value FROM metadata WHERE key=?').get(intakeSourcePinKey(row.id))
              ?.value ?? null,
          preserved: {
            provider_id: row.provider_id,
            bytes: row.bytes,
            mime_type: row.mime_type,
            coverage_status: row.coverage_status,
            batch_id: row.batch_id,
          },
        } as IntakeCopyOriginal;
      }
    }
    function* rows(): Generator<{ key: string; value: string }> {
      for (const row of db
        .prepare("SELECT key,value FROM metadata WHERE key GLOB 'intake_state_*'")
        .iterate())
        yield { key: String(row.key), value: String(row.value) };
    }
    validateIntakeStateCopyRows({
      sourceProfileId: profileId,
      originals: originals(),
      rows: rows(),
    });
    for (const row of db
      .prepare("SELECT key,value FROM metadata WHERE key GLOB 'intake_source_pin:*'")
      .iterate()) {
      const match = /^intake_source_pin:v1:(.+)$/.exec(String(row.key));
      if (!match || !db.prepare('SELECT 1 FROM original_ids WHERE id=?').get(match[1]))
        invalid('unsupported portable source pin');
      parseIntakeSourcePin(String(row.value));
    }
    validatePortableIntakeSourceTextRows(source, profileId);
  } finally {
    manifest.close();
  }
}
export function validatePortableIntakeState(
  tables: Record<string, Row[]>,
  profileId: string,
): void {
  if (!Array.isArray(tables.app_meta) || !Array.isArray(tables.source_files))
    invalid('portable intake tables');
  validatePortableIntakeRows({ rows: (table) => tables[table] ?? [] }, profileId);
}
