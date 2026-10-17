/** Fictional real partial saves. Counters measure logical host/storage work; no provider calls. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import * as intake from '../intake.ts';
import { prepareCollectionReviewMembership } from '../intake-review-membership-index.ts';
import { prepareCollectionClinicalReviewAsync } from '../intake-review-collection-host.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { planIntakeReportAcceptance } from '../intake-acceptance-plan.ts';
import { prepareIntakeLookupProjection } from '../intake-lookup-projection.ts';
import { iterateIntakeEnvelopeText } from '../intake-collection-envelope.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { createIntakeFileWorkCounters, withIntakeFileWork } from '../intake-file-work.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import { attachRecordDurability, rebuildRecordDatabase } from '../record-versions.ts';
import {
  openContributorRecordStorage,
  contributorAuthorityPath,
  observeContributorRecordStorageWork,
} from '../contributor-record-storage.ts';
import {
  acceptIntakeReportSelectionAsync,
  getIntakeReportAcceptance,
} from '../intake-report-acceptance.ts';
import {
  recordVersionWorkInventory,
  recordVersionSequence,
  encodedRecordObjectInventory,
} from './helpers/record-version-work-inventory.ts';
import type {
  HealthRecordEnvelope,
  IntakeReportAcceptanceBlock,
  IntakeReportAcceptanceRequest,
} from '../../shared/intake.ts';

type Path = 'legacy' | 'legacy-planned' | 'native';
const qualification = process.env.CRS_PARTIAL_ACCEPTANCE_QUALIFY === '1';
function sourceDigest() {
  const hash = createHash('sha256');
  for (const path of ['../', '../../shared/']) {
    const directory = fileURLToPath(new URL(path, import.meta.url));
    const files = readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter(
        (file) =>
          file.isFile() && /\.(ts|sql)$/.test(file.name) && !file.parentPath.includes('/test'),
      )
      .map((file) => join(file.parentPath, file.name))
      .sort();
    for (const file of files)
      hash.update(file.slice(directory.length)).update('\0').update(readFileSync(file));
  }
  return hash.digest('hex');
}
const loadedSource = sourceDigest();
const fixtureHash = createHash('sha256')
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest('hex');
const compact = (value: Record<string, number>) =>
  Object.fromEntries(Object.entries(value).filter(([, n]) => n));
/** SQL functions record trigger observations without writing TEMP audit rows.
 * Maintenance admission counts actual SQLite writes; an audit must not add any. */
function installMutationAudit(db: ReturnType<typeof openDatabase>) {
  const totals: Record<string, Record<string, number>> = {};
  const auditTriggers = new Map<string, string[]>();
  const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  assert.equal(Number(db.prepare('PRAGMA recursive_triggers').get()!.recursive_triggers), 0);
  db.function('fictional_mutation_observation', (table, event, next, prior) => {
    const counts = (totals[String(table)] ||= {
      inserts: 0,
      updates: 0,
      deletes: 0,
      new_value_bytes: 0,
      old_value_bytes: 0,
    });
    counts[String(event)]!++;
    counts.new_value_bytes! += Number(next);
    counts.old_value_bytes! += Number(prior);
    return null;
  });
  for (const { name } of db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    const table = String(name);
    auditTriggers.set(table, []);
    totals[table] = { inserts: 0, updates: 0, deletes: 0, new_value_bytes: 0, old_value_bytes: 0 };
    const columns = db
      .prepare(`PRAGMA table_info(${quote(table)})`)
      .all()
      .map((column) => String(column.name));
    const bytes = (prefix: string) =>
      columns.map((name) => `COALESCE(length(CAST(${prefix}.${quote(name)} AS BLOB)),0)`).join('+');
    if (table === '__record_state') {
      // SQLite's default nonrecursive REPLACE omits its implicit DELETE trigger.
      // Read the actual preimage before replacement; SQL rollback restores this
      // row, unlike a JavaScript last-size cache of speculative writes.
      const trigger = 'fictional_audit_state_replace_preimage';
      auditTriggers.get(table)!.push(trigger);
      db.exec(
        `CREATE TEMP TRIGGER ${quote(trigger)} BEFORE INSERT ON main.__record_state WHEN EXISTS(SELECT 1 FROM main.__record_state WHERE singleton=NEW.singleton) BEGIN SELECT fictional_mutation_observation('__record_state','deletes',0,(SELECT ${bytes('prior')} FROM main.__record_state prior WHERE prior.singleton=NEW.singleton)); END`,
      );
    }
    for (const [event, metric] of [
      ['INSERT', 'inserts'],
      ['UPDATE', 'updates'],
      ['DELETE', 'deletes'],
    ] as const) {
      auditTriggers.get(table)!.push('fictional_audit_' + table + '_' + event);
      db.exec(
        `CREATE TEMP TRIGGER ${quote('fictional_audit_' + table + '_' + event)} AFTER ${event} ON main.${quote(table)} BEGIN SELECT fictional_mutation_observation('${table.replaceAll("'", "''")}','${metric}',${event === 'DELETE' ? '0' : bytes('NEW')},${event === 'INSERT' ? '0' : bytes('OLD')}); END`,
      );
    }
  }
  const coverage = () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
    const installed = new Set(
      db
        .prepare("SELECT name FROM sqlite_temp_schema WHERE type='trigger'")
        .all()
        .map((row) => String(row.name)),
    );
    return {
      tables,
      recursiveTriggers: Number(db.prepare('PRAGMA recursive_triggers').get()!.recursive_triggers),
      omitted: tables.filter(
        (table) =>
          !auditTriggers.has(table) ||
          auditTriggers.get(table)!.some((trigger) => !installed.has(trigger)),
      ),
    };
  };
  return Object.assign(() => structuredClone(totals), { coverage });
}
function delta(after: Record<string, number>, before: Record<string, number>) {
  return compact(
    Object.fromEntries(Object.entries(after).map(([key, n]) => [key, n - (before[key] || 0)])),
  );
}
function fictionalRecord(index: number): HealthRecordEnvelope {
  const id = `fictional-measure-${String(index).padStart(4, '0')}`;
  return {
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: { literal: '+14.00', ordinal: index },
    provenance: {
      capturedVia: 'Fictional delivery',
      sourceSystem: 'Fictional issuer',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: `page 1 row ${index}`,
    },
    coverage: { status: 'partial', notes: [] },
    clinical: {
      kind: 'observation',
      subject: 'self',
      testLabel: id,
      valueText: '+14.00',
      date: '2026-09',
      unit: 'mg',
    },
  };
}
function fixture(t: TestContext) {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), 'fictional-partial-acceptance-work-')),
  );
  const profileId = 'fictional-partial-work';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  let closeStorage: (() => void) | undefined;
  t.after(() => {
    try {
      clearIntakeStateCache(db);
    } finally {
      try {
        if (db.isOpen) db.close();
      } finally {
        try {
          closeStorage?.();
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  });
  const storage = openContributorRecordStorage(root, profileId, { initialize: true });
  closeStorage = () => storage.close();
  const observation = observeContributorRecordStorageWork(storage, qualification ? 1_000_000 : 0);
  const io = () => observation.snapshot();
  // Inventory is read outside the measured operation. It never wraps or grants
  // factory ownership, and does not pretend to measure physical filesystem I/O.
  const objects = () => {
    const base = contributorAuthorityPath(root, profileId);
    const entries = readdirSync(join(base, 'objects')).map(
      (name) => ['objects/' + name, readFileSync(join(base, 'objects', name))] as const,
    );
    if (existsSync(join(base, 'head'))) entries.push(['head', readFileSync(join(base, 'head'))]);
    return new Map(entries);
  };
  attachRecordDurability(db, { profileId, storage });
  // Build only the empty disposable schema. No source exists to review, index,
  // convert or certify; later source-specific preparation remains measured.
  // This is fixture setup, not a cold post-restart planning qualification.
  assert.equal(Number(db.prepare('SELECT count(*) n FROM source_files').get()!.n), 0);
  const bootstrapBefore = intakeWorkCounters(db);
  const bootstrapIo = io();
  const bootstrapRecords = createRecordVersionWorkCounters();
  withRecordVersionWork(bootstrapRecords, () => prepareIntakeLookupProjection(db));
  assert.equal(Number(db.prepare('SELECT count(*) n FROM source_files').get()!.n), 0);
  for (const metric of ['immutableWrites', 'immutableBytes', 'headWrites', 'headBytes'] as const)
    assert.equal(
      io()[metric],
      bootstrapIo[metric],
      'Empty lookup setup must not publish accepted objects',
    );
  const bootstrapAfter = intakeWorkCounters(db);
  process.stderr.write(
    JSON.stringify({
      audit: 'partial-acceptance-empty-lookup-bootstrap-v1',
      sourceRows: 0,
      source: loadedSource,
      fixtureHash,
      tables: db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB '__record_intake_lookup_*' ORDER BY name",
        )
        .all()
        .map(({ name }) => ({
          name,
          rows: Number(
            db.prepare('SELECT count(*) n FROM "' + String(name).replaceAll('"', '""') + '"').get()!
              .n,
          ),
        })),
      intake: {
        primitive: delta(bootstrapAfter.primitive, bootstrapBefore.primitive),
        warm: delta(bootstrapAfter.warm, bootstrapBefore.warm),
        reconstruction: delta(bootstrapAfter.reconstruction, bootstrapBefore.reconstruction),
      },
      records: {
        operation: compact(bootstrapRecords.operation),
        reconstruction: compact(bootstrapRecords.reconstruction),
      },
      io: delta(io(), bootstrapIo),
    }) + '\n',
  );
  const sql = installMutationAudit(db);
  const inventory = () => {
    const kinds = new Map<string, { count: number; bytes: number }>();
    for (const [name, bytes] of objects()) {
      let kind = name === 'head' ? 'head' : 'record-segment';
      if (name !== 'head') {
        try {
          const value = JSON.parse(bytes.toString());
          if (value.format === 'health-record-segment-page-v1') kind = 'record-segment-index';
          else if (Array.isArray(value.segments) || value.format === 'health-record-versions-v2')
            kind = 'record-commit';
        } catch {
          /* Segments may divide encoded version JSON. */
        }
      }
      const total = kinds.get(kind) || { count: 0, bytes: 0 };
      total.count++;
      total.bytes += bytes.length;
      kinds.set(kind, total);
    }
    const metadata = db
      .prepare('SELECT key,value FROM app_meta')
      .all()
      .reduce(
        (totals, row) => {
          const key = String(row.key);
          const kind = key.startsWith('intake_partial_acceptance:')
            ? 'partial-receipts'
            : key.startsWith('intake_state_v1:')
              ? 'intake-evidence'
              : 'other';
          const total = (totals[kind] ||= { rows: 0, bytes: 0 });
          total.rows++;
          total.bytes += Buffer.byteLength(String(row.value));
          return totals;
        },
        {} as Record<string, { rows: number; bytes: number }>,
      );
    return {
      accepted: Object.fromEntries(kinds),
      metadata,
      versionEntities: db
        .prepare(
          'SELECT entity, count(*) rows, sum(length(CAST(contents_json AS BLOB))) bytes FROM __record_versions GROUP BY entity ORDER BY entity',
        )
        .all(),
      intakeFrames: (() => {
        const groups = new Map<string, { sequence: number; data: string }[]>();
        for (const row of db
          .prepare("SELECT value FROM app_meta WHERE key LIKE 'intake_state_v1:%:frame:%'")
          .all()) {
          const frame = JSON.parse(String(row.value));
          const list = groups.get(frame.operationId) || [];
          list.push({ sequence: frame.sequence, data: frame.data });
          groups.set(frame.operationId, list);
        }
        return [...groups.values()].map((frames) => {
          const payload = Buffer.concat(
            frames
              .sort((a, b) => a.sequence - b.sequence)
              .map((frame) => Buffer.from(frame.data, 'base64')),
          ).toString();
          const value = JSON.parse(payload);
          const changes = Array.isArray(value) ? value : value.changes;
          return {
            bytes: Buffer.byteLength(payload),
            changes: Array.isArray(changes)
              ? changes.reduce(
                  (
                    totals: Record<string, { count: number; bytes: number }>,
                    change: { path?: string[] },
                  ) => {
                    const key = (change.path || []).slice(0, 4).join('/');
                    const total = (totals[key] ||= { count: 0, bytes: 0 });
                    total.count++;
                    total.bytes += Buffer.byteLength(JSON.stringify(change));
                    return totals;
                  },
                  {},
                )
              : undefined,
          };
        });
      })(),
      versions: Number(db.prepare('SELECT count(*) n FROM __record_versions').get()!.n),
      transactions: db
        .prepare(
          'SELECT count(*) rows, sum(length(CAST(result_json AS BLOB))) bytes, max(length(CAST(result_json AS BLOB))) largest FROM __record_transactions',
        )
        .get(),
      tables: db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map(({ name }) => {
          const quoted = '"' + String(name).replaceAll('"', '""') + '"';
          const columns = db
            .prepare(`PRAGMA table_info(${quoted})`)
            .all()
            .map(
              (column) =>
                'COALESCE(length(CAST("' +
                String(column.name).replaceAll('"', '""') +
                '" AS BLOB)),0)',
            );
          return {
            table: String(name),
            ...db
              .prepare(
                `SELECT count(*) rows, COALESCE(sum(${columns.join('+')}),0) bytes FROM ${quoted}`,
              )
              .get(),
          };
        }),
    };
  };
  const measure = async <T>(stage: string, action: () => T | Promise<T>) => {
    process.stderr.write(`Counted partial acceptance: ${stage} started\n`);
    const sourceBefore = sourceDigest();
    assert.equal(sourceBefore, loadedSource, 'Server source changed since qualification started');
    assert.deepEqual(sql.coverage().omitted, [], 'SQL mutation audit is incomplete before stage');
    assert.equal(
      sql.coverage().recursiveTriggers,
      0,
      'SQL replacement audit requires the default nonrecursive triggers',
    );
    const before = intakeWorkCounters(db);
    const beforeIo = io();
    const beforeSql = sql();
    const beforeSequence = qualification ? recordVersionSequence(db) : 0;
    const beforeVersionRows = qualification
      ? Number(db.prepare('SELECT count(*) n FROM __record_versions').get()!.n)
      : 0;
    const beforeEvent = qualification ? observation.eventCount() : 0;
    const records = createRecordVersionWorkCounters();
    const files = createIntakeFileWorkCounters();
    let reviews = 0;
    const restore = intake.observeIntakeReviewCalls(() => reviews++);
    const heartbeat = qualification
      ? setInterval(() => {
          const progress = intakeWorkCounters(db);
          process.stderr.write(
            JSON.stringify({
              audit: 'partial-acceptance-progress-v1',
              stage,
              io: delta(io(), beforeIo),
              intake: {
                primitive: delta(progress.primitive, before.primitive),
                warm: delta(progress.warm, before.warm),
                reconstruction: delta(progress.reconstruction, before.reconstruction),
              },
            }) + '\n',
          );
        }, 10_000)
      : undefined;
    let result: T;
    try {
      result = await withRecordVersionWork(records, () => withIntakeFileWork(files, action));
    } finally {
      clearInterval(heartbeat);
      restore();
    }
    const after = intakeWorkCounters(db);
    const sqlDelta = Object.fromEntries(
      Object.entries(sql())
        .map(([name, counts]) => [name, delta(counts, beforeSql[name] || {})])
        .filter(([, counts]) => Object.keys(counts).length),
    );
    const measuredEvents = qualification ? observation.events(beforeEvent) : undefined;
    if (measuredEvents)
      assert.equal(measuredEvents.dropped, 0, 'Factory write attribution overflow');
    const work = {
      audit: 'partial-acceptance-work-v1',
      stage,
      ioScope:
        'successful logical genuine contributor factory transport; includes private staged writes and HEAD installation; excludes failed physical installations, physical readback, hashing and certificate scans',
      sourceBefore,
      sourceAfter: sourceDigest(),
      fixtureHash,
      reviews,
      io: delta(io(), beforeIo),
      files: compact(files),
      records: {
        operation: compact(records.operation),
        reconstruction: compact(records.reconstruction),
      },
      intake: {
        primitive: delta(after.primitive, before.primitive),
        warm: delta(after.warm, before.warm),
        reconstruction: delta(after.reconstruction, before.reconstruction),
      },
      sql: sqlDelta,
      sqlAudit: sql.coverage(),
      inventory: inventory(),
      attribution: qualification
        ? {
            versions: recordVersionWorkInventory(db, beforeSequence),
            objects: encodedRecordObjectInventory(objects(), measuredEvents!.events, 0),
          }
        : undefined,
    };
    process.stderr.write(JSON.stringify(work) + '\n');
    if (work.attribution) {
      assert.equal(
        work.attribution.versions.buckets.reduce((sum, bucket) => sum + Number(bucket.rows), 0),
        work.inventory.versions - beforeVersionRows,
      );
      assert.equal(
        Object.values(work.attribution.objects.families).reduce(
          (sum, family) => sum + family.writes,
          0,
        ),
        work.io.immutableWrites || 0,
      );
      assert.equal(
        Object.values(work.attribution.objects.families).reduce(
          (sum, family) => sum + family.bytes,
          0,
        ),
        work.io.immutableBytes || 0,
      );
    }
    assert.deepEqual(
      work.sqlAudit.omitted,
      [],
      'SQL mutation audit missed late-created or recreated main tables',
    );
    assert.equal(
      work.sqlAudit.recursiveTriggers,
      0,
      'SQL replacement audit configuration changed during stage',
    );
    assert.equal(
      work.sourceAfter,
      work.sourceBefore,
      'Server source changed during the measured stage; rerun with a stable source tree',
    );
    return { result, work };
  };
  return {
    db,
    root,
    profileId,
    storage,
    objects,
    measure,
    io,
    sqlAudit: sql.coverage,
    sqlMutations: sql,
  };
}
type Fixture = ReturnType<typeof fixture>;
type Work = Awaited<ReturnType<Fixture['measure']>>['work'];
function sum(values: Record<string, number>[]) {
  const total: Record<string, number> = {};
  for (const value of values)
    for (const [key, amount] of Object.entries(value)) total[key] = (total[key] || 0) + amount;
  return total;
}
function publication(works: Work[]) {
  const tables = new Set(works.flatMap((work) => Object.keys(work.sql)));
  return {
    io: sum(works.map((work) => work.io)),
    sql: Object.fromEntries(
      [...tables].map((table) => [table, sum(works.map((work) => work.sql[table] || {}))]),
    ),
    frames: works.reduce((n, work) => n + (work.intake.primitive.framesWritten || 0), 0),
    frameBytes: works.reduce((n, work) => n + (work.intake.primitive.frameBytesWritten || 0), 0),
    versionBytes: works.reduce(
      (n, work) => n + (work.sql.__record_versions?.new_value_bytes || 0),
      0,
    ),
    transactionBytes: works.reduce(
      (n, work) => n + (work.sql.__record_transactions?.new_value_bytes || 0),
      0,
    ),
  };
}
function assertProportional(
  small: ReturnType<typeof publication>,
  large: ReturnType<typeof publication>,
  context: string,
) {
  assert.ok(
    (large.io.immutableWrites || 0) <= 4 * (small.io.immutableWrites || 0) + 8,
    `${context}: accepted objects`,
  );
  assert.ok(
    (large.io.immutableBytes || 0) <= 4 * (small.io.immutableBytes || 0) + 65536,
    `${context}: accepted bytes`,
  );
  assert.ok(
    (large.io.headWrites || 0) <= 4 * (small.io.headWrites || 0) + 4,
    `${context}: accepted heads`,
  );
  assert.ok(
    (large.io.headBytes || 0) <= 4 * (small.io.headBytes || 0) + 65536,
    `${context}: accepted head bytes`,
  );
  assert.ok(large.frames <= 4 * small.frames + 8, `${context}: intake frame count`);
  assert.ok(large.frameBytes <= 4 * small.frameBytes + 65536, `${context}: intake frame bytes`);
  assert.ok(large.versionBytes <= 4 * small.versionBytes + 65536, `${context}: version SQL bytes`);
  assert.ok(
    large.transactionBytes <= 4 * small.transactionBytes + 65536,
    `${context}: transaction SQL bytes`,
  );
  for (const [table, counts] of Object.entries(large.sql)) {
    const prior = small.sql[table] || {};
    for (const metric of ['inserts', 'updates', 'deletes'])
      assert.ok(
        (counts[metric] || 0) <= 4 * (prior[metric] || 0) + 8,
        `${context}: ${table} ${metric}`,
      );
    for (const metric of ['new_value_bytes', 'old_value_bytes'])
      assert.ok(
        (counts[metric] || 0) <= 4 * (prior[metric] || 0) + 65536,
        `${context}: ${table} ${metric}`,
      );
  }
}
function assertEquivalentHostWork(operations: Work[][]) {
  const totals = operations.map((works) => ({
    primitive: sum(works.map((work) => work.intake.primitive)),
    host: sum(works.flatMap((work) => [work.intake.warm, work.intake.reconstruction])),
    records: sum(works.flatMap((work) => [work.records.operation, work.records.reconstruction])),
    files: sum(works.map((work) => work.files)),
    reviews: works.reduce((n, work) => n + work.reviews, 0),
  }));
  const first = totals[0]!;
  for (const [index, operation] of totals.entries()) {
    const context = `chunk ${index + 1}`;
    // Adoption is initial preparation, never hidden inside a later chunk.
    for (const metric of ['schemaBuildOperations', 'schemaUpgradeInputUnits', 'schemaUpgradeNodes'])
      assert.equal(operation.host[metric] || 0, 0, `${context}: repeated ${metric}`);
    assert.ok(operation.reviews <= first.reviews + 1, `${context}: legacy review preparations`);
    assert.ok(
      (operation.host.collectionClinicalReviewPreparations || 0) <=
        (first.host.collectionClinicalReviewPreparations || 0) + 1,
      `${context}: native review preparations`,
    );
    for (const metric of ['readCopyBytes', 'serializedReadBytes', 'candidateCopyBytes'])
      assert.ok(
        (operation.primitive[metric] || 0) <= (first.primitive[metric] || 0) + 65536,
        `${context}: whole-view ${metric}`,
      );
    for (const metric of [
      'serializedBytes',
      'hashedBytes',
      'arrayMatchSerializedBytes',
      'envelopeSerializedBytes',
    ])
      assert.ok(
        (operation.host[metric] || 0) <= (first.host[metric] || 0) + 65536,
        `${context}: full-view host ${metric}`,
      );
    for (const metric of ['trustedCloneNodes', 'normalizeCloneNodes', 'diffNodeVisits'])
      assert.ok(
        (operation.host[metric] || 0) <= (first.host[metric] || 0) + 2000,
        `${context}: full-view host ${metric}`,
      );
    for (const metric of [
      'serializedBytes',
      'encodedBytes',
      'hashedBytes',
      'parsedBytes',
      'objectReadBytes',
      'headReadBytes',
    ])
      assert.ok(
        (operation.records[metric] || 0) <= (first.records[metric] || 0) + 65536,
        `${context}: accepted-version host ${metric}`,
      );
    for (const metric of ['headReadCalls', 'indexedVersionAttempts', 'decodedVersions'])
      assert.ok(
        (operation.records[metric] || 0) <= (first.records[metric] || 0) + 8,
        `${context}: accepted-version host ${metric}`,
      );
    for (const metric of [
      'readBytes',
      'streamReadBytes',
      'streamHashBytes',
      'bufferHashBytes',
      'candidateVersionHashBytes',
    ])
      assert.ok(
        (operation.files[metric] || 0) <= (first.files[metric] || 0) + 65536,
        `${context}: retained-file ${metric}`,
      );
    // A later review has up to one bounded comparison page of saved evidence.
    // Preserve its measured hash cost separately from full-view clone/hash work;
    // after the second chunk its available page has reached the same fixed cap.
    if (index >= 2)
      assert.ok(
        (operation.files.textHashBytes || 0) <=
          Math.max(first.files.textHashBytes || 0, totals[1]!.files.textHashBytes || 0) + 65536,
        `${context}: bounded comparison evidence hashing`,
      );
  }
}
async function prepare(f: Fixture, path: Path, count: number) {
  const lines = Array.from({ length: count }, (_, index) =>
    JSON.stringify(fictionalRecord(index)),
  ).join('\n');
  const item = intake.uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-counted.jsonl',
    bytes: Buffer.from(lines),
  });
  if (path === 'native') {
    await intake.ensureNativeIntakeSchema(f.db, f.profileId, item.id);
    await prepareCollectionReviewMembership(f.db, { id: item.id });
  }
  const original = f.db.prepare('SELECT path FROM source_files WHERE id=?').get(item.id)!;
  const originalHash = () =>
    createHash('sha256')
      .update(readFileSync(join(f.root, String(original.path))))
      .digest('hex');
  const expectedHash = originalHash();
  if (qualification)
    process.stderr.write(
      JSON.stringify({
        audit: 'partial-acceptance-input-v1',
        path,
        count,
        bytes: Buffer.byteLength(lines),
        originalSha256: expectedHash,
        source: loadedSource,
        fixtureHash,
      }) + '\n',
    );
  return { item, originalHash, expectedHash };
}
async function block(
  f: Fixture,
  _path: Path,
  intakeId: string,
  start: number,
  count: number,
): Promise<IntakeReportAcceptanceBlock> {
  const native = intake.hasNativeIntakeSchema(f.db, f.profileId, intakeId)
    ? await prepareCollectionClinicalReviewAsync(f.db, f.root, f.profileId, intakeId, null)
    : null;
  if (native && native.status !== 'ready') throw Error('Native complete review is not ready');
  try {
    const review =
      native?.status === 'ready'
        ? native.session.review
        : intake.reviewIntake(f.db, f.root, f.profileId, intakeId);
    return {
      intakeId,
      proposalId: null,
      intakeVersion: review.version,
      reviewToken: review.reviewToken,
      selections: review.records.slice(start, start + count).map((record) => ({
        selectionReviewToken: record.selectionReviewToken,
        recordId: record.id,
        candidateId: record.candidateId!,
        candidateVersionId: record.candidateVersionId!,
        mapping: record.draft?.mapping || record.mapping || {},
      })),
    };
  } finally {
    if (native?.status === 'ready') native.session.close();
  }
}
async function accept(f: Fixture, _path: Path, request: IntakeReportAcceptanceRequest) {
  return acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, request);
}
async function plannedRequest(
  f: Fixture,
  path: Path,
  blocks: IntakeReportAcceptanceBlock[],
  stage: string,
  measured: Work[] = [],
): Promise<IntakeReportAcceptanceRequest> {
  const request: IntakeReportAcceptanceRequest = {
    operationId: randomUUID(),
    mode: 'partial-v1',
    blocks,
  };
  if (path === 'legacy') return request;
  const { result, work } = await f.measure(stage, () =>
    planIntakeReportAcceptance(f.db, f.root, f.profileId, { blocks }),
  );
  measured.push(work);
  assert.equal(result.unsent.length, 0);
  assert.equal(result.chunks.length, 1);
  return { ...request, blocks: result.chunks[0]!, plan: { id: result.planId, chunk: 0 } };
}
function oracle(f: Fixture, count: number) {
  assert.deepEqual(
    f.db
      .prepare(
        'SELECT label, value_text, unit, effective_at, date_precision FROM observations ORDER BY label',
      )
      .all()
      .map((row) => ({ ...row })),
    Array.from({ length: count }, (_, index) => ({
      label: fictionalRecord(index).id,
      value_text: '+14.00',
      unit: 'mg',
      effective_at: '2026-09',
      date_precision: 'month',
    })),
  );
}
test('genuine factory measurement reconciles accepted writes and journal-only recovery', async (t) => {
  const f = fixture(t);
  const { work } = await f.measure('fictional-factory-attribution', () =>
    transaction(f.db, () =>
      f.db.prepare('INSERT INTO app_meta VALUES(?,?)').run('fictional:counted', 'preserved'),
    ),
  );
  assert.ok(work.io.immutableWrites! > 0);
  assert.equal(work.io.headWrites, 1);
  assert.ok(work.sql.__record_versions!.inserts! > 0);
  if (qualification) assert.ok(work.attribution);
  const path = join(f.root, 'fictional-counted-rebuild.sqlite');
  rebuildRecordDatabase(path, { profileId: f.profileId, storage: f.storage });
  const recovered = openDatabase(path, f.profileId);
  try {
    assert.equal(
      recovered.prepare('SELECT value FROM app_meta WHERE key=?').get('fictional:counted')!.value,
      'preserved',
    );
  } finally {
    recovered.close();
  }
});
test('repeated legacy stale-tab checks reuse the validated immutable view without copying it', async (t) => {
  const f = fixture(t);
  const { item } = await prepare(f, 'legacy', 40);
  const expected = intakeSourceVersion(f.db, item.id);
  const before = intakeWorkCounters(f.db);
  for (let index = 0; index < 100; index++)
    assert.deepEqual(intakeSourceVersion(f.db, item.id), expected);
  const after = intakeWorkCounters(f.db);
  assert.equal(after.primitive.readCopies, before.primitive.readCopies);
  assert.equal(after.primitive.readCopyBytes, before.primitive.readCopyBytes);
});
test('SQL mutation audit detects a late table rather than silently omitting it', async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.sqlAudit().omitted, []);
  f.db.exec('CREATE TABLE fictional_late_table(value TEXT)');
  assert.deepEqual(f.sqlAudit().omitted, ['fictional_late_table']);
  await assert.rejects(
    f.measure('late-table-coverage-check', () => {
      f.db.prepare('INSERT INTO fictional_late_table VALUES(?)').run('fictional');
    }),
    /SQL mutation audit is incomplete before stage/,
  );
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM fictional_late_table').get()!.n), 0);
});
test('SQL replacement preimages stay exact after rollback across sequence digit widths', (t) => {
  const f = fixture(t);
  const columns = f.db
    .prepare('PRAGMA table_info(__record_state)')
    .all()
    .map((row) => String(row.name));
  const original = f.db.prepare('SELECT * FROM __record_state').get()!;
  const bytes = (row: typeof original) =>
    columns.reduce(
      (n, key) => n + (row[key] === null ? 0 : Buffer.byteLength(String(row[key]))),
      0,
    );
  const wider: typeof original = { ...original, sequence: 1_000_000_000_000 };
  assert.notEqual(bytes(wider), bytes(original));
  const before = f.sqlMutations().__record_state!;
  const statement = f.db.prepare(
    `INSERT OR REPLACE INTO __record_state VALUES(${columns.map(() => '?').join(',')})`,
  );
  f.db.exec('SAVEPOINT fictional_preimage_audit');
  statement.run(...columns.map((key) => wider[key]!));
  f.db.exec('ROLLBACK TO fictional_preimage_audit; RELEASE fictional_preimage_audit');
  assert.deepEqual(f.db.prepare('SELECT * FROM __record_state').get(), original);
  statement.run(...columns.map((key) => original[key]!));
  const work = delta(f.sqlMutations().__record_state!, before);
  assert.equal(work.inserts, 2);
  assert.equal(work.deletes, 2);
  assert.equal(work.new_value_bytes, bytes(wider) + bytes(original));
  assert.equal(work.old_value_bytes, 2 * bytes(original));
});
test('legacy approvals survive native adoption, later partial saves and journal-only restart', async (t) => {
  const f = fixture(t);
  const { item, originalHash, expectedHash } = await prepare(f, 'legacy', 4);
  const approved = await block(f, 'legacy', item.id, 0, 4);
  const version = intakeSourceVersion(f.db, item.id);
  await intake.ensureNativeIntakeSchema(f.db, f.profileId, item.id);
  assert.equal(intake.hasNativeIntakeSchema(f.db, f.profileId, item.id), true);
  const adopted = intakeSourceVersion(f.db, item.id);
  assert.equal(adopted.rawVersion, version.rawVersion);
  assert.equal(adopted.version, version.version);
  assert.equal(adopted.sourcePin, version.sourcePin);
  let lastRequest: IntakeReportAcceptanceRequest | undefined;
  let lastReceipt: unknown;
  for (let index = 0; index < 2; index++) {
    const request: IntakeReportAcceptanceRequest = {
      operationId: randomUUID(),
      mode: 'partial-v1',
      blocks: [{ ...approved, selections: approved.selections.slice(index * 2, index * 2 + 2) }],
    };
    const records = createRecordVersionWorkCounters();
    const before = intakeWorkCounters(f.db);
    const result = await withRecordVersionWork(records, () => accept(f, 'legacy', request));
    assert.equal(result.receipt.acceptedCount, 2, JSON.stringify(result));
    assert.equal(result.receipt.atomic, false);
    // Native clinical acceptance intentionally publishes clinical rows through
    // intakeTransaction, an ordinary transaction. compactTerminalParentChecks
    // describes a different metadata publication path and is not its oracle.
    assert.ok(
      records.operation.encodedBytes > 0,
      'Actual accepted-version encoding must be observed',
    );
    assert.equal(intake.hasNativeIntakeSchema(f.db, f.profileId, item.id), true);
    process.stderr.write(
      JSON.stringify({
        audit: 'partial-acceptance-routine-publication-v1',
        chunk: index + 1,
        records: compact(records.operation),
        sqlAudit: f.sqlAudit(),
      }) + '\n',
    );
    const after = intakeWorkCounters(f.db);
    assert.equal(after.warm.schemaBuildOperations, before.warm.schemaBuildOperations);
    assert.equal(after.warm.schemaUpgradeNodes, before.warm.schemaUpgradeNodes);
    oracle(f, (index + 1) * 2);
    lastRequest = request;
    lastReceipt = result.receipt;
  }
  assert.equal(originalHash(), expectedHash);
  const expected = [...iterateIntakeEnvelopeText(f.db, { id: item.id })].join('');
  const target = join(f.root, 'fictional-routine-recovery.sqlite');
  clearIntakeStateCache(f.db);
  rebuildRecordDatabase(target, { profileId: f.profileId, storage: f.storage });
  const recovered = openDatabase(target, f.profileId);
  attachRecordDurability(recovered, { profileId: f.profileId, storage: f.storage });
  try {
    oracle({ ...f, db: recovered }, 4);
    assert.equal([...iterateIntakeEnvelopeText(recovered, { id: item.id })].join(''), expected);
    assert.deepEqual(
      getIntakeReportAcceptance(recovered, f.root, f.profileId, lastRequest!.operationId).receipt,
      lastReceipt,
    );
    assert.equal((await accept({ ...f, db: recovered }, 'legacy', lastRequest!)).replayed, true);
  } finally {
    clearIntakeStateCache(recovered);
    recovered.close();
  }
  assert.equal(originalHash(), expectedHash);
});
for (const path of ['legacy', 'legacy-planned', 'native'] as const) {
  test(
    `${path} actual partial acceptance 200 versus 800 changed records`,
    { skip: !qualification, timeout: 7_200_000 },
    async (t) => {
      const measurements: {
        save: ReturnType<typeof publication>;
        combined: ReturnType<typeof publication>;
      }[] = [];
      for (const count of [200, 800])
        await t.test(`${count} selections`, async (scope) => {
          const f = fixture(scope);
          const prepared = await f.measure('initial-preparation', () => prepare(f, path, count));
          const { item, originalHash, expectedHash } = prepared.result;
          const review = await f.measure('human-review', () => block(f, path, item.id, 0, count));
          const operation: Work[] = [];
          const request = await plannedRequest(
            f,
            path,
            [review.result],
            'initial-plan-and-conversion',
            operation,
          );
          // Unplanned asynchronous compatibility calls perform their automatic
          // adoption inside the save. Planned entry includes it in the public plan.
          const { result, work } = await f.measure(
            path === 'legacy' ? 'initial-save-and-conversion' : 'partial-save',
            () => accept(f, path, request),
          );
          operation.push(work);
          const combined = publication(operation);
          process.stderr.write(
            JSON.stringify({
              audit: 'partial-acceptance-combined-first-save-v1',
              path,
              count,
              source: loadedSource,
              fixtureHash,
              publication: combined,
            }) + '\n',
          );
          assert.equal(result.receipt.acceptedCount, count);
          assert.equal(result.receipt.atomic, false);
          assert.equal(
            new Set(
              result.receipt.receipts.map(
                (receipt) => `${receipt.intakeVersionBefore}:${receipt.intakeVersionAfter}`,
              ),
            ).size,
            Math.ceil(count / 200),
            'Independent selections must exercise the actual 200-selection batching boundary',
          );
          oracle(f, count);
          assert.equal(originalHash(), expectedHash);
          const envelope = [...iterateIntakeEnvelopeText(f.db, { id: item.id })].join('');
          const rebuiltPath = join(f.root, 'fictional-rebuilt.sqlite');
          await f.measure('cache-loss-reconstruction', () =>
            rebuildRecordDatabase(rebuiltPath, { profileId: f.profileId, storage: f.storage }),
          );
          const rebuilt = openDatabase(rebuiltPath, f.profileId);
          attachRecordDurability(rebuilt, { profileId: f.profileId, storage: f.storage });
          try {
            const recovered = { ...f, db: rebuilt };
            oracle(recovered, count);
            assert.deepEqual(
              getIntakeReportAcceptance(rebuilt, f.root, f.profileId, request.operationId).receipt,
              result.receipt,
            );
            assert.equal(
              [...iterateIntakeEnvelopeText(rebuilt, { id: item.id })].join(''),
              envelope,
            );
            assert.equal((await accept(recovered, path, request)).replayed, true);
          } finally {
            clearIntakeStateCache(rebuilt);
            rebuilt.close();
          }
          assert.equal(originalHash(), expectedHash);
          process.stderr.write(
            JSON.stringify({
              audit: 'partial-acceptance-correctness-v1',
              path,
              count,
              originalSha256: expectedHash,
              exactLiteralValues: true,
              journalOnlyRecovery: true,
              exactEnvelopeRecovery: true,
              receiptRecoveryAndReplay: true,
            }) + '\n',
          );
          measurements.push({ save: publication([work]), combined });
        });
      const [small, large] = measurements;
      assertProportional(
        small!.save,
        large!.save,
        'save (including automatic adoption for unplanned entry)',
      );
      assertProportional(small!.combined, large!.combined, 'initial public plan and first save');
    },
  );
  test(
    `${path} five equivalent 200-selection chunks on one 1000-record intake`,
    { skip: !qualification, timeout: 7_200_000 },
    async (t) => {
      const f = fixture(t);
      const initial = await f.measure('initial-preparation', () => prepare(f, path, 1000));
      const { item, originalHash, expectedHash } = initial.result;
      const reviewed = await f.measure('initial-human-review', () =>
        block(f, path, item.id, 0, 1000),
      );
      // Actual public preparation adopts legacy authority and prepares the graph.
      // Do not subtract graph work and describe the difference as conversion cost.
      const initialPlan = await f.measure('initial-plan-and-conversion', () =>
        planIntakeReportAcceptance(f.db, f.root, f.profileId, { blocks: [reviewed.result] }),
      );
      assert.equal(initialPlan.result.unsent.length, 0);
      assert.equal(initialPlan.result.chunks.length, 1);
      const publications: ReturnType<typeof publication>[] = [];
      const operations: Work[][] = [];
      let lastRequest: IntakeReportAcceptanceRequest | undefined;
      let lastReceipt: unknown;
      for (let index = 0; index < 5; index++) {
        const operation: Work[] = [];
        const request = await plannedRequest(
          f,
          path,
          [
            {
              ...reviewed.result,
              selections: reviewed.result.selections.slice(index * 200, index * 200 + 200),
            },
          ],
          `chunk-${index + 1}-planning`,
          operation,
        );
        const { result, work } = await f.measure(`chunk-${index + 1}-save`, () =>
          accept(f, path, request),
        );
        lastRequest = request;
        lastReceipt = result.receipt;
        operation.push(work);
        operations.push(operation);
        publications.push(publication(operation));
        assert.equal(result.receipt.acceptedCount, 200);
        assert.equal(result.receipt.atomic, false);
        assert.equal(
          new Set(
            result.receipt.receipts.map(
              (receipt) => `${receipt.intakeVersionBefore}:${receipt.intakeVersionAfter}`,
            ),
          ).size,
          1,
        );
        oracle(f, (index + 1) * 200);
        assert.equal(originalHash(), expectedHash);
      }
      const envelope = [...iterateIntakeEnvelopeText(f.db, { id: item.id })].join('');
      const target = join(f.root, 'fictional-sequential-recovery.sqlite');
      await f.measure('cache-loss-reconstruction', () =>
        rebuildRecordDatabase(target, { profileId: f.profileId, storage: f.storage }),
      );
      const recovered = openDatabase(target, f.profileId);
      attachRecordDurability(recovered, { profileId: f.profileId, storage: f.storage });
      try {
        oracle({ ...f, db: recovered }, 1000);
        assert.equal([...iterateIntakeEnvelopeText(recovered, { id: item.id })].join(''), envelope);
        assert.deepEqual(
          getIntakeReportAcceptance(recovered, f.root, f.profileId, lastRequest!.operationId)
            .receipt,
          lastReceipt,
        );
        assert.equal((await accept({ ...f, db: recovered }, path, lastRequest!)).replayed, true);
      } finally {
        clearIntakeStateCache(recovered);
        recovered.close();
      }
      assert.equal(originalHash(), expectedHash);
      process.stderr.write(
        JSON.stringify({
          audit: 'partial-acceptance-correctness-v1',
          path,
          count: 1000,
          chunks: 5,
          originalSha256: expectedHash,
          exactLiteralValues: true,
          journalOnlyRecovery: true,
          exactEnvelopeRecovery: true,
          receiptRecoveryAndReplay: true,
        }) + '\n',
      );
      const first = publications[0]!;
      for (const publication of publications.slice(1)) {
        assert.ok((publication.io.immutableBytes || 0) <= (first.io.immutableBytes || 0) + 65536);
        assert.ok((publication.io.immutableWrites || 0) <= (first.io.immutableWrites || 0) + 4);
        assert.ok((publication.io.headBytes || 0) <= (first.io.headBytes || 0) + 65536);
        assert.ok((publication.io.headWrites || 0) <= (first.io.headWrites || 0) + 1);
        assert.ok((publication.io.readBytes || 0) <= (first.io.readBytes || 0) + 65536);
        assert.ok((publication.io.reads || 0) <= (first.io.reads || 0) + 8);
        assert.ok(publication.frameBytes <= first.frameBytes + 16384);
        assert.ok(publication.frames <= first.frames + 4);
        for (const [table, counts] of Object.entries(publication.sql)) {
          const prior = first.sql[table] || {};
          for (const metric of ['inserts', 'updates', 'deletes'])
            assert.ok((counts[metric] || 0) <= (prior[metric] || 0) + 8, `${table} ${metric}`);
          for (const metric of ['new_value_bytes', 'old_value_bytes'])
            assert.ok((counts[metric] || 0) <= (prior[metric] || 0) + 65536, `${table} ${metric}`);
        }
      }
      assertEquivalentHostWork(operations);
    },
  );
}
