/** Private cold checked membership joins, reused for each prepared report row. */
import { setImmediate } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { Database } from './database.ts';
import { hasIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
import {
  ownershipIntakeScopeOccurrences,
  ownershipIntakeScopes,
} from './ownership-intake-scopes.ts';
export function createOwnershipScopeIndex(
  db: Database,
  sql: DatabaseSync,
  assertCurrent: () => void,
) {
  sql.exec(`CREATE TABLE scope_indices(intake_id TEXT PRIMARY KEY);
    CREATE TABLE scope_groups(intake_id TEXT,group_ordinal INTEGER,group_id TEXT,version_id TEXT,subject_text TEXT,PRIMARY KEY(intake_id,group_ordinal));
    CREATE TABLE scope_members(intake_id TEXT,group_ordinal INTEGER,group_id TEXT,version_id TEXT,record_id TEXT,latest INTEGER,subject_text TEXT,PRIMARY KEY(intake_id,group_ordinal,version_id,record_id));
    CREATE INDEX scope_record_points ON scope_members(intake_id,record_id,latest,group_ordinal);`);
  let visited = 0;
  const has = (id: string) =>
    !!sql.prepare('SELECT 1 FROM scope_indices WHERE intake_id=?').get(id);
  return {
    async prepare(intakeId: string) {
      if (has(intakeId)) return;
      const source = db
        .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
        .get(intakeId);
      if (!source || !hasIntakeCollectionEnvelope(db, source as { id: string })) return;
      for (const member of ownershipIntakeScopeOccurrences(db, intakeId)) {
        if (member.latest)
          sql
            .prepare(
              'INSERT INTO scope_groups VALUES(?,?,?,?,?) ON CONFLICT(intake_id,group_ordinal) DO UPDATE SET version_id=excluded.version_id,subject_text=excluded.subject_text',
            )
            .run(intakeId, member.groupOrdinal, member.id, member.versionId, member.subjectText);
        if (member.recordId !== null)
          sql
            .prepare('INSERT OR IGNORE INTO scope_members VALUES(?,?,?,?,?,?,?)')
            .run(
              intakeId,
              member.groupOrdinal,
              member.id,
              member.versionId,
              member.recordId,
              Number(member.latest),
              member.subjectText,
            );
        if (++visited % 64 === 0) {
          assertCurrent();
          await setImmediate();
          assertCurrent();
        }
      }
      assertCurrent();
      sql.prepare('INSERT INTO scope_indices VALUES(?)').run(intakeId);
    },
    scopes(
      intakeId: string,
      recordId: string,
      options: {
        latestOnly?: boolean;
        exactGroups?: Pick<ReadonlySet<string>, 'has'>;
        subject?: boolean;
        version?: boolean;
      } = {},
    ) {
      if (!has(intakeId)) return ownershipIntakeScopes(db, intakeId, recordId, options);
      return (function* () {
        const rows = options.exactGroups
          ? sql
              .prepare(
                'SELECT group_id id,group_ordinal,version_id,subject_text FROM scope_groups WHERE intake_id=? ORDER BY group_ordinal',
              )
              .iterate(intakeId)
          : sql
              .prepare(
                'SELECT h.group_id id,h.group_ordinal,h.version_id,h.subject_text FROM scope_groups h WHERE h.intake_id=? AND EXISTS(SELECT 1 FROM scope_members m WHERE m.intake_id=h.intake_id AND m.group_ordinal=h.group_ordinal AND m.record_id=? AND (?=0 OR m.latest=1)) ORDER BY h.group_ordinal',
              )
              .iterate(intakeId, recordId, Number(!!options.latestOnly));
        for (const row of rows) {
          if (options.exactGroups && !options.exactGroups.has(String(row.id))) continue;
          yield {
            id: String(row.id),
            subjectText: options.subject === false ? '' : String(row.subject_text),
            ...(options.version ? { versionId: String(row.version_id) } : {}),
          };
        }
      })();
    },
    contributions(intakeId: string, recordId: string) {
      if (!has(intakeId)) return undefined;
      return Array.from(
        this.scopes(intakeId, recordId, { latestOnly: true, subject: false }),
        (group) => intakeId + ':' + group.id,
      );
    },
    contributionValues(intakeId: string, recordId: string) {
      if (!has(intakeId)) return undefined;
      const scopes = this.scopes(intakeId, recordId, { latestOnly: true, subject: false });
      return (function* () {
        for (const group of scopes) yield intakeId + ':' + group.id;
      })();
    },
    get work() {
      return { scopeOccurrences: visited };
    },
  };
}
export type OwnershipScopeIndex = ReturnType<typeof createOwnershipScopeIndex>;
