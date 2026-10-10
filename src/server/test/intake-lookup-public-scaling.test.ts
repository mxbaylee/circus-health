import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatementSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { IntakeReportAcceptanceRequest } from '../../shared/intake.ts';
import { openDatabase } from '../database.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { openContributorRecordStorage } from '../contributor-record-storage.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { createIntakeFileWorkCounters, withIntakeFileWork } from '../intake-file-work.ts';
import {
  clearIntakeLookupCache,
  intakeLookupCounters,
  maximumIntakeDiscoveryOrder,
  retainedIntakeAcceptance,
} from '../intake-lookup-projection.ts';
import { prepareIntakeLookupIndices } from '../intake-lookup-state.ts';
import {
  acceptIntakeReportSelectionAsync,
  getIntakeReportAcceptanceRead,
} from '../intake-report-acceptance.ts';
import {
  prepareCollectionClinicalReviewAsync,
  prepareCollectionClinicalReviewDependencies,
} from '../intake-review-collection-host.ts';
import { prepareCollectionReviewMembership } from '../intake-review-membership-index.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { proposeConversion, uploadIntake } from '../intake.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import { attachRecordDurability, rebuildRecordDatabase } from '../record-versions.ts';
import { freshKey } from '../vault-crypto.ts';
import { openVault } from '../vault-store.ts';

function fictionalLine(id: string) {
  return JSON.stringify({
    format: 'health-record-v1',
    id,
    kind: 'document',
    payload: { text: 'Independently fictional ' + id },
    provenance: {
      capturedVia: 'Fictional export',
      sourceSystem: 'Fictional clinic',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'Fictional page ' + id,
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: {
      kind: 'document',
      subject: 'self',
      documentTitle: 'Fictional ' + id,
      date: '2026-01-01',
    },
  });
}

function delta<T extends Record<string, number>>(after: T, before: T): T {
  return Object.fromEntries(
    Object.entries(after).map(([key, value]) => [key, value - before[key]!]),
  ) as T;
}

function withoutValue<T extends { value: unknown }>({ value: _value, ...counts }: T) {
  return counts;
}

/** Count returned original rows, including cursor GETs and compatibility scans.
 * Point-selected source reads are separate from the global frontier. */
async function countOriginalRows<T>(run: () => Promise<T>) {
  const get = StatementSync.prototype.get,
    all = StatementSync.prototype.all,
    iterate = StatementSync.prototype.iterate;
  let rows = 0;
  const queries = new Map<string, number>();
  const count = (sql: string, amount: number) => {
    rows += amount;
    queries.set(sql, (queries.get(sql) ?? 0) + amount);
  };
  const globalOriginals = (sql: string) =>
    /\b(?:FROM|JOIN)\s+(?:main\.)?source_files\b/i.test(sql) &&
    /(?:\bkind|\.kind)\s*=\s*'intake_original'/i.test(sql) &&
    !/\b(?:[a-z_]\w*\.)?id\s*=\s*\?/i.test(sql);
  StatementSync.prototype.get = function (
    this: StatementSync,
    ...parameters: Parameters<StatementSync['get']>
  ) {
    const result = Reflect.apply(get, this, parameters);
    if (result && globalOriginals(this.sourceSQL)) count(this.sourceSQL, 1);
    return result;
  } as typeof get;
  StatementSync.prototype.all = function (
    this: StatementSync,
    ...parameters: Parameters<StatementSync['all']>
  ) {
    const result = Reflect.apply(all, this, parameters) as ReturnType<typeof all>;
    if (globalOriginals(this.sourceSQL)) count(this.sourceSQL, result.length);
    return result;
  } as typeof all;
  StatementSync.prototype.iterate = function (
    this: StatementSync,
    ...parameters: Parameters<StatementSync['iterate']>
  ) {
    const sql = this.sourceSQL,
      counted = globalOriginals(sql),
      result = Reflect.apply(iterate, this, parameters) as ReturnType<typeof iterate>;
    return (function* () {
      for (const row of result) {
        if (counted) count(sql, 1);
        yield row;
      }
    })();
  } as typeof iterate;
  try {
    const value = await run();
    return { value, rows, queries: Object.fromEntries(queries) };
  } finally {
    StatementSync.prototype.get = get;
    StatementSync.prototype.all = all;
    StatementSync.prototype.iterate = iterate;
  }
}

async function fixture(t: TestContext, backend: 'vault' | 'contributor', unrelated: number) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-public-lookup-'))),
    profileId = 'fictional-public-lookup',
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
    storage = vault?.recordStorage() ?? contributor!,
    opened = [db];
  t.after(() => {
    for (const connection of opened) {
      clearIntakeLookupCache(connection);
      clearIntakeStateCache(connection);
      connection.close();
    }
    vault?.close();
    contributor?.close();
    key?.fill(0);
    rmSync(root, { recursive: true, force: true });
  });
  attachRecordDurability(db, { profileId, storage });
  const selectedText = [fictionalLine('selected'), fictionalLine('followup')].join('\n'),
    source = uploadIntake(db, root, profileId, {
      filename: 'fictional-selected.jsonl',
      bytes: Buffer.from(selectedText),
    }),
    proposed = proposeConversion(db, root, profileId, source.id, {
      version: source.version,
      jsonlText: selectedText,
      summary: 'Fictional selected records',
    });
  for (let index = 0; index < unrelated; index++) {
    const other = uploadIntake(db, root, profileId, {
      filename: `fictional-unrelated-${index}.txt`,
      bytes: Buffer.from(`Independently fictional unrelated original ${index}`),
    });
    await buildIntakeCollectionEnvelope(db, other);
  }
  // Use genuine encrypted original objects as well as encrypted record authority.
  if (vault) {
    for (const row of db.prepare('SELECT path FROM source_files').iterate()) {
      const path = String(row.path);
      vault.storeFile(path, readFileSync(profileOriginal(root, path, profileId)));
    }
    vault.publish();
  }
  await buildIntakeCollectionEnvelope(db, source);
  await prepareCollectionReviewMembership(db, source);
  const proposalId = proposed.proposals.at(-1)!.id,
    versions =
      backend === 'vault' ? join(paths.root, 'vault', 'versions') : join(paths.records, 'objects');
  const immutableNames = () => new Set(readdirSync(versions));
  const immutableGrowth = (before: Set<string>) => {
    const names = readdirSync(versions).filter((name) => !before.has(name));
    return {
      objects: names.length,
      bytes: names.reduce((bytes, name) => bytes + statSync(join(versions, name)).size, 0),
    };
  };
  const request = (): Promise<IntakeReportAcceptanceRequest> =>
    runExclusiveClinicalOperation(db, async () => {
      await prepareCollectionClinicalReviewDependencies(db, root, profileId, source.id, proposalId);
      const reviewed = await prepareCollectionClinicalReviewAsync(
        db,
        root,
        profileId,
        source.id,
        proposalId,
      );
      assert.equal(reviewed.status, 'ready');
      if (reviewed.status !== 'ready') throw Error('Expected fictional native review');
      try {
        const review = reviewed.session.review,
          record = review.records.find((record) => record.reviewState !== 'accepted')!;
        assert.ok(record, 'one pending fictional record remains');
        return {
          operationId: randomUUID(),
          blocks: [
            {
              intakeId: source.id,
              proposalId,
              intakeVersion: review.version,
              reviewToken: review.reviewToken,
              selections: [
                {
                  recordId: record.id,
                  candidateId: record.candidateId!,
                  candidateVersionId: record.candidateVersionId!,
                  mapping: record.mapping,
                },
              ],
            },
          ],
        };
      } finally {
        reviewed.session.close();
      }
    });
  const measure = async <T>(run: () => Promise<T>) => {
    const lookupBefore = { ...intakeLookupCounters(db) },
      hostBefore = intakeWorkCounters(db),
      recordWork = createRecordVersionWorkCounters(),
      fileWork = createIntakeFileWorkCounters(),
      immutableBefore = immutableNames(),
      counted = await countOriginalRows(() =>
        withRecordVersionWork(recordWork, () => withIntakeFileWork(fileWork, run)),
      ),
      hostAfter = intakeWorkCounters(db);
    return {
      value: counted.value,
      originalRows: counted.rows,
      originalQueries: counted.queries,
      lookup: delta({ ...intakeLookupCounters(db) }, lookupBefore),
      host: {
        primitive: delta(hostAfter.primitive, hostBefore.primitive),
        warm: delta(hostAfter.warm, hostBefore.warm),
        reconstruction: delta(hostAfter.reconstruction, hostBefore.reconstruction),
      },
      recordWork,
      fileWork,
      retainedImmutableGrowth: immutableGrowth(immutableBefore),
    };
  };
  return { db, root, profileId, source, storage, opened, request, measure };
}

for (const backend of ['vault', 'contributor'] as const)
  test(
    `${backend} first and subsequent public acceptance keep lookup work local among unrelated originals`,
    { timeout: 600_000 },
    async (t) => {
      const samples = [];
      for (const unrelated of [4, 64]) {
        const f = await fixture(t, backend, unrelated);
        clearIntakeLookupCache(f.db);
        const cold = await f.measure(() => prepareIntakeLookupIndices(f.db));
        assert.ok(
          cold.originalRows >= unrelated + 1,
          'cold complete membership is counted separately',
        );
        const firstPreparation = await f.measure(async () => f.request()),
          firstRequest = firstPreparation.value;
        const calibration = await countOriginalRows(async () => {
          for (const _row of f.db
            .prepare("SELECT id FROM source_files WHERE kind='intake_original' ORDER BY rowid")
            .iterate()) {
            /* A full fallback must be visible to the oracle. */
          }
        });
        assert.equal(calibration.rows, unrelated + 1);
        const accept = (input: IntakeReportAcceptanceRequest) =>
          f.measure(async () => {
            const result = await acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, input);
            assert.equal(result.replayed, false);
            assert.equal(result.receipt.acceptedCount, 1);
            const reconnect = await getIntakeReportAcceptanceRead(
              f.db,
              f.root,
              f.profileId,
              input.operationId,
            );
            assert.equal(reconnect.replayed, true);
            assert.deepEqual(reconnect.receipt, result.receipt);
            assert.deepEqual(
              (retainedIntakeAcceptance(f.db, input.operationId) as { receipt: unknown }).receipt,
              result.receipt,
            );
            assert.equal(retainedIntakeAcceptance(f.db, randomUUID()), null);
            return result;
          });
        const first = await accept(firstRequest),
          secondPreparation = await f.measure(async () => f.request()),
          secondRequest = secondPreparation.value,
          second = await accept(secondRequest),
          expectedRecords = f.db.prepare('SELECT * FROM documents ORDER BY id').all(),
          maximum = maximumIntakeDiscoveryOrder(f.db);
        assert.equal(expectedRecords.length, 2);
        t.diagnostic(
          JSON.stringify({
            backend,
            unrelated,
            firstPreparationRows: firstPreparation.originalRows,
            firstRows: first.originalRows,
            firstQueries: first.originalQueries,
            secondPreparationRows: secondPreparation.originalRows,
            secondRows: second.originalRows,
            secondQueries: second.originalQueries,
          }),
        );
        for (const sample of [first, second]) {
          assert.ok(
            sample.originalRows <= 1,
            'public changed-source operations must not scan unrelated originals',
          );
          assert.ok(sample.lookup.reconciledSources <= 1);
          assert.equal(sample.lookup.hashedPayloadBytes, 0, 'native receipts remain addressed');
          assert.equal(
            sample.lookup.serializedPayloadBytes,
            0,
            'native lookup cannot copy receipt payloads',
          );
          assert.ok(
            sample.retainedImmutableGrowth.objects > 0,
            'accepted work reaches genuine storage',
          );
          assert.equal(sample.fileWork.writeFailures, 0);
        }
        const head = f.storage.read('head')!;
        for (const request of [firstRequest, secondRequest]) {
          const replay = await acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, request);
          assert.equal(replay.replayed, true);
          assert.deepEqual(
            replay.receipt,
            request === firstRequest ? first.value.receipt : second.value.receipt,
          );
        }
        await assert.rejects(
          acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, {
            ...secondRequest,
            operationId: firstRequest.operationId,
          }),
          { code: 'OPERATION_CONFLICT' },
        );
        assert.deepEqual(f.storage.read('head'), head);
        assert.deepEqual(
          f.db.prepare('SELECT * FROM documents ORDER BY id').all(),
          expectedRecords,
        );
        clearIntakeLookupCache(f.db);
        const rebuild = await f.measure(() => prepareIntakeLookupIndices(f.db));
        assert.ok(rebuild.originalRows >= unrelated + 1);
        assert.equal(maximumIntakeDiscoveryOrder(f.db), maximum);
        const records = createRecordVersionWorkCounters(),
          target = join(f.root, 'fictional-cache-loss.sqlite');
        withRecordVersionWork(records, () =>
          rebuildRecordDatabase(target, { profileId: f.profileId, storage: f.storage }),
        );
        assert.ok(
          records.reconstruction.decodedVersions > 0,
          'cache loss replays immutable accepted evidence',
        );
        const recovered = openDatabase(target, f.profileId);
        f.opened.push(recovered);
        attachRecordDurability(recovered, { profileId: f.profileId, storage: f.storage });
        for (const [request, expected] of [
          [firstRequest, first.value.receipt],
          [secondRequest, second.value.receipt],
        ] as const) {
          assert.deepEqual(
            (
              await getIntakeReportAcceptanceRead(
                recovered,
                f.root,
                f.profileId,
                request.operationId,
              )
            ).receipt,
            expected,
          );
          assert.deepEqual(
            (await acceptIntakeReportSelectionAsync(recovered, f.root, f.profileId, request))
              .receipt,
            expected,
          );
        }
        assert.equal(maximumIntakeDiscoveryOrder(recovered), maximum);
        assert.deepEqual(
          recovered.prepare('SELECT * FROM documents ORDER BY id').all(),
          expectedRecords,
        );
        assert.deepEqual(f.storage.read('head'), head);
        samples.push({
          unrelated,
          cold: withoutValue(cold),
          firstPreparation: withoutValue(firstPreparation),
          first: withoutValue(first),
          secondPreparation: withoutValue(secondPreparation),
          second: withoutValue(second),
          rebuild: withoutValue(rebuild),
          recovery: records,
        });
      }
      t.diagnostic(JSON.stringify({ backend, samples }));
      const [small, large] = samples;
      assert.ok(small && large);
      for (const phase of ['first', 'second'] as const) {
        const a = small[phase],
          b = large[phase];
        for (const metric of [
          'authorityReads',
          'authorityBytes',
          'projectionWrites',
          'projectionBytes',
        ] as const)
          assert.ok(
            b.lookup[metric] <= a.lookup[metric] * 2 + 1024,
            `${phase} ${metric} grows with selected work`,
          );
        for (const metric of [
          'readBytes',
          'streamReadBytes',
          'streamHashBytes',
          'bufferHashBytes',
          'textHashBytes',
        ] as const)
          assert.ok(
            b.fileWork[metric] <= a.fileWork[metric] * 2 + 1024,
            `${phase} ${metric} excludes unrelated originals`,
          );
        assert.ok(
          b.retainedImmutableGrowth.bytes <= a.retainedImmutableGrowth.bytes * 2 + 1024,
          `${phase} retained durable bytes grow with selected work`,
        );
        assert.ok(
          b.host.warm.collectionWrittenBytes <= a.host.warm.collectionWrittenBytes * 2 + 1024,
          `${phase} durable collection bytes grow with selected work`,
        );
      }
      t.diagnostic(
        JSON.stringify({
          backend,
          limitation:
            'Counters are logical API payload work, not total SQL VM work or physical disk traffic. Immutable file growth is read-only retained ciphertext/plaintext size accounting, not an fs-write counter. Complete physical member verification and record core work are reported separately and are not claimed constant. Clinical-review/token preparation is measured separately from acceptance and reconnect; the scaling assertions apply to acceptance and reconnect. Cold lookup preparation and cache-loss replay are explicit rebuild phases.',
        }),
      );
    },
  );
