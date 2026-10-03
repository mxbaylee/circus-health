import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { createAssistant } from '../assistant.ts';
import { readChat, writeChat } from '../assistant-journal.ts';
import { ProxyModelBridge } from '../proxy-model-bridge.ts';
import { uploadIntake, linkIntakeConversion } from '../intake.ts';
import { extractIntakeSourceText } from '../intake-source-extraction.ts';
import { fictionalModel } from './fictional-model.ts';
import type { RecordedIntakeModelAttempt } from '../intake-model-attempts.ts';

type Mode = 'response' | 'rejected' | 'unknown' | 'journal-failure';
async function fixture(t: TestContext, mode: Mode) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-attempt-integration-'));
  const profileId = 'fictional-attempt-owner';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const objects = new Map<string, Buffer>();
  attachPersonalDurability(db, {
    root,
    profileId,
    recordStorage: {
      read: (name) => objects.get(name) || null,
      writeImmutable: (name, bytes) => {
        assert(!objects.has(name));
        objects.set(name, Buffer.from(bytes));
      },
      publishHead: (bytes) => {
        objects.set('head', Buffer.from(bytes));
      },
    },
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-attempt.txt',
    bytes: Buffer.from('Fictional source. No fever. Administrative wording kept.'),
    newProviderName: 'Fictional clinic',
  });
  const extracted = await extractIntakeSourceText({ db, root, profileId, id: source.id });
  let chatId = '',
    calls = 0;
  const seen: RecordedIntakeModelAttempt[] = [];
  const httpErrors: Error[] = [];
  const server = createServer(async (request, response) => {
    calls++;
    for await (const _ of request) {
    }
    try {
      const durable = readChat(root, profileId, chatId) as {
        intakeModelAttempts: RecordedIntakeModelAttempt[];
      };
      const attempt = durable.intakeModelAttempts.at(-1)!;
      assert.equal(
        attempt.outcome,
        'dispatched',
        'durable dispatch must precede actual HTTP arrival',
      );
      assert.equal(attempt.scope.sourceHash, source.sha256);
      assert.equal(attempt.scope.sourceTextRevisionId, extracted.sourceText.revision!.id);
      assert.equal(attempt.scope.intakeId, source.id);
      assert.equal(attempt.scope.profileId, profileId);
      seen.push(attempt);
      if (mode === 'unknown') {
        request.socket.destroy();
        return;
      }
      response.setHeader('content-type', 'application/json');
      if (mode === 'rejected') {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: { message: 'Fictional authentication rejection' } }));
        return;
      }
      response.end(
        JSON.stringify({
          id: 'fictional-response',
          model: 'fictional-test-alias',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Fictional source awaits review.' },
            },
          ],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 9,
            total_tokens: 129,
            prompt_tokens_details: { cached_tokens: 20 },
          },
        }),
      );
    } catch (error) {
      httpErrors.push(error instanceof Error ? error : Error(String(error)));
      response.statusCode = 500;
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const assistants: ReturnType<typeof createAssistant>[] = [];
  const open = () => {
    const assistant = createAssistant({
      root,
      databases: new Map([[profileId, db]]),
      availability: () => ({ available: true }),
      journalWriter: (root, profile, chat, reason) => {
        if (mode === 'journal-failure' && reason === 'conversion-model-attempt-dispatched')
          throw Error('Fictional dispatch journal failure');
        writeChat(root, profile, chat, reason);
      },
      bridgeFactory: (options) =>
        new ProxyModelBridge({
          ...options,
          config: {
            backend: 'litellm',
            model: 'fictional-test-alias',
            baseUrl,
            apiKey: 'fictional-only',
            reasoning: null,
            images: false,
            pdf: false,
            pdfMode: 'disabled',
            promptCache: false,
            localOnly: false,
            resolvedModel: null,
            timeoutSeconds: 2,
          },
        }),
    });
    assistants.push(assistant);
    return assistant;
  };
  const assistant = open();
  const chat = assistant.create(profileId, { title: 'Fictional durable request' });
  chatId = chat.id;
  linkIntakeConversion(db, root, profileId, source.id, chatId);
  assistant.send(
    profileId,
    chatId,
    { message: 'Read this fictional source', context: { intakeId: source.id } },
    { beforeModelRequest: () => mode === 'response' && calls >= 1 },
  );
  t.after(async () => {
    assistants.forEach((item) => item.close());
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const wait = async () => {
    for (let i = 0; i < 300; i++) {
      const current = assistant.get(profileId, chatId);
      if (current.status !== 'running') return current;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('Fictional request did not settle');
  };
  return {
    root,
    profileId,
    chatId,
    assistant,
    open,
    wait,
    seen,
    httpErrors,
    get calls() {
      return calls;
    },
  };
}
for (const mode of ['response', 'rejected', 'unknown', 'journal-failure'] as const)
  test(
    `actual assistant/provider boundary records ${mode} with durable admission`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, mode);
      const result = await f.wait();
      assert.deepEqual(f.httpErrors, []);
      if (mode === 'journal-failure') {
        assert.equal(f.calls, 0, 'no provider fetch after durable admission failed');
        assert.equal(result.status, 'failed');
        return;
      }
      assert.equal(
        f.calls,
        1,
        JSON.stringify({
          status: result.status,
          error: result.error,
          reading: result.reading,
          runs: result.runs,
        }),
      );
      assert.equal(f.seen.length, 1);
      const saved = readChat(f.root, f.profileId, f.chatId) as {
        intakeModelAttempts: RecordedIntakeModelAttempt[];
      };
      const attempt = saved.intakeModelAttempts[0]!;
      assert.equal(attempt.outcome, mode);
      assert.equal(attempt.requestId, f.seen[0]!.requestId);
      assert.equal(attempt.requestDigest, f.seen[0]!.requestDigest);
      if (mode === 'response') {
        assert.equal(attempt.usage?.inputTokens, 120);
        assert.equal(attempt.usage?.cachedInputTokens, 20);
        assert.equal(attempt.usage?.outputTokens, 9);
      }
      if (mode === 'rejected') {
        assert.equal(attempt.status, 401);
        assert.equal(attempt.classification, 'authentication');
      }
      if (mode === 'unknown') {
        assert.equal(attempt.usage, null);
        assert.equal(result.reading?.providerWait?.outcome, 'unknown');
        f.assistant.close();
        const restarted = f.open();
        const restored = restarted.get(f.profileId, f.chatId);
        assert.equal(restored.intakeModelAttempts?.[0]?.outcome, 'unknown');
        assert.throws(() => restarted.retry(f.profileId, f.chatId), {
          code: 'INTAKE_REQUEST_OUTCOME_UNKNOWN',
        });
        assert.throws(() => restarted.send(f.profileId, f.chatId, { message: 'Try again' }), {
          code: 'INTAKE_REQUEST_OUTCOME_UNKNOWN',
        });
        assert.equal(f.calls, 1, 'manual retry or new message cannot erase unknown cost');
      }
    },
  );
