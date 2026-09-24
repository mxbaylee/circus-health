import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HttpError, openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { rebuildProfile } from '../portable.ts';
import * as intake from '../intake.ts';
import { createAssistant, type AssistantActionExtensions } from '../assistant.ts';
import {
  intakeDraftRepairAssistantExtensions,
  resolveIntakeDraftRepairScope,
} from '../intake-draft-repair.ts';
import type { HealthRecordEnvelope, IntakeDraftRepairSelection } from '../../shared/intake.ts';
import type { HealthTool } from '../proxy-model-bridge.ts';
import { fictionalModel } from './fictional-model.ts';
import { ProxyModelBridge } from '../proxy-model-bridge.ts';
import { modelConfig } from '../model-config.ts';
import { disposePdfEvidenceSessions } from '../intake-pdf-session.ts';

const report = {
  key: 'fictional-draft-repair-report',
  title: 'Fictional draft repair report',
  anchor: { locator: 'page 1 heading', text: 'Fictional repair panel' },
  subject: { locator: 'page 1 patient', text: 'Fictional Patient' },
};

function envelope(id: string, date: string, method: string): HealthRecordEnvelope {
  return {
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: { literal: `${id} source literal`, reportedDate: date, reportedMethod: method },
    clinical: {
      kind: 'observation',
      subject: 'self',
      testLabel: `Fictional ${id}`,
      valueText: id === 'one' ? '10' : '20',
      unit: 'fictional units',
      date,
      method,
      observationCategory: 'Fictional panel',
    },
    provenance: {
      capturedVia: null,
      sourceSystem: 'Fictional source',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: `characters 0–1200 row ${id}`,
    },
    coverage: { status: 'complete_response', notes: [] },
    report,
  };
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-draft-repair-'));
  const profileId = 'orchid';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const bytes = Buffer.from(
    [envelope('one', '2025-01-01', 'Method A'), envelope('two', '2024-02-02', 'Method B')]
      .map((value) => JSON.stringify(value))
      .join('\n'),
  );
  const uploaded = intake.uploadIntake(db, root, profileId, {
    filename: 'fictional-repair.jsonl',
    newProviderName: 'Fictional Clinic',
    bytes,
  });
  const review = intake.reviewIntake(db, root, profileId, uploaded.id);
  const groupId = review.records[0]!.reportGroups![0]!.groupId;
  const selection: IntakeDraftRepairSelection = {
    format: 'intake-draft-repair-selection-v1',
    intakeId: uploaded.id,
    groupId,
    rows: review.records.map((record) => ({
      proposalId: null,
      recordId: record.id,
      candidateVersionId: record.candidateVersionId!,
      fields: ['date', 'method', 'observationCategory'],
    })),
  };
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, db, bytes, uploaded, review, groupId, selection };
}

function fictionalRepairPdf() {
  const pages = [
    'Fictional unselected repair page',
    'Fictional repair panel Fictional Patient reviewed method',
  ];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, page] of pages.entries()) {
    const stream = `BT /F1 12 Tf 30 720 Td (${page}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

for (const fallback of [false, true])
  test(`selected PDF repair metadata reaches the provider with ${fallback ? 'same-page PNG fallback' : 'native input'}`, async (t) => {
    const f = fixture(t);
    t.after(() => disposePdfEvidenceSessions(f.profileId));
    const uploaded = intake.uploadIntake(f.db, f.root, f.profileId, {
      filename: 'fictional-selected-repair.pdf',
      bytes: fictionalRepairPdf(),
      newProviderName: 'Fictional Clinic',
    });
    const value = envelope('native-repair', '2025-01-01', 'Method A');
    value.provenance.locator = 'page 2 result';
    const item = intake.proposeConversion(f.db, f.root, f.profileId, uploaded.id, {
      version: uploaded.version,
      summary: 'Fictional selected repair',
      jsonlText: JSON.stringify(value),
    });
    const review = intake.reviewIntake(f.db, f.root, f.profileId, item.id, item.proposals[0]!.id);
    const record = review.records[0]!;
    const scope = resolveIntakeDraftRepairScope(f.db, f.root, f.profileId, {
      format: 'intake-draft-repair-selection-v1',
      intakeId: item.id,
      groupId: record.reportGroups![0]!.groupId,
      rows: [
        {
          proposalId: review.proposalId,
          recordId: record.id,
          candidateVersionId: record.candidateVersionId!,
          fields: ['method'],
        },
      ],
    });
    const extension = intakeDraftRepairAssistantExtensions();
    const context = {
      db: f.db,
      root: f.root,
      profileId: f.profileId,
      chat: { context: { intakeRepair: scope }, proposals: [] },
      state: {},
      assertRunning() {},
    };
    const args = {
      scopeToken: scope.scopeToken,
      recordId: record.id,
      evidenceId: scope.rows[0]!.evidence[0]!.id,
    };
    const requests: { messages: { role: string; content: unknown }[] }[] = [];
    const errors: unknown[] = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const bridge = new ProxyModelBridge({
      config: modelConfig({
        HEALTH_AI_MODEL: 'fictional-repair-model',
        HEALTH_AI_BASE_URL: 'http://litellm:4000',
        HEALTH_AI_API_KEY: 'fictional-key',
        HEALTH_AI_PROXY_IMAGES: String(fallback),
        HEALTH_AI_PROXY_PDF: 'true',
      }),
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        if (requests.length === 1)
          return new Response(
            JSON.stringify({
              model: 'fictional-repair-model',
              choices: [
                {
                  index: 0,
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'fictional-repair-read',
                        type: 'function',
                        function: {
                          name: 'health_intake_draft_repair_read',
                          arguments: JSON.stringify(args),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          );
        if (fallback && requests.length === 2)
          return new Response(
            JSON.stringify({ error: { message: 'This model does not support PDF input' } }),
            { status: 400 },
          );
        return new Response(
          JSON.stringify({
            model: 'fictional-repair-model',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'Fictional evidence reviewed' },
              },
            ],
          }),
          { status: 200 },
        );
      },
      onTool: (request) =>
        extension.call(request.tool, request.arguments, { ...context, pdf: request.pdf === true }),
      onEvent: (name, value) => {
        if (name === 'error') {
          errors.push(value);
          finish();
        }
        if (name === 'turn/completed') finish();
      },
      onExit: (error) => {
        errors.push(error);
        finish();
      },
    });
    t.after(() => bridge.close());
    await bridge.start('Read only the selected fictional repair page.', extension.tools);
    await bridge.turn('Read the selected fictional repair evidence.');
    await completed;
    assert.deepEqual(errors, []);
    assert.equal(requests.length, fallback ? 3 : 2);
    for (const request of requests.slice(1)) {
      const tool = request.messages.find((message) => message.role === 'tool')!;
      assert.equal(typeof tool.content, 'string');
      const metadata = JSON.parse(tool.content as string);
      assert.equal(metadata.original.page, 2);
      assert.equal(metadata.repairEvidence.scopeToken, scope.scopeToken);
      assert.equal(metadata.repairEvidence.evidenceId, args.evidenceId);
      assert.match(metadata.instructions, /selected row/);
      assert.equal('pdfFallback' in metadata, false);
    }
    assert.match(JSON.stringify(requests[1]), /application\/pdf/);
    if (fallback) {
      assert.match(JSON.stringify(requests[2]), /image\/png/);
      assert.doesNotMatch(JSON.stringify(requests[2]), /data:application\/pdf/);
    }
  });

test('one previewed field correction updates only selected pending drafts and preserves originals', (t) => {
  const f = fixture(t);
  const [first, second] = f.review.records;
  const updated = intake.saveIntakeDraftRepair(f.db, f.root, f.profileId, f.uploaded.id, {
    version: f.review.version,
    operationId: 'manual-date-column',
    groupId: f.groupId,
    corrections: [
      {
        proposalId: null,
        recordId: first!.id,
        candidateVersionId: first!.candidateVersionId!,
        field: 'date',
        before: '2025-01-01',
        after: '2025-03-03',
      },
    ],
  });
  const refreshed = intake.reviewIntake(f.db, f.root, f.profileId, f.uploaded.id);
  assert.equal(refreshed.records[0]!.mapping.date, '2025-03-03');
  assert.equal(refreshed.records[0]!.mapping.method, 'Method A');
  assert.equal(refreshed.records[1]!.mapping.date, '2024-02-02');
  assert.deepEqual(
    intake.getIntakeOriginal(f.db, f.root, f.profileId, f.uploaded.id).bytes,
    f.bytes,
  );
  assert.equal(updated.version, f.review.version + 1);

  assert.throws(
    () =>
      intake.saveIntakeDraftRepair(f.db, f.root, f.profileId, f.uploaded.id, {
        version: updated.version,
        operationId: 'atomic-stale-group',
        groupId: f.groupId,
        corrections: [
          {
            proposalId: null,
            recordId: first!.id,
            candidateVersionId: first!.candidateVersionId!,
            field: 'method',
            before: 'Method A',
            after: 'Reviewed A',
          },
          {
            proposalId: null,
            recordId: second!.id,
            candidateVersionId: second!.candidateVersionId!,
            field: 'method',
            before: 'stale value',
            after: 'Reviewed B',
          },
        ],
      }),
    (error: unknown) => error instanceof HttpError && error.code === 'DRAFT_REPAIR_STALE',
  );
  const afterFailure = intake.reviewIntake(f.db, f.root, f.profileId, f.uploaded.id);
  assert.equal(afterFailure.records[0]!.mapping.method, 'Method A');
  assert.equal(afterFailure.records[1]!.mapping.method, 'Method B');
  intake.saveIntakeDraftRepair(f.db, f.root, f.profileId, f.uploaded.id, {
    version: updated.version,
    operationId: 'undo-manual-date-column',
    groupId: f.groupId,
    corrections: [
      {
        proposalId: null,
        recordId: first!.id,
        candidateVersionId: first!.candidateVersionId!,
        field: 'date',
        before: '2025-03-03',
        after: '2025-01-01',
      },
    ],
  });
  assert.equal(
    intake.reviewIntake(f.db, f.root, f.profileId, f.uploaded.id).records[0]!.mapping.date,
    '2025-01-01',
  );
});

test('AI draft repair reads retained original, rejects scope escapes, applies once and reconciles', async (t) => {
  const f = fixture(t);
  const scope = resolveIntakeDraftRepairScope(f.db, f.root, f.profileId, f.selection);
  assert.match(scope.originalSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(scope).includes('one source literal'), false);
  const extension = intakeDraftRepairAssistantExtensions();
  const chat = { context: { intakeRepair: scope }, proposals: [] as Record<string, unknown>[] };
  const context = {
    db: f.db,
    root: f.root,
    profileId: f.profileId,
    chat,
    state: {},
    assertRunning: () => {},
  };
  const first = scope.rows[0]!;
  const evidenceId = first.evidence[0]!.id;
  await assert.rejects(
    async () =>
      await extension.call(
        'health_intake_draft_repair_review',
        {
          scopeToken: scope.scopeToken,
          edits: [
            {
              recordId: first.recordId,
              candidateVersionId: first.candidateVersionId,
              field: 'method',
              after: 'Unsupported without an original read',
              evidenceIds: [evidenceId],
            },
          ],
          unresolvedNotes: [],
          reason: 'Must fail before preview',
          propose: false,
        },
        context,
      ),
    (error: unknown) => error instanceof HttpError && error.code === 'DRAFT_REPAIR_EVIDENCE',
  );
  const read = (recordId = first.recordId, selectedEvidenceId = evidenceId) =>
    extension.call(
      'health_intake_draft_repair_read',
      { scopeToken: scope.scopeToken, recordId, evidenceId: selectedEvidenceId },
      context,
    ) as Promise<Record<string, unknown>>;
  const original = await read();
  assert.match(JSON.stringify(original), /one source literal/);
  const call = (overrides: Record<string, unknown> = {}) =>
    extension.call(
      'health_intake_draft_repair_review',
      {
        scopeToken: scope.scopeToken,
        edits: [
          {
            recordId: first.recordId,
            candidateVersionId: first.candidateVersionId,
            field: 'method',
            after: 'Reviewed method',
            evidenceIds: [evidenceId],
          },
        ],
        unresolvedNotes: ['The second row remains unresolved.'],
        reason: 'Review one fictional source-linked method correction.',
        propose: false,
        ...overrides,
      },
      context,
    ) as Promise<Record<string, unknown>>;

  await assert.rejects(
    () =>
      call({
        edits: [
          {
            recordId: 'another-row',
            candidateVersionId: first.candidateVersionId,
            field: 'method',
            after: 'Wrong scope',
            evidenceIds: [evidenceId],
          },
        ],
      }),
    (error: unknown) => error instanceof HttpError && error.code === 'DRAFT_REPAIR_SCOPE',
  );
  await assert.rejects(
    () =>
      call({
        edits: [
          {
            recordId: first.recordId,
            candidateVersionId: first.candidateVersionId,
            field: 'valueText',
            after: '999',
            evidenceIds: [evidenceId],
          },
        ],
      }),
    (error: unknown) => error instanceof HttpError && error.code === 'DRAFT_REPAIR_CHANGE',
  );
  await assert.rejects(
    () => call({ unexpectedModelField: 'must not be retained' }),
    (error: unknown) => error instanceof HttpError && error.code === 'DRAFT_REPAIR_CHANGE',
  );
  await assert.rejects(
    () =>
      call({
        edits: [
          {
            recordId: first.recordId,
            candidateVersionId: first.candidateVersionId,
            field: 'method',
            after: 'Wrong evidence',
            evidenceIds: ['another-row-evidence'],
          },
        ],
      }),
    (error: unknown) => error instanceof HttpError && error.code === 'DRAFT_REPAIR_EVIDENCE',
  );
  const preview = await call();
  assert.equal(chat.proposals.length, 0);
  assert.equal(
    intake.reviewIntake(f.db, f.root, f.profileId, f.uploaded.id).records[0]!.mapping.method,
    'Method A',
  );
  assert.ok(preview.preview);
  const unresolved = (await call({
    edits: [],
    unresolvedNotes: ['The retained locator does not establish which date applies.'],
  })) as { preview: { rows: unknown[]; unresolvedNotes: string[] } };
  assert.deepEqual(unresolved.preview.rows, []);
  assert.equal(unresolved.preview.unresolvedNotes.length, 1);

  const proposal = await call({ propose: true });
  assert.equal(chat.proposals.length, 1);
  const applied = extension.apply(proposal, context) as { applied: boolean };
  assert.equal(applied.applied, true);
  assert.equal(
    intake.reviewIntake(f.db, f.root, f.profileId, f.uploaded.id).records[0]!.mapping.method,
    'Reviewed method',
  );
  assert.ok(extension.reconcile(proposal, context));
  assert.equal((extension.apply(proposal, context) as { applied: boolean }).applied, true);
  assert.deepEqual(
    intake.getIntakeOriginal(f.db, f.root, f.profileId, f.uploaded.id).bytes,
    f.bytes,
  );
  const rebuiltRoot = resolve(f.root, 'rebuilt');
  const rebuilt = rebuildProfile(f.root, f.profileId, rebuiltRoot);
  const rebuiltDb = openDatabase(rebuilt.database, f.profileId);
  try {
    assert.equal(
      intake.reviewIntake(rebuiltDb, rebuiltRoot, f.profileId, f.uploaded.id).records[0]!.mapping
        .method,
      'Reviewed method',
    );
    assert.deepEqual(
      intake.getIntakeOriginal(rebuiltDb, rebuiltRoot, f.profileId, f.uploaded.id).bytes,
      f.bytes,
    );
  } finally {
    rebuiltDb.close();
  }
});

test('a stale AI proposal fails without blocking a later direct correction', async (t) => {
  const f = fixture(t);
  const scope = resolveIntakeDraftRepairScope(f.db, f.root, f.profileId, f.selection);
  const extension = intakeDraftRepairAssistantExtensions();
  const chat = { context: { intakeRepair: scope }, proposals: [] as Record<string, unknown>[] };
  const context = {
    db: f.db,
    root: f.root,
    profileId: f.profileId,
    chat,
    state: {},
    assertRunning: () => {},
  };
  const first = scope.rows[0]!;
  await extension.call(
    'health_intake_draft_repair_read',
    {
      scopeToken: scope.scopeToken,
      recordId: first.recordId,
      evidenceId: first.evidence[0]!.id,
    },
    context,
  );
  const proposal = (await extension.call(
    'health_intake_draft_repair_review',
    {
      scopeToken: scope.scopeToken,
      edits: [
        {
          recordId: first.recordId,
          candidateVersionId: first.candidateVersionId,
          field: 'method',
          after: 'AI proposed method',
          evidenceIds: [first.evidence[0]!.id],
        },
      ],
      unresolvedNotes: [],
      reason: 'Fictional focused request',
      propose: true,
    },
    context,
  )) as Record<string, unknown>;
  const changed = intake.saveIntakeDraftRepair(f.db, f.root, f.profileId, f.uploaded.id, {
    version: f.review.version,
    operationId: 'intervening-manual-change',
    groupId: f.groupId,
    corrections: [
      {
        proposalId: null,
        recordId: first.recordId,
        candidateVersionId: first.candidateVersionId,
        field: 'observationCategory',
        before: 'Fictional panel',
        after: 'Reviewed panel',
      },
    ],
  });
  assert.throws(
    () => extension.apply(proposal, context),
    (error: unknown) => error instanceof HttpError && error.code === 'DRAFT_REPAIR_STALE',
  );
  const direct = intake.saveIntakeDraftRepair(f.db, f.root, f.profileId, f.uploaded.id, {
    version: changed.version,
    operationId: 'manual-after-ai-failure',
    groupId: f.groupId,
    corrections: [
      {
        proposalId: null,
        recordId: first.recordId,
        candidateVersionId: first.candidateVersionId,
        field: 'method',
        before: 'Method A',
        after: 'Direct reviewed method',
      },
    ],
  });
  assert.equal(direct.version, changed.version + 1);
  assert.equal(
    intake.reviewIntake(f.db, f.root, f.profileId, f.uploaded.id).records[0]!.mapping.method,
    'Direct reviewed method',
  );
});

test('cross-profile, stale and malformed retained scopes fail before draft mutation', (t) => {
  const f = fixture(t);
  const scope = resolveIntakeDraftRepairScope(f.db, f.root, f.profileId, f.selection);
  const extension = intakeDraftRepairAssistantExtensions();
  assert.throws(
    () => resolveIntakeDraftRepairScope(f.db, f.root, 'another-profile', f.selection),
    (error: unknown) => error instanceof Error,
  );
  const first = scope.rows[0]!;
  const proposal = {
    id: 'malformed-saved-proposal',
    kind: 'intake_draft_repair',
    changes: {
      scope: { ...scope, scopeToken: 'tampered' },
      edits: [
        {
          recordId: first.recordId,
          candidateVersionId: first.candidateVersionId,
          field: 'date',
          after: '2025-05-05',
          evidenceIds: [first.evidence[0]!.id],
        },
      ],
    },
  };
  assert.throws(
    () => extension.apply(proposal, { db: f.db, root: f.root, profileId: f.profileId }),
    (error: unknown) => error instanceof HttpError && error.code === 'DRAFT_REPAIR_RECEIPT',
  );
  assert.equal(
    intake.reviewIntake(f.db, f.root, f.profileId, f.uploaded.id).records[0]!.mapping.date,
    '2025-01-01',
  );
});

test('changed originals and over-bound locators fail before repair evidence can be used', async (t) => {
  const overBound = fixture(t);
  const changed = envelope('over-bound', '2025-01-01', 'Method A');
  changed.provenance.locator = 'characters 0–20000';
  const uploaded = intake.uploadIntake(overBound.db, overBound.root, overBound.profileId, {
    filename: 'fictional-over-bound.jsonl',
    bytes: Buffer.from(JSON.stringify(changed)),
  });
  const review = intake.reviewIntake(
    overBound.db,
    overBound.root,
    overBound.profileId,
    uploaded.id,
  );
  assert.throws(
    () =>
      resolveIntakeDraftRepairScope(overBound.db, overBound.root, overBound.profileId, {
        format: 'intake-draft-repair-selection-v1',
        intakeId: uploaded.id,
        groupId: review.records[0]!.reportGroups![0]!.groupId,
        rows: [
          {
            proposalId: null,
            recordId: review.records[0]!.id,
            candidateVersionId: review.records[0]!.candidateVersionId!,
            fields: ['date'],
          },
        ],
      }),
    (error: unknown) => error instanceof HttpError && error.code === 'DRAFT_REPAIR_EVIDENCE',
  );

  const scope = resolveIntakeDraftRepairScope(
    overBound.db,
    overBound.root,
    overBound.profileId,
    overBound.selection,
  );
  const reference = intake.getRetainedIntakeOriginalReference(
    overBound.db,
    overBound.root,
    overBound.profileId,
    overBound.uploaded.id,
  );
  writeFileSync(reference.path, Buffer.from('changed fictional bytes'));
  const extension = intakeDraftRepairAssistantExtensions();
  await assert.rejects(
    async () =>
      await extension.call(
        'health_intake_draft_repair_read',
        {
          scopeToken: scope.scopeToken,
          recordId: scope.rows[0]!.recordId,
          evidenceId: scope.rows[0]!.evidence[0]!.id,
        },
        {
          db: overBound.db,
          root: overBound.root,
          profileId: overBound.profileId,
          chat: { context: { intakeRepair: scope }, proposals: [] },
          state: {},
          assertRunning: () => {},
        },
      ),
    (error: unknown) => error instanceof HttpError && error.code === 'SOURCE_CHANGED',
  );
});

test('production assistant keeps repair chats tool-isolated and reads an original-only date', async (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-repair-host-'));
  const profileId = 'cedar';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const original = Buffer.from(
    'Fictional comparison section\nCollection date: 2025-06-07\nNo other date applies.\n',
  );
  const uploaded = intake.uploadIntake(db, root, profileId, {
    filename: 'fictional-original.txt',
    newProviderName: 'Fictional Clinic',
    bytes: original,
  });
  const draft = envelope('original-only-date', '', 'Method A') as HealthRecordEnvelope & {
    clinical: Record<string, unknown>;
  };
  delete draft.clinical.date;
  delete draft.clinical.method;
  draft.payload = { literal: 'Model draft omitted the collection date.' };
  draft.provenance.locator = 'characters 0–78';
  const proposed = intake.proposeConversion(db, root, profileId, uploaded.id, {
    version: uploaded.version,
    jsonlText: JSON.stringify(draft),
    summary: 'Fictional incomplete model-shaped draft',
    runId: 'fictional-first-model-run',
    modelIdentity: {
      backend: 'fictional',
      model: 'fictional-incomplete-model',
      reasoningEffort: null,
      instructionVersion: 'fictional-v1',
    },
  });
  const proposalId = proposed.proposals[0]!.id;
  const review = intake.reviewIntake(db, root, profileId, uploaded.id, proposalId);
  const record = review.records[0]!;
  assert.equal(record.mapping.date, '');
  assert.equal(JSON.stringify(draft.payload).includes('2025-06-07'), false);
  const selection: IntakeDraftRepairSelection = {
    format: 'intake-draft-repair-selection-v1',
    intakeId: uploaded.id,
    groupId: record.reportGroups![0]!.groupId,
    rows: [
      {
        proposalId,
        recordId: record.id,
        candidateVersionId: record.candidateVersionId!,
        fields: ['date', 'method'],
      },
    ],
  };
  type Callbacks = Parameters<
    NonNullable<Parameters<typeof createAssistant>[0]['bridgeFactory']>
  >[0];
  const bridges: { callbacks: Callbacks; tools: HealthTool[] }[] = [];
  let genericExtensionCalls = 0;
  const repair = intakeDraftRepairAssistantExtensions();
  const genericTool: HealthTool = {
    type: 'function',
    name: 'health_review_import',
    description: 'Fictional generic mapping mutation',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  };
  const extensions: AssistantActionExtensions = {
    tools: [genericTool, ...repair.tools],
    call(tool, args, context) {
      if (tool === genericTool.name) {
        genericExtensionCalls++;
        return { mutated: true };
      }
      return repair.call(tool, args, context);
    },
    apply: repair.apply,
    reconcile: repair.reconcile,
  };
  const assistant = createAssistant({
    root,
    databases: new Map([[profileId, db]]),
    availability: () => ({ available: true, readiness: 'ready' }),
    connectionCheck: () => ({ available: true, readiness: 'ready' }),
    journalWriter: () => {},
    actionExtensions: extensions,
    bridgeFactory(callbacks) {
      const bridge = {
        callbacks,
        tools: [] as HealthTool[],
        async start(_instructions: string, tools: HealthTool[]) {
          this.tools = tools;
          return { model: 'fictional-repair-model', backend: 'fictional' };
        },
        async turn() {
          callbacks.onEvent?.('turn/started', { turn: { id: 'fictional-repair-turn' } });
        },
        async cancel() {},
        close() {},
      };
      bridges.push(bridge);
      return bridge;
    },
  });
  t.after(() => {
    assistant.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const waitForBridge = async (count: number) => {
    for (let attempt = 0; attempt < 20 && bridges.length < count; attempt++) await tick();
    assert.equal(bridges.length, count);
  };
  const chat = assistant.create(profileId, {
    message: 'Recover the selected missing date from the original section.',
    context: { route: '#/import', intakeRepair: selection },
  });
  await waitForBridge(1);
  const exactTools = [
    'health_assistant_progress',
    'health_intake_draft_repair_read',
    'health_intake_draft_repair_review',
  ];
  assert.deepEqual(bridges[0]!.tools.map((tool) => tool.name).sort(), exactTools.slice().sort());
  await assert.rejects(
    async () =>
      await bridges[0]!.callbacks.onTool!({
        tool: 'health_intake_read',
        arguments: { id: uploaded.id },
        callId: 'malicious-generic-read',
      }),
    (error: unknown) => error instanceof HttpError && error.code === 'DRAFT_REPAIR_TOOL',
  );
  await assert.rejects(
    async () =>
      await bridges[0]!.callbacks.onTool!({
        tool: 'health_intake_propose',
        arguments: {
          id: uploaded.id,
          version: proposed.version,
          jsonlText: JSON.stringify(draft),
          summary: 'Unadvertised generic conversion attempt',
        },
        callId: 'malicious-intake-propose',
      }),
    (error: unknown) => error instanceof HttpError && error.code === 'DRAFT_REPAIR_TOOL',
  );
  await assert.rejects(
    async () =>
      await bridges[0]!.callbacks.onTool!({
        tool: genericTool.name,
        arguments: {},
        callId: 'malicious-generic-extension',
      }),
    (error: unknown) => error instanceof HttpError && error.code === 'DRAFT_REPAIR_TOOL',
  );
  assert.equal(genericExtensionCalls, 0);
  assert.equal(intake.getIntake(db, root, profileId, uploaded.id).proposals.length, 1);

  bridges[0]!.callbacks.onEvent?.('error', {
    willRetry: false,
    message: 'Fictional interruption before source read',
  });
  assistant.retry(profileId, chat.id);
  await waitForBridge(2);
  assert.deepEqual(bridges[1]!.tools.map((tool) => tool.name).sort(), exactTools.slice().sort());
  bridges[1]!.callbacks.onEvent?.('turn/completed', { turn: { status: 'completed' } });
  assert.throws(
    () =>
      assistant.send(profileId, chat.id, {
        message: 'Try to replace the retained scope.',
        context: { intakeRepair: selection },
      }),
    (error: unknown) => error instanceof HttpError && error.code === 'DRAFT_REPAIR_SCOPE',
  );
  assert.equal(bridges.length, 2);
  assistant.send(profileId, chat.id, {
    message: 'Continue this exact selected repair.',
    context: { route: '#/' },
  });
  await waitForBridge(3);
  assert.deepEqual(bridges[2]!.tools.map((tool) => tool.name).sort(), exactTools.slice().sort());
  const scope = bridges[2]!.callbacks.onTool
    ? (assistant.get(profileId, chat.id).context!.intakeRepair as IntakeDraftRepairScopeForTest)
    : (() => {
        throw new Error('Expected tool callback');
      })();
  const row = scope.rows[0]!;
  const source = (await bridges[2]!.callbacks.onTool!({
    tool: 'health_intake_draft_repair_read',
    arguments: {
      scopeToken: scope.scopeToken,
      recordId: row.recordId,
      evidenceId: row.evidence[0]!.id,
    },
    callId: 'read-retained-original',
  })) as { original: { text: string } };
  assert.match(source.original.text, /2025-06-07/);
  const unresolved = (await bridges[2]!.callbacks.onTool!({
    tool: 'health_intake_draft_repair_review',
    arguments: {
      scopeToken: scope.scopeToken,
      edits: [],
      unresolvedNotes: ['The original section does not state a method.'],
      reason: 'Keep the absent method unresolved.',
      propose: false,
    },
    callId: 'retain-absent-method',
  })) as { preview: { rows: unknown[]; unresolvedNotes: string[] } };
  assert.deepEqual(unresolved.preview.rows, []);
  assert.equal(unresolved.preview.unresolvedNotes.length, 1);
  assert.equal(chat.proposals.length, 0);
  const preview = (await bridges[2]!.callbacks.onTool!({
    tool: 'health_intake_draft_repair_review',
    arguments: {
      scopeToken: scope.scopeToken,
      edits: [
        {
          recordId: row.recordId,
          candidateVersionId: row.candidateVersionId,
          field: 'date',
          after: '2025-06-07',
          evidenceIds: [row.evidence[0]!.id],
        },
      ],
      unresolvedNotes: [],
      reason: 'The bounded retained original contains one explicit collection date.',
      propose: true,
    },
    callId: 'preview-original-date',
  })) as { id: string };
  bridges[2]!.callbacks.onEvent?.('turn/completed', { turn: { status: 'completed' } });
  assistant.apply(profileId, chat.id, preview.id);
  assistant.apply(profileId, chat.id, preview.id);
  assert.equal(
    intake.reviewIntake(db, root, profileId, uploaded.id, proposalId).records[0]!.mapping.date,
    '2025-06-07',
  );
  assert.deepEqual(intake.getIntakeOriginal(db, root, profileId, uploaded.id).bytes, original);
  chat.proposals.push({
    id: 'generic-approval-bypass',
    kind: 'classification',
    title: 'Unrelated accepted-record action',
    summary: 'Must not apply in a repair chat',
    status: 'pending',
    changes: {},
  });
  assert.throws(
    () => assistant.apply(profileId, chat.id, 'generic-approval-bypass'),
    (error: unknown) => error instanceof HttpError && error.code === 'DRAFT_REPAIR_PROPOSAL',
  );
});

type IntakeDraftRepairScopeForTest = ReturnType<typeof resolveIntakeDraftRepairScope>;
