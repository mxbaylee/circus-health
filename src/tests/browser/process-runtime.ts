import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';

export type ProcessRuntimeOptions = {
  dataDirectory: string;
  runtimeDirectory: string;
  codeRoot?: string;
  port: number;
  host: string;
  unavailableModelAlias?: string;
  connectionDiagnostics?: boolean;
};

type DiagnosticStatus =
  'captured' | 'child-exited' | 'aborted' | 'deadline-exceeded' | 'ipc-unavailable';
type DiagnosticCapture = { status: DiagnosticStatus; diagnostics: string; truncated: boolean };
const markerPrefix = '\u001ecrs-browser-diagnostics:';
const markerSuffix = '\u001f';
const nonceLength = 36;
const markerLength = markerPrefix.length + nonceLength + markerSuffix.length;
const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Test-child stderr ordering only; concurrent requests may contribute diagnostics. */
export function createDiagnosticsCapture(
  child: ChildProcess,
  signal: AbortSignal,
  deadlineMs = 5000,
) {
  let diagnostics = '';
  let diagnosticOffset = 0;
  let stderrTail = '';
  const pending = new Map<string, (status: DiagnosticStatus) => void>();
  const retain = (text: string) => {
    diagnosticOffset += text.length;
    diagnostics = (diagnostics + text).slice(-8000);
  };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', retain);
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    let text = stderrTail + chunk;
    stderrTail = '';
    while (text) {
      const position = text.indexOf(markerPrefix);
      if (position < 0) {
        let partial = Math.min(text.length, markerPrefix.length - 1);
        while (partial && !markerPrefix.startsWith(text.slice(-partial))) partial--;
        retain(partial ? text.slice(0, -partial) : text);
        stderrTail = partial ? text.slice(-partial) : '';
        break;
      }
      retain(text.slice(0, position));
      text = text.slice(position);
      if (text.length < markerLength) {
        stderrTail = text;
        break;
      }
      const nonce = text.slice(markerPrefix.length, markerPrefix.length + nonceLength);
      if (noncePattern.test(nonce) && text[markerLength - 1] === markerSuffix) {
        pending.get(nonce)?.('captured');
        text = text.slice(markerLength);
      } else {
        retain(text[0]!);
        text = text.slice(1);
      }
    }
  });
  child.on('exit', () => {
    retain(stderrTail);
    stderrTail = '';
    for (const settle of pending.values()) settle('child-exited');
  });
  child.on('disconnect', () => {
    for (const settle of pending.values()) settle('ipc-unavailable');
  });
  return () => {
    const start = diagnosticOffset;
    return async (): Promise<DiagnosticCapture> => {
      const snapshot = (status: DiagnosticStatus): DiagnosticCapture => {
        const available = diagnosticOffset - start;
        const length = Math.min(available, diagnostics.length);
        return {
          status,
          diagnostics: length ? diagnostics.slice(-length) : '',
          truncated: available > length,
        };
      };
      if (signal.aborted) return snapshot('aborted');
      if (child.exitCode !== null || child.signalCode !== null) return snapshot('child-exited');
      if (!child.connected) return snapshot('ipc-unavailable');
      const id = randomUUID();
      return new Promise<DiagnosticCapture>((resolve) => {
        let settled = false;
        const finish = (status: DiagnosticStatus) => {
          if (settled) return;
          settled = true;
          pending.delete(id);
          clearTimeout(deadline);
          signal.removeEventListener('abort', abort);
          resolve(snapshot(status));
        };
        const abort = () => finish('aborted');
        const deadline = setTimeout(() => finish('deadline-exceeded'), deadlineMs);
        pending.set(id, finish);
        signal.addEventListener('abort', abort, { once: true });
        try {
          child.send({ type: 'capture-diagnostics', id }, (error: Error | null) => {
            if (error) finish('ipc-unavailable');
          });
        } catch {
          finish('ipc-unavailable');
        }
      });
    };
  };
}

export async function startProcessRuntime(t: TestContext, options: ProcessRuntimeOptions) {
  const child = fork(new URL('./runtime-child.ts', import.meta.url), [JSON.stringify(options)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const captureDiagnostics = createDiagnosticsCapture(child, t.signal);
  const startupDiagnostics = captureDiagnostics();
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
    once(child, 'exit').then(async () => {
      throw new Error(
        'Browser runtime exited before ready: ' + JSON.stringify(await startupDiagnostics()),
      );
    }),
  ]);
  return { ...ready, close, captureDiagnostics };
}
