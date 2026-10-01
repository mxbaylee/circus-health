import test from 'node:test';
import assert from 'node:assert/strict';
import { authMountOverlaps, containerPhase, parsePhaseResult } from './qualify-oauth-refresh.ts';
import { Docker } from '../../deploy/run.ts';

test('OAuth phase parser accepts only matching, internally consistent evidence', () => {
  assert.deepEqual(
    parsePhaseResult(
      'refresh',
      JSON.stringify({ status: 'refreshed', refreshObserved: true, persistenceObserved: true }),
    ),
    { status: 'refreshed', refreshObserved: true, persistenceObserved: true },
  );
  assert.throws(() =>
    parsePhaseResult(
      'reuse',
      JSON.stringify({ status: 'refreshed', refreshObserved: true, persistenceObserved: true }),
    ),
  );
  assert.throws(() =>
    parsePhaseResult(
      'refresh',
      JSON.stringify({ status: 'refreshed', refreshObserved: false, persistenceObserved: true }),
    ),
  );
  assert.throws(() =>
    parsePhaseResult('probe', 'provider log with fictional-secret\n{"status":"ready_expired"}'),
  );
  assert.throws(() =>
    parsePhaseResult(
      'probe',
      JSON.stringify({
        status: 'ready_expired',
        refreshObserved: false,
        persistenceObserved: false,
        access_token: 'fictional-secret',
      }),
    ),
  );
});

test('credential writer detection rejects same, parent, child and malformed mounts', () => {
  for (const source of [
    '/fictional/state/chatgpt',
    '/fictional/state',
    '/fictional/state/chatgpt/auth.json',
  ])
    assert.equal(
      authMountOverlaps('/fictional/state/chatgpt', [{ Type: 'bind', Source: source, RW: false }]),
      true,
    );
  assert.equal(
    authMountOverlaps('/fictional/state/chatgpt', [
      { Type: 'bind', Source: '/fictional/state/chatgpt-other' },
    ]),
    false,
  );
  assert.throws(() => authMountOverlaps('/fictional/state/chatgpt', { Mounts: [] }));
  assert.throws(() => authMountOverlaps('/fictional/state/chatgpt', [{}]));
});

test('owned OAuth container cleanup runs after failure and cleanup failure cannot pass', async () => {
  class QualificationDocker extends Docker {
    calls: string[][] = [];
    failRun = false;
    failCleanup = false;
    constructor() {
      super('unused', false);
    }
    override async run(args: string[]): Promise<string> {
      this.calls.push(args);
      if ((args[0] === 'run' && this.failRun) || (args[0] === 'rm' && this.failCleanup))
        throw new Error('fictional failure');
      return JSON.stringify({
        status: 'ready_expired',
        refreshObserved: false,
        persistenceObserved: false,
      });
    }
  }
  for (const failure of ['run', 'cleanup', 'none']) {
    const docker = new QualificationDocker();
    docker.failRun = failure === 'run';
    docker.failCleanup = failure === 'cleanup';
    const result = containerPhase(
      'probe',
      { auth: '/fictional/auth', config: '/fictional/config', model: 'fictional' },
      () => docker,
    );
    if (failure === 'none') await result;
    else await assert.rejects(result);
    const name = docker.calls[0][docker.calls[0].indexOf('--name') + 1];
    assert.match(name, /^circus-oauth-qualification-/u);
    assert.deepEqual(docker.calls[1], ['rm', '--force', name]);
  }
});
