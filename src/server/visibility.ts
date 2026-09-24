import { appendMedicationPreference } from './medication-preferences.ts';
import { randomUUID } from 'node:crypto';
import {
  HttpError,
  required,
  now,
  transaction,
  databaseSchemaVersion,
  type Database,
} from './database.ts';
const tables = {
  note: 'notes',
  person: 'people',
  document: 'documents',
  medication: 'medications',
  procedure: 'procedures',
  observation: 'observations',
  test_type: 'test_types',
  source: 'source_records',
  source_file: 'source_files',
} as const;
type VisibilityKind = keyof typeof tables;
interface VisibilityTarget {
  type: VisibilityKind;
  id: string;
  legacy: boolean;
  protected: boolean;
}
// These rows come only from the version-6 visibility_events schema.
interface VisibilityRow {
  id: string;
  archived: number;
  version: number;
  createdAt: string;
  actor: string;
}
// Note links to a Person and person links share one visibility identity.
export function visibilityTarget(db: Database, type: string, id: string): VisibilityTarget {
  if (!Object.hasOwn(tables, type))
    throw new HttpError(400, 'INVALID_INPUT', 'Unsupported visibility target');
  const row = required(
    db.prepare(`SELECT * FROM ${tables[type as VisibilityKind]} WHERE id=?`).get(id),
    'Record not found',
  );
  if (type === 'note' && row.kind === 'person')
    return visibilityTarget(db, 'person', row.person_id as string);
  const legacy =
    type === 'note'
      ? row.archived
      : type === 'person'
        ? db.prepare('SELECT archived FROM notes WHERE person_id=?').get(id)?.archived
        : 0;
  return {
    type: type as VisibilityKind,
    id,
    legacy: Boolean(legacy),
    protected: type === 'person' && id === 'patient',
  };
}
export function visibilityState(db: Database, type: string, id: string) {
  const target = visibilityTarget(db, type, id);
  const history =
    databaseSchemaVersion(db) < 6
      ? []
      : db
          .prepare(
            'SELECT id,archived,version,created_at AS createdAt,actor FROM visibility_events WHERE target_type=? AND target_id=? ORDER BY version DESC',
          )
          .all(target.type, target.id)
          .map((value) => {
            const row = value as unknown as VisibilityRow;
            return { ...row, archived: Boolean(row.archived) };
          });
  return {
    ...(target.type === 'medication'
      ? {
          currentStatusVersion:
            db.prepare('SELECT version FROM medication_preferences WHERE medication_id=?').get(id)
              ?.version ?? 0,
        }
      : {}),
    targetType: target.type,
    targetId: target.id,
    archived: target.protected ? false : (history[0]?.archived ?? target.legacy),
    version: history[0]?.version ?? 0,
    protected: target.protected,
    history,
  };
}
export function appendVisibilityEvent(db: Database, type: string, id: string, input: unknown) {
  if (
    !input ||
    typeof input !== 'object' ||
    !('archived' in input) ||
    !('version' in input) ||
    typeof input.version !== 'number' ||
    Object.keys(input).some((key) => !['archived', 'version'].includes(key)) ||
    typeof input.archived !== 'boolean' ||
    !Number.isSafeInteger(input.version) ||
    input.version < 0
  )
    throw new HttpError(400, 'INVALID_INPUT', 'Supply archived and the current visibility version');
  const current = visibilityState(db, type, id);
  if (current.protected) throw new HttpError(400, 'SELF_PROFILE', 'Self cannot be archived');
  if (current.version !== input.version)
    throw new HttpError(409, 'VERSION_CONFLICT', 'Visibility changed. Reload before trying again.');
  if (current.archived === input.archived) return current;
  db.prepare('INSERT INTO visibility_events VALUES(?,?,?,?,?,?,?)').run(
    `visibility:${randomUUID()}`,
    current.targetType,
    current.targetId,
    Number(input.archived),
    current.version + 1,
    now(),
    'Profile owner',
  );
  return visibilityState(db, type, id);
}
export function setVisibility(db: Database, type: string, id: string, input: unknown) {
  return transaction(db, () => {
    if (type === 'medication') {
      if (
        !input ||
        typeof input !== 'object' ||
        !('archived' in input) ||
        Object.keys(input).some(
          (key) => !['archived', 'version', 'currentStatusVersion'].includes(key),
        ) ||
        typeof input.archived !== 'boolean'
      )
        throw new HttpError(400, 'INVALID_INPUT', 'Supply archived and both current versions');
      appendMedicationPreference(db, id, {
        status: input.archived ? 'not_current' : 'current',
        version: 'currentStatusVersion' in input ? input.currentStatusVersion : undefined,
      });
      return appendVisibilityEvent(db, type, id, {
        archived: input.archived,
        version: 'version' in input ? input.version : undefined,
      });
    }
    return appendVisibilityEvent(db, type, id, input);
  });
}
// SQL expressions accept only internal, static identifiers, never request text.
export const visibilitySQL = (type: string, id: string, legacy = '0') =>
  `COALESCE((SELECT ve.archived FROM visibility_events ve WHERE ve.target_type=${type} AND ve.target_id=${id} ORDER BY ve.version DESC LIMIT 1),${legacy})`;
export const noteVisibilitySQL = (alias = 'notes') =>
  `CASE WHEN ${alias}.person_id='patient' THEN 0 ELSE ${visibilitySQL(`CASE WHEN ${alias}.kind='person' THEN 'person' ELSE 'note' END`, `CASE WHEN ${alias}.kind='person' THEN ${alias}.person_id ELSE ${alias}.id END`, `${alias}.archived`)} END`;
export function visibilityCondition(params: URLSearchParams, expression: string) {
  const value =
    params.get('visibility') || (params.get('archived') === '1' ? 'archived' : 'visible');
  if (!['visible', 'archived', 'all'].includes(value))
    throw new HttpError(400, 'INVALID_INPUT', 'Choose visible, archived, or all');
  return value === 'all' ? '1=1' : `${expression}=${value === 'archived' ? 1 : 0}`;
}
