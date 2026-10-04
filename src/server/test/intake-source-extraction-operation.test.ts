import type { SourceTextIssueList } from '../../shared/intake-source-text.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase, type Database } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  type RecordStorage,
} from '../record-versions.ts';
import { fictionalModel } from './fictional-model.ts';
import {
  uploadIntake,
  getIntake,
  createIntakePlan,
  submitIntakeBatch,
  reviewIntake,
} from '../intake.ts';
import { extractIntakeSourceText } from '../intake-source-extraction.ts';
import { runIntakeSourceExtractionOperation } from '../intake-source-extraction-operation.ts';
import { intakeSourceRoute } from '../intake-source-routes.ts';
import { getIntakeSourceText, reviewIntakeSourceText } from '../intake-source-text.ts';
function fixture(
  t: TestContext,
  text = 'Fictional document administrative content.\n'.repeat(1500),
) {
  const root = mkdtempSync(resolve(tmpdir(), 'circus-extraction-operation-')),
    profileId = 'fictional-operation';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId),
    objects = new Map<string, Buffer>(),
    opened: Database[] = [db];
  const storage: RecordStorage = {
    read: (name) => objects.get(name) || null,
    writeImmutable: (name, bytes) => {
      assert.equal(objects.has(name), false);
      objects.set(name, Buffer.from(bytes));
    },
    publishHead: (bytes) => objects.set('head', Buffer.from(bytes)),
  };
  attachRecordDurability(db, { profileId, storage });
  const original = uploadIntake(db, root, profileId, {
    filename: 'fictional.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(text),
  });
  t.after(() => {
    for (const connection of opened)
      try {
        connection.close();
      } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  const context = {
    db,
    root,
    profileId,
    id: original.id,
    sourceHash: original.sha256,
    operationId: randomUUID(),
    expectedRevisionId: null,
  };
  function rebuild() {
    const file = resolve(root, randomUUID() + '.sqlite');
    rebuildRecordDatabase(file, { profileId, storage });
    const rebuilt = openDatabase(file, profileId);
    opened.push(rebuilt);
    attachRecordDurability(rebuilt, { profileId, storage });
    return rebuilt;
  }
  return { context, storage, objects, rebuild };
}
const code = (wanted: string) => (e: unknown) =>
  !!e && typeof e === 'object' && 'code' in e && e.code === wanted;

test('exact operation retry returns its original partial revision, never the next two pages', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const extract: typeof extractIntakeSourceText = async (c) => {
    calls++;
    assert.equal(c.maxPages, 2);
    return extractIntakeSourceText(c);
  };
  const first = await runIntakeSourceExtractionOperation({ ...f.context, extract });
  assert.ok(first.sourceText.revision);
  assert.equal(first.operation.status, 'completed');
  assert.ok(first.sourceText.revision.pages.some((p) => p.disposition === 'partial'));
  assert.equal(calls, 1);
  const replay = await runIntakeSourceExtractionOperation({ ...f.context, extract });
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
  const next = await runIntakeSourceExtractionOperation({
    ...f.context,
    operationId: randomUUID(),
    expectedRevisionId: first.sourceText.revision.id,
    extract,
  });
  assert.equal(calls, 2);
  assert.ok(next.sourceText.revision?.pages.every((p) => p.disposition === 'extracted'));
  assert.deepEqual(
    await runIntakeSourceExtractionOperation({ ...f.context, extract }),
    first,
    'historical retry does not masquerade as the newest revision',
  );
});

test('concurrent same-key calls share one worker; changed arguments and other keys cannot overlap', async (t) => {
  const f = fixture(t);
  let release!: () => void,
    calls = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const extract: typeof extractIntakeSourceText = async (c) => {
    calls++;
    await gate;
    return extractIntakeSourceText(c);
  };
  const one = runIntakeSourceExtractionOperation({ ...f.context, extract }),
    two = runIntakeSourceExtractionOperation({ ...f.context, extract });
  assert.equal(one, two);
  assert.throws(
    () =>
      runIntakeSourceExtractionOperation({
        ...f.context,
        expectedRevisionId: randomUUID(),
        extract,
      }),
    code('SOURCE_EXTRACTION_OPERATION_CONFLICT'),
  );
  assert.throws(
    () => runIntakeSourceExtractionOperation({ ...f.context, operationId: randomUUID(), extract }),
    code('SOURCE_TEXT_EXTRACTION_ACTIVE'),
  );
  release();
  const [a, b] = await Promise.all([one, two]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
});

test('durable admission failure prevents all extraction work', async (t) => {
  const f = fixture(t);
  let calls = 0;
  f.storage.publishHead = () => {
    throw new Error('Fictional storage interruption');
  };
  await assert.rejects(
    () =>
      runIntakeSourceExtractionOperation({
        ...f.context,
        extract: async (c) => {
          calls++;
          return extractIntakeSourceText(c);
        },
      }),
    /storage interruption/,
  );
  assert.equal(calls, 0);
});

test('completed receipts survive cache loss and never overwrite later human corrections', async (t) => {
  const f = fixture(t, 'Fictional source text.'),
    first = await runIntakeSourceExtractionOperation(f.context);
  assert.ok(first.sourceText.revision);
  const changed = reviewIntakeSourceText(
    f.context.db,
    f.context.root,
    f.context.profileId,
    f.context.id,
    {
      operationId: randomUUID(),
      expectedRevisionId: first.sourceText.revision.id,
      sourceHash: f.context.sourceHash,
      action: 'correct',
      scope: { page: 1 },
      spans: [
        {
          id: 'human',
          text: 'Fictional human correction.',
          region: { page: 1 },
          provenance: 'human',
        },
      ],
    },
    'owner',
  );
  const db = f.rebuild();
  let calls = 0;
  const replay = await runIntakeSourceExtractionOperation({
    ...f.context,
    db,
    extract: async (c) => {
      calls++;
      return extractIntakeSourceText(c);
    },
  });
  assert.deepEqual(replay, first);
  assert.equal(calls, 0);
  assert.equal(
    getIntakeSourceText(db, f.context.root, f.context.profileId, f.context.id).revision?.id,
    changed.revision?.id,
  );
});

test('interrupted worker preserves partial evidence and makes exact retries non-dispatching', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const extract: typeof extractIntakeSourceText = async (c) => {
    calls++;
    await extractIntakeSourceText(c);
    throw new Error('Fictional worker interrupted after checkpoint');
  };
  const first = await runIntakeSourceExtractionOperation({ ...f.context, extract });
  assert.equal(first.operation.status, 'interrupted');
  assert.equal(first.operation.requiresNewOperation, true);
  assert.equal(first.operation.reasonCode, 'SOURCE_EXTRACTION_INTERRUPTED');
  assert.ok(first.sourceText.revision);
  assert.deepEqual(await runIntakeSourceExtractionOperation({ ...f.context, extract }), first);
  assert.equal(calls, 1);
});

test('lock after partial publication leaves admission for restart recovery, not blind page reruns', async (t) => {
  const f = fixture(t);
  let live = true,
    calls = 0;
  const extract: typeof extractIntakeSourceText = async (c) => {
    calls++;
    await extractIntakeSourceText(c);
    live = false;
    throw new Error('Fictional lock');
  };
  await assert.rejects(
    runIntakeSourceExtractionOperation({
      ...f.context,
      extract,
      assertRunning: () => {
        if (!live) throw new Error('Fictional profile is locked');
      },
    }),
    /locked/,
  );
  const retained = getIntakeSourceText(
    f.context.db,
    f.context.root,
    f.context.profileId,
    f.context.id,
  );
  assert.ok(retained.revision);
  const db = f.rebuild(),
    recovered = await runIntakeSourceExtractionOperation({ ...f.context, db, extract });
  assert.equal(recovered.operation.status, 'interrupted');
  assert.equal(recovered.operation.reasonCode, 'SOURCE_EXTRACTION_RECOVERED_PARTIAL');
  assert.equal(recovered.sourceText.revision?.id, retained.revision.id);
  assert.equal(calls, 1);
  assert.deepEqual(
    await runIntakeSourceExtractionOperation({ ...f.context, db, extract }),
    recovered,
  );
  assert.equal(calls, 1);
});

test('browser losing old operation key receives its own recovery receipt before a fresh continuation', async (t) => {
  const f = fixture(t);
  let live = true,
    calls = 0;
  await assert.rejects(
    runIntakeSourceExtractionOperation({
      ...f.context,
      assertRunning: () => {
        if (!live) throw new Error('Locked');
      },
      extract: async (c) => {
        calls++;
        await extractIntakeSourceText(c);
        live = false;
        throw new Error('Locked');
      },
    }),
    /Locked/,
  );
  const db = f.rebuild(),
    partial = getIntakeSourceText(db, f.context.root, f.context.profileId, f.context.id);
  assert.ok(partial.revision);
  const nextContext = {
    ...f.context,
    db,
    operationId: randomUUID(),
    expectedRevisionId: partial.revision.id,
    extract: async (c: Parameters<typeof extractIntakeSourceText>[0]) => {
      calls++;
      return extractIntakeSourceText(c);
    },
  };
  const recovered = await runIntakeSourceExtractionOperation(nextContext);
  assert.equal(recovered.operation.reasonCode, 'SOURCE_EXTRACTION_PRIOR_INTERRUPTED');
  assert.equal(recovered.operation.operationId, nextContext.operationId);
  assert.equal(calls, 1);
  assert.deepEqual(await runIntakeSourceExtractionOperation(nextContext), recovered);
  assert.equal(calls, 1);
  const continued = await runIntakeSourceExtractionOperation({
    ...nextContext,
    operationId: randomUUID(),
  });
  assert.equal(continued.operation.status, 'completed');
  assert.equal(calls, 2);
});

test('operation IDs are profile-source scoped and stale expected revisions cannot admit new work', async (t) => {
  const f = fixture(t),
    first = await runIntakeSourceExtractionOperation(f.context);
  assert.ok(first.sourceText.revision);
  assert.throws(
    () => runIntakeSourceExtractionOperation({ ...f.context, operationId: randomUUID() }),
    code('SOURCE_TEXT_CHANGED'),
  );
  assert.throws(
    () => runIntakeSourceExtractionOperation({ ...f.context, sourceHash: 'f'.repeat(64) }),
    code('SOURCE_EXTRACTION_OPERATION_CONFLICT'),
  );
  assert.throws(
    () => runIntakeSourceExtractionOperation({ ...f.context, profileId: 'different-profile' }),
    code('PROFILE_SCOPE'),
  );
  assert.throws(
    () => runIntakeSourceExtractionOperation({ ...f.context, operationId: '../invalid' }),
    code('INVALID_INPUT'),
  );
});

test('failed PDF inventory exposes a durable file exception, never an invented page', async (t) => {
  const f = fixture(t);
  const { db, root, profileId } = f.context;
  const original = uploadIntake(db, root, profileId, {
    filename: 'fictional-broken.pdf',
    bytes: Buffer.from('%PDF-1.7\nFictional broken inventory only.'),
  });
  const result = await runIntakeSourceExtractionOperation({
    ...f.context,
    id: original.id,
    sourceHash: original.sha256,
    operationId: randomUUID(),
  });
  assert.equal(result.operation.status, 'interrupted');
  assert.equal(result.sourceText.status, 'unavailable');
  const read = async (database: Database) =>
    await intakeSourceRoute({
      db: database,
      root,
      profileId,
      id: original.id,
      action: 'source-issues',
      params: new URLSearchParams(),
    });
  const response = (await read(db)) as SourceTextIssueList;
  assert.equal(response.status, 'unavailable');
  assert.equal(response.summary, null);
  assert.deepEqual(response.issues, []);
  assert.deepEqual(response.extractionFailure, {
    scope: 'file',
    reasonCode: result.operation.reasonCode,
  });
  assert.deepEqual(await read(f.rebuild()), response);
});

for (const native of [false, true])
  test(
    `${native ? 'native' : 'legacy'} reader coverage remains separately visible for context-only zero-record proposals and uses version-pinned pagination`,
    { timeout: 120000 },
    async (t) => {
      fictionalModel(t);
      const f = fixture(t),
        { db, root, profileId, id } = f.context;
      await runIntakeSourceExtractionOperation(f.context);
      const original = getIntake(db, root, profileId, id);
      const planned = await createIntakePlan(db, root, profileId, id, {
        version: original.version,
      });
      const plan = planned.workflow!.plans[0];
      const jsonlText = JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-context',
        kind: 'context',
        payload: { text: 'Fictional unrecognized administrative section.' },
        provenance: {
          capturedVia: 'Fictional reader',
          sourceSystem: null,
          sourceRecordId: null,
          evidenceClass: 'transcription',
          locator: 'source section 1',
        },
        coverage: { status: 'partial', notes: ['Unrecognized writing requires a person.'] },
      });
      const proposed = submitIntakeBatch(db, root, profileId, id, {
        version: planned.version,
        planId: plan.id,
        operationId: 'fictional-coverage-observation',
        jsonlText,
        summary: 'Fictional source only',
        coverage: [
          {
            unitId: plan.units[0].id,
            kind: 'unreadable',
            notes: 'Fictional unreadable area. '.repeat(100),
          },
        ],
      });
      assert.equal(
        reviewIntake(db, root, profileId, id, proposed.proposals[0].id).records.length,
        0,
      );
      if (native) {
        const { buildIntakeCollectionEnvelope } = await import('../intake-envelope-build.ts');
        await buildIntakeCollectionEnvelope(db, { id });
      }
      const request = (params: string) =>
        intakeSourceRoute({
          db,
          root,
          profileId,
          id,
          action: 'source-issues',
          params: new URLSearchParams(params),
        });
      const first = (await request('readerLimit=1')) as SourceTextIssueList;
      assert.equal(first.status, 'available');
      assert.ok(first.summary);
      assert.ok(first.readerCoverage!.summary.units > 1);
      assert.equal(first.readerCoverage!.summary.unreadable, 1);
      assert.equal(first.readerCoverage!.entries[0].coverageKind, 'unreadable');
      assert.equal(first.readerCoverage!.entries[0].notes.length, 1200);
      assert.equal(first.readerCoverage!.entries[0].notesTruncated, true);
      assert.equal(first.readerCoverage!.nextOffset, 1);
      await assert.rejects(request('readerOffset=1'), { code: 'VERSION_CONFLICT' });
      const next = (await request(
        `readerOffset=1&readerLimit=1&readerVersion=${first.readerCoverage!.intakeVersion}`,
      )) as SourceTextIssueList;
      assert.equal(next.readerCoverage!.entries[0].status, 'pending');
      await assert.rejects(request('readerVersion=0'), { code: 'VERSION_CONFLICT' });
      const source = getIntakeSourceText(db, root, profileId, id).revision!;
      reviewIntakeSourceText(
        db,
        root,
        profileId,
        id,
        {
          operationId: randomUUID(),
          expectedRevisionId: source.id,
          sourceHash: source.sourceHash,
          scope: { page: 1 },
          action: 'correct',
          spans: [
            {
              id: 'human-corrected',
              text: 'Fictional corrected section.',
              region: { page: 1 },
              provenance: 'human',
            },
          ],
        },
        'fictional-owner',
      );
      const corrected = (await request('readerLimit=1')) as SourceTextIssueList;
      assert.equal(corrected.readerCoverage!.entries[0].stale, true);
      assert.equal(corrected.readerCoverage!.summary.unreadable, 0);
      assert.equal(corrected.readerCoverage!.summary.stale, 1);
      assert.equal(
        corrected.readerCoverage!.entries[0].notes,
        first.readerCoverage!.entries[0].notes,
        'earlier findings stay inspectable, explicitly stale',
      );
      await assert.rejects(
        request(`readerOffset=1&readerVersion=${first.readerCoverage!.intakeVersion}`),
        { code: 'VERSION_CONFLICT' },
      );
    },
  );
