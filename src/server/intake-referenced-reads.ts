/** GET readers for a referenced V3 source row. The synchronous intake readers
 * classify `details_json` and refuse a V3 descriptor as unsupported authority;
 * a V3 row is instead read under one complete accepted selected-source proof,
 * and every presented source fact comes from that proof. Selections outside
 * the accepted scope (review sessions, reader coverage) are left out or
 * refused explicitly rather than read from SQL. */
import { HttpError, type Database } from './database.ts';
import { withAcceptedNativeIntakeSourceFormat } from './intake-accepted-source-format.ts';
import {
  captureReferencedEnvelopeReadFromFormat,
  closeReferencedEnvelopeRead,
  referencedEnvelopeCurrentSelection,
  referencedEnvelopeCurrentSourceFacts,
  type ReferencedEnvelopeRead,
} from './intake-referenced-envelope-access.ts';
import {
  collectionReferencedIntakeSummary,
  collectionReferencedPackageFailures,
} from './intake-summary.ts';
import { assertIntakeOwner, intakeDurability, intakeLiteralWindow } from './intake.ts';
import { getIntakeSourceIssues, getIntakeSourceText } from './intake-source-text.ts';
import { getIntakeSourceExtractionFailure } from './intake-source-extraction-operation.ts';
import { profileOriginal } from './profile-storage.ts';
import type { IntakeSummaryV3 } from '../shared/intake-summary.ts';

/** Routing hint only: selects which reader a GET uses, never authorizes. */
export function referencedIntakeRowHint(db: Database, id: string): boolean {
  return String(
    db
      .prepare(
        "SELECT substr(details_json,1,96) AS prefix FROM main.source_files WHERE id=? AND kind='intake_original'",
      )
      .get(id)?.prefix ?? '',
  ).startsWith('{"intakeAuthority":{"format":"health-intake-envelope-v3"');
}

export type AcceptedIntakeRead<T> = { format: 'legacy' } | { format: 'referenced'; value: T };

/** One complete accepted proof. A legacy result means the routing hint was
 * stale: the caller then takes its existing (prepared) legacy reader. */
export async function withReferencedIntakeRead<T>(
  db: Database,
  profileId: string,
  id: string,
  assertRunning: () => void,
  read: (scope: ReferencedEnvelopeRead, assertCurrent: () => void) => Promise<T>,
): Promise<AcceptedIntakeRead<T>> {
  assertIntakeOwner(db, profileId);
  return withAcceptedNativeIntakeSourceFormat(
    db,
    profileId,
    id,
    assertRunning,
    async (format): Promise<AcceptedIntakeRead<T>> => {
      if (format.format === 'legacy') return { format: 'legacy' };
      const scope = await captureReferencedEnvelopeReadFromFormat(
        db,
        format,
        assertRunning,
        'current',
      );
      try {
        const assertCurrent = () => {
          assertRunning();
          format.assertCurrent();
          referencedEnvelopeCurrentSelection(scope);
        };
        assertCurrent();
        const value = await read(scope, assertCurrent);
        assertCurrent();
        return { format: 'referenced', value };
      } finally {
        closeReferencedEnvelopeRead(scope);
      }
    },
    true,
  );
}

export function referencedIntakeSummary(
  db: Database,
  scope: ReferencedEnvelopeRead,
): Promise<IntakeSummaryV3> {
  return collectionReferencedIntakeSummary(scope, intakeDurability(db));
}

/** The literal original window, bound to the accepted path, size, hash and
 * MIME type rather than to the unproven SQL columns. */
export async function referencedIntakeLiteralRead(
  db: Database,
  root: string,
  profileId: string,
  scope: ReferencedEnvelopeRead,
  assertCurrent: () => void,
  window: { offset?: number; limit?: number },
) {
  const intake = await referencedIntakeSummary(db, scope);
  const selected = referencedEnvelopeCurrentSelection(scope);
  const facts = await referencedEnvelopeCurrentSourceFacts(scope);
  if (facts.path.kind !== 'value')
    throw new HttpError(409, 'SOURCE_CHANGED', 'The retained original path is unavailable');
  assertCurrent();
  const literal = intakeLiteralWindow(
    profileOriginal(root, facts.path.value, profileId),
    { bytes: facts.bytes, sha256: selected.identity.sourceHash },
    facts.mimeType.kind === 'value' ? facts.mimeType.value : null,
    window,
  );
  assertCurrent();
  return { intake, ...literal };
}

/** Source text belongs to the exact accepted original hash. */
function assertAcceptedSourceHash(scope: ReferencedEnvelopeRead, sourceHash: string) {
  if (referencedEnvelopeCurrentSelection(scope).identity.sourceHash !== sourceHash)
    throw new HttpError(409, 'SOURCE_CHANGED', 'Reload the retained source');
}

export async function referencedIntakeSourceText(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  scope: ReferencedEnvelopeRead,
  assertCurrent: () => void,
  revisionId: string | undefined,
) {
  const sourceHash = referencedEnvelopeCurrentSelection(scope).identity.sourceHash;
  const current = db
    .prepare("SELECT sha256 FROM main.source_files WHERE id=? AND kind='intake_original'")
    .get(id)?.sha256;
  if (current !== sourceHash) assertAcceptedSourceHash(scope, String(current));
  const text = getIntakeSourceText(db, root, profileId, id, revisionId);
  assertCurrent();
  return text;
}

/** Reader coverage is built from selected plan rows outside the accepted
 * scope, so a referenced source omits it (the field is optional). */
export async function referencedIntakeSourceIssues(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  scope: ReferencedEnvelopeRead,
  assertCurrent: () => void,
  options: { revisionId?: string; offset: number; limit: number },
) {
  const response = getIntakeSourceIssues(db, root, profileId, id, options);
  assertAcceptedSourceHash(scope, response.sourceHash);
  const extractionFailure = getIntakeSourceExtractionFailure(
    db,
    profileId,
    id,
    response.sourceHash,
  );
  assertCurrent();
  return { ...response, extractionFailure };
}

export function referencedIntakePackageFailures(
  scope: ReferencedEnvelopeRead,
  options: { cursor?: string; limit?: number },
) {
  return collectionReferencedPackageFailures(scope, options);
}

/** The clinical review session reads selections outside the accepted scope
 * (mapping rules, proposal records, ownership indexes) through the synchronous
 * selected-envelope authority, which cannot certify a V3 descriptor. */
export function referencedIntakeReviewUnavailable(): never {
  throw new HttpError(
    409,
    'INTAKE_REVIEW_UNAVAILABLE',
    'Clinical review is not available for this file yet. Its original and source text remain readable.',
  );
}
