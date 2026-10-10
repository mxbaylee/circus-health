import assert from 'node:assert/strict';
import nodeCrypto, { createHash, randomUUID } from 'node:crypto';
import nodeFs, { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { getRetainedIntakeOriginalReference } from '../intake.ts';
import { getNativeIntakeIdentityReview } from '../intake-identity-native.ts';
import {
  identityCompleteSnapshotId,
  identityEvidenceAliasId,
} from '../intake-identity-snapshot-alias.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { clearIntakeCollectionCache } from '../intake-state-collections.ts';
import { clearIdentityGrounding } from '../intake-identity-grounding.ts';
import { reviewIssueScratchCounts } from '../intake-review-issue-state.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import {
  clearNativeIdentityPreviews,
  nativeIdentityPreviewCounts,
} from '../intake-identity-preview-cache.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import { fixture } from './intake-identity-native-fixture.ts';

test(
  'native identity snapshot work does not synchronously sweep its complete retained proof',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, true, 3, false, undefined, undefined, true);
    const stat = nodeFs.statSync;
    let proofStats = 0;
    const observe = ((path, ...options) => {
      if (new Error().stack?.includes('clinical-review-artifact-proof.ts')) proofStats++;
      return Reflect.apply(stat, nodeFs, [path, ...options]);
    }) as typeof nodeFs.statSync;
    assert.equal(Reflect.set(nodeFs, 'statSync', observe), true);
    syncBuiltinESMExports();
    try {
      const cold = await f.review();
      assert.ok(cold.scopeReference, JSON.stringify(cold));
      clearNativeIdentityPreviews(f.db);
      const current = await f.review();
      assert.deepEqual(current, cold);
      assert.equal(
        proofStats,
        0,
        'preparation and reuse close original signed evidence off-thread',
      );
    } finally {
      assert.equal(Reflect.set(nodeFs, 'statSync', stat), true);
      syncBuiltinESMExports();
    }
  },
);

test(
  'native identity snapshot closes its original proof after callback-capable cooperative work',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, true, 3, false, undefined, undefined, true);
    await f.review();
    await f.review();
    clearNativeIdentityPreviews(f.db);
    const reference = getRetainedIntakeOriginalReference(f.db, f.root, f.profileId, f.original.id);
    const bytes = readFileSync(reference.path);
    let rewrites = 0;
    await assert.rejects(
      runExclusiveClinicalOperation(
        f.db,
        (operation) =>
          getNativeIntakeIdentityReview(f.db, f.root, f.profileId, f.original.id, f.groupId, {
            operation,
          }),
        {
          assertRunning: () => {
            const stack = new Error().stack;
            if (!rewrites && stack?.includes('writeSnapshot')) {
              writeFileSync(reference.path, bytes);
              rewrites++;
            }
          },
        },
      ),
      { code: 'SOURCE_CHANGED' },
    );
    assert.equal(rewrites, 1, 'the real snapshot work must reach the injected original rewrite');
    assert.equal(nativeIdentityPreviewCounts(f.db).entries, 0);
  },
);

test(
  'native identity reuses its first complete build only within a stable request',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, true, 3, false, undefined, undefined, true);
    const preparations = () => intakeWorkCounters(f.db).warm.identityPreviewFullPreparations;
    const originalHash = nodeCrypto.createHash;
    const commitments = { build: 0, certification: 0 };
    const observeHash = ((...args: Parameters<typeof createHash>) => {
      const hash = Reflect.apply(originalHash, nodeCrypto, args);
      const update = hash.update;
      hash.update = function (this: typeof hash, ...values: Parameters<typeof update>) {
        if (values[0] === '[{') {
          const stack = new Error().stack;
          if (stack?.includes('identityScopeCommitmentsWork'))
            commitments[stack.includes('verifyAliasEvidenceWork') ? 'certification' : 'build']++;
        }
        return Reflect.apply(update, this, values);
      } as typeof update;
      return hash;
    }) as typeof createHash;
    assert.equal(Reflect.set(nodeCrypto, 'createHash', observeHash), true);
    syncBuiltinESMExports();
    t.after(() => {
      assert.equal(Reflect.set(nodeCrypto, 'createHash', originalHash), true);
      syncBuiltinESMExports();
    });

    const beforeCold = preparations();
    const beforeGrounding = intakeWorkCounters(f.db).warm.identityPreviewGroundingPreparations;
    const cold = await f.review();
    assert.ok(cold.scopeReference);
    assert.equal(
      preparations() - beforeCold,
      1,
      'cold grounding prepares one complete preview after retaining its original facts',
    );
    assert.equal(
      commitments.build,
      1,
      'cold grounding does not construct a discarded preview scope commitment',
    );
    assert.equal(
      commitments.certification,
      1,
      'initial snapshot certification independently reconstructs its retained commitment',
    );
    assert.equal(
      intakeWorkCounters(f.db).warm.identityPreviewGroundingPreparations - beforeGrounding,
      1,
    );
    assert.equal(nativeIdentityPreviewCounts(f.db).entries, 0);
    const scopePage = (token: string, cursor?: string) =>
      f.request(
        `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${encodeURIComponent(token)}&section=assignmentTargets&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
    const coldPage = await scopePage(cold.scopeReference.scopeToken);
    assert.equal(coldPage.total, 3);
    assert.equal(coldPage.items.length, 2);
    assert.ok(coldPage.nextCursor);
    const coldTail = await scopePage(cold.scopeReference.scopeToken, coldPage.nextCursor);
    assert.equal(coldTail.items.length, 1);
    assert.equal(coldTail.nextCursor, null);

    const beforeStable = preparations();
    const commitmentsBeforeStable = { ...commitments };
    const stable = await f.review();
    assert.deepEqual(stable, cold);
    assert.equal(
      preparations() - beforeStable,
      1,
      'stable proof should reuse its first full build',
    );
    assert.equal(commitments.build - commitmentsBeforeStable.build, 1);
    assert.equal(commitments.certification - commitmentsBeforeStable.certification, 0);
    assert.equal(
      intakeWorkCounters(f.db).warm.identityPreviewGroundingPreparations - beforeGrounding,
      1,
      'stable grounding does not add another discovery pass',
    );
    assert.equal(nativeIdentityPreviewCounts(f.db).entries, 1);
    const stablePage = await scopePage(stable.scopeReference!.scopeToken);
    assert.deepEqual(stablePage, coldPage);
    assert.deepEqual(
      await scopePage(stable.scopeReference!.scopeToken, stablePage.nextCursor),
      coldTail,
    );

    const beforeWarm = preparations();
    const commitmentsBeforeWarm = { ...commitments };
    assert.deepEqual(await f.review(), stable);
    assert.equal(preparations() - beforeWarm, 0, 'retained wire still performs no full build');
    assert.equal(commitments.build - commitmentsBeforeWarm.build, 0);
    assert.equal(commitments.certification - commitmentsBeforeWarm.certification, 0);
  },
);

for (const mutation of [
  'no-op SQL',
  'rolled-back SQL',
  'TEMP schema change',
  'peer SQL',
  'registry revocation',
  'grounding revocation',
] as const)
  test(
    `native identity refuses first-build reuse after terminal ${mutation}`,
    { timeout: 30_000 },
    async (t) => {
      const f = await fixture(t, true, 1, false, undefined, undefined, true);
      await f.review();
      const baseline = await f.review();
      const preparations = () => intakeWorkCounters(f.db).warm.identityPreviewFullPreparations;
      clearNativeIdentityPreviews(f.db);
      const before = preparations();
      const prototype = Object.getPrototypeOf(f.db.prepare('SELECT 1')) as {
        get: (...args: unknown[]) => unknown;
      };
      const originalGet = prototype.get;
      let sourceGetters = 0;
      let stampGetters = 0;
      let injections = 0;
      prototype.get = function (this: { sourceSQL: string }, ...args: unknown[]) {
        const relevant =
          this.sourceSQL === 'PRAGMA temp.schema_version' ||
          this.sourceSQL.startsWith('SELECT id,kind,sha256,details_json FROM source_files');
        const inAdmission = relevant && new Error().stack?.includes('firstBuildCurrent') === true;
        const source =
          inAdmission &&
          this.sourceSQL.startsWith('SELECT id,kind,sha256,details_json FROM source_files');
        const stamp = inAdmission && this.sourceSQL === 'PRAGMA temp.schema_version';
        const value = Reflect.apply(originalGet, this, args);
        // Three admission points: after first build, after grounding, after fresh evidence.
        if (
          (source && ++sourceGetters === 3 && !mutation.endsWith('revocation')) ||
          (stamp && ++stampGetters === 6 && mutation.endsWith('revocation'))
        ) {
          injections++;
          if (mutation === 'registry revocation') clearIntakeCollectionCache(f.db);
          else if (mutation === 'grounding revocation') clearIdentityGrounding(f.db);
          else if (mutation === 'no-op SQL')
            f.db.prepare("UPDATE notes SET title=title WHERE id='person-note:self'").run();
          else if (mutation === 'rolled-back SQL') {
            f.db.exec('SAVEPOINT fictional_identity_probe');
            try {
              f.db.prepare("UPDATE notes SET title=title WHERE id='person-note:self'").run();
              f.db.exec('ROLLBACK TO fictional_identity_probe');
            } finally {
              f.db.exec('RELEASE fictional_identity_probe');
            }
          } else if (mutation === 'TEMP schema change')
            f.db.exec('CREATE TEMP TABLE fictional_identity_probe(value INTEGER)');
          else {
            const peer = new DatabaseSync(ensureProfileDirectories(f.root, f.profileId).database);
            try {
              peer.prepare("UPDATE notes SET title=title WHERE id='person-note:self'").run();
            } finally {
              peer.close();
            }
          }
        }
        return value;
      };
      let value: Awaited<ReturnType<typeof f.review>> | undefined;
      try {
        value = await f.review();
      } finally {
        prototype.get = originalGet;
      }
      assert.equal(injections, 1, 'the terminal getter must be reached exactly once');
      assert.equal(sourceGetters, 3);
      assert.equal(stampGetters, 6);
      if (mutation === 'grounding revocation') assert.ok(value?.scopeReference);
      else assert.deepEqual(value, baseline);
      assert.equal(preparations() - before, 2, 'revoked exact state must retain the full rebuild');
    },
  );

for (const selected of ['original', 'proposal'] as const)
  test(
    `native identity refuses a replaced ${selected} after fresh evidence`,
    { timeout: 30_000 },
    async (t) => {
      const f = await fixture(t, true, 1, false, undefined, undefined, true);
      await f.review();
      await f.review();
      clearNativeIdentityPreviews(f.db);
      const path =
        selected === 'original'
          ? getRetainedIntakeOriginalReference(f.db, f.root, f.profileId, f.original.id).path
          : (() => {
              const row = f.db
                .prepare("SELECT path FROM source_files WHERE kind='intake_proposal'")
                .get();
              assert.ok(row);
              return profileOriginal(f.root, String(row.path), f.profileId);
            })();
      const prototype = Object.getPrototypeOf(f.db.prepare('SELECT 1')) as {
        get: (...args: unknown[]) => unknown;
      };
      const originalGet = prototype.get;
      let stampGetters = 0;
      let replacements = 0;
      prototype.get = function (this: { sourceSQL: string }, ...args: unknown[]) {
        const selectedStamp =
          this.sourceSQL === 'PRAGMA temp.schema_version' &&
          new Error().stack?.includes('firstBuildCurrent');
        const value = Reflect.apply(originalGet, this, args);
        if (selectedStamp && ++stampGetters === 6) {
          const bytes = readFileSync(path);
          const replacement = path + '.fictional-replacement';
          writeFileSync(replacement, bytes);
          renameSync(replacement, path);
          replacements++;
        }
        return value;
      };
      let refused;
      try {
        refused = await f.request(
          'identity-review?groupId=' + encodeURIComponent(f.groupId),
          undefined,
          409,
        );
      } finally {
        prototype.get = originalGet;
      }
      assert.equal(replacements, 1, 'replacement must follow the fresh physical sweep');
      assert.equal(stampGetters, 6);
      assert.equal(refused.error.code, 'SOURCE_CHANGED');
      assert.equal(nativeIdentityPreviewCounts(f.db).entries, 0);
    },
  );

test(
  'nested operation callback changes before the closing reuse stamp',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, true, 1, false, undefined, undefined, true);
    await f.review();
    await f.review();
    const baseline = await getNativeIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      f.original.id,
      f.groupId,
    );
    clearNativeIdentityPreviews(f.db);
    const before = intakeWorkCounters(f.db).warm.identityPreviewFullPreparations;
    let admissionCallbacks = 0;
    const value = await runExclusiveClinicalOperation(
      f.db,
      (operation) =>
        getNativeIntakeIdentityReview(f.db, f.root, f.profileId, f.original.id, f.groupId, {
          operation,
        }),
      {
        assertRunning: () => {
          if (!new Error().stack?.includes('firstBuildCurrent')) return;
          admissionCallbacks++;
          if (admissionCallbacks === 3)
            f.db.prepare("UPDATE notes SET title=title WHERE id='person-note:self'").run();
        },
      },
    );
    assert.equal(admissionCallbacks, 3, 'the parent callback must reach final admission');
    assert.deepEqual(value, baseline);
    assert.equal(
      intakeWorkCounters(f.db).warm.identityPreviewFullPreparations - before,
      2,
      'the final callback mutation must retain the full rebuild',
    );
  },
);

test(
  'native identity aborts a subscriber at final reuse admission',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, true, 1, false, undefined, undefined, true);
    await f.review();
    await f.review();
    clearNativeIdentityPreviews(f.db);
    const beforeScratch = reviewIssueScratchCounts(f.db);
    const controller = new AbortController();
    const prototype = Object.getPrototypeOf(f.db.prepare('SELECT 1')) as {
      get: (...args: unknown[]) => unknown;
    };
    const originalGet = prototype.get;
    let stampGetters = 0;
    let aborts = 0;
    prototype.get = function (this: { sourceSQL: string }, ...args: unknown[]) {
      const finalStamp =
        this.sourceSQL === 'PRAGMA temp.schema_version' &&
        new Error().stack?.includes('firstBuildCurrent') === true;
      const value = Reflect.apply(originalGet, this, args);
      if (finalStamp && ++stampGetters === 6) {
        aborts++;
        controller.abort();
      }
      return value;
    };
    try {
      await assert.rejects(
        getNativeIntakeIdentityReview(f.db, f.root, f.profileId, f.original.id, f.groupId, {
          signal: controller.signal,
        }),
        { name: 'AbortError' },
      );
    } finally {
      prototype.get = originalGet;
    }
    assert.equal(stampGetters, 6, 'abort must occur after the fresh evidence sweep');
    assert.equal(aborts, 1);
    assert.equal(nativeIdentityPreviewCounts(f.db).entries, 0);
    assert.deepEqual(reviewIssueScratchCounts(f.db), beforeScratch);
  },
);

test(
  'reused first build proves proposals before a new catalog checkpoint',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, true, 1, false, undefined, undefined, true);
    await f.review();
    const stable = await f.review();
    assert.ok(stable.evidenceCommitment);
    clearNativeIdentityPreviews(f.db);

    await runExclusiveClinicalOperation(f.db, async () => {
      const collections = selectedEnvelopeStore(f.db, { id: f.original.id }).collections;
      const keys = [
        'identity-current:' + createHash('sha256').update(f.groupId).digest('hex'),
        identityEvidenceAliasId(stable.evidenceCommitment!.sha256),
        identityCompleteSnapshotId(
          stable.evidenceCommitment!.sha256,
          stable.scopeReference!.scopeToken,
        ),
        stable.scopeReference!.collection.snapshotId,
        'identity-warning-content:' + createHash('sha256').update('[]').digest('hex'),
      ];
      for (const key of keys)
        assert.ok(
          collections.getCollectionReference(
            collections.openView(),
            'builds',
            'report.snapshots',
            key,
          ),
          'the setup must remove a real retained alias',
        );
      const operationId = randomUUID();
      collections.commitMaintenance(
        collections.prepare(collections.openView(), {
          operationId,
          requestDigest: createHash('sha256').update(operationId).digest('hex'),
          domainVersion: intakeSourceVersion(f.db, f.original.id).rawVersion,
          changes: keys.map((key) => ({
            area: 'builds' as const,
            collection: 'report.snapshots',
            op: 'delete' as const,
            key,
          })),
        }),
      );
      for (const key of keys)
        assert.equal(
          collections.getCollectionReference(
            collections.openView(),
            'builds',
            'report.snapshots',
            key,
          ),
          undefined,
        );
    });

    const path = (() => {
      const row = f.db.prepare("SELECT path FROM source_files WHERE kind='intake_proposal'").get();
      assert.ok(row);
      return profileOriginal(f.root, String(row.path), f.profileId);
    })();
    const beforeNodes = intakeWorkCounters(f.db).warm.collectionNodesWritten;
    const prototype = Object.getPrototypeOf(f.db.prepare('SELECT 1')) as {
      get: (...args: unknown[]) => unknown;
    };
    const originalGet = prototype.get;
    const originalExec = DatabaseSync.prototype.exec;
    let stampGetters = 0;
    let replacements = 0;
    let commits = 0;
    prototype.get = function (this: { sourceSQL: string }, ...args: unknown[]) {
      const finalStamp =
        this.sourceSQL === 'PRAGMA temp.schema_version' &&
        new Error().stack?.includes('firstBuildCurrent') === true;
      const value = Reflect.apply(originalGet, this, args);
      if (finalStamp && ++stampGetters === 6) {
        const bytes = readFileSync(path);
        const replacement = path + '.fictional-replacement';
        writeFileSync(replacement, bytes);
        renameSync(replacement, path);
        replacements++;
      }
      return value;
    };
    DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
      if (this === f.db && sql.trim().toUpperCase() === 'COMMIT') commits++;
      return Reflect.apply(originalExec, this, [sql]);
    };
    let refused;
    let status = 0;
    try {
      const response = await fetch(
        f.base + 'identity-review?groupId=' + encodeURIComponent(f.groupId),
      );
      status = response.status;
      refused = await response.json();
    } finally {
      prototype.get = originalGet;
      DatabaseSync.prototype.exec = originalExec;
    }
    assert.equal(replacements, 1, 'the proposal changes only after the fresh physical sweep');
    assert.equal(stampGetters, 6);
    assert.equal(commits, 0, 'no catalog or maintenance publication may commit');
    assert.equal(intakeWorkCounters(f.db).warm.collectionNodesWritten - beforeNodes, 0);
    assert.equal(status, 409);
    assert.equal(refused.error.code, 'SOURCE_CHANGED');
    assert.equal(nativeIdentityPreviewCounts(f.db).entries, 0);
  },
);
