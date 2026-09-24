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
  if (db.prepare(`SELECT 1 FROM ${clinicalTables[kind]} WHERE id=?`).get(recordId))
    return { kind, recordId, redirected: false };
  const transitions = clinicalTransitions(db, recordId);
  if (!transitions.some((item) => item.fromKind === kind || item.toKind === kind)) return null;
  const current = transitions.at(-1)?.toKind;
  return isClinicalKind(current) &&
    db.prepare(`SELECT 1 FROM ${clinicalTables[current]} WHERE id=?`).get(recordId)
    ? { kind: current, recordId, redirected: true }
    : null;
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
    ? { id: recordId, reclassifiedTo: clinicalNavigation(resolved.kind, recordId) }
    : null;
}
