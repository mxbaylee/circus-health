import type { DatabaseSync } from 'node:sqlite';
import { json } from './database.ts';

export const clinicalTables = {
  observation: 'observations',
  medication: 'medications',
  procedure: 'procedures',
  document: 'documents',
} as const;
export type ClinicalKind = keyof typeof clinicalTables;

interface ClinicalTransition {
  fromKind: ClinicalKind;
  toKind: ClinicalKind;
}

const isClinicalKind = (value: unknown): value is ClinicalKind =>
  typeof value === 'string' && Object.hasOwn(clinicalTables, value);

function isClinicalTransition(value: unknown): value is ClinicalTransition {
  return (
    typeof value === 'object' &&
    value !== null &&
    isClinicalKind(Reflect.get(value, 'fromKind')) &&
    isClinicalKind(Reflect.get(value, 'toKind'))
  );
}

function storedClinicalTransition(value: unknown): ClinicalTransition {
  if (!isClinicalTransition(value)) throw new Error('Invalid stored clinical transition');
  return value;
}

function clinicalTransitions(db: DatabaseSync, recordId: string): ClinicalTransition[] {
  return db
    .prepare(
      "SELECT json_extract(coverage_json,'$.recordException.reclassification') AS transition FROM manual_batches WHERE title='Import record exception' AND json_extract(coverage_json,'$.recordException.reclassification.recordId')=? ORDER BY json_extract(coverage_json,'$.recordException.sequence')",
    )
    .all(recordId)
    .map((row) => storedClinicalTransition(json(row.transition)));
}

// Kind is a classification, not a new clinical identity. A journal proves which
// old references may follow the stable ID; unrelated missing IDs never resolve.
export function resolveClinicalReference(db: DatabaseSync, kind: unknown, recordId: string) {
  if (!isClinicalKind(kind)) return null;
  const seen = new Set<string>();
  let currentId = recordId;
  let currentKind = kind;
  for (let depth = 0; depth < 100; depth++) {
    if (seen.has(currentId)) return null;
    seen.add(currentId);
    const redirect = db
      .prepare(
        "SELECT json_extract(coverage_json,'$.destinationRecordId') id,json_extract(coverage_json,'$.kind') kind FROM manual_batches WHERE title='Record ownership redirect' AND json_extract(coverage_json,'$.recordId')=? ORDER BY json_extract(coverage_json,'$.revision') DESC,id DESC LIMIT 1",
      )
      .get(currentId);
    // Each identity keeps its own kind history. Resolve it before following the
    // ownership link; an older bookmark must not lose that evidence at the new ID.
    const transitions = clinicalTransitions(db, currentId);
    if (transitions.length) {
      if (!transitions.some((item) => item.fromKind === currentKind || item.toKind === currentKind))
        return null;
      currentKind = transitions.at(-1)!.toKind;
    }
    if (!redirect)
      return db.prepare(`SELECT 1 FROM ${clinicalTables[currentKind]} WHERE id=?`).get(currentId)
        ? {
            kind: currentKind,
            recordId: currentId,
            redirected: currentId !== recordId || currentKind !== kind,
          }
        : null;
    if (redirect.kind !== currentKind) return null;
    currentId = String(redirect.id);
  }
  return null;
}

export function clinicalReferenceKinds(db: DatabaseSync, kind: unknown, recordId: string) {
  if (!isClinicalKind(kind) || !resolveClinicalReference(db, kind, recordId)) return [];
  const transitions = clinicalTransitions(db, recordId);
  const kinds = new Set<ClinicalKind>([kind]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of transitions)
      if (kinds.has(item.fromKind) || kinds.has(item.toKind)) {
        for (const value of [item.fromKind, item.toKind])
          if (isClinicalKind(value) && !kinds.has(value)) {
            kinds.add(value);
            changed = true;
          }
      }
  }
  return [...kinds];
}
export function clinicalNavigation(kind: unknown, recordId: string) {
  const id = encodeURIComponent(recordId);
  const routes = {
    observation: { appUrl: `/tests?result=${id}&detail=1`, apiUrl: `/api/tests/${id}` },
    procedure: { appUrl: `/procedures?id=${id}`, apiUrl: `/api/procedures/${id}` },
    medication: { appUrl: `/medications?id=${id}`, apiUrl: `/api/medications/${id}` },
    document: { appUrl: `/sources?document=${id}`, apiUrl: `/api/documents/${id}` },
  };
  return isClinicalKind(kind) ? { kind, recordId, ...routes[kind] } : null;
}
// A redirect envelope is deliberately not a DTO of the old clinical kind.
export function clinicalRedirect(db: DatabaseSync, kind: unknown, recordId: string) {
  const resolved = resolveClinicalReference(db, kind, recordId);
  return resolved?.redirected
    ? {
        id: recordId,
        ...(resolved.recordId !== recordId ? { ownershipCorrected: true } : {}),
        reclassifiedTo: clinicalNavigation(resolved.kind, resolved.recordId),
      }
    : null;
}

/** Historical tuples stay immutable; current backlinks include links to explicitly joined identities. */
export function clinicalReferenceAliases(
  db: DatabaseSync,
  kind: unknown,
  recordId: string,
): string[][] {
  const resolved = resolveClinicalReference(db, kind, recordId);
  if (!resolved) return [];
  const ids = new Set([resolved.recordId]);
  const queue = [resolved.recordId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const row of db
      .prepare(
        "SELECT json_extract(coverage_json,'$.recordId') id FROM manual_batches WHERE title='Record ownership redirect' AND json_extract(coverage_json,'$.destinationRecordId')=?",
      )
      .iterate(id)) {
      const old = String(row.id);
      if (!ids.has(old)) {
        ids.add(old);
        queue.push(old);
      }
    }
  }
  return [...ids].flatMap((id) =>
    Object.keys(clinicalTables).flatMap((k) => {
      const alias = resolveClinicalReference(db, k, id);
      return alias?.recordId === resolved.recordId && alias.kind === resolved.kind ? [[k, id]] : [];
    }),
  );
}
