import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IntakePackageFailure } from '../shared/intake.ts';
import { HttpError } from './database.ts';
import { getIntake, workflowMutation } from './intake.ts';

export interface IntakePackageFailureInput {
  operationKey: string;
  memberId?: string;
  ordinal?: number;
  filename?: string;
  locator?: string;
  reasonCode: string;
  detail: string;
  retryAction?: IntakePackageFailure['retryAction'];
}

function operationKey(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\x00-\x1f\x7f]/.test(value))
    throw new HttpError(400, 'PACKAGE_FAILURE_SCOPE', 'Use a bounded package operation key');
  return value;
}

/** Worker diagnostics are not authority for filesystem paths, URLs or stack traces. */
export function sanitizePackageFailureDetail(value: string): string {
  return (
    String(value)
      .slice(0, 4096)
      .split('\n')
      .filter((line) => !/^\s*at\s/.test(line))
      .join(' ')
      .replace(/\b[a-z][a-z\d+.-]*:\/\/\S+/gi, '[address]')
      .replace(/(^|[\s('"])(?:[A-Z]:\\|\/)[^\s'"<>]*/gi, '$1[path]')
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500) || 'Package processing could not finish. The original remains retained.'
  );
}

function failureKey(sourceHash: string, key: string): string {
  return createHash('sha256')
    .update(JSON.stringify([sourceHash, key]))
    .digest('hex');
}

function validateLocation(input: IntakePackageFailureInput): void {
  // The inspector admits 2,000 Unicode code points, including astral names.
  // Preserve those exact names; UTF-16 storage needs up to twice that length.
  for (const [name, maximum] of [
    ['memberId', 200],
    ['filename', 4000],
    ['locator', 4200],
  ] as const) {
    const value = input[name];
    if (value !== undefined && (typeof value !== 'string' || !value || value.length > maximum))
      throw new HttpError(400, 'PACKAGE_FAILURE_SCOPE', 'Use an exact bounded package location');
  }
  if (input.ordinal !== undefined && (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0))
    throw new HttpError(400, 'PACKAGE_FAILURE_SCOPE', 'Use an exact package member ordinal');
  if (typeof input.reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(input.reasonCode))
    throw new HttpError(400, 'PACKAGE_FAILURE_REASON', 'Use a package processing reason code');
  if (
    input.retryAction !== undefined &&
    !['inventory', 'read_member', 'read_structure'].includes(input.retryAction)
  )
    throw new HttpError(400, 'PACKAGE_FAILURE_SCOPE', 'Use a supported package retry action');
}

/** Store only the changed pending scope in the existing selected intake journal. */
export function recordIntakePackageFailure(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: IntakePackageFailureInput,
) {
  const key = operationKey(input.operationKey);
  validateLocation(input);
  const intake = getIntake(db, root, profileId, id);
  const failure: IntakePackageFailure = {
    sourceFileId: intake.id,
    sourceHash: intake.sha256,
    operationKey: key,
    originalFilename: intake.filename,
    contentUrl: intake.contentUrl,
    ...(input.memberId === undefined ? {} : { memberId: input.memberId }),
    ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
    ...(input.filename === undefined ? {} : { filename: input.filename }),
    ...(input.locator === undefined ? {} : { locator: input.locator }),
    reasonCode: input.reasonCode,
    detail: sanitizePackageFailureDetail(input.detail),
    status: 'pending',
    scope: 'incomplete',
    retryAction:
      input.retryAction ||
      (key === 'inventory'
        ? 'inventory'
        : key.startsWith('structure:')
          ? 'read_structure'
          : 'read_member'),
  };
  const slot = failureKey(intake.sha256, key);
  if (JSON.stringify(intake.packageFailures?.[slot]) === JSON.stringify(failure)) return intake;
  // Do not add a growing workflow.operations history for transient retries.
  // The selected authority itself retains the bounded per-key change receipt.
  return workflowMutation(
    db,
    root,
    profileId,
    id,
    { version: intake.version },
    (_workflow, _file, details) => {
      details.packageFailures ??= {};
      details.packageFailures[slot] = failure;
    },
  );
}

/** A successful operation clears only its own pending scope on the same original. */
export function resolveIntakePackageFailure(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: { operationKey: string },
) {
  const key = operationKey(input.operationKey);
  const intake = getIntake(db, root, profileId, id);
  const slot = failureKey(intake.sha256, key);
  const pending = intake.packageFailures?.[slot];
  if (
    !pending ||
    pending.sourceFileId !== intake.id ||
    pending.sourceHash !== intake.sha256 ||
    pending.operationKey !== key
  )
    return intake;
  return workflowMutation(
    db,
    root,
    profileId,
    id,
    { version: intake.version },
    (_workflow, _file, details) => {
      delete details.packageFailures![slot];
    },
  );
}
