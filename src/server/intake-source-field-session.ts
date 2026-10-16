import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  IntakeSourceFieldFragmentV1,
  IntakeSourceFieldReferenceV1,
} from '../shared/intake-summary.ts';
import { HttpError } from './database.ts';
import {
  openAcceptedIntakeSourceColumn,
  type AcceptedIntakeSourceColumnScope,
} from './intake-accepted-source-column.ts';

const MAX_SESSIONS = 4;
const IDLE_MILLISECONDS = 60_000;
const sessions = new Map<DatabaseSync, Map<string, FieldSession>>();
const pendingOpens = new WeakMap<DatabaseSync, number>();
const generations = new WeakMap<DatabaseSync, number>();

interface FieldSession {
  profileId: string;
  sessionBinding: string;
  reference: IntakeSourceFieldReferenceV1;
  scope: AcceptedIntakeSourceColumnScope;
  ordinal: number;
  timer?: NodeJS.Timeout;
}

export interface IntakeSourceFieldFragmentInput {
  reference: IntakeSourceFieldReferenceV1;
  cursor?: string;
  bytes?: number;
  release?: true;
}

function badRequest(): never {
  throw new HttpError(400, 'INTAKE_SOURCE_FIELD_WINDOW', 'Use a current source field reference');
}

function unavailable(): never {
  throw new HttpError(409, 'INTAKE_SOURCE_FIELD_CHANGED', 'Source field read is no longer current');
}

function validReference(value: unknown): value is IntakeSourceFieldReferenceV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const reference = value as Partial<IntakeSourceFieldReferenceV1>;
  return (
    reference.format === 'health-intake-source-field-reference-v1' &&
    typeof reference.intakeId === 'string' &&
    typeof reference.sourceHash === 'string' &&
    typeof reference.sourceVersionId === 'string' &&
    (reference.field === 'mimeType' || reference.field === 'providerId') &&
    Number.isSafeInteger(reference.bytes) &&
    Number(reference.bytes) >= 0 &&
    typeof reference.scalarHash === 'string' &&
    /^[a-f0-9]{64}$/.test(reference.scalarHash)
  );
}

function sameReference(a: IntakeSourceFieldReferenceV1, b: IntakeSourceFieldReferenceV1): boolean {
  return (
    a.format === b.format &&
    a.intakeId === b.intakeId &&
    a.sourceHash === b.sourceHash &&
    a.sourceVersionId === b.sourceVersionId &&
    a.field === b.field &&
    a.bytes === b.bytes &&
    a.scalarHash === b.scalarHash
  );
}

function release(db: DatabaseSync, token: string): void {
  const entries = sessions.get(db);
  const held = entries?.get(token);
  if (!held) return;
  entries!.delete(token);
  if (held.timer) clearTimeout(held.timer);
  try {
    held.scope.close();
  } finally {
    if (!entries!.size) sessions.delete(db);
  }
}

function schedule(db: DatabaseSync, token: string, held: FieldSession): void {
  if (held.timer) clearTimeout(held.timer);
  held.timer = setTimeout(() => {
    try {
      release(db, token);
    } catch {
      // The next request still has to acquire a new accepted read scope.
    }
  }, IDLE_MILLISECONDS);
  held.timer.unref();
}

export function clearIntakeSourceFieldSessions(db: DatabaseSync): void {
  generations.set(db, (generations.get(db) ?? 0) + 1);
  const entries = sessions.get(db);
  if (!entries) return;
  let failure: unknown;
  for (const token of [...entries.keys()]) {
    try {
      release(db, token);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

export async function readIntakeSourceFieldFragment(
  db: DatabaseSync,
  profileId: string,
  intakeId: string,
  sessionBinding: string,
  input: IntakeSourceFieldFragmentInput,
  assertRunning: () => void,
): Promise<IntakeSourceFieldFragmentV1> {
  assertRunning();
  if (!input || !validReference(input.reference) || input.reference.intakeId !== intakeId)
    badRequest();
  if (input.release !== undefined && input.release !== true) badRequest();
  if (input.release && input.cursor === undefined) badRequest();
  const limit = input.bytes ?? 16 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 4 || limit > 16 * 1024) badRequest();
  const entries = sessions.get(db);
  let token: string;
  let held: FieldSession;
  if (input.cursor === undefined) {
    const reference: IntakeSourceFieldReferenceV1 = Object.freeze({
      format: input.reference.format,
      intakeId: input.reference.intakeId,
      sourceHash: input.reference.sourceHash,
      sourceVersionId: input.reference.sourceVersionId,
      field: input.reference.field,
      bytes: input.reference.bytes,
      scalarHash: input.reference.scalarHash,
    });
    for (const [prior, active] of sessions.get(db) ?? [])
      if (
        active.profileId === profileId &&
        active.sessionBinding === sessionBinding &&
        sameReference(active.reference, reference)
      )
        release(db, prior);
    const pending = pendingOpens.get(db) ?? 0;
    if ((entries?.size ?? 0) + pending >= MAX_SESSIONS)
      throw new HttpError(429, 'INTAKE_SOURCE_FIELD_BUSY', 'Finish an open source field read');
    pendingOpens.set(db, pending + 1);
    const generation = generations.get(db) ?? 0;
    let scope: AcceptedIntakeSourceColumnScope | null;
    try {
      scope = await openAcceptedIntakeSourceColumn(
        db,
        { profileId, intakeId, sourceHash: reference.sourceHash },
        reference.sourceVersionId,
        reference.field === 'mimeType' ? 'mime_type' : 'provider_id',
        assertRunning,
      );
    } finally {
      pendingOpens.set(db, (pendingOpens.get(db) ?? 1) - 1);
    }
    if (generation !== (generations.get(db) ?? 0)) {
      scope?.close();
      unavailable();
    }
    if (!scope || scope.bytes !== reference.bytes || scope.hash !== reference.scalarHash) {
      scope?.close();
      unavailable();
    }
    try {
      token = randomBytes(24).toString('base64url');
      held = { profileId, sessionBinding, reference, scope, ordinal: 0 };
      const current = sessions.get(db) ?? new Map<string, FieldSession>();
      sessions.set(db, current);
      current.set(token, held);
    } catch (error) {
      scope.close();
      throw error;
    }
  } else {
    if (typeof input.cursor !== 'string') badRequest();
    const cursor = /^([A-Za-z0-9_-]{32})\.([0-9]+)$/.exec(input.cursor);
    if (!cursor || !Number.isSafeInteger(Number(cursor[2]))) badRequest();
    token = cursor[1]!;
    const found = entries?.get(token);
    if (!found || Number(cursor[2]) !== found.ordinal) unavailable();
    held = found;
    if (
      held.profileId !== profileId ||
      held.sessionBinding !== sessionBinding ||
      !sameReference(held.reference, input.reference)
    )
      unavailable();
  }
  if (input.release) {
    assertRunning();
    release(db, token);
    return {
      format: 'health-intake-source-field-fragment-v1',
      reference: held.reference,
      text: '',
      complete: true,
      nextCursor: null,
    };
  }
  try {
    assertRunning();
    const page = held.scope.page(held.ordinal, limit, assertRunning);
    assertRunning();
    held.ordinal = page.nextOrdinal ?? held.ordinal;
    if (page.complete) release(db, token);
    else schedule(db, token, held);
    return {
      format: 'health-intake-source-field-fragment-v1',
      reference: held.reference,
      text: page.text,
      complete: page.complete,
      nextCursor: page.complete ? null : `${token}.${page.nextOrdinal}`,
    };
  } catch (error) {
    try {
      release(db, token);
    } catch {
      // Keep the original page refusal as the response reason.
    }
    throw error;
  }
}
