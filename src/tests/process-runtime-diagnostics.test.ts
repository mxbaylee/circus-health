import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { createDiagnosticsCapture } from './browser/process-runtime.ts';

function fixture(deadline = 5000) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    connected: true,
    exitCode: null as number | null,
    signalCode: null,
    sends: [] as Array<{ type: string; id: string }>,
    send(message: { type: string; id: string }, _callback: (error: Error | null) => void) {
      this.sends.push(message);
    },
  });
  const abort = new AbortController();
  const checkpoint = createDiagnosticsCapture(
    child as unknown as ChildProcess,
    abort.signal,
    deadline,
  );
  const marker = (id = child.sends.at(-1)!.id) => '\u001ecrs-browser-diagnostics:' + id + '\u001f';
  return { child, abort, checkpoint, marker };
}

test('success checkpoints do not send IPC; exact split stderr marker acknowledges preceding fictional failure and is stripped', async () => {
  const f = fixture();
  f.child.stderr.write('older fictional diagnostic\n');
  const capture = f.checkpoint();
  assert.equal(f.child.sends.length, 0);
  f.child.stderr.write('fictional upload 500 stack\n');
  let finished = false;
  const result = capture().then((value) => {
    finished = true;
    return value;
  });
  assert.equal(f.child.sends.length, 1);
  const marker = f.marker();
  for (const char of marker.slice(0, -1)) f.child.stderr.write(char);
  assert.equal(finished, false, 'partial markers never acknowledge a drain');
  f.child.stderr.write(marker.slice(-1) + 'later unrelated fictional log');
  assert.deepEqual(await result, {
    status: 'captured',
    diagnostics: 'fictional upload 500 stack\n',
    truncated: false,
  });
  const later = f.checkpoint();
  const next = later();
  f.child.stderr.write(f.marker());
  assert.deepEqual(await next, { status: 'captured', diagnostics: '', truncated: false });
});

test('since-checkpoint capture stays bounded to 8000 characters and reports truncation', async () => {
  const f = fixture();
  const capture = f.checkpoint();
  f.child.stderr.write('x'.repeat(9000));
  const result = capture();
  f.child.stderr.write(f.marker());
  assert.deepEqual(await result, {
    status: 'captured',
    diagnostics: 'x'.repeat(8000),
    truncated: true,
  });
});

test('concurrent failure drains resolve only their own nonce and strip late markers', async () => {
  const f = fixture();
  const first = f.checkpoint()();
  const firstId = f.child.sends.at(-1)!.id;
  const second = f.checkpoint()();
  const secondId = f.child.sends.at(-1)!.id;
  f.child.stderr.write('fictional concurrent log' + f.marker(firstId));
  assert.equal((await first).status, 'captured');
  f.child.stderr.write(f.marker(secondId));
  assert.equal((await second).diagnostics, 'fictional concurrent log');
});

test('child exit returns bounded available evidence and explicit unavailable status without throwing', async () => {
  const f = fixture();
  const capture = f.checkpoint();
  f.child.stderr.write('fictional exit stack');
  const result = capture();
  f.child.exitCode = 1;
  f.child.emit('exit', 1, null);
  assert.deepEqual(await result, {
    status: 'child-exited',
    diagnostics: 'fictional exit stack',
    truncated: false,
  });
  assert.equal((await f.checkpoint()()).status, 'child-exited');
  assert.equal(getEventListeners(f.abort.signal, 'abort').length, 0);
});

test('abort, disconnect, callback send errors and synchronous send errors return statuses without replacing failure', async () => {
  for (const terminal of ['abort', 'disconnect', 'send-callback', 'send-throw'] as const) {
    const f = fixture();
    if (terminal === 'send-callback')
      f.child.send = (_message, callback) => callback(Error('fictional IPC error'));
    if (terminal === 'send-throw')
      f.child.send = () => {
        throw Error('fictional IPC error');
      };
    const result = f.checkpoint()();
    if (terminal === 'abort') f.abort.abort();
    if (terminal === 'disconnect') {
      f.child.connected = false;
      f.child.emit('disconnect');
    }
    assert.equal((await result).status, terminal === 'abort' ? 'aborted' : 'ipc-unavailable');
    assert.equal(getEventListeners(f.abort.signal, 'abort').length, 0);
  }
});

test('unacknowledged stderr barrier reaches its host deadline; late marker never enters next report', async () => {
  const f = fixture(0);
  const result = f.checkpoint()();
  const lateMarker = f.marker();
  assert.equal((await result).status, 'deadline-exceeded');
  assert.equal(getEventListeners(f.abort.signal, 'abort').length, 0);
  f.child.stderr.write(lateMarker);
  const next = f.checkpoint()();
  f.child.stderr.write('fictional next failure' + f.marker());
  assert.deepEqual(await next, {
    status: 'captured',
    diagnostics: 'fictional next failure',
    truncated: false,
  });
});

test('malformed marker-shaped output remains diagnostic text', async () => {
  const f = fixture();
  const result = f.checkpoint()();
  const invalid = '\u001ecrs-browser-diagnostics:' + 'z'.repeat(36) + '\u001f';
  f.child.stderr.write(invalid + f.marker());
  assert.deepEqual(await result, { status: 'captured', diagnostics: invalid, truncated: false });
});

test('split UTF-8 bytes preserve fictional diagnostic text across stderr chunks', async () => {
  const f = fixture();
  const result = f.checkpoint()();
  const message = 'fictional résumé 🧪 error';
  for (const byte of Buffer.from(message)) f.child.stderr.write(Buffer.from([byte]));
  f.child.stderr.write(f.marker());
  assert.deepEqual(await result, { status: 'captured', diagnostics: message, truncated: false });
});
