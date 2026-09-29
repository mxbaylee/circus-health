import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './database.ts';

/**
 * The source-text state an intake's proposals are pinned to. It lives in its own
 * durable record rather than the intake row, so each material source revision
 * journals this record instead of the intake's proposals and history (CRS-117).
 * `version` counts those revisions; the intake's public version is the row's
 * version plus this count, so stale tabs still conflict after a source change.
 */
export interface IntakeSourcePin {
  revisionId: string | null;
  dependencyToken: string | null;
  requiresInterpretation: boolean;
  version: number;
}
interface PinnedDetails {
  version: number;
  sourceTextRevisionId?: string | null;
  sourceTextDependencyToken?: string | null;
  sourceTextRequiresInterpretation?: boolean;
}
const FIELDS = [
  'sourceTextRevisionId',
  'sourceTextDependencyToken',
  'sourceTextRequiresInterpretation',
] as const;

export const intakeSourcePinKey = (intakeId: string) => `intake_source_pin:v1:${intakeId}`;

function corrupt(): never {
  throw new HttpError(
    409,
    'SOURCE_TEXT_INTEGRITY',
    'Retained source text is missing or inconsistent; recover the profile before continuing',
  );
}
const nullableString = (value: unknown) => value === null || typeof value === 'string';

/** Parse a stored pin; `null` means the intake predates CRS-117 or has no source revision yet. */
export function parseIntakeSourcePin(raw: unknown): IntakeSourcePin | null {
  if (raw == null) return null;
  let value: unknown;
  try {
    value = JSON.parse(String(raw));
  } catch {
    return corrupt();
  }
  const pin = value as IntakeSourcePin;
  if (
    !pin ||
    typeof pin !== 'object' ||
    !nullableString(pin.revisionId) ||
    !nullableString(pin.dependencyToken) ||
    typeof pin.requiresInterpretation !== 'boolean' ||
    !Number.isSafeInteger(pin.version) ||
    pin.version < 1
  )
    corrupt();
  return pin;
}
export function readIntakeSourcePin(db: DatabaseSync, intakeId: string): IntakeSourcePin | null {
  return parseIntakeSourcePin(
    db.prepare('SELECT value FROM app_meta WHERE key=?').get(intakeSourcePinKey(intakeId))?.value,
  );
}
export function writeIntakeSourcePin(db: DatabaseSync, intakeId: string, pin: IntakeSourcePin) {
  db.prepare(
    'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(intakeSourcePinKey(intakeId), JSON.stringify(pin));
}

/** Intake details as readers see them: the pin, when present, replaces the row's pin fields. */
export function withIntakeSourcePin<T extends PinnedDetails>(
  details: T,
  pin: IntakeSourcePin | null,
): T {
  if (!pin) return details;
  return {
    ...details,
    sourceTextRevisionId: pin.revisionId,
    sourceTextDependencyToken: pin.dependencyToken,
    sourceTextRequiresInterpretation:
      pin.requiresInterpretation || !!details.sourceTextRequiresInterpretation,
    version: details.version + pin.version,
  };
}

/**
 * Details to write back to the intake row after an edit made on the pinned view.
 * The row keeps the pin fields it already held, so an edit never copies pin state
 * back into the row or disturbs readers comparing raw rows.
 */
export function withoutIntakeSourcePin<T extends PinnedDetails>(
  details: T,
  stored: Partial<PinnedDetails>,
  pin: IntakeSourcePin | null,
): T {
  if (!pin) return details;
  const row: T = { ...details, version: details.version - pin.version };
  for (const field of FIELDS) {
    if (field in stored) (row as Record<string, unknown>)[field] = stored[field];
    else delete (row as Record<string, unknown>)[field];
  }
  return row;
}
