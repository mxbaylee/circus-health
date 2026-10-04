import { writeFileSync, readFileSync } from 'node:fs';
import { transaction } from '../database.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { publishIntakeSourceText } from '../intake-source-text.ts';
import { getRetainedIntakeOriginalReference } from '../intake.ts';
import { captureIntakeSourceTextForRead } from '../intake-evidence.ts';
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
import { uploadIntake } from '../intake.ts';
import { extractIntakeSourceText } from '../intake-source-extraction.ts';
import { runIntakeSourceExtractionOperation } from '../intake-source-extraction-operation.ts';
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
function humanCorrection(c: ReturnType<typeof fixture>['context']) {
  const initial = publishIntakeSourceText(c.db, c.root, c.profileId, c.id, {
    operationId: randomUUID(),
    expectedRevisionId: null,
    sourceHash: c.sourceHash,
    evidence: {
      adapter: { name: 'fictional-machine-page', version: '1' },
      pages: [{ page: 1, disposition: 'extracted', inspected: false }],
      spans: [],
      relations: [],
      issues: [],
    },
  });
  const corrected = reviewIntakeSourceText(
    c.db,
    c.root,
    c.profileId,
    c.id,
    {
      operationId: randomUUID(),
      expectedRevisionId: initial.revision!.id,
      sourceHash: c.sourceHash,
      action: 'correct',
      scope: { page: 1 },
      spans: [
        {
          id: 'fictional-human',
          text: 'Fictional retained human correction.',
          region: { page: 1 },
          provenance: 'human',
        },
      ],
    },
    'owner',
  );
  assert.ok(corrected.revision!.protectedPages.includes(1));
  return corrected.revision!.id;
}
const code = (wanted: string) => (e: unknown) =>
  !!e && typeof e === 'object' && 'code' in e && e.code === wanted;

function gate(t: TestContext) {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  t.signal.addEventListener('abort', resolve, { once: true });
  t.after(resolve);
  return { resolve, promise };
}
function receipt(context: ReturnType<typeof fixture>['context']) {
  const value = context.db
    .prepare('SELECT value FROM app_meta WHERE key=?')
    .get('intake_source_extraction:v1:' + context.operationId)?.value;
  return typeof value === 'string' ? JSON.parse(value).receipt : null;
}
test(
  'stalled extraction I/O releases the clinical lane and exact duplicate operations share one worker',
  { timeout: 30000 },
  async (t) => {
    const f = fixture(t, 'Fictional short original'),
      started = gate(t),
      release = gate(t);
    let calls = 0;
    const extract: typeof extractIntakeSourceText = async (context) => {
      calls++;
      started.resolve();
      await release.promise;
      return extractIntakeSourceText(context);
    };
    const one = runIntakeSourceExtractionOperation({ ...f.context, extract }),
      two = runIntakeSourceExtractionOperation({ ...f.context, extract });
    assert.equal(one, two);
    t.after(async () => {
      release.resolve();
      await Promise.allSettled([one, two]);
    });
    try {
      await started.promise;
      assert.equal(receipt(f.context).status, 'started');
      const short = await runExclusiveClinicalOperation(f.context.db, async () =>
        transaction(f.context.db, () => {
          f.context.db
            .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
            .run('fictional_short_operation', '1');
          return 'short-work-complete';
        }),
      );
      assert.equal(short, 'short-work-complete');
      assert.equal(calls, 1);
    } finally {
      release.resolve();
    }
    const [a, b] = await Promise.all([one, two]);
    assert.equal(a, b);
    assert.equal(a.operation.status, 'completed');
    assert.equal(calls, 1);
    assert.deepEqual(await runIntakeSourceExtractionOperation({ ...f.context, extract }), a);
    assert.equal(calls, 1);
  },
);
test(
  'clinical owner cannot join externally owned extraction but harmless evidence reads remain available',
  { timeout: 30000 },
  async (t) => {
    const f = fixture(t, 'Fictional short original'),
      started = gate(t),
      release = gate(t);
    let calls = 0;
    const work = runIntakeSourceExtractionOperation({
      ...f.context,
      extract: async (context) => {
        calls++;
        started.resolve();
        await release.promise;
        return extractIntakeSourceText(context);
      },
    });
    t.after(async () => {
      release.resolve();
      await Promise.allSettled([work]);
    });
    try {
      await started.promise;
      const before = JSON.stringify(receipt(f.context));
      await runExclusiveClinicalOperation(f.context.db, async () => {
        assert.throws(
          () => runIntakeSourceExtractionOperation(f.context),
          /cannot start or join inside a clinical operation/,
        );
        await assert.rejects(
          captureIntakeSourceTextForRead({ ...f.context, modelContext: true }),
          /cannot start or join inside a clinical operation/,
        );
        await captureIntakeSourceTextForRead({
          ...f.context,
          modelContext: true,
          captureSourceText: false,
        });
      });
      assert.equal(JSON.stringify(receipt(f.context)), before);
      assert.equal(calls, 1);
    } finally {
      release.resolve();
    }
    assert.equal((await work).operation.status, 'completed');
  },
);
for (const change of ['revision', 'physical original', 'source hash'] as const)
  test(`queued extraction publication refuses changed ${change}`, { timeout: 30000 }, async (t) => {
    const f = fixture(t, 'Fictional short original'),
      held = gate(t),
      release = gate(t);
    const c = f.context;
    const original = getRetainedIntakeOriginalReference(c.db, c.root, c.profileId, c.id),
      bytes = readFileSync(original.path);
    let waits = 0,
      owner: Promise<unknown> | undefined;
    const work = extractIntakeSourceText({
      ...c,
      onCoordinationWait(waiting) {
        if (waiting && ++waits === 2)
          owner = runExclusiveClinicalOperation(c.db, async () => {
            held.resolve();
            await release.promise;
          });
      },
    });
    const rejected = assert.rejects(
      work,
      change === 'revision' ? code('SOURCE_TEXT_CONFLICT') : code('SOURCE_CHANGED'),
    );
    t.after(async () => {
      release.resolve();
      await Promise.allSettled([work, rejected, owner]);
    });
    let humanRevision: string | undefined;
    try {
      await held.promise;
      assert.equal(getIntakeSourceText(c.db, c.root, c.profileId, c.id).status, 'unavailable');
      if (change === 'revision') humanRevision = humanCorrection(c);
      else if (change === 'physical original')
        writeFileSync(original.path, Buffer.from('Fictional replacement bytes'));
      else
        transaction(c.db, () =>
          c.db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('f'.repeat(64), c.id),
        );
    } finally {
      release.resolve();
    }
    try {
      await rejected;
      await owner;
    } finally {
      if (change === 'physical original') writeFileSync(original.path, bytes);
      if (change === 'source hash')
        transaction(c.db, () =>
          c.db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run(c.sourceHash, c.id),
        );
    }
    const current = getIntakeSourceText(c.db, c.root, c.profileId, c.id);
    assert.equal(
      current.revision?.id,
      humanRevision,
      'The queued result did not overwrite or create a revision',
    );
  });
for (const change of ['cancel', 'close'] as const)
  test(
    `queued extraction initial admission retains recoverable receipt after ${change}`,
    { timeout: 30000 },
    async (t) => {
      const f = fixture(t, 'Fictional short original'),
        held = gate(t),
        release = gate(t),
        c = f.context;
      let cancelled = false,
        calls = 0,
        waits = 0,
        owner: Promise<unknown> | undefined;
      const work = runIntakeSourceExtractionOperation({
        ...c,
        assertRunning() {
          if (cancelled) throw Error('Fictional extraction cancelled');
        },
        extract: (context) => {
          calls++;
          return extractIntakeSourceText({
            ...context,
            onCoordinationWait(waiting) {
              if (waiting && ++waits === 1)
                owner = runExclusiveClinicalOperation(c.db, async () => {
                  held.resolve();
                  await release.promise;
                });
            },
          });
        },
      });
      const rejected = assert.rejects(
        work,
        change === 'cancel'
          ? /Fictional extraction cancelled/
          : /database is not open|no longer active/,
      );
      t.after(async () => {
        release.resolve();
        await Promise.allSettled([work, rejected, owner]);
      });
      let head: Buffer;
      try {
        await held.promise;
        assert.equal(receipt(c).status, 'started');
        assert.equal(waits, 1);
        assert.equal(getIntakeSourceText(c.db, c.root, c.profileId, c.id).status, 'unavailable');
        head = Buffer.from(f.objects.get('head')!);
        if (change === 'cancel') cancelled = true;
        else c.db.close();
      } finally {
        release.resolve();
      }
      await rejected;
      await Promise.allSettled([owner]);
      assert.deepEqual(
        f.objects.get('head'),
        head,
        'No late source revision or terminal receipt publication',
      );
      const db = change === 'close' ? f.rebuild() : c.db;
      assert.equal(receipt({ ...c, db }).status, 'started');
      assert.equal(getIntakeSourceText(db, c.root, c.profileId, c.id).status, 'unavailable');
      const recovered = await runIntakeSourceExtractionOperation({
        ...c,
        db,
        extract: async () => {
          calls++;
          throw Error('Recovery must not dispatch');
        },
      });
      assert.equal(recovered.operation.status, 'interrupted');
      assert.equal(recovered.operation.requiresNewOperation, true);
      assert.equal(calls, 1);
    },
  );
test(
  'operation initial read refuses a human revision admitted after its durable receipt',
  { timeout: 30000 },
  async (t) => {
    const f = fixture(t, 'Fictional short original'),
      c = f.context;
    const held = gate(t),
      release = gate(t);
    let owner: Promise<unknown> | undefined,
      initialWaits = 0;
    const work = runIntakeSourceExtractionOperation({
      ...c,
      extract: (context) =>
        extractIntakeSourceText({
          ...context,
          onCoordinationWait(waiting) {
            if (waiting && ++initialWaits === 1)
              owner = runExclusiveClinicalOperation(c.db, async () => {
                held.resolve();
                await release.promise;
              });
          },
        }),
    });
    t.after(async () => {
      release.resolve();
      await Promise.allSettled([work, owner]);
    });
    let humanRevision: string;
    try {
      await held.promise;
      assert.equal(receipt(c).status, 'started');
      assert.equal(receipt(c).expectedRevisionId, null);
      humanRevision = humanCorrection(c);
    } finally {
      release.resolve();
    }
    const result = await work;
    await owner;
    assert.equal(result.operation.status, 'interrupted');
    assert.equal(result.operation.reasonCode, 'SOURCE_TEXT_CHANGED');
    assert.equal(initialWaits, 1, 'No extraction publication phase was entered');
    assert.equal(getIntakeSourceText(c.db, c.root, c.profileId, c.id).revision?.id, humanRevision);
    assert.equal(receipt(c).status, 'interrupted');
  },
);
