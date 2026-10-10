import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction, clinicalReviewRevision } from '../database.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  openIntakeCollectionEnvelope,
  intakeEnvelopeFilenameCell,
  selectedEnvelopeStore,
  iterateIntakeEnvelopeText,
} from '../intake-collection-envelope.ts';
import { prepareIntakeFilenameFactsSteps } from '../intake-filename-facts.ts';
import {
  prepareIntakeFilenameSummary,
  intakeFilenameSummaryPrepared,
} from '../intake-summary-name.ts';
import { collectionIntakeSummary, collectionIntakeFilenameFragment } from '../intake-summary.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { schemaKey } from '../intake-envelope-schema.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import { readNativeAssistantSourceHeader } from '../assistant-intake-header.ts';
import { handleIntakeRoute } from '../intake-routes.ts';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { setImmediate } from 'node:timers/promises';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { createAssistant } from '../assistant.ts';
import { resolveIntakeDraftRepairContext } from '../intake-draft-repair.ts';

const filename = 'fictional-' + '\uD83C\uDF3F"\\'.repeat(60000) + '.mp3';
const durability = { pending: false, mutationRevision: 0, persistedRevision: 0, error: null };
function* pieces(text: string) {
  for (let at = 0; at < text.length;) {
    let end = Math.min(at + 4096, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    yield text.slice(at, end);
    at = end;
  }
}
test('filename facts yield by lexical work, retain exact hash, and close cancelled input', () => {
  const lexical = JSON.stringify(filename);
  let yielded = 0;
  const steps = prepareIntakeFilenameFactsSteps(pieces(lexical), 'fictional-binding');
  for (;;) {
    const next = steps.next();
    if (next.done) {
      assert.equal(next.value.scalarHash, schemaKey(filename));
      assert.equal(next.value.bytes, Buffer.byteLength(lexical));
      assert.equal(next.value.truncated, true);
      assert.equal(next.value.preview.length <= 120, true);
      assert.equal(next.value.suffix.endsWith('.mp3'), true);
      break;
    }
    yielded++;
  }
  assert.ok(yielded > 66);
  let read = 0,
    closed = false;
  const input = function* () {
    try {
      for (const piece of pieces(lexical)) {
        read += piece.length;
        yield piece;
      }
    } finally {
      closed = true;
    }
  };
  const cancelled = prepareIntakeFilenameFactsSteps(input(), 'fictional-binding');
  assert.equal(cancelled.next().done, false);
  assert.ok(read < lexical.length);
  assert.ok(read <= 8192);
  cancelled.return(undefined as never);
  assert.equal(closed, true);
});
function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-filename-preparation-'));
  const original = Buffer.from('Independently fictional filename preparation evidence.');
  const identity = {
    profileId: 'fictional-filename',
    intakeId: 'fictional-intake',
    sourceHash: createHash('sha256').update(original).digest('hex'),
  };
  const paths = ensureProfileDirectories(directory, identity.profileId);
  const originalPath =
    profilePaths(directory, identity.profileId).relativeRoot + '/sources/fictional.mp3';
  writeFileSync(join(directory, originalPath), original);
  const db = openDatabase(paths.database, identity.profileId);
  const authority = memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const initial = prepareInitialIntakeEnvelope({
    intake: {
      version: 3,
      originalName: filename,
      createdAt: '2026-01-02T00:00:00Z',
      state: 'ready',
      metadata: { source: 'Fictional Clinic', careArea: null, documentType: null, topics: [] },
      proposals: [],
      importHistory: [],
      workflow: {
        format: 'health-intake-workflow-v1',
        candidates: [],
        questions: [],
        plans: [],
        reportGroups: [],
      },
    },
  });
  transaction(db, () => {
    db.prepare('INSERT INTO providers(id,name) VALUES(?,?)').run(
      'fictional-provider',
      'Fictional Clinic',
    );
    db.prepare(
      'INSERT INTO source_files(id,provider_id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?,?)',
    ).run(
      identity.intakeId,
      'fictional-provider',
      originalPath,
      identity.sourceHash,
      original.length,
      'intake_original',
      initial.detailsJson,
    );
    createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
  });
  return {
    db,
    identity,
    directory,
    authority,
    legacyDetailsJson: initial.detailsJson,
    source: { id: identity.intakeId, sha256: identity.sourceHash },
  };
}
function byteReads(db: ReturnType<typeof openDatabase>) {
  const counts = intakeWorkCounters(db);
  return (
    counts.warm.collectionByteChunkReadBytes + counts.reconstruction.collectionByteChunkReadBytes
  );
}
async function forkFacts(
  db: ReturnType<typeof openDatabase>,
  source: { id: string; sha256: string },
  value?: string,
) {
  const view = openIntakeCollectionEnvelope(db, source);
  const intake = view.child(view.root(), 'intake')!;
  const cell = intakeEnvelopeFilenameCell(view, intake);
  const { collections } = selectedEnvelopeStore(db, source);
  const build = 'fictional.filename.' + randomUUID();
  const prepare = (changes: Parameters<typeof collections.prepare>[1]['changes']) => {
    const operationId = randomUUID();
    return collections.prepare(collections.openView(), {
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: view.logical.domainVersion,
      changes,
    });
  };
  collections.commitMaintenance(
    prepare([
      {
        area: 'builds',
        collection: build,
        op: 'adoptCollection',
        fromArea: 'logical',
        fromCollection: 'envelope.data',
      },
      value === undefined
        ? { area: 'builds', collection: build, op: 'delete', key: 'q:' + cell.id }
        : { area: 'builds', collection: build, op: 'put', key: 'q:' + cell.id, value },
    ]),
  );
  const prepared = prepare([
    {
      area: 'logical',
      collection: 'envelope.data',
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: build,
    },
  ]);
  return { collections, prepared, cell };
}
test('cold and revised giant-name summaries use bounded facts and preserve exact fragments', async (t) => {
  const { db, source, directory, authority, identity } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  clearIntakeStateCache(db);
  const before = byteReads(db);
  const first = collectionIntakeSummary(db, source, { durability });
  assert.equal(byteReads(db) - before, 0, 'a cold summary must not scan the giant scalar');
  assert.equal(first.filenameReference!.scalarHash, schemaKey(filename));
  assert.ok(first.filenameReference!.bytes > 66 * 4096);
  let release!: () => void,
    entered!: () => void,
    warmDone = false;
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = runExclusiveClinicalOperation(db, async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await entry;
  const warm = prepareIntakeFilenameSummary(db, source).then(() => {
    warmDone = true;
  });
  try {
    await setImmediate();
    assert.equal(warmDone, true, 'ready filename reads do not queue behind a background owner');
  } finally {
    release();
    await held;
    await warm;
  }
  const view = openIntakeCollectionEnvelope(db, source);
  const intake = view.child(view.root(), 'intake')!;
  const operationId = randomUUID();
  const changed = await prepareIntakeEnvelopeMutation(db, source, {
    reader: view,
    operationId,
    requestDigest: createHash('sha256').update(operationId).digest('hex'),
    domainVersion: 4,
    changes: [{ op: 'set', record: intake, field: 'state', jsonText: '"needs_review"' }],
  });
  transaction(db, () => selectedEnvelopeStore(db, source).collections.stage(changed.prepared!));
  clearIntakeStateCache(db);
  const revisedBefore = byteReads(db);
  const revised = collectionIntakeSummary(db, source, { durability });
  assert.equal(
    byteReads(db) - revisedBefore,
    0,
    'a new selected revision must not rehash the name',
  );
  assert.equal(revised.filenameReference!.scalarHash, first.filenameReference!.scalarHash);
  assert.notEqual(revised.pins.logicalRoot, first.pins.logicalRoot);
  assert.throws(
    () =>
      collectionIntakeFilenameFragment(db, source, {
        reference: first.filenameReference!,
      }),
    { code: 'INTAKE_FILENAME_CHANGED' },
  );
  const lexical: string[] = [];
  let cursor: string | undefined;
  do {
    const page = collectionIntakeFilenameFragment(db, source, {
      reference: revised.filenameReference!,
      cursor,
      limit: 32768,
    });
    lexical.push(page.text);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(JSON.parse(lexical.join('')), filename);
  const { collections } = selectedEnvelopeStore(db, source);
  assert.throws(
    () => collections.byteValueBinding({ kind: 'bytes', bytes: 1, chunks: 1 } as never),
    /foreign, stale or expired byte reference/,
  );
  const reopened = openDatabase(
    ensureProfileDirectories(directory, identity.profileId).database,
    identity.profileId,
  );
  try {
    authority.attach(reopened);
    const coldBefore = byteReads(reopened);
    assert.equal(
      collectionIntakeSummary(reopened, source, { durability }).filenameReference!.scalarHash,
      schemaKey(filename),
    );
    assert.equal(byteReads(reopened) - coldBefore, 0, 'a fresh connection reads persisted facts');
    const headerBefore = byteReads(reopened);
    const header = readNativeAssistantSourceHeader(
      reopened,
      directory,
      identity.profileId,
      source.id,
    )!;
    assert.equal(header.filenameReference!.scalarHash, schemaKey(filename));
    assert.equal(
      byteReads(reopened) - headerBefore,
      0,
      'the native header never scans filename chunks',
    );
  } finally {
    clearIntakeStateCache(reopened);
    reopened.close();
  }
});
test('older native filenames upgrade cooperatively, cancel without partial proof, and refuse forged facts', async (t) => {
  const { db, source, directory, identity, legacyDetailsJson } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  transaction(db, () =>
    db
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run(legacyDetailsJson, source.id),
  );
  const old = await forkFacts(db, source);
  await old.collections.certifySchemaAdoptionAsync(old.prepared);
  old.collections.commitMaintenance(old.prepared);
  assert.equal(intakeFilenameSummaryPrepared(db, source), false);
  const retained = [...iterateIntakeEnvelopeText(db, source)].join('');
  const revision = clinicalReviewRevision(db);
  const original = JSON.stringify(openIntakeCollectionEnvelope(db, source).logical);
  const before = byteReads(db);
  await assert.rejects(
    prepareIntakeFilenameSummary(db, source, {
      assertRunning() {
        if (byteReads(db) - before >= 8192)
          throw new DOMException('Fictional cancellation', 'AbortError');
      },
    }),
    { name: 'AbortError' },
  );
  assert.ok(byteReads(db) - before < Buffer.byteLength(retained));
  assert.equal(JSON.stringify(openIntakeCollectionEnvelope(db, source).logical), original);
  assert.equal(intakeFilenameSummaryPrepared(db, source), false);
  const req = new IncomingMessage(new Socket());
  let read: unknown;
  await handleIntakeRoute({
    resource: 'intakes',
    id: source.id,
    method: 'GET',
    params: new URLSearchParams(),
    req,
    db,
    root: directory,
    profileId: identity.profileId,
    respond: (value) => {
      read = value;
    },
    list: () => assert.fail('unexpected list'),
    body: async () => Buffer.alloc(0),
    assistant: {} as never,
  });
  assert.equal(
    (read as ReturnType<typeof collectionIntakeSummary>).filenameReference!.scalarHash,
    schemaKey(filename),
    'an old native GET prepares facts instead of becoming unavailable',
  );
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal([...iterateIntakeEnvelopeText(db, source)].join(''), retained);
  assert.equal(clinicalReviewRevision(db), revision);
  clearIntakeStateCache(db);
  const readyBefore = byteReads(db);
  assert.deepEqual(await prepareIntakeFilenameSummary(db, source), { changed: false });
  assert.equal(byteReads(db), readyBefore);
  const view = openIntakeCollectionEnvelope(db, source);
  const intake = view.child(view.root(), 'intake')!;
  const facts = JSON.parse(intakeEnvelopeFilenameCell(view, intake).facts!);
  const forged = await forkFacts(
    db,
    source,
    JSON.stringify({ ...facts, scalarHash: '0'.repeat(64) }),
  );
  try {
    await assert.rejects(
      forged.collections.certifySchemaAdoptionAsync(forged.prepared),
      /filename facts disagree/,
    );
  } finally {
    forged.collections.disposePreparation(forged.prepared);
  }
  assert.equal(intakeFilenameSummaryPrepared(db, source), true);
  assert.equal(
    collectionIntakeSummary(db, source, { durability }).filenameReference!.scalarHash,
    schemaKey(filename),
  );
});

test('an old-native repair context stays native and prepares its name before refusing changed drafts', async (t) => {
  const { db, source, directory, identity, legacyDetailsJson } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  transaction(db, () =>
    db
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run(legacyDetailsJson, source.id),
  );
  const old = await forkFacts(db, source);
  await old.collections.certifySchemaAdoptionAsync(old.prepared);
  old.collections.commitMaintenance(old.prepared);
  const selection = {
    format: 'intake-draft-repair-selection-v1',
    intakeId: source.id,
    groupId: 'fictional-missing-group',
    rows: [
      {
        proposalId: null,
        recordId: 'fictional-changed-record',
        candidateVersionId: 'fictional-changed-version',
        fields: ['date'],
      },
    ],
  };
  const context = resolveIntakeDraftRepairContext(db, directory, identity.profileId, {
    route: '#/import',
    intakeRepair: selection,
  });
  assert.deepEqual(context.intakeRepair, selection);
  assert.equal(
    intakeFilenameSummaryPrepared(db, source),
    false,
    'synchronous native classification does not scan or prepare the filename',
  );
  let providerCalls = 0;
  const assistant = createAssistant({
    root: directory,
    databases: new Map([[identity.profileId, db]]),
    bridgeFactory() {
      providerCalls++;
      throw Error('A changed fictional draft must refuse before provider dispatch');
    },
  });
  try {
    const created = assistant.create(identity.profileId, {
      title: 'Fictional old-native repair',
      context,
    });
    assert.equal(created.status, 'idle');
    const chat = assistant.send(identity.profileId, created.id, {
      message: 'Inspect the selected fictional draft.',
    });
    for (let turns = 0; turns < 20000 && chat.status === 'running'; turns++) await setImmediate();
    assert.equal(chat.status, 'failed');
    assert.equal(providerCalls, 0);
    assert.equal(
      intakeFilenameSummaryPrepared(db, source),
      true,
      'actual async repair preparation upgrades the name before checking selected rows',
    );
    assert.doesNotMatch(chat.error || '', /selected filename|INTAKE_SUMMARY_UNAVAILABLE/);
  } finally {
    assistant.close();
  }
});
