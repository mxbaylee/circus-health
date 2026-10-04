/** Closed command effects are inert until their exact prospective root is selected. */
import type { DatabaseSync } from 'node:sqlite';
import type { IntakeEnvelopeDerivedPreparation } from './intake-envelope-mutation.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import { openIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
import type { NativeProposalAffected } from './intake-collection-proposals.ts';
import type { NativeAcceptanceEffects } from './intake-collection-acceptance.ts';
import type { WorkflowDraftEffects } from './intake-workflow-draft-index.ts';
import { canonicalLiteral } from './intake-format.ts';
const prefix = '__intake_queue_transitions';
const initialized = new WeakSet<DatabaseSync>();
export function prepareCollectionQueueTransitions(db: DatabaseSync) {
  db.exec(
    `CREATE TEMP TABLE IF NOT EXISTS ${prefix}(source TEXT,after TEXT,before TEXT,PRIMARY KEY(source,after));CREATE TEMP TABLE IF NOT EXISTS ${prefix}_effects(source TEXT,after TEXT,kind TEXT,key TEXT,value TEXT,PRIMARY KEY(source,after,kind,key));`,
  );
  initialized.add(db);
}
export function recordCollectionQueueTransition(
  db: DatabaseSync,
  source: IntakeEnvelopeSource,
  input: IntakeEnvelopeDerivedPreparation,
  effect: {
    affected: NativeProposalAffected;
    acceptance?: NativeAcceptanceEffects;
    draft?: WorkflowDraftEffects;
    packageBatch?: { planAddress: string; operationId: string; pendingDelta: number };
  },
) {
  if (!initialized.has(db)) return;
  const before = canonicalLiteral(openIntakeCollectionEnvelope(db, source).logical),
    after = canonicalLiteral(input.logical);
  if (canonicalLiteral(input.reader.logical) !== before) throw Error('Foreign queue transition');
  db.prepare(`INSERT OR IGNORE INTO ${prefix} VALUES(?,?,?)`).run(source.id, after, before);
  const put = (kind: string, key: string, value: unknown) =>
    db
      .prepare(`INSERT OR REPLACE INTO ${prefix}_effects VALUES(?,?,?,?,?)`)
      .run(source.id, after, kind, key, JSON.stringify(value));
  for (const change of effect.affected.candidateChanges)
    put('candidate', JSON.stringify([change.candidateId, change.candidateVersionId]), change);
  for (const address of effect.affected.questionAddresses) {
    const question = input.reader.resolve(address),
      candidate = input.reader.field(question, 'candidateId', { bytes: 8192 });
    if (candidate.kind === 'value' && typeof candidate.value === 'string')
      put('candidate', JSON.stringify([candidate.value, null]), { candidateId: candidate.value });
    else put('broad', 'questions', true);
  }
  const groups = new Set<string>();
  for (const change of effect.affected.reportVersionChanges || []) {
    groups.add(change.groupAddress);
    put('group', change.versionAddress, change);
  }
  for (const id of effect.affected.proposalIds) put('proposal', id, id);
  if (
    effect.acceptance ||
    effect.affected.reportGroupAddresses.some((address) => !groups.has(address)) ||
    effect.affected.candidateChanges.some(
      (change) =>
        change.kind === 'append' &&
        !(effect.affected.reportVersionChanges || []).some((group) =>
          group.changed.some(
            (member) =>
              member.candidateId === change.candidateId &&
              member.candidateVersionId === change.candidateVersionId,
          ),
        ),
    )
  )
    put('broad', 'membership', true);
  if (
    !effect.affected.candidateChanges.length &&
    !effect.affected.questionAddresses.length &&
    !effect.affected.reportGroupAddresses.length &&
    !effect.affected.proposalIds.length &&
    !effect.packageBatch
  )
    put('metadata', 'metadata', true);
}
export interface CollectionQueueTransitionEffect {
  kind: 'candidate' | 'group' | 'proposal' | 'broad' | 'metadata';
  key: string;
  value: string;
}
/** Consumers stream the exact selected path; abandoned roots have no effect. */
export function collectionQueueTransitionEffects(
  db: DatabaseSync,
  sourceId: string,
  before: unknown,
  after: unknown,
): Iterable<CollectionQueueTransitionEffect> | undefined {
  if (!initialized.has(db)) return undefined;
  const start = canonicalLiteral(before),
    finish = canonicalLiteral(after);
  let current = finish;
  while (current !== start) {
    const row = db
      .prepare(`SELECT before FROM ${prefix} WHERE source=? AND after=?`)
      .get(sourceId, current);
    if (!row || row.before === current) return undefined;
    current = String(row.before);
  }
  return {
    *[Symbol.iterator]() {
      for (const step of db
        .prepare(
          `WITH RECURSIVE chain(after,before,depth) AS (
        SELECT after,before,0 FROM ${prefix} WHERE source=? AND after=?
        UNION ALL SELECT t.after,t.before,c.depth+1 FROM ${prefix} t JOIN chain c ON t.after=c.before AND t.source=? WHERE c.before<>?
      ) SELECT after FROM chain ORDER BY depth DESC`,
        )
        .iterate(sourceId, finish, sourceId, start)) {
        const current = String(step.after);
        for (const row of db
          .prepare(
            `SELECT kind,key,value FROM ${prefix}_effects WHERE source=? AND after=? ORDER BY kind,key`,
          )
          .iterate(sourceId, current))
          yield {
            kind: String(row.kind) as CollectionQueueTransitionEffect['kind'],
            key:
              row.kind === 'candidate'
                ? String(JSON.parse(String(row.value)).candidateId)
                : String(row.key),
            value: String(row.value),
          };
      }
    },
  };
}
