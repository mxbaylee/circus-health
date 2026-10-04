/** Checked source-occurrence joins. No source/evidence/history aggregate is retained. */
import { createHash, type Hash } from 'node:crypto';
import { HttpError, json, type Database, type SqliteRow } from './database.ts';
import { clinicalTables, type ClinicalKind } from './clinical-references.ts';
import { canonicalLiteral } from './intake-format.ts';
import { clinicalSourceIdentityV1 } from './intake-source-identity.ts';
import { latestOwnershipDecision } from './ownership-journal.ts';
import { ownershipDecisionQueries } from './ownership-decision-index.ts';
import { ownershipIntakeScopes } from './ownership-intake-scopes.ts';
import type { SourceContribution, AcceptedContribution } from './ownership-contributions.ts';
import type { HealthRecordEnvelope } from '../shared/intake.ts';

const registered = new WeakSet<Database>();
const work = new WeakMap<
  Database,
  {
    sourceRows: number;
    evidenceRows: number;
    transitionRows: number;
    hashedBytes: number;
    maxEncodedRowBytes: number;
  }
>();
export function ownershipContributionWork(db: Database) {
  let value = work.get(db);
  if (!value) {
    value = {
      sourceRows: 0,
      evidenceRows: 0,
      transitionRows: 0,
      hashedBytes: 0,
      maxEncodedRowBytes: 0,
    };
    work.set(db, value);
  }
  return { ...value };
}
function metric(db: Database) {
  ownershipContributionWork(db);
  return work.get(db)!;
}
function update(db: Database, hash: Hash, text: string) {
  const counters = metric(db),
    bytes = Buffer.byteLength(text);
  counters.hashedBytes += bytes;
  counters.maxEncodedRowBytes = Math.max(counters.maxEncodedRowBytes, bytes);
  hash.update(text);
}
function rows(
  db: Database,
  hash: Hash,
  values: Iterable<SqliteRow>,
  kind: 'evidenceRows' | 'transitionRows',
) {
  update(db, hash, '[');
  let comma = false;
  for (const value of values) {
    if (comma) update(db, hash, ',');
    comma = true;
    metric(db)[kind]++;
    update(db, hash, canonicalLiteral(value));
  }
  update(db, hash, ']');
}
export function* iterateOwnershipContributionSourceIds(
  db: Database,
  kind: ClinicalKind,
  recordId: string,
) {
  if (!db.prepare(`SELECT 1 FROM ${clinicalTables[kind]} WHERE id=?`).get(recordId))
    throw new HttpError(404, 'RECORD_NOT_FOUND', 'Saved record not found in this profile.');
  if (!registered.has(db)) {
    // JS Array.sort compares UTF16 code units. SQLite's UTF8 text order differs
    // for supplementary characters; an explicit big-endian key preserves it.
    db.function('circus_ownership_source_utf16', (input) => {
      const result = Buffer.from(String(input), 'utf16le');
      result.swap16();
      return result;
    });
    registered.add(db);
  }
  for (const row of db
    .prepare(
      `SELECT id FROM (SELECT COALESCE(source_record_id,'null') id FROM ${clinicalTables[kind]} WHERE id=? UNION SELECT COALESCE(source_record_id,'null') id FROM evidence WHERE entity_type=? AND entity_id=?) ORDER BY circus_ownership_source_utf16(id)`,
    )
    .iterate(recordId, kind, recordId))
    yield String(row.id);
}
export type OwnershipStreamContribution = Omit<
  SourceContribution,
  'reportScopes' | 'evidenceIds'
> & {
  reportScopes(): Iterable<string>;
  evidenceIds(): Iterable<string>;
};
export function readOwnershipStreamContribution(
  db: Database,
  kind: ClinicalKind,
  recordId: string,
  id: string,
  options: { scopes?: (intakeId: string, recordId: string) => Iterable<string> | undefined } = {},
): OwnershipStreamContribution {
  const source = db.prepare('SELECT * FROM source_records WHERE id=?').get(id);
  if (!source)
    throw new HttpError(
      409,
      'OWNERSHIP_CHANGED',
      'The saved record source changed. Update the correction preview.',
    );
  metric(db).sourceRows++;
  const envelope = json(source.raw_json) as HealthRecordEnvelope;
  const locator = json(source.locator_json, {}) as Record<string, unknown>;
  const originalId = String(locator.originalSourceFileId || source.source_file_id);
  const original = db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(originalId);
  if (!original)
    throw new HttpError(
      409,
      'OWNERSHIP_CHANGED',
      'The retained original changed. Update the correction preview.',
    );
  const indexed = ownershipDecisionQueries(db),
    indexedAccepted = indexed?.accepted(id);
  const accepted = indexed
    ? indexedAccepted
      ? (json(indexedAccepted.coverage_json) as AcceptedContribution)
      : null
    : latestOwnershipDecision<AcceptedContribution>(
        db,
        'Accepted clinical contribution',
        'sourceRecordId',
        id,
      );
  const evidence = () =>
    db
      .prepare(
        'SELECT * FROM evidence WHERE entity_type=? AND entity_id=? AND source_record_id=? ORDER BY id',
      )
      .iterate(kind, recordId, id);
  const transitions = () =>
    indexed
      ? indexed.transitions(id)
      : db
          .prepare(
            "SELECT id,coverage_json FROM manual_batches WHERE title='Duplicate evidence decision' AND json_extract(coverage_json,'$.duplicateDecision.occurrenceAttachment.incomingSourceRecordId')=? ORDER BY json_extract(coverage_json,'$.duplicateDecision.sequence'),id",
          )
          .iterate(id);
  const version = createHash('sha256');
  update(db, version, '[' + canonicalLiteral(source) + ',');
  rows(db, version, evidence(), 'evidenceRows');
  update(db, version, ',' + canonicalLiteral(accepted) + ',');
  rows(db, version, transitions(), 'transitionRows');
  update(db, version, ']');
  const attachment = createHash('sha256');
  rows(db, attachment, transitions(), 'transitionRows');
  return {
    sourceRecordId: id,
    sourceFileId: originalId,
    reportScopes: () =>
      options.scopes?.(originalId, id) ??
      (function* () {
        for (const group of ownershipIntakeScopes(db, originalId, id, {
          latestOnly: true,
          subject: false,
        }))
          yield originalId + ':' + group.id;
      })(),
    contentUrl: `/api/sources/${encodeURIComponent(originalId)}/content`,
    locator: envelope?.provenance?.locator || locator,
    version: version.digest('hex'),
    selected: false,
    identity: envelope?.provenance
      ? clinicalSourceIdentityV1({ value: envelope }, { sha256: String(original.sha256) })
      : '',
    acceptedMapping: accepted?.mapping || null,
    evidenceIds: function* () {
      for (const row of evidence()) yield String(row.id);
    },
    source,
    envelope,
    intakeId: accepted?.intakeId || originalId,
    sourceHash: String(original.sha256),
    attachmentVersion: attachment.digest('hex'),
  };
}
export function* iterateOwnershipStreamContributions(
  db: Database,
  kind: ClinicalKind,
  recordId: string,
  options: Parameters<typeof readOwnershipStreamContribution>[4] = {},
) {
  for (const id of iterateOwnershipContributionSourceIds(db, kind, recordId))
    yield readOwnershipStreamContribution(db, kind, recordId, id, options);
}

/** Repeatable bounded iterator. Filtering never retains a record's complete fan-in. */
export class OwnershipContributionSequence implements Iterable<OwnershipStreamContribution> {
  private read: () => Iterable<OwnershipStreamContribution>;
  constructor(read: () => Iterable<OwnershipStreamContribution>) {
    this.read = read;
  }
  [Symbol.iterator]() {
    return this.read()[Symbol.iterator]();
  }
  get length() {
    let count = 0;
    for (const _value of this) count++;
    return count;
  }
  first() {
    for (const value of this) return value;
    return undefined;
  }
  find(test: (value: OwnershipStreamContribution) => unknown) {
    for (const value of this) if (test(value)) return value;
    return undefined;
  }
  some(test: (value: OwnershipStreamContribution) => unknown) {
    return this.find(test) !== undefined;
  }
  filter(test: (value: OwnershipStreamContribution) => unknown) {
    const selected = this;
    return new OwnershipContributionSequence(function* () {
      for (const value of selected) if (test(value)) yield value;
    });
  }
}

export function ownershipContributionSequence(
  db: Database,
  kind: ClinicalKind,
  recordId: string,
  options: Parameters<typeof readOwnershipStreamContribution>[4] = {},
) {
  return new OwnershipContributionSequence(() =>
    iterateOwnershipStreamContributions(db, kind, recordId, options),
  );
}

/** A prepared report's private row snapshot is valid only while its clinical
 * revision/frontier guard holds. Function-valued joins are restored explicitly. */
export function restoreOwnershipStreamContribution(
  db: Database,
  kind: ClinicalKind,
  recordId: string,
  text: string,
  scopes: (intakeId: string, sourceRecordId: string) => Iterable<string> | undefined,
): OwnershipStreamContribution {
  const value = JSON.parse(text) as Omit<
    OwnershipStreamContribution,
    'reportScopes' | 'evidenceIds'
  >;
  return {
    ...value,
    reportScopes: () =>
      scopes(value.sourceFileId, value.sourceRecordId) ??
      (function* () {
        for (const group of ownershipIntakeScopes(db, value.sourceFileId, value.sourceRecordId, {
          latestOnly: true,
          subject: false,
        }))
          yield value.sourceFileId + ':' + group.id;
      })(),
    evidenceIds: function* () {
      for (const row of db
        .prepare(
          'SELECT id FROM evidence WHERE entity_type=? AND entity_id=? AND source_record_id=? ORDER BY id',
        )
        .iterate(kind, recordId, value.sourceRecordId))
        yield String(row.id);
    },
  };
}

export function contributionMappingsDisagree(
  values: Iterable<OwnershipStreamContribution>,
  hash: (value: object) => string,
) {
  const steps = contributionMappingSteps(values, hash);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}
export function* contributionMappingSteps(
  values: Iterable<OwnershipStreamContribution>,
  hash: (value: object) => string,
): Generator<void, boolean> {
  let first: string | undefined;
  let visited = 0;
  for (const value of values) {
    if (!value.acceptedMapping) return true;
    const current = hash(value.acceptedMapping);
    if (first !== undefined && first !== current) return true;
    first = current;
    if (++visited % 32 === 0) yield;
  }
  return false;
}
