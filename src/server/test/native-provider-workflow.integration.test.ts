import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createVaultApp } from '../vault-app.ts';

interface RequestOptions {
  method?: string;
  input?: unknown;
  bytes?: Buffer;
  headers?: Record<string, string>;
}
interface WorkflowDto {
  id: string;
  setupId: string;
  recoveryKit: unknown;
  state: string;
  version: number;
  chatId: string;
  status: string;
  backend: string;
  available: boolean;
  connectionTest: { fictional: boolean; model?: string };
  capabilities: { tools: boolean };
  counts: { observations: number };
  operations: Array<{ tool: string }>;
  proposals: Array<{
    id: string;
    kind: string;
    status: string;
    changes: { set: Record<string, unknown>; recordId: string };
    preview: { after: { kind: string } };
  }>;
  records: Array<{
    id: string;
    kind: string;
    mapping: Record<string, unknown>;
    problem: unknown;
    questions?: Array<{
      id: string;
      field: string;
      prompt: string;
      locator: unknown;
      status: string;
    }>;
  }>;
  reviewToken: string;
  imported: { clinical: { added: number } };
  evidence: unknown[];
  valueText: string;
  label: string;
  unit: string;
  date: string;
  entries: Array<{ contents: { label: string } }>;
}

// Opt-in incurs real provider usage: one connection turn, one source-conversion
// turn and one correction turn. No bridge mocks, authentication-file inspection,
// model repair retries, Docker claims or representative format-quality claims.
// Run with CRS_AI_NATIVE_WORKFLOW_TEST=1 CRS_AI_BACKEND=codex
// CRS_AI_REASONING_EFFORT=medium node --test <this file>.
test(
  'native Codex converts fictional evidence through encrypted HTTP review, correction and cache-loss rebuild',
  {
    skip: process.env.CRS_AI_NATIVE_WORKFLOW_TEST !== '1',
    timeout: 420000,
  },
  async (t) => {
    assert.equal(
      process.env.CRS_AI_BACKEND,
      'codex',
      'This bounded gate is specifically for native Codex',
    );
    assert.equal(
      process.env.CRS_AI_REASONING_EFFORT,
      'medium',
      'Keep the opt-in live check economical',
    );
    const base = mkdtempSync(resolve(tmpdir(), 'circus-native-provider-')),
      dataDirectory = resolve(base, 'data'),
      runtimeDirectory = resolve(base, 'runtime');
    mkdirSync(dataDirectory);
    const app = createVaultApp({ dataDirectory, runtimeDirectory });
    let closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        app.close();
      }
    };
    t.after(() => {
      try {
        close();
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
    t.signal.addEventListener('abort', close, { once: true });
    await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', () => done()));
    const origin = 'http://127.0.0.1:5173',
      url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    let cookie = '';
    const stage = (label: string) => process.stdout.write(`Native workflow: ${label}\n`);
    async function request<T = WorkflowDto>(
      path: string,
      { method = 'GET', input, bytes, headers = {} }: RequestOptions = {},
    ): Promise<T> {
      const response = await fetch(url + path, {
        method,
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...headers },
        ...(input !== undefined
          ? { body: JSON.stringify(input) }
          : bytes
            ? { body: Uint8Array.from(bytes).buffer }
            : {}),
        signal: AbortSignal.any([t.signal, AbortSignal.timeout(90000)]),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0] ?? '';
      const body = (await response.json()) as { data: T; error?: { code?: string } };
      assert.equal(
        response.ok,
        true,
        `${method} ${path.split('?')[0]} failed: ${body.error?.code || response.status}`,
      );
      return body.data;
    }
    const setup = await request('/api/profile-setups', {
      method: 'POST',
      input: {
        fullName: 'Native Fiction Person',
        birthDate: '1982-04-17',
        name: 'Native Fiction Person',
        placebo: false,
      },
    });
    const profile = await request(`/api/profile-setups/${setup.setupId}/verify`, {
        method: 'POST',
        input: { recovery: setup.recoveryKit, acknowledged: true },
      }),
      prefix = `/api/profiles/${profile.id}`;
    const scoped = <T = WorkflowDto>(path: string, options?: RequestOptions) =>
      request<T>(prefix + path, options);
    async function completedChat(chatId: string, label: string): Promise<WorkflowDto> {
      const deadline = Date.now() + 150000;
      while (Date.now() < deadline) {
        const chat = await scoped(`/assistant/chats/${encodeURIComponent(chatId)}`);
        if (chat.status === 'idle') return chat;
        assert.equal(
          ['failed', 'cancelled'].includes(chat.status),
          false,
          `${label} ended with ${chat.status}`,
        );
        await new Promise((done) => setTimeout(done, 500));
      }
      assert.fail(`${label} exceeded its 150-second bound`);
    }
    assert.equal((await scoped('/overview')).counts.observations, 0);
    stage('encrypted fictional profile ready; real connection test starting');
    const connection = await scoped('/assistant/test-connection', {
      method: 'POST',
      input: { image: false },
    });
    assert.equal(connection.backend, 'codex');
    assert.equal(connection.available, true);
    assert.equal(connection.connectionTest.fictional, true);
    assert.equal(connection.capabilities.tools, true);
    stage(
      `connection passed (${connection.connectionTest.model || 'configured model'}); source conversion starting`,
    );
    const identityFact =
      'The named patient, Native Fiction Person, is explicitly the profile owner (Self).';
    const dateFact = 'Date 2026-01-15 is the performed laboratory event date, not an order date.';
    const absentFacts = {
      reference:
        'No reference range or reference interval is supplied. Normal or abnormal interpretation is not supplied and must not be inferred.',
      specimen: 'No specimen is supplied.',
      method: 'No assay method is supplied.',
      time: 'No collection time or timezone is supplied.',
      identity: 'No birth date or external patient identifier is supplied.',
    };
    const source = Buffer.from(
      '<!doctype html><html><body><h1>Fictional laboratory report</h1><p>Patient: Native Fiction Person. Entirely invented test data. ' +
        identityFact +
        '</p><p>Issuing source: Fictional Native Clinic. Record ID: NATIVE-CREAT-1.</p><table><tr><th>Date</th><th>Display label</th><th>Full analyte name</th><th>Result</th><th>Unit</th><th>Status</th></tr><tr><td>2026-01-15</td><td>CREAT</td><td>Creatinine</td><td>1.20</td><td>mg/dL</td><td>Final</td></tr></table><p>This is one performed laboratory observation, not an order or procedure. ' +
        dateFact +
        '</p><p>' +
        Object.values(absentFacts).join(' ') +
        '</p></body></html>',
    );
    const uploaded = await scoped('/intakes', {
      method: 'POST',
      bytes: source,
      headers: {
        'Content-Type': 'text/html',
        'X-Filename': 'fictional-native-creatinine.html',
        'X-Source-Name': 'Fictional Native Clinic',
      },
    });
    assert.equal(uploaded.state, 'pending_conversion');
    const conversion = await scoped(`/intakes/${encodeURIComponent(uploaded.id)}/convert`, {
      method: 'POST',
      input: { version: uploaded.version },
    });
    const conversionChat = await completedChat(conversion.chatId, 'Real source conversion');
    assert.ok(
      conversionChat.operations.some((operation) =>
        ['health_intake_read', 'health_intake_plan'].includes(operation.tool),
      ),
      'The real agent must inspect the retained source',
    );
    assert.ok(
      conversionChat.operations.some((operation) =>
        ['health_intake_propose', 'health_intake_batch'].includes(operation.tool),
      ),
      'The real agent must submit a host-validated proposal',
    );
    const converted = await scoped(`/intakes/${encodeURIComponent(uploaded.id)}`);
    assert.ok(converted.proposals.length > 0, 'The conversion must leave a reviewable proposal');
    assert.equal(
      (await scoped('/overview')).counts.observations,
      0,
      'The real agent must not accept its own conversion',
    );
    const proposalId = converted.proposals.at(-1)?.id;
    assert.ok(proposalId);
    const reviewPath = `/intakes/${encodeURIComponent(uploaded.id)}/review?proposalId=${encodeURIComponent(proposalId)}`;
    let review = await scoped(reviewPath);
    const proposedLabs = review.records.filter((record) => record.kind === 'observation');
    assert.equal(
      proposedLabs.length,
      1,
      'This small source must produce exactly one laboratory observation',
    );
    assert.equal(
      proposedLabs[0].mapping.valueText,
      '1.20',
      'The literal source value must survive actual model conversion',
    );
    assert.equal(proposedLabs[0].mapping.unit, 'mg/dL');
    assert.equal(proposedLabs[0].mapping.date, '2026-01-15');
    assert.equal(proposedLabs[0].mapping.subject, 'self');
    assert.equal(
      proposedLabs[0].problem,
      null,
      'Do not force-accept a malformed model interpretation',
    );
    const unanswered = (proposedLabs[0].questions || []).filter(
      (question) => question.status === 'unanswered',
    );
    // Answer only a small, explicit fixture fact. Unrecognized questions remain
    // pending; never invent a clinical value, alter a mapping, or blanket-dismiss.
    const supportedQuestions: Array<[RegExp, string]> = [
      [/\b(self|profile owner|subject attribution|patient attribution)\b/i, identityFact],
      [
        /\b(date role|performed (?:laboratory )?(?:event )?date|event date|order date)\b/i,
        dateFact,
      ],
      [/\breference (?:range|interval)\b/i, absentFacts.reference],
      [/\bspecimen\b/i, absentFacts.specimen],
      [/\b(?:assay )?method\b/i, absentFacts.method],
      [/\b(collection time|timezone)\b/i, absentFacts.time],
      [/\b(birth date|external patient identifier)\b/i, absentFacts.identity],
    ];
    for (const question of unanswered) {
      stage(
        'fictional review question ' +
          JSON.stringify({
            field: question.field,
            prompt: question.prompt,
            locator: question.locator,
          }),
      );
      const matching = supportedQuestions.filter(([pattern]) => pattern.test(question.prompt));
      assert.ok(
        matching.length > 0,
        'The real provider asked a question outside explicit fixture facts; stop without inventing an answer',
      );
      const answer = [...new Set(matching.map(([, fact]) => fact))].join(' ');
      const current = await scoped(`/intakes/${encodeURIComponent(uploaded.id)}`);
      await scoped(`/intakes/${encodeURIComponent(uploaded.id)}/answers`, {
        method: 'POST',
        input: {
          version: current.version,
          questionId: question.id,
          operationId: `native-fixture-answer:${question.id}`,
          answer,
          mapping: {},
        },
      });
    }
    if (unanswered.length) review = await scoped(reviewPath);
    const imported = await scoped(`/intakes/${encodeURIComponent(uploaded.id)}/import`, {
      method: 'POST',
      input: {
        version: review.version,
        proposalId,
        reviewToken: review.reviewToken,
        decisions: review.records.map((record) => ({
          recordId: record.id,
          action: record.id === proposedLabs[0].id ? 'accept' : 'skip',
          mapping: {},
        })),
      },
    });
    assert.equal(imported.imported.clinical.added, 1);
    const labs = await scoped<WorkflowDto[]>('/tests');
    assert.equal(labs.length, 1);
    const before = await scoped(`/tests/${encodeURIComponent(labs[0].id)}`);
    assert.ok(before.evidence.length > 0);
    assert.equal(before.valueText, '1.20');
    const targetLabel = before.label === 'Creatinine' ? 'CREAT' : 'Creatinine';
    stage('real conversion reviewed and accepted through HTTP; one-record correction starting');
    const correctionChat = await scoped('/assistant/chats', {
      method: 'POST',
      input: {
        message: `This is a fictional validation run. For accepted observation ${before.id}, read its retained original evidence and propose ONLY a one-record display-label correction to ${JSON.stringify(targetLabel)} using health_record_correction_review with kind observation, recordId ${before.id}, set {testLabel:${JSON.stringify(targetLabel)}}, propose true and a reason grounded in the original. Both CREAT and Creatinine appear in the supplied report. Keep value, date, unit, source bytes and clinical kind unchanged. Do not apply it or create a future rule.`,
        context: { route: '/tests', selection: { collection: 'results', id: before.id } },
      },
    });
    const correctedChat = await completedChat(correctionChat.id, 'Real individual correction');
    const pending = correctedChat.proposals.filter(
      (proposal) => proposal.kind === 'clinical_correction' && proposal.status === 'pending',
    );
    assert.equal(
      pending.length,
      1,
      'The real agent must return one reviewed individual correction',
    );
    const correction = pending[0];
    assert.ok(correction);
    assert.deepEqual(correction.changes.set, { testLabel: targetLabel });
    assert.equal(correction.changes.recordId, before.id);
    assert.equal(correction.preview.after.kind, 'observation');
    assert.equal(
      (await scoped(`/tests/${encodeURIComponent(before.id)}`)).label,
      before.label,
      'The agent proposal cannot apply itself',
    );
    const applied = await scoped(`/assistant/chats/${correctedChat.id}/apply`, {
      method: 'POST',
      input: { proposalId: correction.id },
    });
    assert.equal(
      applied.proposals.find((proposal) => proposal.id === correction.id)?.status,
      'applied',
    );
    const after = await scoped(`/tests/${encodeURIComponent(before.id)}`);
    assert.equal(after.label, targetLabel);
    assert.equal(after.valueText, '1.20');
    assert.equal(after.unit, 'mg/dL');
    assert.equal(after.date, '2026-01-15');
    async function original() {
      const response = await fetch(
        url + prefix + `/sources/${encodeURIComponent(uploaded.id)}/content`,
        {
          headers: { Origin: origin, Cookie: cookie },
          signal: AbortSignal.any([t.signal, AbortSignal.timeout(30000)]),
        },
      );
      assert.equal(response.status, 200);
      return Buffer.from(await response.arrayBuffer());
    }
    assert.deepEqual(await original(), source);
    const historyPath =
      '/record-history?' + new URLSearchParams({ kind: 'observation', recordId: before.id });
    const history = await scoped(historyPath);
    assert.ok(history.entries.length >= 2);
    assert.ok(history.entries.some((entry) => entry.contents.label === targetLabel));
    await scoped('/lock', { method: 'POST', input: {} });
    rmSync(resolve(dataDirectory, 'profiles', profile.id, 'cache'), {
      recursive: true,
      force: true,
    });
    await scoped('/unlock', { method: 'POST', input: { recovery: setup.recoveryKit } });
    const reopened = app.manager.opened.get(profile.id);
    assert.ok(reopened);
    assert.equal(reopened.metrics.cacheHit, false, 'Unlock must rebuild after complete cache loss');
    assert.deepEqual(await scoped(`/tests/${encodeURIComponent(before.id)}`), after);
    assert.deepEqual(await scoped(historyPath), history);
    assert.deepEqual(await original(), source);
    stage(
      'PASS: native conversion, user acceptance, reviewed correction, unchanged original and encrypted cache-loss rebuild',
    );
  },
);
