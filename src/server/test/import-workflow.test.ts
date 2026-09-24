import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase } from '../database.ts';
import { createApp } from '../index.ts';
import { rebuildProfile } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import type { HealthTool, ProxyModelBridgeOptions } from '../proxy-model-bridge.ts';
import type { AssistantChat } from '../assistant.ts';

interface WorkflowEvidence {
  imageContent: string;
  metadata: {
    intake: { version: number };
    original: {
      text: string;
      assets: Array<{ id: string; mimeType: string; derivative: boolean }>;
    };
  };
}
interface MappingProposal {
  id: string;
}
interface WorkflowPrompt {
  profileId?: string;
  intakeId?: string;
}
interface ApiData {
  id: string;
  state: string;
  version: number;
  providerId: string;
  repeatedUpload: boolean;
  chatId: string;
  status: string;
  counts: { observations: number };
  operations: Array<{ tool: string }>;
  proposals: Array<{ id: string; status: string }>;
  summary: { additions: number };
  records: Array<{
    id: string;
    candidateVersionId: string;
    mapping: Record<string, unknown>;
    issues: Array<{ id: string; kind: string; status: string }>;
  }>;
  reviewToken: string;
  imported: { clinical: { added: number } };
  label: string;
  valueText: string;
  attachments: Array<{ asset: { mimeType: string; originalName: string } }>;
  evidence: Array<{ locator: { originalSourceFileId: string; locator: string } }>;
}

function syntheticPdf(text: string) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
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

async function waitFor<T>(read: () => Promise<T | null>, description: string): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test(
  'HTTP assistant conversion imports reviewed PDF evidence and survives loss of SQLite',
  { timeout: 15000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'health-import-workflow-')),
      profileId = 'orchid';
    const paths = ensureProfileDirectories(root, profileId),
      db = openDatabase(paths.database, profileId);
    const databases = new Map([[profileId, db]]),
      bridgeState: {
        prompts: WorkflowPrompt[];
        evidence: WorkflowEvidence | null;
        providerId: string | null;
        mappingProposal: MappingProposal | null;
      } = { prompts: [], evidence: null, providerId: null, mappingProposal: null };
    let callNumber = 0;
    const bridgeFactory = (
      callbacks: Omit<ProxyModelBridgeOptions, 'config'> & { profileId?: string },
    ) => ({
      async start(_instructions: string, tools: HealthTool[]) {
        assert.ok(tools.some((tool) => tool.name === 'health_intake_read'));
        assert.ok(tools.some((tool) => tool.name === 'health_intake_propose'));
        assert.ok(tools.some((tool) => tool.name === 'health_mapping_review'));
        return { model: 'synthetic-workflow' };
      },
      async turn(prompt: string) {
        const context = JSON.parse(prompt.slice(prompt.indexOf('{'))) as WorkflowPrompt;
        bridgeState.prompts.push(context);
        callbacks.onEvent?.('turn/started', {
          turn: { id: `turn-${bridgeState.prompts.length}` },
        });
        if (context.intakeId) {
          assert.ok(callbacks.onTool);
          bridgeState.evidence = (await callbacks.onTool({
            tool: 'health_intake_read',
            arguments: { id: context.intakeId, page: 1 },
            callId: `call-${++callNumber}`,
          })) as WorkflowEvidence;
          const envelope = {
            format: 'health-record-v1',
            id: 'workflow-observation',
            kind: 'record',
            payload: { verbatim: 'Workflow test 7.20 mg/dL' },
            clinical: {
              kind: 'observation',
              subject: 'self',
              testLabel: 'Workflow test',
              date: '2026-08',
              valueText: '7.20',
              unit: 'mg/dL',
              referenceText: '5.00–10.00',
              assets: [context.intakeId],
              uncertainties: [],
            },
            provenance: {
              capturedVia: 'Synthetic PDF conversion',
              sourceSystem: 'Workflow clinic',
              sourceRecordId: 'workflow-observation',
              evidenceClass: 'provider_export',
              locator: 'synthetic.pdf page 1',
            },
            coverage: { status: 'complete_response', notes: [] },
          };
          await callbacks.onTool({
            tool: 'health_intake_propose',
            arguments: {
              id: context.intakeId,
              version: bridgeState.evidence.metadata.intake.version,
              jsonlText: JSON.stringify(envelope),
              summary: 'Read the only PDF page and retained its visible value and source locator.',
            },
            callId: `call-${++callNumber}`,
          });
        } else {
          assert.ok(callbacks.onTool);
          bridgeState.mappingProposal = (await callbacks.onTool({
            tool: 'health_mapping_review',
            arguments: {
              providerId: bridgeState.providerId,
              kind: 'observation',
              label: 'Workflow test',
              set: { testLabel: 'Assistant reviewed workflow test' },
              propose: true,
              reason: 'Use the reviewed display label for this exact source label.',
            },
            callId: `call-${++callNumber}`,
          })) as MappingProposal;
        }
        callbacks.onEvent?.('item/completed', {
          item: {
            id: `reply-${bridgeState.prompts.length}`,
            type: 'agentMessage',
            text: 'Synthetic workflow completed.',
          },
        });
        callbacks.onEvent?.('turn/completed', { turn: { status: 'completed' } });
      },
      async cancel() {},
      close() {},
    });
    const app = createApp({
      root,
      databases,
      assistantOptions: {
        availability: () => ({ available: true }),
        connectionCheck: async ({ image, pdf }) => {
          assert.equal(
            pdf,
            true,
            'PDF conversion checks native or image capability before starting',
          );
          assert.equal(image, false, 'An original PDF is distinct from an image source');
          return { available: true, capabilities: { tools: true, images: true } };
        },
        bridgeFactory,
      },
    });
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()));
    let closed = false;
    t.after(() => {
      if (!closed) app.close();
      rmSync(root, { recursive: true, force: true });
    });
    const origin = 'http://127.0.0.1:5173',
      headers = { Origin: origin, 'Content-Type': 'application/json' };
    const api = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/${profileId}`;
    const request = async <T = ApiData>(path: string, options: RequestInit = {}): Promise<T> => {
      const response = await fetch(api + path, options);
      const payload = (await response.json()) as { data: T; error?: unknown };
      assert.equal(
        response.ok,
        true,
        `${options.method || 'GET'} ${path}: ${JSON.stringify(payload.error)}`,
      );
      return payload.data;
    };

    assert.equal((await request('/overview')).counts.observations, 0);
    const pdf = syntheticPdf('Workflow test 7.20 mg/dL');
    const uploaded = await request('/intakes', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/pdf',
        'X-Filename': 'synthetic.pdf',
        'X-Source-Name': 'Workflow clinic',
      },
      body: pdf,
    });
    bridgeState.providerId = uploaded.providerId;
    assert.equal(uploaded.state, 'pending_conversion');
    assert.equal(db.prepare('SELECT count(*) n FROM observations').get()?.n, 0);

    const conversion = await request(`/intakes/${encodeURIComponent(uploaded.id)}/convert`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ version: uploaded.version }),
    });
    const conversionChat = await waitFor(async () => {
      const chat = await request<AssistantChat>(`/assistant/chats/${conversion.chatId}`);
      return chat.status === 'idle' ? chat : null;
    }, 'assistant conversion');
    assert.deepEqual(conversionChat.context, {
      route: `#/import?intake=${encodeURIComponent(uploaded.id)}`,
      intakeId: uploaded.id,
    });
    assert.equal(bridgeState.prompts[0]?.profileId, profileId);
    assert.equal(bridgeState.prompts[0]?.intakeId, uploaded.id);
    const evidence = bridgeState.evidence;
    assert.ok(evidence);
    assert.match(evidence.imageContent, /^data:image\/png;base64,/);
    assert.match(evidence.metadata.original.text, /Workflow test 7\.20/);
    assert.deepEqual(
      evidence.metadata.original.assets.map((asset) => ({
        id: asset.id,
        mimeType: asset.mimeType,
        derivative: asset.derivative,
      })),
      [{ id: uploaded.id, mimeType: 'application/pdf', derivative: false }],
    );
    assert.deepEqual(
      conversionChat.operations.map((operation) => operation.tool),
      ['health_intake_read', 'health_intake_propose'],
    );
    assert.equal(
      db.prepare('SELECT count(*) n FROM observations').get()?.n,
      0,
      'assistant proposal cannot create clinical rows',
    );

    const converted = await request(`/intakes/${encodeURIComponent(uploaded.id)}`);
    assert.equal(converted.proposals.length, 1);
    const proposal = converted.proposals[0];
    assert.ok(proposal);
    const proposalId = proposal.id;
    let review = await request(
      `/intakes/${encodeURIComponent(uploaded.id)}/review?proposalId=${encodeURIComponent(proposalId)}`,
    );
    assert.equal(review.summary.additions, 1);
    assert.equal(
      db.prepare('SELECT count(*) n FROM observations').get()?.n,
      0,
      'review remains read-only',
    );
    const reviewRecord = review.records[0];
    assert.ok(reviewRecord);
    const identity = reviewRecord.issues.find((issue) => issue.kind === 'identity');
    assert.ok(identity);
    assert.equal(identity.status, 'unresolved');
    await request(`/intakes/${encodeURIComponent(uploaded.id)}/review-draft`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: review.version,
        operationId: 'confirm-workflow-self',
        proposalId,
        recordId: reviewRecord.id,
        candidateVersionId: reviewRecord.candidateVersionId,
        resolutions: [
          { issueId: identity.id, outcome: 'this_is_me', mapping: { subject: 'self' } },
        ],
      }),
    });
    review = await request(
      `/intakes/${encodeURIComponent(uploaded.id)}/review?proposalId=${encodeURIComponent(proposalId)}`,
    );
    const decisions = review.records.map((record) => ({
      recordId: record.id,
      action: 'accept',
      mapping: record.mapping,
    }));
    const imported = await request(`/intakes/${encodeURIComponent(uploaded.id)}/import`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: review.version,
        proposalId,
        reviewToken: review.reviewToken,
        decisions,
      }),
    });
    assert.equal(imported.imported.clinical.added, 1);

    let observations = await request<ApiData[]>('/tests');
    assert.equal(observations.length, 1);
    const observation = observations[0];
    assert.ok(observation);
    assert.equal(observation.label, 'Workflow test');
    assert.equal(observation.valueText, '7.20');
    let detail = await request(`/tests/${encodeURIComponent(observation.id)}`);
    assert.equal(detail.attachments.length, 1);
    assert.equal(detail.attachments[0]?.asset.mimeType, 'application/pdf');
    assert.equal(detail.attachments[0]?.asset.originalName, 'synthetic.pdf');
    assert.equal(detail.evidence[0]?.locator.originalSourceFileId, uploaded.id);
    assert.equal(detail.evidence[0]?.locator.locator, 'synthetic.pdf page 1');

    const repeated = await request('/intakes', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/pdf',
        'X-Filename': 'synthetic.pdf',
        'X-Source-Id': uploaded.providerId,
      },
      body: pdf,
    });
    assert.equal(repeated.repeatedUpload, true);
    assert.equal(repeated.id, uploaded.id);
    assert.equal(db.prepare('SELECT count(*) n FROM observations').get()?.n, 1);

    const mappingChat = await request('/assistant/chats', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'Propose the reviewed exact-label mapping.' }),
    });
    const mappedChat = await waitFor(async () => {
      const chat = await request(`/assistant/chats/${mappingChat.id}`);
      return chat.status === 'idle' ? chat : null;
    }, 'assistant mapping proposal');
    assert.equal(bridgeState.prompts[1]?.profileId, profileId);
    assert.equal(mappedChat.proposals.length, 1);
    const mappedProposal = mappedChat.proposals[0];
    assert.ok(mappedProposal);
    assert.ok(bridgeState.mappingProposal);
    assert.equal(mappedProposal.id, bridgeState.mappingProposal.id);
    assert.equal(
      (
        await request(`/assistant/chats/${mappedChat.id}/apply`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ proposalId: mappedProposal.id }),
        })
      ).proposals[0]?.status,
      'applied',
    );
    observations = await request<ApiData[]>('/tests');
    assert.equal(observations[0]?.label, 'Assistant reviewed workflow test');
    detail = await request(`/tests/${encodeURIComponent(observations[0]?.id ?? '')}`);
    assert.equal(detail.attachments[0]?.asset.mimeType, 'application/pdf');

    app.close();
    closed = true;
    rmSync(paths.database, { force: true });
    rmSync(paths.database + '-wal', { force: true });
    rmSync(paths.database + '-shm', { force: true });
    assert.equal(existsSync(paths.database), false);
    const rebuiltRoot = resolve(root, 'rebuilt'),
      rebuilt = rebuildProfile(root, profileId, rebuiltRoot);
    const recovered = openDatabase(rebuilt.database, profileId);
    try {
      assert.equal(recovered.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      assert.equal(
        recovered.prepare('SELECT label FROM observations').get()?.label,
        'Assistant reviewed workflow test',
      );
      assert.equal(recovered.prepare('SELECT count(*) n FROM observations').get()?.n, 1);
      assert.equal(recovered.prepare('SELECT count(*) n FROM attachments').get()?.n, 1);
      assert.equal(
        recovered.prepare('SELECT mime_type FROM assets').get()?.mime_type,
        'application/pdf',
      );
      assert.equal(recovered.prepare('SELECT count(*) n FROM source_records').get()?.n, 1);
    } finally {
      recovered.close();
    }
  },
);
