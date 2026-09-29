import { json, required, HttpError, now, type Database } from './database.ts';

// Appends a personal assertion inside the caller's transaction. Provider rows
// remain immutable; both public mutation routes share this version check.
export function appendMedicationPreference(db: Database, id: string, input: unknown) {
  if (
    !input ||
    typeof input !== 'object' ||
    !('status' in input) ||
    !(input.status === 'current' || input.status === 'not_current' || input.status === 'unknown') ||
    !('version' in input) ||
    typeof input.version !== 'number' ||
    !Number.isSafeInteger(input.version) ||
    input.version < 0
  )
    throw new HttpError(400, 'INVALID_INPUT', 'Supply a personal status and its current version');
  required(db.prepare('SELECT id FROM medications WHERE id=?').get(id), 'Medication not found');
  const current = db.prepare('SELECT * FROM medication_preferences WHERE medication_id=?').get(id);
  if ((current?.version ?? 0) !== input.version)
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'Personal medication status changed since you opened it. Reload before saving.',
    );
  const updated = now();
  const assertion = {
    source: 'personal_confirmation',
    actor: 'Profile owner',
    recordedAt: updated,
    statement: {
      current: 'Currently taking',
      not_current: 'Not currently taking',
      unknown: 'Current use not confirmed',
    }[input.status],
    scope: 'this medication record',
    ...(current
      ? {
          previousAssertion: json(current.assertion_json),
          previousStatus: current.status,
          previousUpdatedAt: current.updated_at,
        }
      : {}),
  };
  db.prepare(
    'INSERT INTO medication_preferences(medication_id,status,version,updated_at,assertion_json) VALUES(?,?,?,?,?) ON CONFLICT(medication_id) DO UPDATE SET status=excluded.status,version=excluded.version,updated_at=excluded.updated_at,assertion_json=excluded.assertion_json',
  ).run(id, input.status, input.version + 1, updated, JSON.stringify(assertion));
}

// New accepted prescriptions begin inactive until the profile owner turns one on.
// This is a system default, not a personal confirmation. INSERT OR IGNORE keeps
// repeated delivery and cache rebuild idempotent: an existing choice always wins.
export function appendImportedMedicationDefault(db: Database, id: string) {
  const updated = now();
  db.prepare(
    'INSERT OR IGNORE INTO medication_preferences(medication_id,status,version,updated_at,assertion_json) VALUES(?,?,?,?,?)',
  ).run(
    id,
    'not_current',
    1,
    updated,
    JSON.stringify({
      source: 'system_default',
      actor: 'Circus Health',
      recordedAt: updated,
      statement: 'Inactive until the profile owner turns it on',
      scope: 'this medication record',
    }),
  );
}

// Backwards-compatible no-op guard while onboarding is simplified. Inactive is
// already safe; completing setup no longer requires one assertion per record.
export function requireMedicationSetupReview(db: Database) {
  return db.prepare("SELECT count(*) AS total FROM medications WHERE person_id='patient'").get()!
    .total as number;
}
