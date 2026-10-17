/** Independently fictional stage isolation; does not replace HTTP/encrypted qualification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import { openContributorRecordStorage } from '../contributor-record-storage.ts';
import { registerIntakeFile } from '../intake-state-access.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { attachRecordDurability, rebuildRecordDatabase } from '../record-versions.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import {
  captureIntakeStateCopySnapshot,
  validateProductionIntakeAuthority,
} from '../intake-state-bootstrap.ts';
import { IntakeStateManifest } from '../intake-state-manifest.ts';
import { inspectIntakeCollectionGraph } from '../intake-state-graph.ts';
import { intakeNamespace, parseIntakeCollectionHead } from '../intake-state-evidence.ts';
import {
  createIntakeEnvelopeGraphReader,
  iterateSchemaEnvelopeText,
  validateIntakeCollectionEnvelopeRepresentation,
  iterateIntakeEnvelopeText,
} from '../intake-collection-envelope.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { validateIntakeSchemaReachability } from '../intake-envelope-schema-validation.ts';
import { prepareIntakeLookupIndices } from '../intake-lookup-projection.ts';
import { intakeWorkCounters, withIntakeWork } from '../intake-work-accounting.ts';

const nonzero = (values: Record<string, number>) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== 0));
const delta = (after: Record<string, number>, before: Record<string, number>) =>
  nonzero(
    Object.fromEntries(
      Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)]),
    ),
  );

for (const count of [4, 16])
  test(`cold recovery stage breakdown retains exact evidence at ${count} records`, async (t) => {
    const temporary = mkdtempSync(join(tmpdir(), 'fictional-recovery-breakdown-'));
    const opened: ReturnType<typeof openDatabase>[] = [];
    let storage: ReturnType<typeof openContributorRecordStorage> | undefined;
    t.after(() => {
      let firstError: unknown;
      let failed = false;
      const cleanup = (run: () => void) => {
        try {
          run();
        } catch (error) {
          if (!failed) firstError = error;
          failed = true;
        }
      };
      for (const connection of opened) {
        cleanup(() => clearIntakeStateCache(connection));
        cleanup(() => {
          if (connection.isOpen) connection.close();
        });
      }
      cleanup(() => storage?.close());
      cleanup(() => rmSync(temporary, { recursive: true, force: true }));
      if (failed) throw firstError;
    });
    const directory = realpathSync.native(temporary);
    const profileId = 'fictional-recovery-stages';
    const paths = ensureProfileDirectories(directory, profileId),
      db = openDatabase(paths.database, profileId);
    opened.push(db);
    storage = openContributorRecordStorage(directory, profileId, { initialize: true });
    const text =
      '{"intake":{"version":0,"state":"pending","workflow":' +
      JSON.stringify({
        format: 'health-intake-workflow-v1',
        candidates: Array.from({ length: count }, (_, index) => ({
          id: `fictional-candidate-${index}`,
          versions: [{ id: `fictional-version-${index}`, status: 'pending', occurrences: [] }],
        })),
      }) +
      '},"unknown":{"same":1,"same":2,"literal":"fictional"}}';
    const originalPath = profilePaths(directory, profileId).relativeRoot + '/sources/fictional.txt',
      source = {
        id: 'fictional-original',
        kind: 'intake_original',
        sha256: createHash('sha256').update(text).digest('hex'),
      };
    writeFileSync(join(directory, originalPath), text);
    attachRecordDurability(db, { profileId, storage });
    const initialStarted = performance.now(),
      initialRecords = createRecordVersionWorkCounters(),
      initialBefore = intakeWorkCounters(db);
    await withRecordVersionWork(initialRecords, async () => {
      transaction(db, () =>
        registerIntakeFile(db, {
          ...source,
          path: originalPath,
          size: Buffer.byteLength(text),
          mimeType: 'text/plain',
          coverage: 'unknown',
          details: text,
        }),
      );
      await buildIntakeCollectionEnvelope(db, source);
    });
    const initialAfter = intakeWorkCounters(db);
    t.diagnostic(
      JSON.stringify({
        stage: 'initial-registration-and-build',
        count,
        ms: performance.now() - initialStarted,
        records: {
          operation: nonzero(initialRecords.operation),
          reconstruction: nonzero(initialRecords.reconstruction),
        },
        intake: {
          primitive: delta(initialAfter.primitive, initialBefore.primitive),
          warm: delta(initialAfter.warm, initialBefore.warm),
          reconstruction: delta(initialAfter.reconstruction, initialBefore.reconstruction),
        },
      }),
    );
    const original = captureIntakeStateCopySnapshot(db, profileId);
    const fingerprint = () =>
      createHash('sha256')
        .update(JSON.stringify(captureIntakeStateCopySnapshot(db, profileId)))
        .digest('hex');
    const before = fingerprint();
    const recordWork = createRecordVersionWorkCounters();
    const path = join(directory, 'rebuilt.sqlite');
    let started = performance.now();
    withRecordVersionWork(recordWork, () => rebuildRecordDatabase(path, { profileId, storage }));
    t.diagnostic(
      JSON.stringify({
        stage: 'accepted-journal-replay',
        count,
        ms: performance.now() - started,
        work: recordWork.reconstruction,
      }),
    );
    const rebuilt = openDatabase(path, profileId);
    opened.push(rebuilt);
    assert.deepEqual(captureIntakeStateCopySnapshot(rebuilt, profileId), original);
    const manifest = new IntakeStateManifest();
    try {
      started = performance.now();
      for (const row of original.rows)
        manifest.put('source', row.key, row.value, row.key.split(':').slice(0, 2).join(':') + ':');
      t.diagnostic(
        JSON.stringify({
          stage: 'manifest-copy',
          count,
          rows: original.rows.length,
          ms: performance.now() - started,
        }),
      );
      const identity = { profileId, intakeId: source.id, sourceHash: source.sha256 };
      const prefix = intakeNamespace(identity);
      const get = manifest.db.prepare('SELECT value FROM source WHERE key=?');
      const head = parseIntakeCollectionHead(get.get(prefix + 'head')!.value, identity)!;
      let checkpoints = 0;
      started = performance.now();
      const beforeGraph = intakeWorkCounters(db).reconstruction;
      withIntakeWork(db, 'reconstruction', () => {
        inspectIntakeCollectionGraph(
          manifest,
          identity,
          String(get.get(prefix + 'head')!.value),
          undefined,
          () => checkpoints++,
        );
      });
      const afterGraph = intakeWorkCounters(db).reconstruction;
      const graphWork = {
        reads: afterGraph.graphScratchSeenReads - beforeGraph.graphScratchSeenReads,
        writes: afterGraph.graphScratchSeenWrites - beforeGraph.graphScratchSeenWrites,
      };
      t.diagnostic(JSON.stringify({ stage: 'typed-encrypted-graph-work', count, ...graphWork }));
      // Actual typed summary operations replace the removed SQL implementation
      // probe. These counts establish substantial graph work, not coverage by
      // themselves; exact recovery and representation checks remain below.
      assert.ok(graphWork.reads > 100, 'typed graph summary reads execute substantial work');
      assert.ok(graphWork.writes > 100, 'typed graph summary writes execute substantial work');
      assert.ok(graphWork.reads >= graphWork.writes);
      t.diagnostic(
        JSON.stringify({
          stage: 'historical-graph',
          count,
          checkpoints,
          ms: performance.now() - started,
        }),
      );
      const reads = new Set<string>();
      let calls = 0,
        bytes = 0;
      started = performance.now();
      const result = validateIntakeCollectionEnvelopeRepresentation(
        original.originals[0]!.detailsJson,
        head,
        (hash) => {
          const raw = get.get(prefix + 'node:' + hash)?.value;
          calls++;
          reads.add(hash);
          if (typeof raw === 'string') bytes += Buffer.byteLength(raw);
          return raw;
        },
      );
      assert.equal(result.domainVersion, 0);
      t.diagnostic(
        JSON.stringify({
          stage: 'schema-and-lexical-validation',
          count,
          calls,
          uniqueNodes: reads.size,
          bytes,
          ms: performance.now() - started,
        }),
      );
      const sample = (allowPrefix: boolean) => {
        let nodeReads = 0,
          nodeBytes = 0;
        const { store, control } = createIntakeEnvelopeGraphReader(identity, head, (hash) => {
          const raw = get.get(prefix + 'node:' + hash)?.value;
          nodeReads++;
          if (typeof raw === 'string') nodeBytes += Buffer.byteLength(raw);
          return raw;
        });
        // Older/custom stores support only the original three arguments. Keep
        // the real cold reader, checks and values, but omit the optional hint.
        if (!allowPrefix) {
          const range = store.range;
          store.range = (after, items, bytes) => range(after, items, bytes);
        }
        validateIntakeSchemaReachability(store, control);
        assert.equal([...iterateSchemaEnvelopeText(store, control)].join(''), text);
        return { nodeReads, nodeBytes };
      };
      const graph = createIntakeEnvelopeGraphReader(
        identity,
        head,
        (hash) => get.get(prefix + 'node:' + hash)?.value,
      );
      const orderPrefix = 'o:' + graph.control.root + ':';
      const expectedOrder = graph.store
        .range(orderPrefix, 64, 65536)
        .items.filter((row) => row.key.startsWith(orderPrefix));
      const actualOrder = [];
      let after = orderPrefix;
      for (;;) {
        const page = graph.store.range(after, 1, 65536, orderPrefix);
        assert.ok(page.items.every((row) => row.key.startsWith(orderPrefix)));
        actualOrder.push(...page.items);
        if (page.complete) break;
        assert.equal(page.items.length, 1);
        assert.ok(page.items[0]!.key > after);
        after = page.items[0]!.key;
      }
      assert.deepEqual(actualOrder, expectedOrder);
      assert.deepEqual(graph.store.range('nonexistent:', 64, 65536, 'nonexistent:'), {
        items: [],
        complete: true,
      });
      assert.throws(() => graph.store.range(orderPrefix, 1, 65536, 'foreign:'), /prefix cursor/);
      const fallback = sample(false),
        bounded = sample(true);
      t.diagnostic(JSON.stringify({ stage: 'prefix-read-comparison', count, fallback, bounded }));
      assert.ok(
        bounded.nodeReads < fallback.nodeReads,
        'schema prefixes do not fill pages with unrelated cells',
      );
      assert.ok(
        bounded.nodeBytes < fallback.nodeBytes,
        'complete lexical validation reads fewer unrelated bytes',
      );
    } finally {
      manifest.close();
    }
    started = performance.now();
    validateProductionIntakeAuthority(rebuilt, profileId);
    attachRecordDurability(rebuilt, { profileId, storage });
    t.diagnostic(
      JSON.stringify({
        stage: 'full-production-validation-and-attach',
        count,
        ms: performance.now() - started,
      }),
    );
    started = performance.now();
    const lookupBefore = intakeWorkCounters(rebuilt),
      lookupRecords = createRecordVersionWorkCounters();
    const indexed = await withRecordVersionWork(lookupRecords, () =>
      prepareIntakeLookupIndices(rebuilt),
    );
    const lookupAfter = intakeWorkCounters(rebuilt);
    t.diagnostic(
      JSON.stringify({
        stage: 'lookup-index-preparation',
        count,
        ms: performance.now() - started,
        prepared: indexed.prepared,
        records: {
          operation: nonzero(lookupRecords.operation),
          reconstruction: nonzero(lookupRecords.reconstruction),
        },
        intake: {
          primitive: delta(lookupAfter.primitive, lookupBefore.primitive),
          warm: delta(lookupAfter.warm, lookupBefore.warm),
          reconstruction: delta(lookupAfter.reconstruction, lookupBefore.reconstruction),
        },
      }),
    );
    assert.equal([...iterateIntakeEnvelopeText(rebuilt, source)].join(''), text);
    assert.equal(fingerprint(), before);
  });
