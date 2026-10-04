/** Complete disposable routing, certified only after scanning one selected intake root.
 * TEMP rows share the profile connection lifetime; no source/group-sized JS cache. */
import { setImmediate } from 'node:timers/promises';
import { HttpError, type Database } from './database.ts';
import { recordIntakeWork, withIntakeWork } from './intake-work-accounting.ts';
import { intakeCollectionCacheGeneration } from './intake-state-collections.ts';

const prefix = '__report_source_routing';
const ddl = [
  `CREATE TEMP TABLE ${prefix}(source TEXT PRIMARY KEY,binding TEXT NOT NULL,ready INTEGER NOT NULL) WITHOUT ROWID`,
  `CREATE TEMP TABLE ${prefix}_owners(source TEXT,candidate TEXT,version TEXT,groupId TEXT,basis INTEGER,PRIMARY KEY(source,candidate,version)) WITHOUT ROWID`,
  `CREATE TEMP TABLE ${prefix}_drafts(source TEXT,identity TEXT,disposition TEXT,PRIMARY KEY(source,identity)) WITHOUT ROWID`,
  ...(['owners', 'drafts'] as const).flatMap((table) =>
    (['INSERT', 'UPDATE', 'DELETE'] as const).map(
      (event) =>
        `CREATE TEMP TRIGGER ${prefix}_${table}_${event} AFTER ${event} ON ${prefix}_${table} BEGIN UPDATE ${prefix} SET ready=0 WHERE source=${event === 'DELETE' ? 'OLD' : 'NEW'}.source${event === 'UPDATE' ? ' OR source=OLD.source' : ''}; END`,
    ),
  ),
];
type Owner = { kind: 'owner'; candidate: string; version: string; groupId: string; basis: number };
type Draft = { kind: 'draft'; identity: string; disposition: string };
const preparing = new WeakMap<Database, Promise<void>>();
interface State {
  version: number;
  signature: string;
  stamp: string;
  registry: object;
  /** Eviction affects only preparation work, never the available product scope. */
  proofs: Map<string, string>;
}
const schemas = new WeakMap<Database, State>();
const stamp = (db: Database) => {
  const read = db.prepare(
    'SELECT total_changes() AS changes,(SELECT data_version FROM pragma_data_version) AS external,(SELECT schema_version FROM pragma_schema_version) AS mainSchema',
  );
  read.setReadBigInts(true);
  return Object.values(read.get()!).map(String).join(':') + ':' + schemaVersion(db);
};
const unavailable = () =>
  new HttpError(409, 'REPORT_SOURCE_SCOPE', 'Refresh this complete report source scope');
const schemaVersion = (db: Database) =>
  Number(db.prepare('PRAGMA temp.schema_version').get()!.schema_version);
const schema = (db: Database) =>
  JSON.stringify(
    db
      .prepare(
        'SELECT type,name,sql FROM sqlite_temp_schema WHERE name GLOB ? OR tbl_name GLOB ? ORDER BY type,name',
      )
      .all(prefix + '*', prefix + '*'),
  );
function ensure(db: Database) {
  const retained = schemas.get(db),
    version = schemaVersion(db);
  if (retained?.version === version) return retained;
  const actual = schema(db);
  if (retained && retained.signature === actual) {
    retained.version = version;
    return retained;
  }
  for (const table of ['owners', 'drafts', ''])
    db.exec(`DROP TABLE IF EXISTS temp.${prefix}${table ? '_' + table : ''}`);
  for (const sql of ddl) db.exec(sql);
  const state = {
    version: schemaVersion(db),
    signature: schema(db),
    stamp: stamp(db),
    registry: intakeCollectionCacheGeneration(db),
    proofs: new Map<string, string>(),
  };
  schemas.set(db, state);
  return state;
}

export async function prepareReportSourceRouting(
  db: Database,
  input: {
    sourceId: string;
    binding: string;
    assertCurrent(): void;
    rows(): Iterable<Owner | Draft>;
  },
) {
  if (db.isTransaction)
    throw Error('Report source routing requires outside-transaction preparation');
  input.assertCurrent();
  while (preparing.has(db)) {
    await preparing.get(db);
    input.assertCurrent();
  }
  let state = ensure(db);
  const currentState = () => {
    state = ensure(db);
    const actual = stamp(db);
    const registry = intakeCollectionCacheGeneration(db);
    if (actual !== state.stamp || registry !== state.registry || db.isTransaction) {
      state.proofs.clear();
      state.stamp = actual;
      state.registry = registry;
    }
    return state;
  };
  const ready = () => {
    input.assertCurrent();
    const current = currentState();
    if (current.proofs.get(input.sourceId) !== input.binding) return false;
    const row = db
      .prepare(`SELECT binding,ready FROM ${prefix} WHERE source=?`)
      .get(input.sourceId);
    return row?.ready === 1 && row.binding === input.binding;
  };
  if (!ready()) {
    const prepare = async () => {
      currentState();
      state.proofs.delete(input.sourceId);
      const ownWrite = (write: () => void) => {
        if (
          db.isTransaction ||
          stamp(db) !== state.stamp ||
          intakeCollectionCacheGeneration(db) !== state.registry
        ) {
          state.proofs.clear();
          throw unavailable();
        }
        const before = state.stamp;
        write();
        const after = stamp(db);
        if (
          after.slice(after.indexOf(':')) !== before.slice(before.indexOf(':')) ||
          intakeCollectionCacheGeneration(db) !== state.registry
        ) {
          state.proofs.clear();
          throw unavailable();
        }
        state.stamp = after;
      };
      ownWrite(() => {
        db.prepare(
          `INSERT INTO ${prefix} VALUES(?,?,0) ON CONFLICT(source) DO UPDATE SET binding=excluded.binding,ready=0`,
        ).run(input.sourceId, input.binding);
        db.prepare(`DELETE FROM ${prefix}_owners WHERE source=?`).run(input.sourceId);
        db.prepare(`DELETE FROM ${prefix}_drafts WHERE source=?`).run(input.sourceId);
      });
      const owner = db.prepare(
          `INSERT INTO ${prefix}_owners VALUES(?,?,?,?,?) ON CONFLICT(source,candidate,version) DO UPDATE SET groupId=excluded.groupId,basis=excluded.basis WHERE excluded.basis>=basis`,
        ),
        draft = db.prepare(
          `INSERT INTO ${prefix}_drafts VALUES(?,?,?) ON CONFLICT(source,identity) DO UPDATE SET disposition=excluded.disposition`,
        );
      // Read a bounded window before writing it. Interleaving every envelope read
      // with a TEMP write needlessly invalidates the storage owner's SQL stamp.
      const window: Array<Owner | Draft> = [];
      const flush = () => {
        if (!window.length) return;
        ownWrite(() => {
          for (const row of window)
            if (row.kind === 'owner')
              owner.run(input.sourceId, row.candidate, row.version, row.groupId, row.basis);
            else draft.run(input.sourceId, row.identity, row.disposition);
        });
        withIntakeWork(db, 'warm', () =>
          recordIntakeWork('reportSourceScopeRoutingRows', window.length),
        );
        window.length = 0;
      };
      for (const row of input.rows()) {
        input.assertCurrent();
        window.push(row);
        if (window.length === 64) {
          flush();
          await setImmediate();
          input.assertCurrent();
        }
      }
      flush();
      input.assertCurrent();
      ownWrite(() =>
        db
          .prepare(`UPDATE ${prefix} SET ready=1 WHERE source=? AND binding=?`)
          .run(input.sourceId, input.binding),
      );
      state.proofs.set(input.sourceId, input.binding);
      while (state.proofs.size > 32) state.proofs.delete(state.proofs.keys().next().value!);
      withIntakeWork(db, 'warm', () => recordIntakeWork('reportSourceScopeRoutingBuilds'));
    };
    const pending = prepare();
    preparing.set(db, pending);
    try {
      await pending;
    } finally {
      if (preparing.get(db) === pending) preparing.delete(db);
    }
  } else withIntakeWork(db, 'warm', () => recordIntakeWork('reportSourceScopeRoutingReuses'));
  if (!ready()) throw unavailable();
  const checked = () => {
    if (!ready()) throw unavailable();
  };
  return {
    owner(candidate: string, version: string) {
      checked();
      return db
        .prepare(
          `SELECT groupId FROM ${prefix}_owners WHERE source=? AND candidate=? AND version=?`,
        )
        .get(input.sourceId, candidate, version)?.groupId;
    },
    disposition(identity: string) {
      checked();
      return db
        .prepare(`SELECT disposition FROM ${prefix}_drafts WHERE source=? AND identity=?`)
        .get(input.sourceId, identity)?.disposition;
    },
  };
}
