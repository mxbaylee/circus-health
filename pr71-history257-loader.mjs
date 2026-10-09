import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { basename, resolve, sep } from 'node:path';

const root = resolve(process.cwd()) + sep;
const head = 'e7e24f87da3cad2efb36bcd1da18dcaf5e4ffbfe';
const files = new Map([
  ['src/server/intake-state-collections.ts', 'e57f440db967c2f18b1dd0c5ddc6e3ca94b2c7470dc0e1060df234da7e831dcb'],
  ['src/server/intake-state-storage.ts', '3d5e2e3b3943721adc52a5454ed0afec231346e09eac5514062913c08e1823f6'],
  ['src/server/record-versions.ts', '1433c529eec61e2ab2a2c1680caa1f577da6c42e54ae7e73286d885e5a822913'],
  ['src/server/clinical-review-work.ts', 'fbc2a0fcad7ee2c96807e118d1ef8a3e2675bb72c245fc0d54d3efcce1d5cf9d'],
  ['src/server/clinical-review-artifact-proof.ts', 'aeeb22a93428b6436be3b134dc0f23af8b7c6029a53bf26b39a8b8506ccf3051'],
  ['src/server/intake-identity-native.ts', 'a9788f6c96bb8d1bc9fd16169f09bf883c93581903cd8c72742e7849c0232df6'],
  ['src/server/intake-file-work.ts', '641041bed8343e7e13943f707b0a39748642898e0bbfe25fdc015bf15299c32e'],
  ['src/server/test/intake-identity-native-artifact-history.test.ts', '975c71299a249477486beb416740322958ffca32ec739fbd88bb07aff00633a2'],
]);
const hash = (value) => createHash('sha256').update(value).digest('hex');
if (execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== head)
  throw Error('History257 observer requires the exact published source');
try {
  execFileSync('git', ['diff', '--quiet', 'HEAD']);
} catch {
  throw Error('History257 observer requires a clean tracked checkout');
}
if (process.env.CRS_HISTORY257_DIAGNOSTIC !== '1' || !process.env.CRS_HISTORY257_PROFILE_DIR)
  throw Error('History257 observer requires explicit opt-in and profile output');
for (const [name, expected] of files)
  if (hash(readFileSync(root + name, 'utf8')) !== expected)
    throw Error(`History257 observer source differs: ${name}`);

function once(source, before, after) {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0)
    throw Error(`History257 observer anchor missing or repeated: ${before.slice(0, 60)}`);
  return source.slice(0, at) + after + source.slice(at + before.length);
}
const bump = (key) => `const pr71Probe = (globalThis as any).__pr71History257;
      if (pr71Probe) pr71Probe.${key}++;`;

const transforms = new Map([
  ['src/server/intake-state-collections.ts', (source) => {
    source = once(source,
      "    withIntakeWork(db, 'warm', () => {\n      let certificate: IntakeTreeReadCertificate | undefined;",
      `    withIntakeWork(db, 'warm', () => {\n      ${bump('runReadAttempts')}\n      let certificate: IntakeTreeReadCertificate | undefined;`);
    return once(source,
      '  ): SchemaRecord | { target: SchemaTarget | undefined } {\n    let admission:',
      `  ): SchemaRecord | { target: SchemaTarget | undefined } {\n    const pr71SchemaProbe = (globalThis as any).__pr71History257;\n    if (pr71SchemaProbe) pr71SchemaProbe[operation.kind === 'field' ? 'schemaFieldAttempts' : 'schemaHeaderAttempts']++;\n    let admission:`);
  }],
  ['src/server/intake-state-storage.ts', (source) => once(source,
    '  function ready() {\n    if (closed || !db.isOpen)',
    `  function ready() {\n    ${bump('storageReadyAttempts')}\n    if (closed || !db.isOpen)`) ],
  ['src/server/record-versions.ts', (source) => once(source,
    "function readHead(storage: RecordStorage): RecordObjectReference | null {\n  recordVersionWork('headReadCalls');",
    "function readHead(storage: RecordStorage): RecordObjectReference | null {\n  const pr71Probe = (globalThis as any).__pr71History257;\n  if (pr71Probe) pr71Probe.acceptedHeadReadAttempts++;\n  recordVersionWork('headReadCalls');")],
  ['src/server/clinical-review-work.ts', (source) => {
    source = once(source, '      const assertResume = boundary.capture();',
      "      const pr71Probe = (globalThis as any).__pr71History257;\n      if (pr71Probe) pr71Probe.captureAttempts++;\n      const assertResume = boundary.capture();");
    return once(source, '      assertResume();',
      '      if (pr71Probe) pr71Probe.resumeAttempts++;\n      assertResume();');
  }],
  ['src/server/clinical-review-artifact-proof.ts', (source) => {
    source = once(source, '    assertCurrent() {\n      let seen = 0;',
      "    assertCurrent() {\n      const pr71Probe = (globalThis as any).__pr71History257;\n      if (pr71Probe && table === 'identity_artifact_proof') pr71Probe.proofSweepAttempts++;\n      let seen = 0;");
    return once(source, '        .iterate()) {\n        if (',
      "        .iterate()) {\n        if (pr71Probe && table === 'identity_artifact_proof') pr71Probe.proofRowsInspected++;\n        if (");
  }],
  ['src/server/intake-identity-native.ts', (source) => {
    source = once(source,
      '    capture() {\n      context.assertCurrent();\n      stored.assertArtifacts();',
      "    capture() {\n      const pr71Probe = (globalThis as any).__pr71History257;\n      if (pr71Probe) pr71Probe.nativeCaptureAttempts++;\n      context.assertCurrent();\n      stored.assertArtifacts();");
    return once(source,
      '      return () => {\n        context.assertCurrent();\n        if (reviewPreparationStamp(db) !== stamp)',
      '      return () => {\n        if (pr71Probe) pr71Probe.nativeResumeAttempts++;\n        context.assertCurrent();\n        if (reviewPreparationStamp(db) !== stamp)');
  }],
  ['src/server/intake-file-work.ts', (source) => once(source,
    'export function recordIntakeFileWork(metric: keyof FileWork, amount = 1): void {\n  const counters = scope.getStore();',
    `export function recordIntakeFileWork(metric: keyof FileWork, amount = 1): void {\n  const pr71Probe = (globalThis as any).__pr71History257;\n  if (pr71Probe && (metric === 'streamReadBytes' || metric === 'streamHashBytes' || metric === 'verificationCacheHits')) pr71Probe[metric] += amount;\n  const counters = scope.getStore();`) ],
  ['src/server/test/intake-identity-native-artifact-history.test.ts', (source) => {
    source = once(source, "import { DatabaseSync } from 'node:sqlite';",
      "import { DatabaseSync } from 'node:sqlite';\nimport { Session } from 'node:inspector';");
    source = once(source,
      'async function artifactHistoryFixture(t: test.TestContext, phase: (name: string) => void) {',
      'async function artifactHistoryFixture(t: test.TestContext, phase: (name: string) => void, pr71StartProfile: () => Promise<void>, pr71StopProfile: (reason: string) => Promise<void>) {');
    source = once(source,
      `    const started = performance.now();
    const phase = (name: string) => {
      if (process.env.CRS_ARTIFACT_HISTORY_PHASES === '1')
        process.stderr.write(
          JSON.stringify({
            fixture: 'fictional retained artifact history',
            phase: name,
            elapsedMs: performance.now() - started,
          }) + '\\n',
        );
    };
    phase('fixture-start');
    t.after(() => phase('test-teardown'));`,
      `    const started = performance.now();
    const pr71Counters = (globalThis as any).__pr71History257 = {
      runReadAttempts: 0, schemaHeaderAttempts: 0, schemaFieldAttempts: 0,
      storageReadyAttempts: 0, acceptedHeadReadAttempts: 0,
      captureAttempts: 0, resumeAttempts: 0,
      nativeCaptureAttempts: 0, nativeResumeAttempts: 0,
      proofSweepAttempts: 0, proofRowsInspected: 0,
      streamReadBytes: 0, streamHashBytes: 0, verificationCacheHits: 0,
    };
    const pr71Point = () => ({
      ms: performance.now(), cpu: process.cpuUsage(), fsWrite: process.resourceUsage().fsWrite,
      counters: { ...pr71Counters },
    });
    let pr71Last = pr71Point();
    let pr71LastPhase = 'fixture-start';
    const pr71Emit = (reason: string, name: string) => {
      const now = pr71Point();
      const counters = Object.fromEntries(Object.keys(now.counters).map((key) => [key,
        now.counters[key] - pr71Last.counters[key]]));
      process.stderr.write(JSON.stringify({
        probe: 'history257-phase', reason, from: pr71LastPhase, to: name,
        elapsedMs: now.ms - pr71Last.ms,
        cpuMicros: now.cpu.user + now.cpu.system - pr71Last.cpu.user - pr71Last.cpu.system,
        processFsWrite: now.fsWrite - pr71Last.fsWrite,
        counters,
      }) + '\\n');
      pr71Last = now;
      pr71LastPhase = name;
    };
    let pr71Session: Session | undefined;
    let pr71Start: Promise<void> | undefined;
    let pr71ProfileStarted = false;
    let pr71Stop: Promise<void> | undefined;
    let pr71Aborted = false;
    const pr71Post = (session: Session, command: string) => new Promise<any>((resolve, reject) =>
      session.post(command, (error, result) => error ? reject(error) : resolve(result)));
    const pr71StartProfile = async () => {
      if (pr71Aborted || t.signal.aborted) return;
      const session = new Session();
      pr71Session = session;
      pr71Start = (async () => {
        try {
          session.connect();
          await pr71Post(session, 'Profiler.enable');
          await pr71Post(session, 'Profiler.start');
          pr71ProfileStarted = true;
        } catch {
          process.stderr.write(JSON.stringify({ probe: 'history257-profile', outcome: 'start-unavailable' }) + '\\n');
          session.disconnect();
          if (pr71Session === session) pr71Session = undefined;
        }
      })();
      await pr71Start;
    };
    const pr71StopProfile = (reason: string) => {
      if (pr71Stop) return pr71Stop;
      if (!pr71Session && !pr71Start) return Promise.resolve();
      pr71Stop = (async () => {
        await pr71Start;
        const session = pr71Session;
        if (!session) return;
        try {
          if (pr71ProfileStarted) {
            const result = await pr71Post(session, 'Profiler.stop');
            const encoded = JSON.stringify(result.profile);
            writeFileSync(join(process.env.CRS_HISTORY257_PROFILE_DIR!, 'original257-cold.cpuprofile'), encoded);
            process.stderr.write(JSON.stringify({
              probe: 'history257-profile', outcome: reason, bytes: Buffer.byteLength(encoded),
            }) + '\\n');
          }
        } catch {
          process.stderr.write(JSON.stringify({ probe: 'history257-profile', outcome: 'stop-unavailable' }) + '\\n');
        } finally {
          session.disconnect();
          if (pr71Session === session) pr71Session = undefined;
        }
      })();
      return pr71Stop;
    };
    const phase = (name: string) => {
      pr71Emit('marker', name);
      if (process.env.CRS_ARTIFACT_HISTORY_PHASES === '1')
        process.stderr.write(JSON.stringify({
          fixture: 'fictional retained artifact history', phase: name,
          elapsedMs: performance.now() - started,
        }) + '\\n');
    };
    const pr71Abort = () => {
      pr71Aborted = true;
      pr71Emit('abort', 'aborted');
      void pr71StopProfile('abort');
    };
    t.signal.addEventListener('abort', pr71Abort, { once: true });
    phase('fixture-start');
    t.after(async () => {
      phase('test-teardown');
      await pr71StopProfile('teardown');
      t.signal.removeEventListener('abort', pr71Abort);
      delete (globalThis as any).__pr71History257;
    });`);
    source = once(source,
      `  const cold = await f.review();
  assert.ok(cold.scopeReference);`,
      `  await pr71StartProfile();
  let cold: Awaited<ReturnType<typeof f.review>>;
  try { cold = await f.review(); }
  finally { await pr71StopProfile('cold-settled'); }
  assert.ok(cold.scopeReference);`);
    return once(source,
      '    const f = await artifactHistoryFixture(t, phase);',
      '    const f = await artifactHistoryFixture(t, phase, pr71StartProfile, pr71StopProfile);');
  }],
]);

if (process.env.PR71_HISTORY257_DRY === '1') {
  for (const [name, transform] of transforms) {
    const output = transform(readFileSync(root + name, 'utf8'));
    stripTypeScriptTypes(output);
    writeFileSync(`/private/tmp/pr71-history257-transformed-${basename(name)}`, output);
    process.stdout.write(JSON.stringify({ name, sha256: hash(output), bytes: Buffer.byteLength(output) }) + '\n');
  }
} else {
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      const name = url.startsWith('file:') ? new URL(url).pathname.slice(root.length) : '';
      const expected = files.get(name);
      if (!expected || !transforms.has(name)) return loaded;
      const source = String(loaded.source);
      if (hash(source) !== expected) throw Error(`Loaded History257 source differs: ${name}`);
      return { ...loaded, source: transforms.get(name)(source) };
    },
  });
}
