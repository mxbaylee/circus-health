import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

const sourceHead = 'c04f278ab338a6973d30658e7309fcbb21365b67';
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim() + '/';
const paths = new Map([
  ['src/server/intake-identity-native.ts', 'a9788f6c96bb8d1bc9fd16169f09bf883c93581903cd8c72742e7849c0232df6'],
  ['src/server/clinical-review-artifact-proof.ts', 'aeeb22a93428b6436be3b134dc0f23af8b7c6029a53bf26b39a8b8506ccf3051'],
  ['src/server/clinical-review-work.ts', 'fbc2a0fcad7ee2c96807e118d1ef8a3e2675bb72c245fc0d54d3efcce1d5cf9d'],
  ['src/server/test/intake-identity-native-artifact-history.test.ts', '975c71299a249477486beb416740322958ffca32ec739fbd88bb07aff00633a2'],
]);
const hash = (value) => createHash('sha256').update(value).digest('hex');
if (process.cwd() + '/' !== root)
  throw Error('Run the identity diagnostic from the repository root');
try {
  execFileSync('git', ['merge-base', '--is-ancestor', sourceHead, 'HEAD'], { stdio: 'ignore' });
  execFileSync('git', ['diff', '--quiet', sourceHead, '--', 'src/server', 'src/shared'], { stdio: 'ignore' });
} catch {
  throw Error('Identity diagnostic source differs from pinned published c04 source');
}
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim())
  throw Error('Identity diagnostic requires a clean tracked worktree');
for (const [name, digest] of paths)
  if (hash(readFileSync(root + name, 'utf8')) !== digest)
    throw Error(`Pinned identity diagnostic source changed: ${name}`);

function once(source, before, after) {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0)
    throw Error(`Identity diagnostic anchor absent or repeated: ${before.slice(0, 48)}`);
  return source.slice(0, at) + after + source.slice(at + before.length);
}

function identity(source) {
  source = once(
    source,
    "import { verifyIntakeFileHashWork } from './intake-files.ts';",
    "import { verifyIntakeFileHashWork } from './intake-files.ts';\nimport { createIntakeFileWorkCounters, withIntakeFileWork } from './intake-file-work.ts';",
  );
  source = once(
    source,
    'function* verifyPreviewArtifactsWork(',
    `async function pr71Timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const probe = (globalThis as any).__pr71IdentityPhase;
  const started = performance.now();
  try {
    return await run();
  } finally {
    if (probe) {
      const elapsed = performance.now() - started;
      probe.counters[label + 'Calls'] = (probe.counters[label + 'Calls'] || 0) + 1;
      probe.counters[label + 'Milliseconds'] = (probe.counters[label + 'Milliseconds'] || 0) + elapsed;
      if (probe.timedEmitted++ < 24)
        process.stderr.write('PR71_IDENTITY_TIMED ' + JSON.stringify({
          phase: probe.phase, label, elapsedMs: elapsed,
        }) + '\\n');
    }
  }
}
function pr71TimedSync<T>(label: string, run: () => T): T {
  const probe = (globalThis as any).__pr71IdentityPhase;
  const started = performance.now();
  try {
    return run();
  } finally {
    if (probe) {
      const elapsed = performance.now() - started;
      probe.counters[label + 'Calls'] = (probe.counters[label + 'Calls'] || 0) + 1;
      probe.counters[label + 'Milliseconds'] = (probe.counters[label + 'Milliseconds'] || 0) + elapsed;
      if (probe.timedEmitted++ < 24)
        process.stderr.write('PR71_IDENTITY_TIMED ' + JSON.stringify({
          phase: probe.phase, label, elapsedMs: elapsed,
        }) + '\\n');
    }
  }
}
async function pr71Sweep<T>(label: 'first' | 'final' | 'cached', run: () => Promise<T>): Promise<T> {
  const probe = (globalThis as any).__pr71IdentityPhase;
  const before = probe ? { ...probe.counters } : null;
  // The original direct-warm test already owns its ALS counter.
  const file = label === 'cached' ? null : createIntakeFileWorkCounters();
  const started = performance.now();
  let outcome = 'failed';
  try {
    const value = await (file ? withIntakeFileWork(file, run) : run());
    outcome = 'completed';
    return value;
  } finally {
    if (probe && probe.sweeps.length < 12) {
      const item = {
        phase: probe.phase, label, outcome,
        elapsedMs: performance.now() - started,
        fileWorkCaptured: file !== null,
        cacheHits: file?.verificationCacheHits ?? null,
        streamReadCalls: file?.streamReadCalls ?? null,
        streamReadBytes: file?.streamReadBytes ?? null,
        streamHashBytes: file?.streamHashBytes ?? null,
        proofSweeps: probe.counters.proofSweeps - before!.proofSweeps,
        proofRows: probe.counters.proofRows - before!.proofRows,
        proofMilliseconds: probe.counters.proofMilliseconds - before!.proofMilliseconds,
      };
      probe.sweeps.push(item);
      process.stderr.write('PR71_IDENTITY_SWEEP ' + JSON.stringify(item) + '\\n');
    }
  }
}
function* verifyPreviewArtifactsWork(`,
  );
  source = once(
    source,
    'await runNativeIdentityWork(context, proof, verifyPreviewArtifactsWork(context, proof));',
    "await pr71Sweep('cached', () =>\n              runNativeIdentityWork(context, proof!, verifyPreviewArtifactsWork(context, proof!)));",
  );
  const target = 'await runNativeIdentityWork(context, stored, verifyPreviewArtifactsWork(context, stored));';
  const first = source.indexOf(target), second = source.indexOf(target, first + target.length);
  if (first < 0 || second < 0 || source.indexOf(target, second + target.length) >= 0)
    throw Error('Expected exactly two full identity artifact sweeps');
  source = source.slice(0, second) +
    "await pr71Sweep('final', () =>\n        runNativeIdentityWork(context, stored, verifyPreviewArtifactsWork(context, stored)));" +
    source.slice(second + target.length);
  source = source.slice(0, first) +
    "await pr71Sweep('first', () =>\n        runNativeIdentityWork(context, stored, verifyPreviewArtifactsWork(context, stored)));" +
    source.slice(first + target.length);
  source = once(source,
    'let built = await build(context, original, stored);',
    "let built = await pr71Timed('fullBuild', () => build(context, original, stored));");
  source = once(source,
    'built = await build(context, freshOriginal, stored);',
    "built = await pr71Timed('fullBuild', () => build(context, freshOriginal, stored));");
  source = once(source,
    "await writeSnapshot(context, built, stored, catalog, 'preview');",
    "await pr71Timed('writeSnapshot', () => writeSnapshot(context, built, stored, catalog, 'preview'));");
  source = once(source,
    'const changes = await catalog.finalChanges();',
    "const changes = await pr71Timed('catalogFinalChanges', () => catalog.finalChanges());");
  source = once(source,
    '      if (changes.length)\n        collections.commitMaintenance(',
    "      if (changes.length)\n        pr71TimedSync('commitMaintenance', () => collections.commitMaintenance(");
  source = once(source,
    '            changes,\n          }),\n        );',
    '            changes,\n          }),\n        ));');
  return source;
}

function proof(source) {
  source = once(
    source,
    '    assertCurrent() {\n      let seen = 0;',
    "    assertCurrent() {\n      const probe = (globalThis as any).__pr71IdentityPhase;\n      const started = performance.now();\n      if (probe) probe.counters.proofSweeps++;\n      try {\n      let seen = 0;",
  );
  source = once(
    source,
    '        .iterate()) {\n        if (',
    '        .iterate()) {\n        if (probe) probe.counters.proofRows++;\n        if (',
  );
  source = once(
    source,
    '      if (seen !== count) throw changed();\n    },',
    '      if (seen !== count) throw changed();\n      } finally { if (probe) probe.counters.proofMilliseconds += performance.now() - started; }\n    },',
  );
  return source;
}

function work(source) {
  source = once(
    source,
    '      const next = work.next();',
    "      const probe = (globalThis as any).__pr71IdentityPhase;\n      const stepStart = performance.now();\n      const next = work.next();\n      if (probe) { probe.counters.completedGeneratorSteps++; probe.counters.generatorMilliseconds += performance.now() - stepStart; }",
  );
  source = once(
    source,
    '      const assertResume = boundary.capture();',
    "      const captureStart = performance.now();\n      const assertResume = boundary.capture();\n      if (probe) { probe.counters.completedCaptureCalls++; probe.counters.captureMilliseconds += performance.now() - captureStart; }",
  );
  source = once(
    source,
    '      assertResume();',
    "      const resumeStart = performance.now();\n      assertResume();\n      if (probe) { probe.counters.completedResumeCalls++; probe.counters.resumeMilliseconds += performance.now() - resumeStart; }",
  );
  return source;
}

function test(source) {
  source = once(
    source,
    '    const started = performance.now();\n    const phase = (name: string) => {',
    `    const started = performance.now();
    (globalThis as any).__pr71IdentityPhase = {
      phase: '', sweeps: [], timedEmitted: 0, counters: {
        proofSweeps: 0, proofRows: 0, proofMilliseconds: 0,
        completedGeneratorSteps: 0, generatorMilliseconds: 0,
        completedCaptureCalls: 0, captureMilliseconds: 0,
        completedResumeCalls: 0, resumeMilliseconds: 0,
      },
    };
    const phase = (name: string) => {
      const probe = (globalThis as any).__pr71IdentityPhase;
      probe.phase = name;
      process.stderr.write('PR71_IDENTITY_PHASE ' + JSON.stringify({
        phase: name, elapsedMs: performance.now() - started,
        counters: { ...probe.counters }, sweeps: probe.sweeps,
      }) + '\\n');`,
  );
  source = once(source,
    "    t.after(() => phase('test-teardown'));",
    "    t.after(() => { phase('test-teardown'); delete (globalThis as any).__pr71IdentityPhase; });");
  return source;
}

if (process.env.PR71_IDENTITY_SOURCE_SMOKE === '1') {
  for (const name of paths.keys()) {
    const source = readFileSync(root + name, 'utf8');
    const transformed =
      name.endsWith('/intake-identity-native.ts') ? identity(source) :
      name.endsWith('/clinical-review-artifact-proof.ts') ? proof(source) :
      name.endsWith('/clinical-review-work.ts') ? work(source) : test(source);
    stripTypeScriptTypes(transformed);
  }
  process.stdout.write('Pinned c04 identity diagnostic transformed all four sources\n');
}

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    const name = url.startsWith('file:') ? new URL(url).pathname.slice(root.length) : '';
    const digest = paths.get(name);
    if (!digest) return loaded;
    const source = String(loaded.source);
    if (hash(source) !== digest) throw Error(`Loaded identity diagnostic source changed: ${name}`);
    return { ...loaded, source:
      name.endsWith('/intake-identity-native.ts') ? identity(source) :
      name.endsWith('/clinical-review-artifact-proof.ts') ? proof(source) :
      name.endsWith('/clinical-review-work.ts') ? work(source) : test(source) };
  },
});
