import { randomUUID, createHash } from 'node:crypto';
import type { Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import { INTAKE_COMPACT_ENVELOPE_FORMAT } from './intake-authority.ts';
import { createIntakeStateStorage } from './intake-state-storage.ts';
import { parseSchemaControl } from './intake-envelope-schema.ts';
import { INTAKE_LEGACY_BRIDGE_CONTROL } from './intake-state-migration.ts';
import {
  currentClinicalOperation,
  assertClinicalOperation,
  runExclusiveClinicalOperation,
} from './clinical-operation.ts';
import { COMPACT_SCALAR_BYTES } from './intake-compact-scalar.ts';
import { ensureIntakeFrontierObserver } from './intake-lookup-frontier-observer.ts';

/** Cooperatively replace only certified presentation metadata, never evidence. */
export async function prepareIntakeCompactMetadata(
  db: Database,
  input: IntakeEnvelopeSource,
  options: { assertRunning?: () => void; assertPublicationCurrent?: () => void } = {},
): Promise<{ changed: boolean }> {
  const source = db
    .prepare(
      'SELECT id,kind,sha256,length(CAST(details_json AS BLOB)) AS metadataBytes,substr(details_json,1,128) AS metadataPrefix FROM main.source_files WHERE id=?',
    )
    .get(input.id);
  if (!source || source.kind !== 'intake_original' || typeof source.metadataPrefix !== 'string')
    return { changed: false };
  if (
    Number(source.metadataBytes) <= COMPACT_SCALAR_BYTES ||
    source.metadataPrefix.startsWith(
      '{"intakeAuthority":{"format":"' + INTAKE_COMPACT_ENVELOPE_FORMAT + '"',
    )
  )
    return { changed: false };
  return runExclusiveClinicalOperation(
    db,
    async (operation) => {
      ensureIntakeFrontierObserver(db);
      const profileId = db
        .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
        .get()?.value;
      if (typeof profileId !== 'string' || source.sha256 !== input.sha256)
        throw Error('Compact metadata source/profile changed');
      const assertRunning = () => {
        assertClinicalOperation(db, operation);
        options.assertRunning?.();
      };
      const assertPublicationCurrent = () => {
        assertClinicalOperation(db, operation);
        (options.assertPublicationCurrent ?? options.assertRunning)?.();
      };
      assertRunning();
      const collections = createIntakeStateStorage(db, {
        profileId,
        intakeId: input.id,
        sourceHash: source.sha256 as string,
      }).collections;
      const view = collections.openView(),
        head = collections.binding(view);
      if (!head) return { changed: false };
      const control = collections.get(view, 'logical', 'envelope.control', 'representation');
      if (control === undefined || control === INTAKE_LEGACY_BRIDGE_CONTROL)
        return { changed: false };
      parseSchemaControl(control);
      const operationId = randomUUID(),
        prepared = collections.prepare(view, {
          operationId,
          requestDigest: createHash('sha256').update(operationId).digest('hex'),
          domainVersion: head.logical.domainVersion,
          changes: [],
        });
      try {
        if (!(await collections.certifyCompactMetadataAsync(prepared, { assertRunning })))
          return { changed: false };
        assertRunning();
        collections.commitMaintenance(prepared, { assertCurrent: assertPublicationCurrent });
        return { changed: true };
      } finally {
        collections.disposePreparation(prepared);
      }
    },
    { operation: currentClinicalOperation(db), assertRunning: options.assertRunning },
  );
}
