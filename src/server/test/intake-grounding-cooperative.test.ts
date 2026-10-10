import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { canonicalLiteral } from '../intake-format.ts';
import { collectionWorkflowReviewScope } from '../intake-review-collection.ts';
import type { ReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import { retainedEnvelopeReader } from './helpers/retained-envelope-reader.ts';
import { finishClinicalReviewWork, runClinicalReviewWork } from '../clinical-review-work.ts';
import {
  retainSelectedIdentityGrounding,
  retainSelectedIdentityGroundingWork,
  selectedIdentityReviewGroundingLookups,
  clearIdentityGrounding,
  identityGroundingGeneration,
} from '../intake-identity-grounding.ts';
import { iterateCompetingIdentityBoundaries } from '../intake-identity-policy.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';
import type { IntakeReportGroup } from '../../shared/intake.ts';
import type { WorkflowReviewGroup } from '../intake-workflow.ts';

function fixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE fictional_authority_changes(value INTEGER)');
  const group = (id: string, subject = 'Patient: Fictional Iris Meadow'): IntakeReportGroup => ({
    id,
    basis: 'report_anchor',
    sourceFileId: 'fictional-original',
    sourceHash: 'fictional-hash',
    sourceSystem: 'Fictional clinic',
    memberId: null,
    report: {
      key: id,
      title: 'Fictional report',
      anchor: { locator: 'page 1', text: 'Fictional report' },
      subject: { locator: 'page 1', text: subject },
    },
    versions: [
      { id: 'z-old', createdAt: '2026-01-01', title: 'Old', members: [], contributionId: 'old' },
      {
        id: 'a-current',
        createdAt: '2026-01-02',
        title: 'Current',
        members: [],
        contributionId: 'new',
      },
    ],
  });
  const selected = group('selected');
  // Unknown retained current-version evidence is part of the raw hash recipe.
  Object.assign(selected.versions.at(-1)!, {
    raw: Array.from({ length: 160 }, (_, n) => ({
      n,
      literal: 'Independently fictional retained evidence '.repeat(96),
      nil: null,
      false: false,
    })),
  });
  const groups = [
    selected,
    ...Array.from({ length: 97 }, (_, n) => group('unrelated-' + n)),
    group('duplicate', 'Patient: Fictional Rowan Fern'),
    group('duplicate', 'Patient: Fictional Sage Lake'),
    // Duplicate public IDs retain first-occurrence selection, not latest duplicate selection.
    group('selected', 'Patient: Fictional Different Header'),
  ];
  const view = retainedEnvelopeReader({ intake: { workflow: { reportGroups: groups } } });
  const scope = collectionWorkflowReviewScope({
    view,
    catalog: new Proxy({} as ReportSnapshotCatalog, {
      get() {
        throw Error('Grounding raw-boundary review unexpectedly opened a report snapshot');
      },
    }),
    metadataBytes: 64 * 1024,
    packageEvidence: false,
    activeReceipt: () => true,
    originalFingerprint: () => 'fictional-original-fingerprint',
    reportSource: () => undefined,
  });
  const groupRecord = scope.groupRecords()[Symbol.iterator]().next().value!;
  const header = scope.groupHeader(groupRecord);
  const current = scope.currentGroupVersion(groupRecord)!;
  const currentAddress = view.address(current);
  const boundary = scope.groundingBoundary(
    'fictional-profile',
    'fictional-original',
    'fictional-hash',
  );
  // Independent oracle of the unchanged native recipe: canonical header, raw full
  // selected current version, then all competing occurrences in retained order.
  const digest = createHash('sha256')
    .update(
      canonicalLiteral([
        'selected-intake-identity-v1',
        boundary.profileId,
        boundary.intakeId,
        boundary.sourceHash,
        boundary.originalFingerprint(header),
        header,
      ]),
    )
    .update(JSON.stringify(selected.versions.at(-1)));
  for (const other of groups) {
    if (!iterateCompetingIdentityBoundaries(header, [other]).next().done)
      digest.update(canonicalLiteral([other.id, other.report?.subject]));
  }
  const expected = digest.digest('hex');
  assert.equal(boundary.boundaryFingerprint(header), expected);
  const question = {
    prompt: 'Confirm the fictional printed name',
    textAnchor: 'Fictional Iris Meadow',
  };
  const receipt = {
    operationId: 'fictional-confirmation',
    scope: { scopeToken: 'fictional-scope', profileId: 'fictional-profile' },
  };
  retainSelectedIdentityGrounding(
    db,
    boundary,
    header,
    [{ issue: question, receipt }],
    true,
    [question],
    {
      dates: ['1990-03-08'],
      unreadable: false,
    },
  );
  const trace = { chunks: 0, headers: 0, active: 0, closed: 0 };
  const originalChunks = view.recordChunks.bind(view),
    originalChild = view.child.bind(view);
  view.recordChunks = function* (record) {
    if (view.address(record) !== currentAddress) {
      yield* originalChunks(record);
      return;
    }
    trace.active++;
    try {
      for (const chunk of originalChunks(record)) {
        trace.chunks++;
        yield chunk;
      }
    } finally {
      trace.active--;
      trace.closed++;
    }
  };
  view.child = (record, field) => {
    if (record.kind === 'reportGroup' && field === 'id') trace.headers++;
    return originalChild(record, field);
  };
  const callbacks = () => selectedIdentityReviewGroundingLookups(db, boundary);
  const native = (lookups = callbacks()) =>
    scope.clinicalSourceScope({
      profileId: boundary.profileId,
      hasParent: false,
      hasMember: () => false,
      childBoundary: null,
      subjectGrounded: lookups.subjectGrounded,
      questionGrounded: lookups.grounded,
      subjectGroundedWork: lookups.subjectGroundedWork,
      questionGroundedWork: lookups.groundedWork,
    });
  t.after(() => {
    scope.close?.();
    clearIdentityGrounding(db);
    db.close();
  });
  return {
    db,
    scope,
    header,
    boundary,
    trace,
    callbacks,
    native,
    expected,
    groups,
    question,
    receipt,
  };
}

test('retained native grounding proof hashes the exact full current version and inspects noncompeting history cooperatively', async (t) => {
  const f = fixture(t);
  const lookups = f.callbacks();
  let chunkTurn = false,
    historyTurn = false,
    turns = 0;
  const hostDb = new DatabaseSync(':memory:');
  t.after(() => hostDb.close());
  const native = f.native(lookups);
  const value = await runClinicalReviewWork(native.subjectGroundedWork!(f.header), {
    capture() {
      const chunks = f.trace.chunks,
        headers = f.trace.headers;
      // A real unrelated host query executes on the scheduled event-loop turn,
      // strictly while the callback has only partially traversed its boundary.
      setImmediate(() => {
        assert.equal(hostDb.prepare('SELECT 23 AS value').get()!.value, 23);
        if (f.trace.active && chunks > 0) chunkTurn = true;
        if (headers > 0 && headers < f.groups.length) historyTurn = true;
        turns++;
      });
      const generation = identityGroundingGeneration(f.db);
      return () => assert.equal(identityGroundingGeneration(f.db), generation);
    },
  });
  assert.equal(value, true);
  assert.ok(chunkTurn, 'host query ran inside current-version hashing');
  assert.ok(historyTurn, 'host query ran inside mostly nonmatching historical traversal');
  assert.ok(turns > 2);
  assert.equal(f.trace.headers, f.groups.length);
  assert.equal(f.trace.active, 0);
  assert.ok(f.trace.chunks > 16);
  const prior = { ...f.trace };
  assert.deepEqual(finishClinicalReviewWork(lookups.originalBirthDateEvidenceWork(f.header)), {
    dates: ['1990-03-08'],
    unreadable: false,
  });
  assert.deepEqual(f.trace, prior, 'same snapshot/group memo avoids repeating the complete hash');
  assert.equal(
    finishClinicalReviewWork(lookups.nameQuestionGroundedWork(f.header, f.question)),
    true,
  );
  assert.equal(
    finishClinicalReviewWork(native.questionGroundedWork!(f.header, f.question, f.receipt)),
    true,
  );
  assert.equal(
    finishClinicalReviewWork(
      native.questionGroundedWork!(f.header, f.question, {
        ...f.receipt,
        operationId: 'different-operation',
      }),
    ),
    false,
  );
  assert.deepEqual(
    f.trace,
    prior,
    'question and subject callbacks share only the completed exact snapshot',
  );
  assert.equal(finishClinicalReviewWork(f.boundary.boundaryFingerprintWork!(f.header)), f.expected);
});

test('native grounding cancellation and authority drift close hashing and never memoize incomplete proof', async (t) => {
  const f = fixture(t);
  for (const stage of ['hash', 'history'] as const) {
    for (const failure of ['cancel', 'authority', 'grounding'] as const) {
      const lookups = f.callbacks(),
        abort = new AbortController();
      f.trace.chunks = 0;
      f.trace.headers = 0;
      let interrupted = false;
      await assert.rejects(
        runClinicalReviewWork(f.native(lookups).subjectGroundedWork!(f.header), {
          signal: abort.signal,
          capture() {
            const captured = reviewReadStamp(f.db);
            if (!interrupted && (stage === 'hash' ? f.trace.active > 0 : f.trace.headers > 0)) {
              interrupted = true;
              setImmediate(() => {
                if (failure === 'cancel') abort.abort(Error('fictional cancellation'));
                else if (failure === 'grounding') clearIdentityGrounding(f.db);
                else f.db.prepare('INSERT INTO fictional_authority_changes VALUES(?)').run(1);
              });
            }
            const generation = identityGroundingGeneration(f.db);
            return () => {
              if (
                reviewReadStamp(f.db) !== captured ||
                identityGroundingGeneration(f.db) !== generation
              )
                throw Error('fictional authority drift');
            };
          },
        }),
        failure === 'cancel'
          ? /operation was aborted|fictional cancellation/
          : /fictional authority drift/,
      );
      assert.equal(interrupted, true);
      assert.equal(f.trace.active, 0, 'owned raw iterator closes on interruption');
      if (failure === 'grounding') {
        assert.throws(() => lookups.subjectGrounded(f.header), /snapshot changed/);
        retainSelectedIdentityGrounding(f.db, f.boundary, f.header, [], true, [], {
          dates: ['1990-03-08'],
          unreadable: false,
        });
      } else {
        f.trace.chunks = 0;
        assert.equal(lookups.subjectGrounded(f.header), true);
        assert.ok(f.trace.chunks > 16, 'interrupted computation was not published to the memo');
      }
    }
  }
});

test('grounding work preserves stale-boundary DOB facts, explicit negative proofs, and absent-original facts', (t) => {
  const f = fixture(t);
  const altered = {
    ...f.boundary,
    *boundaryFingerprintWork() {
      yield;
      return 'changed-current-version';
    },
  };
  const stale = selectedIdentityReviewGroundingLookups(f.db, altered);
  assert.equal(finishClinicalReviewWork(stale.subjectGroundedWork(f.header)), false);
  assert.deepEqual(finishClinicalReviewWork(stale.originalBirthDateEvidenceWork(f.header)), {
    dates: ['1990-03-08'],
    unreadable: false,
  });
  retainSelectedIdentityGrounding(f.db, f.boundary, f.header, [], false, [], {
    dates: [],
    unreadable: true,
  });
  const negative = f.callbacks();
  assert.equal(finishClinicalReviewWork(negative.subjectGroundedWork(f.header)), false);
  assert.deepEqual(finishClinicalReviewWork(negative.originalBirthDateEvidenceWork(f.header)), {
    dates: [],
    unreadable: true,
  });
  const absent: WorkflowReviewGroup = { ...f.header, id: 'no-proof' };
  assert.equal(finishClinicalReviewWork(negative.originalBirthDateEvidenceWork(absent)), undefined);
});

const proofScratch = () =>
  readdirSync(tmpdir())
    .filter((name) => name.startsWith('intake-grounding-proofs-'))
    .sort();
const databaseChanges = (db: DatabaseSync) =>
  db.prepare('SELECT total_changes() AS changes').get()!.changes;

test('cooperative native publication preserves exact legacy semantics and closes unpublished or abandoned proof scratch', async (t) => {
  const f = fixture(t);
  const names = Array.from({ length: 97 }, (_, n) => ({
    prompt: 'Fictional name ' + n,
    textAnchor: 'Fictional Iris Meadow',
  }));
  const before = proofScratch();
  const changes = databaseChanges(f.db);
  const priorLegacyRows = Number(
    f.db.prepare('SELECT count(*) AS count FROM intake_selected_identity_proofs').get()!.count,
  );
  let inspected = 0,
    closed = false,
    hostProgress = false;
  function* input() {
    try {
      for (const name of names) {
        inspected++;
        yield name;
      }
    } finally {
      closed = true;
    }
  }
  await runClinicalReviewWork(
    retainSelectedIdentityGroundingWork(f.db, f.boundary, f.header, [], true, input(), {
      dates: ['1990-03-08'],
      unreadable: false,
    }),
    {
      capture() {
        assert.equal(
          databaseChanges(f.db),
          changes,
          'proof staging never mutates main SQL across a yield',
        );
        const generation = identityGroundingGeneration(f.db);
        if (inspected > 0 && inspected < names.length)
          setImmediate(() => {
            hostProgress = true;
          });
        return () => {
          assert.equal(databaseChanges(f.db), changes);
          assert.equal(identityGroundingGeneration(f.db), generation);
        };
      },
    },
  );
  assert.ok(closed && hostProgress, 'proof staging yields within the complete input iterator');
  assert.equal(
    databaseChanges(f.db),
    Number(changes) + priorLegacyRows,
    'atomic final publication only removes the superseded legacy proof rows',
  );
  assert.equal(proofScratch().length, before.length + 1);
  const generation = identityGroundingGeneration(f.db);
  const lookup = f.callbacks();
  assert.equal(lookup.nameQuestionGrounded(f.header, names[96]!), true);
  // Legacy publication of the same deduplicated proof set is identical even
  // though native storage now lives in owned scratch instead of a temp table.
  retainSelectedIdentityGrounding(
    f.db,
    f.boundary,
    f.header,
    [],
    true,
    [...names].reverse().concat(names[0]!),
    { dates: ['1990-03-08'], unreadable: false },
  );
  assert.equal(identityGroundingGeneration(f.db), generation);
  assert.equal(proofScratch().length, before.length + 1);
  finishClinicalReviewWork(
    retainSelectedIdentityGroundingWork(f.db, f.boundary, f.header, [], true, names, {
      dates: ['1990-03-08'],
      unreadable: false,
    }),
  );
  assert.equal(identityGroundingGeneration(f.db), generation);
  assert.equal(
    proofScratch().length,
    before.length + 1,
    'identical native staging closes its duplicate owner',
  );

  for (const failure of ['cancel', 'iterator', 'drift'] as const) {
    inspected = 0;
    closed = false;
    const abort = new AbortController();
    let interrupted = false;
    function* failingInput() {
      try {
        for (const name of names) {
          inspected++;
          if (failure === 'iterator' && inspected === 40)
            throw Error('fictional proof input failed');
          yield { ...name, prompt: name.prompt + ' changed' };
        }
      } finally {
        closed = true;
      }
    }
    await assert.rejects(
      runClinicalReviewWork(
        retainSelectedIdentityGroundingWork(f.db, f.boundary, f.header, [], false, failingInput()),
        {
          signal: abort.signal,
          capture() {
            const captured = reviewReadStamp(f.db);
            if (!interrupted && inspected > 0 && failure !== 'iterator') {
              interrupted = true;
              setImmediate(() => {
                if (failure === 'cancel') abort.abort(Error('fictional proof cancelled'));
                else f.db.prepare('INSERT INTO fictional_authority_changes VALUES(?)').run(1);
              });
            }
            return () => {
              if (captured !== reviewReadStamp(f.db))
                throw Error('fictional proof authority drift');
            };
          },
        },
      ),
      failure === 'cancel'
        ? /operation was aborted|fictional proof cancelled/
        : /fictional proof (input failed|authority drift)/,
    );
    assert.equal(closed, true);
    assert.equal(proofScratch().length, before.length + 1, 'failed unpublished staging is removed');
    assert.equal(
      identityGroundingGeneration(f.db),
      generation,
      'prior complete proof remains selected',
    );
    assert.equal(lookup.subjectGrounded(f.header), true);
  }
  clearIdentityGrounding(f.db);
  assert.deepEqual(proofScratch(), before);
});

test('native proof scratch is evicted atomically and disposed on database close', () => {
  const db = new DatabaseSync(':memory:');
  const before = proofScratch();
  const boundary = {
    profileId: 'fictional',
    intakeId: 'fictional',
    sourceHash: 'fictional',
    originalFingerprint: (group: WorkflowReviewGroup) => group.id,
    boundaryFingerprint: (group: WorkflowReviewGroup) => group.id,
  };
  const group = (id: string): WorkflowReviewGroup => ({
    id,
    basis: 'report_anchor',
    sourceFileId: 'fictional',
    sourceHash: 'fictional',
    memberId: null,
    report: null,
  });
  try {
    for (let n = 0; n < 257; n++)
      finishClinicalReviewWork(
        retainSelectedIdentityGroundingWork(db, boundary, group(String(n)), [], true),
      );
    assert.equal(
      proofScratch().length,
      before.length + 256,
      'scope eviction closes its old scratch owner',
    );
    const lookup = selectedIdentityReviewGroundingLookups(db, boundary);
    assert.equal(lookup.subjectGrounded(group('0')), false);
    assert.equal(lookup.subjectGrounded(group('256')), true);
    db.close();
    assert.deepEqual(proofScratch(), before);
    assert.throws(() => lookup.subjectGrounded(group('256')), /snapshot changed/);
  } finally {
    if (db.isOpen) db.close();
  }
});
