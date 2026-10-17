import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Docker, ROOT } from '../../deploy/run.ts';
import { runQualificationLauncher } from './provider-qualification-launcher.ts';
import {
  observeQualificationRequestBudget,
  prepareQualificationRequestBudget,
  readQualificationRequestBudget,
  retainQualificationRequestBudget,
  type QualificationRequestBudget,
} from './provider-qualification-request-budget.ts';
import { writeQualificationPrivateJson } from './qualify-provider-pdf.ts';
import { prepareQualificationPrivateTrace } from './provider-qualification-private-trace.ts';

function fixture(t: { after(fn: () => void): void }, tracing = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fictional-request-budget-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const privateTrace = tracing ? prepareQualificationPrivateTrace(root) : undefined;
  return { root, privateTrace, budget: prepareQualificationRequestBudget(root, privateTrace) };
}
function child(preloader: string, env: NodeJS.ProcessEnv, source: string | { entrypoint: string }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const process = spawn(
      globalThis.process.execPath,
      [
        '--import',
        preloader,
        ...(typeof source === 'string'
          ? ['--input-type=module', '-e', source]
          : [source.entrypoint]),
      ],
      {
        env: { ...globalThis.process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '';
    process.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    process.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    process.once('error', reject);
    process.once('close', (code) => done({ code, stdout, stderr }));
  });
}

test('inherited worker preload permits local initialization and refuses worker fetches without refilling the main budget', async (t) => {
  const { root, budget } = fixture(t);
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.end('fictional');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const entrypoint = join(root, 'runtime.mjs');
  writeFileSync(
    join(root, 'worker.mjs'),
    `
    import assert from 'node:assert/strict';
    import { parentPort, workerData } from 'node:worker_threads';
    assert.ok(process.execArgv.includes(${JSON.stringify(budget.preloader)}));
    if (workerData) {
      await assert.rejects(fetch(workerData.url,workerData.init),/worker network request/u);
    }
    parentPort.postMessage('local worker initialized');
  `,
  );
  writeFileSync(
    entrypoint,
    `
    import assert from 'node:assert/strict';
    import { Worker } from 'node:worker_threads';
    const start = (workerData) => new Promise((done,reject) => {
      const worker = new Worker(new URL('./worker.mjs',import.meta.url),{workerData});
      let message;
      worker.on('message',value=>{message=value;});
      worker.once('error',reject);
      worker.once('exit',code=>{
        if(code!==0) reject(Error('Worker failed: '+code));
        else {assert.equal(message,'local worker initialized');done();}
      });
    });
    await start();
    assert.equal((await fetch(${JSON.stringify(origin)}+'/v1/chat/completions',{method:'POST',body:'fictional'})).status,200);
    await Promise.all([
      start({url:${JSON.stringify(origin)}+'/v1/chat/completions',init:{method:'POST',body:'fictional'}}),
      start({url:${JSON.stringify(origin)}+'/health/ready'}),
    ]);
    assert.equal((await fetch(${JSON.stringify(origin)}+'/v1/chat/completions',{method:'POST',body:'fictional'})).status,200);
  `,
  );
  const env = { CRS_QUALIFICATION_REQUEST_RECEIPTS: budget.receipts, CRS_AI_BASE_URL: origin };
  const run = await child(budget.preloader, env, { entrypoint });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(requests, 2); // Both admitted attempts came from the main thread.
  const snapshot = readQualificationRequestBudget(budget.receipts);
  assert.equal(snapshot.runtimeClaimed, true);
  assert.equal(snapshot.admitted, 2);
  assert.equal(snapshot.denied, 2);
  assert.equal(snapshot.stopReason, 'worker_network_request_refused');
  assert.equal(readdirSync(budget.receipts).includes('blocked-restart.json'), false);
  const observed = await new Promise<QualificationRequestBudget>((done) => {
    const stop = observeQualificationRequestBudget(
      budget.receipts,
      (value) => {
        stop();
        assert.ok(value);
        done(value);
      },
      1,
    );
    const deadline = setTimeout(() => {
      stop();
      throw Error('Offline worker denial observer did not run');
    }, 1000);
    t.after(() => clearTimeout(deadline));
  });
  assert.deepEqual(observed, snapshot);
  const report = {
    passed: true,
    failure: null as string | null,
    requestBudget: null as QualificationRequestBudget | null,
  };
  retainQualificationRequestBudget(report, observed);
  assert.equal(report.passed, false);
  assert.match(report.failure!, /inconclusive: worker_network_request_refused/u);
  const restarted = await child(budget.preloader, env, "throw Error('runtime must never start');");
  assert.notEqual(restarted.code, 0);
  assert.match(restarted.stderr, /cannot restart/u);
  assert.equal(requests, 2);
  const afterRestart = readQualificationRequestBudget(budget.receipts);
  assert.equal(afterRestart.admitted, 2);
  assert.equal(afterRestart.denied, 2);
  assert.equal(afterRestart.stopReason, 'runtime_restart_refused');
});

test('normal probe, bridge retry, concurrent calls and failed transport share sixteen durable admissions', async (t) => {
  const { budget } = fixture(t);
  let requests = 0,
    reads = 0,
    failedOnce = false;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      reads++;
      response.end('healthy fictional status');
      return;
    }
    requests++;
    assert.equal(request.url, '/v1/chat/completions');
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
    const user = body.messages.find((message) => message.role === 'user')?.content || '';
    if (user === 'fictional transport failure') {
      request.socket.destroy();
      return;
    }
    if (user === 'fictional retry' && !failedOnce) {
      failedOnce = true;
      response.writeHead(503);
      response.end(JSON.stringify({ error: { message: 'fictional temporary failure' } }));
      return;
    }
    const tool = body.messages.find((message) => message.role === 'tool');
    const challenge = /challenge ([a-f0-9-]+)/u.exec(user)?.[1];
    const message =
      challenge && !tool
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'fictional-call',
                type: 'function',
                function: {
                  name: 'health_connection_test',
                  arguments: JSON.stringify({ challenge }),
                },
              },
            ],
          }
        : {
            role: 'assistant',
            content: tool ? JSON.parse(tool.content).response : 'fictional response',
          };
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        model: 'fictional-model',
        choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const proxy = `http://localhost:${address.port}`;
  const env = { CRS_QUALIFICATION_REQUEST_RECEIPTS: budget.receipts, CRS_AI_BASE_URL: proxy };
  const bridgePath = fileURLToPath(new URL('../server/proxy-model-bridge.ts', import.meta.url));
  const modelPath = fileURLToPath(new URL('../server/model-bridge.ts', import.meta.url));
  const run = await child(
    budget.preloader,
    env,
    `
    import assert from 'node:assert/strict';
    import { proxyRequest, ProxyModelBridge } from ${JSON.stringify(bridgePath)};
    import { testModelConnection } from ${JSON.stringify(modelPath)};
    const config = {backend:'litellm',model:'fictional-model',baseUrl:${JSON.stringify(proxy)},apiKey:'fictional-secret',reasoning:null,images:false,pdf:false,pdfMode:'disabled',promptCache:false,localOnly:true,resolvedModel:'fictional-model',timeoutSeconds:30};
    const resolveHost = async () => [{address:'127.0.0.1'}];
    const probe = await testModelConnection({config,resolveHost});
    assert.equal(probe.available,true);
    let failure;
    const bridge = new ProxyModelBridge({config,resolveHost,retryDelay:async()=>{},onExit:(error)=>{failure=error;}});
    await bridge.start('Independently fictional retry test.', []);
    await bridge.turn('fictional retry');
    await bridge.completion;
    bridge.close();
    assert.equal(failure,undefined);
    const request = (text) => proxyRequest(config,{messages:[{role:'user',content:text}]},{requestOrigin:${JSON.stringify(origin)},hostHeader:new URL(config.baseUrl).host});
    const concurrent = await Promise.allSettled([...Array.from({length:11},()=>request('fictional concurrent request')),request('fictional transport failure')]);
    assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,11);
    assert.equal(concurrent.filter(r=>r.status==='rejected').length,1);
    await assert.rejects(request('seventeenth request must stay local'));
    // Keeping the exhausted runtime alive for read-only diagnostics must not
    // admit another completion, even if the application retries during capture.
    for (let attempt=0;attempt<3;attempt++) await assert.rejects(request('capture window retry must stay local'));
    for (const path of ['/health/ready','/api/runtime']) assert.equal((await fetch(${JSON.stringify(origin)}+path)).status,200);
    await assert.rejects(fetch(${JSON.stringify(origin)}+'/v1/responses',{method:'POST',body:'fictional'}));
    console.log('fictional checks passed');
  `,
  );
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /fictional checks passed/u);
  assert.equal(requests, 16);
  assert.equal(reads, 2);
  assert.equal(failedOnce, true);
  const snapshot = readQualificationRequestBudget(budget.receipts);
  assert.equal(snapshot.admitted, 16);
  assert.equal(snapshot.denied, 5);
  assert.equal(snapshot.stopReason, 'unexpected_request_route');
  assert.equal(snapshot.runtimeClaimed, true);
  for (const name of readdirSync(budget.receipts)) {
    const text = readFileSync(join(budget.receipts, name), 'utf8');
    assert.doesNotMatch(text, /fictional-secret|messages|concurrent request/u);
    assert.equal(statSync(join(budget.receipts, name)).mode & 0o777, 0o600);
  }
  const restarted = await child(budget.preloader, env, "throw Error('runtime must never start');");
  assert.notEqual(restarted.code, 0);
  assert.match(restarted.stderr, /cannot restart/u);
  assert.doesNotMatch(restarted.stderr, /runtime must never start/u);
  assert.equal(requests, 16);
  assert.equal(
    readQualificationRequestBudget(budget.receipts).stopReason,
    'runtime_restart_refused',
  );
});

test('the parent observes cap denial independently and retains exact counts and reason', async (t) => {
  const { root, budget } = fixture(t);
  // Receipt filenames reserve work even when a crash interrupts their body.
  for (let slot = 1; slot <= 16; slot++)
    writeFileSync(join(budget.receipts, `admitted-${String(slot).padStart(4, '0')}.json`), '');
  writeFileSync(join(budget.receipts, 'denied-limit-0001.json'), '');
  let callbacks = 0;
  const observed = await new Promise<ReturnType<typeof readQualificationRequestBudget>>((done) => {
    const stop = observeQualificationRequestBudget(
      budget.receipts,
      (snapshot) => {
        callbacks++;
        assert.ok(snapshot);
        stop();
        done(snapshot);
      },
      1,
    );
    // A pending Promise alone does not keep an unref'ed observation timer alive.
    const keepAlive = setTimeout(() => {
      stop();
      throw Error('Offline observer did not run');
    }, 1000);
    t.after(() => clearTimeout(keepAlive));
  });
  assert.equal(callbacks, 1);
  assert.equal(observed.admitted, 16);
  assert.equal(observed.denied, 1);
  assert.equal(observed.stopReason, 'completion_request_cap_reached');
  assert.match(observed.scope, /not tokens/u);
  const report = {
    passed: true,
    failure: null as string | null,
    requestBudget: null as QualificationRequestBudget | null,
  };
  retainQualificationRequestBudget(report, observed);
  const path = join(root, 'qualification.json');
  writeQualificationPrivateJson(path, report);
  const retained = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(retained.passed, false);
  assert.match(retained.failure, /inconclusive: completion_request_cap_reached/u);
  assert.match(retained.failure, /cannot refill or rerun/u);
  assert.equal(retained.requestBudget.admitted, 16);
  assert.equal(retained.requestBudget.denied, 1);
});

test('a receipt fsync failure stops the runtime before forwarding or retrying', async (t) => {
  const { budget } = fixture(t);
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.end('fictional');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const run = await child(
    budget.preloader,
    {
      CRS_QUALIFICATION_REQUEST_RECEIPTS: budget.receipts,
      CRS_AI_BASE_URL: origin,
    },
    `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    fs.fsyncSync = () => { throw Error('fictional fsync failure'); };
    syncBuiltinESMExports();
    await fetch(${JSON.stringify(origin)}+'/v1/chat/completions',{method:'POST',body:'fictional'});
    throw Error('failed reservation must never return');
  `,
  );
  assert.equal(run.code, 78);
  assert.equal(requests, 0);
  assert.doesNotMatch(run.stderr, /must never return/u);
  const snapshot = readQualificationRequestBudget(budget.receipts);
  assert.equal(snapshot.runtimeClaimed, true);
  assert.equal(snapshot.admitted, 1); // Conservative reservation, never refunded.
  assert.equal(snapshot.stopReason, 'receipt_integrity_failure');
});

test('an admitted completion cannot follow a redirect into a second HTTP attempt', async (t) => {
  const { budget } = fixture(t);
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(307, { Location: '/v1/chat/completions' });
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const run = await child(
    budget.preloader,
    {
      CRS_QUALIFICATION_REQUEST_RECEIPTS: budget.receipts,
      CRS_AI_BASE_URL: origin,
    },
    `
    import assert from 'node:assert/strict';
    await assert.rejects(fetch(${JSON.stringify(origin)}+'/v1/chat/completions',{method:'POST',body:'fictional',redirect:'follow'}));
  `,
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(requests, 1);
  assert.equal(readQualificationRequestBudget(budget.receipts).admitted, 1);
});

class FakeDocker extends Docker {
  calls: { args: string[]; env?: NodeJS.ProcessEnv; cleanup?: boolean }[] = [];
  constructor() {
    super('unused', false);
  }
  override async run(
    args: string[],
    options: { env?: NodeJS.ProcessEnv; cleanup?: boolean; capture?: boolean } = {},
  ) {
    this.calls.push({ args, ...options });
    return JSON.stringify({
      response_model: 'fictional-model',
      images: true,
      promptCache: false,
      pdf: true,
    });
  }
}
test('the supported launcher appends the override for build, preflight, up and down without preflight claiming', async (t) => {
  const { root, budget } = fixture(t);
  const data = join(root, 'data'),
    state = join(root, 'state'),
    config = join(root, 'fictional.yaml');
  mkdirSync(data);
  writeFileSync(config, 'model_list: []\n');
  const docker = new FakeDocker();
  await runQualificationLauncher(
    {
      CRS_DATA_DIR: data,
      CRS_STATE_DIR: state,
      CRS_LITELLM_CONFIG: config,
      CRS_MODEL: 'fictional-alias',
      CRS_QUALIFICATION_REQUEST_OVERRIDE: budget.override,
    },
    () => docker,
  );
  const calls = docker.calls.filter((call) => call.args[0] === 'compose');
  assert.equal(calls.length, 4);
  assert.deepEqual(
    calls.map((call) => call.args[7]),
    ['build', 'run', 'up', 'down'],
  );
  for (const call of calls) {
    assert.deepEqual(call.args.slice(3, 7), [
      '-f',
      join(ROOT, 'compose.yaml'),
      '-f',
      budget.override,
    ]);
    assert.ok(!call.env?.NODE_OPTIONS);
  }
  const preflight = calls[1].args;
  assert.ok(preflight.includes('--entrypoint'));
  assert.ok(preflight.includes('--input-type=module'));
  assert.ok(!preflight.includes('--import'));
  assert.ok(calls.at(-1)?.cleanup);
  const override = JSON.parse(readFileSync(budget.override, 'utf8'));
  assert.deepEqual(override.services.health.command, [
    'node',
    '--import',
    '/qualification/cap.mjs',
    'src/server/runtime.ts',
  ]);
  assert.equal(override.services.health.volumes[0].read_only, true);
  assert.equal(override.services.health.volumes[1].read_only, undefined);
  assert.equal(readQualificationRequestBudget(budget.receipts).runtimeClaimed, false);
  assert.deepEqual(readdirSync(budget.receipts), []);
  assert.equal(statSync(budget.control).mode & 0o777, 0o700);
  assert.ok(
    !Object.keys(override.services.health.environment).some((key) =>
      key.startsWith('CRS_IMPORT_PRIVATE_TRACE'),
    ),
  );
});

test('qualification override composes opt-in private trace with the unchanged sixteen-request runtime cap', (t) => {
  const { budget, privateTrace } = fixture(t, true);
  assert.ok(privateTrace);
  const override = JSON.parse(readFileSync(budget.override, 'utf8'));
  const health = override.services.health;
  assert.deepEqual(health.command, [
    'node',
    '--import',
    '/qualification/cap.mjs',
    'src/server/runtime.ts',
  ]);
  assert.equal(health.environment.CRS_QUALIFICATION_REQUEST_RECEIPTS, '/qualification/receipts');
  assert.equal(health.environment.CRS_IMPORT_PRIVATE_TRACE, 'contains-health-data');
  assert.equal(
    health.environment.CRS_IMPORT_PRIVATE_TRACE_GRANT_FILE,
    '/qualification-private-trace-control/grant.json',
  );
  assert.deepEqual(
    health.volumes.map((volume: { target: string }) => volume.target),
    [
      '/qualification/cap.mjs',
      '/qualification/receipts',
      '/qualification-private-trace',
      '/qualification-private-trace-control',
    ],
  );
  assert.equal(health.volumes[3].source, privateTrace.grantDirectory);
  assert.equal(health.volumes[3].read_only, true);
  assert.equal(health.volumes[2].read_only, undefined);
  assert.equal(readQualificationRequestBudget(budget.receipts).limit, 16);
  assert.equal(readQualificationRequestBudget(budget.receipts).admitted, 0);
  assert.doesNotMatch(readFileSync(join(ROOT, 'compose.yaml'), 'utf8'), /CRS_IMPORT_PRIVATE_TRACE/);
});
