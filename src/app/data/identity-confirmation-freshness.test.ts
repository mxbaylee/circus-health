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
