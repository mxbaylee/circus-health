import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Intake, IntakeExtractionPlan, IntakeExtractionUnit } from '../../shared/intake.ts';
import {
  ensureIntakeAttribution,
  attributionReadScope,
  recordAttributionRead,
  acknowledgeAttributionRead,
  startAttributionRequest,
  finishAttributionRequest,
  exportImportAttribution,
} from '../intake-attribution.ts';

const source = (id = 'fictional-intake'): Intake =>
  ({
    id,
    sha256: `fictional-hash-${id}`,
    parentSourceFileId: null,
    proposals: [],
    workflow: {
      format: 'health-intake-workflow-v1',
      plans: [],
      candidates: [],
      questions: [],
      decisions: [],
    },
  }) as unknown as Intake;
const checkpoint = (intake = source(), turns = 0) => ({
  intakeId: intake.id,
  sourceHash: intake.sha256,
  profileId: 'fictional-profile',
  turns,
  attribution: undefined as ReturnType<typeof ensureIntakeAttribution> | undefined,
});
const page = (n: number, sourceFileId = 'fictional-intake') => ({
  sourceFileId,
  memberId: null,
  page: n,
});
const unit = (
  id: string,
  pages: number[],
  extra: Partial<IntakeExtractionUnit> = {},
): IntakeExtractionUnit => ({
  id,
  pages,
  kind: 'pdf',
  locator: 'Private fictional locator',
  status: 'pending',
  attempts: [],
  ...extra,
});
const plan = (
  id: string,
  units: IntakeExtractionUnit[],
  extra: Partial<IntakeExtractionPlan> = {},
): IntakeExtractionPlan =>
  ({
    id,
    status: 'active',
    units,
    batches: [],
    ...extra,
  }) as unknown as IntakeExtractionPlan;

test('request totals count once while page shares conserve tokens, including retries and unknown usage', () => {
  const cp = checkpoint();
  const a = recordAttributionRead(cp, 'a', page(1)).scopeKey!;
  const b = recordAttributionRead(cp, 'b', page(2)).scopeKey!;
  const first = startAttributionRequest(cp, [a, a, b]);
  finishAttributionRequest(cp, first, {
    failed: false,
    usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 },
  });
  const failed = startAttributionRequest(cp, [a]);
  finishAttributionRequest(cp, failed, { failed: true });
  const retry = startAttributionRequest(cp, [a]);
  finishAttributionRequest(cp, retry, {
    failed: false,
    usage: { inputTokens: 60, outputTokens: 10, cachedInputTokens: null },
  });
  const unscoped = startAttributionRequest(cp, []);
  finishAttributionRequest(cp, unscoped, {
    failed: false,
    usage: { inputTokens: 11, outputTokens: 3, cachedInputTokens: 0 },
  });
  const m = cp.attribution!;
  assert.equal(m.totals.attempts, 4);
  assert.equal(m.totals.inputTokens, 171);
  assert.equal(m.scopes[a].inputTokens, 110);
  assert.equal(m.scopes[b].inputTokens, 50);
  assert.equal(m.unallocated.inputTokens, 11);
  assert.equal(m.totals.unknownUsageAttempts, 1);
  assert.equal(m.totals.unknownCacheAttempts, 2);
  assert.equal(m.scopes[a].failedAttempts, 1);
  assert.equal(m.scopes[b].attempts, 1);
});

test('host reads and model acknowledgments survive journal JSON/restart without inventing historical counts', () => {
  const cp = checkpoint();
  const first = recordAttributionRead(cp, 'same-window', page(1));
  assert.equal(first.priorReads, 0);
  const restored = JSON.parse(JSON.stringify(cp)) as typeof cp;
  restored.turns++;
  assert.equal(recordAttributionRead(restored, 'same-window', page(1)).priorReads, 1);
  acknowledgeAttributionRead(restored, first.scopeKey!);
  assert.equal(restored.attribution!.scopes[first.scopeKey!].hostReads, 2);
  assert.equal(restored.attribution!.scopes[first.scopeKey!].acknowledgedReads, 1);
  assert.equal(restored.attribution!.historicalReadsUnknown, false);
  const legacy = checkpoint(source(), 5);
  assert.equal(ensureIntakeAttribution(legacy).historicalReadsUnknown, true);
  assert.equal(legacy.attribution!.totals.attempts, 0);
});

test('source projection omits inventory/context and uses actual returned PDF page/member/child metadata', () => {
  assert.equal(
    attributionReadScope(
      'health_intake_plan',
      { action: 'read', id: 'source' },
      { original: { text: 'context' } },
    ),
    null,
  );
  assert.equal(
    attributionReadScope(
      'health_intake_package',
      { action: 'inventory', id: 'source' },
      { members: [] },
    ),
    null,
  );
  assert.deepEqual(
    attributionReadScope(
      'health_intake_package',
      { action: 'read_member', id: 'package', memberId: 'member' },
      {
        pdfContent: 'data:fake',
        metadata: { sourceFileId: 'child', original: { page: 7, text: 'fictional text' } },
      },
    ),
    { sourceFileId: 'child', memberId: 'member', page: 7 },
  );
});

test('overlapping active and replaced plans retain separate coverage and nonadditive batch yield', () => {
  const intake = source();
  intake.proposals = [{ id: 'proposal' }] as Intake['proposals'];
  intake.workflow!.plans = [
    plan(
      'old',
      [
        unit('u-old', [1, 2], {
          status: 'completed',
          coverage: { unitId: 'u-old', kind: 'extracted', notes: 'private' },
        }),
      ],
      { status: 'superseded' },
    ),
    plan(
      'new',
      [
        unit('u1', [1, 2], {
          status: 'partial',
          coverage: { unitId: 'u1', kind: 'inspected', notes: 'private' },
        }),
        unit('u2', [2, 3]),
      ],
      {
        batches: [
          {
            id: 'batch',
            proposalId: 'proposal',
            at: 'fictional',
            coverage: [
              { unitId: 'u1', kind: 'inspected', notes: '' },
              { unitId: 'u2', kind: 'inspected', notes: '' },
            ],
          },
        ],
      },
    ),
  ];
  intake.workflow!.candidates = [
    {
      id: 'candidate',
      envelopeId: 'envelope',
      sourceRecordId: null,
      sourceSystem: null,
      versions: [
        {
          id: 'version',
          status: 'pending',
          createdAt: 'fictional',
          occurrences: [
            {
              proposalId: 'proposal',
              recordId: 'record',
              batchId: 'batch',
              locator: 'page 2 fictional private',
            },
          ],
        },
      ],
    },
  ];
  const row = exportImportAttribution({ intakes: [intake], chats: [] }).imports[0];
  assert.equal(row.proposedOccurrences, 1);
  assert.equal(row.acceptedRecords, 0);
  assert.equal(row.pages.length, 3);
  const overlap = row.pages.find((row) => row.page === 2)!;
  assert.equal(overlap.activeUnits, 2);
  assert.equal(overlap.supersededUnits, 1);
  assert.deepEqual(overlap.activeCoverage, { inspected: 1, pending: 1 });
  assert.equal(overlap.proposedOccurrences, 1);
  assert.equal(overlap.sharedProposedOccurrences, 1);
  assert.equal(
    row.pages.reduce((sum, page) => sum + page.proposedOccurrences, 0),
    3,
  );
  assert.match(
    exportImportAttribution({ intakes: [intake], chats: [] }).yieldAttribution,
    /nonadditive/,
  );
});

test('acceptance receipts on another coordinator join exact occurrences after supersession and rebuild', () => {
  const intake = source('child');
  intake.parentSourceFileId = 'package';
  const parent = source('package'),
    coordinator = source('coordinator');
  intake.proposals = [{ id: 'p' }] as Intake['proposals'];
  intake.workflow!.plans = [
    plan('plan', [unit('u', [4])], {
      batches: [
        {
          id: 'b',
          proposalId: 'p',
          at: '',
          coverage: [{ unitId: 'u', kind: 'extracted', notes: '' }],
        },
      ],
    }),
  ];
  intake.workflow!.candidates = [
    {
      id: 'c',
      envelopeId: '',
      sourceRecordId: null,
      sourceSystem: null,
      versions: [
        {
          id: 'v1',
          status: 'superseded',
          createdAt: '',
          occurrences: [
            { proposalId: 'p', recordId: 'r', batchId: 'b', locator: 'private' },
            { proposalId: 'p', recordId: 'not-accepted', batchId: 'b', locator: 'private' },
          ],
        },
        {
          id: 'v2',
          status: 'pending',
          createdAt: '',
          occurrences: [{ proposalId: 'p', recordId: 'r', batchId: 'b', locator: 'private' }],
        },
      ],
    },
  ];
  coordinator.workflow!.reportAcceptances = [
    {
      fingerprint: '',
      receipt: {
        operationId: 'op',
        status: 'accepted',
        atomic: true,
        at: '',
        selectedCount: 1,
        acceptedCount: 1,
        receipts: [
          {
            intakeId: 'child',
            proposalId: 'p',
            intakeVersionBefore: 1,
            intakeVersionAfter: 2,
            reviewToken: 'private-token',
            records: [{ candidateId: 'c', candidateVersionId: 'v1', recordId: 'r' } as never],
          },
        ],
      },
    },
  ];
  intake.importHistory = [
    {
      acceptedProposalId: 'p',
      reviewToken: null,
      at: '',
      clinical: {
        added: 1,
        duplicates: 0,
        retainedOnly: 0,
        versions: 0,
        records: [{ recordId: 'r' } as never],
      },
    },
  ];
  const cp = checkpoint(parent);
  recordAttributionRead(cp, 'member', { sourceFileId: 'child', memberId: 'member', page: 4 });
  recordAttributionRead(cp, 'direct', page(4, 'child'));
  const input = {
    intakes: [parent, intake, coordinator],
    chats: [{ conversionCheckpoint: cp }],
    salt: new Uint8Array(32),
  };
  const report = exportImportAttribution(input);
  assert.deepEqual(
    exportImportAttribution(JSON.parse(JSON.stringify({ ...input, salt: undefined }))).imports.map(
      (r) => r.acceptedRecords,
    ),
    [1, 0],
  );
  const root = report.imports[0];
  assert.equal(
    root.importId,
    createHash('sha256').update(input.salt).update('package').digest('hex').slice(0, 20),
  );
  assert.equal(root.acceptedRecords, 1);
  assert.equal(root.unscopedAcceptedRecords, 0);
  assert.equal(root.pages.length, 2);
  const direct = root.pages.find((row) => row.memberId === null)!;
  assert.equal(direct.hostReads, 1);
  assert.equal(direct.acceptedRecords, 1);
  assert.equal(direct.acceptedVersions, 1, 'the later pending version never inherits acceptance');
  assert.equal(direct.pendingVersions, 1);
  assert.equal(direct.supersededVersions, 1);
  assert.equal(direct.proposedOccurrences, 3);
  const serialized = JSON.stringify(report);
  for (const secret of [
    'child',
    'member',
    'private',
    'coordinator',
    'fictional-hash',
    'review-token',
  ])
    assert.ok(!serialized.includes(`"${secret}"`));
});

test('unlinked legacy acceptance remains accepted with unknown page attribution', () => {
  const intake = source();
  intake.importHistory = [
    {
      acceptedProposalId: null,
      reviewToken: null,
      at: '',
      clinical: {
        added: 1,
        duplicates: 0,
        retainedOnly: 0,
        versions: 0,
        records: [{ recordId: 'legacy' } as never],
      },
    },
  ];
  const row = exportImportAttribution({ intakes: [intake], chats: [] }).imports[0];
  assert.equal(row.acceptedRecords, 1);
  assert.equal(row.unscopedAcceptedRecords, 1);
  assert.equal(row.historicalReadsUnknown, true);
  assert.equal(row.requestTotals.usageComplete, false);
  assert.equal(row.requestTotals.trackedUsageComplete, true);
});

test('bounded metadata flags truncation without changing request total conservation', () => {
  const cp = checkpoint();
  for (let i = 1; i <= 2050; i++) recordAttributionRead(cp, `window-${i}`, page(i));
  assert.equal(Object.keys(cp.attribution!.scopes).length, 2048);
  assert.equal(cp.attribution!.truncated, true);
  assert.equal(cp.attribution!.untrackedReadScopes, 2);
  const scopes = startAttributionRequest(cp, ['missing']);
  finishAttributionRequest(cp, scopes, {
    failed: false,
    usage: { inputTokens: 17, outputTokens: 2 },
  });
  assert.equal(cp.attribution!.totals.inputTokens, 17);
  assert.equal(cp.attribution!.unallocated.inputTokens, 17);
});

test('member-only plans join observed retained child identities without pretending source-wide yield is per-page', () => {
  const parent = source('package'),
    child = source('child');
  child.parentSourceFileId = parent.id;
  parent.proposals = [{ id: 'p' }] as Intake['proposals'];
  parent.workflow!.plans = [
    plan(
      'plan',
      [
        unit('u', [], {
          kind: 'package_member',
          memberId: 'member',
          coverage: { unitId: 'u', kind: 'extracted', notes: '' },
        }),
      ],
      {
        batches: [
          {
            id: 'b',
            proposalId: 'p',
            at: '',
            coverage: [{ unitId: 'u', kind: 'extracted', notes: '' }],
          },
        ],
      },
    ),
  ];
  parent.workflow!.candidates = [
    {
      id: 'c',
      envelopeId: '',
      sourceRecordId: null,
      sourceSystem: null,
      versions: [
        {
          id: 'v',
          status: 'pending',
          createdAt: '',
          occurrences: [{ proposalId: 'p', recordId: 'r', batchId: 'b', locator: 'private' }],
        },
      ],
    },
  ];
  const cp = checkpoint(parent);
  recordAttributionRead(cp, 'member-page', { sourceFileId: child.id, memberId: 'member', page: 4 });
  const report = exportImportAttribution({
    intakes: [parent, child],
    chats: [{ conversionCheckpoint: cp }],
  }).imports[0];
  const actualPage = report.pages.find((row) => row.page === 4)!;
  assert.equal(report.pages.length, 2);
  assert.deepEqual(actualPage.sourceWideCoverage, { extracted: 1 });
  assert.equal(actualPage.proposedOccurrences, 0);
  assert.equal(actualPage.sourceWideProposedOccurrences, 1);
  assert.equal(actualPage.yieldPageUnknown, true);
  assert.equal(actualPage.sourceId, report.pages.find((row) => row.page === null)!.sourceId);
});

test('byte-reused ZIP children keep member occurrences distinct and a direct read remains unassigned', () => {
  const parent = source('package'),
    child = source('shared-child');
  child.parentSourceFileId = parent.id;
  const cp = checkpoint(parent);
  recordAttributionRead(cp, 'member-a', { sourceFileId: child.id, memberId: 'a', page: 1 });
  recordAttributionRead(cp, 'member-b', { sourceFileId: child.id, memberId: 'b', page: 1 });
  recordAttributionRead(cp, 'direct', page(1, child.id));
  const row = exportImportAttribution({
    intakes: [parent, child],
    chats: [{ conversionCheckpoint: cp }],
  }).imports[0];
  assert.equal(row.pages.length, 3);
  assert.equal(new Set(row.pages.map((page) => page.memberId)).size, 3);
  assert.ok(row.pages.every((page) => page.hostReads === 1));
  assert.ok(row.pages.every((page) => page.yieldPageUnknown));
});

test('untracked windows never claim a first read when the bounded history is full', () => {
  const cp = checkpoint();
  ensureIntakeAttribution(cp).windows = Object.fromEntries(
    Array.from({ length: 4096 }, (_, i) => [`window-${i}`, 1]),
  );
  assert.equal(recordAttributionRead(cp, 'dropped', page(1)).priorReads, null);
  assert.equal(recordAttributionRead(cp, 'dropped', page(1)).priorReads, null);
  assert.equal(cp.attribution!.untrackedReadWindows, 2);
});

test('unlinked yield, missing selected metadata and legacy history never turn into known zero per-page yield', () => {
  const intake = source(),
    cp = checkpoint(intake, 3);
  recordAttributionRead(cp, 'page', page(1));
  intake.workflow!.candidates = [
    {
      id: 'c',
      envelopeId: '',
      sourceRecordId: null,
      sourceSystem: null,
      versions: [
        {
          id: 'v',
          status: 'pending',
          createdAt: '',
          occurrences: [
            { proposalId: null, recordId: 'r', batchId: null, locator: 'unknown private location' },
          ],
        },
      ],
    },
  ];
  const input = { intakes: [intake], chats: [{ conversionCheckpoint: cp }] };
  const row = exportImportAttribution(input).imports[0];
  assert.equal(row.pages[0].proposedOccurrences, 0);
  assert.equal(row.pages[0].yieldPageUnknown, true);
  assert.equal(row.pages[0].requestExposure.usageComplete, false);
  for (const incomplete of [{ selectionIncomplete: true }, { historyIncomplete: true }]) {
    const report = exportImportAttribution({ ...input, ...incomplete });
    assert.equal(report.exportBounds.partial, true);
    assert.equal(report.imports[0].truncated, true);
    assert.equal(report.imports[0].pages[0].yieldPageUnknown, true);
  }
});

test('export caps aggregate scope rows and metadata work, marking every omitted join partial', () => {
  const intakes = Array.from({ length: 3 }, (_, n) => {
    const intake = source(`source-${n}`);
    intake.workflow!.plans = [
      plan(
        'plan',
        Array.from({ length: 2048 }, (_, i) => unit(`u-${i}`, [i + 1])),
      ),
    ];
    return intake;
  });
  const scopeReport = exportImportAttribution({ intakes, chats: [] });
  assert.equal(scopeReport.exportBounds.retainedScopes, 4096);
  assert.equal(
    scopeReport.imports.reduce((sum, row) => sum + row.pages.length, 0),
    4096,
  );
  assert.equal(scopeReport.exportBounds.partial, true);
  assert.ok(Buffer.byteLength(JSON.stringify(scopeReport)) < 5 * 1024 * 1024);
  const intake = source();
  intake.workflow!.plans = [plan('p', [unit('u', [1])])];
  intake.workflow!.candidates = [
    {
      id: 'c',
      envelopeId: '',
      sourceRecordId: null,
      sourceSystem: null,
      versions: [
        {
          id: 'v',
          status: 'pending',
          createdAt: '',
          occurrences: Array.from({ length: 50001 }, (_, i) => ({
            proposalId: null,
            recordId: `r-${i}`,
            batchId: null,
            locator: 'fictional',
          })),
        },
      ],
    },
  ];
  const workReport = exportImportAttribution({ intakes: [intake], chats: [] });
  assert.equal(workReport.exportBounds.metadataWork, 50000);
  assert.ok(workReport.exportBounds.omittedMetadataItems > 0);
  assert.equal(workReport.imports[0].pages[0].yieldPageUnknown, true);
});

test('page text counts survive checkpoint recovery and stay unknown when unavailable', () => {
  const intake = source(),
    cp = checkpoint(intake);
  recordAttributionRead(cp, 'page1', page(1), 0, 17.5);
  recordAttributionRead(cp, 'page2', page(2), 1432);
  recordAttributionRead(cp, 'page3', page(3));
  recordAttributionRead(cp, 'page4', page(4), -1);
  const recovered = JSON.parse(JSON.stringify(cp));
  const result = exportImportAttribution({
    intakes: [intake],
    chats: [{ conversionCheckpoint: recovered }],
  });
  const rows = result.imports[0].pages;
  assert.equal(rows.find((row) => row.page === 1)?.textLayerCharacters, 0);
  assert.equal(rows.find((row) => row.page === 1)?.timedHostReads, 1);
  assert.equal(rows.find((row) => row.page === 1)?.hostReadTotalMs, 17.5);
  assert.equal(rows.find((row) => row.page === 1)?.hostReadTimingComplete, true);
  assert.equal(rows.find((row) => row.page === 2)?.hostReadTotalMs, null);
  assert.equal(rows.find((row) => row.page === 2)?.hostReadTimingComplete, false);
  assert.equal(rows.find((row) => row.page === 1)?.textLayerCountStatus, 'observed');
  assert.equal(rows.find((row) => row.page === 2)?.textLayerCharacters, 1432);
  for (const n of [3, 4]) {
    assert.equal(rows.find((row) => row.page === n)?.textLayerCharacters, null);
    assert.equal(rows.find((row) => row.page === n)?.textLayerCountStatus, 'unknown');
  }
  assert.match(result.unknowns, /does not mean an empty/);
});

test('conflicting text counts are not averaged or silently presented as exact', () => {
  const intake = source(),
    cp = checkpoint(intake),
    second = checkpoint(intake);
  recordAttributionRead(cp, 'page1', page(1), 0);
  recordAttributionRead(cp, 'page1-offset', page(1), 5);
  recordAttributionRead(cp, 'page2', page(2), 40);
  recordAttributionRead(second, 'page2', page(2), 41);
  const result = exportImportAttribution({
    intakes: [intake],
    chats: [cp, second].map((conversionCheckpoint) => ({ conversionCheckpoint })),
  });
  assert.ok(
    result.imports[0].pages.every(
      (row) => row.textLayerCharacters === null && row.textLayerCountStatus === 'conflicting',
    ),
  );
});
