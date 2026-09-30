import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fictionalModel } from './fictional-model.ts';

test(
  'real process loss keeps encrypted automatic intent dormant until unlock; Stop survives and tab-independent dispatch resumes',
  { timeout: 90000 },
  async (t) => {
    fictionalModel(t);
    const root = mkdtempSync(join(tmpdir(), 'fictional-intake-process-'));
    const data = join(root, 'data'),
      runtime = join(root, 'runtime');
    mkdirSync(data);
    let child: ChildProcess | undefined,
      url = '',
      cookie = '';
    const dispatched: string[] = [];
    async function boot() {
      child = fork(
        new URL('./helpers/automatic-recovery-server.ts', import.meta.url),
        [data, runtime],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: process.env },
      );
      let errors = '';
      child.stderr?.on('data', (data) => {
        errors += String(data);
      });
      url = await new Promise<string>((resolve, reject) => {
        child!.on('error', reject);
        child!.on('exit', () => reject(Error('Fictional server exited: ' + errors)));
        child!.on('message', (value) => {
          const message = value as { kind: string; port: number; intakeId: string };
          if (message.kind === 'ready') resolve('http://127.0.0.1:' + message.port);
          if (message.kind === 'dispatch') dispatched.push(message.intakeId);
        });
      });
      cookie = '';
    }
    async function crash() {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    t.after(async () => {
      await crash();
      rmSync(root, { recursive: true, force: true });
    });
    async function request(path: string, body?: unknown) {
      const response = await fetch(url + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Origin: 'http://127.0.0.1:5173',
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.headers.get('set-cookie'))
        cookie = response.headers.get('set-cookie')!.split(';')[0];
      const json = await response.json();
      assert.ok(response.ok, JSON.stringify(json));
      return json.data;
    }
    async function waitFor(check: () => boolean) {
      const end = Date.now() + 8000;
      while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
      assert.ok(check());
    }
    await boot();
    t.diagnostic('first process ready');
    const setup = await request('/api/profile-setups', {
      fullName: 'Fictional process recovery',
      birthDate: '1982-04-17',
      name: 'Fictional process recovery',
    });
    t.diagnostic('setup created');
    const profile = await request('/api/profile-setups/' + setup.setupId + '/verify', {
      recovery: setup.recoveryKit,
      acknowledged: true,
    });
    const prefix = '/api/profiles/' + profile.id;
    async function upload(name: string) {
      const response = await fetch(url + prefix + '/intakes', {
        method: 'POST',
        headers: {
          Origin: 'http://127.0.0.1:5173',
          Cookie: cookie,
          'Content-Type': 'text/plain',
          'X-Filename': name,
        },
        body: 'Independent fictional source ' + name,
      });
      assert.equal(response.status, 201);
      return (await response.json()).data;
    }
    t.diagnostic('profile verified');
    const stopped = await upload('fictional-stopped.txt');
    await waitFor(() => dispatched.includes(stopped.id));
    const first = (await request(prefix + '/intake-batches'))[0];
    await request(prefix + '/intake-batches/' + first.id + '/stop', {});
    const automatic = await upload('fictional-automatic.txt');
    // No Import page or browser GET is needed to wake an accepted upload.
    await waitFor(() => dispatched.includes(automatic.id));
    t.diagnostic('automatic upload dispatched');
    await crash();
    dispatched.length = 0;
    await boot();
    t.diagnostic('restarted process ready');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(dispatched.length, 0, 'encrypted intent is not authority while locked');
    await request(prefix + '/unlock', { recovery: setup.recoveryKit });
    // Observe dispatch before any profile GET, proving unlock owns recovery.
    await waitFor(() => dispatched.includes(automatic.id));
    assert.equal(dispatched.includes(stopped.id), false);
    const batches = await request(prefix + '/intake-batches');
    assert.equal(batches.find((b: { id: string }) => b.id === first.id).status, 'stopped');
    const recoveredItem = batches
      .flatMap((batch: { items: { intakeId: string; chatId: string }[] }) => batch.items)
      .find((item: { intakeId: string }) => item.intakeId === automatic.id);
    const recovered = await request(prefix + '/assistant/chats/' + recoveredItem.chatId);
    assert.equal(recovered.intakeModelAttempts.length, 2);
    assert.equal(recovered.intakeModelAttempts[0].outcome, 'unknown');
    assert.equal(
      recovered.intakeModelAttempts[0].recovery.replacementRequestId,
      recovered.intakeModelAttempts[1].requestId,
    );
    assert.equal(recovered.intakeModelAttempts[1].outcome, 'dispatched');
    assert.equal(
      batches
        .flatMap((b: { items: { intakeId: string }[] }) => b.items)
        .filter((i: { intakeId: string }) => i.intakeId === automatic.id).length,
      1,
    );
  },
);
