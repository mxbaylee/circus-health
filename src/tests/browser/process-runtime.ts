import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import type { TestContext } from 'node:test';

export type ProcessRuntimeOptions = {
  dataDirectory: string;
  runtimeDirectory: string;
  codeRoot?: string;
  port: number;
  host: string;
  unavailableModelAlias?: string;
};

export async function startProcessRuntime(t: TestContext, options: ProcessRuntimeOptions) {
  const child = fork(new URL('./runtime-child.ts', import.meta.url), [JSON.stringify(options)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let diagnostics = '';
  let diagnosticOffset = 0;
  const retainDiagnostics = (value: Buffer) => {
    const text = value.toString();
    diagnosticOffset += text.length;
    diagnostics = (diagnostics + text).slice(-8000);
  };
  child.stdout?.on('data', retainDiagnostics);
  child.stderr?.on('data', retainDiagnostics);
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
  return {
    ...ready,
    close,
    captureDiagnostics() {
      const start = diagnosticOffset;
      return async () => {
        // Best-effort buffered output since this checkpoint; concurrent requests
        // can contribute, so this is not guaranteed attribution of the HTTP 500.
        await setImmediate();
        const length = Math.min(diagnosticOffset - start, diagnostics.length);
        return length ? diagnostics.slice(-length) : '';
      };
    },
  };
}
