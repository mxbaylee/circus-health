/** Controlled public-response oracle tests. These make no provider requests and
 * do not qualify real reading, extraction, UI behavior or a deployment. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVaultApp } from '../server/vault-app.ts';
import { getIntakeRead, proposeConversionRead } from '../server/intake.ts';
import { publishIntakeSourceText } from '../server/intake-source-text.ts';
import type { IntakeBatch } from '../shared/intake-batch.ts';
import type {
  IntakeReportAcceptanceBlock,
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceResult,
} from '../shared/intake.ts';
import type { IntakeSourceText, SourceTextReviewRequest } from '../shared/intake-source-text.ts';
import {
  answersForQualification,
  qualificationBirthDate,
  qualificationPerson,
  qualificationSourceSystem,
  writeProviderQualificationPdf,
} from './provider-qualification-fixture.ts';
import {
  collectQualificationFeed,
  type QualificationFeedBlock,
} from './qualification-intake-read.ts';
import type { IntakeRead } from '../shared/intake-summary.ts';
import { createContinuingApprovalQualifier } from './provider-qualification-continuing-approval.ts';
import { ProxyModelBridge, proxyConfig } from '../server/proxy-model-bridge.ts';
import { fictionalModel } from '../server/test/fictional-model.ts';
import { setTimeout as delay } from 'node:timers/promises';

const profileId = 'fictional-profile';
const originalId = 'fictional-original';
const sha = 'a'.repeat(64);
const prefix = `/api/profiles/${profileId}`;
const answers = answersForQualification('continuing');
function batch(): IntakeBatch {
  return {
    id: 'fictional-batch',
    profileId,
    operationId: 'fictional-batch-operation',
    automaticRun: true,
    status: 'running',
    reason: null,
    currentIndex: 0,
    createdAt: '',
    updatedAt: '',
    items: [
      {
        intakeId: originalId,
        sourceHash: sha,
        filename: 'fictional.pdf',
        mimeType: 'application/pdf',
        status: 'running',
        reason: null,
        chatId: 'fictional-chat',
        proposalIds: ['fictional-proposal'],
        startedAt: '',
        endedAt: null,
        reading: {
          status: 'running',
          reason: null,
          turns: 8,
          modelRequests: 8,
          readyRecords: 2,
          remainingUnits: 1,
          pendingReadWindows: 1,
          coverage: 'reading_progress_only',
        },
      },
    ],
  };
}
function fixture() {
  const currentBatch = batch();
  const blocks: QualificationFeedBlock[] = [
    {
      intakeId: originalId,
      proposalId: 'fictional-proposal',
      intakeVersion: 1,
      reviewToken: 'fictional-review-original',
      groupId: 'fictional-group',
      records: answers.slice(0, 2).map((answer) => ({
        id: answer.marker,
        kind: 'observation',
        mapping: { ...answer.fields },
        candidateId: 'candidate-' + answer.marker,
        candidateVersionId: 'version-' + answer.marker,
        selectionReviewToken: 'proof-' + answer.marker,
        selectable: true,
        queueState: 'pending',
        issues: [],
        questions: [],
        reportGroups: [{ groupId: 'fictional-group' }],
        identityReview: {
          status: 'evidenced_match',
          blocking: false,
          conflicts: [],
          evidencedIdentity: { fullName: qualificationPerson, birthDate: qualificationBirthDate },
        },
        evidence: [
          {
            label: 'Original source',
            locator: 'page 1',
            contentUrl: `/api/sources/${originalId}/content`,
          },
        ],
      })) as unknown as QualificationFeedBlock['records'],
    },
  ];
  let source = {
    status: 'available',
    summary: { pages: 3 },
    revision: {
      id: 'fictional-revision-0',
      parentRevisionId: null,
      profileId,
      intakeId: originalId,
      sourceHash: sha,
      pages: [1, 2, 3].map((page) => ({ page, disposition: 'extracted', inspected: false })),
      spans: [
        {
          id: 'fictional-span',
          text: 'Fictional source text',
          region: { page: 1 },
          provenance: 'native',
        },
      ],
      relations: [],
      review: null,
    },
  } as unknown as Extract<IntakeSourceText, { status: 'available' }>;
  const artifacts = new Map<string, unknown>();
  const requests: Array<{ path: string; input: unknown }> = [];
  const receipts = new Map<string, IntakeReportAcceptanceResult>();
  const controls = {
    inactiveChat: false,
    endAfterPublication: false,
    keepRelevantProof: false,
    invalidateUnrelated: false,
    mutatePlan: false,
    wrongAcceptedPerson: false,
    incorrectProjection: false,
    wrongHash: false,
    corruptReplay: false,
  };
  let sourceEdits = 0;
  let acceptedCount = 0;
  const request = async <T>(path: string, input?: unknown): Promise<T> => {
    requests.push({ path, input: structuredClone(input) });
    let output: unknown;
    if (path.endsWith('/intake-batches/fictional-batch')) output = currentBatch;
    else if (path.endsWith('/assistant/chats/fictional-chat'))
      output = {
        id: 'fictional-chat',
        context: { intakeId: originalId },
        backend: 'litellm',
        model: 'fictional-model',
        status: controls.inactiveChat ? 'idle' : 'running',
        updatedAt: '',
        reading: currentBatch.items[0]!.reading,
      };
    else if (path.endsWith('/source-text')) {
      if (input) {
        const edit = input as SourceTextReviewRequest;
        sourceEdits++;
        assert.equal(edit.action, 'clarification');
        assert.deepEqual(edit.scope, { page: sourceEdits === 1 ? 3 : 1 });
        assert.equal(edit.expectedRevisionId, source.revision!.id);
        source = {
          ...source,
          revision: {
            ...source.revision!,
            id: 'fictional-revision-' + sourceEdits,
            parentRevisionId: source.revision!.id,
            review: { ...edit, actor: 'profile-owner', at: '' },
          },
        };
        if (sourceEdits === 1 && controls.invalidateUnrelated)
          blocks[0]!.records[0]!.selectionReviewToken = 'unrelated-changed-proof';
        if (sourceEdits === 2 && !controls.keepRelevantProof)
          blocks[0]!.records[1]!.selectionReviewToken = 'relevant-changed-proof';
        if (controls.endAfterPublication) controls.inactiveChat = true;
      }
      output = source;
    } else if (path.endsWith('/report-acceptance-plan')) {
      const plan = structuredClone(input as { blocks: IntakeReportAcceptanceBlock[] });
      if (controls.mutatePlan)
        plan.blocks[0]!.selections[0]!.selectionReviewToken = 'fresh-manufactured-proof';
      output = { planId: 'fictional-plan', chunks: [plan.blocks], unsent: [] };
    } else if (path.endsWith('/report-acceptance')) {
      const accepted = input as IntakeReportAcceptanceRequest;
      const previous = receipts.get(accepted.operationId);
      if (previous) output = { ...previous, replayed: true };
      else {
        const block = accepted.blocks[0]!,
          selection = block.selections[0]!;
        assert.equal(
          selection.selectionReviewToken,
          'proof-' + selection.recordId,
          'must retain original proof',
        );
        assert.deepEqual(
          selection.mapping,
          answers.find((answer) => answer.marker === selection.recordId)!.fields,
        );
        const saved = selection.recordId === answers[0]!.marker;
        if (saved) acceptedCount++;
        else assert.equal(blocks[0]!.records[1]!.selectionReviewToken, 'relevant-changed-proof');
        const recordReceipt = {
          intakeId: originalId,
          proposalId: block.proposalId,
          reviewToken: block.reviewToken,
          intakeVersionBefore: 1,
          intakeVersionAfter: 2,
          records: saved ? [{ kind: 'observation', entityId: 'accepted-A', outcome: 'added' }] : [],
        };
        output = {
          replayed: false,
          durability: {},
          receipt: {
            version: 1,
            operationId: accepted.operationId,
            status: 'completed',
            atomic: false,
            at: '',
            selectedCount: 1,
            acceptedCount: saved ? 1 : 0,
            receipts: saved ? [recordReceipt] : [],
            items: [
              {
                ...selection,
                intakeId: originalId,
                proposalId: block.proposalId,
                personId: 'patient',
                operationId: accepted.operationId,
                status: saved ? 'saved' : 'needs_review',
                ...(saved ? { receipt: recordReceipt } : {}),
              },
            ],
          },
        };
        receipts.set(accepted.operationId, structuredClone(output) as IntakeReportAcceptanceResult);
      }
      if (controls.corruptReplay && previous)
        (output as IntakeReportAcceptanceResult).receipt.acceptedCount = 999;
    } else if (path.includes('/report-acceptance/')) output = receipts.get(path.split('/').at(-1)!);
    else if (path.endsWith('/overview'))
      output = { counts: { observations: acceptedCount, medications: 0, procedures: 0 } };
    else if (path.endsWith('/tests/accepted-A')) {
      const answer = answers[0]!;
      output = {
        id: 'accepted-A',
        personId: controls.wrongAcceptedPerson ? 'foreign-person' : 'patient',
        label: answer.marker,
        date: answer.fields.date,
        datePrecision: 'day',
        valueText: answer.fields.valueText,
        value: controls.incorrectProjection ? 999 : 0.01,
        comparator: '<',
        unit: answer.fields.unit,
        reference: { text: answer.fields.referenceText },
        status: answer.fields.status,
        extra: { import: { acceptedMapping: answer.fields } },
        evidence: [{ locator: { locator: 'page 1', originalSourceFileId: originalId } }],
      };
    } else assert.fail('Unrecognized controlled qualification request: ' + path);
    return structuredClone(output) as T;
  };
  const qualifier = createContinuingApprovalQualifier({
    prefix,
    profileId,
    originalId,
    expectedSha256: sha,
    ownedProfiles: new Set([profileId]),
    signal: new AbortController().signal,
    request,
    collectFeed: async () => ({ blocks: structuredClone(blocks) }),
    originalHash: async () => (controls.wrongHash ? 'b'.repeat(64) : sha),
    retain: (name, value) => {
      artifacts.set(name, structuredClone(value));
    },
  });
  return {
    qualifier,
    currentBatch,
    blocks,
    controls,
    artifacts,
    requests,
    receipts,
    sourceEdits: () => sourceEdits,
    acceptedCount: () => acceptedCount,
  };
}

test('controlled qualifier preserves original approvals, attributes two real-source API publications and checks exact replay', async () => {
  const f = fixture();
  await f.qualifier.onSnapshot(f.currentBatch);
  const result = f.qualifier.result();
  assert.equal(result.status, 'passed');
  assert.equal(result.automaticCaptureAfterApproval, false);
  assert.equal(result.intermediateReviewObserved, true);
  assert.equal(result.sourcePublications, 2);
  assert.equal(result.acceptanceOperations, 2);
  assert.equal(result.savedRecords, 1);
  assert.equal(result.rejectedRecords, 1);
  assert.equal(f.acceptedCount(), 1);
  assert.equal(f.receipts.size, 2);
  assert.equal(f.sourceEdits(), 2);
  assert.ok(result.evidence.includes('continuing-original-approvals.json'));
  assert.ok(result.evidence.includes('continuing-after-relevant-publication.json'));
  assert.ok(f.requests.every(({ path }) => !/convert|resume|proposals|\/lock|\/unlock/.test(path)));
  const count = f.requests.length;
  f.currentBatch.status = 'stopped';
  f.currentBatch.automaticRun = false;
  await f.qualifier.onSnapshot(f.currentBatch);
  assert.equal(f.requests.length, count, 'never rerun a completed scenario');
  result.evidence.length = 0;
  assert.ok(f.qualifier.result().evidence.length, 'result snapshots are detached');
});

test('completed reading and stale batch pending counts cannot manufacture a live intermediate review', async () => {
  for (const terminal of [false, true]) {
    const f = fixture();
    if (terminal) f.currentBatch.status = 'complete';
    else f.controls.inactiveChat = true;
    await f.qualifier.onSnapshot(f.currentBatch);
    assert.equal(f.qualifier.result().status, 'inconclusive');
    assert.equal(f.qualifier.result().intermediateReviewObserved, false);
    assert.equal(f.sourceEdits(), 0);
    assert.equal(f.acceptedCount(), 0);
  }
});

test('reading that finishes during publication yields inconclusive with no clinical write and no automatic retry', async () => {
  const f = fixture();
  f.controls.endAfterPublication = true;
  await f.qualifier.onSnapshot(f.currentBatch);
  assert.equal(f.qualifier.result().status, 'inconclusive');
  assert.equal(f.sourceEdits(), 1);
  assert.equal(f.acceptedCount(), 0);
  f.controls.inactiveChat = false;
  await f.qualifier.onSnapshot(f.currentBatch);
  assert.equal(f.sourceEdits(), 1);
});

test('polls may wait for actual provider rows but never synthesize a missing intermediate proposal', async () => {
  const f = fixture();
  const b = f.blocks[0]!.records.pop()!;
  await f.qualifier.onSnapshot(f.currentBatch);
  assert.equal(f.qualifier.result().status, 'inconclusive');
  assert.equal(f.sourceEdits(), 0);
  f.blocks[0]!.records.push(b);
  await f.qualifier.onSnapshot(f.currentBatch);
  assert.equal(f.qualifier.result().passed, true);
});

for (const [control, error, saved] of [
  ['wrongHash', /original changed/, 0],
  ['invalidateUnrelated', /unrelated publication changed/, 0],
  ['keepRelevantProof', /did not invalidate/, 1],
  ['mutatePlan', /planning must preserve/, 0],
  ['wrongAcceptedPerson', /wrong person/, 1],
  ['incorrectProjection', /independent literal/, 1],
  ['corruptReplay', /operation-ID reconciliation/, 1],
] as const)
  test(`controlled oracle rejects ${control} without retrying its scenario`, async () => {
    const f = fixture();
    f.controls[control] = true;
    await assert.rejects(f.qualifier.onSnapshot(f.currentBatch), error);
    assert.equal(f.qualifier.result().status, 'failed');
    assert.equal(f.qualifier.result().passed, false);
    assert.equal(f.acceptedCount(), saved);
    const count = f.requests.length;
    await f.qualifier.onSnapshot(f.currentBatch);
    assert.equal(f.requests.length, count);
  });

test('oracle refuses clinical or provenance changes before explicit acceptance', async () => {
  const f = fixture();
  f.blocks[0]!.records[0]!.mapping.unit = 'fictional-wrong-unit';
  await assert.rejects(f.qualifier.onSnapshot(f.currentBatch), /independent literal/);
  assert.equal(f.sourceEdits(), 0);
  assert.equal(f.acceptedCount(), 0);
});

test('foreign profile, original, chat and changed batch operation never qualify', async () => {
  for (const mutate of [
    (value: IntakeBatch) => {
      value.profileId = 'foreign';
    },
    (value: IntakeBatch) => {
      value.items[0]!.sourceHash = 'b'.repeat(64);
    },
    (value: IntakeBatch) => {
      value.items[0]!.intakeId = 'foreign';
    },
  ]) {
    const f = fixture();
    mutate(f.currentBatch);
    await assert.rejects(f.qualifier.onSnapshot(f.currentBatch), /owned original/);
    assert.equal(f.sourceEdits(), 0);
  }
  const f = fixture();
  f.currentBatch.items[0]!.reading = null;
  await f.qualifier.onSnapshot(f.currentBatch);
  f.currentBatch.operationId = 'replaced-operation';
  await assert.rejects(f.qualifier.onSnapshot(f.currentBatch), /operation identity changed/);
});

test(
  'controlled reading adapter exercises real encrypted HTTP source review, canonical Self, planned save and stale refusal',
  { timeout: 120_000 },
  async (t) => {
    // Reading/proposals are explicitly fabricated for this host contract test.
    // Only the opt-in, independently attested live runner can establish real reading.
    const directory = mkdtempSync(join(tmpdir(), 'fictional-continuing-host-'));
    mkdirSync(join(directory, 'data'));
    const app = createVaultApp({
      dataDirectory: join(directory, 'data'),
      runtimeDirectory: join(directory, 'runtime'),
      assistantOptions: { availability: async () => ({ available: false }) },
    });
    t.after(() => {
      app.close();
      rmSync(directory, { recursive: true, force: true });
    });
    await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const origin = 'http://localhost:5173',
      base = `http://127.0.0.1:${address.port}`;
    let cookie = '';
    async function http<T>(path: string, input?: unknown, bytes?: Buffer): Promise<T> {
      const response = await fetch(base + path, {
        method: input !== undefined || bytes ? 'POST' : 'GET',
        headers: {
          Origin: origin,
          Cookie: cookie,
          Connection: 'close',
          'Content-Type': bytes ? 'application/pdf' : 'application/json',
          ...(bytes ? { 'X-Filename': 'fictional-continuing.pdf' } : {}),
        },
        ...(bytes
          ? { body: Uint8Array.from(bytes).buffer }
          : input !== undefined
            ? { body: JSON.stringify(input) }
            : {}),
        signal: t.signal,
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0]!;
      const value = (await response.json()) as { data: T; error?: unknown };
      assert.equal(response.ok, true, `${path}: ${JSON.stringify(value.error)}`);
      return value.data;
    }
    const setup = await http<{ setupId: string; recoveryKit: unknown }>('/api/profile-setups', {
      name: 'Fictional continuing review',
      fullName: qualificationPerson,
      birthDate: qualificationBirthDate,
      placebo: false,
    });
    const profile = await http<{ id: string }>(`/api/profile-setups/${setup.setupId}/verify`, {
      recovery: setup.recoveryKit,
      acknowledged: true,
    });
    const selectedPrefix = `/api/profiles/${profile.id}`;
    const path = join(directory, 'fictional.pdf');
    const pdf = writeProviderQualificationPdf(path, 'continuing');
    const uploaded = await http<IntakeRead>(
      selectedPrefix + '/intakes',
      undefined,
      readFileSync(path),
    );
    const batches = await http<IntakeBatch[]>(selectedPrefix + '/intake-batches');
    const owned = batches.find((candidate) =>
      candidate.items.some((item) => item.intakeId === uploaded.id),
    )!;
    await http(selectedPrefix + `/intake-batches/${owned.id}/stop`, {});
    const opened = app.manager.opened.get(profile.id)!;
    const before = await http<IntakeSourceText>(
      selectedPrefix + `/intakes/${uploaded.id}/source-text`,
    );
    publishIntakeSourceText(opened.db, opened.root, profile.id, uploaded.id, {
      operationId: randomUUID(),
      expectedRevisionId: before.revision?.id ?? null,
      sourceHash: pdf.sha256,
      evidence: {
        adapter: { name: 'controlled fictional host fixture', version: '1' },
        pages: [1, 2, 3].map((page) => ({ page, disposition: 'extracted', inspected: false })),
        spans: [1, 2, 3].map((page) => ({
          id: `fictional-page-${page}`,
          text: `FICTIONAL CLINICAL QUALIFICATION REPORT\nPatient: ${qualificationPerson}\nPatient DOB: ${qualificationBirthDate}\n${page === 1 ? 'FXP1R01 <0.01 mg/dL. FXP1R02 1.17 U/L.' : 'Fictional administrative or later page.'}`,
          region: { page },
          provenance: 'native',
        })),
        relations: [],
        issues: [],
      },
    });
    await proposeConversionRead(
      opened.db,
      opened.root,
      profile.id,
      uploaded.id,
      {
        version: getIntakeRead(opened.db, opened.root, profile.id, uploaded.id).version,
        jsonlText: answers
          .slice(0, 2)
          .map((answer) =>
            JSON.stringify({
              format: 'health-record-v1',
              id: answer.marker,
              kind: 'record',
              payload: {
                value: answer.fields.valueText,
                person: qualificationPerson,
                birthDate: qualificationBirthDate,
                identity: `Patient: ${qualificationPerson}\nPatient DOB: ${qualificationBirthDate}`,
                report: 'FICTIONAL CLINICAL QUALIFICATION REPORT',
              },
              provenance: {
                capturedVia: 'Controlled host fixture, never live extraction',
                sourceSystem: qualificationSourceSystem,
                sourceRecordId: null,
                evidenceClass: 'transcription',
                locator: `page 1, row ${answer.marker}`,
              },
              coverage: { status: 'partial', notes: [] },
              clinical: { kind: 'observation', ...answer.fields, subject: 'unknown' },
              reviewIssues: [
                {
                  kind: 'identity',
                  field: 'subject',
                  prompt: 'Does this fictional report belong to you?',
                  textAnchor: `Patient: ${qualificationPerson}\nPatient DOB: ${qualificationBirthDate}`,
                  selfSuggestion: {
                    fullName: qualificationPerson,
                    birthDate: qualificationBirthDate,
                  },
                },
              ],
              report: {
                key: 'fictional-page-one',
                title: 'FICTIONAL CLINICAL QUALIFICATION REPORT',
                anchor: { locator: 'page 1', text: 'FICTIONAL CLINICAL QUALIFICATION REPORT' },
                subject: { locator: 'page 1', text: 'Patient: ' + qualificationPerson },
              },
            }),
          )
          .join('\n'),
        summary: 'Explicitly controlled fictional proposal fixture',
      },
      { observedSourcePages: [{ intakeId: uploaded.id, pages: [1] }] },
    );
    const fabricatedReading = batch();
    fabricatedReading.id = owned.id;
    fabricatedReading.operationId = owned.operationId;
    fabricatedReading.profileId = profile.id;
    fabricatedReading.items[0]!.intakeId = uploaded.id;
    fabricatedReading.items[0]!.sourceHash = pdf.sha256;
    const retained = new Map<string, unknown>();
    const qualifier = createContinuingApprovalQualifier({
      prefix: selectedPrefix,
      profileId: profile.id,
      originalId: uploaded.id,
      expectedSha256: pdf.sha256,
      ownedProfiles: new Set([profile.id]),
      signal: t.signal,
      request: async <T>(resource: string, input?: unknown): Promise<T> => {
        if (resource === selectedPrefix + `/intake-batches/${owned.id}`)
          return structuredClone(fabricatedReading) as T;
        if (resource === selectedPrefix + '/assistant/chats/fictional-chat')
          return {
            id: 'fictional-chat',
            context: { intakeId: uploaded.id },
            status: 'running',
            backend: 'litellm',
            reading: fabricatedReading.items[0]!.reading,
          } as T;
        return http<T>(resource, input);
      },
      collectFeed: (resource) => collectQualificationFeed(http, resource),
      originalHash: async (resource, id) => {
        const response = await fetch(base + resource + `/sources/${id}/content`, {
          headers: { Origin: origin, Cookie: cookie, Connection: 'close' },
          signal: t.signal,
        });
        assert.equal(response.ok, true);
        return createHash('sha256')
          .update(Buffer.from(await response.arrayBuffer()))
          .digest('hex');
      },
      retain: (name, value) => {
        retained.set(name, structuredClone(value));
      },
    });
    try {
      await qualifier.onSnapshot(fabricatedReading);
    } catch (error) {
      assert.fail(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown test failure',
          validApproval: retained.get('continuing-valid-acceptance-request.json'),
          validReceipt: retained.get('continuing-valid-acceptance.json'),
          staleReceipt: retained.get('continuing-stale-acceptance.json'),
        }),
      );
    }
    assert.equal(qualifier.result().status, 'passed');
    assert.equal(opened.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
    assert.deepEqual(
      opened.db
        .prepare('SELECT person_id,value_text FROM observations')
        .all()
        .map((row) => [row.person_id, row.value_text]),
      [['patient', '<0.01']],
    );
  },
);

test(
  'scripted proxy publishes the first PDF unit through the encrypted HTTP coordinator with normal compaction and an unread second unit',
  { timeout: 120_000 },
  async (t) => {
    fictionalModel(t);
    const priorPdf = process.env.CRS_AI_PROXY_PDF;
    process.env.CRS_AI_PROXY_PDF = 'true';
    t.after(() => {
      if (priorPdf === undefined) delete process.env.CRS_AI_PROXY_PDF;
      else process.env.CRS_AI_PROXY_PDF = priorPdf;
    });
    const directory = mkdtempSync(join(tmpdir(), 'fictional-scripted-continuing-'));
    mkdirSync(join(directory, 'data'));
    type Value = Record<string, unknown>;
    const value = (input: unknown): Value => {
      assert.ok(input && typeof input === 'object' && !Array.isArray(input));
      return input as Value;
    };
    const published = Promise.withResolvers<void>();
    const hold = Promise.withResolvers<void>();
    let uploaded: IntakeRead | undefined;
    let selectedPrefix = '';
    let last: Value | undefined;
    type Command = { name: string; args: Value };
    let commands: Generator<Command, void, Value> | undefined;
    let requestCount = 0;
    let compacted = false;
    const calls: Array<{ tool: string; arguments: Value }> = [];
    const originalPages: number[] = [];
    const sourcePages: number[] = [];
    const sourceWindows = new Set<string>();
    const failures: string[] = [];
    const reply = (name: string, args: Value) => ({
      model: 'fictional-test-alias',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: `fictional-call-${requestCount}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    function* reading(context: Value): Generator<Command, void, Value> {
      const conversion = value(context.conversion),
        unit = value(conversion.unit);
      const id = String(conversion.intakeId),
        planId = String(conversion.planId),
        unitId = String(unit.id);
      assert.equal(id, uploaded!.id);
      assert.equal(value(conversion.reading).totalUnits, 2);
      assert.equal(unit.pageCount, 2);
      const selected = yield {
        name: 'health_intake_plan',
        args: { id, action: 'read_unit', unitId },
      };
      const pages = value(selected.unit).pages;
      assert.deepEqual(pages, [1, 2], JSON.stringify(selected));

      for (const page of pages as number[])
        yield { name: 'health_intake_read', args: { id, page } };
      let revisionId: string | undefined;
      for (const page of pages as number[]) {
        let offset = 0,
          character = 0;
        do {
          const window = JSON.stringify([page, offset, character]);
          assert.equal(sourceWindows.has(window), false, 'never reread a source-text window');
          sourceWindows.add(window);
          const passage = yield {
            name: 'health_intake_source_text',
            args: { id, page, ...(revisionId ? { revisionId } : {}), offset, character },
          };
          assert.equal(typeof passage.revisionId, 'string');
          if (revisionId) assert.equal(passage.revisionId, revisionId);
          revisionId = passage.revisionId as string;
          if (passage.nextOffset === null) break;
          assert.ok(Number.isSafeInteger(passage.nextOffset));
          offset = Number(passage.nextOffset);
          character = Number(passage.nextCharacter);
        } while (true);
      }
      const current = yield {
        name: 'health_intake_plan',
        args: { id, action: 'read', section: 'plan', freshStart: true, offset: 0 },
      };
      const version = Number(value(current.pins).version);
      assert.equal(value(current.proposalSourceText).currentRevisionId, revisionId);
      assert.equal(compacted, true, 'the ordinary proxy already compacted consumed original reads');
      const jsonlText = answers
        .slice(0, 2)
        .map((answer) =>
          JSON.stringify({
            format: 'health-record-v1',
            id: answer.marker,
            kind: 'record',
            payload: {
              value: answer.fields.valueText,
              person: qualificationPerson,
              birthDate: qualificationBirthDate,
              identity: `Patient: ${qualificationPerson}\nPatient DOB: ${qualificationBirthDate}`,
              report: 'FICTIONAL CLINICAL QUALIFICATION REPORT',
            },
            provenance: {
              capturedVia: 'Independently fictional scripted proxy fixture',
              sourceSystem: qualificationSourceSystem,
              sourceRecordId: null,
              evidenceClass: 'transcription',
              locator: `page 1, row ${answer.marker}`,
            },
            coverage: { status: 'partial', notes: [] },
            clinical: { kind: 'observation', ...answer.fields, subject: 'unknown' },
            report: {
              key: 'fictional-page-one',
              title: 'FICTIONAL CLINICAL QUALIFICATION REPORT',
              anchor: { locator: 'page 1', text: 'FICTIONAL CLINICAL QUALIFICATION REPORT' },
              subject: { locator: 'page 1', text: 'Patient: ' + qualificationPerson },
            },
          }),
        )
        .join('\n');
      yield {
        name: 'health_intake_batch',
        args: {
          id,
          version,
          planId,
          operationId: 'fictional-first-unit-publication',
          sourceTextRevisionId: revisionId,
          jsonlText,
          summary: 'Scripted first-unit proposal, never clinical acceptance',
          coverage: [
            {
              unitId,
              kind: 'extracted',
              notes: 'Read original pages 1 and 2 and their current durable source text.',
            },
          ],
        },
      };
    }
    const app = createVaultApp({
      dataDirectory: join(directory, 'data'),
      runtimeDirectory: join(directory, 'runtime'),
      assistantOptions: {
        availability: async () => ({ available: true, readiness: 'ready' }),
        connectionCheck: async () => ({ available: true, readiness: 'ready' }),
        bridgeFactory(options) {
          return new ProxyModelBridge({
            ...options,
            config: proxyConfig(),
            resolveHost: async () => [{ address: '127.0.0.1' }],
            onTool: async (request) => {
              calls.push({ tool: request.tool, arguments: structuredClone(request.arguments) });
              try {
                last = value(await options.onTool!(request));
                return last;
              } catch (error) {
                failures.push(error instanceof Error ? error.message : String(error));
                published.reject(error);
                throw error;
              }
            },
            fetchImpl: async (_url, init) => {
              try {
                requestCount++;
                assert.ok(requestCount <= 16, 'scripted reading cannot exhaust the request bound');
                const wire = JSON.parse(String(init?.body)) as {
                  messages: Array<{ role: string; content: unknown }>;
                };
                compacted ||= wire.messages.some(
                  (message) =>
                    message.role === 'tool' &&
                    typeof message.content === 'string' &&
                    message.content.includes('[HOST_TRANSCRIPT_RECEIPT:'),
                );
                while (!uploaded) await delay(1, undefined, { signal: t.signal });
                if (!commands) {
                  const initial = wire.messages.find((message) => message.role === 'user')?.content;
                  assert.equal(typeof initial, 'string');
                  commands = reading(
                    value(JSON.parse(String(initial).slice(String(initial).indexOf('\n') + 1))),
                  );
                }
                const next = commands.next(last!);
                let response: unknown;
                if (next.done) {
                  published.resolve();
                  await hold.promise;
                  response = {
                    model: 'fictional-test-alias',
                    choices: [
                      {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'Fictional fixture stopped.' },
                      },
                    ],
                  };
                } else response = reply(next.value.name, next.value.args);
                return new Response(JSON.stringify(response), {
                  headers: { 'Content-Type': 'application/json' },
                });
              } catch (error) {
                published.reject(error);
                throw error;
              }
            },
          });
        },
      },
    });
    t.after(() => {
      hold.resolve();
      app.close();
      rmSync(directory, { recursive: true, force: true });
    });
    await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    let cookie = '';
    async function http<T>(path: string, input?: unknown, bytes?: Buffer): Promise<T> {
      const response = await fetch(base + path, {
        method: input !== undefined || bytes ? 'POST' : 'GET',
        headers: {
          Origin: 'http://localhost:5173',
          Cookie: cookie,
          Connection: 'close',
          'Content-Type': bytes ? 'application/pdf' : 'application/json',
          ...(bytes ? { 'X-Filename': 'fictional-scripted-continuing.pdf' } : {}),
        },
        ...(bytes
          ? { body: Uint8Array.from(bytes).buffer }
          : input !== undefined
            ? { body: JSON.stringify(input) }
            : {}),
        signal: t.signal,
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0]!;
      const result = (await response.json()) as { data: T; error?: unknown };
      assert.equal(response.ok, true, `${path}: ${JSON.stringify(result.error)}`);
      return result.data;
    }
    const setup = await http<{ setupId: string; recoveryKit: unknown }>('/api/profile-setups', {
      name: 'Fictional scripted reading',
      fullName: qualificationPerson,
      birthDate: qualificationBirthDate,
      placebo: false,
    });
    const profile = await http<{ id: string }>(`/api/profile-setups/${setup.setupId}/verify`, {
      recovery: setup.recoveryKit,
      acknowledged: true,
    });
    selectedPrefix = `/api/profiles/${profile.id}`;
    const path = join(directory, 'fictional.pdf');
    writeProviderQualificationPdf(path, 'continuing');
    uploaded = await http<IntakeRead>(selectedPrefix + '/intakes', undefined, readFileSync(path));
    await published.promise;
    assert.deepEqual(failures, []);
    for (const call of calls) {
      if (call.tool === 'health_intake_read') originalPages.push(Number(call.arguments.page));
      if (call.tool === 'health_intake_source_text') sourcePages.push(Number(call.arguments.page));
    }
    assert.deepEqual(originalPages, [1, 2], 'no prerequisite reread was required');
    assert.deepEqual([...new Set(sourcePages)], [1, 2]);
    assert.equal(sourcePages.length, sourceWindows.size);
    assert.equal(calls.filter((call) => call.tool === 'health_intake_batch').length, 1);
    // Four normal capability requests plus this scripted path, including its
    // held next request, fit the separately enforced sixteen-request limit.
    assert.ok(requestCount <= 12);
    let current: IntakeBatch | undefined;
    while (!t.signal.aborted) {
      const batches = await http<IntakeBatch[]>(selectedPrefix + '/intake-batches');
      current = batches.find((candidate) =>
        candidate.items.some((item) => item.intakeId === uploaded!.id),
      );
      assert.ok(current);
      if (current.items[0]!.reading?.proposalsProduced === 1) break;
      assert.equal(current.status, 'running');
      await delay(5, undefined, { signal: t.signal });
    }
    assert.ok(current);
    assert.equal(current.status, 'running');
    assert.equal(current.items[0]!.reading?.status, 'running');
    assert.equal(current.items[0]!.reading?.coverage, 'reading_progress_only');
    assert.equal(current.items[0]!.reading?.proposalsProduced, 1);
    assert.equal(current.items[0]!.reading?.remainingUnits, 1);
    assert.equal(current.items[0]!.reading?.accountedUnits, 1);
    const feed = await collectQualificationFeed(http, selectedPrefix);
    assert.deepEqual(
      feed.blocks
        .flatMap((block) => block.records.map((record) => record.mapping.testLabel))
        .sort(),
      answers
        .slice(0, 2)
        .map((answer) => answer.marker)
        .sort(),
    );
    const overview = await http<{ counts: { observations: number } }>(selectedPrefix + '/overview');
    assert.equal(overview.counts.observations, 0, 'proposals do not accept clinical records');
    await http(selectedPrefix + `/intake-batches/${current.id}/stop`, {});
    hold.resolve();
  },
);
