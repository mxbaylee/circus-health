/** Disposable reader observations. The selected envelope and dependency receipts
 * remain authoritative; a new connection or unknown mutation prepares them again. */
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import {
  execClinicalReviewMaintenance,
  prepareClinicalReviewMaintenance,
} from './clinical-review-maintenance.ts';
import { HttpError, type Database } from './database.ts';
import { assertIntakeOwner } from './intake.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  intakeEnvelopeRecordOrder,
} from './intake-collection-envelope.ts';
import type { IntakeEnvelopeDerivedPreparation } from './intake-envelope-mutation.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import {
  openCollectionReaderPlan,
  collectionReaderProposalCurrent,
  type CollectionReaderUnitFacts,
} from './intake-source-reader-unit.ts';
import { prepareRetainedPlanAccess } from './intake-retained-plan.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';

const P = '__intake_reader_',
  ROOT_LEVEL = 53;
const pending = () =>
  new HttpError(
    409,
    'READER_COVERAGE_PENDING',
    'Prepare current reader observations before continuing',
  );
const dataVersion = (db: Database) => Number(db.prepare('PRAGMA data_version').get()!.data_version);
const schema = (db: Database) =>
  JSON.stringify(
    db
      .prepare(
        "SELECT type,name,sql FROM sqlite_temp_schema WHERE name GLOB '__intake_reader_*' ORDER BY type,name",
      )
      .all(),
  );
const mainSchema = (db: Database) =>
  JSON.stringify(
    db
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='table' AND name IN ('app_meta','source_files') ORDER BY name",
      )
      .all(),
  );
interface Store {
  epoch: string;
  data: number;
  schema: string;
  main: string;
}
const stores = new WeakMap<Database, Store>();
const tables = [
  'control',
  'sources',
  'plans',
  'units',
  'tree',
  'excluded',
  'proposals',
  'dependencies',
  'dirty',
  'dirty_proposals',
  'transitions',
  'effects',
  'path',
] as const;
const events = ['insert', 'update', 'delete'] as const;
const watched = (row: string) =>
  [
    'intake_source_page_hash:v1:*',
    'intake_source_span_hash:v1:*',
    'intake_proposal_dependencies:v1:*',
    'intake_source_pin:v1:*',
  ]
    .map((pattern) => `${row}.key GLOB '${pattern}'`)
    .join(' OR ');
// An outer UPSERT can override a trigger's OR IGNORE policy. Avoid the
// duplicate insertion itself so OLD/NEW and repeated writes safely coalesce.
const markDirty = (key: string) =>
  `INSERT INTO ${P}dirty(key) SELECT ${key} WHERE NOT EXISTS(SELECT 1 FROM ${P}dirty WHERE key=${key});`;
function checked(db: Database) {
  const state = stores.get(db);
  if (
    !state ||
    state.data !== dataVersion(db) ||
    state.schema !== schema(db) ||
    state.main !== mainSchema(db)
  )
    throw pending();
  return state;
}
function ensure(db: Database) {
  try {
    return checked(db);
  } catch (error) {
    if (!(error instanceof HttpError && error.code === 'READER_COVERAGE_PENDING')) throw error;
  }
  for (const table of ['meta', 'source'])
    for (const event of events)
      execClinicalReviewMaintenance(
        db,
        'reader',
        `DROP TRIGGER IF EXISTS temp.${P}${table}_${event}`,
      );
  for (const table of tables)
    execClinicalReviewMaintenance(db, 'reader', `DROP TABLE IF EXISTS temp.${P}${table}`);
  for (const sql of [
    `CREATE TEMP TABLE ${P}control(singleton INTEGER PRIMARY KEY,generation INTEGER NOT NULL)`,
    `INSERT INTO ${P}control VALUES(1,0)`,
    `CREATE TEMP TABLE ${P}sources(id TEXT PRIMARY KEY,logical TEXT NOT NULL,sourceHash TEXT NOT NULL,ready INTEGER NOT NULL,generation INTEGER NOT NULL,run TEXT NOT NULL)`,
    `CREATE TEMP TABLE ${P}plans(source TEXT,ordinal INTEGER,address TEXT,unitCount INTEGER,eligible INTEGER,summary TEXT,PRIMARY KEY(source,ordinal))`,
    `CREATE INDEX temp.${P}plan_address ON ${P}plans(source,address)`,
    `CREATE TEMP TABLE ${P}units(source TEXT,plan INTEGER,ordinal INTEGER,facts TEXT,proposal TEXT,stale INTEGER,PRIMARY KEY(source,plan,ordinal))`,
    `CREATE INDEX temp.${P}unit_proposal ON ${P}units(source,proposal)`,
    `CREATE TEMP TABLE ${P}tree(source TEXT,level INTEGER,slot INTEGER,value TEXT,PRIMARY KEY(source,level,slot))`,
    `CREATE TEMP TABLE ${P}excluded(source TEXT,plan INTEGER,level INTEGER,slot INTEGER,value INTEGER,PRIMARY KEY(source,plan,level,slot))`,
    `CREATE TEMP TABLE ${P}proposals(source TEXT,id TEXT,current INTEGER,PRIMARY KEY(source,id))`,
    `CREATE TEMP TABLE ${P}dependencies(key TEXT,source TEXT,proposal TEXT,PRIMARY KEY(key,source,proposal))`,
    `CREATE INDEX temp.${P}dependency_proposal ON ${P}dependencies(source,proposal)`,
    `CREATE TEMP TABLE ${P}dirty(key TEXT PRIMARY KEY)`,
    `CREATE TEMP TABLE ${P}dirty_proposals(source TEXT,proposal TEXT,PRIMARY KEY(source,proposal))`,
    `CREATE TEMP TABLE ${P}transitions(source TEXT,after TEXT,before TEXT,PRIMARY KEY(source,after))`,
    `CREATE TEMP TABLE ${P}effects(source TEXT,after TEXT,kind TEXT,key TEXT,value TEXT,PRIMARY KEY(source,after,kind,key))`,
    `CREATE TEMP TABLE ${P}path(source TEXT,run TEXT,after TEXT,PRIMARY KEY(source,run,after))`,
  ])
    execClinicalReviewMaintenance(db, 'reader', sql);
  for (const event of events) {
    const row = event === 'delete' ? 'OLD' : 'NEW';
    const metaChanged =
      event === 'update'
        ? `(${watched('OLD')} OR ${watched('NEW')}) AND (OLD.key IS NOT NEW.key OR OLD.value IS NOT NEW.value)`
        : `(${watched(row)})`;
    execClinicalReviewMaintenance(
      db,
      'reader',
      `CREATE TEMP TRIGGER ${P}meta_${event} AFTER ${event.toUpperCase()} ON main.app_meta WHEN ${metaChanged} BEGIN ${markDirty(`'meta:' || ${row}.key`)} ${event === 'update' ? markDirty("'meta:' || OLD.key") : ''} UPDATE ${P}control SET generation=generation+1; END`,
    );
    execClinicalReviewMaintenance(
      db,
      'reader',
      `CREATE TEMP TRIGGER ${P}source_${event} AFTER ${event.toUpperCase()} ON main.source_files ${event === 'update' ? 'WHEN OLD.id IS NOT NEW.id OR OLD.sha256 IS NOT NEW.sha256 OR OLD.details_json IS NOT NEW.details_json OR OLD.kind IS NOT NEW.kind' : ''} BEGIN ${markDirty(`'source:' || ${row}.id`)} ${event === 'update' ? markDirty("'source:' || OLD.id") : ''} UPDATE ${P}control SET generation=generation+1; END`,
    );
  }
  const state = {
    epoch: randomUUID(),
    data: dataVersion(db),
    schema: schema(db),
    main: mainSchema(db),
  };
  stores.set(db, state);
  return state;
}
const generation = (db: Database) =>
  Number(db.prepare(`SELECT generation FROM ${P}control WHERE singleton=1`).get()!.generation);
const roleKey = (id: string, member: string) => 'role:' + JSON.stringify([id, member]);
/** Called inside the actual role publication transaction, so rollback also rolls
 * back invalidation. It visits only reverse dependencies of these exact members. */
export function invalidateCollectionReaderRoleDependencies(
  db: Database,
  id: string,
  members: readonly string[],
) {
  if (!stores.has(db)) return;
  try {
    checked(db);
  } catch (error) {
    if (error instanceof HttpError && error.code === 'READER_COVERAGE_PENDING') {
      stores.delete(db);
      return;
    }
    throw error;
  }
  const put = prepareClinicalReviewMaintenance(
    db,
    'reader',
    `INSERT OR IGNORE INTO ${P}dirty VALUES(?)`,
  );
  for (const member of members) put.run(roleKey(id, member));
  if (members.length)
    execClinicalReviewMaintenance(db, 'reader', `UPDATE ${P}control SET generation=generation+1`);
}
export interface ReaderCoverageEffects {
  planAddresses?: readonly string[];
  batches?: readonly { planAddress: string; unitIds: readonly string[] }[];
  proposalIds?: readonly string[];
}
/** An inert prospective transition is not a selected observation. Only a later
 * exact selected logical root can consume its closed command effects. */
export function recordCollectionReaderCoverageTransition(
  db: Database,
  source: IntakeEnvelopeSource,
  input: IntakeEnvelopeDerivedPreparation,
  effects: ReaderCoverageEffects = {},
): readonly IntakeCollectionChange[] {
  if (!stores.has(db)) return [];
  try {
    checked(db);
  } catch (error) {
    if (error instanceof HttpError && error.code === 'READER_COVERAGE_PENDING') return [];
    throw error;
  }
  if (!db.prepare(`SELECT 1 FROM ${P}sources WHERE id=?`).get(source.id)) return [];
  const before = JSON.stringify(openIntakeCollectionEnvelope(db, source).logical),
    after = JSON.stringify(input.logical);
  if (JSON.stringify(input.reader.logical) !== before)
    throw Error('Foreign reader coverage transition');
  const prior = db
    .prepare(`SELECT before FROM ${P}transitions WHERE source=? AND after=?`)
    .get(source.id, after);
  if (prior && prior.before !== before) {
    // A link-only command can return to an identical logical root. Ambiguous
    // auxiliary ancestry invalidates this cache rather than blocking the write.
    prepareClinicalReviewMaintenance(db, 'reader', `UPDATE ${P}sources SET ready=0 WHERE id=?`).run(
      source.id,
    );
    prepareClinicalReviewMaintenance(
      db,
      'reader',
      `DELETE FROM ${P}transitions WHERE source=?`,
    ).run(source.id);
    prepareClinicalReviewMaintenance(db, 'reader', `DELETE FROM ${P}effects WHERE source=?`).run(
      source.id,
    );
    return [];
  }
  prepareClinicalReviewMaintenance(
    db,
    'reader',
    `INSERT OR IGNORE INTO ${P}transitions VALUES(?,?,?)`,
  ).run(source.id, after, before);
  const put = prepareClinicalReviewMaintenance(
    db,
    'reader',
    `INSERT OR IGNORE INTO ${P}effects VALUES(?,?,?,?,?)`,
  );
  for (const address of effects.planAddresses ?? [])
    put.run(source.id, after, 'plan', address, address);
  for (const batch of effects.batches ?? [])
    for (const unitId of batch.unitIds)
      put.run(
        source.id,
        after,
        'unit',
        JSON.stringify([batch.planAddress, unitId]),
        JSON.stringify([batch.planAddress, unitId]),
      );
  for (const proposalId of effects.proposalIds ?? [])
    put.run(source.id, after, 'proposal', proposalId, proposalId);
  return [];
}
interface Counts {
  units: number;
  pending: number;
  partial: number;
  unreadable: number;
  context: number;
  stale: number;
  relevant: number;
}
const zero = (): Counts => ({
  units: 0,
  pending: 0,
  partial: 0,
  unreadable: 0,
  context: 0,
  stale: 0,
  relevant: 0,
});
const fields = Object.keys(zero()) as (keyof Counts)[];
function plus(a: Counts, b: Counts, sign = 1) {
  const value = { ...a };
  for (const key of fields) value[key] += b[key] * sign;
  return value;
}
function validate(value: Counts) {
  if (fields.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0))
    throw Error('Invalid reader observation counts');
  return value;
}
const defaultCounts = (units = 1): Counts => ({
  ...zero(),
  units,
  pending: units,
  relevant: units,
});
function contribution(facts: CollectionReaderUnitFacts | undefined, stale: boolean): Counts {
  if (!facts) return defaultCounts();
  return {
    units: 1,
    pending: Number(facts.status === 'pending'),
    partial: Number(facts.status === 'partial'),
    unreadable: Number(!stale && facts.coverageKind === 'unreadable'),
    context: Number(!stale && facts.coverageKind === 'context'),
    stale: Number(stale),
    relevant: Number(
      stale ||
        facts.status !== 'completed' ||
        facts.coverageKind === 'unreadable' ||
        facts.coverageKind === 'context' ||
        facts.hasNotes,
    ),
  };
}
interface PlanRow {
  ordinal: number;
  address: string;
  unitCount: number;
  eligible: number;
  summary: string;
}
interface UnitRow {
  ordinal: number;
  plan: number;
  facts: string;
  proposal: string | null;
  stale: number;
}
function operations(db: Database, source: string) {
  const tree = (level: number, slot: number): Counts => {
    const raw = db
      .prepare(`SELECT value FROM ${P}tree WHERE source=? AND level=? AND slot=?`)
      .get(source, level, slot)?.value;
    return raw ? JSON.parse(String(raw)) : zero();
  };
  const excluded = (plan: number, level: number, slot: number) =>
    Number(
      db
        .prepare(`SELECT value FROM ${P}excluded WHERE source=? AND plan=? AND level=? AND slot=?`)
        .get(source, plan, level, slot)?.value ?? 0,
    );
  const updateTree = (ordinal: number, delta: Counts, sign = 1) => {
    const put = prepareClinicalReviewMaintenance(
      db,
      'reader',
      `INSERT INTO ${P}tree VALUES(?,?,?,?) ON CONFLICT(source,level,slot) DO UPDATE SET value=excluded.value`,
    );
    for (let level = 0; level <= ROOT_LEVEL; level++) {
      const slot = Math.floor(ordinal / 2 ** level);
      put.run(source, level, slot, JSON.stringify(validate(plus(tree(level, slot), delta, sign))));
    }
  };
  const updateExcluded = (plan: PlanRow, ordinal: number, delta: number) => {
    const put = prepareClinicalReviewMaintenance(
      db,
      'reader',
      `INSERT INTO ${P}excluded VALUES(?,?,?,?,?) ON CONFLICT(source,plan,level,slot) DO UPDATE SET value=excluded.value`,
    );
    for (
      let level = 0, height = Math.ceil(Math.log2(Math.max(1, plan.unitCount)));
      level <= height;
      level++
    ) {
      const slot = Math.floor(ordinal / 2 ** level),
        value = excluded(plan.ordinal, level, slot) + delta;
      if (value < 0) throw Error('Invalid reader exclusion count');
      put.run(source, plan.ordinal, level, slot, value);
    }
  };
  const plan = (ordinal: number) =>
    db
      .prepare(
        `SELECT ordinal,address,unitCount,eligible,summary FROM ${P}plans WHERE source=? AND ordinal=?`,
      )
      .get(source, ordinal) as PlanRow | undefined;
  const unit = (plan: number, ordinal: number) =>
    db
      .prepare(
        `SELECT plan,ordinal,facts,proposal,stale FROM ${P}units WHERE source=? AND plan=? AND ordinal=?`,
      )
      .get(source, plan, ordinal) as UnitRow | undefined;
  return { tree, excluded, updateTree, updateExcluded, plan, unit };
}
function registerDependencies(db: Database, source: string, proposalId: string) {
  prepareClinicalReviewMaintenance(
    db,
    'reader',
    `DELETE FROM ${P}dependencies WHERE source=? AND proposal=?`,
  ).run(source, proposalId);
  const insert = prepareClinicalReviewMaintenance(
      db,
      'reader',
      `INSERT OR IGNORE INTO ${P}dependencies VALUES(?,?,?)`,
    ),
    put = (key: string) => insert.run(key, source, proposalId);
  put('meta:intake_proposal_dependencies:v1:' + proposalId);
  const raw = db
    .prepare('SELECT value FROM app_meta WHERE key=?')
    .get('intake_proposal_dependencies:v1:' + proposalId)?.value;
  if (typeof raw !== 'string') {
    put('meta:intake_source_pin:v1:' + source);
    put('source:' + source);
    return;
  }
  let value: { format?: string; sources?: unknown[] };
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  }
  if (value?.format !== 'intake-proposal-dependencies-v1' || !Array.isArray(value.sources)) return;
  for (const item of value.sources) {
    if (!item || typeof item !== 'object') continue;
    const dependency = item as {
      intakeId?: unknown;
      pages?: { page?: unknown }[];
      spans?: { spanId?: unknown }[];
      member?: { rootIntakeId?: unknown; memberId?: unknown };
    };
    if (typeof dependency.intakeId !== 'string') continue;
    if (Array.isArray(dependency.pages))
      for (const page of dependency.pages)
        if (Number.isSafeInteger(page?.page))
          put('meta:intake_source_page_hash:v1:' + dependency.intakeId + ':' + page.page);
    if (Array.isArray(dependency.spans))
      for (const span of dependency.spans)
        if (typeof span?.spanId === 'string')
          put('meta:intake_source_span_hash:v1:' + dependency.intakeId + ':' + span.spanId);
    if (dependency.member) {
      put('source:' + dependency.intakeId);
      if (
        typeof dependency.member.rootIntakeId === 'string' &&
        typeof dependency.member.memberId === 'string'
      ) {
        put('source:' + dependency.member.rootIntakeId);
        put(roleKey(dependency.member.rootIntakeId, dependency.member.memberId));
      }
    }
  }
}
function drainDirty(db: Database) {
  const keys = db.prepare(`SELECT key FROM ${P}dirty ORDER BY key LIMIT 64`).all();
  const mark = prepareClinicalReviewMaintenance(
      db,
      'reader',
      `INSERT OR IGNORE INTO ${P}dirty_proposals SELECT source,proposal FROM ${P}dependencies WHERE key=?`,
    ),
    remove = prepareClinicalReviewMaintenance(db, 'reader', `DELETE FROM ${P}dirty WHERE key=?`);
  for (const row of keys) {
    mark.run(row.key);
    remove.run(row.key);
  }
  return keys.length;
}
function clearSource(db: Database, id: string) {
  for (const table of [
    'plans',
    'units',
    'tree',
    'excluded',
    'proposals',
    'dependencies',
    'dirty_proposals',
    'transitions',
    'effects',
    'path',
  ])
    prepareClinicalReviewMaintenance(db, 'reader', `DELETE FROM ${P}${table} WHERE source=?`).run(
      id,
    );
  prepareClinicalReviewMaintenance(db, 'reader', `DELETE FROM ${P}sources WHERE id=?`).run(id);
}
/** Complete cold traversal is explicit. Warm work follows only closed command
 * effects and coalesced changed dependency keys. No pending row per implicit unit. */
export async function prepareCollectionReaderCoverage(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  options: { assertRunning?: () => void; onCheckpoint?: () => void | Promise<void> } = {},
): Promise<void> {
  if (db.isTransaction) throw Error('Prepare reader observations outside publication');
  assertIntakeOwner(db, profileId);
  const store = ensure(db);
  await prepareRetainedPlanAccess(db, profileId, id, options);
  const view = openIntakeCollectionEnvelope(db, { id }),
    intake = view.child(view.root(), 'intake')!,
    workflow = view.child(intake, 'workflow'),
    logical = JSON.stringify(view.logical),
    sourceHash = selectedEnvelopeStore(db, { id }).source.sha256!;
  const publicVersion = intakeSourceVersion(db, id).version,
    selectedGeneration = generation(db);
  let inspected = 0,
    initialized = false,
    selectionChecked = false,
    expectedRun: string | undefined;
  const run = randomUUID();
  const assertCurrent = () => {
    assertIntakeOwner(db, profileId);
    options.assertRunning?.();
    if (
      checked(db) !== store ||
      generation(db) !== selectedGeneration ||
      intakeSourceVersion(db, id).version !== publicVersion ||
      JSON.stringify(openIntakeCollectionEnvelope(db, { id }).logical) !== logical
    )
      throw pending();
    if (initialized && db.prepare(`SELECT run FROM ${P}sources WHERE id=?`).get(id)?.run !== run)
      throw pending();
    if (
      !initialized &&
      selectionChecked &&
      db.prepare(`SELECT run FROM ${P}sources WHERE id=?`).get(id)?.run !== expectedRun
    )
      throw pending();
  };
  const checkpoint = async (force = false) => {
    if (force || ++inspected % 64 === 0) {
      await options.onCheckpoint?.();
      await setImmediate();
      assertCurrent();
    }
  };
  while (drainDirty(db)) await checkpoint(true);
  let selected = db
    .prepare(`SELECT logical,sourceHash,ready,run FROM ${P}sources WHERE id=?`)
    .get(id) as { logical: string; sourceHash: string; ready: number; run: string } | undefined;
  expectedRun = selected?.run;
  selectionChecked = true;
  if (selected?.ready && selected.sourceHash === sourceHash) {
    let target = logical;
    while (target !== selected.logical) {
      const previous = db
        .prepare(`SELECT before FROM ${P}transitions WHERE source=? AND after=?`)
        .get(id, target)?.before;
      if (
        typeof previous !== 'string' ||
        db
          .prepare(`SELECT 1 FROM ${P}path WHERE source=? AND run=? AND after=?`)
          .get(id, run, target)
      ) {
        selected = undefined;
        break;
      }
      prepareClinicalReviewMaintenance(db, 'reader', `INSERT INTO ${P}path VALUES(?,?,?)`).run(
        id,
        run,
        target,
      );
      target = previous;
      await checkpoint();
    }
  } else selected = undefined;
  const cold = !selected;
  assertCurrent();
  if (cold) {
    clearSource(db, id);
    prepareClinicalReviewMaintenance(
      db,
      'reader',
      `INSERT INTO ${P}sources VALUES(?,?,?,0,?,?)`,
    ).run(id, logical, sourceHash, selectedGeneration, run);
  } else
    prepareClinicalReviewMaintenance(
      db,
      'reader',
      `UPDATE ${P}sources SET ready=0,run=? WHERE id=?`,
    ).run(run, id);
  initialized = true;
  const op = operations(db, id);
  const currentProposal = (proposalId: string) => {
    const saved = db
      .prepare(`SELECT current FROM ${P}proposals WHERE source=? AND id=?`)
      .get(id, proposalId);
    if (saved) return !!saved.current;
    withIntakeWork(db, cold ? 'reconstruction' : 'warm', () =>
      recordIntakeWork('readerCoverageDependencyChecks'),
    );
    const current = collectionReaderProposalCurrent(db, id, view, proposalId);
    prepareClinicalReviewMaintenance(db, 'reader', `INSERT INTO ${P}proposals VALUES(?,?,?)`).run(
      id,
      proposalId,
      Number(current),
    );
    registerDependencies(db, id, proposalId);
    return current;
  };
  const applyUnit = (
    ordinal: number,
    unitOrdinal: number,
    facts: CollectionReaderUnitFacts,
    forcedCurrent?: boolean,
  ) => {
    withIntakeWork(db, cold ? 'reconstruction' : 'warm', () =>
      recordIntakeWork(cold ? 'readerCoverageColdUnits' : 'readerCoverageChangedUnits'),
    );
    const plan = op.plan(ordinal);
    if (!plan || unitOrdinal < 0 || unitOrdinal >= plan.unitCount)
      throw Error('Reader changed unit is outside its plan');
    const old = op.unit(ordinal, unitOrdinal),
      prior: CollectionReaderUnitFacts | undefined = old ? JSON.parse(old.facts) : undefined;
    const proposal = facts.coverageKind && facts.proposalId ? facts.proposalId : null;
    const stale =
      !!facts.coverageKind && (!proposal || !(forcedCurrent ?? currentProposal(proposal)));
    const next = contribution(facts, stale),
      before = contribution(prior, !!old?.stale),
      delta = plus(next, before, -1);
    const summary = validate(plus(JSON.parse(plan.summary), delta));
    prepareClinicalReviewMaintenance(
      db,
      'reader',
      `UPDATE ${P}plans SET summary=? WHERE source=? AND ordinal=?`,
    ).run(JSON.stringify(summary), id, ordinal);
    if (fields.some((key) => delta[key]) && plan.eligible) op.updateTree(ordinal, delta);
    if (next.relevant !== before.relevant)
      op.updateExcluded(plan, unitOrdinal, before.relevant - next.relevant);
    if (facts.status === 'pending' && !facts.coverageKind)
      prepareClinicalReviewMaintenance(
        db,
        'reader',
        `DELETE FROM ${P}units WHERE source=? AND plan=? AND ordinal=?`,
      ).run(id, ordinal, unitOrdinal);
    else
      prepareClinicalReviewMaintenance(
        db,
        'reader',
        `INSERT INTO ${P}units VALUES(?,?,?,?,?,?) ON CONFLICT(source,plan,ordinal) DO UPDATE SET facts=excluded.facts,proposal=excluded.proposal,stale=excluded.stale`,
      ).run(id, ordinal, unitOrdinal, JSON.stringify(facts), proposal, Number(stale));
    if (
      old?.proposal &&
      old.proposal !== proposal &&
      !db
        .prepare(`SELECT 1 FROM ${P}units WHERE source=? AND proposal=? LIMIT 1`)
        .get(id, old.proposal)
    ) {
      prepareClinicalReviewMaintenance(
        db,
        'reader',
        `DELETE FROM ${P}proposals WHERE source=? AND id=?`,
      ).run(id, old.proposal);
      prepareClinicalReviewMaintenance(
        db,
        'reader',
        `DELETE FROM ${P}dependencies WHERE source=? AND proposal=?`,
      ).run(id, old.proposal);
    }
  };
  const preparePlan = async (address: string) => {
    const record = view.resolve(address),
      ordinal = intakeEnvelopeRecordOrder(view, record).at(-1)!;
    if (
      !workflow ||
      !Number.isSafeInteger(ordinal) ||
      view.address(view.childAt(workflow, 'plans', ordinal)!) !== address
    )
      throw Error('Foreign changed reader plan');
    const plan = openCollectionReaderPlan(db, root, profileId, id, address),
      old = op.plan(ordinal),
      eligible = Number(plan.status === 'active' && plan.sourceHash === sourceHash);
    if (old && (old.address !== address || old.unitCount !== plan.unitCount))
      throw Error('Reader plan membership changed without replacement');
    const summary = defaultCounts(plan.unitCount);
    if (old) {
      if (old.eligible === eligible) return;
      if (old.eligible) {
        op.updateTree(ordinal, JSON.parse(old.summary), -1);
        while (true) {
          const proposal = db
            .prepare(
              `SELECT proposal FROM ${P}units WHERE source=? AND plan=? AND proposal IS NOT NULL LIMIT 1`,
            )
            .get(id, ordinal)?.proposal;
          if (typeof proposal !== 'string') break;
          prepareClinicalReviewMaintenance(
            db,
            'reader',
            `DELETE FROM ${P}units WHERE source=? AND plan=? AND proposal=?`,
          ).run(id, ordinal, proposal);
          if (
            !db
              .prepare(`SELECT 1 FROM ${P}units WHERE source=? AND proposal=? LIMIT 1`)
              .get(id, proposal)
          ) {
            prepareClinicalReviewMaintenance(
              db,
              'reader',
              `DELETE FROM ${P}proposals WHERE source=? AND id=?`,
            ).run(id, proposal);
            prepareClinicalReviewMaintenance(
              db,
              'reader',
              `DELETE FROM ${P}dependencies WHERE source=? AND proposal=?`,
            ).run(id, proposal);
          }
          await checkpoint();
        }
        prepareClinicalReviewMaintenance(
          db,
          'reader',
          `DELETE FROM ${P}units WHERE source=? AND plan=?`,
        ).run(id, ordinal);
        prepareClinicalReviewMaintenance(
          db,
          'reader',
          `DELETE FROM ${P}excluded WHERE source=? AND plan=?`,
        ).run(id, ordinal);
      }
      prepareClinicalReviewMaintenance(
        db,
        'reader',
        `UPDATE ${P}plans SET eligible=?,summary=? WHERE source=? AND ordinal=?`,
      ).run(eligible, JSON.stringify(summary), id, ordinal);
    } else
      prepareClinicalReviewMaintenance(
        db,
        'reader',
        `INSERT INTO ${P}plans VALUES(?,?,?,?,?,?)`,
      ).run(id, ordinal, address, plan.unitCount, eligible, JSON.stringify(summary));
    if (eligible) op.updateTree(ordinal, summary);
    if (!eligible) return;
    if (plan.format === 'retained') {
      for (let n = 0; n < plan.unitCount; n++) {
        applyUnit(ordinal, n, plan.facts(n));
        await checkpoint();
      }
    } else
      for (const n of plan.changedOrdinals()) {
        applyUnit(ordinal, n, plan.facts(n));
        await checkpoint();
      }
  };
  try {
    if (cold) {
      for (let n = 0, total = workflow ? view.childCount(workflow, 'plans') : 0; n < total; n++) {
        await preparePlan(view.address(view.childAt(workflow!, 'plans', n)!));
        await checkpoint();
      }
    } else {
      // All effects are re-read from the actual final selection. Coalescing
      // repeated commands visits each distinct changed unit only once.
      for (const effect of db
        .prepare(
          `SELECT e.kind,e.key,e.value FROM ${P}effects e JOIN ${P}path p ON p.source=e.source AND p.after=e.after WHERE e.source=? AND p.run=? GROUP BY e.kind,e.key ORDER BY e.kind,e.key`,
        )
        .iterate(id, run)) {
        if (effect.kind === 'plan') await preparePlan(String(effect.value));
        else if (effect.kind === 'unit') {
          const [address, unitId] = JSON.parse(String(effect.value)) as [string, string],
            plan = openCollectionReaderPlan(db, root, profileId, id, address),
            ordinal = db
              .prepare(`SELECT ordinal FROM ${P}plans WHERE source=? AND address=?`)
              .get(id, address)?.ordinal,
            unitOrdinal = plan.ordinalOf(unitId);
          if (typeof ordinal !== 'number' || unitOrdinal === undefined)
            throw Error('Changed reader unit has no complete plan index');
          if (op.plan(ordinal)?.eligible) applyUnit(ordinal, unitOrdinal, plan.facts(unitOrdinal));
        } else
          prepareClinicalReviewMaintenance(
            db,
            'reader',
            `INSERT OR IGNORE INTO ${P}dirty_proposals VALUES(?,?)`,
          ).run(id, effect.value);
        await checkpoint();
      }
    }
    while (true) {
      const dirty = db
        .prepare(
          `SELECT proposal FROM ${P}dirty_proposals WHERE source=? ORDER BY proposal LIMIT 1`,
        )
        .get(id)?.proposal;
      if (typeof dirty !== 'string') break;
      if (db.prepare(`SELECT 1 FROM ${P}proposals WHERE source=? AND id=?`).get(id, dirty)) {
        withIntakeWork(db, 'warm', () => recordIntakeWork('readerCoverageDependencyChecks'));
        const current = collectionReaderProposalCurrent(db, id, view, dirty);
        registerDependencies(db, id, dirty);
        prepareClinicalReviewMaintenance(
          db,
          'reader',
          `UPDATE ${P}proposals SET current=? WHERE source=? AND id=?`,
        ).run(Number(current), id, dirty);
        for (const unit of db
          .prepare(
            `SELECT plan,ordinal,facts,proposal,stale FROM ${P}units WHERE source=? AND proposal=? ORDER BY plan,ordinal`,
          )
          .iterate(id, dirty) as Iterable<UnitRow>) {
          applyUnit(unit.plan, unit.ordinal, JSON.parse(unit.facts), current);
          await checkpoint();
        }
      }
      prepareClinicalReviewMaintenance(
        db,
        'reader',
        `DELETE FROM ${P}dirty_proposals WHERE source=? AND proposal=?`,
      ).run(id, dirty);
      await checkpoint();
    }
    assertCurrent();
    prepareClinicalReviewMaintenance(
      db,
      'reader',
      `UPDATE ${P}sources SET logical=?,ready=1,generation=? WHERE id=?`,
    ).run(logical, selectedGeneration, id);
    prepareClinicalReviewMaintenance(db, 'reader', `DELETE FROM ${P}effects WHERE source=?`).run(
      id,
    );
    prepareClinicalReviewMaintenance(
      db,
      'reader',
      `DELETE FROM ${P}transitions WHERE source=?`,
    ).run(id);
    prepareClinicalReviewMaintenance(
      db,
      'reader',
      `DELETE FROM ${P}path WHERE source=? AND run=?`,
    ).run(id, run);
  } catch (error) {
    prepareClinicalReviewMaintenance(
      db,
      'reader',
      `UPDATE ${P}sources SET ready=0 WHERE id=? AND run=?`,
    ).run(id, run);
    throw error;
  }
}
export function readCollectionReaderCoverage(
  db: Database,
  profileId: string,
  id: string,
  input: { offset: number; limit: number },
) {
  assertIntakeOwner(db, profileId);
  checked(db);
  if (
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 50
  )
    throw new HttpError(
      400,
      'SOURCE_TEXT_INVALID',
      'Choose a reader offset and limit from 1 to 50',
    );
  const view = openIntakeCollectionEnvelope(db, { id }),
    logical = JSON.stringify(view.logical),
    version = intakeSourceVersion(db, id).version;
  const assertCurrent = () => {
    assertIntakeOwner(db, profileId);
    checked(db);
    const row = db.prepare(`SELECT logical,ready,generation FROM ${P}sources WHERE id=?`).get(id);
    if (
      !row?.ready ||
      row.logical !== logical ||
      row.generation !== generation(db) ||
      intakeSourceVersion(db, id).version !== version ||
      JSON.stringify(openIntakeCollectionEnvelope(db, { id }).logical) !== logical
    )
      throw pending();
  };
  assertCurrent();
  const op = operations(db, id),
    counts = validate(op.tree(ROOT_LEVEL, 0)),
    entries: { planAddress: string; planOrdinal: number; unitOrdinal: number; stale: boolean }[] =
      [];
  for (
    let index = input.offset;
    index < Math.min(counts.relevant, input.offset + input.limit);
    index++
  ) {
    let rank = index,
      slot = 0;
    for (let level = ROOT_LEVEL - 1; level >= 0; level--) {
      const left = slot * 2,
        size = op.tree(level, left).relevant;
      if (rank < size) slot = left;
      else {
        rank -= size;
        slot = left + 1;
      }
    }
    const plan = op.plan(slot);
    if (!plan?.eligible) throw Error('Reader rank selected an unavailable plan');
    let unit = 0;
    for (let level = Math.ceil(Math.log2(Math.max(1, plan.unitCount))) - 1; level >= 0; level--) {
      const left = unit * 2,
        start = left * 2 ** level,
        size =
          Math.max(0, Math.min(2 ** level, plan.unitCount - start)) -
          op.excluded(plan.ordinal, level, left);
      if (rank < size) unit = left;
      else {
        rank -= size;
        unit = left + 1;
      }
    }
    if (unit >= plan.unitCount || rank !== 0)
      throw Error('Reader rank is outside its selected unit count');
    entries.push({
      planAddress: plan.address,
      planOrdinal: plan.ordinal,
      unitOrdinal: unit,
      stale: !!op.unit(plan.ordinal, unit)?.stale,
    });
  }
  assertCurrent();
  const { relevant: total, ...summary } = counts;
  return { summary, total, entries, assertCurrent };
}
