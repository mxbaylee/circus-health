import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, type BinaryLike } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Note } from '../../shared/api.ts';
import type { Profile } from '../../app/data/profile.ts';
import type { ProfileSetup } from '../../app/data/profile-management.ts';
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
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  assertCompactComplaintSnapshot,
  assertProviderWait,
  assertSlowUpload,
  complaintDelayMs,
  complaintPdf,
  completedProviderWait,
  reviewWithComplaintDelay,
  uploadWithComplaintDelay,
  type ComplaintSnapshot,
} from './launch-performance-fixture.ts';

interface UpstreamMessage {
  role: string;
  content: string | null | Array<{ type: string; text?: string; file?: { file_data: string } }>;
  tool_call_id?: string;
  tool_calls?: { function: { name: string } }[];
}
interface UpstreamRequest {
  model: string;
  messages: UpstreamMessage[];
  tools: { function: { name: string } }[];
}
interface ChatResult {
  id: string;
  status: string;
  backend: string;
  model: string;
  error?: string;
  messages: { role: string; content: string }[];
  runs: { assistantIdentity: string }[];
  operations: { tool: string }[];
  proposals: { id: string; status: string; noteId: string }[];
  reading?: { status: string; reason: string | null };
}
interface ConnectionResult {
  backend: string;
  model: string;
  available: boolean;
  connectionTest: { fictional: boolean };
  capabilities: { tools: boolean; pdf: boolean | null };
}

// Opt in: builds the actual app image, starts the pinned LiteLLM image through
// the Node launcher, and uses only temporary fictional profiles and a synthetic upstream.
const enabled = process.env.CRS_LAUNCH_TEST === '1';
const performanceOnly = process.env.CRS_LAUNCH_PERFORMANCE_ONLY === '1';
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const messageText = (message: UpstreamMessage | undefined): string =>
  typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text || '')
          .join(' ')
      : '';
const sha = (value: BinaryLike) => createHash('sha256').update(value).digest('hex');

test(
  performanceOnly
    ? 'Node Docker: controlled upload, processing and browser review complaint qualification'
    : 'Node Docker: LiteLLM chat, complaint diagnostics, encrypted recreation and cache-loss rebuild',
  { skip: !enabled, timeout: 1800000 },
  async (t) => {
    const requestedProxyCpus = process.env.CRS_LAUNCH_LITELLM_CPUS ?? '1';
    assert.ok(
      requestedProxyCpus === '1' || requestedProxyCpus === '2',
      'CRS_LAUNCH_LITELLM_CPUS must be 1 or 2',
    );
    const proxyCpus = Number(requestedProxyCpus);
    const dockerInfo = JSON.parse(
      execFileSync('docker', ['info', '--format', '{{json .}}'], {
        encoding: 'utf8',
        timeout: 30000,
      }),
    ) as { ServerVersion: string; Architecture: string; NCPU: number; MemTotal: number };
    const environment = {
      proxyCpus,
      defaultProxyCpus: proxyCpus === 1,
      dockerVersion: dockerInfo.ServerVersion,
      architecture: dockerInfo.Architecture,
      vmCpus: dockerInfo.NCPU,
      vmMemoryBytes: dockerInfo.MemTotal,
      vmMemoryBelowInstallationGuidance: dockerInfo.MemTotal < 4 * 1024 ** 3,
    };
    t.diagnostic('Controlled qualification environment: ' + JSON.stringify(environment));
    const deploySourceFiles = [
      'deploy/litellm/configure.py',
      'deploy/litellm/entrypoint.sh',
      'compose.yaml',
    ];
    const frozenDeployHashes = Object.fromEntries(
      deploySourceFiles.map((file) => [file, sha(readFileSync(resolve(repository, file)))]),
    );
    const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'circus-npm-litellm-')));
    const data = resolve(root, 'data'),
      state = resolve(root, 'state');
    mkdirSync(data, { mode: 0o700 });
    mkdirSync(state, { mode: 0o700 });

    const upstreamRequests: UpstreamRequest[] = [],
      upstreamResponseModels: string[] = [],
      upstreamErrors: string[] = [];
    let returnedProposalId: string | undefined;
    let delayedUpstream: { started: () => void; released: Promise<void> } | undefined;
    let releaseUpstream = () => {};
    const upstream = createHttpServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as UpstreamRequest;
        if (req.url !== '/v1/chat/completions') throw Error(`Unexpected upstream path ${req.url}`);
        if (req.headers.authorization !== 'Bearer fictional-provider-key')
          throw Error('LiteLLM did not use the supplied provider credential.');
        if (body.model !== 'fictional-upstream')
          throw Error(`Unexpected upstream model ${body.model}`);
        upstreamRequests.push(body);
        if (
          delayedUpstream &&
          body.tools.some((tool) => tool.function.name === 'health_intake_read')
        ) {
          const waiting = delayedUpstream;
          delayedUpstream = undefined;
          waiting.started();
          await waiting.released;
        }
        const toolResult = body.messages.findLast((message) => message.role === 'tool');
        const setupPrompt = messageText(body.messages.find((message) => message.role === 'system'));
        let finish_reason = 'stop',
          message;
        const scopedJourney = body.messages.some(
          (item) =>
            item.role === 'user' &&
            messageText(item).includes('Read Self and propose a fictional follow-up'),
        );
        if (scopedJourney) {
          const priorCalls = body.messages.flatMap((item) => item.tool_calls || []);
          const readMessage = body.messages.find(
            (item) => item.role === 'tool' && item.tool_call_id === 'fictional-health_read',
          );
          if (readMessage) {
            const read = JSON.parse(messageText(readMessage));
            assert.equal(read.error, undefined);
            assert.equal(read.kind, 'person');
            assert.equal(read.isSelf, true);
            assert.equal(read.title, 'Fictional Make Juggler');
          }
          const proposalMessage = body.messages.find(
            (item) => item.role === 'tool' && item.tool_call_id === 'fictional-health_propose_note',
          );
          if (proposalMessage) {
            const proposed = JSON.parse(messageText(proposalMessage));
            assert.equal(proposed.error, undefined);
            assert.equal(proposed.status, 'pending');
            assert.equal(proposed.changes.content, 'Fictional tool-loop persistence marker');
            assert.equal(typeof proposed.id, 'string');
            assert(proposed.id.length > 0);
            returnedProposalId = proposed.id;
          }
          const nextTool = !priorCalls.some((call) => call.function.name === 'health_read')
            ? ['health_read', { collection: 'notes', id: 'patient' }]
            : !priorCalls.some((call) => call.function.name === 'health_propose_note')
              ? [
                  'health_propose_note',
                  {
                    kind: 'note',
                    title: 'Fictional reviewed follow-up',
                    content: 'Fictional tool-loop persistence marker',
                    reason: 'The user requested this fictional proposal.',
                  },
                ]
              : null;
          assert(body.tools.some((tool) => tool.function.name === 'health_read'));
          assert(body.tools.some((tool) => tool.function.name === 'health_propose_note'));
          if (nextTool) {
            finish_reason = 'tool_calls';
            message = {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `fictional-${nextTool[0]}`,
                  type: 'function',
                  function: { name: nextTool[0], arguments: JSON.stringify(nextTool[1]) },
                },
              ],
            };
          } else {
            assert(body.messages.filter((item) => item.role === 'tool').length >= 2);
            message = {
              role: 'assistant',
              content: 'Fictional read and proposal returned through LiteLLM; awaiting review.',
            };
          }
        } else if (toolResult) {
          const pdf = body.messages
            .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
            .find((part) => part.type === 'file');
          if (pdf) {
            assert.match(pdf.file!.file_data, /^data:application\/pdf;base64,/);
            const bytes = Buffer.from(pdf.file!.file_data.split(',')[1]!, 'base64');
            const digits = /\((\d{4})\) Tj/.exec(bytes.toString())?.[1];
            assert.ok(digits, 'the fictional challenge must be carried by native PDF bytes');
            assert.ok(
              !body.messages.map(messageText).join(' ').includes(digits),
              'textual metadata must not reveal the PDF answer',
            );
            message = { role: 'assistant', content: digits };
          } else
            message = { role: 'assistant', content: JSON.parse(messageText(toolResult)).response };
        } else if (setupPrompt.includes('fictional setup test')) {
          const user = messageText(body.messages.findLast((message) => message.role === 'user'));
          const challenge = /challenge ([a-f0-9-]+)/.exec(user)?.[1];
          if (!challenge) throw Error('The app did not send the fictional connection challenge.');
          finish_reason = 'tool_calls';
          message = {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'fictional-tool-call',
                type: 'function',
                function: {
                  name: 'health_connection_test',
                  arguments: JSON.stringify({ challenge }),
                },
              },
            ],
          };
        } else {
          message = { role: 'assistant', content: 'Fictional Moxie reply through LiteLLM.' };
        }
        const response = {
          id: 'chatcmpl-circus-fictional',
          object: 'chat.completion',
          created: 0,
          model: body.model,
          choices: [{ index: 0, finish_reason, message }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        };
        upstreamResponseModels.push(response.model);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (error) {
        upstreamErrors.push(error instanceof Error ? error.message : String(error));
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Synthetic upstream rejected the request.' } }));
      }
    });
    await new Promise<void>((done, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '0.0.0.0', done);
    });
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const socket = createTcpServer();
    await new Promise<void>((done, reject) => {
      socket.once('error', reject);
      socket.listen(0, '127.0.0.1', done);
    });
    const port = (socket.address() as AddressInfo).port;
    await new Promise<void>((done) => socket.close(() => done()));
    const base = `http://127.0.0.1:${port}`;
    const composeProject = 'circus-health-' + sha(data).slice(0, 12);
    const config = resolve(root, 'litellm.yaml'),
      providerEnv = resolve(root, 'provider.env');
    // Omit a PDF hint to exercise the actual unknown-route metadata lookup;
    // the runtime challenge below must independently prove PDF support.
    writeFileSync(
      config,
      `model_list:\n  - model_name: fictional-alias\n    litellm_params:\n      model: openai/fictional-upstream\n      api_base: http://host.docker.internal:${upstreamPort}/v1\n      api_key: os.environ/FICTIONAL_PROVIDER_KEY\n    model_info:\n      supports_vision: false\n`,
    );
    // Even blank database environment variables trigger Prisma in LiteLLM 1.99.1.
    // The managed entrypoint must remove them before the proxy binds its port.
    writeFileSync(
      providerEnv,
      'FICTIONAL_PROVIDER_KEY=fictional-provider-key\nDATABASE_URL=\nDIRECT_URL=\n',
      { mode: 0o600 },
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(CRS_|HEALTH_|CIRCUS_|CODEX_|LITELLM_|OLLAMA_|DATA_DIR$|AI$|MODEL$|AI_URL$|KEY_FILE$|AUTH_DIR$|ENV_FILE$|STACK$|RUNTIME$|PORT$|IMAGE$|NODE$|STATE_DIR$|RESPONSE_MODEL$|IMAGES$|PDF$|PROMPT_CACHE$)/.test(
            key,
          ),
      ),
    );

    let processHandle: ChildProcess | null = null;
    let closed: Promise<void> | undefined;
    let output = '',
      cookie = '';
    let proxyKey: string | undefined;
    function assertProjectRemoved() {
      const filter = `label=com.docker.compose.project=${composeProject}`;
      assert.equal(
        execFileSync('docker', ['ps', '--all', '--quiet', '--filter', filter], {
          encoding: 'utf8',
        }).trim(),
        '',
        'Shutdown must remove stopped containers as well as stop the HTTP server',
      );
      assert.equal(
        execFileSync('docker', ['network', 'ls', '--quiet', '--filter', filter], {
          encoding: 'utf8',
        }).trim(),
        '',
        'Shutdown must remove this test project’s networks',
      );
    }
    async function stop() {
      if (!processHandle) return;
      try {
        assert(processHandle.pid);
        process.kill(-processHandle.pid, 'SIGINT');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
      }
      await Promise.race([
        closed,
        delay(120000, undefined, { ref: false }).then(() => {
          throw Error('Node launcher did not stop after Ctrl-C');
        }),
      ]);
      processHandle = null;
      assertProjectRemoved();
      for (let i = 0; i < 100; i++) {
        try {
          await fetch(base + '/health/ready', { signal: AbortSignal.timeout(200) });
        } catch {
          return;
        }
        await delay(50);
      }
      assert.fail('Runtime still responds after the launcher stopped');
    }
    async function waitForLauncherExit() {
      await Promise.race([
        closed,
        delay(120000, undefined, { ref: false }).then(() => {
          throw Error('Node launcher did not exit after the health container stopped');
        }),
      ]);
      processHandle = null;
      assertProjectRemoved();
      for (let i = 0; i < 100; i++) {
        try {
          await fetch(base + '/health/ready', { signal: AbortSignal.timeout(200) });
        } catch {
          return;
        }
        await delay(50);
      }
      assert.fail('Runtime still responds after its health container stopped');
    }
    async function start() {
      t.signal.throwIfAborted();
      output = '';
      cookie = '';
      processHandle = spawn(process.execPath, ['deploy/run.ts', 'run'], {
        cwd: repository,
        env: {
          ...env,
          CRS_DATA_DIR: data,
          CRS_MODEL: 'fictional-alias',
          CRS_LITELLM_CONFIG: config,
          CRS_LITELLM_ENV_FILE: providerEnv,
          CRS_STATE_DIR: state,
          CRS_PORT: String(port),
          CRS_LITELLM_CPUS: String(proxyCpus),
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const retainOutput = (bytes: Buffer) => {
        output = (output + bytes).slice(-20000);
      };
      processHandle.stdout!.on('data', retainOutput);
      processHandle.stderr!.on('data', retainOutput);
      closed = new Promise<void>((done, reject) => {
        processHandle!.once('close', () => done());
        processHandle!.once('error', reject);
      });
      for (let i = 0; i < 6000; i++) {
        t.signal.throwIfAborted();
        assert.equal(processHandle.exitCode, null, output);
        assert.equal(processHandle.signalCode, null, output);
        try {
          const response = await fetch(base + '/api/runtime', { signal: AbortSignal.timeout(300) });
          if (response.ok) {
            assert.equal((await response.json()).encrypted, true);
            return;
          }
        } catch {}
        await delay(100);
      }
      assert.fail('Node launcher did not start the Docker stack: ' + output);
    }
    function verifyRunningHardening() {
      for (const [service, cpus, pids] of [
        ['health', 2, 512],
        ['litellm', proxyCpus, 256],
      ] as const) {
        const container = `${composeProject}-${service}-1`;
        const [inspection] = JSON.parse(
          execFileSync('docker', ['inspect', container], { encoding: 'utf8', timeout: 30000 }),
        );
        const host = inspection.HostConfig;
        assert.equal(host.ReadonlyRootfs, true);
        assert.ok(host.SecurityOpt.includes('no-new-privileges:true'));
        assert.ok(host.CapDrop.includes('ALL'));
        assert.equal(host.PidsLimit, pids);
        assert.equal(host.NanoCpus, cpus * 1_000_000_000);
        assert.ok(
          host.Ulimits.some(
            (limit: { Name: string; Soft: number; Hard: number }) =>
              limit.Name === 'core' && limit.Soft === 0 && limit.Hard === 0,
          ),
        );
        for (const [path, options] of Object.entries(host.Tmpfs) as [string, string][]) {
          for (const flag of ['noexec', 'nosuid', 'nodev'])
            assert.ok(options.split(',').includes(flag), `${service} ${path}: ${flag}`);
          assert.ok(options.split(',').includes(`size=${path === '/run/health' ? 1024 : 128}m`));
        }
        if (service === 'health') assert.equal(host.ShmSize, 128 * 1024 * 1024);
        const kernel = execFileSync(
          'docker',
          [
            'exec',
            container,
            '/bin/sh',
            '-c',
            'cat /proc/self/status /proc/self/limits /proc/self/mountinfo /sys/fs/cgroup/cpu.max /sys/fs/cgroup/pids.max',
          ],
          { encoding: 'utf8', timeout: 30000 },
        );
        assert.match(kernel, /NoNewPrivs:\s+1/);
        assert.match(kernel, /CapEff:\s+0+\b/);
        assert.match(kernel, /Max core file size\s+0\s+0/);
        assert.match(kernel, / \/tmp [^\n]*noexec[^\n]* - tmpfs /);
        for (const path of Object.keys(host.Tmpfs)) {
          const mount = kernel.split('\n').find((line) => line.split(' ')[4] === path);
          assert.ok(mount, `${service}: ${path} mounted`);
          const flags = mount.split(' ')[5]!.split(',');
          for (const flag of ['noexec', 'nosuid', 'nodev']) assert.ok(flags.includes(flag));
          assert.match(mount, / - tmpfs /);
          assert.ok(mount.includes(`size=${path === '/run/health' ? 1048576 : 131072}k`));
        }
        assert.ok(kernel.trim().endsWith(String(pids)));
        const cpu = /(?:^|\n)(\d+) (\d+)\n\d+\s*$/.exec(kernel);
        assert.ok(cpu);
        assert.equal(Number(cpu[1]) / Number(cpu[2]), cpus);
        t.diagnostic(
          `${service}: running readonly rootfs, no-new-privileges, cap-drop ALL, sized tmpfs noexec/nosuid/nodev, core=0, CPUs=${cpus}, PIDs=${pids}; image ${inspection.Image}`,
        );
      }
    }
    function verifyContainerNativePdf() {
      const result = execFileSync(
        'docker',
        [
          'exec',
          `${composeProject}-health-1`,
          'node',
          '--test',
          '--test-name-pattern=native PDF evidence|native rendering graph|ordinary page|native incompatibility|source mutation|native selected page|native isolation|native extraction reads|graph projection|native projection|native graph descriptor',
          'src/server/test/intake-pdf-native.test.ts',
          'src/server/test/intake-pdf-native-graph.test.ts',
        ],
        { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 },
      );
      assert.match(result, /(?:# )?fail 0/);
      t.diagnostic('Native PDF tests inside actual hardened app container:\n' + result);
    }
    function verifyRunningSource() {
      const sourceFiles = [
        'assistant.ts',
        'model-bridge.ts',
        'model-config.ts',
        'proxy-model-bridge.ts',
        'proxy-transcript.ts',
        'intake-evidence.ts',
        'intake-pdf-native.ts',
        'intake-pdf-session.ts',
        'intake-pdf-worker.ts',
        'intake-continuation.ts',
        'intake-workflow.ts',
        'intake-identity.ts',
        'intake-identity-grounding.ts',
        'import-diagnostics.ts',
        'import-performance.ts',
        'intake-upload.ts',
        'intake-files.ts',
        'intake.ts',
        'archive-storage.ts',
        'encrypted-profiles.ts',
        'index.ts',
      ];
      const image = execFileSync(
        'docker',
        ['inspect', '--format', '{{.Image}}', `${composeProject}-health-1`],
        { encoding: 'utf8', timeout: 30000 },
      ).trim();
      const hashes = execFileSync(
        'docker',
        [
          'exec',
          `${composeProject}-health-1`,
          'sha256sum',
          ...sourceFiles.map((file) => 'src/server/' + file),
        ],
        { encoding: 'utf8', timeout: 30000 },
      );
      for (const line of hashes.trim().split('\n')) {
        const [digest, file] = line.trim().split(/\s+/);
        assert.equal(
          digest,
          sha(readFileSync(resolve(repository, file!))),
          'running image must contain frozen host source: ' + file,
        );
      }
      const [proxy] = JSON.parse(
        execFileSync('docker', ['inspect', `${composeProject}-litellm-1`], {
          encoding: 'utf8',
          timeout: 30000,
        }),
      ) as Array<{
        Image: string;
        Config: { Labels: Record<string, string> };
        Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
      }>;
      assert.ok(proxy);
      const mountedFiles = ['configure.py', 'entrypoint.sh'];
      const mountedHashes = execFileSync(
        'docker',
        [
          'exec',
          `${composeProject}-litellm-1`,
          'sha256sum',
          ...mountedFiles.map((file) => '/opt/circus/' + file),
        ],
        { encoding: 'utf8', timeout: 30000 },
      );
      for (const line of mountedHashes.trim().split('\n')) {
        const [digest, mountedPath] = line.trim().split(/\s+/);
        const filename = mountedPath!.split('/').at(-1)!;
        const source = `deploy/litellm/${filename}`;
        const mount = proxy.Mounts.find((entry) => entry.Destination === mountedPath);
        assert.ok(
          mount && mount.Type === 'bind' && mount.RW === false,
          'deployment source must be mounted read-only',
        );
        assert.equal(realpathSync(mount.Source), realpathSync(resolve(repository, source)));
        assert.equal(
          digest,
          frozenDeployHashes[source],
          'mounted deployment bytes must match the frozen source: ' + source,
        );
      }
      for (const file of deploySourceFiles)
        assert.equal(
          sha(readFileSync(resolve(repository, file))),
          frozenDeployHashes[file],
          'deployment source changed during qualification: ' + file,
        );
      assert.ok(
        proxy.Config.Labels['com.docker.compose.project.config_files']
          ?.split(',')
          .map((file) => realpathSync(file))
          .includes(realpathSync(resolve(repository, 'compose.yaml'))),
        'running proxy must identify the frozen Compose source',
      );
      t.diagnostic(`Running image ${image} matches frozen source hashes:\n${hashes}`);
      const deployment = {
        proxyImage: proxy.Image,
        sourceSha256: frozenDeployHashes,
        boundFilesVerified: mountedFiles.map((file) => '/opt/circus/' + file),
      };
      t.diagnostic('Frozen deployment sources: ' + JSON.stringify(deployment));
      return {
        image,
        runtimeSourceSha256: Object.fromEntries(
          hashes
            .trim()
            .split('\n')
            .map((line) => {
              const [digest, file] = line.trim().split(/\s+/);
              return [file, digest];
            }),
        ),
        deployment,
      };
    }
    async function request<T = Record<string, unknown>>(
      path: string,
      method = 'GET',
      body?: unknown,
      options: { headers?: Record<string, string>; binary?: boolean } = {},
    ): Promise<T> {
      const binary = Buffer.isBuffer(body);
      const response = await fetch(base + path, {
        method,
        headers: {
          Origin: base,
          Cookie: cookie,
          'Content-Type': binary ? 'application/pdf' : 'application/json',
          ...options.headers,
        },
        ...(body === undefined
          ? {}
          : { body: binary ? new Uint8Array(body as Buffer) : JSON.stringify(body) }),
      });
      const set = response.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const value: unknown = options.binary
        ? Buffer.from(await response.arrayBuffer())
        : await response.json();
      assert(response.ok, `${method} ${path}: ${JSON.stringify(value)}`);
      return options.binary ? (value as T) : (value as { data: T }).data;
    }
    async function waitForChat(path: string, id: string) {
      for (let i = 0; i < 200; i++) {
        const chat = await request<ChatResult>(`${path}/assistant/chats/${encodeURIComponent(id)}`);
        if (chat.status !== 'running') return chat;
        await delay(100);
      }
      assert.fail('Moxie chat did not finish.');
    }
    function durableFiles(directory: string): string[] {
      const files = [];
      for (const name of readdirSync(directory)) {
        const path = join(directory, name),
          info = statSync(path);
        if (info.isDirectory()) files.push(...durableFiles(path));
        else files.push(path);
      }
      return files;
    }
    function verifyState(marker: string) {
      const keyPath = resolve(state, 'proxy-key'),
        currentKey = readFileSync(keyPath, 'utf8');
      assert.match(currentKey, /^sk-[0-9a-f]{64}\n?$/);
      assert.equal(
        statSync(keyPath).mode & 0o077,
        0,
        'Proxy credentials must not be group/world accessible.',
      );
      if (proxyKey === undefined) proxyKey = currentKey;
      else assert.equal(currentKey, proxyKey);
      assert.equal(readFileSync(resolve(state, 'chatgpt', 'fictional-marker'), 'utf8'), marker);
    }

    t.after(async () => {
      releaseUpstream();
      await stop();
      await new Promise<void>((done) => upstream.close(() => done()));
      rmSync(root, { recursive: true, force: true });
    });
    const marker = 'Fictional Make lifecycle marker',
      authMarker = 'fictional-auth-state-marker';
    const original = complaintPdf();

    await start();
    verifyRunningHardening();
    verifyContainerNativePdf();
    assert.match(await (await fetch(base)).text(), /Circus Health/);
    assert.deepEqual(await request<Profile[]>('/api/profiles'), []);
    const beforeTest = await request('/api/ai/status');
    assert.deepEqual(
      {
        backend: beforeTest.backend,
        model: beforeTest.model,
        readiness: beforeTest.readiness,
        available: beforeTest.available,
      },
      { backend: 'litellm', model: 'fictional-alias', readiness: 'untested', available: false },
    );
    const setup = await request<ProfileSetup>('/api/profile-setups', 'POST', {
      fullName: 'Fictional Make Juggler',
      birthDate: '1982-04-17',
      name: 'Fictional Make Juggler',
      placebo: false,
    });
    const profile = await request<Profile>(`/api/profile-setups/${setup.setupId}/verify`, 'POST', {
      acknowledged: true,
      recovery: setup.recoveryKit,
    });
    const path = `/api/profiles/${profile.id}`;
    // The published Docker port differs from the API's internal port. Local
    // passkey enrollment must use a hostname and pass the same origin checks.
    const localOrigin = `http://localhost:${port}`;
    const passkey = await request<{ options: { rp: { id: string } } }>(
      path + '/passkeys/options',
      'POST',
      {},
      { headers: { Origin: localOrigin } },
    );
    assert.equal(passkey.options.rp.id, 'localhost');
    const foreign = await fetch(base + path + '/passkeys/options', {
      method: 'POST',
      headers: {
        Origin: 'https://untrusted.example',
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(foreign.status, 403);
    const connection = await request<ConnectionResult>(
      path + '/assistant/test-connection',
      'POST',
      { pdf: true },
    );
    assert.equal(connection.backend, 'litellm');
    assert.equal(connection.model, 'fictional-alias');
    assert.equal(connection.available, true);
    assert.equal(connection.connectionTest.fictional, true);
    assert.equal(connection.capabilities.tools, true);
    assert.equal(connection.capabilities.pdf, true);
    assert.ok(
      upstreamRequests.some((request) =>
        request.messages.some(
          (message) =>
            Array.isArray(message.content) && message.content.some((part) => part.type === 'file'),
        ),
      ),
      'pinned LiteLLM must carry the PDF challenge to the synthetic upstream',
    );
    t.diagnostic(
      'Pinned LiteLLM native PDF readiness passed: exact four digits obtained from fictional file_data after tool result.',
    );
    const startedChat = await request<ChatResult>(path + '/assistant/chats', 'POST', {
      message: 'Give a fictional connection confirmation.',
      context: { route: '/' },
    });
    const chat = await waitForChat(path, startedChat.id);
    assert.equal(chat.status, 'idle');
    assert.equal(chat.backend, 'litellm');
    assert.equal(chat.model, 'fictional-alias');
    assert.equal(
      chat.messages.findLast((message) => message.role === 'assistant')?.content,
      'Fictional Moxie reply through LiteLLM.',
    );
    assert(chat.runs.every((run) => run.assistantIdentity === 'Moxie'));
    assert.deepEqual(upstreamErrors, []);
    assert(upstreamRequests.length >= 3);
    assert(upstreamRequests.every((body) => body.model === 'fictional-upstream'));
    assert.deepEqual(
      upstreamResponseModels,
      upstreamRequests.map((body) => body.model),
    );

    const proposedRun = await request<ChatResult>(path + '/assistant/chats', 'POST', {
      message: 'Read Self and propose a fictional follow-up. Leave acceptance to me.',
      context: { route: '/' },
    });
    const proposedChat = await waitForChat(path, proposedRun.id);
    assert.equal(proposedChat.status, 'idle', proposedChat.error);
    assert.deepEqual(
      proposedChat.operations.map((item) => item.tool),
      ['health_read', 'health_propose_note'],
    );
    const proposal = proposedChat.proposals[0];
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.id, returnedProposalId);
    assert.deepEqual(upstreamErrors, []);
    assert.equal(
      (await request<Note[]>(path + '/notes?q=Fictional%20reviewed%20follow-up')).length,
      0,
      'The model cannot accept its own proposal',
    );
    await request(`${path}/assistant/chats/${proposedChat.id}/apply`, 'POST', {
      proposalId: proposal.id,
    });
    assert.equal(
      (await request<Note>(`${path}/notes/${encodeURIComponent(proposal.noteId)}`)).content,
      'Fictional tool-loop persistence marker',
    );
    await request(`${path}/assistant/chats/${proposedChat.id}/apply`, 'POST', {
      proposalId: proposal.id,
    });
    assert.equal(
      (await request<Note[]>(path + '/notes?q=Fictional%20reviewed%20follow-up')).length,
      1,
      'Repeated acceptance retains one note',
    );

    const self = await request<Note>(path + '/notes/patient');
    await request(path + `/notes/${encodeURIComponent(self.id)}`, 'PUT', {
      kind: 'person',
      title: self.title,
      content: marker,
      person: self.person,
      pinned: self.pinned,
      links: self.links,
      version: self.version,
    });
    const snapshot = () => request<ComplaintSnapshot>(path + '/import-diagnostics');
    const delayedUpload = await uploadWithComplaintDelay(base, path, cookie, original);
    const uploaded = delayedUpload.intake;
    assert.equal(uploaded.sha256, sha(original));
    const originalUrl = uploaded.contentUrl;
    assert.deepEqual(await request(originalUrl, 'GET', undefined, { binary: true }), original);
    const uploadTiming = assertSlowUpload(
      await snapshot(),
      delayedUpload.operationId,
      original.length,
    );
    assert.equal(
      uploadTiming.retentionMethod,
      'adopt',
      'supported Compose staging and workspace mounts must avoid a second plaintext copy',
    );

    // Only the fictional upstream is held. The app's real conversion scheduler,
    // proxy, active scope and diagnostics run without injected production hooks.
    let upstreamStarted!: () => void;
    const upstreamReady = new Promise<void>((done) => {
      upstreamStarted = done;
    });
    delayedUpstream = {
      started: upstreamStarted,
      released: new Promise<void>((done) => {
        releaseUpstream = done;
      }),
    };
    let conversion: { chatId: string };
    try {
      conversion = await request<{ chatId: string }>(
        path + `/intakes/${uploaded.id}/convert`,
        'POST',
        { version: uploaded.version },
      );
      await Promise.race([
        upstreamReady,
        delay(30000, undefined, { ref: false }).then(() => {
          throw Error('Conversion did not reach fictional upstream');
        }),
      ]);
      const waitingBefore = assertProviderWait(await snapshot(), delayedUpload.operationId);
      await delay(complaintDelayMs);
      const waitingAfter = assertProviderWait(await snapshot(), delayedUpload.operationId);
      assert.ok(waitingAfter.elapsedWallMs >= waitingBefore.elapsedWallMs + complaintDelayMs * 0.8);
      assert.ok(
        waitingAfter.progressAgeMs >= complaintDelayMs * 0.75,
        'stalled provider wait must expose age since progress',
      );
    } finally {
      releaseUpstream();
    }
    const converted = await waitForChat(path, conversion.chatId);
    assert.equal(converted.status, 'idle', converted.error);
    assert.equal(
      converted.reading?.reason,
      'no_progress',
      'scripted timing response must not claim completed extraction',
    );
    const processing = completedProviderWait(await snapshot(), delayedUpload.operationId);
    assert.deepEqual(upstreamErrors, []);
    const reviewTiming = await reviewWithComplaintDelay(base, cookie, profile.id, snapshot);
    const qualification = {
      kind: 'controlled_complaint_qualification',
      autonomousAccuracyOrCacheSavings: false,
      defaultCompactDiagnostics: true,
      environment,
      ...verifyRunningSource(),
      upload: uploadTiming,
      processing: {
        status: processing.status,
        readingStatus: converted.reading?.status,
        readingReason: converted.reading?.reason,
        providerMs: processing.spans
          .filter((span) => span.phase === 'provider_request')
          .map((span) => span.durationMs),
      },
      review: reviewTiming,
    };
    t.diagnostic('Controlled complaint qualification: ' + JSON.stringify(qualification));
    writeFileSync(resolve(state, 'chatgpt', 'fictional-marker'), authMarker, { mode: 0o600 });
    verifyState(authMarker);
    // Lock publishes pending compact summaries before the actual process/container recreation.
    await request(path + '/lock', 'POST', {});
    await stop();

    const plaintext = durableFiles(data).flatMap((file) => {
      const bytes = readFileSync(file);
      return [marker, setup.recoveryKit.phrase, original.toString()]
        .filter((value) => bytes.includes(Buffer.from(value)))
        .map(() => file);
    });
    assert.deepEqual(
      plaintext,
      [],
      'Durable archive files must not contain fictional private plaintext.',
    );

    await start();
    verifyState(authMarker);
    assert.equal((await request<Profile[]>('/api/profiles'))[0].locked, true);
    await request(path + '/unlock', 'POST', { recovery: setup.recoveryKit });
    assert.equal((await request<Note>(path + '/notes/patient')).content, marker);
    assert.equal(
      (await request<Note>(`${path}/notes/${encodeURIComponent(proposal.noteId)}`)).content,
      'Fictional tool-loop persistence marker',
    );
    assert.deepEqual(await request(originalUrl, 'GET', undefined, { binary: true }), original);
    const retainedChats = await request<ChatResult[]>(path + '/assistant/chats');
    assert.equal(retainedChats.find((item) => item.id === chat.id)?.status, 'idle');
    const restoredDiagnostics = await snapshot();
    assertSlowUpload(restoredDiagnostics, delayedUpload.operationId, original.length);
    completedProviderWait(restoredDiagnostics, delayedUpload.operationId);
    const restoredReview = assertCompactComplaintSnapshot(restoredDiagnostics).find(
      (operation) => operation.operationId === reviewTiming.operationId,
    );
    assert.equal(restoredReview?.client?.kind, 'review_open');
    assert.equal(restoredReview?.status, 'completed');
    assert.ok(restoredReview?.client?.requestIds?.includes(reviewTiming.requestId));
    t.diagnostic(
      'Controlled complaint timelines retained after explicit lock, container recreation and unlock.',
    );
    if (performanceOnly) {
      verifyRunningSource();
      return;
    }
    await request(path + '/lock', 'POST', {});
    await stop();

    rmSync(resolve(data, 'profiles', profile.id, 'cache'), { recursive: true, force: true });
    await start();
    verifyState(authMarker);
    const rebuilt = await request<{ metrics: { cacheHit: boolean } }>(path + '/unlock', 'POST', {
      recovery: setup.recoveryKit,
    });
    assert.equal(rebuilt.metrics.cacheHit, false);
    assert.equal((await request<Note>(path + '/notes/patient')).content, marker);
    assert.equal(
      (await request<Note>(`${path}/notes/${encodeURIComponent(proposal.noteId)}`)).content,
      'Fictional tool-loop persistence marker',
    );
    assert.deepEqual(await request(originalUrl, 'GET', undefined, { binary: true }), original);
    assert.equal(
      (await request<ChatResult[]>(path + '/assistant/chats')).find((item) => item.id === chat.id)
        ?.status,
      'idle',
    );
    const rebuiltSelf = await request<Note>(path + '/notes/patient'),
      crashMarker = marker + ' after acknowledged update';
    await request(path + `/notes/${encodeURIComponent(rebuiltSelf.id)}`, 'PUT', {
      kind: 'person',
      title: rebuiltSelf.title,
      content: crashMarker,
      person: rebuiltSelf.person,
      pinned: rebuiltSelf.pinned,
      links: rebuiltSelf.links,
      version: rebuiltSelf.version,
    });
    execFileSync(
      process.env.CRS_DOCKER || 'docker',
      ['kill', '--signal', 'KILL', `${composeProject}-health-1`],
      { encoding: 'utf8', timeout: 30000 },
    );
    await waitForLauncherExit();

    await start();
    verifyState(authMarker);
    await request(path + '/unlock', 'POST', { recovery: setup.recoveryKit });
    assert.equal((await request<Note>(path + '/notes/patient')).content, crashMarker);
    assert.deepEqual(await request(originalUrl, 'GET', undefined, { binary: true }), original);
    assert.equal(
      (await request<ChatResult[]>(path + '/assistant/chats')).find((item) => item.id === chat.id)
        ?.status,
      'idle',
    );
    const finalConnection = await request<ConnectionResult>(
      path + '/assistant/test-connection',
      'POST',
      { pdf: true },
    );
    assert.equal(finalConnection.available, true);
    assert.equal(finalConnection.capabilities.pdf, true);
    verifyRunningSource();
  },
);
