import assert from 'node:assert/strict';
import test from 'node:test';
import type { Intake } from '../../shared/intake.ts';
import type {
  IntakeIdentityConfirmation,
  IntakeIdentityReview,
  IntakeIdentityScope,
} from '../../shared/intake-identity.ts';
import {
  confirmIdentityWithFreshness,
  sameDisplayedIdentityReview,
} from './identity-confirmation-freshness.ts';

const scope = (patch: Partial<IntakeIdentityScope> = {}): IntakeIdentityScope => ({
  profileId: 'fictional-profile',
  intakeId: 'fictional-intake',
  intakeVersion: 4,
  groupId: 'fictional-report',
  groupVersionId: 'fictional-report-v1',
  sourceHash: 'fictional-source-hash',
  memberId: null,
  original: {
    filename: 'fictional-report.txt',
    contentUrl: '/api/sources/fictional-intake/content',
    page: null,
  },
  report: { locator: 'page 1 heading', text: 'Fictional report FIR-22' },
  subject: { locator: 'page 1 patient', text: 'Patient: Fictional Sage Rowan' },
  verificationMode: 'literal_text_match',
  evidencedIdentity: {
    fullName: 'Fictional Sage Rowan',
    birthDate: '1992-05-14',
    personFingerprint: 'fictional-person-fingerprint',
  },
  evidenceOriginalFingerprint: 'fictional-original-fingerprint',
  membership: [
    {
      candidateId: 'fictional-candidate',
      candidateVersionId: 'fictional-candidate-v1',
      occurrences: [
        {
          proposalId: 'fictional-proposal',
          recordId: 'fictional-record',
          batchId: 'fictional-batch',
          locator: 'page 1 result',
        },
      ],
    },
  ],
  questions: [
    {
      prompt: 'Does this fictional printed identity belong to you?',
      textAnchor: 'Patient: Fictional Sage Rowan',
    },
  ],
  targets: [
    {
      candidateId: 'fictional-candidate',
      candidateVersionId: 'fictional-candidate-v1',
      proposalId: 'fictional-proposal',
      recordId: 'fictional-record',
      title: 'Fictional result',
      issueId: 'fictional-generic-identity-issue',
      issueIds: ['fictional-generic-identity-issue', 'fictional-explicit-identity-issue'],
    },
  ],
  scopeToken: 'fictional-scope-token-v4',
  ...patch,
});

const review = (patch: Partial<IntakeIdentityReview> = {}): IntakeIdentityReview => ({
  status: 'confirmation_required',
  blocking: true,
  message: 'Confirm this fictional report subject.',
  scope: scope(),
  evidencedIdentity: {
    fullName: 'Fictional Sage Rowan',
    birthDate: '1992-05-14',
    personFingerprint: 'fictional-person-fingerprint',
  },
  self: { noteId: 'person-note:self', version: 3, fullName: null, birthDate: null },
  offeredSelfFields: { fullName: 'Fictional Sage Rowan', birthDate: '1992-05-14' },
  conflicts: [],
  ...patch,
});

const request = (): IntakeIdentityConfirmation => ({
  version: 4,
  operationId: '00000000-0000-4000-8000-000000000022',
  scope: scope(),
  outcome: 'this_is_me',
  attestation: 'confirmed_displayed_identity_questions',
  selfUpdate: {
    expectedVersion: 3,
    fields: { fullName: 'Fictional Sage Rowan', birthDate: '1992-05-14' },
  },
});

const conflict = (code = 'VERSION_CONFLICT') =>
  Object.assign(new Error('Fictional conflict'), { status: 409, code });
const result = { id: 'fictional-intake' } as Intake;

test('late unrelated progress retries once with the same action and a fresh complete scope', async () => {
  const displayed = review();
  const fresh = review({
    scope: scope({ intakeVersion: 5, scopeToken: 'fictional-scope-token-v5' }),
  });
  const original = request();
  const sent: IntakeIdentityConfirmation[] = [];
  const retained: (IntakeIdentityConfirmation | null)[] = [];
  const pending = confirmIdentityWithFreshness({
    displayed,
    request: original,
    send: async (value) => {
      sent.push(structuredClone(value));
      if (sent.length === 1) throw conflict();
      return result;
    },
    loadFresh: async () => fresh,
    isContextCurrent: () => true,
    retainRequest: (value) => retained.push(value && structuredClone(value)),
  });
  original.scope.subject.text = 'Caller mutated after click';
  original.selfUpdate!.fields.fullName = 'Caller mutation';
  const outcome = await pending;

  assert.deepEqual(outcome, { status: 'confirmed', result, refreshed: true });
  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.operationId, sent[1]!.operationId);
  assert.equal(sent[1]!.operationId, request().operationId);
  assert.equal(sent[0]!.scope.subject.text, 'Patient: Fictional Sage Rowan');
  assert.deepEqual(sent[1], {
    ...request(),
    version: 5,
    scope: fresh.scope,
  });
  assert.deepEqual(
    retained.map((value) => (value ? [value.version, value.scope.scopeToken] : null)),
    [[4, 'fictional-scope-token-v4'], null, [5, 'fictional-scope-token-v5'], null],
  );
});

test('any meaningful or future identity field change fails closed', async (t) => {
  const displayed = review();
  const cases: [string, IntakeIdentityReview][] = [
    ['status', review({ status: 'prior_confirmation', blocking: false })],
    ['blocking', review({ blocking: false })],
    ['evidence', review({ evidencedIdentity: { fullName: 'Fictional Different Person' } })],
    ['Self version', review({ self: { ...review().self, version: 4 } })],
    ['offered value', review({ offeredSelfFields: { birthDate: '1992-05-14' } })],
    ['membership', review({ scope: scope({ membership: [] }) })],
    [
      'candidate version',
      review({
        scope: scope({
          targets: [{ ...scope().targets[0]!, candidateVersionId: 'fictional-candidate-v2' }],
        }),
      }),
    ],
    [
      'question',
      review({
        scope: scope({ questions: [{ prompt: 'A newly displayed identity question?' }] }),
      }),
    ],
    [
      'original evidence',
      review({ scope: scope({ evidenceOriginalFingerprint: 'fictional-changed-original' }) }),
    ],
    [
      'future top-level field',
      { ...review(), futureIdentityBoundary: 'new' } as IntakeIdentityReview,
    ],
    [
      'future scope field',
      review({ scope: { ...scope(), futureScopeBoundary: 'new' } as IntakeIdentityScope }),
    ],
  ];
  for (const [name, fresh] of cases)
    await t.test(name, () => {
      assert.equal(sameDisplayedIdentityReview(displayed, fresh), false);
    });

  assert.equal(
    sameDisplayedIdentityReview(
      displayed,
      review({ scope: scope({ intakeVersion: 5, scopeToken: 'fresh-derived-token' }) }),
    ),
    true,
  );
});

test('removed selected offer stops after the fresh read without a hidden retry', async () => {
  let sends = 0;
  const outcome = await confirmIdentityWithFreshness({
    displayed: review(),
    request: request(),
    send: async () => {
      sends++;
      throw conflict();
    },
    loadFresh: async () =>
      review({
        offeredSelfFields: { birthDate: '1992-05-14' },
        scope: scope({ intakeVersion: 5, scopeToken: 'fresh-derived-token' }),
      }),
    isContextCurrent: () => true,
    retainRequest: () => {},
  });
  assert.equal(outcome.status, 'scope_changed');
  assert.equal(sends, 1);
});

test('profile or generation changes around either await prevent reads, retries, and pending-map writes', async (t) => {
  await t.test('after first send', async () => {
    let current = true;
    let freshReads = 0;
    const retained: unknown[] = [];
    const outcome = await confirmIdentityWithFreshness({
      displayed: review(),
      request: request(),
      send: async () => {
        current = false;
        throw conflict();
      },
      loadFresh: async () => {
        freshReads++;
        return review();
      },
      isContextCurrent: () => current,
      retainRequest: (value) => retained.push(value),
    });
    assert.deepEqual(outcome, { status: 'context_changed' });
    assert.equal(freshReads, 0);
    assert.equal(retained.length, 1);
  });

  await t.test('after fresh read', async () => {
    let current = true;
    let sends = 0;
    const retained: unknown[] = [];
    const outcome = await confirmIdentityWithFreshness({
      displayed: review(),
      request: request(),
      send: async () => {
        sends++;
        throw conflict();
      },
      loadFresh: async () => {
        current = false;
        return review({ scope: scope({ intakeVersion: 5, scopeToken: 'fresh' }) });
      },
      isContextCurrent: () => current,
      retainRequest: (value) => retained.push(value),
    });
    assert.deepEqual(outcome, { status: 'context_changed' });
    assert.equal(sends, 1);
    assert.deepEqual(
      retained.map((value) => (value ? 'request' : null)),
      ['request', null],
    );
  });
});

test('an uncertain second request remains exact for recovery and is never looped', async () => {
  const uncertain = new Error('Fictional connection ended without a response');
  const retained: (IntakeIdentityConfirmation | null)[] = [];
  const sent: IntakeIdentityConfirmation[] = [];
  await assert.rejects(
    () =>
      confirmIdentityWithFreshness({
        displayed: review(),
        request: request(),
        send: async (value) => {
          sent.push(structuredClone(value));
          if (sent.length === 1) throw conflict();
          throw uncertain;
        },
        loadFresh: async () =>
          review({ scope: scope({ intakeVersion: 5, scopeToken: 'fresh-derived-token' }) }),
        isContextCurrent: () => true,
        retainRequest: (value) => retained.push(value && structuredClone(value)),
      }),
    uncertain,
  );
  assert.equal(sent.length, 2);
  assert.deepEqual(retained.at(-1), sent[1]);
});

test('non-version failures preserve existing exact recovery behavior', async (t) => {
  for (const [name, failure, expectedRetained] of [
    ['already resolved', conflict('IDENTITY_ALREADY_RESOLVED'), null],
    ['definite validation failure', Object.assign(new Error('Invalid'), { status: 400 }), null],
    ['uncertain first response', new Error('Connection ended'), request()],
  ] as const)
    await t.test(name, async () => {
      let retained: IntakeIdentityConfirmation | null = null;
      let reads = 0;
      await assert.rejects(() =>
        confirmIdentityWithFreshness({
          displayed: review(),
          request: request(),
          send: async () => {
            throw failure;
          },
          loadFresh: async () => {
            reads++;
            return review();
          },
          isContextCurrent: () => true,
          retainRequest: (value) => {
            retained = value;
          },
        }),
      );
      assert.equal(reads, 0);
      assert.deepEqual(retained, expectedRetained);
    });
});

const nativeReview = (version = 4): IntakeIdentityReview => {
  const { membership: _membership, targets: _targets, questions: _questions, ...header } = scope();
  const token = String(version).repeat(64);
  return review({
    scope: null,
    evidenceCommitment: { format: 'health-intake-identity-evidence-v1', sha256: 'a'.repeat(64) },
    scopeReference: {
      ...header,
      intakeVersion: version,
      scopeToken: token,
      format: 'health-intake-identity-scope-v2',
      collection: {
        snapshotId: 'identity:' + token,
        membership: 1000,
        targets: 500,
        assignmentTargets: 500,
        questions: 40,
        competingSubjects: 2,
      },
    },
  });
};

test('native version-specific references retry exactly once after equal complete evidence proof', async () => {
  const displayed = nativeReview(),
    fresh = nativeReview(5),
    sent: IntakeIdentityConfirmation[] = [];
  assert.notEqual(
    displayed.scopeReference!.collection.snapshotId,
    fresh.scopeReference!.collection.snapshotId,
  );
  assert.equal(sameDisplayedIdentityReview(displayed, fresh), true);
  const input = { ...request(), scope: displayed.scopeReference! };
  const outcome = await confirmIdentityWithFreshness({
    displayed,
    request: input,
    send: async (value) => {
      sent.push(structuredClone(value));
      if (sent.length === 1) throw conflict();
      return result;
    },
    loadFresh: async () => fresh,
    isContextCurrent: () => true,
    retainRequest: () => {},
  });
  assert.equal(outcome.status, 'confirmed');
  assert.deepEqual(sent, [input, { ...input, version: 5, scope: fresh.scopeReference! }]);
});

test('native proof and reference validation refuse missing/malformed/changed hidden evidence', async (t) => {
  const shown = nativeReview(),
    fresh = nativeReview(5);
  const cases: [string, IntakeIdentityReview][] = [
    [
      'missing collection',
      {
        ...fresh,
        scopeReference: { ...fresh.scopeReference!, collection: undefined },
      } as unknown as IntakeIdentityReview,
    ],
    [
      'null collection',
      {
        ...fresh,
        scopeReference: { ...fresh.scopeReference!, collection: null },
      } as unknown as IntakeIdentityReview,
    ],
    ['missing proof', { ...fresh, evidenceCommitment: undefined }],
    [
      'malformed hash',
      { ...fresh, evidenceCommitment: { ...fresh.evidenceCommitment!, sha256: 'not-a-digest' } },
    ],
    [
      'unsupported proof',
      {
        ...fresh,
        evidenceCommitment: { ...fresh.evidenceCommitment!, format: 'future' },
      } as unknown as IntakeIdentityReview,
    ],
    [
      'new proof field',
      {
        ...fresh,
        evidenceCommitment: { ...fresh.evidenceCommitment!, future: true },
      } as IntakeIdentityReview,
    ],
    [
      'changed same-count evidence',
      { ...fresh, evidenceCommitment: { ...fresh.evidenceCommitment!, sha256: 'b'.repeat(64) } },
    ],
    [
      'unbound snapshot',
      {
        ...fresh,
        scopeReference: {
          ...fresh.scopeReference!,
          collection: {
            ...fresh.scopeReference!.collection,
            snapshotId: shown.scopeReference!.collection.snapshotId,
          },
        },
      },
    ],
    [
      'malformed token',
      { ...fresh, scopeReference: { ...fresh.scopeReference!, scopeToken: 'invalid' } },
    ],
    [
      'changed collection count',
      {
        ...fresh,
        scopeReference: {
          ...fresh.scopeReference!,
          collection: { ...fresh.scopeReference!.collection, membership: 999 },
        },
      },
    ],
    [
      'changed header',
      {
        ...fresh,
        scopeReference: {
          ...fresh.scopeReference!,
          subject: { ...fresh.scopeReference!.subject, text: 'A changed subject' },
        },
      },
    ],
    ['changed Self', { ...fresh, self: { ...fresh.self, version: fresh.self.version + 1 } }],
    ['changed view', { ...fresh, message: 'A changed decision' }],
    ['future view field', { ...fresh, future: 'new' } as IntakeIdentityReview],
  ];
  for (const [name, value] of cases)
    await t.test(name, async () => {
      let sends = 0;
      const outcome = await confirmIdentityWithFreshness({
        displayed: shown,
        request: { ...request(), scope: shown.scopeReference! },
        send: async () => {
          sends++;
          throw conflict();
        },
        loadFresh: async () => value,
        isContextCurrent: () => true,
        retainRequest: () => {},
      });
      assert.equal(outcome.status, 'scope_changed');
      assert.equal(sends, 1);
    });
  assert.equal(
    sameDisplayedIdentityReview({ ...shown, evidenceCommitment: undefined }, fresh),
    false,
  );
  assert.equal(sameDisplayedIdentityReview(shown, review()), false);
});

test('paged warnings retain exact snapshot binding and complete warning commitment', () => {
  const warningReview = (version: number) => {
    const value = nativeReview(version);
    return {
      ...value,
      warningsReference: {
        format: 'health-intake-identity-warnings-v2' as const,
        scopeToken: value.scopeReference!.scopeToken,
        snapshotId: 'identity-warnings:' + value.scopeReference!.scopeToken + ':' + 'd'.repeat(64),
        sha256: 'd'.repeat(64),
        count: 101,
      },
    };
  };
  const shown = warningReview(4),
    fresh = warningReview(5);
  assert.equal(
    sameDisplayedIdentityReview(shown, {
      ...fresh,
      warningsReference: {
        format: 'health-intake-identity-warnings-v1',
        scopeToken: fresh.scopeReference!.scopeToken,
        snapshotId: fresh.scopeReference!.collection.snapshotId,
        count: 101,
      },
    }),
    false,
  );
  assert.equal(sameDisplayedIdentityReview(shown, fresh), true);
  assert.equal(
    sameDisplayedIdentityReview(shown, {
      ...fresh,
      warningsReference: {
        ...fresh.warningsReference,
        snapshotId: shown.warningsReference.snapshotId,
      },
    }),
    false,
  );
  assert.equal(
    sameDisplayedIdentityReview(shown, {
      ...fresh,
      evidenceCommitment: { ...fresh.evidenceCommitment!, sha256: 'c'.repeat(64) },
    }),
    false,
  );
  assert.equal(
    sameDisplayedIdentityReview(shown, {
      ...fresh,
      warningsReference: { ...fresh.warningsReference, count: 102 },
    }),
    false,
  );
});

test('a second native VERSION_CONFLICT cannot initiate another read or retry', async () => {
  let sends = 0,
    reads = 0;
  await assert.rejects(
    () =>
      confirmIdentityWithFreshness({
        displayed: nativeReview(),
        request: { ...request(), scope: nativeReview().scopeReference! },
        send: async () => {
          sends++;
          throw conflict();
        },
        loadFresh: async () => {
          reads++;
          return nativeReview(5);
        },
        isContextCurrent: () => true,
        retainRequest: () => {},
      }),
    conflict(),
  );
  assert.equal(sends, 2);
  assert.equal(reads, 1);
});
