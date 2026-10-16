import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatementSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { openDatabase, transaction } from '../database.ts';
import { openContributorRecordStorage } from '../contributor-record-storage.ts';
import {
  INTAKE_COMPACT_ENVELOPE_FORMAT,
  prepareInitialIntakeEnvelope,
} from '../intake-authority.ts';
import { prepareIntakeCompactMetadata } from '../intake-compact-metadata.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  captureIntakeFrontierAttempts,
  intakeFrontierAttemptCounts,
  readIntakeFrontierCommittedChain,
} from '../intake-lookup-frontier-observer.ts';
import { takeRecordAcceptedSourceDeltaCandidate } from '../record-accepted-source-delta.ts';
import { clearIntakeLookupCache, intakeLookupCounters } from '../intake-lookup-projection.ts';
import {
  assertIntakeDiscoveryRevision,
  intakeDiscoveryRevision,
  prepareIntakeLookupIndices,
} from '../intake-lookup-state.ts';
import { registerIntakeFile } from '../intake-state-access.ts';
import { clearIntakeStateCache, createIntakeStateStorage } from '../intake-state-storage.ts';
import { uploadIntake } from '../intake.ts';
import { reconcileSourceTextProjection } from '../source-text-projection.ts';
import { ensureProfileDirectories, profileOriginal, profilePaths } from '../profile-storage.ts';
import { attachRecordDurability } from '../record-versions.ts';
import { freshKey } from '../vault-crypto.ts';
import { openVault } from '../vault-store.ts';

type Backend = 'contributor' | 'vault';

/** Fictional originals whose envelopes are native, plus one retained legacy
 * original whose oversized presentation metadata is still uncompacted. */
async function fixture(t: TestContext, backend: Backend, others = 3) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-lookup-compact-'))),
    profileId = 'fictional-lookup-compact',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId),
    key = backend === 'vault' ? freshKey() : undefined,
    vault = key
      ? openVault({ directory: paths.root, profileId, key, initialize: true })
      : undefined,
    contributor =
      backend === 'contributor'
        ? openContributorRecordStorage(root, profileId, { initialize: true })
        : undefined,
    storage = vault?.recordStorage() ?? contributor!;
  t.after(() => {
    clearIntakeLookupCache(db);
    clearIntakeStateCache(db);
    db.close();
    vault?.close();
    contributor?.close();
    key?.fill(0);
    rmSync(root, { recursive: true, force: true });
  });
  attachRecordDurability(db, { profileId, storage });
  for (let index = 0; index < others; index++) {
    const other = uploadIntake(db, root, profileId, {
      filename: `fictional-native-${index}.txt`,
      bytes: Buffer.from(`Independently fictional native original ${index}`),
    });
    await buildIntakeCollectionEnvelope(db, other);
  }
  const original = Buffer.from('Independently fictional retained compact original.'),
    sourceHash = createHash('sha256').update(original).digest('hex'),
    id = 'fictional-compact-retained',
    path = profilePaths(root, profileId).relativeRoot + '/sources/fictional-compact.pdf';
  writeFileSync(join(root, path), original);
  const initial = prepareInitialIntakeEnvelope({
    intake: {
      version: 1,
      originalName: 'fictional-' + 'retained-long-name-'.repeat(1500) + '.pdf',
      state: 'ready',
      proposals: [],
      importHistory: [],
    },
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,mime_type,details_json) VALUES(?,?,?,?,?,?,?)',
    ).run(
      id,
      path,
      sourceHash,
      original.length,
      'intake_original',
      'application/pdf',
      initial.detailsJson,
    );
    createIntakeStateStorage(db, { profileId, intakeId: id, sourceHash }).stage(
      initial.state,
      randomUUID(),
    );
  });
  const compact = { id, sha256: sourceHash };
  // Encrypted originals are stored before any compact backing replay verifies them.
  if (vault) {
    for (const row of db.prepare('SELECT path FROM source_files').iterate()) {
      const file = String(row.path);
      // Vault original names are relative to the profile directory.
      vault.storeFile(
        file.slice(profilePaths(root, profileId).relativeRoot.length + 1),
        readFileSync(profileOriginal(root, file, profileId)),
      );
    }
    vault.publish();
  }
  await buildIntakeCollectionEnvelope(db, compact);
  // Retained legacy metadata: the envelope is native, the row is not compact yet.
  transaction(db, () =>
    db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(initial.detailsJson, id),
  );
  const details = () =>
    String(db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!.details_json);
  return { db, root, profileId, compact, details, storage };
}

const compactPrefix = '{"intakeAuthority":{"format":"' + INTAKE_COMPACT_ENVELOPE_FORMAT + '"';

const dirtyRows = (f: Awaited<ReturnType<typeof fixture>>, table: string) =>
  Number(
    f.db.prepare(`SELECT COUNT(*) AS n FROM temp.${table} WHERE source_id=?`).get(f.compact.id)!.n,
  );
const tempTable = (f: Awaited<ReturnType<typeof fixture>>, table: string) =>
  !!f.db.prepare("SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name=?").get(table);

for (const backend of ['contributor', 'vault'] as const)
  for (const [lookup, sourceText] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const)
    test(
      `${backend} compact installer publication succeeds with lookup ${lookup ? 'prepared' : 'absent'} and source text ${sourceText ? 'prepared' : 'absent'}`,
      { timeout: 300_000 },
      async (t) => {
        const f = await fixture(t, backend);
        assert.equal(f.details().startsWith(compactPrefix), false);
        if (lookup) await prepareIntakeLookupIndices(f.db);
        if (sourceText) transaction(f.db, () => reconcileSourceTextProjection(f.db));
        assert.equal(tempTable(f, '__intake_lookup_dirty'), lookup);
        assert.equal(tempTable(f, '__source_text_dirty'), sourceText);
        // Each prepared tracker binds every selected head as a dirty authority,
        // so the compact HEAD write fires its owned dirty trigger.
        if (lookup) {
          assert.equal(
            f.db
              .prepare(
                'SELECT COUNT(*) AS n FROM temp.__intake_lookup_authorities WHERE source_id=?',
              )
              .get(f.compact.id)!.n,
            1,
          );
          assert.equal(dirtyRows(f, '__intake_lookup_dirty'), 0);
        }
        if (sourceText) assert.equal(dirtyRows(f, '__source_text_dirty'), 0);
        assert.equal((await prepareIntakeCompactMetadata(f.db, f.compact)).changed, true);
        assert.equal(f.details().startsWith(compactPrefix), true);
        if (lookup) assert.equal(dirtyRows(f, '__intake_lookup_dirty'), 1);
        if (sourceText) assert.equal(dirtyRows(f, '__source_text_dirty'), 1);
        // The source row, HEAD and dirty insertions are all owned: no revocation.
        assert.equal(intakeFrontierAttemptCounts(f.db)?.revoked, false);
      },
    );

for (const backend of ['contributor', 'vault'] as const)
  test(
    `${backend} compact publication after lookup preparation still refuses an unowned write`,
    { timeout: 300_000 },
    async (t) => {
      const f = await fixture(t, backend);
      await prepareIntakeLookupIndices(f.db);
      transaction(f.db, () => reconcileSourceTextProjection(f.db));
      const before = f.details();
      // A foreign trigger that mimics the owned lookup-dirty insertion for a
      // different source: one extra write the dirty credit must not absorb.
      f.db.exec(
        "CREATE TEMP TRIGGER fictional_unowned_dirty AFTER UPDATE OF details_json ON main.source_files BEGIN INSERT INTO __intake_lookup_dirty SELECT 'fictional-other-' || NEW.id WHERE NOT EXISTS(SELECT 1 FROM __intake_lookup_dirty WHERE source_id='fictional-other-' || NEW.id); END",
      );
      await assert.rejects(
        prepareIntakeCompactMetadata(f.db, f.compact),
        /closing SQL\/method\/physical seal|unowned preimage write|late mutation/,
      );
      assert.equal(
        f.db
          .prepare('SELECT COUNT(*) AS n FROM temp.__intake_lookup_dirty WHERE source_id=?')
          .get('fictional-other-' + f.compact.id)!.n,
        0,
        'the refused publication rolled back the unowned write',
      );
      assert.equal(f.details(), before);
    },
  );

/** Count returned global original-row reads (the cold catalog derivation);
 * point-selected source reads are separate. */
async function measure<T>(db: Awaited<ReturnType<typeof fixture>>['db'], run: () => Promise<T>) {
  const methods = ['get', 'all', 'iterate'] as const,
    saved = methods.map((name) => StatementSync.prototype[name]),
    global = (sql: string) =>
      /\b(?:FROM|JOIN)\s+(?:main\.)?source_files\b/i.test(sql) &&
      /(?:\bkind|\.kind)\s*=\s*'intake_original'/i.test(sql) &&
      !/\b(?:[a-z_]\w*\.)?id\s*=\s*\?/i.test(sql);
  let originalRows = 0;
  StatementSync.prototype.get = function (this: StatementSync, ...args: never[]) {
    const row = Reflect.apply(saved[0]!, this, args);
    if (row && global(this.sourceSQL)) originalRows++;
    return row;
  } as StatementSync['get'];
  StatementSync.prototype.all = function (this: StatementSync, ...args: never[]) {
    const rows = Reflect.apply(saved[1]!, this, args) as unknown[];
    if (global(this.sourceSQL)) originalRows += rows.length;
    return rows;
  } as StatementSync['all'];
  StatementSync.prototype.iterate = function (this: StatementSync, ...args: never[]) {
    const counted = global(this.sourceSQL),
      rows = Reflect.apply(saved[2]!, this, args) as Iterable<unknown>;
    return (function* () {
      for (const row of rows) {
        if (counted) originalRows++;
        yield row;
      }
    })();
  } as unknown as StatementSync['iterate'];
  const before = { ...intakeLookupCounters(db) };
  try {
    const value = await run();
    const after = intakeLookupCounters(db);
    return {
      value,
      originalRows,
      builds: after.builds - before.builds,
      appended: after.nativeCatalogSourcesAppended - before.nativeCatalogSourcesAppended,
    };
  } finally {
    methods.forEach((name, index) => {
      (StatementSync.prototype as unknown as Record<string, unknown>)[name] = saved[index];
    });
  }
}

for (const backend of ['contributor', 'vault'] as const)
  for (const broken of [false, true])
    test(
      `${backend} compact installer interval ${broken ? 'with a consumed link falls back' : 'appends incrementally'}`,
      {
        timeout: 300_000,
      },
      async (t) => {
        const f = await fixture(t, backend);
        const cold = await measure(f.db, () => prepareIntakeLookupIndices(f.db));
        t.diagnostic(JSON.stringify({ cold }));
        const snapshot = captureIntakeFrontierAttempts(f.db);
        assert.ok(snapshot);
        assert.equal((await prepareIntakeCompactMetadata(f.db, f.compact)).changed, true);
        const chain = readIntakeFrontierCommittedChain(f.db, snapshot);
        assert.ok(chain);
        assert.equal(chain.outcomes.length, 1);
        assert.equal(chain.outcomes[0]!.maintenance, true);
        assert.deepEqual(chain.outcomes[0]!.sourceIds, [f.compact.id]);
        if (broken)
          assert.ok(takeRecordAcceptedSourceDeltaCandidate(f.db, chain.outcomes[0]!.token));
        const prepared = await measure(f.db, () => prepareIntakeLookupIndices(f.db));
        t.diagnostic(JSON.stringify({ broken, prepared }));
        if (broken) {
          // The full fallback: a complete rescan of all four originals, the
          // same original rows the cold derivation read (no table rebuild).
          assert.equal(prepared.appended, 0);
          assert.equal(prepared.builds, 0);
          assert.equal(prepared.originalRows, cold.originalRows);
        } else {
          assert.equal(prepared.appended, 1);
          assert.equal(prepared.builds, 0);
          assert.equal(prepared.originalRows, 0);
        }
        assert.equal(intakeFrontierAttemptCounts(f.db)?.revoked, false);
      },
    );

/** One production registration commit carrying more source rows than one
 * accepted-delta page (the former 100-row cap): fictional derived rows bound
 * to one native original, which never enter lookup membership. */
function registerDerivedRows(
  f: Awaited<ReturnType<typeof fixture>>,
  originalId: string,
  count: number,
) {
  const ids: string[] = [];
  transaction(f.db, () => {
    for (let index = 0; index < count; index++) {
      const id = `proposal_fictional-paged-${String(index).padStart(3, '0')}`,
        bytes = Buffer.from(`{"fictional":"paged derived row ${index}"}\n`),
        path = `${profilePaths(f.root, f.profileId).relativeRoot}/sources/fictional-paged-${index}.jsonl`;
      writeFileSync(join(f.root, path), bytes);
      registerIntakeFile(f.db, {
        id,
        path,
        bytes,
        mimeType: 'application/x-ndjson',
        kind: 'intake_proposal',
        coverage: 'derived_proposal; unreviewed',
        details: { originalSourceFileId: originalId, clinicalProjection: 'none' },
      });
      ids.push(id);
    }
  });
  return ids;
}

for (const backend of ['contributor', 'vault'] as const)
  for (const broken of [false, true])
    test(
      `${backend} interval with a 101-source-row commit ${broken ? 'with a consumed link falls back' : 'appends incrementally in pages'}`,
      { timeout: 300_000 },
      async (t) => {
        const f = await fixture(t, backend);
        const cold = await measure(f.db, () => prepareIntakeLookupIndices(f.db));
        const snapshot = captureIntakeFrontierAttempts(f.db);
        assert.ok(snapshot);
        const fresh = uploadIntake(f.db, f.root, f.profileId, {
          filename: 'fictional-paged-original.txt',
          bytes: Buffer.from('Independently fictional paged native original'),
        });
        await buildIntakeCollectionEnvelope(f.db, fresh);
        const written = registerDerivedRows(f, fresh.id, 101);
        const chain = readIntakeFrontierCommittedChain(f.db, snapshot);
        assert.ok(chain);
        const paged = chain.outcomes.filter(
          (outcome) => !outcome.maintenance && outcome.sourceIds.length === 101,
        );
        assert.equal(paged.length, 1);
        assert.deepEqual([...paged[0]!.sourceIds].sort(), written);
        if (broken) assert.ok(takeRecordAcceptedSourceDeltaCandidate(f.db, paged[0]!.token));
        const prepared = await measure(f.db, () => prepareIntakeLookupIndices(f.db));
        t.diagnostic(JSON.stringify({ backend, broken, cold, prepared }));
        if (broken) {
          // The full fallback rescans all five originals at the cold rate.
          assert.equal(cold.originalRows % 4, 0);
          assert.equal(prepared.appended, 0);
          assert.equal(prepared.builds, 0);
          assert.equal(prepared.originalRows, (cold.originalRows / 4) * 5);
        } else {
          assert.equal(prepared.appended, 1);
          assert.equal(prepared.builds, 0);
          assert.equal(prepared.originalRows, 0);
        }
        assert.equal(intakeFrontierAttemptCounts(f.db)?.revoked, false);
      },
    );

for (const backend of ['contributor', 'vault'] as const)
  test(
    `${backend} incremental discovery revision equals the full revision after each transition`,
    { timeout: 300_000 },
    async (t) => {
      const f = await fixture(t, backend);
      const cold = await measure(f.db, () => prepareIntakeLookupIndices(f.db));
      assert.equal(cold.value.discoveryRevision, intakeDiscoveryRevision(f.db));
      const seen = new Set([cold.value.discoveryRevision]);
      for (let index = 0; index < 3; index++) {
        const fresh = uploadIntake(f.db, f.root, f.profileId, {
          filename: `fictional-transition-${index}.txt`,
          bytes: Buffer.from(`Independently fictional transition original ${index}`),
        });
        await buildIntakeCollectionEnvelope(f.db, fresh);
        const prepared = await measure(f.db, () => prepareIntakeLookupIndices(f.db));
        // Each step is an incremental transition, never a full rescan.
        assert.equal(prepared.appended, 1);
        assert.equal(prepared.builds, 0);
        assert.equal(prepared.originalRows, 0);
        assert.equal(prepared.value.discoveryRevision, intakeDiscoveryRevision(f.db));
        assert.equal(seen.has(prepared.value.discoveryRevision), false);
        seen.add(prepared.value.discoveryRevision);
        assertIntakeDiscoveryRevision(f.db, prepared.value.discoveryRevision);
      }
      // A complete cold derivation over the same rows reaches the same value.
      clearIntakeLookupCache(f.db);
      const recomputed = await measure(f.db, () => prepareIntakeLookupIndices(f.db));
      assert.equal(recomputed.builds, 1);
      assert.equal(recomputed.value.discoveryRevision, intakeDiscoveryRevision(f.db));
      assert.equal(recomputed.value.discoveryRevision, [...seen].at(-1));
    },
  );
