import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  captureNative,
  createDebugTrace,
  debugMarkdown,
  debugValue,
  DEBUG_LIMITS,
  isDebugReport,
  probeBrowser,
} from '../app/passkey-checker/debug.ts';

const json = (value: unknown) => JSON.parse(JSON.stringify(debugValue(value)));

test('complete error text, native stack, causes and aggregate errors survive without redaction', () => {
  const cause = new Error('fictional credential=ab_cd token=test-token');
  const error = new AggregateError([cause], 'exact provider message', { cause });
  const output = json(error);
  assert.equal(output.message, error.message);
  assert.equal(output.stack, error.stack);
  assert.equal(output.cause.message, cause.message);
  assert.ok(output.errors.$array['0'].$reference);
  const native = new DOMException('Exact browser rejection', 'NotAllowedError');
  assert.equal(json(native).message, native.message);
  assert.equal(json(native).name, native.name);
  assert.equal(json(native).code, native.code);
  assert.equal(json(runInNewContext('new Error("cross realm")')).name, 'Error');
});

test('absent and throwing stacks, cycles and own accessors are explicitly represented', () => {
  const error = new Error('missing stack');
  delete error.stack;
  assert.deepEqual(json(error).stack, { $undefined: true });
  Object.defineProperty(error, 'stack', {
    get() {
      throw Error('cannot read');
    },
  });
  assert.match(json(error).stack.$unavailable, /getter threw/);
  const cyclic: { self?: unknown; first: string } = { first: 'retained' };
  cyclic.self = cyclic;
  assert.equal(json(cyclic).self.$reference, '$');
  let accesses = 0;
  const output = json({
    get optional() {
      accesses++;
      throw Error('do not call');
    },
  });
  assert.equal(accesses, 0);
  assert.equal(output.optional.$unavailable, 'accessor not invoked');
});

test('binary snapshots preserve exact view bytes, offset and representation before mutation', () => {
  const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6]);
  const output = json(new DataView(bytes.buffer, 2, 3));
  bytes.fill(0);
  assert.deepEqual(Buffer.from(output.$binary, 'base64'), Buffer.from([3, 4, 5]));
  assert.equal(output.byteOffset, 2);
  assert.equal(output.byteLength, 3);
  assert.equal(output.representation, '[object DataView]');
  assert.deepEqual(json([7, 8]).$array, { 0: 7, 1: 8, length: 2 });
  assert.equal(json(runInNewContext('new Uint8Array([9, 8]).buffer')).$binary, 'CQg=');
});

test('capture preserves a synchronous native throw and separate invocation stack', async () => {
  const trace = createDebugTrace({ build: 'fictional', provider: 'operator label' });
  const error = new TypeError('exact bad-option message');
  let invoked = false;
  assert.throws(
    () =>
      captureNative(trace, { publicKey: { challenge: new Uint8Array([1, 2]) } }, () => {
        invoked = true;
        throw error;
      }),
    (actual) => actual === error,
  );
  assert.equal(invoked, true);
  const saved = JSON.parse(trace.export());
  const invocation = saved.entries.find(
    (entry: { event: string }) => entry.event === 'native.invocation',
  );
  assert.match(invocation.value.invocationStack.stack, /Checker native invocation call site/);
  assert.equal(invocation.value.options.publicKey.challenge.$binary, 'AQI=');
  const thrown = saved.entries.find((entry: { event: string }) => entry.event === 'native.threw');
  assert.equal(thrown.value.stack, error.stack);
  const rejected = new DOMException('provider declined', 'InvalidStateError');
  await assert.rejects(
    captureNative(trace, {}, () => Promise.reject(rejected)),
    (e) => e === rejected,
  );
  assert.match(trace.export(), /native.rejected/);
  assert.equal(isDebugReport(trace.export()), true);
  trace.close();
});

test('credential capture preserves raw response and does not invoke extensions or toJSON', async () => {
  const trace = createDebugTrace({ fixture: true });
  const result = {
    id: 'raw-test-id',
    rawId: new Uint8Array([1]).buffer,
    type: 'public-key',
    response: { signature: new Uint8Array([4, 5]).buffer, userHandle: null },
    getClientExtensionResults() {
      throw Error('must wait for exact-ID validation');
    },
    toJSON() {
      throw Error('must not invoke arbitrary serialization');
    },
  };
  const returned = captureNative(trace, { challenge: 'original' }, () => Promise.resolve(result));
  assert.equal(await returned, result);
  assert.match(trace.export(), /raw-test-id/);
  assert.match(trace.export(), /BAU=/);
  assert.doesNotMatch(trace.export(), /must wait|must not invoke/);
  trace.close();
});

test('budgets expose omissions rather than claiming unlimited capture', () => {
  const long = 'x'.repeat(DEBUG_LIMITS.valueCharacters + 1);
  const value = json(long);
  assert.equal(value.originalCharacters, long.length);
  assert.equal(value.$truncated.length, DEBUG_LIMITS.valueCharacters);
  const trace = createDebugTrace({ fixture: true });
  for (let index = 0; index < DEBUG_LIMITS.events + 5; index++) trace.record('event', index);
  const saved = JSON.parse(trace.export());
  assert.equal(saved.entries.length, DEBUG_LIMITS.events);
  assert.ok(saved.omittedEvents > 0);
  assert.ok(trace.export().length <= DEBUG_LIMITS.reportCharacters);
  trace.close();
});

test('export is inert JSON and retains unredacted text; old and invalid captures remain explicit', () => {
  const trace = createDebugTrace({ id: 'test-id-do-not-redact' });
  const message = '</script>\n```\n# fake section\n<svg onload=alert(1)>';
  trace.record('error', new Error(message));
  const report = debugMarkdown(trace.export()).join('\n');
  assert.ok(report.includes('test-id-do-not-redact'));
  assert.ok(!report.includes('<svg'));
  const embedded = report.slice(report.indexOf('```json\n') + 8, report.lastIndexOf('\n```'));
  const error = JSON.parse(embedded).entries.find((entry: { event: string }) => entry.event === 'error');
  assert.equal(error.value.message, message);
  assert.match(debugMarkdown(undefined).join('\n'), /unavailable/);
  assert.equal(isDebugReport('{"schema":"incorrect"}'), false);
  assert.equal(isDebugReport('{'), false);
  trace.close();
});

test('noninteractive probes distinguish absent APIs without a credential prompt', () => {
  const probes = probeBrowser();
  assert.deepEqual(probes.values.clientCapabilities, { status: 'unavailable' });
  assert.deepEqual(probes.values.highEntropyClientHints, { status: 'unavailable' });
  probes.close();
});
