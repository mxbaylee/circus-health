import {
  validateIntakeStateCopySnapshot,
  type IntakeCopyOriginal,
  type IntakeStateCopySnapshot,
} from './intake-state-bootstrap.ts';
import { intakeSourcePinKey, parseIntakeSourcePin } from './intake-source-pin.ts';
import { DEFAULT_LIMITS, invalid } from './intake-state-evidence.ts';
import { validatePortableIntakeSourceText } from './intake-source-text.ts';

type Row = Record<string, unknown>;

/** Portable generations retain exact metadata strings; never infer authority from loose rows. */
export function validatePortableIntakeState(
  tables: Record<string, Row[]>,
  profileId: string,
): void {
  if (!Array.isArray(tables.app_meta) || !Array.isArray(tables.source_files))
    invalid('portable intake tables');
  const metadata = new Map<string, string>();
  let bytes = 0,
    count = 0;
  for (const row of tables.app_meta) {
    if (typeof row.key !== 'string' || typeof row.value !== 'string' || metadata.has(row.key))
      invalid('portable metadata inventory');
    if (row.key.startsWith('intake_state_') || row.key.startsWith('intake_source_pin:')) {
      bytes += Buffer.byteLength(row.key) + Buffer.byteLength(row.value);
      if (bytes > DEFAULT_LIMITS.bytes || ++count > 200_000)
        invalid('aggregate portable intake rows/bytes');
    }
    metadata.set(row.key, row.value);
  }
  if (metadata.get('owner_profile_id') !== profileId) invalid('portable intake owner');
  const snapshot: IntakeStateCopySnapshot = { sourceProfileId: profileId, originals: [], rows: [] };
  const originals = new Set<string>();
  for (const row of tables.source_files) {
    if (row.kind !== 'intake_original') continue;
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (bytes > DEFAULT_LIMITS.bytes || ++count > 200_000)
      invalid('aggregate portable intake rows/bytes');
    if (typeof row.id !== 'string' || originals.has(row.id)) invalid('portable original identity');
    originals.add(row.id);
    snapshot.originals.push({
      id: row.id,
      kind: row.kind,
      sha256: row.sha256,
      path: row.path,
      detailsJson: row.details_json,
      sourcePin: metadata.get(intakeSourcePinKey(row.id)) ?? null,
      preserved: {
        provider_id: row.provider_id,
        bytes: row.bytes,
        mime_type: row.mime_type,
        coverage_status: row.coverage_status,
        batch_id: row.batch_id,
      },
    } as IntakeCopyOriginal);
  }
  for (const [key, value] of metadata) {
    if (key.startsWith('intake_state_')) snapshot.rows.push({ key, value });
    if (key.startsWith('intake_source_pin:')) {
      const match = /^intake_source_pin:v1:(.+)$/.exec(key);
      if (!match || !originals.has(match[1])) invalid('unsupported portable source pin');
      parseIntakeSourcePin(value);
    }
  }
  validateIntakeStateCopySnapshot(snapshot);
  validatePortableIntakeSourceText(tables, profileId);
}
