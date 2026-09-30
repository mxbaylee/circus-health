import { appendOwnershipDecision } from './ownership-journal.ts';
import { createHash } from 'node:crypto';
import { json, now, revision, type Database } from './database.ts';
import {
  canonicalIdentityName,
  savedKnownNames,
  safeSourceIdentityName,
} from '../shared/self-identity.ts';
import type { PersonProfile } from '../shared/api.ts';

export interface NameSupport {
  noteId: string;
  name: string;
  operationId: string;
  intakeId: string;
  groupId: string;
  sourceHash: string;
  subjectText: string;
  /** Recorded before mirroring the first learned name. Absent means legacy provenance is unknown. */
  independentManual?: boolean;
  independentPrimary?: boolean;
}
export interface NameAuthority {
  noteId: string;
  name: string;
  status: 'active' | 'superseded' | 'unresolved';
  operationId: string;
  revision: number;
  supportOperations: string[];
  at: string;
}
const key = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function rememberNameSupport(
  db: Database,
  noteId: string,
  profile: PersonProfile,
  evidence: NonNullable<PersonProfile['sourceKnownNames']>[number],
) {
  if (!safeSourceIdentityName(evidence.name)) return;
  const previous = db
    .prepare(
      "SELECT coverage_json FROM manual_batches WHERE title='Remembered name support' AND json_extract(coverage_json,'$.noteId')=? AND json_extract(coverage_json,'$.nameKey')=? ORDER BY json_extract(coverage_json,'$.revision'),id LIMIT 1",
    )
    .get(noteId, canonicalIdentityName(evidence.name));
  const first = previous ? (json(previous.coverage_json) as NameSupport) : null;
  const legacy = profile.sourceKnownNames?.some(
    (s) => canonicalIdentityName(s.name) === canonicalIdentityName(evidence.name),
  );
  const support: NameSupport & { nameKey: string; revision: number } = {
    noteId,
    revision: revision(db) + 1,
    ...evidence,
    nameKey: canonicalIdentityName(evidence.name),
    ...(first
      ? { independentManual: first.independentManual, independentPrimary: first.independentPrimary }
      : legacy
        ? {}
        : {
            independentManual: savedKnownNames(profile.knownNames).some(
              (n) => canonicalIdentityName(n) === canonicalIdentityName(evidence.name),
            ),
            independentPrimary:
              !!profile.fullName &&
              canonicalIdentityName(profile.fullName) === canonicalIdentityName(evidence.name),
          }),
  };
  const at = now();
  const added = db
    .prepare(
      "INSERT OR IGNORE INTO manual_batches(id,title,status,created_at,verified_at,notes,coverage_json) VALUES(?,'Remembered name support','verified',?,?,'Explicit report confirmation',?)",
    )
    .run(
      'name-support:' +
        key([
          noteId,
          evidence.operationId,
          evidence.intakeId,
          evidence.groupId,
          evidence.sourceHash,
          evidence.name,
        ]),
      at,
      at,
      JSON.stringify(support),
    );
  if (
    added.changes &&
    nameAuthorities(db, noteId).some(
      (a) =>
        canonicalIdentityName(a.name) === canonicalIdentityName(evidence.name) &&
        a.status !== 'active',
    )
  )
    appendOwnershipDecision(
      db,
      'name-reconfirmed:' + key([noteId, evidence.operationId, evidence.name]),
      'Remembered name correction',
      {
        noteId,
        name: evidence.name,
        status: 'active',
        operationId: evidence.operationId,
        supportOperations: [evidence.operationId],
      },
      'New explicit report confirmation reestablishes this name association',
    );
}
export function nameAuthorities(db: Database, noteId: string): NameAuthority[] {
  const latest = new Map<string, NameAuthority>();
  for (const row of db
    .prepare(
      "SELECT coverage_json FROM manual_batches WHERE title='Remembered name correction' AND json_extract(coverage_json,'$.noteId')=? ORDER BY json_extract(coverage_json,'$.revision'),id",
    )
    .iterate(noteId)) {
    const value = json(row.coverage_json) as NameAuthority;
    latest.set(canonicalIdentityName(value.name), value);
  }
  return [...latest.values()];
}
/** Old evidence stays, but corrected authority cannot authorize another wrong-person match. */
export function effectiveKnownNames(
  db: Database,
  noteId: string,
  profile: PersonProfile,
): string[] {
  const statuses = new Map(
    nameAuthorities(db, noteId).map((a) => [canonicalIdentityName(a.name), a.status]),
  );
  return [
    ...new Set([
      ...savedKnownNames(profile.knownNames),
      ...(profile.sourceKnownNames || []).map((s) => s.name),
      ...nameAuthorities(db, noteId)
        .filter((a) => a.status === 'active')
        .map((a) => a.name),
    ]),
  ].filter(
    (n) =>
      !statuses.has(canonicalIdentityName(n)) ||
      statuses.get(canonicalIdentityName(n)) === 'active',
  );
}

/** Historical receipts stay in storage; this filter is only current matching authority. */
export function activeIdentityReceipts<T extends { operationId: string }>(
  db: Database,
  receipts: T[] | undefined,
): T[] | undefined {
  if (!receipts?.length) return receipts;
  const revoked = new Set<string>();
  for (const row of db
    .prepare(
      "SELECT json_extract(coverage_json,'$.supportOperationId') operation FROM manual_batches WHERE title='Identity receipt supersession'",
    )
    .iterate())
    revoked.add(String(row.operation));
  return receipts.filter((r) => !revoked.has(r.operationId));
}

/** Only explicit name additions/removals count; mirroring source evidence never calls this. */
export function rememberManualNameChanges(
  db: Database,
  noteId: string,
  before: PersonProfile,
  after: PersonProfile,
) {
  const old = new Set(savedKnownNames(before.knownNames).map(canonicalIdentityName));
  const next = new Map(savedKnownNames(after.knownNames).map((n) => [canonicalIdentityName(n), n]));
  const linked = new Set(
    [...(before.sourceKnownNames || []), ...(after.sourceKnownNames || [])].map((s) =>
      canonicalIdentityName(s.name),
    ),
  );
  for (const nameKey of new Set([...old, ...next.keys()])) {
    if (linked.has(nameKey)) continue;
    if (old.has(nameKey) === next.has(nameKey)) continue;
    const name =
      next.get(nameKey) ||
      savedKnownNames(before.knownNames).find((n) => canonicalIdentityName(n) === nameKey)!;
    const at = now();
    db.prepare(
      "INSERT INTO manual_batches(id,title,status,created_at,verified_at,notes,coverage_json) VALUES(?,'Manual name assertion','verified',?,?,'Explicit name edit',?)",
    ).run(
      'manual-name:' + key([noteId, nameKey, revision(db) + 1]),
      at,
      at,
      JSON.stringify({
        noteId,
        name,
        nameKey,
        active: next.has(nameKey),
        revision: revision(db) + 1,
        at,
      }),
    );
  }
}
