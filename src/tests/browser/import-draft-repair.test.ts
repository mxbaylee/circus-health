import { launchBrowser, newTestPage, startBrowserRuntime } from './harness.ts';
import { stopFixtureImport } from './manual-import-fixture.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { AppOptions } from '../../server/index.ts';
import type { Browser } from 'playwright';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fictionalModel } from '../../server/test/fictional-model.ts';
import type { HealthTool } from '../../server/proxy-model-bridge.ts';

test(
  'selected draft repair reads retained original, previews, and applies through the encrypted app',
  { timeout: 60000 },
  async (t) => {
    fictionalModel(t);
    const root = mkdtempSync(resolve(tmpdir(), 'circus-browser-draft-repair-'));
    mkdirSync(resolve(root, 'data'));
    type Callbacks = Parameters<
      NonNullable<NonNullable<AppOptions['assistantOptions']>['bridgeFactory']>
    >[0];
    const starts: HealthTool[][] = [];
    let retainedOriginalText = '';
    let modelAvailable = false;
    const runtimeDirectory = createTestRuntimeDirectory();
    const runtime = await startBrowserRuntime(t, {
      dataDirectory: resolve(root, 'data'),
      runtimeDirectory,
      port: 0,
      host: '127.0.0.1',
      assistantOptions: {
        availability: () => ({ available: modelAvailable, readiness: 'ready' }),
        connectionCheck: async () => ({ available: true, readiness: 'ready' }),
        bridgeFactory(callbacks: Callbacks) {
          return {
            async start(_instructions: string, tools: HealthTool[]) {
              starts.push(tools);
              return { model: 'fictional-repair-browser', backend: 'synthetic' };
            },
            async turn(prompt: string) {
              callbacks.onEvent?.('turn/started', { turn: { id: 'fictional-repair-turn' } });
              const context = JSON.parse(prompt.slice(prompt.indexOf('{'))) as {
                mode: string;
                intakeRepair: {
                  scopeToken: string;
                  rows: {
                    recordId: string;
                    candidateVersionId: string;
                    evidence: { id: string }[];
                  }[];
                };
              };
              assert.equal(context.mode, 'selected_pending_draft_repair');
              const row = context.intakeRepair.rows[0]!;
              const source = (await callbacks.onTool?.({
                tool: 'health_intake_draft_repair_read',
                arguments: {
                  scopeToken: context.intakeRepair.scopeToken,
                  recordId: row.recordId,
                  evidenceId: row.evidence[0]!.id,
                },
                callId: 'fictional-original-read',
              })) as { original: { text: string } };
              retainedOriginalText = source.original.text;
              await callbacks.onTool?.({
                tool: 'health_intake_draft_repair_review',
                arguments: {
                  scopeToken: context.intakeRepair.scopeToken,
                  edits: [
                    {
                      recordId: row.recordId,
                      candidateVersionId: row.candidateVersionId,
                      field: 'date',
                      after: '2025-06-07',
                      evidenceIds: [row.evidence[0]!.id],
                    },
                  ],
                  unresolvedNotes: ['The retained original does not state a collection method.'],
                  reason:
                    'The selected retained-original section has one explicit collection date.',
                  propose: true,
                },
                callId: 'fictional-repair-preview',
              });
              callbacks.onEvent?.('item/completed', {
                item: {
                  id: 'fictional-repair-message',
                  type: 'agentMessage',
                  text: 'I found one source-supported date correction for review.',
                },
              });
              callbacks.onEvent?.('turn/completed', { turn: { status: 'completed' } });
            },
            async cancel() {},
            close() {},
          };
        },
      },
    });
    let browser: Browser | undefined;
    t.after(async () => {
      await browser?.close();
      await runtime.close();
      rmSync(runtimeDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    // Use the built app and isolated runtime port, as other encrypted journeys do.
    const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    browser = await launchBrowser(t);
    const page = await newTestPage(browser, { viewport: { width: 1440, height: 1000 } });
    await page.goto(url);
    const setup = await page.evaluate(async () => {
      const post = async (path: string, body: unknown) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw Error(await response.text());
        return (await response.json()).data;
      };
      const created = await post('/api/profile-setups', {
        fullName: 'Fictional repair browser',
        birthDate: '1982-04-17',
        name: 'Fictional repair browser',
      });
      return post(`/api/profile-setups/${created.setupId}/verify`, {
        acknowledged: true,
        recovery: created.recoveryKit,
      });
    });
    const prefix = `/api/profiles/${setup.id}`;
    const profilesResponse = await page.request.get(url + '/api/profiles');
    const profilesBody = await profilesResponse.json();
    assert(profilesResponse.ok(), JSON.stringify(profilesBody));
    assert.equal(profilesBody.data.length, 1);
    const original =
      'Fictional comparison section\nCollection date: 2025-06-07\nNo other date applies.\n';
    const uploadedResponse = await page.request.post(url + prefix + '/intakes', {
      headers: {
        Origin: url,
        'Content-Type': 'text/plain',
        'X-Filename': 'fictional-original.txt',
      },
      data: original,
    });
    assert.equal(uploadedResponse.status(), 201);
    const uploaded = await stopFixtureImport(
      page,
      url,
      prefix,
      (await uploadedResponse.json()).data.id,
    );
    modelAvailable = true;
    const proposedResponse = await page.request.post(
      url + prefix + `/intakes/${encodeURIComponent(uploaded.id)}/proposals`,
      {
        headers: { Origin: url },
        data: {
          version: uploaded.version,
          summary: 'Fictional incomplete model-shaped draft',
          jsonlText: JSON.stringify({
            format: 'health-record-v1',
            id: 'fictional-original-only-date',
            kind: 'record',
            payload: { literal: 'The first model omitted the collection date.' },
            clinical: {
              kind: 'observation',
              subject: 'unknown',
              testLabel: 'Fictional original-only date',
              valueText: '7',
              unit: 'fictional units',
            },
            provenance: {
              capturedVia: 'Fictional browser upload',
              sourceSystem: 'Fictional clinic',
              sourceRecordId: 'fictional-original-only-date',
              evidenceClass: 'transcription',
              locator: 'characters 0–78',
            },
            report: {
              key: 'fictional-repair-report',
              title: 'Fictional repair report',
              anchor: { locator: 'characters 0–30', text: 'Fictional comparison section' },
              subject: null,
            },
            coverage: { status: 'partial', notes: ['One fictional section supplied'] },
          }),
        },
      },
    );
    const proposedBody = await proposedResponse.json();
    assert(proposedResponse.ok(), JSON.stringify(proposedBody));
    await page.goto(url + '/#/import');
    await page.reload();
    await page.getByText('Fictional original-only date', { exact: true }).waitFor();
    assert.match(await page.locator('body').innerText(), /Fictional original-only date/);
    await page
      .getByRole('checkbox', { name: 'Select Fictional original-only date', exact: true })
      .check();
    await page.getByRole('button', { name: 'Correct selected fields', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Correct selected drafts' });
    await sheet
      .getByLabel('Ask Moxie to check these source sections')
      .fill('Recover the missing collection date from the selected original section.');
    await sheet.getByRole('button', { name: 'Ask for a source-linked preview' }).click();
    const assistant = page.getByRole('dialog', { name: 'Moxie the Assistant' });
    await assistant.waitFor();
    await assistant.getByRole('button', { name: 'Send', exact: true }).click();
    await assistant
      .getByRole('region', { name: 'Selected import draft correction preview' })
      .waitFor();
    assert.match(retainedOriginalText, /2025-06-07/);
    assert.deepEqual(
      starts[0]!.map((tool) => tool.name).sort(),
      [
        'health_assistant_progress',
        'health_intake_draft_repair_read',
        'health_intake_draft_repair_review',
      ].sort(),
    );
    await assistant.getByText('Not supplied → 2025-06-07', { exact: false }).waitFor();
    const appliedResponse = page.waitForResponse(
      (response) => response.url().endsWith('/apply') && response.request().method() === 'POST',
    );
    await assistant.getByRole('button', { name: 'Apply reviewed change' }).click();
    const applied = await appliedResponse;
    assert(applied.ok(), await applied.text());
    const review = await page.request.get(
      url +
        prefix +
        `/intakes/${encodeURIComponent(uploaded.id)}/review?proposalId=${encodeURIComponent(proposedBody.data.proposals[0].id)}`,
    );
    assert(review.ok(), await review.text());
    assert.equal((await review.json()).data.records[0].mapping.date, '2025-06-07');
  },
);
