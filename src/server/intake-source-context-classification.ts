import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { json } from './database.ts';
import { createTransactionOutcomeIssuer } from './transaction-observer-issuer.ts';
const outcomes = createTransactionOutcomeIssuer();
export const intakeSourceContextTerminalOutcome = outcomes.recognizes;
import { sourceContextEnvelope } from './clinical-import.ts';
import { MAX_INTAKE_BYTES, validateJSONL } from './intake-format.ts';
import { readIntakeFileSync, recordIntakeFileHash } from './intake-file-work.ts';
import { intakeCandidateVersionId } from './intake-workflow.ts';
import { profileOriginal } from './profile-storage.ts';
import type { IntakeDetails } from './intake-state-access.ts';
import type { IntakeValidation } from '../shared/intake.ts';

interface Source {
  id: string;
  kind?: string;
  path: string;
  sha256: string;
  bytes: number;
  details_json: string;
}
interface Classification {
  binding: string;
  versions: Set<string>;
}
interface Collection {
  binding: string;
  sources: Map<string, Classification>;
}
interface Scope {
  binding: string;
  collections: Map<string, Collection>;
  dispose: () => void;
}
// Retain one result per referenced source, including empty results. No global
// FIFO competes with other collections, and no source literals are retained.
const scopes = new WeakMap<DatabaseSync, Scope>();

export function clearSourceContextClassificationCache(db: DatabaseSync): void {
  scopes.get(db)?.dispose();
  scopes.delete(db);
}

function scoped(db: DatabaseSync, root: string, profileId: string): Scope {
  const binding = JSON.stringify([resolve(root), profileId]);
  let scope = scopes.get(db);
  if (scope?.binding !== binding) {
    clearSourceContextClassificationCache(db);
    scope = { binding, collections: new Map(), dispose: () => {} };
    const collections = scope.collections;
    scope.dispose = outcomes.observe(db, (outcome) => {
      if (!outcome.succeeded) collections.clear();
    });
    scopes.set(db, scope);
  }
  return scope;
}

function physicalIdentity(path: string): string {
  const stat = statSync(path, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

/** DTO fallback only. The caller first reads selected intake authority; explicit
 * source/review verification remains independent and must still refuse damage.
 * Physical identity is checked on every hit, as in verifyIntakeFileHash. */
export function cachedSourceContextVersions(
  db: DatabaseSync,
  root: string | null,
  profileId: string,
  file: Source,
  d: IntakeDetails,
): Set<string> {
  if (!db.isOpen) {
    clearSourceContextClassificationCache(db);
    throw Error('Source classification requires an open database');
  }
  if (!root) return new Set();
  const scope = scoped(db, root, profileId);
  const unresolved = new Set<string>(
    (d.workflow?.candidates || []).flatMap((candidate) =>
      candidate.versions.filter((version) => !version.sourceContext).map((version) => version.id),
    ),
  );
  if (!unresolved.size) {
    scope.collections.delete(file.id);
    return new Set();
  }
  const allowed = new Set<string>([file.id, ...(d.proposals || []).map((proposal) => proposal.id)]);
  const referenced = new Set<string>(
    d
      .workflow!.candidates.flatMap((candidate) => candidate.versions)
      .filter((version) => unresolved.has(version.id))
      .flatMap((version) => version.occurrences || [])
      .map((occurrence) => occurrence.proposalId || file.id)
      .filter((id) => allowed.has(id)),
  );
  const sourceIds = referenced.size ? referenced : allowed;
  const collectionBinding = JSON.stringify([
    file.id,
    file.kind,
    file.path,
    file.sha256,
    file.bytes,
  ]);
  let collection = scope.collections.get(file.id);
  if (collection?.binding !== collectionBinding) {
    collection = { binding: collectionBinding, sources: new Map() };
    scope.collections.set(file.id, collection);
  }
  for (const id of collection.sources.keys()) if (!sourceIds.has(id)) collection.sources.delete(id);
  const revisions = new Map<string, string | null>();
  for (const proposal of d.proposals || [])
    // Match intakeCandidateVersionId's first matching proposal exactly, including
    // unusual retained envelopes with a repeated proposal ID.
    if (!revisions.has(proposal.id))
      revisions.set(
        proposal.id,
        proposal.sourceTextDependencyToken || proposal.sourceTextRevisionId || null,
      );
  const contextVersions = new Set<string>();
  for (const sourceId of sourceIds) {
    const source =
      sourceId === file.id
        ? file
        : (db.prepare('SELECT * FROM source_files WHERE id=?').get(sourceId) as Source | undefined);
    const validation =
      sourceId === file.id
        ? d.validation
        : (json(source?.details_json) as { validation?: IntakeValidation } | null)?.validation;
    if (!source || !validation?.valid || source.bytes > MAX_INTAKE_BYTES) {
      collection.sources.delete(sourceId);
      continue;
    }
    try {
      // Resolve even warm hits: a copied path, profile escape, removed file or
      // changed inode/timestamps must never inherit an earlier classification.
      const path = profileOriginal(root, source.path, profileId);
      const physical = physicalIdentity(path);
      const revision = sourceId === file.id ? null : revisions.get(sourceId);
      const binding = JSON.stringify([
        source.id,
        source.kind,
        source.path,
        path,
        source.sha256,
        source.bytes,
        physical,
        revision,
      ]);
      let retained = collection.sources.get(sourceId);
      if (retained?.binding !== binding) {
        collection.sources.delete(sourceId);
        const bytes = readIntakeFileSync(path);
        recordIntakeFileHash(bytes);
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (
          bytes.length !== source.bytes ||
          hash !== source.sha256 ||
          physicalIdentity(path) !== physical
        )
          continue;
        const parsed = validateJSONL(bytes);
        if (!parsed.valid) continue;
        const versions = new Set<string>();
        for (const entry of parsed.entries)
          if (sourceContextEnvelope(entry.value))
            versions.add(
              intakeCandidateVersionId(d, sourceId === file.id ? null : sourceId, entry),
            );
        retained = { binding, versions };
        collection.sources.set(sourceId, retained);
      }
      for (const versionId of retained.versions)
        if (unresolved.has(versionId)) contextVersions.add(versionId);
    } catch {
      collection.sources.delete(sourceId);
      // DTO reads do not replace explicit source verification or review errors.
    }
  }
  return contextVersions;
}
