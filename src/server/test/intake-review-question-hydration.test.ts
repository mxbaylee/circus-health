import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewQuestionHydrationCache } from '../intake-review-question-hydration.ts';
import {
  reviewReadStamp,
  preparedClinicalReviewRead,
} from '../intake-clinical-review-read-cache.ts';
import { selectionAuthority } from '../intake-selection-authority.ts';
import nodeFs, { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction, type Database } from '../database.ts';
import { attachRecordDurability } from '../record-versions.ts';
import {
  contributorAuthorityPath,
  openContributorRecordStorage,
  captureContributorRecordWriteWitness,
  contributorRecordWriteWitnessSequence,
  closeContributorRecordWriteWitness,
  type ContributorRecordWriteWitness,
} from '../contributor-record-storage.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, reviewIntakeRead } from '../intake.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import {
  prepareCollectionClinicalReview,
  prepareCollectionClinicalReviewDependencies,
} from '../intake-review-collection-host.ts';
import { collectionClinicalProjectionContext } from '../intake-review-collection-session.ts';
import { clinicalSourceIdentityV1 } from '../intake-source-identity.ts';
import {
  registerRawIntakeFixture,
  memoryRecordAuthority,
  writeIntakeFixtureEnvelope,
} from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import {
  createReviewIssueScratch,
  reviewIssueScratchCounts,
} from '../intake-review-issue-scratch.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { collectionWorkflowReviewScope } from '../intake-review-collection.ts';
import {
  openReviewQuestionState,
  canonicalReviewValueChunks,
  prepareReviewQuestionState,
} from '../intake-review-question-state.ts';
import { reviewRecordQuestions } from '../intake-review-question-selection.ts';
import { canonicalLiteral, validateJSONL } from '../intake-format.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import type { IntakeEnvelopeSource } from '../intake-authority.ts';
import type { IntakeCollectionEnvelopeReader } from '../intake-collection-envelope.ts';

type QuestionStateFactory = (input: {
  db: Database;
  source: IntakeEnvelopeSource;
  view: IntakeCollectionEnvelopeReader;
  scratch: Database;
}) => ReturnType<typeof openReviewQuestionState>;

async function countedQuestionHydrationFixture(
  t: test.TestContext,
  count: 8 | 32,
  open: QuestionStateFactory = ({ db, source, view }) => openReviewQuestionState(db, source, view),
  history: 1 | 3 = 1,
  contributor = false,
) {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-question-hydration-'));
  const db = openDatabase(join(directory, 'cache.sqlite'), 'fictional-question-hydration');
  const scratch = createReviewIssueScratch(db);
  const authority = contributor
    ? (() => {
        ensureProfileDirectories(directory, 'fictional-question-hydration');
        const storage = openContributorRecordStorage(directory, 'fictional-question-hydration', {
          initialize: true,
        });
        attachRecordDurability(db, { profileId: 'fictional-question-hydration', storage });
        return { storage };
      })()
    : memoryRecordAuthority(db);
  let acceptedWrites = 0,
    publications = 0;
  if (!contributor) {
    const write = authority.storage.writeImmutable.bind(authority.storage);
    authority.storage.writeImmutable = (name, bytes) => {
      acceptedWrites++;
      write(name, bytes);
    };
    const publish = authority.storage.publishHead.bind(authority.storage);
    authority.storage.publishHead = (bytes) => {
      publications++;
      publish(bytes);
    };
  }
  let writeWitness: ContributorRecordWriteWitness | undefined;
  // Capture once after setup without replacing the genuine factory methods.
  const writeCount = () => {
    if (!contributor) return acceptedWrites;
    writeWitness ??= captureContributorRecordWriteWitness(authority.storage);
    assert.ok(writeWitness);
    return contributorRecordWriteWitnessSequence(authority.storage, writeWitness);
  };
  const publicationState = () => {
    if (!contributor) return publications;
    const base = contributorAuthorityPath(directory, 'fictional-question-hydration');
    return JSON.stringify({
      head: readFileSync(join(base, 'head')).toString('base64'),
      objects: readdirSync(join(base, 'objects')).sort(),
    });
  };
  t.after(() => {
    if (writeWitness) closeContributorRecordWriteWitness(writeWitness);
    scratch.close();
    clearIntakeStateCache(db);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const questions = Array.from({ length: count }, (_, ordinal) => ({
    id: 'question:fictional-hydration-' + ordinal,
    key: 'fictional-hydration-' + ordinal,
    candidateId: 'candidate:fictional-hydration',
    candidateVersionId: 'version:fictional-hydration',
    prompt: 'Confirm the fictional document title ' + 'x'.repeat(2048),
    locator: 'page 1',
    field: 'documentTitle',
    status: ordinal === count - 1 ? 'unanswered' : 'resolved',
    createdAt: '2026-01-01T00:00:00Z',
    unknownHeader: { number: JSON.rawJSON('12.00'), nested: { text: 'fictional original' } },
    answers: Array.from({ length: history }, (_, answer) => ({
      id: 'answer:fictional-' + ordinal + ':' + answer,
      answer: 'Fictional prior explanation',
      mapping: { documentTitle: 'Fictional original mapping' },
      unknownAnswerNumber: JSON.rawJSON('13.00'),
      scope: 'record',
      at: '2026-01-01T00:00:00Z',
    })),
  }));
  assert.ok(Buffer.byteLength(canonicalLiteral(questions)) > 4096);
  assert.ok(questions.every((question) => Buffer.byteLength(canonicalLiteral(question)) < 4096));
  const source = { id: 'fictional-hydration-source' };
  registerRawIntakeFixture(
    db,
    source.id,
    JSON.stringify({
      intake: {
        version: 0,
        workflow: {
          format: 'health-intake-workflow-v1',
          questions,
          candidates: [],
          decisions: [],
          reviewDrafts: [],
        },
      },
    }),
  );
  await buildIntakeCollectionEnvelope(db, source);
  if (history > 1) await prepareReviewQuestionState(db, source);
  const view = openIntakeCollectionEnvelope(db, source);
  const sourceWork = { exports: 0, bytes: 0 };
  const recordChunks = view.recordChunks.bind(view);
  view.recordChunks = function* (record) {
    if (record.kind === 'question') sourceWork.exports++;
    for (const chunk of recordChunks(record)) {
      if (record.kind === 'question') sourceWork.bytes += Buffer.byteLength(chunk);
      yield chunk;
    }
  };
  const state = open({ db, source, view, scratch: scratch.db });
  const scope = collectionWorkflowReviewScope({
    view,
    catalog: createReportSnapshotCatalog(db, source),
    questionState: state,
    policySql: scratch.db,
    metadataBytes: 4096,
    packageEvidence: false,
    activeReceipt: () => true,
    originalFingerprint: () => 'fictional-original-fingerprint',
    reportSource: () => undefined,
  });
  const before = structuredClone(intakeWorkCounters(db));
  const initialWrites = writeCount(),
    initialPublication = publicationState();
  const selected = scope.questions('candidate:fictional-hydration', 'version:fictional-hydration');
  assert.ok(
    !Array.isArray(selected),
    'fixture must exercise referenced questions, not retained inline values',
  );
  const record = { questionsReference: selected };
  const expected = canonicalLiteral(questions);
  for (const pass of ['date', 'issues', 'mapping', 'token']) {
    const values: string[] = [];
    let ordinal = 0;
    for (const question of reviewRecordQuestions(record)) {
      assert.equal(question.id, questions[ordinal++]!.id);
      values.push([...canonicalReviewValueChunks(question)].join(''));
      if (pass === 'issues' && ordinal === 1) {
        const header = Reflect.get(question, 'unknownHeader');
        assert.ok(header && typeof header === 'object');
        const nested = Reflect.get(header, 'nested');
        assert.ok(nested && typeof nested === 'object');
        Reflect.set(nested, 'text', 'Fictional mutated nested header');
        question.answers[0]!.mapping.documentTitle = 'Fictional mutated latest mapping';
      }
    }
    assert.equal('[' + values.join(',') + ']', expected);
    assert.equal(ordinal, count);
  }
  // Returning to the first question after the complete corpus detects FIFO cycling
  // and checks that mutation of one borrowed question did not enter the recipe.
  const first = reviewRecordQuestions(record).at(0)!;
  assert.equal([...canonicalReviewValueChunks(first)].join(''), canonicalLiteral(questions[0]));
  assert.equal(writeCount(), initialWrites, 'policy reuse writes no accepted evidence');
  assert.equal(
    publicationState(),
    initialPublication,
    'policy reuse publishes no accepted evidence',
  );
  return {
    count,
    sourceWork,
    before,
    after: structuredClone(intakeWorkCounters(db)),
    state,
    scope,
    scratch,
    db,
    view,
    questions,
    directory,
    acceptedWrites: writeCount,
    publications: publicationState,
  };
}

test(
  'session question recipes avoid repeated native exports at two counts while charging parse, spool and MAC work',
  { timeout: 180_000 },
  async (t) => {
    for (const count of [8, 32] as const) {
      const baseline = await countedQuestionHydrationFixture(t, count);
      let close: () => void = () => {};
      const cached = await countedQuestionHydrationFixture(t, count, (input) => {
        const cache = createReviewQuestionHydrationCache(input.db, input.scratch);
        close = cache.close;
        return openReviewQuestionState(input.db, input.source, input.view, {
          cache,
          assertCurrent: () => {
            input.view.address(input.view.root());
          },
        });
      });
      t.after(close);
      const delta = (caseResult: typeof cached) => {
        const before = caseResult.before.warm,
          after = caseResult.after.warm;
        return {
          hydrated: after.reviewQuestionHydrations - before.reviewQuestionHydrations,
          bytes: after.reviewQuestionHydrationBytes - before.reviewQuestionHydrationBytes,
          hits: after.reviewQuestionHydrationHits - before.reviewQuestionHydrationHits,
          parse: after.reviewQuestionParseBytes - before.reviewQuestionParseBytes,
          read: after.reviewQuestionScratchReadBytes - before.reviewQuestionScratchReadBytes,
          written:
            after.reviewQuestionScratchWrittenBytes - before.reviewQuestionScratchWrittenBytes,
          mac: after.reviewQuestionRecipeMacBytes - before.reviewQuestionRecipeMacBytes,
          discarded:
            after.reviewQuestionScratchDiscardedRows - before.reviewQuestionScratchDiscardedRows,
          nodeReads: after.collectionNodeReads - before.collectionNodeReads,
        };
      };
      const old = delta(baseline),
        reused = delta(cached);
      assert.ok(old.hydrated >= count * 4);
      assert.equal(reused.hydrated, count);
      assert.equal(cached.sourceWork.exports, count);
      assert.ok(baseline.sourceWork.exports >= count * 4);
      assert.ok(reused.bytes < old.bytes);
      assert.equal(
        reused.parse,
        old.parse,
        'detached literal parsing remains counted on every borrow',
      );
      assert.ok(reused.hits >= count * 3);
      assert.ok(reused.read > 0 && reused.written > 0 && reused.mac > 0);
      assert.equal(reused.discarded, 0, 'stable reads do not erase a populated recipe corpus');
      assert.ok(reused.nodeReads < old.nodeReads);
      t.diagnostic(JSON.stringify({ count, baseline: old, cached: reused }));
    }
  },
);

test('long-answer recipes reattach exact canonical providers and preserve nested detachment, reset and resolution', async (t) => {
  let close: () => void = () => {};
  const f = await countedQuestionHydrationFixture(
    t,
    8,
    (input) => {
      const cache = createReviewQuestionHydrationCache(input.db, input.scratch);
      close = cache.close;
      return openReviewQuestionState(input.db, input.source, input.view, {
        cache,
        assertCurrent: () => {
          input.view.address(input.view.root());
        },
      });
    },
    3,
  );
  t.after(close);
  const workflow = f.view.child(f.view.child(f.view.root(), 'intake')!, 'workflow')!;
  const record = f.view.find('question', workflow, f.questions[0]!.id)!;
  const question = f.state.question(record, 4096);
  assert.equal(question.answerScope, 'latest');
  assert.equal(question.answerHistory!.count, 3);
  assert.equal(selectionAuthority({ question }), selectionAuthority({ question: f.questions[0] }));
  question.answers = [];
  question.status = 'unanswered';
  question.resolvedAt = '2026-01-02T00:00:00Z';
  const expected = {
    ...f.questions[0],
    answers: [],
    status: 'unanswered',
    resolvedAt: '2026-01-02T00:00:00Z',
  };
  assert.equal([...f.state.canonicalRecords(question)].join(''), canonicalLiteral(expected));
  const fresh = f.state.question(record, 4096);
  assert.equal(
    selectionAuthority({ question: fresh }),
    selectionAuthority({ question: f.questions[0] }),
  );
  assert.match([...f.state.canonicalRecords(fresh)].join(''), /12\.00/);
  assert.match([...f.state.canonicalRecords(fresh)].join(''), /13\.00/);
  close();
  assert.throws(() => [...f.state.canonicalRecords(fresh)], /closed/i);
});

test('recipe corruption refuses rather than certifying SQL, missing rows hydrate under original guards and closed owners stay closed', async (t) => {
  let close: () => void = () => {};
  const f = await countedQuestionHydrationFixture(t, 8, (input) => {
    const cache = createReviewQuestionHydrationCache(input.db, input.scratch);
    close = cache.close;
    return openReviewQuestionState(input.db, input.source, input.view, {
      cache,
      assertCurrent: () => {
        input.view.address(input.view.root());
      },
    });
  });
  t.after(close);
  const workflow = f.view.child(f.view.child(f.view.root(), 'intake')!, 'workflow')!;
  const record = f.view.find('question', workflow, f.questions[0]!.id)!;
  const address = f.view.address(record);
  assert.throws(() => f.state.question(record, 16), /fragment/i);
  const exportsBefore = f.sourceWork.exports;
  f.scratch.db
    .prepare(
      "UPDATE review_question_hydration_v1 SET recipe=json_set(recipe,'$.text','fictional corrupt SQL') WHERE address=?",
    )
    .run(address);
  assert.throws(() => f.state.question(record, 4096), /authentication|corrupt/i);
  assert.equal(
    f.sourceWork.exports,
    exportsBefore,
    'corrupt present data cannot silently fall back',
  );
  f.scratch.db.prepare('DELETE FROM review_question_hydration_v1 WHERE address=?').run(address);
  assert.equal(canonicalLiteral(f.state.question(record, 4096)), canonicalLiteral(f.questions[0]));
  assert.equal(f.sourceWork.exports, exportsBefore + 1);
  close();
  assert.throws(() => f.state.question(record, 4096), /closed/i);
});

test('recipe raw proof invalidates between borrows and rejects mid-borrow restored writes without rebasing the outer owner', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-question-recipe-proof-'));
  const path = join(directory, 'cache.sqlite');
  const db = openDatabase(path, 'fictional-question-recipe-proof');
  const peer = openDatabase(path, 'fictional-question-recipe-proof');
  const scratch = createReviewIssueScratch(db);
  const cache = createReviewQuestionHydrationCache(db, scratch.db);
  t.after(() => {
    cache.close();
    scratch.close();
    peer.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec('CREATE TABLE recipe_proof_stimulus(value TEXT)');
  let hydrated = 0,
    guards = 0,
    stimulus: (() => void) | undefined;
  const text = '{"answers":[],"nested":{"text":"fictional original"}}';
  const borrow = () =>
    cache.read({
      binding: 'fictional-source-profile-hash-logical',
      expectedBefore: reviewReadStamp(db),
      address: 'a'.repeat(64),
      count: 0,
      bytes: 4096,
      assertCurrent() {
        guards++;
        if (guards === 2) stimulus?.();
      },
      overBudget(): never {
        throw Error('fragment required');
      },
      hydrate() {
        hydrated++;
        return {
          value: JSON.parse(text),
          recipe: { kind: 'full' as const, count: 0, cost: Buffer.byteLength(text), text },
        };
      },
      materialize: (recipe) => JSON.parse(recipe.kind === 'full' ? recipe.text : ''),
    });
  const initial = borrow();
  initial.nested.text = 'fictional local mutation';
  guards = 0;
  assert.equal(borrow().nested.text, 'fictional original');
  assert.equal(hydrated, 1);
  for (const change of [
    () =>
      db.exec(
        "INSERT INTO recipe_proof_stimulus VALUES('local'); DELETE FROM recipe_proof_stimulus",
      ),
    () =>
      peer.exec(
        "INSERT INTO recipe_proof_stimulus VALUES('peer'); DELETE FROM recipe_proof_stimulus",
      ),
    () => db.exec('CREATE TEMP TABLE recipe_proof_temp(value TEXT); DROP TABLE recipe_proof_temp'),
    () =>
      db.exec(
        "SAVEPOINT recipe_proof; INSERT INTO recipe_proof_stimulus VALUES('rolled back'); ROLLBACK TO recipe_proof; RELEASE recipe_proof",
      ),
  ]) {
    const prior = reviewReadStamp(db),
      beforeHydrate: number = hydrated;
    change();
    assert.notEqual(reviewReadStamp(db), prior, 'actual raw stimulus must change proof');
    guards = 0;
    assert.equal(borrow().nested.text, 'fictional original');
    assert.equal(
      hydrated,
      beforeHydrate + 1,
      'between-borrow invalidation only discards derived recipes',
    );
  }
  const originalOuterProof = reviewReadStamp(db);
  let injected = false;
  stimulus = () => {
    injected = true;
    db.exec(
      "SAVEPOINT recipe_mid; INSERT INTO recipe_proof_stimulus VALUES('restored'); ROLLBACK TO recipe_mid; RELEASE recipe_mid",
    );
  };
  guards = 0;
  assert.throws(borrow, /authority changed during hydration/);
  assert.equal(injected, true, 'stimulus must run at final borrowed-value guard');
  assert.notEqual(reviewReadStamp(db), originalOuterProof);
  assert.equal(
    db.prepare('SELECT count(*) n FROM recipe_proof_stimulus').get()!.n,
    0,
    'stimulus restores SQL rows',
  );
  stimulus = undefined;
  const strictOuterBorrow = () =>
    cache.read({
      binding: 'fictional-source-profile-hash-logical',
      expectedBefore: reviewReadStamp(db),
      address: 'a'.repeat(64),
      count: 0,
      bytes: 4096,
      assertCurrent() {
        assert.equal(reviewReadStamp(db), originalOuterProof, 'outer owner remains stale');
      },
      overBudget(): never {
        throw Error('fragment required');
      },
      hydrate() {
        throw Error('stale outer owner must fail before fallback');
      },
      materialize() {
        throw Error('stale outer owner must fail before borrow');
      },
    });
  assert.throws(strictOuterBorrow, /outer owner remains stale/);
});

test('valid oversized hydration preserves original fallback and never creates an authenticated recipe', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-question-recipe-oversize-'));
  const db = openDatabase(join(directory, 'cache.sqlite'), 'fictional-question-recipe-oversize');
  const scratch = createReviewIssueScratch(db);
  const cache = createReviewQuestionHydrationCache(db, scratch.db);
  t.after(() => {
    cache.close();
    scratch.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const text = JSON.stringify({ answers: [], prompt: 'x'.repeat(256 * 1024) });
  let hydrated = 0;
  for (let n = 0; n < 2; n++) {
    const value = cache.read({
      binding: 'fictional-source-profile-hash-logical',
      expectedBefore: reviewReadStamp(db),
      address: 'b'.repeat(64),
      count: 0,
      bytes: 512 * 1024,
      assertCurrent() {},
      overBudget(): never {
        throw Error('fragment required');
      },
      hydrate() {
        hydrated++;
        return {
          value: JSON.parse(text),
          recipe: { kind: 'full' as const, count: 0, cost: Buffer.byteLength(text), text },
        };
      },
      materialize() {
        throw Error('oversize cannot enter recipe-hit path');
      },
    });
    assert.equal(value.prompt.length, 256 * 1024);
  }
  assert.equal(hydrated, 2);
  assert.equal(
    scratch.db.prepare('SELECT count(*) n FROM review_question_hydration_v1').get()!.n,
    0,
  );
});

test(
  'authenticated recipe hits refuse peer ABA, local rollback and changed accepted HEAD at the final real physical view guard',
  { timeout: 180_000 },
  async (t) => {
    for (const mode of ['peer', 'rollback', 'head'] as const) {
      let close = () => {};
      const f = await countedQuestionHydrationFixture(
        t,
        8,
        (input) => {
          const cache = createReviewQuestionHydrationCache(input.db, input.scratch);
          close = cache.close;
          const originalOwner = reviewReadStamp(input.db);
          return openReviewQuestionState(input.db, input.source, input.view, {
            cache,
            assertCurrent() {
              // This proof belongs to the original owner. The recipe context cannot
              // refresh it after a refusal or a between-borrow cache invalidation.
              assert.equal(reviewReadStamp(input.db), originalOwner, 'original owner changed');
              input.view.address(input.view.root());
            },
          });
        },
        3,
        true,
      );
      t.after(close);
      const workflow = f.view.child(f.view.child(f.view.root(), 'intake')!, 'workflow')!;
      const record = f.view.find('question', workflow, f.questions[0]!.id)!;
      const exact = canonicalLiteral(f.questions[0]);
      const hitsBeforeWarm = intakeWorkCounters(f.db).warm.reviewQuestionHydrationHits;
      assert.equal([...f.state.canonicalRecords(f.state.question(record, 4096))].join(''), exact);
      assert.equal(intakeWorkCounters(f.db).warm.reviewQuestionHydrationHits, hitsBeforeWarm + 1);
      const headPath = join(
        contributorAuthorityPath(f.directory, 'fictional-question-hydration'),
        'head',
      );
      const headBytes = readFileSync(headPath);
      const peer = new DatabaseSync(String(f.db.prepare('PRAGMA database_list').get()!.file));
      const stat = nodeFs.lstatSync,
        stackTraceLimit = Error.stackTraceLimit;
      const before = {
        hits: intakeWorkCounters(f.db).warm.reviewQuestionHydrationHits,
        exports: f.sourceWork.exports,
        writes: f.acceptedWrites(),
        publications: f.publications(),
        nodes: intakeWorkCounters(f.db).warm.collectionNodesWritten,
        raw: reviewReadStamp(f.db),
      };
      let stimulus:
        | {
            before: unknown;
            after: unknown;
            row: unknown;
            headChanged: boolean;
            hits: number;
            stack: string;
          }
        | undefined;
      Error.stackTraceLimit = 64;
      Reflect.set(nodeFs, 'lstatSync', ((selected, ...args) => {
        const result = Reflect.apply(stat, nodeFs, [selected, ...args]);
        if (
          String(selected) !== headPath ||
          stimulus ||
          intakeWorkCounters(f.db).warm.reviewQuestionHydrationHits !== before.hits + 1
        )
          return result;
        const stack = new Error('fictional recipe-hit HEAD stimulus').stack!;
        if (!stack.includes('intake-review-question-hydration.ts')) return result;
        const key = 'fictional-recipe-final-aba';
        const state = {
          before: reviewReadStamp(f.db),
          after: reviewReadStamp(f.db),
          row: undefined as unknown,
          headChanged: false,
          hits: intakeWorkCounters(f.db).warm.reviewQuestionHydrationHits,
          stack,
        };
        stimulus = state;
        if (mode === 'peer') {
          peer.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(key, 'changed');
          peer.prepare('DELETE FROM app_meta WHERE key=?').run(key);
        } else if (mode === 'rollback') {
          f.db.exec('SAVEPOINT fictional_recipe_physical');
          f.db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(key, 'changed');
          f.db.exec('ROLLBACK TO fictional_recipe_physical; RELEASE fictional_recipe_physical');
        } else {
          writeFileSync(headPath, Buffer.alloc(headBytes.length, 32));
          state.headChanged = !readFileSync(headPath).equals(headBytes);
        }
        state.after = reviewReadStamp(f.db);
        state.row = f.db.prepare('SELECT value FROM app_meta WHERE key=?').get(key);
        return result;
      }) as typeof nodeFs.lstatSync);
      syncBuiltinESMExports();
      try {
        assert.throws(() => f.state.question(record, 4096), /changed|head|authority|record|json/i);
      } finally {
        Reflect.set(nodeFs, 'lstatSync', stat);
        Error.stackTraceLimit = stackTraceLimit;
        syncBuiltinESMExports();
        writeFileSync(headPath, headBytes);
        peer.close();
      }
      assert.ok(stimulus, `${mode} must reach a real accepted HEAD stat after the recipe hit`);
      assert.equal(stimulus.hits, before.hits + 1, 'hit completed before physical stimulus');
      assert.match(stimulus.stack, /intake-review-question-hydration\.ts/);
      assert.equal(stimulus.row, undefined, 'actual committed/rolled-back rows are restored');
      assert.equal(f.db.isTransaction, false);
      if (mode === 'head')
        assert.equal(stimulus.headChanged, true, 'actual accepted HEAD bytes changed');
      else {
        assert.notEqual(stimulus.after, stimulus.before, 'actual raw witness advanced');
        assert.throws(
          () => f.state.question(record, 4096),
          /original owner changed/,
          'refusal must not rebaseline original owner',
        );
      }
      assert.deepEqual(
        readFileSync(headPath),
        headBytes,
        'physical evidence is restored after refusal',
      );
      assert.equal(
        f.sourceWork.exports,
        before.exports,
        'hit guard refusal has no native fallback',
      );
      assert.equal(f.acceptedWrites(), before.writes);
      assert.equal(f.publications(), before.publications);
      assert.equal(intakeWorkCounters(f.db).warm.collectionNodesWritten, before.nodes);
      close();
    }
  },
);

const hostEnvelope = (id: string) => ({
  format: 'health-record-v1',
  id,
  kind: 'document',
  payload: { text: 'Fictional question recipe original' },
  provenance: {
    capturedVia: 'Fictional export',
    sourceSystem: 'Fictional clinic',
    sourceRecordId: id,
    evidenceClass: 'provider_export',
    locator: 'page 1',
  },
  coverage: { status: 'complete_response', notes: [] },
  clinical: { kind: 'document', subject: 'unknown', documentTitle: id, date: '2026-01-01' },
});
function questionHostFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-question-recipe-host-'));
  const profileId = 'fictional-question-recipe-host';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const upload = (id: string, count = 1) =>
    uploadIntake(db, root, profileId, {
      filename: id + '.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(
        Array.from({ length: count }, (_, n) => JSON.stringify(hostEnvelope(id + ':' + n))).join(
          '\n',
        ),
      ),
    });
  const addQuestions = (source: ReturnType<typeof upload>, padding: number) => {
    const saved = JSON.parse(readIntakeEnvelopeText(db, { id: source.id }));
    const candidate = saved.intake.workflow.candidates[0];
    const questions = Array.from({ length: 8 }, (_, n) => ({
      id: 'question:fictional-host-recipe-' + n,
      key: 'fictional-host-recipe-' + n,
      candidateId: candidate.id,
      candidateVersionId: candidate.versions[0].id,
      prompt: 'Confirm fictional document title ' + 'x'.repeat(padding),
      locator: 'page 1',
      field: 'documentTitle',
      status: 'resolved',
      createdAt: '2026-01-01',
      unknownHeader: {
        nested: { text: 'fictional canonical header' },
        number: JSON.rawJSON('12.00'),
      },
      answers: Array.from({ length: 3 }, (_, a) => ({
        id: 'fictional-host-answer-' + n + ':' + a,
        answer: 'Fictional prior explanation',
        mapping: { documentTitle: 'Fictional original title' },
        scope: 'record',
        at: '2026-01-01',
        unknownNumber: JSON.rawJSON('13.00'),
      })),
    }));
    // The normalized JS fixture writer clones RawJSON as plain enumerable data.
    // Install exact lexical questions through the addressed native writer below.
    saved.intake.workflow.questions = [];
    writeIntakeFixtureEnvelope(db, source.id, saved);
    return questions;
  };
  const installQuestions = async (
    source: ReturnType<typeof upload>,
    questions: ReturnType<typeof addQuestions>,
  ) => {
    const view = openIntakeCollectionEnvelope(db, { id: source.id });
    const workflow = view.child(view.child(view.root(), 'intake')!, 'workflow')!;
    const operationId = randomUUID();
    const mutation = await prepareIntakeEnvelopeMutation(
      db,
      { id: source.id },
      {
        reader: view,
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: view.logical.domainVersion + 1,
        changes: questions.map((question) => ({
          op: 'append' as const,
          record: workflow,
          field: 'questions',
          jsonText: canonicalLiteral(question),
        })),
      },
    );
    const details = mutation.projectDetailsJson!({ bytes: 256 * 1024 });
    transaction(db, () => {
      selectedEnvelopeStore(db, { id: source.id }).collections.stage(mutation.prepared!);
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(details, source.id);
    });
    const selected = openIntakeCollectionEnvelope(db, { id: source.id });
    const selectedWorkflow = selected.child(
      selected.child(selected.root(), 'intake')!,
      'workflow',
    )!;
    const selectedQuestions = selected.child(selectedWorkflow, 'questions');
    assert.ok(selectedQuestions, 'accepted questions array is a checked structured child');
    assert.equal(
      [...selected.recordChunks(selectedQuestions)].join(''),
      canonicalLiteral(questions),
      'accepted native question text preserves exact literals before any recipe/cache exists',
    );
  };
  return { db, root, profileId, upload, addQuestions, installQuestions };
}

test(
  'host lexical question fixture initializes exact native questions before review preparation',
  { timeout: 60_000 },
  async (t) => {
    const f = questionHostFixture(t);
    const source = f.upload('fictional-lexical-setup');
    const questions = f.addQuestions(source, 128);
    await buildIntakeCollectionEnvelope(f.db, { id: source.id });
    assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
    assert.equal(intakeWorkCounters(f.db).warm.reviewQuestionHydrations, 0);
    await f.installQuestions(source, questions);
    assert.equal(
      reviewIssueScratchCounts(f.db).databases,
      0,
      'setup creates no owning recipe/policy scratch',
    );
    assert.equal(
      intakeWorkCounters(f.db).warm.reviewQuestionHydrations,
      0,
      'setup oracle runs before any recipe or clinical host preparation',
    );
  },
);

test(
  'host recipe providers remain fresh after more than sixteen source scopes and refuse after session disposal',
  { timeout: 360_000 },
  async (t) => {
    const f = questionHostFixture(t);
    const source = f.upload('fictional-root-recipe', 17);
    const questions = f.addQuestions(source, 2048);
    const neighbors = Array.from({ length: 17 }, (_, n) =>
      f.upload('fictional-neighbor-recipe-' + n),
    );
    const entries = validateJSONL(
      readFileSync(
        profileOriginal(
          f.root,
          String(f.db.prepare('SELECT path FROM source_files WHERE id=?').get(source.id)!.path),
          f.profileId,
        ),
      ),
    ).entries!;
    assert.equal(entries.length, 17);
    transaction(f.db, () => {
      for (let n = 0; n < neighbors.length; n++) {
        const neighbor = neighbors[n]!;
        const recordId = neighbor.id + ':line:1';
        f.db
          .prepare(
            'INSERT OR REPLACE INTO source_records(id,source_file_id,raw_json,locator_json) VALUES(?,?,?,?)',
          )
          .run(
            recordId,
            neighbor.id,
            JSON.stringify(hostEnvelope('fictional-neighbor-recipe-' + n + ':0')),
            JSON.stringify({ originalSourceFileId: neighbor.id }),
          );
        f.db
          .prepare(
            "INSERT INTO manual_batches(id,title,status,created_at,coverage_json) VALUES(?,'Import record exception','verified','2026-01-01',?)",
          )
          .run(
            'fictional-recipe-scope-' + n,
            JSON.stringify({
              recordException: {
                identityKey: clinicalSourceIdentityV1(entries[n]!, source),
                recordId,
              },
            }),
          );
      }
    });
    for (const item of [source, ...neighbors])
      await buildIntakeCollectionEnvelope(f.db, { id: item.id });
    await f.installQuestions(source, questions);
    await prepareCollectionClinicalReviewDependencies(f.db, f.root, f.profileId, source.id);
    const ready = prepareCollectionClinicalReview(f.db, f.root, f.profileId, source.id, null, {
      metadataBytes: 4096,
    });
    if (ready.status !== 'ready') throw Error('Expected complete source-LRU question review');
    t.after(() => ready.session.close());
    const context = collectionClinicalProjectionContext(ready.session);
    const consumed = [...context.consumedArtifactIds()];
    assert.equal(
      new Set(consumed).size,
      18,
      'real host sourceFor has opened more unique sources than its16-entry owner map',
    );
    assert.ok([source, ...neighbors].every((item) => consumed.includes(item.id)));
    const record = ready.session.review.records.find(
      (item) => item.candidateId === questions[0]!.candidateId,
    )!;
    assert.ok(
      record.questionsReference,
      'aggregate metadata budget must return checked question provider',
    );
    const beforeHits = intakeWorkCounters(f.db).warm.reviewQuestionHydrationHits;
    const first = reviewRecordQuestions(record).at(0)!;
    assert.ok(
      intakeWorkCounters(f.db).warm.reviewQuestionHydrationHits > beforeHits,
      'original checked scope borrows its shared recipe after real host LRU eviction',
    );
    assert.equal([...canonicalReviewValueChunks(first)].join(''), canonicalLiteral(questions[0]));
    assert.equal(first.answerHistory!.count, 3);
    const nested = Reflect.get(Reflect.get(first, 'unknownHeader'), 'nested');
    Reflect.set(nested, 'text', 'Fictional borrowed mutation');
    first.answers[0]!.mapping.documentTitle = 'Fictional borrowed latest mutation';
    const hitAfterFirst = intakeWorkCounters(f.db).warm.reviewQuestionHydrationHits;
    const second = reviewRecordQuestions(record).at(0)!;
    assert.ok(intakeWorkCounters(f.db).warm.reviewQuestionHydrationHits > hitAfterFirst);
    assert.notEqual(first, second);
    assert.notEqual(first.answers[0], second.answers[0]);
    assert.equal([...canonicalReviewValueChunks(second)].join(''), canonicalLiteral(questions[0]));
    context.assertAuthorityCurrent();
    ready.session.close();
    assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
    assert.throws(
      () => [...canonicalReviewValueChunks(second)],
      /closed/i,
      'borrowed canonical history cannot outlive actual host owner',
    );
    const beforeClosedScratch = reviewIssueScratchCounts(f.db);
    const beforeClosedHydrations = intakeWorkCounters(f.db).warm.reviewQuestionHydrations;
    const beforeClosedHits = intakeWorkCounters(f.db).warm.reviewQuestionHydrationHits;
    assert.throws(
      () => reviewRecordQuestions(record).at(0),
      (error: unknown) =>
        error instanceof Error &&
        (/closed/i.test(error.message) || error.message === 'statement has been finalized'),
      'closed host cannot open new recipe borrows',
    );
    assert.deepEqual(reviewIssueScratchCounts(f.db), beforeClosedScratch);
    assert.equal(intakeWorkCounters(f.db).warm.reviewQuestionHydrations, beforeClosedHydrations);
    assert.equal(intakeWorkCounters(f.db).warm.reviewQuestionHydrationHits, beforeClosedHits);
  },
);

test(
  'public review replacement closes old canonical providers and gives the new session detached authenticated questions',
  { timeout: 120_000 },
  async (t) => {
    const f = questionHostFixture(t);
    const source = f.upload('fictional-public-recipe');
    const questions = f.addQuestions(source, 34_000);
    assert.ok(
      Buffer.byteLength(canonicalLiteral(questions)) > 256 * 1024,
      'real public default budget must select referenced questions',
    );
    const other = f.upload('fictional-public-replacement');
    for (const item of [source, other]) await buildIntakeCollectionEnvelope(f.db, { id: item.id });
    await f.installQuestions(source, questions);
    const page = (id: string) =>
      reviewIntakeRead(f.db, f.root, f.profileId, id, null, { items: 1, bytes: 4096 });
    await page(source.id);
    const old = preparedClinicalReviewRead(f.db)!.session;
    const record = old.review.records[0]!;
    assert.ok(record.questionsReference);
    const beforeHits = intakeWorkCounters(f.db).warm.reviewQuestionHydrationHits;
    const borrowed = reviewRecordQuestions(record).at(0)!;
    assert.ok(
      intakeWorkCounters(f.db).warm.reviewQuestionHydrationHits > beforeHits,
      'retained real public session serves authenticated recipe hit',
    );
    assert.equal(
      [...canonicalReviewValueChunks(borrowed)].join(''),
      canonicalLiteral(questions[0]),
    );
    await page(other.id);
    assert.notEqual(preparedClinicalReviewRead(f.db)!.session, old);
    assert.equal(
      reviewIssueScratchCounts(f.db).databases,
      1,
      'replacement disposes old owner and retains exactly one new scratch',
    );
    assert.throws(
      () => [...canonicalReviewValueChunks(borrowed)],
      /closed/i,
      'old history provider refuses after real public cache replacement',
    );
    const beforeReplacedScratch = reviewIssueScratchCounts(f.db);
    const beforeReplacedHydrations = intakeWorkCounters(f.db).warm.reviewQuestionHydrations;
    const beforeReplacedHits = intakeWorkCounters(f.db).warm.reviewQuestionHydrationHits;
    assert.throws(
      () => reviewRecordQuestions(record).at(0),
      (error: unknown) =>
        error instanceof Error &&
        (/closed/i.test(error.message) || error.message === 'statement has been finalized'),
      'replaced host cannot open new recipe borrows',
    );
    assert.deepEqual(reviewIssueScratchCounts(f.db), beforeReplacedScratch);
    assert.equal(intakeWorkCounters(f.db).warm.reviewQuestionHydrations, beforeReplacedHydrations);
    assert.equal(intakeWorkCounters(f.db).warm.reviewQuestionHydrationHits, beforeReplacedHits);
    await page(source.id);
    const current = preparedClinicalReviewRead(f.db)!.session;
    assert.notEqual(current, old);
    const next = reviewRecordQuestions(current.review.records[0]!).at(0)!;
    assert.notEqual(next, borrowed);
    assert.notEqual(next.answers[0], borrowed.answers[0]);
    assert.equal([...canonicalReviewValueChunks(next)].join(''), canonicalLiteral(questions[0]));
  },
);

// Direct sharing is distinct from the actual host LRU-survival case above:
// a new checked scope must reconstruct its own provider from the same recipe.
test('fresh checked question scopes share authenticated recipes and reconstruct detached canonical providers without exporting values again', async (t) => {
  let cache: ReturnType<typeof createReviewQuestionHydrationCache> | undefined;
  const f = await countedQuestionHydrationFixture(
    t,
    8,
    (input) => {
      cache = createReviewQuestionHydrationCache(input.db, input.scratch);
      return openReviewQuestionState(input.db, input.source, input.view, {
        cache,
        assertCurrent: () => {
          input.view.address(input.view.root());
        },
      });
    },
    3,
    true,
  );
  const shared = cache!;
  t.after(() => shared.close());
  const originalFlow = f.view.child(f.view.child(f.view.root(), 'intake')!, 'workflow')!;
  const originalRecord = f.view.find('question', originalFlow, f.questions[0]!.id)!;
  const first = f.state.question(originalRecord, 4096);
  const nextView = openIntakeCollectionEnvelope(f.db, { id: 'fictional-hydration-source' });
  const nextFlow = nextView.child(nextView.child(nextView.root(), 'intake')!, 'workflow')!;
  const nextRecord = nextView.find('question', nextFlow, f.questions[0]!.id)!;
  let exports = 0;
  nextView.recordChunks = function* () {
    exports++;
    throw Error('recipe hit must not export native value');
  };
  nextView.fieldChunks = function* () {
    exports++;
    throw Error('recipe hit must not export native field');
  };
  const nextState = openReviewQuestionState(f.db, { id: 'fictional-hydration-source' }, nextView, {
    cache: shared,
    assertCurrent: () => {
      nextView.address(nextView.root());
    },
  });
  const before = {
    hits: intakeWorkCounters(f.db).warm.reviewQuestionHydrationHits,
    hydrations: intakeWorkCounters(f.db).warm.reviewQuestionHydrations,
  };
  const second = nextState.question(nextRecord, 4096);
  assert.equal(intakeWorkCounters(f.db).warm.reviewQuestionHydrationHits, before.hits + 1);
  assert.equal(intakeWorkCounters(f.db).warm.reviewQuestionHydrations, before.hydrations);
  assert.equal(exports, 0, 'new view/state obtains lexical recipe without native hydration');
  assert.notEqual(first, second);
  assert.notEqual(first.answers[0], second.answers[0]);
  const firstHeader = Reflect.get(first, 'unknownHeader'),
    secondHeader = Reflect.get(second, 'unknownHeader');
  assert.notEqual(firstHeader, secondHeader);
  assert.notEqual(Reflect.get(firstHeader, 'nested'), Reflect.get(secondHeader, 'nested'));
  Reflect.set(Reflect.get(firstHeader, 'nested'), 'text', 'Fictional old-scope mutation');
  first.answers[0]!.mapping.documentTitle = 'Fictional old-scope latest mutation';
  assert.equal([...nextState.canonicalRecords(second)].join(''), canonicalLiteral(f.questions[0]));
  assert.equal(second.answerHistory!.count, 3);
  assert.equal(exports, 0, 'new canonical history provider uses its checked answer bank');
  shared.close();
  assert.throws(() => [...nextState.canonicalRecords(second)], /closed/i);
});
