import test from 'node:test';
import assert from 'node:assert/strict';
import timers from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createVaultApp } from '../vault-app.ts';
import { readChat } from '../assistant-journal.ts';
import { getIntakeOriginal } from '../intake.ts';
import { fictionalModel } from './fictional-model.ts';
import { deferred } from './helpers/vault-fixture.ts';
import {
  captureManagedPhysicalEpoch,
  managedPhysicalEpochCurrent,
} from '../clinical-review-physical-epoch.ts';
import type { ProxyModelBridgeOptions } from '../proxy-model-bridge.ts';

type Callbacks = Omit<ProxyModelBridgeOptions, 'config'>;
for (const boundary of [
  'completed',
  'stream-item',
  'provider-error',
  'progress-tool',
  'late-accounting',
  'assistant-route',
] as const)
  test(`encrypted ordinary upload admits prior assistant ${boundary} publication after its original proof`, async (t) => {
    fictionalModel(t);
    const entered = deferred<void>(),
      preflight = deferred<{ available: boolean }>();
    let callbacks!: Callbacks;
    let requests = 0;
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'fictional-assistant-bridge-')));
    mkdirSync(join(base, 'data'));
    const app = createVaultApp({
      dataDirectory: join(base, 'data'),
      runtimeDirectory: join(base, 'runtime'),
      assistantOptions: {
        availability: async () => ({
          available: boundary !== 'assistant-route',
          readiness: 'ready',
        }),
        connectionCheck: async () => {
          if (boundary === 'assistant-route') {
            entered.resolve();
            return preflight.promise;
          }
          return { available: true, readiness: 'ready' };
        },
        bridgeFactory(value) {
          callbacks = value;
          return {
            async start() {
              return { model: 'fictional-held-model' };
            },
            async turn() {
              await value.beforeRequest?.();
              requests++;
              await value.onEvent?.('turn/started', { turn: { id: 'fictional-held-turn' } });
              entered.resolve();
            },
            async cancel() {},
            close() {},
          };
        },
      },
    });
    t.after(() => {
      preflight.resolve({ available: false });
      app.close();
      rmSync(base, { recursive: true, force: true });
    });
    await new Promise<void>((ready) => app.server.listen(0, '127.0.0.1', ready));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    let cookie = '';
    async function send(path: string, body?: string | Blob, headers: Record<string, string> = {}) {
      const response = await fetch(url + path, {
        ...(body === undefined ? {} : { method: 'POST', body }),
        headers: {
          Origin: 'http://127.0.0.1:5173',
          'Content-Type': 'application/json',
          ...headers,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
      const set = response.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0]!;
      return response;
    }
    const setup = await send(
      '/api/profile-setups',
      JSON.stringify({
        fullName: 'Fictional Aspen Doe',
        birthDate: '1977-04-12',
        name: 'Fictional Aspen Doe',
        placebo: false,
      }),
    );
    assert.equal(setup.status, 201);
    const kit = (await setup.json()) as { data: { setupId: string; recoveryKit: unknown } };
    const verified = await send(
      `/api/profile-setups/${kit.data.setupId}/verify`,
      JSON.stringify({ acknowledged: true, recovery: kit.data.recoveryKit }),
    );
    assert.equal(verified.status, 201);
    const profileId = ((await verified.json()) as { data: { id: string } }).data.id;
    const prefix = `/api/profiles/${profileId}`;
    const state = app.manager.opened.get(profileId)!;
    const upload = (name: string) =>
      send(prefix + '/intakes', new Blob([`Fictional ${name} source.\n`], { type: 'text/plain' }), {
        'Content-Type': 'text/plain',
        'X-Filename': name,
      });
    const first = await upload('fictional-aspen.txt');
    assert.equal(first.status, 201, await first.clone().text());
    const original = ((await first.json()) as { data: { id: string } }).data.id;
    await entered.promise;
    const originalBytes = readFileSync(
      getIntakeOriginal(state.db, state.root, profileId, original).path,
    );
    const history = () =>
      state.db
        .prepare(
          "SELECT version_id,contents_json,metadata_json FROM __record_versions WHERE entity='source_files' AND record_id=? ORDER BY version_id",
        )
        .all(JSON.stringify([original]));
    const accepted = history();
    assert.ok(accepted.length);
    const batchResponse = await send(prefix + '/intake-batches');
    assert.equal(batchResponse.status, 200);
    const batches = (await batchResponse.json()) as {
      data: { items: { chatId?: string }[]; status: string }[];
    };
    let chatId =
      batches.data.find((batch) => batch.status === 'running')!.items.find((item) => item.chatId)
        ?.chatId || '';
    const receipt = {
      requestId: 'fictional-paid-request',
      failed: false,
      outcome: 'response',
      usage: { inputTokens: 100, cachedInputTokens: 30, outputTokens: 10 },
      status: null,
      classification: null,
      retryAt: null,
    };
    if (boundary === 'late-accounting') {
      await callbacks.onEvent?.('model/requestStarted', {
        requestId: receipt.requestId,
        requestDigest: 'a'.repeat(64),
        requestBytes: 456,
        model: 'fictional-held-model',
        attempt: 1,
      });
      const cancelled = await send(prefix + '/assistant/chats/' + chatId + '/cancel', '{}');
      assert.equal(cancelled.status, 200);
    }
    let lateFlushFailures = 0;
    if (boundary === 'late-accounting') {
      const nativeFlush = app.manager.flush.bind(app.manager);
      t.mock.method(app.manager, 'flush', (...args: Parameters<typeof app.manager.flush>) => {
        if (
          !lateFlushFailures &&
          new Error().stack?.includes('withVaultAssistantRequestAccounting')
        ) {
          lateFlushFailures++;
          throw new Error('Fictional late accounting flush failed');
        }
        return nativeFlush(...args);
      });
    }
    let acknowledged = false,
      releases = 0;
    let task: Promise<unknown> | undefined;
    const observations: boolean[] = [];
    const nativeImmediate = timers.setImmediate;
    t.mock.method(
      timers,
      'setImmediate',
      async (...args: Parameters<typeof timers.setImmediate>) => {
        if (!releases && new Error().stack?.includes('prepareIntakeLegacyBridgeProofAsync')) {
          releases++;
          const epoch = captureManagedPhysicalEpoch()!;
          task = Promise.resolve(
            boundary === 'assistant-route'
              ? send(
                  prefix + '/assistant/chats',
                  JSON.stringify({ title: 'Fictional overlapping conversation' }),
                )
              : boundary === 'late-accounting'
                ? callbacks.onEvent?.('model/requestFinished', receipt)
                : boundary === 'completed'
                  ? callbacks.onEvent?.('turn/completed', { turn: { status: 'completed' } })
                  : boundary === 'stream-item'
                    ? callbacks.onEvent?.('item/completed', {
                        item: {
                          id: 'fictional-message',
                          type: 'agentMessage',
                          text: 'Fictional retained message.',
                        },
                      })
                    : boundary === 'provider-error'
                      ? callbacks.onExit?.(new Error('Fictional provider failure.'))
                      : callbacks.onTool?.({
                          callId: 'fictional-progress',
                          tool: 'health_assistant_progress',
                          arguments: { text: 'Reviewing fictional source.' },
                        }),
          )
            .then(async (result) => {
              if (boundary === 'assistant-route') {
                const response = result as Response;
                assert.equal(response.status, 200);
                chatId = ((await response.json()) as { data: { id: string } }).data.id;
              }
              acknowledged = true;
              return result;
            })
            .catch((error: unknown) => {
              acknowledged = true;
              return error;
            });
          await nativeImmediate();
          observations.push(managedPhysicalEpochCurrent(epoch));
          assert.equal(acknowledged, false, 'callback acknowledgement waits for journal admission');
        }
        return nativeImmediate(...args);
      },
    );
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const second = await upload('fictional-willow.txt');
    const body = await second.text();
    assert.equal(releases, 1);
    assert.equal(second.status, 201, body);
    assert.deepEqual(observations, [true]);
    const result = await task;
    assert.equal(acknowledged, true);
    if (boundary === 'late-accounting') {
      assert.equal(lateFlushFailures, 1);
      assert.match(String(result), /Fictional late accounting flush failed/);
      await callbacks.onEvent?.('model/requestFinished', receipt);
    } else assert.equal(result instanceof Error, false, String(result));
    const saved = readChat(state.root, profileId, chatId) as {
      status: string;
      error: string | null;
      messages: { content: string }[];
      operations: { tool: string }[];
      intakeModelAttempts: {
        outcome: string;
        usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null;
        lateResponse?: { usage: { inputTokens: number } };
      }[];
    };
    if (boundary === 'completed' || boundary === 'assistant-route')
      assert.equal(saved.status, 'idle');
    else if (boundary === 'late-accounting') {
      assert.equal(saved.status, 'cancelled');
      assert.equal(saved.intakeModelAttempts[0]!.outcome, 'unknown');
      assert.equal(saved.intakeModelAttempts[0]!.usage?.inputTokens, 100);
      assert.equal(saved.intakeModelAttempts[0]!.usage?.cachedInputTokens, 30);
      assert.equal(saved.intakeModelAttempts[0]!.usage?.outputTokens, 10);
      assert.equal(saved.intakeModelAttempts[0]!.lateResponse?.usage.inputTokens, 100);
      const replayEpoch = captureManagedPhysicalEpoch()!;
      await callbacks.onEvent?.('model/requestFinished', receipt);
      assert.equal(
        managedPhysicalEpochCurrent(replayEpoch),
        true,
        'identical accounting replay makes no durable write',
      );
      await assert.rejects(
        async () =>
          callbacks.onEvent?.('model/requestFinished', { ...receipt, usage: { inputTokens: 999 } }),
        /Conflicting late provider usage/,
      );
      assert.deepEqual(readChat(state.root, profileId, chatId), saved);
    } else if (boundary === 'provider-error') {
      assert.equal(saved.status, 'failed');
      assert.match(saved.error!, /Fictional provider failure/);
    } else if (boundary === 'stream-item')
      assert.ok(
        saved.messages.some((message) => message.content === 'Fictional retained message.'),
      );
    else
      assert.ok(
        saved.operations.some((operation) => operation.tool === 'health_assistant_progress'),
      );
    assert.equal(
      requests,
      boundary === 'assistant-route' ? 0 : 1,
      'publication never retries the model',
    );
    assert.deepEqual(
      readFileSync(getIntakeOriginal(state.db, state.root, profileId, original).path),
      originalBytes,
    );
    assert.deepEqual(history(), accepted, 'original accepted versions remain unchanged');
    assert.equal((await fetch(url + prefix + '/intakes/' + original)).status, 423);
    t.diagnostic(
      JSON.stringify({ boundary, releases, requests, acknowledged, physicalHeld: observations }),
    );
    if (boundary === 'stream-item') {
      const cancelled = await send(prefix + '/assistant/chats/' + chatId + '/cancel', '{}');
      assert.equal(cancelled.status, 200);
      const retiredEpoch = captureManagedPhysicalEpoch()!;
      await callbacks.onExit?.(new Error('Fictional retired provider error.'));
      assert.equal(
        managedPhysicalEpochCurrent(retiredEpoch),
        true,
        'retired exit is an acknowledged no-op',
      );
      await assert.rejects(async () => callbacks.beforeRequest?.(), /Assistant access changed/);
    }
    if (boundary === 'late-accounting') {
      const locked = await send(prefix + '/lock', '{}');
      assert.equal(locked.status, 200);
      const manifest = join(base, 'data', 'profiles', profileId, 'vault', 'manifest.enc');
      const ciphertext = readFileSync(manifest);
      await assert.rejects(
        async () => callbacks.onEvent?.('model/requestFinished', receipt),
        /accounting access changed/,
      );
      assert.deepEqual(readFileSync(manifest), ciphertext);
      assert.equal((await send(prefix + '/assistant/chats/' + chatId)).status, 423);
    }
  });
