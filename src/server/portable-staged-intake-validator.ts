import type { DatabaseSync } from 'node:sqlite';
import {
  createIntakeCopyIncrementalReaderFromStandalone,
  type IntakeCopyStandaloneTextReader,
} from './intake-copy-incremental-reader.ts';
import { intakeCopyPieceSource } from './intake-copy-piece-source.ts';
import { validateIntakeStateCopyRows } from './intake-state-bootstrap.ts';
import { validatePortableIntakeSourceTextDatabase } from './intake-source-text.ts';
import { intakeSourcePinKey } from './intake-source-pin.ts';
import { invalid } from './intake-state-evidence.ts';

const PIN_PREFIX = 'intake_source_pin:v1:';
const STATE_KEY_UNITS = 256;

function text(
  reader: IntakeCopyStandaloneTextReader,
  table: 'app_meta' | 'source_files',
  column: string,
  rowid: bigint,
  maximumUnits?: number,
): string {
  if (reader.columnType(table, column, rowid) !== 'text')
    invalid('portable intake field storage class');
  let value = '';
  for (const piece of reader.textPieces(table, column, rowid)) {
    value += piece;
    if (maximumUnits !== undefined && value.length > maximumUnits)
      invalid('unsupported copy namespace');
  }
  return value;
}

function nullableText(
  reader: IntakeCopyStandaloneTextReader,
  column: string,
  rowid: bigint,
): string | null {
  if (reader.columnType('source_files', column, rowid) === 'null') return null;
  return text(reader, 'source_files', column, rowid);
}

function owner(db: DatabaseSync, reader: IntakeCopyStandaloneTextReader, profileId: string): void {
  const row = db
    .prepare("SELECT CAST(rowid AS TEXT) AS rid FROM main.app_meta WHERE key='owner_profile_id'")
    .get();
  if (!row) invalid('portable intake owner');
  const rowid = BigInt(String(row.rid));
  if (reader.columnType('app_meta', 'value', rowid) !== 'text') invalid('portable intake owner');
  const expected = [profileId];
  let at = 0;
  for (const piece of reader.textPieces('app_meta', 'value', rowid)) {
    if (piece !== expected[0].slice(at, at + piece.length)) invalid('portable intake owner');
    at += piece.length;
  }
  if (at !== profileId.length) invalid('portable intake owner');
}

/**
 * Validate a completed private staged SQLite projection. The caller still owns
 * archive selection, accepted-original proof, and target-publication authority.
 */
export function validatePortableStagedIntakeDatabase(
  db: DatabaseSync,
  profileId: string,
  checkpoint: () => void,
): void {
  const reader = createIntakeCopyIncrementalReaderFromStandalone(db, checkpoint);
  try {
    owner(db, reader, profileId);
    if (db.prepare('SELECT 1 FROM main.app_meta GROUP BY key HAVING COUNT(*)>1 LIMIT 1').get())
      invalid('portable metadata inventory');
    for (const rowid of reader.rowIds('app_meta')) {
      checkpoint();
      if (
        reader.columnType('app_meta', 'key', rowid) !== 'text' ||
        reader.columnType('app_meta', 'value', rowid) !== 'text'
      )
        invalid('portable metadata inventory');
    }
    const invalidPin = db
      .prepare(
        `SELECT 1 FROM main.app_meta AS m
         WHERE m.key GLOB 'intake_source_pin:*'
           AND (
             substr(m.key,1,${PIN_PREFIX.length}) <> '${PIN_PREFIX}'
             OR NOT EXISTS (
               SELECT 1 FROM main.source_files AS s
               WHERE s.kind='intake_original' AND m.key='${PIN_PREFIX}' || s.id
             )
           ) LIMIT 1`,
      )
      .get();
    if (invalidPin) invalid('unsupported portable source pin');
    function* originals() {
      const rows = db
        .prepare(
          "SELECT CAST(rowid AS TEXT) AS rid, bytes FROM main.source_files WHERE kind='intake_original' ORDER BY id",
        )
        .iterate();
      for (const row of rows) {
        checkpoint();
        const rowid = BigInt(String(row.rid));
        const id = text(reader, 'source_files', 'id', rowid);
        const pinRow = db
          .prepare('SELECT CAST(rowid AS TEXT) AS rid FROM main.app_meta WHERE key=?')
          .get(intakeSourcePinKey(id));
        yield {
          id,
          kind: text(reader, 'source_files', 'kind', rowid),
          sha256: text(reader, 'source_files', 'sha256', rowid),
          path: text(reader, 'source_files', 'path', rowid),
          detailsJson: intakeCopyPieceSource(() =>
            reader.textPieces('source_files', 'details_json', rowid),
          ),
          sourcePin: pinRow ? text(reader, 'app_meta', 'value', BigInt(String(pinRow.rid))) : null,
          preserved: {
            provider_id: nullableText(reader, 'provider_id', rowid),
            bytes: row.bytes as number,
            mime_type: text(reader, 'source_files', 'mime_type', rowid),
            coverage_status: text(reader, 'source_files', 'coverage_status', rowid),
            batch_id: nullableText(reader, 'batch_id', rowid),
          },
        };
      }
    }
    function* rows() {
      for (const row of db
        .prepare(
          "SELECT CAST(rowid AS TEXT) AS rid FROM main.app_meta WHERE key GLOB 'intake_state_*' ORDER BY key",
        )
        .iterate()) {
        checkpoint();
        const rowid = BigInt(String(row.rid));
        yield {
          key: text(reader, 'app_meta', 'key', rowid, STATE_KEY_UNITS),
          value: intakeCopyPieceSource(() => reader.textPieces('app_meta', 'value', rowid)),
        };
      }
    }
    validateIntakeStateCopyRows({
      sourceProfileId: profileId,
      originals: originals(),
      rows: rows(),
    });
    checkpoint();
    validatePortableIntakeSourceTextDatabase(reader, profileId, checkpoint);
    // Close the selected file interval after the last callback-capable traversal.
    owner(db, reader, profileId);
  } finally {
    reader.close();
  }
}
