import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatementSync } from 'node:sqlite';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { createBackup, restoreBackup } from '../recovery.ts';
import { uploadIntake, proposeConversion } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  intakeNamespace,
  parseIntakeCollectionHead,
  type IntakeCollectionHead,
} from '../intake-state-evidence.ts';
import { createIntakeTree, type IntakeTreeRoot } from '../intake-state-tree.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { prepareCollectionClinicalReview } from '../intake-review-collection-host.ts';
import { prepareCollectionReviewMembership } from '../intake-review-membership-index.ts';
import { prepareIntakeLookupIndices } from '../intake-lookup-state.ts';
import { prepareDuplicateEvidenceIndex } from '../duplicate-evidence-index.ts';
import { acceptIntakeReportSelectionAsync } from '../intake-report-acceptance.ts';
import {
  captureIntakeFrontierAttempts,
  ensureIntakeFrontierObserver,
  readIntakeFrontierAttempts,
} from '../intake-lookup-frontier-observer.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import type { IntakeReportAcceptanceRequest } from '../../shared/intake.ts';

function fictionalLine(id: string) {
  return JSON.stringify({
    format: 'health-record-v1',
    id,
    kind: 'document',
    payload: { text: 'Fictional ' + id },
    provenance: {
      capturedVia: 'Fictional export',
      sourceSystem: 'Fictional clinic',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'page ' + id,
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

function changedTreePathBudget(
  db: ReturnType<typeof openDatabase>,
  identity: { profileId: string; intakeId: string; sourceHash: string },
  before: IntakeCollectionHead,
  after: IntakeCollectionHead,
) {
  const prefix = intakeNamespace(identity),
    readNode = db.prepare('SELECT value FROM app_meta WHERE key=?'),
    tree = createIntakeTree(
      identity,
      (hash) => readNode.get(prefix + 'node:' + hash)?.value,
      new Map(),
    );
  const visited = new Set<string>();
  let changedKeys = 0,
    pathBudget = 0;
  const nested = (raw: string): IntakeTreeRoot | undefined => {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!value || typeof value !== 'object') return undefined;
    const cell = value as {
      kind?: string;
      root?: IntakeTreeRoot;
      descriptor?: { root?: IntakeTreeRoot };
    };
    if (['map', 'sequence', 'bytes'].includes(cell.kind ?? '')) return cell.root;
    if (cell.kind === 'collection') return cell.descriptor?.root;
    return undefined;
  };
  const compare = (left: IntakeTreeRoot, right: IntakeTreeRoot) => {
    if (left?.hash === right?.hash) return;
    const pair = (left?.hash ?? '') + ':' + (right?.hash ?? '');
    if (visited.has(pair)) return;
    visited.add(pair);
    const old = tree.entries(left)[Symbol.iterator](),
      current = tree.entries(right)[Symbol.iterator]();
    let beforeEntry = old.next(),
      afterEntry = current.next(),
      localChanges = 0;
    while (!beforeEntry.done || !afterEntry.done) {
      if (afterEntry.done || (!beforeEntry.done && beforeEntry.value.key < afterEntry.value.key)) {
        localChanges++;
        compare(nested(beforeEntry.value.value) ?? null, null);
        beforeEntry = old.next();
      } else if (beforeEntry.done || afterEntry.value.key < beforeEntry.value.key) {
        localChanges++;
        compare(null, nested(afterEntry.value.value) ?? null);
        afterEntry = current.next();
      } else {
        if (beforeEntry.value.value !== afterEntry.value.value) {
          localChanges++;
          compare(nested(beforeEntry.value.value) ?? null, nested(afterEntry.value.value) ?? null);
        }
        beforeEntry = old.next();
        afterEntry = current.next();
      }
    }
    changedKeys += localChanges;
    pathBudget += 4 * localChanges * (Math.max(left?.height ?? 0, right?.height ?? 0) + 1);
  };
  compare(before.logical.root, after.logical.root);
  compare(before.receipts, after.receipts);
  compare(before.history, after.history);
  compare(before.builds, after.builds);
  return { changedKeys, pathBudget };
}

test(
  'durable first and follow-up acceptance measure unrelated-original work at 8 and 32 sources',
  { timeout: 240000 },
  async (t) => {
    const observations: Array<{
      phase: 'first' | 'followup';
      unrelated: number;
      globalRows: number;
      globalQueries: number;
      aggregateSourceQueries: number;
      unrelatedPointRows: number;
      unrelatedPointQueries: number;
      unrelatedPointShapes: readonly { sql: string; queries: number }[];
      frontierAttempts: number | null;
      frontierRearmed: boolean;
      frontierAfter: number | null;
      durableVersions: number;
      durableByEntity: readonly { entity: string; versions: number }[];
      durableCollectionNodes: number;
      selectedChangedKeys: number;
      selectedPathBudget: number;
      unrelatedDurableSourceVersions: number;
      unrelatedDurableMetadataVersions: number;
      unrelatedMetadataKinds: readonly { kind: string; versions: number }[];
      nodesWritten: number;
    }> = [];
    for (const unrelatedCount of [8, 32]) {
      const root = mkdtempSync(join(tmpdir(), 'fictional-durable-frontier-')),
        profileId = 'fictional-durable-frontier',
        db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
      attachPersonalDurability(db, { root, profileId });
      try {
        const selectedText = [
          fictionalLine('selected-first'),
          fictionalLine('selected-second'),
        ].join('\n');
        const original = uploadIntake(db, root, profileId, {
          filename: 'fictional-selected.jsonl',
          bytes: Buffer.from(selectedText),
        });
        const proposed = proposeConversion(db, root, profileId, original.id, {
          version: original.version,
          jsonlText: selectedText,
          summary: 'Fictional selected records',
        });
        const unrelated = new Set<string>();
        const unrelatedNamespaces = new Set<string>();
        for (let index = 0; index < unrelatedCount; index++) {
          const source = uploadIntake(db, root, profileId, {
            filename: `fictional-unrelated-${index}.txt`,
            bytes: Buffer.from(`Independently fictional unrelated original ${index}`),
          });
          unrelated.add(source.id);
          unrelatedNamespaces.add(
            intakeNamespace({
              profileId,
              intakeId: source.id,
              sourceHash: source.sha256,
            }),
          );
          await buildIntakeCollectionEnvelope(db, { id: source.id });
        }
        await buildIntakeCollectionEnvelope(db, { id: original.id });
        await prepareCollectionReviewMembership(db, { id: original.id });
        const proposalId = proposed.proposals.at(-1)!.id;
        const unrelatedNamespacePrefixes = [...unrelatedNamespaces];
        const selectedIdentity = {
          profileId,
          intakeId: original.id,
          sourceHash: original.sha256,
        };
        const selectedHead = db.prepare('SELECT value FROM app_meta WHERE key=?');
        const head = () => {
          const current = parseIntakeCollectionHead(
            selectedHead.get(intakeNamespace(selectedIdentity) + 'head')?.value,
            selectedIdentity,
          );
          assert.ok(current);
          return current;
        };
        const request = (index: number): IntakeReportAcceptanceRequest => {
          const reviewed = prepareCollectionClinicalReview(
            db,
            root,
            profileId,
            original.id,
            proposalId,
          );
          if (reviewed.status !== 'ready') throw Error('Expected selected durable review');
          try {
            const review = reviewed.session.review;
            const record = review.records[index];
            if (!record) throw Error('Missing selected fictional record');
            return {
              operationId: randomUUID(),
              blocks: [
                {
                  intakeId: original.id,
                  proposalId,
                  intakeVersion: review.version,
                  reviewToken: review.reviewToken,
                  selections: [
                    {
                      recordId: record.id,
                      candidateId: record.candidateId!,
                      candidateVersionId: record.candidateVersionId!,
                      mapping: structuredClone(record.mapping),
                    },
                  ],
                },
              ],
            };
          } finally {
            reviewed.session.close();
          }
        };
        const measure = async (
          phase: 'first' | 'followup',
          input: IntakeReportAcceptanceRequest,
        ) => {
          ensureIntakeFrontierObserver(db);
          const frontierBefore = captureIntakeFrontierAttempts(db);
          assert.ok(frontierBefore);
          const sequenceBefore = Number(
            db.prepare('SELECT sequence FROM __record_state WHERE singleton=1').get()!.sequence,
          );
          const headBefore = head();
          const workBefore = intakeWorkCounters(db);
          const nativeGet = StatementSync.prototype.get,
            nativeAll = StatementSync.prototype.all,
            nativeIterate = StatementSync.prototype.iterate;
          let globalRows = 0,
            globalQueries = 0,
            unrelatedPointRows = 0,
            unrelatedPointQueries = 0,
            aggregateSourceQueries = 0;
          const pointShapes = new Map<string, number>();
          const count = (
            statement: StatementSync,
            rows: number,
            parameters: readonly unknown[],
            query: boolean,
          ) => {
            const sql = statement.sourceSQL;
            if (!/\b(?:FROM|JOIN)\s+(?:main\.)?source_files\b/i.test(sql)) return;
            const keyed = /\b(?:[a-z_]\w*\.)?id\s*=\s*\?/i.test(sql);
            if (!keyed) {
              if (query) globalQueries++;
              globalRows += rows;
              if (query && /\b(?:count|sum|min|max|avg)\s*\(/i.test(sql)) aggregateSourceQueries++;
            } else if (
              parameters.some((value) => typeof value === 'string' && unrelated.has(value))
            ) {
              if (query) {
                unrelatedPointQueries++;
                pointShapes.set(sql, (pointShapes.get(sql) ?? 0) + 1);
              }
              unrelatedPointRows += rows;
            }
          };
          StatementSync.prototype.get = function (
            this: StatementSync,
            ...parameters: Parameters<StatementSync['get']>
          ) {
            const row = Reflect.apply(nativeGet, this, parameters);
            count(this, row ? 1 : 0, parameters, true);
            return row;
          } as typeof StatementSync.prototype.get;
          StatementSync.prototype.all = function (
            this: StatementSync,
            ...parameters: Parameters<StatementSync['all']>
          ) {
            const rows = Reflect.apply(nativeAll, this, parameters) as ReturnType<
              StatementSync['all']
            >;
            count(this, rows.length, parameters, true);
            return rows;
          } as typeof StatementSync.prototype.all;
          StatementSync.prototype.iterate = function (
            this: StatementSync,
            ...parameters: Parameters<StatementSync['iterate']>
          ) {
            const rows = Reflect.apply(nativeIterate, this, parameters) as ReturnType<
              StatementSync['iterate']
            >;
            const statement = this;
            count(statement, 0, parameters, true);
            return (function* () {
              for (const row of rows) {
                count(statement, 1, parameters, false);
                yield row;
              }
            })();
          } as typeof StatementSync.prototype.iterate;
          let result: Awaited<ReturnType<typeof acceptIntakeReportSelectionAsync>>;
          try {
            result = await acceptIntakeReportSelectionAsync(db, root, profileId, input);
          } finally {
            StatementSync.prototype.get = nativeGet;
            StatementSync.prototype.all = nativeAll;
            StatementSync.prototype.iterate = nativeIterate;
          }
          assert.equal(result.replayed, false);
          assert.equal(result.receipt.acceptedCount, 1);
          const frontier = readIntakeFrontierAttempts(db, frontierBefore);
          const frontierAfter = captureIntakeFrontierAttempts(db);
          const frontierRearmed =
            frontierAfter !== undefined && frontierAfter.identity !== frontierBefore.identity;
          const frontierAttempts =
            frontier?.attempts ??
            (frontierAfter !== undefined && !frontierRearmed
              ? frontierAfter.attempts - frontierBefore.attempts
              : null);
          const durableRows = db
            .prepare(
              'SELECT entity,record_id FROM __record_versions WHERE sequence>? ORDER BY sequence',
            )
            .all(sequenceBefore);
          const unrelatedDurableSourceVersions = durableRows.filter((row) => {
            if (row.entity !== 'source_files') return false;
            const [id] = JSON.parse(String(row.record_id)) as string[];
            return unrelated.has(id);
          }).length;
          const entityCounts = new Map<string, number>();
          const metadataKinds = new Map<string, number>();
          let durableCollectionNodes = 0,
            unrelatedDurableMetadataVersions = 0;
          for (const row of durableRows) {
            const entity = String(row.entity);
            entityCounts.set(entity, (entityCounts.get(entity) ?? 0) + 1);
            if (entity === 'app_meta') {
              const [key] = JSON.parse(String(row.record_id)) as string[];
              if (key.includes(':node:')) durableCollectionNodes++;
              const unrelatedPrefix = unrelatedNamespacePrefixes.find((prefix) =>
                key.startsWith(prefix),
              );
              if (unrelatedPrefix) {
                unrelatedDurableMetadataVersions++;
                const suffix = key.slice(unrelatedPrefix.length),
                  kind = suffix.startsWith('node:') ? 'node' : suffix === 'head' ? 'head' : 'other';
                metadataKinds.set(kind, (metadataKinds.get(kind) ?? 0) + 1);
              }
            }
          }
          const workAfter = intakeWorkCounters(db);
          const nodesWritten =
            workAfter.warm.collectionNodesWritten -
            workBefore.warm.collectionNodesWritten +
            workAfter.reconstruction.collectionNodesWritten -
            workBefore.reconstruction.collectionNodesWritten;
          const changedPath = changedTreePathBudget(db, selectedIdentity, headBefore, head());
          const observation = {
            phase,
            unrelated: unrelatedCount,
            globalRows,
            globalQueries,
            aggregateSourceQueries,
            unrelatedPointRows,
            unrelatedPointQueries,
            unrelatedPointShapes: [...pointShapes]
              .map(([sql, queries]) => ({ sql, queries }))
              .sort((a, b) => b.queries - a.queries)
              .slice(0, 5),
            frontierAttempts,
            frontierRearmed,
            frontierAfter: frontierAfter?.attempts ?? null,
            durableVersions: durableRows.length,
            durableByEntity: [...entityCounts]
              .map(([entity, versions]) => ({ entity, versions }))
              .sort((left, right) => left.entity.localeCompare(right.entity)),
            durableCollectionNodes,
            selectedChangedKeys: changedPath.changedKeys,
            selectedPathBudget: changedPath.pathBudget,
            unrelatedDurableSourceVersions,
            unrelatedDurableMetadataVersions,
            unrelatedMetadataKinds: [...metadataKinds]
              .map(([kind, versions]) => ({ kind, versions }))
              .sort((left, right) => left.kind.localeCompare(right.kind)),
            nodesWritten,
          };
          observations.push(observation);
          t.diagnostic(JSON.stringify(observation));
          assert.equal(unrelatedDurableSourceVersions, 0);
          if (phase === 'followup') assert.equal(unrelatedDurableMetadataVersions, 0);
          assert.ok(durableCollectionNodes <= changedPath.pathBudget);
          return result;
        };
        const firstRequest = request(0);
        await measure('first', firstRequest);
        await prepareIntakeLookupIndices(db);
        await prepareDuplicateEvidenceIndex(db);
        const secondRequest = request(1);
        const second = await measure('followup', secondRequest);
        assert.deepEqual(
          db
            .prepare('SELECT title FROM documents ORDER BY title')
            .all()
            .map((row) => row.title),
          ['Fictional selected-first', 'Fictional selected-second'],
        );
        clearIntakeStateCache(db);
        const replay = await acceptIntakeReportSelectionAsync(db, root, profileId, secondRequest);
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.receipt, second.receipt);
      } finally {
        clearIntakeStateCache(db);
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
    assert.deepEqual(
      observations.map(({ phase, unrelated }) => [phase, unrelated]),
      [
        ['first', 8],
        ['followup', 8],
        ['first', 32],
        ['followup', 32],
      ],
    );
    for (const observation of observations) {
      assert.ok(observation.durableVersions > 0);
      assert.ok(observation.nodesWritten > 0);
      assert.ok(observation.frontierAttempts === null || observation.frontierAttempts >= 0);
      assert.ok(observation.frontierAttempts !== null || observation.frontierRearmed);
    }
    const cold = observations.filter((observation) => observation.phase === 'first');
    const followup = observations.filter((observation) => observation.phase === 'followup');
    assert.equal(cold.length, 2);
    assert.equal(followup.length, 2);
    assert.ok(cold[1]!.globalRows > cold[0]!.globalRows);
    assert.ok(cold[1]!.unrelatedPointRows > cold[0]!.unrelatedPointRows);
    for (const observation of followup) {
      assert.equal(observation.globalQueries, 0);
      assert.equal(observation.globalRows, 0);
      assert.equal(observation.unrelatedPointQueries, 0);
      assert.equal(observation.unrelatedPointRows, 0);
      assert.equal(observation.aggregateSourceQueries, 0);
      assert.ok(observation.frontierAttempts !== null);
    }
  },
);

test(
  'paired accepted preimage bounds follow-up durable writes across unrelated originals',
  { timeout: 240000 },
  async (t) => {
    const fixture = mkdtempSync(join(tmpdir(), 'fictional-durable-frontier-paired-')),
      root = join(fixture, 'active'),
      profileId = 'fictional-durable-frontier',
      selectedText = [fictionalLine('selected-first'), fictionalLine('selected-second')].join('\n'),
      operationId = randomUUID();
    let db: ReturnType<typeof openDatabase> | undefined;
    const close = () => {
      if (!db) return;
      clearIntakeStateCache(db);
      db.close();
      db = undefined;
    };
    const open = (initialize: boolean) => {
      const current = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
      attachPersonalDurability(current, { root, profileId, initialize });
      db = current;
      return current;
    };
    const request = (
      current: ReturnType<typeof openDatabase>,
      intakeId: string,
      proposalId: string,
      index: number,
      selectedOperationId: string,
    ): IntakeReportAcceptanceRequest => {
      const reviewed = prepareCollectionClinicalReview(
        current,
        root,
        profileId,
        intakeId,
        proposalId,
      );
      if (reviewed.status !== 'ready') throw Error('Expected paired durable review');
      try {
        const review = reviewed.session.review,
          record = review.records[index];
        if (!record) throw Error('Missing paired fictional record');
        return {
          operationId: selectedOperationId,
          blocks: [
            {
              intakeId,
              proposalId,
              intakeVersion: review.version,
              reviewToken: review.reviewToken,
              selections: [
                {
                  recordId: record.id,
                  candidateId: record.candidateId!,
                  candidateVersionId: record.candidateVersionId!,
                  mapping: structuredClone(record.mapping),
                },
              ],
            },
          ],
        };
      } finally {
        reviewed.session.close();
      }
    };
    try {
      const initial = open(true),
        original = uploadIntake(initial, root, profileId, {
          filename: 'fictional-selected.jsonl',
          bytes: Buffer.from(selectedText),
        }),
        proposed = proposeConversion(initial, root, profileId, original.id, {
          version: original.version,
          jsonlText: selectedText,
          summary: 'Fictional selected records',
        }),
        proposalId = proposed.proposals.at(-1)!.id;
      await buildIntakeCollectionEnvelope(initial, { id: original.id });
      await prepareCollectionReviewMembership(initial, { id: original.id });
      const first = await acceptIntakeReportSelectionAsync(
        initial,
        root,
        profileId,
        request(initial, original.id, proposalId, 0, randomUUID()),
      );
      assert.equal(first.replayed, false);
      assert.equal(first.receipt.acceptedCount, 1);
      const backup = await createBackup(initial, root, profileId, join(fixture, 'template'));
      close();
      const observations: Array<{
        unrelated: number;
        durableVersions: number;
        nodesWritten: number;
        selectedHeadBefore: string;
        unrelatedSourceVersions: number;
        unrelatedMetadataVersions: number;
      }> = [];
      for (const unrelatedCount of [8, 32]) {
        rmSync(root, { recursive: true, force: true });
        restoreBackup(backup.path, root);
        const current = open(false),
          unrelated = new Set<string>(),
          unrelatedNamespaces = new Set<string>();
        for (let index = 0; index < unrelatedCount; index++) {
          const source = uploadIntake(current, root, profileId, {
            filename: `fictional-unrelated-${index}.txt`,
            bytes: Buffer.from(`Independently fictional unrelated original ${index}`),
          });
          unrelated.add(source.id);
          unrelatedNamespaces.add(
            intakeNamespace({ profileId, intakeId: source.id, sourceHash: source.sha256 }),
          );
          await buildIntakeCollectionEnvelope(current, { id: source.id });
        }
        await prepareIntakeLookupIndices(current);
        await prepareDuplicateEvidenceIndex(current);
        const selectedHeadBefore = current
          .prepare('SELECT value FROM app_meta WHERE key=?')
          .get(
            intakeNamespace({ profileId, intakeId: original.id, sourceHash: original.sha256 }) +
              'head',
          )?.value;
        if (typeof selectedHeadBefore !== 'string') throw Error('Missing selected paired HEAD');
        const input = request(current, original.id, proposalId, 1, operationId),
          sequenceBefore = Number(
            current.prepare('SELECT sequence FROM __record_state WHERE singleton=1').get()!
              .sequence,
          ),
          workBefore = intakeWorkCounters(current);
        const result = await acceptIntakeReportSelectionAsync(current, root, profileId, input);
        assert.equal(result.replayed, false);
        assert.equal(result.receipt.acceptedCount, 1);
        const durableRows = current
            .prepare('SELECT entity,record_id FROM __record_versions WHERE sequence>?')
            .all(sequenceBefore),
          workAfter = intakeWorkCounters(current),
          observation = {
            unrelated: unrelatedCount,
            durableVersions: durableRows.length,
            nodesWritten:
              workAfter.warm.collectionNodesWritten -
              workBefore.warm.collectionNodesWritten +
              workAfter.reconstruction.collectionNodesWritten -
              workBefore.reconstruction.collectionNodesWritten,
            selectedHeadBefore,
            unrelatedSourceVersions: durableRows.filter((row) => {
              if (row.entity !== 'source_files') return false;
              const [id] = JSON.parse(String(row.record_id)) as string[];
              return unrelated.has(id);
            }).length,
            unrelatedMetadataVersions: durableRows.filter((row) => {
              if (row.entity !== 'app_meta') return false;
              const [key] = JSON.parse(String(row.record_id)) as string[];
              return [...unrelatedNamespaces].some((prefix) => key.startsWith(prefix));
            }).length,
          };
        observations.push(observation);
        t.diagnostic(
          JSON.stringify({
            ...observation,
            selectedHeadBefore: createHash('sha256')
              .update(observation.selectedHeadBefore)
              .digest('hex'),
          }),
        );
        assert.equal(observation.unrelatedSourceVersions, 0);
        assert.equal(observation.unrelatedMetadataVersions, 0);
        assert.deepEqual(
          current
            .prepare('SELECT title FROM documents ORDER BY title')
            .all()
            .map((row) => row.title),
          ['Fictional selected-first', 'Fictional selected-second'],
        );
        clearIntakeStateCache(current);
        const replay = await acceptIntakeReportSelectionAsync(current, root, profileId, input);
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.receipt, result.receipt);
        close();
      }
      assert.equal(observations.length, 2);
      assert.equal(observations[0]!.selectedHeadBefore, observations[1]!.selectedHeadBefore);
      assert.ok(observations[1]!.durableVersions <= observations[0]!.durableVersions + 64);
      assert.ok(observations[1]!.nodesWritten <= observations[0]!.nodesWritten + 64);
    } finally {
      close();
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);
