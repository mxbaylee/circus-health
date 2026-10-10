import nodeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import { uploadIntake, proposeConversionRead } from '../intake.ts';
import {
  prepareCollectionClinicalReviewAsync,
  prepareCollectionClinicalReviewDependencies,
} from '../intake-review-collection-host.ts';
import { reviewIssueScratchCounts } from '../intake-review-issue-state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase, transaction } from '../database.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { openIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import { collectionWorkflowReviewScope } from '../intake-review-collection.ts';
import { recordCandidateVersions } from '../intake-workflow.ts';
import { validateJSONL } from '../intake-format.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';
import { finishClinicalReviewWork } from '../clinical-review-work.ts';
import {
  prepareClinicalSourceScopeCheckWork,
  type ClinicalOriginalScope,
  type ClinicalSourceScopeBoundary,
} from '../clinical-source-scope.ts';
import { intakeWorkCounters, withIntakeWork, recordIntakeWork } from '../intake-work-accounting.ts';

const table = 'clinical_source_scope_verified_prefix_v1';
async function fixture(
  t: test.TestContext,
  count = 4,
  rowBytes: number | 'oversize' = 256 * 1024,
  duplicates = false,
  unusual: 'none' | 'raw-number' | 'missing-member' = 'none',
) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-source-scope-prefix-'));
  const db = openDatabase(join(root, 'cache.sqlite'), 'fictional-prefix-profile');
  const authority = memoryRecordAuthority(db);
  const sql = new DatabaseSync(':memory:');
  const file = {
    id: 'fictional-prefix-source',
    sha256: 'a'.repeat(64),
    mime_type: 'application/pdf',
  };
  const entries = validateJSONL(
    Buffer.from(
      Array.from({ length: count }, (_, n) =>
        JSON.stringify({
          format: 'health-record-v1',
          id: 'record-' + n,
          kind: 'record',
          payload: 'Fictional body without printed subject',
          clinical: { kind: 'document', title: 'Fictional document ' + n, subject: 'unknown' },
          report: {
            key: 'report-' + n,
            title: 'Fictional report',
            anchor: { locator: 'page1', text: 'Fictional boundary' },
            subject: { locator: 'page1', text: 'Fictional person ' + n + 'z'.repeat(3900) },
          },
          provenance: {
            sourceSystem: 'Fictional issuer',
            sourceRecordId: 'shared-identity',
            capturedVia: null,
            evidenceClass: 'provider_export',
            locator: 'page1',
          },
          coverage: { status: 'complete_response', notes: [] },
        }),
      ).join('\n'),
    ),
  ).entries!;
  assert.equal(entries.length, count);
  const details: {
    proposals: { id: string }[];
    workflow?: ReturnType<typeof import('../intake-workflow.ts').intakeWorkflow>;
  } = { proposals: [{ id: 'fictional-prefix-proposal' }] };
  recordCandidateVersions(file, details, entries, 'fictional-prefix-proposal');
  if (duplicates) {
    const groups = details.workflow!.reportGroups!;
    groups[1]!.id = groups[0]!.id;
    groups[1]!.report = structuredClone(groups[0]!.report);
    groups[2]!.versions = [];
  }
  if (unusual === 'raw-number')
    Object.assign(details.workflow!.reportGroups![0]!.report!.anchor, {
      literal: JSON.rawJSON('900719925474099312345'),
    });
  if (unusual === 'missing-member')
    delete (details.workflow!.reportGroups![0]! as { memberId?: string | null }).memberId;
  const metadataBytes =
    rowBytes === 'oversize'
      ? Buffer.byteLength(JSON.stringify(details.workflow!.reportGroups![0]!.report)) + 16
      : rowBytes;
  const initial = prepareInitialIntakeEnvelope({
    intake: { version: 1, originalName: 'fictional.pdf', ...details },
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(file.id, 'fictional.pdf', file.sha256, 0, 'intake_original', initial.detailsJson);
    createIntakeStateStorage(db, {
      profileId: 'fictional-prefix-profile',
      intakeId: file.id,
      sourceHash: file.sha256,
    }).stage(initial.state, randomUUID());
  });
  await buildIntakeCollectionEnvelope(db, file);
  const view = openIntakeCollectionEnvelope(db, file);
  const raw = () => (db.isTransaction ? undefined : reviewReadStamp(db));
  const owner = collectionWorkflowReviewScope({
    view,
    catalog: createReportSnapshotCatalog(db, file),
    metadataBytes,
    policySql: sql,
    readCacheState: raw,
    readProofState: raw,
    sourceScopePrefixProof() {
      if (db.isTransaction) return undefined;
      const before = reviewReadStamp(db);
      view.address(view.root());
      if (reviewReadStamp(db) !== before)
        throw Error('Fictional source prefix final authority changed');
      return before;
    },
    packageEvidence: false,
    activeReceipt: () => true,
    originalFingerprint: () => 'fictional-original-proof',
    reportSource: () => undefined,
    sourceScopePrefixWork: (metric, n) =>
      withIntakeWork(db, 'warm', () => recordIntakeWork(metric, n)),
  });
  const scope = owner.clinicalSourceScope({
    profileId: 'fictional-prefix-profile',
    hasParent: false,
    hasMember: () => false,
    childBoundary: null,
    subjectGrounded: () => false,
    questionGrounded: () => false,
  });
  const group = Array.from(scope.groups())[0]!;
  const boundary: ClinicalSourceScopeBoundary = {
    sourceFileId: file.id,
    sourceHash: file.sha256,
    memberId: null,
    anchor: group.report!.anchor,
    subject: group.report!.subject,
  };
  t.after(() => {
    owner.close?.();
    if (sql.isOpen) sql.close();
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const some = (selected: ClinicalSourceScopeBoundary = boundary, accept = false) =>
    finishClinicalReviewWork(
      scope.groundedSomeWork!(selected, function* () {
        return accept;
      }),
    );
  return {
    root,
    db,
    sql,
    authority,
    file,
    entries,
    scope,
    owner,
    view,
    boundary,
    some,
    rowBytes: metadataBytes,
  };
}

// Builds a real 16-report native fixture and executes all 256 original version
// visits before comparing policy and counted work; allow host setup margin in CI.
test(
  'native source-scope prefix preserves complete policy while reducing original version reads',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t, 16);
    const run = (scope: ClinicalOriginalScope) => {
      const answers = new Map<object, string | null>();
      const check = finishClinicalReviewWork(
        prepareClinicalSourceScopeCheckWork(
          {
            set: (entry, answer) => answers.set(entry, answer),
            get: (entry) => answers.get(entry),
          },
          f.db,
          f.file,
          f.entries,
          'fictional-prefix-proposal',
          () => scope,
        ),
      );
      return f.entries.map(check);
    };
    let ordinaryVersions = 0;
    const ordinary = {
      ...f.scope,
      groundedSomeWork: undefined,
      versionWork: function* (
        ...args: Parameters<NonNullable<ClinicalOriginalScope['versionWork']>>
      ) {
        ordinaryVersions++;
        return yield* f.scope.versionWork!(...args);
      },
    };
    const expected = run(ordinary);
    const before = intakeWorkCounters(f.db).warm;
    assert.deepEqual(run(f.scope), expected);
    const after = intakeWorkCounters(f.db).warm;
    assert.equal(ordinaryVersions, 256);
    assert.equal(
      after.clinicalSourceScopePrefixVerifiedGroups -
        before.clinicalSourceScopePrefixVerifiedGroups,
      16,
    );
    assert.equal(
      after.clinicalSourceScopePrefixMatchedGroups - before.clinicalSourceScopePrefixMatchedGroups,
      15,
    );
    assert.ok(after.clinicalSourceScopePrefixRowsRead > before.clinicalSourceScopePrefixRowsRead);
    assert.ok(
      after.clinicalSourceScopePrefixTextBytesRead > before.clinicalSourceScopePrefixTextBytesRead,
    );
    assert.ok(after.hashedBytes > before.hashedBytes);
    assert.ok(after.jsonParseBytes > before.jsonParseBytes);
  },
);

for (const mutation of ['delete', 'header', 'ordinal', 'version', 'extra'] as const)
  test('native signed prefix refuses ' + mutation + ' scratch tampering', async (t) => {
    const f = await fixture(t);
    assert.equal(f.some(), false);
    const row = f.sql.prepare(`SELECT * FROM ${table} ORDER BY ordinal LIMIT 1`).get()!;
    if (mutation === 'delete') f.sql.prepare(`DELETE FROM ${table} WHERE ordinal=0`).run();
    if (mutation === 'header')
      f.sql.prepare(`UPDATE ${table} SET header='{}' WHERE ordinal=0`).run();
    if (mutation === 'ordinal')
      f.sql.prepare(`UPDATE ${table} SET ordinal=40 WHERE ordinal=0`).run();
    if (mutation === 'version')
      f.sql.prepare(`UPDATE ${table} SET version='{}' WHERE ordinal=0`).run();
    if (mutation === 'extra')
      f.sql
        .prepare(`INSERT INTO ${table} VALUES (?,?,?,?,?)`)
        .run(row.scope, 40, row.header, row.version, row.mac);
    assert.throws(() => f.some(f.boundary, true), /prefix authority changed/);
  });

test('native prefix detects scratch deletion during successful candidate work', async (t) => {
  const f = await fixture(t);
  assert.equal(f.some(), false);
  const work = f.scope.groundedSomeWork!(f.boundary, function* () {
    yield;
    f.sql.prepare(`DELETE FROM ${table} WHERE ordinal=3`).run();
    return true;
  });
  assert.throws(() => finishClinicalReviewWork(work), /prefix authority changed/);
});

test('native prefix detects scratch mutation across completeness verification yield', async (t) => {
  const f = await fixture(t);
  assert.equal(f.some(), false);
  const work = f.scope.groundedSomeWork!(f.boundary, function* () {
    return true;
  });
  assert.equal(work.next().done, false);
  f.sql.prepare(`UPDATE ${table} SET header='{}' WHERE ordinal=0`).run();
  assert.throws(() => finishClinicalReviewWork(work), /prefix authority changed/);
});

for (const mutation of ['local-ABA', 'rollback', 'peer'] as const)
  test('native prefix retains original proof across ' + mutation, async (t) => {
    const f = await fixture(t);
    f.db.exec('CREATE TABLE fictional_prefix_change(value TEXT)');
    assert.equal(f.some(), false);
    if (mutation === 'local-ABA')
      f.db.exec(
        "INSERT INTO fictional_prefix_change VALUES('fictional');DELETE FROM fictional_prefix_change",
      );
    if (mutation === 'rollback')
      f.db.exec(
        "SAVEPOINT fictional;INSERT INTO fictional_prefix_change VALUES('fictional');ROLLBACK TO fictional;RELEASE fictional",
      );
    if (mutation === 'peer') {
      using peer = new DatabaseSync(join(f.root, 'cache.sqlite'));
      peer.exec(
        "INSERT INTO fictional_prefix_change VALUES('fictional');DELETE FROM fictional_prefix_change",
      );
    }
    assert.throws(() => f.some(f.boundary, true), /prefix authority changed/);
  });

test('native prefix stops at the same early match and refuses later corruption when traversed', async (t) => {
  const f = await fixture(t);
  const version = f.scope.versionWork!.bind(f.scope);
  let visited = 0;
  f.scope.versionWork = function* (group, id) {
    if (++visited === 2) throw Error('Fictional corrupt later version');
    return yield* version(group, id);
  };
  assert.equal(f.some(f.boundary, true), true);
  assert.equal(visited, 1);
  assert.throws(
    () => f.some({ ...f.boundary, sourceFileId: 'fictional-absent' }, true),
    /Fictional corrupt later version/,
  );
});

test('native prefix cancellation closes retained provider and caller transactions keep original traversal', async (t) => {
  const f = await fixture(t);
  f.db.exec('SAVEPOINT fictional');
  assert.equal(f.some(), false);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM sqlite_master WHERE name=?').get(table)!.n, 0);
  f.db.exec('ROLLBACK TO fictional;RELEASE fictional');
  const work = f.scope.groundedSomeWork!(f.boundary, function* () {
    return false;
  });
  assert.equal(work.next().done, false);
  work.return(false);
  assert.throws(() => f.some(), /prefix authority changed/);
  f.owner.close?.();
  assert.throws(() => f.some(), /Closed clinical source scope/);
});

test('valid oversized prefix metadata falls back to the complete original traversal', async (t) => {
  const f = await fixture(t, 4, 'oversize');
  const group = Array.from(f.scope.groups())[0]!;
  assert.ok(Buffer.byteLength(JSON.stringify(group.report)) < f.rowBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(group)) > f.rowBytes);
  assert.equal(f.some(), false);
  assert.equal(f.some(f.boundary, true), true);
  assert.equal(f.sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0);
});

test('native prefix retains duplicate group cardinality and absent-current-version semantics', async (t) => {
  const f = await fixture(t, 4, 256 * 1024, true);
  const seen: string[] = [];
  assert.equal(
    finishClinicalReviewWork(
      f.scope.groundedSomeWork!(f.boundary, function* (group, current) {
        assert.ok(current);
        seen.push(group.id + ':' + current.id);
        return false;
      }),
    ),
    false,
  );
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  const again: string[] = [];
  assert.equal(
    finishClinicalReviewWork(
      f.scope.groundedSomeWork!(f.boundary, function* (group, current) {
        again.push(group.id + ':' + current!.id);
        return false;
      }),
    ),
    false,
  );
  assert.deepEqual(again, seen);
});

test('native prefix allows unrelated evaluation scratch writes without granting prefix mutation credits', async (t) => {
  const f = await fixture(t);
  assert.equal(f.some(), false);
  f.sql.exec('CREATE TABLE fictional_other_scratch(value TEXT)');
  const evaluate = function* () {
    f.sql.prepare('INSERT INTO fictional_other_scratch VALUES(?)').run('fictional');
    yield;
    return false;
  };
  assert.equal(finishClinicalReviewWork(f.scope.groundedSomeWork!(f.boundary, evaluate)), false);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM fictional_other_scratch').get()!.n, 1);
});

test('native prefix still checks physical accepted HEAD with unchanged SQL', async (t) => {
  const f = await fixture(t);
  assert.equal(f.some(), false);
  const stamp = reviewReadStamp(f.db),
    head = f.authority.objects.get('head')!;
  f.authority.objects.delete('head');
  try {
    assert.throws(() => f.some(f.boundary, true), /head|authority|durab|selected/i);
  } finally {
    f.authority.objects.set('head', head);
  }
  // A physical refusal may revoke disposable read caches without changing SQL.
  const after = reviewReadStamp(f.db);
  assert.ok(stamp);
  assert.ok(after);
  assert.equal(after.split(':').slice(1).join(':'), stamp.split(':').slice(1).join(':'));
});

test('already pinned native prefix refuses caller transaction admission', async (t) => {
  const f = await fixture(t);
  assert.equal(f.some(), false);
  f.db.exec('SAVEPOINT fictional');
  try {
    assert.throws(() => f.some(), /prefix authority changed/);
  } finally {
    f.db.exec('ROLLBACK TO fictional;RELEASE fictional');
  }
  assert.throws(() => f.some(), /prefix authority changed/);
});

test('oversize fallback cannot revive its pinned proof after real SQL changes', async (t) => {
  const f = await fixture(t, 4, 'oversize');
  assert.equal(f.some(), false);
  f.db.exec('CREATE TABLE fictional_after_oversize(value TEXT)');
  assert.throws(() => f.some(), /prefix authority changed/);
});

for (const column of ['header', 'version', 'mac', 'ordinal'])
  test(
    'native prefix bounds invalid scratch ' + column + ' before JavaScript decoding',
    async (t) => {
      const f = await fixture(t);
      assert.equal(f.some(), false);
      f.sql
        .prepare(`UPDATE ${table} SET ${column}=CAST(zeroblob(1048576) AS TEXT) WHERE ordinal=0`)
        .run();
      assert.throws(() => f.some(), /prefix authority changed/);
    },
  );

for (const mutation of ['local-ABA', 'TEMP-schema', 'peer-ABA'] as const)
  test(
    'actual host prefix proof catches ' + mutation + ' after its last physical stat',
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'fictional-source-prefix-host-')),
        profile = 'fictional-prefix-host',
        paths = ensureProfileDirectories(root, profile),
        db = openDatabase(paths.database, profile);
      attachPersonalDurability(db, { root, profileId: profile });
      t.after(() => {
        clearIntakeStateCache(db);
        if (db.isOpen) db.close();
        rmSync(root, { recursive: true, force: true });
      });
      const original = uploadIntake(db, root, profile, {
        filename: 'fictional.txt',
        bytes: Buffer.from('Fictional source report and patient'),
        newProviderName: 'Fictional clinic',
      });
      await buildIntakeCollectionEnvelope(db, { id: original.id });
      await proposeConversionRead(db, root, profile, original.id, {
        version: original.version,
        summary: 'Fictional scope evidence',
        jsonlText: JSON.stringify({
          format: 'health-record-v1',
          id: 'fictional-host-record',
          kind: 'record',
          payload: 'Fictional result body',
          clinical: { kind: 'document', title: 'Fictional evidence', subject: 'unknown' },
          report: {
            key: 'fictional-report',
            title: 'Fictional report',
            anchor: { locator: 'page1', text: 'Fictional report' },
            subject: { locator: 'page1', text: 'Fictional patient' },
          },
          provenance: {
            sourceSystem: 'Fictional issuer',
            sourceRecordId: 'fictional-host-record',
            capturedVia: null,
            evidenceClass: 'provider_export',
            locator: 'page1',
          },
          coverage: { status: 'complete_response', notes: [] },
        }),
      });
      const proposalId = String(
        db
          .prepare(
            "SELECT id FROM source_files WHERE kind='intake_proposal' ORDER BY rowid DESC LIMIT 1",
          )
          .get()!.id,
      );
      await prepareCollectionClinicalReviewDependencies(db, root, profile, original.id, proposalId);
      db.exec('CREATE TABLE fictional_prefix_race(value TEXT)');
      const file = db
        .prepare('SELECT path FROM source_files WHERE id IN (?,?) ORDER BY id DESC LIMIT 1')
        .get(original.id, proposalId)!;
      const target = profileOriginal(root, String(file.path), profile);
      using peer = new DatabaseSync(paths.database);
      const before = {
        raw: reviewReadStamp(db),
        peer: db.prepare('PRAGMA data_version').get()!.data_version,
        temp: db.prepare('PRAGMA temp.schema_version').get()!.schema_version,
      };
      const old = nodeFs.statSync,
        oldStack = Error.stackTraceLimit;
      let visits = 0,
        injected = false,
        after: { raw: string | undefined; peer: unknown; temp: unknown } | undefined;
      Error.stackTraceLimit = 64;
      Reflect.set(nodeFs, 'statSync', ((path, ...args) => {
        const result = old(path, ...args);
        if (
          String(path) === target &&
          new Error().stack?.includes('sourceScopePrefixProof') &&
          ++visits === 2
        ) {
          if (mutation === 'local-ABA')
            db.exec(
              "INSERT INTO fictional_prefix_race VALUES('fictional');DELETE FROM fictional_prefix_race",
            );
          if (mutation === 'TEMP-schema')
            db.exec(
              'CREATE TEMP TABLE fictional_prefix_temp(value TEXT);DROP TABLE fictional_prefix_temp',
            );
          if (mutation === 'peer-ABA')
            peer.exec(
              "INSERT INTO fictional_prefix_race VALUES('fictional');DELETE FROM fictional_prefix_race",
            );
          after = {
            raw: reviewReadStamp(db),
            peer: db.prepare('PRAGMA data_version').get()!.data_version,
            temp: db.prepare('PRAGMA temp.schema_version').get()!.schema_version,
          };
          injected = true;
        }
        return result;
      }) as typeof nodeFs.statSync);
      syncBuiltinESMExports();
      try {
        await assert.rejects(
          prepareCollectionClinicalReviewAsync(db, root, profile, original.id, proposalId),
          /Clinical source scope authority changed during verification/,
        );
      } finally {
        Reflect.set(nodeFs, 'statSync', old);
        syncBuiltinESMExports();
        Error.stackTraceLimit = oldStack;
      }
      assert.equal(injected, true);
      assert.ok(after);
      assert.notEqual(after.raw, before.raw);
      if (mutation === 'peer-ABA') assert.notEqual(after.peer, before.peer);
      if (mutation === 'TEMP-schema') assert.notEqual(after.temp, before.temp);
      assert.equal(db.prepare('SELECT count(*) n FROM fictional_prefix_race').get()!.n, 0);
      assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });
    },
  );

test('native prefix preserves raw numeric boundary tokens and missing member distinct from null', async (t) => {
  const f = await fixture(t, 4, 256 * 1024, false, 'raw-number');
  assert.equal(f.some(), false);
  assert.equal(f.some(f.boundary, true), true);
  assert.equal(
    f.some(
      {
        ...f.boundary,
        anchor: {
          ...f.boundary.anchor,
          literal: JSON.rawJSON('900719925474099312346'),
        } as typeof f.boundary.anchor,
      },
      true,
    ),
    false,
  );
  assert.equal(f.some({ ...f.boundary, subject: null as never }, true), false);
  const missing = await fixture(t, 4, 256 * 1024, false, 'missing-member');
  assert.equal(Array.from(missing.scope.groups())[0]!.memberId, undefined);
  assert.equal(missing.some(), false);
  assert.equal(missing.some(missing.boundary, true), false);
});

test('native prefix second pass reauthenticates rows after its own yield', async (t) => {
  const f = await fixture(t);
  assert.equal(f.some(), false);
  const work = f.scope.groundedSomeWork!(
    { ...f.boundary, sourceFileId: 'fictional-no-match' },
    function* () {
      return true;
    },
  );
  for (let n = 0; n < 5; n++) assert.equal(work.next().done, false);
  f.sql.prepare(`UPDATE ${table} SET header='{}' WHERE ordinal=1`).run();
  assert.throws(() => finishClinicalReviewWork(work), /prefix authority changed/);
});

test('repeated native source-scope handles retain independent proofs and one owned prefix', async (t) => {
  const f = await fixture(t);
  assert.equal(f.some(), false);
  const rows = f.sql
    .prepare(`SELECT count(*) n, count(DISTINCT scope) scopes FROM ${table}`)
    .get()!;
  let subjectCalls = 0;
  const second = f.owner.clinicalSourceScope({
    profileId: f.scope.profileId,
    hasParent: false,
    hasMember: () => false,
    childBoundary: null,
    subjectGrounded() {
      subjectCalls++;
      return true;
    },
    questionGrounded: () => true,
  });
  const evaluate = (scope: ClinicalOriginalScope) =>
    finishClinicalReviewWork(
      scope.groundedSomeWork!(f.boundary, function* (group) {
        return scope.subjectGrounded(group);
      }),
    );
  assert.equal(evaluate(f.scope), false);
  assert.equal(evaluate(second), true);
  assert.equal(subjectCalls, 1);
  assert.equal(evaluate(f.scope), false);
  assert.equal(subjectCalls, 1);
  assert.deepEqual(
    f.sql.prepare(`SELECT count(*) n, count(DISTINCT scope) scopes FROM ${table}`).get(),
    rows,
  );
  const answers = (scope: ClinicalOriginalScope) => {
    const result = new Map<object, string | null>();
    const check = finishClinicalReviewWork(
      prepareClinicalSourceScopeCheckWork(
        { set: (entry, value) => result.set(entry, value), get: (entry) => result.get(entry) },
        f.db,
        f.file,
        f.entries,
        'fictional-prefix-proposal',
        () => scope,
      ),
    );
    return f.entries.map(check);
  };
  const ordinary = { ...second, groundedSomeWork: undefined };
  const expected = answers(ordinary);
  subjectCalls = 0;
  assert.deepEqual(answers(second), expected);
  assert.equal(subjectCalls, f.entries.length);
  assert.equal(evaluate(f.scope), false);
  f.owner.close?.();
  assert.throws(() => evaluate(f.scope), /Closed clinical source scope/);
  assert.throws(() => evaluate(second), /Closed clinical source scope/);
});

test('interleaved source-scope handle completion and cancellation preserve the active prefix owner', async (t) => {
  const f = await fixture(t);
  const second = f.owner.clinicalSourceScope({
    profileId: f.scope.profileId,
    hasParent: false,
    hasMember: () => false,
    childBoundary: null,
    subjectGrounded: () => true,
    questionGrounded: () => true,
  });
  const active = f.scope.groundedSomeWork!(f.boundary, function* () {
    return false;
  });
  try {
    assert.equal(active.next().done, false);
    const before = f.sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n;
    const canceled = second.groundedSomeWork!(f.boundary, function* () {
      return true;
    });
    assert.equal(canceled.next().done, false);
    canceled.return(false);
    assert.equal(f.sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, before);
    assert.equal(
      finishClinicalReviewWork(
        second.groundedSomeWork!(f.boundary, function* () {
          return true;
        }),
      ),
      true,
    );
    assert.equal(f.sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, before);
    assert.equal(finishClinicalReviewWork(active), false);
    assert.equal(f.some(f.boundary, true), true);
    assert.equal(f.sql.prepare(`SELECT count(DISTINCT scope) n FROM ${table}`).get()!.n, 1);
  } finally {
    active.return(false);
  }
});

test('interleaved original traversal retains the shared immutable source authority pin', async (t) => {
  const f = await fixture(t);
  const second = f.owner.clinicalSourceScope({
    profileId: f.scope.profileId,
    hasParent: false,
    hasMember: () => false,
    childBoundary: null,
    subjectGrounded: () => false,
    questionGrounded: () => false,
  });
  const active = f.scope.groundedSomeWork!(f.boundary, function* () {
    return false;
  });
  const other = second.groundedSomeWork!(f.boundary, function* () {
    return true;
  });
  try {
    assert.equal(active.next().done, false);
    assert.equal(other.next().done, false);
    f.db.exec(
      'CREATE TEMP TABLE fictional_interleaved_race(value TEXT); DROP TABLE fictional_interleaved_race',
    );
    assert.throws(() => finishClinicalReviewWork(other), /prefix authority changed/);
    assert.throws(() => finishClinicalReviewWork(active), /prefix authority changed/);
  } finally {
    other.return(false);
    active.return(false);
  }
});

for (const phase of ['authentication', 'evaluation'] as const)
  test(`interleaved scratch evaluation writes reverify a stable prefix during ${phase}`, async (t) => {
    const f = await fixture(t);
    assert.equal(f.some(), false);
    f.sql.exec('CREATE TABLE fictional_other_policy(value INTEGER)');
    const second = f.owner.clinicalSourceScope({
      profileId: f.scope.profileId,
      hasParent: false,
      hasMember: () => false,
      childBoundary: null,
      subjectGrounded: () => true,
      questionGrounded: () => true,
    });
    let evaluations = 0;
    const active = f.scope.groundedSomeWork!(f.boundary, function* () {
      evaluations++;
      return false;
    });
    const start = intakeWorkCounters(f.db).warm.clinicalSourceScopePrefixRowsRead;
    try {
      // Four admission rows, the first candidate row, four post-evaluation
      // authentication rows, then the next nonmatching evaluation-pass row.
      const target = phase === 'authentication' ? 1 : 10;
      while (intakeWorkCounters(f.db).warm.clinicalSourceScopePrefixRowsRead - start < target)
        assert.equal(active.next().done, false);
      assert.equal(evaluations, phase === 'authentication' ? 0 : 1);
      assert.equal(
        finishClinicalReviewWork(
          second.groundedSomeWork!(f.boundary, function* () {
            f.sql.exec('INSERT INTO fictional_other_policy VALUES(1)');
            return true;
          }),
        ),
        true,
      );
      assert.equal(finishClinicalReviewWork(active), false);
      assert.equal(evaluations, 1);
      assert.equal(f.sql.prepare('SELECT count(*) n FROM fictional_other_policy').get()!.n, 1);
      assert.equal(f.some(f.boundary, true), true);
    } finally {
      active.return(false);
    }
  });

for (const outcome of ['cancel', 'throw'] as const)
  test(`interleaved scratch ${outcome} cannot release another handle's prefix ownership`, async (t) => {
    const f = await fixture(t);
    assert.equal(f.some(), false);
    f.sql.exec('CREATE TABLE fictional_other_policy(value INTEGER)');
    const second = f.owner.clinicalSourceScope({
      profileId: f.scope.profileId,
      hasParent: false,
      hasMember: () => false,
      childBoundary: null,
      subjectGrounded: () => true,
      questionGrounded: () => true,
    });
    const active = f.scope.groundedSomeWork!(f.boundary, function* () {
      return false;
    });
    let wrote = false;
    const other = second.groundedSomeWork!(f.boundary, function* () {
      f.sql.exec('INSERT INTO fictional_other_policy VALUES(1)');
      wrote = true;
      if (outcome === 'throw') throw Error('Fictional overlapping predicate failure');
      yield;
      return true;
    });
    try {
      assert.equal(active.next().done, false);
      if (outcome === 'throw')
        assert.throws(
          () => finishClinicalReviewWork(other),
          /Fictional overlapping predicate failure/,
        );
      else {
        while (!wrote) assert.equal(other.next().done, false);
        other.return(false);
      }
      assert.equal(wrote, true);
      assert.equal(finishClinicalReviewWork(active), false);
      assert.equal(f.some(f.boundary, true), true);
      assert.equal(f.sql.prepare('SELECT count(*) n FROM fictional_other_policy').get()!.n, 1);
    } finally {
      other.return(false);
      active.return(false);
    }
  });

for (const mutation of ['delete', 'rewrite', 'extra'] as const)
  test(`interleaved evaluation cannot authorize ${mutation} of the signed prefix`, async (t) => {
    const f = await fixture(t);
    assert.equal(f.some(), false);
    const second = f.owner.clinicalSourceScope({
      profileId: f.scope.profileId,
      hasParent: false,
      hasMember: () => false,
      childBoundary: null,
      subjectGrounded: () => true,
      questionGrounded: () => true,
    });
    const active = f.scope.groundedSomeWork!(f.boundary, function* () {
      return false;
    });
    try {
      assert.equal(active.next().done, false);
      assert.equal(
        finishClinicalReviewWork(
          second.groundedSomeWork!(f.boundary, function* () {
            if (mutation === 'delete') f.sql.exec(`DELETE FROM ${table} WHERE ordinal=3`);
            if (mutation === 'rewrite')
              f.sql.exec(`UPDATE ${table} SET header='{}' WHERE ordinal=3`);
            if (mutation === 'extra')
              f.sql.exec(
                `INSERT INTO ${table} SELECT scope,99,header,version,mac FROM ${table} WHERE ordinal=0`,
              );
            return true;
          }),
        ),
        true,
      );
      assert.throws(() => finishClinicalReviewWork(active), /prefix authority changed/);
    } finally {
      active.return(false);
    }
  });
