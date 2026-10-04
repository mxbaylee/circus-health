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
interface NameAuthorityHeader {
  noteId: string;
  name: string;
  status: 'active' | 'superseded' | 'unresolved';
  operationId: string;
  revision: number;
  at: string;
  origin?: 'confirmation' | 'ownership' | 'future';
}
export type NameAuthority = NameAuthorityHeader &
  (
    | { supportOperations: string[]; supportOperationsIncluded?: true }
    | {
        supportOperationsIncluded: false;
        supportOperationsReference: import('../shared/ownership-name-reference.ts').OwnershipNameSupportReference;
      }
  );
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
        origin: 'confirmation',
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
    // Older decisions predate the explicit origin field. Ownership receipts have a durable
    // operation key; identity confirmations do not.
    value.origin ??= db
      .prepare('SELECT 1 FROM manual_batches WHERE id=?')
      .get('ownership:' + value.operationId)
      ? 'ownership'
      : 'confirmation';
    latest.set(canonicalIdentityName(value.name), value);
  }
  return [...latest.values()];
}
/** Presentation metadata only; retained support remains the durable authority. */
export function sourceNameConfirmationDate(
  db: Database,
  noteId: string,
  operationId: string,
  name: string,
): string | undefined {
  const row = db
    .prepare(
      "SELECT created_at FROM manual_batches WHERE title='Remembered name support' AND json_extract(coverage_json,'$.noteId')=? AND json_extract(coverage_json,'$.operationId')=? AND json_extract(coverage_json,'$.nameKey')=? ORDER BY created_at LIMIT 1",
    )
    .get(noteId, operationId, canonicalIdentityName(name));
  return row ? String(row.created_at) : undefined;
}
/** Challenged learned associations remain a competing claim until explicit review settles them. */
export function challengedKnownNames(db: Database, noteId: string): string[] {
  return nameAuthorities(db, noteId)
    .filter((authority) => authority.status === 'unresolved')
    .map((authority) => authority.name);
}
/** Latest explicit future-report choice for each spelling, reconstructed from the journal. */
export function futureNameOwners(db: Database): { name: string; personId: string }[] {
  const latest = new Map<string, { name: string; personId: string } | null>();
  for (const row of db
    .prepare(
      "SELECT coverage_json FROM manual_batches WHERE title='Future name owner' ORDER BY json_extract(coverage_json,'$.revision'),id",
    )
    .iterate()) {
    const decision = json(row.coverage_json) as { name: string; personId: string | null };
    latest.set(
      canonicalIdentityName(decision.name),
      decision.personId ? { name: decision.name, personId: decision.personId } : null,
    );
  }
  return [...latest.values()].filter(
    (value): value is { name: string; personId: string } => !!value,
  );
}
export function challengedNameNoteIds(db: Database, name: string): string[] {
  const canonical = canonicalIdentityName(name);
  return db
    .prepare("SELECT id FROM notes WHERE kind='person'")
    .all()
    .map((row) => String(row.id))
    .filter((noteId) =>
      nameAuthorities(db, noteId).some(
        (authority) =>
          authority.status === 'unresolved' && canonicalIdentityName(authority.name) === canonical,
      ),
    );
}

/** Confirmation settles future matching without rewriting its report's historical attribution. */
export function rememberFutureNameOwner(
  db: Database,
  name: string,
  target: { noteId: string; personId: string } | null,
  operationId: string,
  challengedNoteIds: string[],
) {
  const canonical = canonicalIdentityName(name);
  for (const noteId of challengedNoteIds)
    appendOwnershipDecision(
      db,
      'future-name-authority:' + key([operationId, noteId, canonical]),
      'Remembered name correction',
      {
        noteId,
        name,
        status:
          target && target.noteId === noteId ? 'active' : target ? 'superseded' : 'unresolved',
        origin: 'future',
        operationId,
        supportOperations: [operationId],
      },
      'Explicit future-report name choice after an accepted ownership correction',
    );
  if (target && !challengedNoteIds.includes(target.noteId))
    appendOwnershipDecision(
      db,
      'future-name-authority:' + key([operationId, target.noteId, canonical]),
      'Remembered name correction',
      {
        noteId: target.noteId,
        name,
        status: 'active',
        origin: 'future',
        operationId,
        supportOperations: [operationId],
      },
      'Explicit future-report name choice after an accepted ownership correction',
    );
  appendOwnershipDecision(
    db,
    'future-name-owner:' + key([operationId, canonical]),
    'Future name owner',
    { name, personId: target?.personId || null, operationId },
    'Explicit choice for later reports with this printed name',
  );
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
  const manual = new Map<string, boolean>();
  for (const row of db
    .prepare(
      "SELECT coverage_json FROM manual_batches WHERE title='Manual name assertion' AND json_extract(coverage_json,'$.noteId')=? ORDER BY json_extract(coverage_json,'$.revision'),id",
    )
    .iterate(noteId)) {
    const assertion = json(row.coverage_json) as { nameKey: string; active: boolean };
    manual.set(assertion.nameKey, assertion.active);
  }
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
      statuses.get(canonicalIdentityName(n)) === 'active' ||
      (!!profile.fullName &&
        canonicalIdentityName(profile.fullName) === canonicalIdentityName(n)) ||
      manual.get(canonicalIdentityName(n)) === true,
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
