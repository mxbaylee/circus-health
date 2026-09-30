import { fork } from 'node:child_process';
import { once } from 'node:events';
import type { TestContext } from 'node:test';

export async function startProcessRuntime(
  t: TestContext,
  options: { dataDirectory: string; runtimeDirectory: string; port: number; host: string },
) {
  const child = fork(new URL('./runtime-child.ts', import.meta.url), [JSON.stringify(options)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let diagnostics = '';
  child.stdout?.on('data', (value) => {
    diagnostics = (diagnostics + value).slice(-8000);
  });
  child.stderr?.on('data', (value) => {
    diagnostics = (diagnostics + value).slice(-8000);
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ||= (async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      if (child.connected) child.send('close');
      else child.kill('SIGTERM');
      await exited;
    })());
  const abort = () => child.kill('SIGKILL');
  t.signal.addEventListener('abort', abort, { once: true });
  t.after(async () => {
    await close();
    t.signal.removeEventListener('abort', abort);
  });
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message as { port: number; pid: number }),
    once(child, 'exit').then(() => {
      throw new Error('Browser runtime exited before ready: ' + diagnostics);
    }),
  ]);
  return { ...ready, close };
}
