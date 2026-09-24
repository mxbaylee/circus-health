import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  IntakeReportQueueBlock,
  IntakeReportQueueDetail,
  IntakeReportQueueGroup,
  IntakeReportSourceResult,
  IntakeReportSourceUpdate,
} from '../../shared/intake.ts';
import { saveReportSourceWithFreshness } from './source-label-freshness.ts';

const fictionalGroup = (patch: Partial<IntakeReportQueueGroup> = {}): IntakeReportQueueGroup => ({
  groupId: 'fictional-report',
  groupVersionId: 'fictional-group-v1',
  intakeId: 'fictional-intake',
  intakeVersion: 4,
  discoveryOrder: 1,
  title: 'Fictional optical report',
  source: null,
  sourceScope: null,
  sourceLabelScope: {
    contextId: 'fictional-group-v1',
    evidence: {
      label: 'Report original',
      locator: 'fictional page 1',
      contentUrl: '/api/sources/fictional-intake/content',
    },
  },
  date: '2026-09-01',
  basis: 'report_anchor',
  original: {
    filename: 'fictional-optical.pdf',
    contentUrl: '/api/sources/fictional-intake/content',
    parentSourceFileId: null,
  },
  member: null,
  anchor: { locator: 'fictional page 1', text: 'Fictional vision center' },
  counts: {
    pending: 2,
    deferred: 0,
    blocked: 0,
    accepted: 0,
    keptOriginal: 0,
    superseded: 0,
    questions: 0,
  },
  peopleCounts: { pending: 0, later: 0, excluded: 0, saved: 0 },
  ...patch,
});

const fictionalBlock = (): IntakeReportQueueBlock =>
  ({
    intakeId: 'fictional-intake',
    proposalId: 'fictional-proposal',
    intakeVersion: 4,
    reviewToken: 'fictional-review-token',
    proposalContentUrl: '/api/sources/fictional-proposal/content',
    records: [
      {
        id: 'fictional-record-1',
        candidateId: 'fictional-candidate-1',
        candidateVersionId: 'fictional-candidate-version-1',
        queueState: 'pending',
      },
      {
        id: 'fictional-record-2',
        candidateId: 'fictional-candidate-2',
        candidateVersionId: 'fictional-candidate-version-2',
        queueState: 'pending',
      },
    ],
  }) as IntakeReportQueueBlock;

const request: IntakeReportSourceUpdate = {
  version: 4,
  operationId: '00000000-0000-4000-8000-000000000001',
  groupId: 'fictional-report',
  groupVersionId: 'fictional-group-v1',
  contextId: 'fictional-group-v1',
  source: 'Fictional Vision Center',
  basis: 'manual_report_label',
};

const result = {} as IntakeReportSourceResult;
const stale = Object.assign(new Error('This intake changed'), {
  status: 409,
  code: 'VERSION_CONFLICT',
});

function detail(
  group: IntakeReportQueueGroup,
  blocks = [fictionalBlock()],
): IntakeReportQueueDetail {
  return { view: 'all', group, blocks, totalRecords: 2, nextCursor: null };
}

test('late background progress retries once with a fresh intake version when the displayed source scope is exact', async () => {
  const sent: IntakeReportSourceUpdate[] = [];
  let retained: IntakeReportSourceUpdate | null = null;
  const outcome = await saveReportSourceWithFreshness({
    displayed: { group: fictionalGroup(), blocks: [fictionalBlock()] },
    request,
    send: async (value) => {
      sent.push(value);
      if (sent.length === 1) throw stale;
      return result;
    },
    loadFresh: async () =>
      detail(
        fictionalGroup({
          intakeVersion: 5,
          counts: { ...fictionalGroup().counts, blocked: 1, questions: 1 },
        }),
        [{ ...fictionalBlock(), intakeVersion: 5, reviewToken: 'new-global-revision-token' }],
      ),
    isProfileCurrent: () => true,
    retainRequest: (value) => {
      retained = value;
    },
  });
  assert.deepEqual(outcome, { status: 'saved', result, refreshed: true });
  assert.deepEqual(
    sent.map(({ version, operationId, source }) => ({ version, operationId, source })),
    [
      { version: 4, operationId: request.operationId, source: request.source },
      { version: 5, operationId: request.operationId, source: request.source },
    ],
  );
  assert.equal(retained, null);
});

test('changed group, members, or source evidence requires review and preserves the draft', async (t) => {
  const cases: [string, IntakeReportQueueDetail][] = [
    ['group version', detail(fictionalGroup({ groupVersionId: 'fictional-group-v2' }))],
    [
      'people membership',
      detail(
        fictionalGroup({
          intakeVersion: 5,
          peopleCounts: { pending: 1, later: 0, excluded: 0, saved: 0 },
        }),
      ),
    ],
    [
      'member',
      detail(fictionalGroup({ intakeVersion: 5 }), [
        {
          ...fictionalBlock(),
          records: fictionalBlock().records.slice(0, 1),
        },
      ]),
    ],
    [
      'evidence',
      detail(
        fictionalGroup({
          intakeVersion: 5,
          sourceLabelScope: {
            contextId: 'fictional-group-v1',
            evidence: { label: 'Report original', locator: 'fictional page 2' },
          },
        }),
      ),
    ],
  ];
  for (const [name, fresh] of cases)
    await t.test(name, async () => {
      let writes = 0;
      let retained: IntakeReportSourceUpdate | null = null;
      const outcome = await saveReportSourceWithFreshness({
        displayed: { group: fictionalGroup(), blocks: [fictionalBlock()] },
        request,
        send: async () => {
          writes++;
          throw stale;
        },
        loadFresh: async () => fresh,
        isProfileCurrent: () => true,
        retainRequest: (value) => {
          retained = value;
        },
      });
      assert.equal(outcome.status, 'scope_changed');
      assert.match(outcome.message, /Your label is still entered/);
      assert.equal(writes, 1);
      assert.equal(retained, null);
      assert.equal(request.source, 'Fictional Vision Center');
    });
});

test('an uncertain response is not retried and retains the exact operation request', async () => {
  const uncertain = new Error('Fictional connection ended before a response');
  let writes = 0;
  let reads = 0;
  let retained: IntakeReportSourceUpdate | null = null;
  await assert.rejects(
    saveReportSourceWithFreshness({
      displayed: { group: fictionalGroup(), blocks: [fictionalBlock()] },
      request,
      send: async () => {
        writes++;
        throw uncertain;
      },
      loadFresh: async () => {
        reads++;
        return detail(fictionalGroup({ intakeVersion: 5 }));
      },
      isProfileCurrent: () => true,
      retainRequest: (value) => {
        retained = value;
      },
    }),
    uncertain,
  );
  assert.equal(writes, 1);
  assert.equal(reads, 0);
  assert.equal(retained, request);
});

test('a profile switch after the stale response prevents refresh and retry', async () => {
  let writes = 0;
  let reads = 0;
  const outcome = await saveReportSourceWithFreshness({
    displayed: { group: fictionalGroup(), blocks: [fictionalBlock()] },
    request,
    send: async () => {
      writes++;
      throw stale;
    },
    loadFresh: async () => {
      reads++;
      return detail(fictionalGroup({ intakeVersion: 5 }));
    },
    isProfileCurrent: () => false,
    retainRequest: () => {},
  });
  assert.equal(outcome.status, 'profile_changed');
  assert.equal(writes, 1);
  assert.equal(reads, 0);
});
