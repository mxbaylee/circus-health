import { fixtureApi, fixtureReview, fixtureSourcePath } from './native-intake-fixture.ts';
import { launchBrowser, newTestPage, startBrowserRuntime } from './harness.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import { fictionalModel } from '../../server/test/fictional-model.ts';

test(
  'encrypted browser previews selected ownership, reconciles a lost response and preserves originals across reload',
  { timeout: 60000 },
  async (t) => {
    fictionalModel(t);
    const root = mkdtempSync(resolve(tmpdir(), 'fictional-ownership-browser-'));
    mkdirSync(resolve(root, 'data'));
    const runtimeDirectory = createTestRuntimeDirectory();
    const runtime = await startBrowserRuntime(t, {
      dataDirectory: resolve(root, 'data'),
      runtimeDirectory,
      port: 0,
      host: '127.0.0.1',
      assistantOptions: { availability: () => ({ available: false, readiness: 'unavailable' }) },
    });
    const browser = await launchBrowser(t);
    t.after(async () => {
      await browser.close();
      await runtime.close();
      rmSync(runtimeDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    const page = await newTestPage(browser, { viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const failureDetails = async () => {
      return JSON.stringify({
        pageErrors: errors,
        dialogs: await page
          .getByRole('dialog')
          .allTextContents()
          .catch(() => []),
        alerts: await page
          .getByRole('alert')
          .allTextContents()
          .catch(() => []),
      });
    };
    const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    await page.goto(url);
    const seed = await page.evaluate(async () => {
      const request = async (path: string, body?: unknown, raw?: string) => {
        const response = await fetch(path, {
          method: body !== undefined || raw !== undefined ? 'POST' : 'GET',
          headers: {
            'Content-Type': raw !== undefined ? 'application/x-ndjson' : 'application/json',
            ...(raw !== undefined ? { 'X-Filename': 'fictional-ownership.jsonl' } : {}),
          },
          body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        });
        if (!response.ok) throw Error(await response.text());
        return (await response.json()).data;
      };
      const setup = await request('/api/profile-setups', {
        fullName: 'Fictional Cedar',
        birthDate: '1982-04-17',
        name: 'Fictional Cedar',
      });
      const profile = await request(`/api/profile-setups/${setup.setupId}/verify`, {
        acknowledged: true,
        recovery: setup.recoveryKit,
      });
      const prefix = `/api/profiles/${profile.id}`;
      const person = await request(prefix + '/notes', {
        kind: 'person',
        title: 'Robin Lane',
        person: { fullName: 'Robin Lane' },
      });
      const original = ['one', 'two']
        .map((id, i) =>
          JSON.stringify({
            format: 'health-record-v1',
            id,
            kind: 'record',
            payload: { literal: 'Fictional sample ' + id },
            provenance: {
              sourceSystem: 'Fictional Brook Lab',
              capturedVia: null,
              sourceRecordId: id,
              evidenceClass: 'provider_export',
              locator: 'Fictional row ' + id,
            },
            coverage: { status: 'complete_response', notes: [] },
            clinical: {
              kind: 'observation',
              subject: 'self',
              testLabel: 'Fictional sample ' + id,
              date: '2026-02-10',
              valueText: String(12 + i) + '.00',
              unit: 'mg',
            },
          }),
        )
        .join('\n');
      const intake = await request(prefix + '/intakes', undefined, original);
      const path = prefix + '/intakes/' + encodeURIComponent(intake.id);
      return { prefix, path, person, original, contentUrl: intake.contentUrl, intakeId: intake.id };
    });
    const api = fixtureApi(page, url);
    const path = seed.path;
    const review = await fixtureReview(api, path + '/review');
    await api(path + '/import', {
      version: review.version,
      reviewToken: review.reviewToken,
      decisions: review.records.map((r: { id: string }) => ({
        recordId: r.id,
        action: 'accept',
        mapping: {},
      })),
    });
    await page.goto(url + '/#/tests');
    await page.reload();
    await page
      .getByRole('button', { name: 'Select records to change person', exact: true })
      .click();
    const selection = page.getByRole('group', { name: 'Saved records to move' });
    await selection.getByRole('checkbox').nth(0).check();
    await selection.getByRole('checkbox').nth(1).check();
    await selection.getByRole('button', { name: 'Move selected records', exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Move these saved records and all their sources',
    });
    await dialog.getByLabel('Destination person').selectOption({ label: 'Robin Lane' });
    await dialog.getByRole('button', { name: 'Preview correction', exact: true }).click();
    try {
      await dialog
        .getByRole('button', { name: 'Confirm person correction', exact: true })
        .waitFor();
    } catch (cause) {
      throw new Error(
        'Native ownership preview did not offer confirmation: ' + (await failureDetails()),
        { cause },
      );
    }
    assert.match(await dialog.innerText(), /2 saved records and 0 pending/);
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1280, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    let operationId = '';
    await page.route('**/record-ownership', async (route) => {
      operationId = (route.request().postDataJSON() as { operationId: string }).operationId;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort('failed');
    });
    await dialog.getByRole('button', { name: 'Confirm person correction', exact: true }).click();
    try {
      await page.getByRole('dialog', { name: 'Person correction saved' }).waitFor();
    } catch (cause) {
      throw new Error('Native ownership save did not reconcile: ' + (await failureDetails()), {
        cause,
      });
    }
    assert.ok(operationId);
    await page.unroute('**/record-ownership');
    const state = await page.evaluate(
      async ({ prefix, personId, operationId, originalUrl }) => {
        const get = async (path: string) => {
          const r = await fetch(path);
          if (!r.ok) throw Error(await r.text());
          return (await r.json()).data;
        };
        return {
          self: await get(prefix + '/tests?personId=patient'),
          destination: await get(prefix + '/tests?personId=' + encodeURIComponent(personId)),
          receipt: await get(prefix + '/record-ownership/' + operationId),
          original: await (
            await fetch(
              originalUrl.startsWith('/api/profiles/')
                ? originalUrl
                : prefix + originalUrl.slice(4),
            )
          ).text(),
        };
      },
      {
        prefix: seed.prefix,
        personId: seed.person.personId,
        operationId,
        originalUrl: fixtureSourcePath(seed.prefix, seed.contentUrl),
      },
    );
    assert.equal(state.self.length, 0);
    assert.equal(state.destination.length, 2);
    assert.equal(state.receipt.moved, 2);
    assert.equal(state.original, seed.original);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.reload();
    const receipt = await page.evaluate(
      async ({ prefix, operationId }) =>
        (await (await fetch(prefix + '/record-ownership/' + operationId)).json()).data,
      { prefix: seed.prefix, operationId },
    );
    assert.equal(receipt.moved, 2);
    assert.equal(receipt.replayed, true);
    assert.deepEqual(errors, []);
    const unauthenticated = await browser.newContext();
    try {
      const response = await unauthenticated.request.get(
        url + seed.prefix + '/record-ownership/' + operationId,
      );
      assert.ok([401, 403, 423].includes(response.status()));
    } finally {
      await unauthenticated.close();
    }
    const locked = await page.evaluate(
      async ({ prefix, operationId }) => {
        const lock = await fetch(prefix + '/lock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!lock.ok) throw Error(await lock.text());
        return (await fetch(prefix + '/record-ownership/' + operationId)).status;
      },
      { prefix: seed.prefix, operationId },
    );
    assert.equal(locked, 423);
  },
);
