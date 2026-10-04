/** Explicit cold legacy history reduction; warm views read selected witnesses. */
import type { Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import {
  selectedEnvelopeStore,
  openIntakeCollectionEnvelope,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { schemaKey } from './intake-envelope-schema.ts';
import { IntakeReviewFragmentRequired } from './intake-review-collection.ts';
import { finishClinicalReviewWork } from './clinical-review-work.ts';
import { parseLiteralJSON } from './intake-format.ts';
import type { ReviewDraftResolutionPolicy } from './intake-review-draft-selection.ts';
import type { IntakeIssueResolution } from '../shared/intake.ts';

const prefix = (address: string) => 'draft.policy:' + address + ':';
export function* legacyDraftPolicyContributions(
  view: IntakeCollectionEnvelopeReader,
  selectedDrafts?: Iterable<IntakeEnvelopeRecord>,
): Generator<{ checkpoint: true } | { key: string; value: string }> {
  const intake = view.child(view.root(), 'intake'),
    flow = intake && view.child(intake, 'workflow');
  if (!flow) return;
  const scratch = disposableSqlite('intake-draft-policy-');
  try {
    scratch.db.exec(
      'CREATE TABLE witnesses(kind TEXT,issue TEXT,ordinal INTEGER,address TEXT,PRIMARY KEY(kind,issue))',
    );
    const put = scratch.db.prepare(
      'INSERT INTO witnesses VALUES(?,?,?,?) ON CONFLICT(kind,issue) DO UPDATE SET ordinal=excluded.ordinal,address=excluded.address',
    );
    let visited = 0;
    function* drafts() {
      for (let n = 0, count = view.childCount(flow!, 'reviewDrafts'); n < count; n++)
        yield view.childAt(flow!, 'reviewDrafts', n)!;
    }
    for (const draft of selectedDrafts ?? drafts()) {
      const format = view.field(draft, 'format', { bytes: 256 });
      if (format.kind === 'value' && format.value === 'health-intake-review-draft-v2') continue;
      scratch.db.exec('DELETE FROM witnesses');
      for (
        let ordinal = 0, count = view.childCount(draft, 'resolutions');
        ordinal < count;
        ordinal++
      ) {
        const record = view.childAt(draft, 'resolutions', ordinal)!,
          issue = view.field(record, 'issueId', { bytes: 65536 }),
          outcome = view.field(record, 'outcome', { bytes: 256 });
        if (
          issue.kind !== 'value' ||
          typeof issue.value !== 'string' ||
          outcome.kind !== 'value' ||
          typeof outcome.value !== 'string'
        )
          throw Error('Legacy draft resolution identity is unavailable');
        const address = view.address(record),
          key = schemaKey(issue.value);
        put.run('latest', key, ordinal, address);
        if (outcome.value !== 'unknown') put.run('known', key, ordinal, address);
        if (outcome.value === 'this_is_me') put.run('self', '', ordinal, address);
        if (++visited % 64 === 0) yield { checkpoint: true };
      }
      for (const row of scratch.db
        .prepare('SELECT kind,issue,ordinal,address FROM witnesses ORDER BY kind,issue')
        .iterate())
        yield {
          key: prefix(view.address(draft)) + row.kind + ':' + row.issue,
          value: JSON.stringify({ ordinal: row.ordinal, address: row.address }),
        };
      if (++visited % 64 === 0) yield { checkpoint: true };
    }
  } finally {
    scratch.close();
  }
}

export function readLegacyDraftPolicyWitnesses(
  db: Database,
  source: IntakeEnvelopeSource,
  view: IntakeCollectionEnvelopeReader,
  draft: IntakeEnvelopeRecord,
  options: { bytes: number },
) {
  if (!Number.isSafeInteger(options.bytes) || options.bytes < 0)
    throw Error('Invalid draft witness budget');
  const collections = selectedEnvelopeStore(db, source).collections;
  if (
    JSON.stringify(openIntakeCollectionEnvelope(db, source).logical) !==
      JSON.stringify(view.logical) ||
    collections.get(collections.openView(), 'builds', 'envelope.indexes', 'complete') !==
      JSON.stringify(view.logical) ||
    collections.get(collections.openView(), 'builds', 'envelope.indexes', 'policy') !==
      'health-intake-workflow-index-v6'
  )
    throw Error('Legacy draft policy indexes are incomplete or stale');
  const address = view.address(draft),
    start = prefix(address);
  const check = (raw: unknown) => {
    if (typeof raw !== 'string') throw Error('Invalid legacy draft witness index');
    const witness = JSON.parse(raw) as { ordinal: number; address: string };
    if (
      !Number.isSafeInteger(witness.ordinal) ||
      witness.ordinal < 0 ||
      typeof witness.address !== 'string'
    )
      throw Error('Invalid legacy draft witness ordinal');
    return witness;
  };
  function* readWork(witness: {
    ordinal: number;
    address: string;
  }): Generator<void, IntakeIssueResolution, void> {
    const record = view.childAt(draft, 'resolutions', witness.ordinal);
    if (!record || view.address(record) !== witness.address)
      throw Error('Legacy draft witness does not belong to the selected history');
    let size = 0;
    const pieces: string[] = [];
    for (const piece of view.recordChunks(record)) {
      size += Buffer.byteLength(piece);
      if (size > 256 * 1024)
        throw new IntakeReviewFragmentRequired({
          format: 'health-intake-review-fragment-v1',
          logical: view.logical,
          address: view.address(record),
        });
      pieces.push(piece);
      yield;
    }
    return parseLiteralJSON(pieces.join('')) as IntakeIssueResolution;
  }
  const read = (witness: { ordinal: number; address: string }) =>
    finishClinicalReviewWork(readWork(witness));
  const point = (key: string) => {
    view.address(draft);
    const raw = collections.get(collections.openView(), 'builds', 'envelope.indexes', start + key);
    return raw === undefined ? undefined : read(check(raw));
  };
  const policy: ReviewDraftResolutionPolicy = {
    *values() {
      for (const resolution of this.valuesWork!()) if (resolution !== undefined) yield resolution;
    },
    *valuesWork() {
      view.address(draft);
      const scratch = disposableSqlite('intake-draft-witnesses-');
      try {
        scratch.db.exec('CREATE TABLE selected(ordinal INTEGER PRIMARY KEY,address TEXT NOT NULL)');
        const put = scratch.db.prepare(
          'INSERT INTO selected VALUES(?,?) ON CONFLICT(ordinal) DO UPDATE SET address=excluded.address',
        );
        let after = start;
        outer: while (true) {
          const page = collections.range(collections.openView(), 'builds', 'envelope.indexes', {
            after,
            items: 32,
            bytes: 16384,
          });
          for (const item of page.items) {
            yield;
            if (!item.key.startsWith(start)) break outer;
            const witness = check(item.value);
            put.run(witness.ordinal, witness.address);
          }
          if (page.complete) break;
          if (!page.after || page.after === after)
            throw Error('Legacy draft witness cursor did not advance');
          after = page.after;
        }
        for (const row of scratch.db
          .prepare('SELECT ordinal,address FROM selected ORDER BY ordinal')
          .iterate())
          yield yield* readWork({ ordinal: Number(row.ordinal), address: String(row.address) });
      } finally {
        scratch.close();
      }
    },
    latest: (issueId) => point('latest:' + schemaKey(issueId)),
    known: (issueId) => point('known:' + schemaKey(issueId)),
    self: () => point('self:'),
  };
  return {
    policy,
    draftAddress: address,
    counts: {
      resolutions: view.childCount(draft, 'resolutions'),
      corrections: view.childCount(draft, 'corrections'),
    },
  };
}
