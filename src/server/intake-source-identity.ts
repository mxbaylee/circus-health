import { createHash } from 'node:crypto';
import type { IntakeEntry } from './intake-format.ts';

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Persisted v1 domains are deliberately different. Clinical keys recognize an
 * issuing source across deliveries; candidate keys pin one delivery/report's
 * review history. Keep both byte-for-byte stable until a versioned migration
 * defines equivalence for whitespace, originals, member and subject scopes. */
export const INTAKE_SOURCE_IDENTITY_VERSION = 1 as const;

export function clinicalSourceIdentityV1(
  entry: Pick<IntakeEntry, 'value'>,
  file: { sha256: string },
): string {
  const p = entry.value.provenance;
  const sourceSystem = p.sourceSystem?.trim(),
    sourceRecordId = p.sourceRecordId?.trim();
  return sourceSystem && sourceRecordId
    ? digest(['origin', sourceSystem, sourceRecordId])
    : digest(['original', file.sha256, p.locator, entry.value.id]);
}

export function candidateSourceIdentityV1(
  file: { id: string; sha256: string },
  entry: Pick<IntakeEntry, 'value'>,
): string {
  const p = entry.value.provenance;
  const identity =
    p.sourceSystem && p.sourceRecordId
      ? ['source', p.sourceSystem, p.sourceRecordId]
      : ['original', file.sha256, p.locator, entry.value.id];
  const reportScope = entry.value.report
    ? [entry.value.report.memberId || null, entry.value.report.subject]
    : null;
  return (
    'candidate:' + digest(reportScope ? [file.id, identity, reportScope] : [file.id, identity])
  );
}
