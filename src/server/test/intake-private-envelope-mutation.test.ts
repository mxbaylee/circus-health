import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPrivateEnvelopeCandidate } from '../intake-envelope-candidate.ts';
import { createIntakeTree } from '../intake-state-tree.ts';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { openContributorRecordStorage } from '../contributor-record-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { rebuildContributorDatabase } from '../contributor-durability.ts';
import { recordDurabilityStatus } from '../record-versions.ts';
import {
  authenticateRecordTransactionPreparation,
  captureRecordPublicationOriginals,
  closeRecordPublicationOriginals,
  commitRecordTransactionPreparation,
  discardRecordTransactionPreparation,
  prepareRecordTransactionWithOriginals,
  stageRecordTransactionPreparation,
} from '../record-versions.ts';
import { captureOwnershipReportOriginalProof } from '../ownership-report-plan.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { recordPreparedPublicationFixture } from './helpers/record-prepared-publication-fixture.ts';
import { uploadIntake } from '../intake.ts';
import { writeIntakeFixtureEnvelope } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareIntakeWorkflowCommand } from '../intake-workflow-command.ts';
import {
  prepareReviewQuestionState,
  prepareReviewQuestionDerived,
} from '../intake-review-question-state.ts';
import { workflowHash } from '../intake-workflow.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { intakeWorkCounters, withIntakeWork } from '../intake-work-accounting.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
// Workspace cleanup assertions must not observe other test processes' scratch files.
const previousTmpdir = process.env.TMPDIR;
const suiteTmpdir = mkdtempSync(join(tmpdir(), 'fictional-envelope-suite-'));
process.env.TMPDIR = suiteTmpdir;
after(() => {
  if (previousTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmpdir;
  rmSync(suiteTmpdir, { recursive: true, force: true });
});
const identity = {
  profileId: 'fictional-private-construction',
  intakeId: 'fictional-intake',
  sourceHash: hash('Independently fictional construction source'),
};
const workspaces = () =>
  readdirSync(tmpdir())
    .filter((name) => name.startsWith('circus-private-envelope-'))
    .sort();

test('private construction seals exact reachable nodes in bounded parts without publishing intermediates', async (t) => {
  const db = new DatabaseSync(':memory:'),
    originals = new Map<string, string>(),
    originalTree = createIntakeTree(identity, (key) => originals.get(key), new Map()),
    originalRoot = originalTree.put(null, 'retained', '{"kind":"inline","text":"original"}');
  for (const node of originalTree.writes([originalRoot])) originals.set(node.hash, node.raw);
  const originalBytes = [...originals],
    nativeExec = DatabaseSync.prototype.exec;
  let queuePlan = '',
    scratch: DatabaseSync | undefined,
    candidate: ReturnType<typeof createPrivateEnvelopeCandidate>;
  DatabaseSync.prototype.exec = function (sql: string) {
    const result = nativeExec.call(this, sql);
    if (sql.includes('CREATE INDEX queue_pending ON queue(done,hash)')) {
      scratch = this;
      queuePlan = this.prepare(
        'EXPLAIN QUERY PLAN SELECT hash,ref FROM queue WHERE done=0 ORDER BY hash LIMIT 1',
      )
        .all()
        .map((row) => row.detail)
        .join(' ');
    }
    return result;
  };
  try {
    candidate = createPrivateEnvelopeCandidate({
      db,
      identity,
      nodePrefix: 'fictional:node:',
      collection: 'envelope.data',
      descriptor: { kind: 'map', root: originalRoot, bytes: 8 },
      readOriginal: (key) => originals.get(key),
      assertOriginal() {},
    });
  } finally {
    DatabaseSync.prototype.exec = nativeExec;
  }
  assert.match(queuePlan, /SEARCH queue USING INDEX queue_pending/);
  t.after(() => {
    candidate.close();
    db.close();
  });
  for (let offset = 0; offset < 5000; offset += 64)
    candidate.apply(
      Array.from({ length: Math.min(64, 5000 - offset) }, (_, index) => ({
        area: 'builds' as const,
        collection: 'envelope.data',
        op: 'put' as const,
        key: String(offset + index).padStart(5, '0'),
        value: 'Fictional fixed-width value '.repeat(8),
      })),
    );
  candidate.apply([
    { area: 'builds', collection: 'envelope.data', op: 'put', key: '00000', value: 'superseded' },
    { area: 'builds', collection: 'envelope.data', op: 'put', key: '00000', value: 'final' },
    {
      area: 'builds',
      collection: 'bytes',
      op: 'appendBytes',
      bytes: Buffer.from('Fictional UTF8: \u00e9'),
    },
    {
      area: 'builds',
      collection: 'envelope.data',
      op: 'putBytes',
      key: 'encoded',
      fromArea: 'builds',
      fromCollection: 'bytes',
    },
  ]);
  withIntakeWork(db, 'warm', () => assert.equal(candidate.store.get('00000'), 'final'));
  const beforeCachedReads = intakeWorkCounters(db).warm.hashCalls;
  withIntakeWork(db, 'warm', () => {
    for (let index = 0; index < 32; index++) assert.equal(candidate.store.get('00000'), 'final');
  });
  assert.equal(intakeWorkCounters(db).warm.hashCalls - beforeCachedReads, 0);
  const roster = await candidate.seal(),
    retained = new Map(originals),
    hashes = new Set<string>(),
    digest = createHash('sha256');
  let count = 0,
    bytes = 0,
    parts = 0,
    maximum = 0;
  for (const part of roster.parts()) {
    parts++;
    const size = part.reduce(
      (sum, row) =>
        sum + Buffer.byteLength(roster.nodePrefix + row.hash) + Buffer.byteLength(row.raw),
      0,
    );
    assert.ok(part.length <= 4096);
    assert.ok(size <= 8 * 1024 * 1024);
    maximum = Math.max(maximum, size);
    for (const node of part) {
      assert.equal(hashes.has(node.hash), false);
      hashes.add(node.hash);
      retained.set(node.hash, node.raw);
      digest.update(node.hash).update(node.raw);
      count++;
      bytes += Buffer.byteLength(node.raw);
    }
  }
  assert.ok(
    parts >= 2,
    'more than the ordinary node cap is transported without an aggregate array',
  );
  assert.equal(count, roster.count);
  assert.equal(bytes, roster.bytes);
  assert.equal(digest.digest('hex'), roster.digest);
  assert.equal(roster.descriptor.root!.count, 5002);
  const tree = createIntakeTree(identity, (key) => retained.get(key), new Map());
  for (let index = 0; index < 5000; index++)
    assert.deepEqual(
      JSON.parse(tree.get(roster.descriptor.root, String(index).padStart(5, '0'))!),
      {
        kind: 'inline',
        text: index ? 'Fictional fixed-width value '.repeat(8) : 'final',
      },
    );
  assert.equal(tree.get(roster.descriptor.root, 'missing'), undefined);
  assert.deepEqual([...originals], originalBytes);
  const encoded = candidate.store.get('encoded');
  assert.ok(encoded && typeof encoded !== 'string');
  if (!encoded || typeof encoded === 'string') throw Error('Expected checked private bytes');
  assert.equal(
    Buffer.concat(candidate.store.chunks(encoded).chunks).toString(),
    'Fictional UTF8: \u00e9',
  );
  assert.ok(intakeWorkCounters(db).warm.privateEnvelopeSpooledNodes > roster.count);
  assert.throws(() => candidate.apply([]), /private envelope change budget/);
  t.diagnostic(
    JSON.stringify({
      generated: intakeWorkCounters(db).warm.privateEnvelopeGeneratedNodes,
      spooled: intakeWorkCounters(db).warm.privateEnvelopeSpooledNodes,
      reachable: count,
      bytes,
      parts,
      maximum,
    }),
  );
  assert.ok(scratch);
  scratch
    .prepare('UPDATE nodes SET signature=? WHERE hash=?')
    .run('tampered', roster.descriptor.root!.hash);
  assert.throws(candidate.check, /workspace changed/);
});

test('private reader coverage retains only the final derived pass and refuses scratch edits', (t) => {
  const db = new DatabaseSync(':memory:'),
    nativeExec = DatabaseSync.prototype.exec;
  let scratch: DatabaseSync | undefined;
  DatabaseSync.prototype.exec = function (sql: string) {
    const result = nativeExec.call(this, sql);
    if (sql.includes('CREATE TABLE reader_transitions(')) scratch = this;
    return result;
  };
  let candidate: ReturnType<typeof createPrivateEnvelopeCandidate>;
  try {
    candidate = createPrivateEnvelopeCandidate({
      db,
      identity,
      nodePrefix: 'fictional:node:',
      collection: 'envelope.data',
      descriptor: { kind: 'map', root: null, bytes: 0 },
      readOriginal: () => undefined,
      assertOriginal() {},
    });
  } finally {
    DatabaseSync.prototype.exec = nativeExec;
  }
  t.after(() => {
    candidate.close();
    db.close();
  });
  candidate.recordReaderCoverageTransition(identity.intakeId, 'before', 'abandoned', [
    { kind: 'plan', key: 'first', value: 'first' },
  ]);
  candidate.resetRetainedCollections();
  assert.deepEqual([...candidate.readerCoverageRows()], []);
  candidate.recordReaderCoverageTransition(identity.intakeId, 'before', 'selected', [
    { kind: 'plan', key: 'second', value: 'second' },
  ]);
  assert.deepEqual(
    [...candidate.readerCoverageRows()],
    [
      { kind: 'transition', sourceId: identity.intakeId, before: 'before', after: 'selected' },
      {
        kind: 'effect',
        sourceId: identity.intakeId,
        after: 'selected',
        effectKind: 'plan',
        key: 'second',
        value: 'second',
      },
    ],
  );
  assert.ok(scratch);
  scratch.prepare('UPDATE reader_effects SET value=? WHERE after=?').run('changed', 'selected');
  assert.throws(() => [...candidate.readerCoverageRows()], /workspace changed/);
});

test('private construction keeps ordinary batch limits and rejects concurrent sealing and cancellation', async (t) => {
  const db = new DatabaseSync(':memory:'),
    before = workspaces();
  t.after(() => db.close());
  const create = () =>
    createPrivateEnvelopeCandidate({
      db,
      identity,
      nodePrefix: 'fictional:node:',
      collection: 'envelope.data',
      descriptor: { kind: 'map', root: null, bytes: 0 },
      readOriginal: () => undefined,
      assertOriginal() {},
    });
  const candidate = create();
  assert.throws(
    () =>
      candidate.apply(
        Array(65).fill({
          area: 'builds',
          collection: 'envelope.data',
          op: 'put',
          key: 'a',
          value: 'b',
        }),
      ),
    /change budget/,
  );
  assert.throws(
    () =>
      candidate.apply([
        {
          area: 'builds',
          collection: 'envelope.data',
          op: 'put',
          key: 'a',
          value: 'x'.repeat(8192),
        },
      ]),
    /inline budget/,
  );
  assert.equal(candidate.descriptor().root, null);
  for (let offset = 0; offset < 128; offset += 64)
    candidate.apply(
      Array.from({ length: 64 }, (_, index) => ({
        area: 'builds' as const,
        collection: 'envelope.data',
        op: 'put' as const,
        key: String(offset + index),
        value: 'Fictional',
      })),
    );
  let second: Promise<unknown> | undefined,
    reached = 0;
  await candidate.seal(() => {
    if (++reached === 1) {
      assert.throws(() => candidate.apply([]), /change budget/);
      second = candidate.seal().catch((error: unknown) => error);
    }
  });
  assert.match(String(await second), /sealing already started/);
  assert.ok(reached > 1, 'actual graph validation yielded with sealing already exclusive');
  candidate.close();
  const cancelled = create(),
    reason = Error('Fictional candidate cancellation');
  for (let offset = 0; offset < 128; offset += 64)
    cancelled.apply(
      Array.from({ length: 64 }, (_, index) => ({
        area: 'builds' as const,
        collection: 'envelope.data',
        op: 'put' as const,
        key: String(offset + index),
        value: 'Fictional',
      })),
    );
  let checks = 0;
  await assert.rejects(
    cancelled.seal(() => {
      if (++checks === 2) throw reason;
    }),
    (error) => error === reason,
  );
  assert.equal(checks, 2);
  assert.throws(cancelled.check, /workspace changed/);
  assert.deepEqual(workspaces(), before);
});

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-private-mutation-')),
    profileId = 'fictional-private-mutation',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId),
    storage = openContributorRecordStorage(root, profileId, { initialize: true });
  attachPersonalDurability(db, { root, profileId, recordStorage: storage });
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional.txt',
    bytes: Buffer.from('Independently fictional retained original.'),
  });
  writeIntakeFixtureEnvelope(db, source.id, {
    intake: {
      version: 1,
      originalName: 'fictional.txt',
      workflow: {
        format: 'health-intake-workflow-v1',
        operations: [],
        questions: [],
        unknownEvidence: 'Fictional untouched scalar '.repeat(300),
      },
    },
  });
  await buildIntakeCollectionEnvelope(db, source);
  const prepare = (options: { onCheckpoint?: () => void; assertRunning?: () => void } = {}) =>
    prepareIntakeWorkflowCommand(db, source, {
      version: intakeSourceVersion(db, source.id).version,
      operationId: 'fictional-private-command',
      request: { answer: 'literal' },
      createdAt: '2026-01-01',
      ...options,
      *changes({ workflow }) {
        for (let index = 0; index < 12; index++)
          yield {
            op: 'append' as const,
            record: workflow,
            field: 'questions',
            jsonText: JSON.stringify({
              id: 'fictional-question-' + index,
              status: 'unanswered',
              answers: [],
            }),
          };
      },
    });
  return { root, profileId, db, storage, source, prepare };
}

test('genuine contributor mutation prepares privately and publishes one exact recoverable command', async (t) => {
  const f = await fixture(t),
    beforeHead = Buffer.from(f.storage.read('head')!),
    beforeSequence = recordDurabilityStatus(f.db)!.sequence,
    beforeWork = intakeWorkCounters(f.db).warm;
  const prepared = await f.prepare();
  assert.equal(prepared.replayed, false);
  if (prepared.replayed) throw Error('Expected new private command');
  assert.deepEqual(f.storage.read('head'), beforeHead);
  assert.equal(recordDurabilityStatus(f.db)!.sequence, beforeSequence);
  const { collections } = selectedEnvelopeStore(f.db, f.source);
  const accepted = transaction(f.db, () => {
    prepared.assertCurrent();
    return collections.stage(prepared.prepared);
  });
  assert.equal(recordDurabilityStatus(f.db)!.sequence, beforeSequence + 1);
  assert.notDeepEqual(f.storage.read('head'), beforeHead);
  const inspect = (db: typeof f.db) => {
    const reader = openIntakeCollectionEnvelope(db, f.source),
      intake = reader.child(reader.root(), 'intake')!,
      flow = reader.child(intake, 'workflow')!;
    assert.equal(reader.childCount(flow, 'questions'), 12);
    assert.equal(reader.childCount(flow, 'operations'), 1);
    assert.equal(
      [...reader.fieldChunks(flow, 'unknownEvidence')].join(''),
      JSON.stringify('Fictional untouched scalar '.repeat(300)),
    );
    for (let index = 0; index < 12; index++)
      assert.ok(reader.find('question', flow, 'fictional-question-' + index));
    assert.deepEqual(
      selectedEnvelopeStore(db, f.source).collections.replay(
        prepared.publicationId,
        prepared.fingerprint,
      ),
      accepted,
    );
  };
  inspect(f.db);
  const afterWork = intakeWorkCounters(f.db).warm;
  assert.equal(afterWork.envelopeHydrations, beforeWork.envelopeHydrations);
  assert.equal(afterWork.materializationReads, beforeWork.materializationReads);
  assert.ok(afterWork.privateEnvelopeStagedParts > beforeWork.privateEnvelopeStagedParts);
  assert.ok(afterWork.privateEnvelopePeakPartBytes <= 8 * 1024 * 1024);
  const acceptedHead = Buffer.from(f.storage.read('head')!);
  assert.equal((await f.prepare()).replayed, true);
  assert.deepEqual(f.storage.read('head'), acceptedHead);
  const rebuiltPath = join(f.root, 'rebuilt.sqlite');
  rebuildContributorDatabase(rebuiltPath, f.root, f.profileId);
  const rebuilt = openDatabase(rebuiltPath, f.profileId);
  try {
    attachPersonalDurability(rebuilt, {
      root: f.root,
      profileId: f.profileId,
      recordStorage: f.storage,
    });
    inspect(rebuilt);
  } finally {
    rebuilt.close();
  }
});

test('cached private seals honor the final caller guard and retain exact operation snapshot pins', async (t) => {
  const f = await fixture(t),
    selected = selectedEnvelopeStore(f.db, f.source),
    originalHead = Buffer.from(f.storage.read('head')!),
    operation = {
      operationId: randomUUID(),
      requestDigest: hash('fictional cached private seal'),
      domainVersion: 1,
    },
    candidate = selected.collections.createPrivateEnvelopeMutation(
      selected.collections.openView(),
      selected.source,
      operation,
    ),
    change = selected.collections.privateEnvelopeChange(candidate),
    reason = Error('Fictional cached seal cancellation');
  const witnessQueries = intakeWorkCounters(f.db).warm.collectionReadWitnessQueries;
  candidate.check();
  assert.equal(intakeWorkCounters(f.db).warm.collectionReadWitnessQueries - witnessQueries, 4);
  await candidate.seal();
  await assert.rejects(
    selected.collections.preparePrivateEnvelopeMutation(
      candidate,
      { ...operation, changes: [change] },
      {
        assertCurrent() {
          throw reason;
        },
      },
    ),
    (error) => error === reason,
  );
  assert.throws(candidate.check, /workspace changed/);
  selected.collections.disposePrivateEnvelopeMutation(candidate);
  assert.deepEqual(f.storage.read('head'), originalHead);
  const next = selected.collections.createPrivateEnvelopeMutation(
    selected.collections.openView(),
    selected.source,
    operation,
  );
  let operationReads = 0;
  const prepared = await selected.collections.preparePrivateEnvelopeMutation(next, {
    get operationId() {
      operationReads++;
      return operationReads === 1 ? operation.operationId : randomUUID();
    },
    requestDigest: operation.requestDigest,
    domainVersion: operation.domainVersion,
    changes: [selected.collections.privateEnvelopeChange(next)],
  });
  const result = selected.collections.inspectPrepared(prepared).result;
  assert.equal(operationReads, 1);
  assert.equal(result.operationId, operation.operationId);
  assert.equal(result.logical.domainVersion, operation.domainVersion);
  selected.collections.disposePreparation(prepared);
  assert.deepEqual(f.storage.read('head'), originalHead);
});

test('private auxiliary builds select one final head and survive contributor recovery', async (t) => {
  const f = await fixture(t),
    selected = selectedEnvelopeStore(f.db, f.source),
    before = Buffer.from(f.storage.read('head')!),
    operation = {
      operationId: randomUUID(),
      requestDigest: hash('fictional private auxiliary publication'),
      domainVersion: selected.collections.binding(selected.collections.openView())!.logical
        .domainVersion,
    },
    candidate = selected.collections.createPrivateEnvelopeMutation(
      selected.collections.openView(),
      selected.source,
      operation,
    );
  for (let offset = 0; offset < 96; offset += 48)
    candidate.apply(
      Array.from({ length: 48 }, (_, index) => ({
        area: 'builds' as const,
        collection: 'fictional.auxiliary.work',
        op: 'put' as const,
        key: String(offset + index).padStart(4, '0'),
        value: 'Fictional retained auxiliary value',
      })),
    );
  candidate.retainCollection('fictional.auxiliary.work');
  candidate.apply([
    {
      area: 'builds',
      collection: 'fictional.auxiliary.temporary',
      op: 'put',
      key: 'unused',
      value: 'Disposable intermediate',
    },
  ]);
  const prepared = await selected.collections.preparePrivateEnvelopeMutation(candidate, {
    ...operation,
    changes: [
      selected.collections.privateEnvelopeChange(candidate),
      {
        area: 'builds',
        collection: 'fictional.auxiliary.selected',
        op: 'adoptCollection',
        fromArea: 'builds',
        fromCollection: 'fictional.auxiliary.work',
      },
    ],
  });
  assert.deepEqual(f.storage.read('head'), before);
  transaction(f.db, () => selected.collections.stage(prepared));
  assert.notDeepEqual(f.storage.read('head'), before);
  const inspect = (db: typeof f.db) => {
    const store = selectedEnvelopeStore(db, f.source).collections,
      view = store.openView();
    assert.equal(
      store.get(view, 'builds', 'fictional.auxiliary.selected', '0095'),
      'Fictional retained auxiliary value',
    );
    assert.equal(
      store.get(view, 'builds', 'fictional.auxiliary.work', '0000'),
      'Fictional retained auxiliary value',
    );
    assert.equal(store.collection(view, 'builds', 'fictional.auxiliary.temporary'), undefined);
  };
  inspect(f.db);
  const rebuiltPath = join(f.root, 'auxiliary-rebuilt.sqlite');
  rebuildContributorDatabase(rebuiltPath, f.root, f.profileId);
  const rebuilt = openDatabase(rebuiltPath, f.profileId);
  try {
    attachPersonalDurability(rebuilt, {
      root: f.root,
      profileId: f.profileId,
      recordStorage: f.storage,
    });
    inspect(rebuilt);
  } finally {
    rebuilt.close();
  }
});

test('actual question-derived preparation selects only the final state pass', async (t) => {
  const f = await fixture(t);
  await prepareReviewQuestionState(f.db, f.source);
  const before = Buffer.from(f.storage.read('head')!);
  const names: string[] = [];
  let answerAddress = '';
  const prepared = await prepareIntakeWorkflowCommand(f.db, f.source, {
    version: intakeSourceVersion(f.db, f.source.id).version,
    operationId: 'fictional-private-question-derived',
    request: { answer: 'fictional' },
    createdAt: '2026-01-01',
    *changes({ workflow }) {
      yield {
        op: 'append',
        record: workflow,
        field: 'questions',
        jsonText: JSON.stringify({
          id: 'fictional-derived-question',
          key: 'fictional-derived',
          candidateId: null,
          candidateVersionId: null,
          prompt: 'Confirm the fictional value',
          locator: 'line 1',
          field: 'documentTitle',
          status: 'answered',
          createdAt: '2026-01-01',
          answers: [
            {
              id: 'fictional-derived-answer',
              answer: 'Fictional answer',
              mapping: {},
              scope: 'record',
              at: '2026-01-01',
            },
          ],
        }),
      };
    },
    prepareDerived: async (derived) => {
      const intake = derived.reader.child(derived.reader.root(), 'intake')!,
        workflow = derived.reader.child(intake, 'workflow')!,
        question = derived.reader.find('question', workflow, 'fictional-derived-question')!;
      answerAddress = derived.reader.address(derived.reader.childAt(question, 'answers', 0)!);
      names.push('review.questions.' + workflowHash(derived.logical));
      return prepareReviewQuestionDerived(f.db, f.source, {
        ...derived,
        questionAddresses: [derived.reader.address(question)],
      });
    },
    derivedIntakeState: () => 'needs_review',
  });
  assert.equal(prepared.replayed, false);
  if (prepared.replayed) throw Error('Expected new derived command');
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1]);
  assert.deepEqual(f.storage.read('head'), before);
  transaction(f.db, () =>
    selectedEnvelopeStore(f.db, f.source).collections.stage(prepared.prepared),
  );
  const inspect = (db: typeof f.db) => {
    const store = selectedEnvelopeStore(db, f.source).collections,
      view = store.openView();
    assert.equal(store.collection(view, 'builds', names[0]!), undefined);
    assert.ok(store.collection(view, 'builds', names[1]!));
    const answer = store.get(view, 'builds', names[1]!, 'answer:' + answerAddress);
    assert.equal(typeof answer, 'string');
    if (typeof answer !== 'string') throw Error('Expected canonical answer cell');
    assert.deepEqual(JSON.parse(answer), {
      id: 'fictional-derived-answer',
      answer: 'Fictional answer',
      mapping: {},
      scope: 'record',
      at: '2026-01-01',
    });
  };
  inspect(f.db);
  const rebuiltPath = join(f.root, 'question-derived-rebuilt.sqlite');
  rebuildContributorDatabase(rebuiltPath, f.root, f.profileId);
  const rebuilt = openDatabase(rebuiltPath, f.profileId);
  try {
    attachPersonalDurability(rebuilt, {
      root: f.root,
      profileId: f.profileId,
      recordStorage: f.storage,
    });
    inspect(rebuilt);
  } finally {
    rebuilt.close();
  }
});

test('ordinary preparation cannot borrow a reentrant private issuer for the exact same input', async (t) => {
  const f = await fixture(t),
    selected = selectedEnvelopeStore(f.db, f.source),
    originalHead = Buffer.from(f.storage.read('head')!),
    operation = {
      operationId: randomUUID(),
      requestDigest: hash('fictional reentrant private scope'),
      domainVersion: 1,
    },
    candidate = selected.collections.createPrivateEnvelopeMutation(
      selected.collections.openView(),
      selected.source,
      operation,
    ),
    changes = [selected.collections.privateEnvelopeChange(candidate)];
  let entered = false,
    refused = false;
  const input = {
    ...operation,
    get changes() {
      if (!entered) {
        entered = true;
        assert.throws(
          () => selected.collections.prepare(selected.collections.openView(), input),
          /collection reference/,
        );
        refused = true;
      }
      return changes;
    },
  };
  assert.throws(() => selected.collections.previewPrivateEnvelopeMutation(candidate, input));
  assert.equal(entered, true);
  assert.equal(refused, true);
  assert.deepEqual(f.storage.read('head'), originalHead);
  selected.collections.disposePrivateEnvelopeMutation(candidate);
});

test('private owner refuses ordinary-path adoption, wrong operations and source drift without a receipt', async (t) => {
  const f = await fixture(t),
    selected = selectedEnvelopeStore(f.db, f.source),
    originalHead = Buffer.from(f.storage.read('head')!),
    beforeTransactions = f.db.prepare('SELECT count(*) n FROM __record_transactions').get()!.n,
    operation = {
      operationId: randomUUID(),
      requestDigest: hash('fictional private scope'),
      domainVersion: 2,
    };
  const candidate = selected.collections.createPrivateEnvelopeMutation(
      selected.collections.openView(),
      selected.source,
      operation,
    ),
    change = selected.collections.privateEnvelopeChange(candidate);
  await assert.rejects(
    selected.collections.preparePrivateEnvelopeMutation(
      { ...candidate },
      {
        ...operation,
        changes: [change],
      },
    ),
    /foreign private envelope candidate/,
  );
  assert.throws(
    () =>
      selected.collections.prepare(selected.collections.openView(), {
        ...operation,
        changes: [change],
      }),
    /collection reference/,
  );
  assert.deepEqual(f.storage.read('head'), originalHead);
  const current = selectedEnvelopeStore(f.db, f.source),
    other = current.collections.createPrivateEnvelopeMutation(
      current.collections.openView(),
      current.source,
      operation,
    );
  await assert.rejects(
    current.collections.preparePrivateEnvelopeMutation(other, {
      ...operation,
      operationId: randomUUID(),
      changes: [current.collections.privateEnvelopeChange(other)],
    }),
    /foreign or nested/,
  );
  current.collections.disposePrivateEnvelopeMutation(other);
  let changed = false;
  await assert.rejects(
    f.prepare({
      onCheckpoint() {
        if (!changed) {
          changed = true;
          f.db
            .prepare('UPDATE source_files SET sha256=? WHERE id=?')
            .run('f'.repeat(64), f.source.id);
        }
      },
    }),
    /missing selected intake head|Stale envelope mutation source|private envelope original owner changed/,
  );
  assert.equal(changed, true);
  assert.deepEqual(f.storage.read('head'), originalHead);
  assert.equal(
    f.db.prepare('SELECT count(*) n FROM __record_transactions').get()!.n,
    beforeTransactions,
  );
});

test('private mutation cancellation closes its workspace and never publishes preparation', async (t) => {
  const f = await fixture(t),
    beforeHead = Buffer.from(f.storage.read('head')!),
    before = workspaces(),
    reason = Error('Fictional private mutation cancelled');
  let cancelled = false;
  await assert.rejects(
    f.prepare({
      onCheckpoint() {
        cancelled = true;
      },
      assertRunning() {
        if (cancelled) throw reason;
      },
    }),
    (error) => error === reason,
  );
  assert.equal(cancelled, true);
  assert.deepEqual(f.storage.read('head'), beforeHead);
  assert.deepEqual(workspaces(), before);
});

test('private envelope nodes enter genuine contributor T1 once and replay under the original T2 closure', async (t) => {
  const f = await recordPreparedPublicationFixture(t, undefined, 'contributor');
  await runExclusiveClinicalOperation(f.db, async () => {
    const original = captureOwnershipReportOriginalProof(f.plan, f.db, f.profileId),
      originals = await captureRecordPublicationOriginals(f.db, f.profileId, original);
    try {
      const command = await prepareIntakeWorkflowCommand(f.db, f.source, {
        version: intakeSourceVersion(f.db, f.source.id).version,
        operationId: 'fictional-private-original-closure',
        request: { link: 'fictional-chat' },
        createdAt: '2026-01-01',
        *changes({ intake }) {
          yield {
            op: 'set',
            record: intake,
            field: 'conversionChatId',
            jsonText: '"fictional-chat"',
          };
        },
      });
      if (command.replayed) throw Error('Expected private original-backed preparation');
      let businessCalls = 0;
      const preparation = await prepareRecordTransactionWithOriginals(
        f.db,
        () => {
          businessCalls++;
          selectedEnvelopeStore(f.db, f.source).collections.stage(command.prepared);
          return { operationId: command.publicationId };
        },
        { operationId: randomUUID(), fingerprint: 'fictional-private-original-closure' },
        originals,
      );
      try {
        assert.equal(businessCalls, 1);
        assert.deepEqual(f.storage.read('head'), f.beforeHead);
        await authenticateRecordTransactionPreparation(f.db, preparation);
        await stageRecordTransactionPreparation(f.db, preparation);
        assert.deepEqual(await commitRecordTransactionPreparation(f.db, preparation), {
          operationId: command.publicationId,
        });
        assert.equal(businessCalls, 1);
        assert.notDeepEqual(f.storage.read('head'), f.beforeHead);
        const reader = openIntakeCollectionEnvelope(f.db, f.source),
          intake = reader.child(reader.root(), 'intake')!;
        assert.deepEqual(reader.field(intake, 'conversionChatId'), {
          kind: 'value',
          value: 'fictional-chat',
        });
        assert.equal(
          (
            await prepareIntakeWorkflowCommand(f.db, f.source, {
              version: 0,
              operationId: 'fictional-private-original-closure',
              request: { link: 'fictional-chat' },
              createdAt: '2026-01-02',
              *changes() {
                throw Error('Exact retry must not execute business changes');
              },
            })
          ).replayed,
          true,
        );
      } finally {
        discardRecordTransactionPreparation(f.db, preparation);
      }
    } finally {
      closeRecordPublicationOriginals(originals);
    }
  });
});
