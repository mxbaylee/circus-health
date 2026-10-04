import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareIntakeWorkflowCommand } from '../intake-workflow-command.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { writeIntakeSourcePin } from '../intake-source-pin.ts';

async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-workflow-command-')),
    db = openDatabase(join(directory, 'cache.sqlite'), 'fictional');
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const source = { id: 'fictional-command', kind: 'intake_original', sha256: 'a'.repeat(64) },
    original = {
      intake: {
        version: 1,
        originalName: 'fictional.json',
        workflow: {
          format: 'health-intake-workflow-v1',
          operations: [],
          questions: Array.from({ length: 70 }, (_, i) => ({
            id: 'question-' + i,
            status: 'unanswered',
            answers: [],
          })),
          unknownEvidence: 'fictional evidence '.repeat(12000),
        },
      },
    },
    initial = prepareInitialIntakeEnvelope(original),
    storage = createIntakeStateStorage(db, {
      profileId: 'fictional',
      intakeId: source.id,
      sourceHash: source.sha256,
    });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(source.id, 'fictional.json', source.sha256, 0, source.kind, initial.detailsJson);
    storage.stage(initial.state, randomUUID());
  });
  await buildIntakeCollectionEnvelope(db, source);
  const state = () => {
    const view = openIntakeCollectionEnvelope(db, source),
      intake = view.child(view.root(), 'intake')!,
      workflow = view.child(intake, 'workflow')!,
      question = view.find('question', workflow, 'question-69')!;
    return { view, intake, workflow, question };
  };
  const prepare = (version = intakeSourceVersion(db, source.id).version) =>
    prepareIntakeWorkflowCommand(db, source, {
      version,
      operationId: 'fictional-answer',
      request: { operationId: 'fictional-answer', questionId: 'question-69', answer: 'Known' },
      createdAt: '2026-01-01',
      *changes({ reader, workflow }) {
        const question = reader.find('question', workflow, 'question-69')!;
        yield {
          op: 'append',
          record: question,
          field: 'answers',
          jsonText: '{"id":"fictional-answer","answer":"Known"}',
        };
        yield { op: 'set', record: question, field: 'status', jsonText: '"answered"' };
      },
    });
  const answers = () => {
    const current = state();
    return current.view.childCount(current.question, 'answers');
  };
  return { db, source, state, prepare, original, answers };
}

test('addressed command publishes once with its operation receipt, survives rollback and replays before changed pins', async (t) => {
  const f = await fixture(t),
    before = intakeWorkCounters(f.db).warm;
  const prepared = await f.prepare();
  assert.equal(prepared.replayed, false);
  if (prepared.replayed) throw Error('Expected new command');
  assert.equal(f.answers(), 0);
  assert.equal(intakeSourceVersion(f.db, f.source.id).version, 1);
  assert.throws(
    () =>
      transaction(f.db, () => {
        selectedEnvelopeStore(f.db, f.source).collections.stage(prepared.prepared);
        throw Error('fictional related write failed');
      }),
    /fictional related write failed/,
  );
  clearIntakeStateCache(f.db);
  assert.equal(f.answers(), 0);
  const retry = await f.prepare();
  assert.equal(retry.replayed, false);
  if (retry.replayed) throw Error('Expected retry preparation');
  transaction(f.db, () => {
    retry.assertCurrent();
    selectedEnvelopeStore(f.db, f.source).collections.stage(retry.prepared);
  });
  const current = f.state();
  assert.equal(current.view.childCount(current.question, 'answers'), 1);
  assert.equal(current.view.childCount(current.workflow, 'operations'), 1);
  assert.equal(intakeSourceVersion(f.db, f.source.id).version, 2);
  assert.equal(
    [...current.view.fieldChunks(current.workflow, 'unknownEvidence')].join(''),
    JSON.stringify(f.original.intake.workflow.unknownEvidence),
  );
  transaction(f.db, () =>
    writeIntakeSourcePin(f.db, f.source.id, {
      version: 3,
      revisionId: 'fictional-revision',
      dependencyToken: 'fictional-dependency',
      requiresInterpretation: true,
    }),
  );
  const replayBefore = intakeWorkCounters(f.db).warm.collectionNodesWritten;
  assert.equal((await f.prepare(1)).replayed, true);
  assert.equal(intakeWorkCounters(f.db).warm.collectionNodesWritten, replayBefore);
  await assert.rejects(
    prepareIntakeWorkflowCommand(f.db, f.source, {
      version: 1,
      operationId: 'fictional-answer',
      request: { answer: 'Different' },
      createdAt: '2026-01-02',
      *changes() {
        throw Error('Conflicting replay must not invoke command');
      },
    }),
    { code: 'OPERATION_CONFLICT' },
  );
  const after = intakeWorkCounters(f.db).warm;
  assert.equal(after.envelopeHydrations, before.envelopeHydrations);
  assert.equal(after.materializationReads, before.materializationReads);
});

test('prepared commands refuse competing source changes and link-only edits preserve the public version', async (t) => {
  const f = await fixture(t),
    pending = await f.prepare();
  assert.equal(pending.replayed, false);
  if (pending.replayed) throw Error('Expected new command');
  const link = await prepareIntakeWorkflowCommand(f.db, f.source, {
    version: 1,
    incrementVersion: false,
    request: { chatId: 'fictional-chat' },
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
  if (link.replayed) throw Error('Expected link command');
  transaction(f.db, () => selectedEnvelopeStore(f.db, f.source).collections.stage(link.prepared));
  assert.equal(intakeSourceVersion(f.db, f.source.id).version, 1);
  assert.throws(pending.assertCurrent, { code: 'VERSION_CONFLICT' });
  assert.equal(f.answers(), 0);
  await assert.rejects(f.prepare(0), { code: 'VERSION_CONFLICT' });
});
