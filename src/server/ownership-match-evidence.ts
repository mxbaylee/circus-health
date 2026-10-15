/** A destination comparison's exact evidence is inspected and pinned one row at a time. */
import { createHash } from 'node:crypto';
import { json, HttpError, type Database } from './database.ts';
import type { ClinicalKind } from './clinical-references.ts';
import { verifyIntakeFileHash } from './intake-files.ts';
import { profileOriginal } from './profile-storage.ts';
import { canonicalLiteral } from './intake-format.ts';
import { iterateOwnershipStreamContributions } from './ownership-contribution-stream.ts';
import type { OwnershipPreviewSink } from './ownership-preview-store.ts';
import type { OwnershipScopeIndex } from './ownership-scope-index.ts';
export function* prepareOwnershipMatchEvidenceSteps(
  db: Database,
  root: string,
  profileId: string,
  kind: ClinicalKind,
  recordId: string,
  sink: OwnershipPreviewSink,
  scopes?: OwnershipScopeIndex,
) {
  const hash = createHash('sha256');
  let visited = 0;
  const verify = (id: string) => {
    const source = db.prepare('SELECT path,bytes,sha256 FROM source_files WHERE id=?').get(id);
    if (!source)
      throw new HttpError(409, 'DUPLICATE_EVIDENCE', 'The saved record original is unavailable');
    verifyIntakeFileHash(profileOriginal(root, source.path, profileId), {
      bytes: Number(source.bytes),
      sha256: String(source.sha256),
    });
  };
  for (const contribution of iterateOwnershipStreamContributions(db, kind, recordId, {
    scopes: scopes?.contributionValues.bind(scopes),
  })) {
    verify(String(contribution.source.source_file_id));
    verify(contribution.sourceFileId);
    hash.update(contribution.version);
    for (const scope of contribution.reportScopes()) {
      hash.update(JSON.stringify(scope));
      if (++visited % 32 === 0) yield;
    }
    if (++visited % 32 === 0) yield;
  }
  const values = function* () {
    for (const row of db
      .prepare(
        'SELECT s.*,e.locator_json AS evidence_locator,p.name AS acquiring_source FROM evidence e JOIN source_records s ON s.id=e.source_record_id LEFT JOIN providers p ON p.id=s.provider_id WHERE e.entity_type=? AND e.entity_id=? ORDER BY e.id',
      )
      .iterate(kind, recordId)) {
      const locator = json(row.evidence_locator, {}) as Record<string, unknown>,
        sourceLocator = json(row.locator_json, {}) as Record<string, unknown>,
        originalId = String(locator.originalSourceFileId || row.source_file_id || '');
      verify(originalId);
      const value = {
        label: typeof row.acquiring_source === 'string' ? row.acquiring_source : 'Original source',
        locator:
          typeof locator.locator === 'string'
            ? locator.locator
            : typeof sourceLocator.locator === 'string'
              ? sourceLocator.locator
              : typeof row.source_key === 'string'
                ? row.source_key
                : 'Retained record',
        sourceRecordId: String(row.id || ''),
        contentUrl: '/api/sources/' + encodeURIComponent(originalId) + '/content',
      };
      hash.update(canonicalLiteral({ ...value, original: json(row.raw_json) }));
      yield value;
    }
  };
  const reference = yield* sink.matchEvidenceSteps(kind, recordId, values());
  return { reference, digest: hash.digest('hex') };
}
export function prepareOwnershipMatchEvidence(
  ...args: Parameters<typeof prepareOwnershipMatchEvidenceSteps>
) {
  const steps = prepareOwnershipMatchEvidenceSteps(...args);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}
