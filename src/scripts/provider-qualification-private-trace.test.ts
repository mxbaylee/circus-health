import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  createPrivateImportTrace,
  type PrivateTraceStatus,
} from '../server/import-private-trace.ts';
import {
  finalizeQualificationPrivateTraceReport,
  prepareQualificationPrivateTrace,
  prepareQualificationTraceProfile,
  qualificationPrivateTraceCompose,
  qualificationPrivateTraceLimits,
  qualificationPrivateTraceReport,
  qualificationPrivateTraceRequested,
  retainQualificationPrivateTraceStatus,
  revokeQualificationPrivateTrace,
  revokeQualificationPrivateTraceForReport,
} from './provider-qualification-private-trace.ts';
import type { QualificationRequestBudget } from './provider-qualification-request-budget.ts';

const profileId = 'independently-fictional-profile';
const budget: QualificationRequestBudget = {
  limit: 16,
  admitted: 0,
  denied: 0,
  runtimeClaimed: true,
  stopReason: null,
  scope: 'Independently fictional zero-admission receipt.',
};
function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fictional-qualification-trace-')));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function enabledStatus(): PrivateTraceStatus {
  return {
    enabled: true,
    recordedEvents: 0,
    recordedBytes: 0,
    omittedEvents: 0,
    truncatedEvents: 0,
    reason: null,
    limits: { ...qualificationPrivateTraceLimits },
    warning: 'Independently fictional status only.',
  };
}

test('private trace opt-in requires continuing mode and the existing explicit acknowledgment', () => {
  assert.equal(qualificationPrivateTraceRequested(true, {}), false);
  assert.equal(qualificationPrivateTraceRequested(false, {}), false);
  assert.equal(
    qualificationPrivateTraceRequested(true, { CRS_IMPORT_PRIVATE_TRACE: 'contains-health-data' }),
    true,
  );
  for (const [continuing, env] of [
    [false, { CRS_IMPORT_PRIVATE_TRACE: 'contains-health-data' }],
    [true, { CRS_IMPORT_PRIVATE_TRACE: 'true' }],
    [true, { CRS_IMPORT_PRIVATE_TRACE: '' }],
    ...[
      'CRS_IMPORT_PRIVATE_TRACE_DIR',
      'CRS_IMPORT_PRIVATE_TRACE_GRANT_FILE',
      'CRS_IMPORT_PRIVATE_TRACE_MAX_TOTAL_MIB',
      'CRS_IMPORT_PRIVATE_TRACE_MAX_ENTRY_MIB',
      'CRS_IMPORT_PRIVATE_TRACE_MAX_ENTRIES',
    ].map(
      (key) =>
        [
          true,
          { CRS_IMPORT_PRIVATE_TRACE: 'contains-health-data', [key]: 'fictional-override' },
        ] as const,
    ),
  ] as const)
    assert.throws(() => qualificationPrivateTraceRequested(continuing, env));
});

test('trace preparation rejects unsafe attempts and creates only fresh owner-only protected directories', (t) => {
  const base = fixture(t);
  const safe = join(base, 'safe');
  mkdirSync(safe, { mode: 0o700 });
  const trace = prepareQualificationPrivateTrace(safe);
  assert.equal(statSync(trace.directory).mode & 0o777, 0o700);
  assert.equal(statSync(trace.grantDirectory).mode & 0o777, 0o700);
  assert.equal(existsSync(trace.grantFile), false);
  assert.throws(() => prepareQualificationPrivateTrace(safe));
  const link = join(base, 'link');
  symlinkSync(safe, link, 'dir');
  assert.throws(() => prepareQualificationPrivateTrace(link));
  const broad = join(base, 'broad');
  mkdirSync(broad, { mode: 0o700 });
  chmodSync(broad, 0o755);
  assert.throws(() => prepareQualificationPrivateTrace(broad));
  const git = join(base, 'fictional-git');
  mkdirSync(git, { mode: 0o700 });
  mkdirSync(join(git, '.git'));
  assert.throws(() => prepareQualificationPrivateTrace(git));
});

test('fresh-profile grant enables the existing writer before probes, remains exact and revokes without renewal', async (t) => {
  const root = fixture(t);
  const trace = prepareQualificationPrivateTrace(root);
  let now = new Date();
  const writer = createPrivateImportTrace({
    directory: trace.directory,
    grantFile: trace.grantFile,
    acknowledged: true,
    now: () => now,
  });
  assert.equal(writer.status(profileId).enabled, false);
  let reads = 0;
  const readiness = await prepareQualificationTraceProfile(trace, profileId, new Set([profileId]), {
    diagnostics: async () => {
      reads++;
      assert.equal(statSync(trace.grantFile).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(trace.grantDirectory), ['grant.json']);
      return { privateTrace: writer.status(profileId) };
    },
    requestBudget: () => budget,
    now: () => now,
  });
  assert.equal(reads, 1);
  assert.equal(readiness.admittedRequests, 0);
  assert.equal(readiness.status.enabled, true);
  const lifetime = Date.parse(readiness.expiresAt) - now.getTime();
  assert.equal(lifetime, 24 * 60 * 60 * 1000 - 60_000);
  assert.deepEqual(JSON.parse(readFileSync(trace.grantFile, 'utf8')), {
    profileId,
    expiresAt: readiness.expiresAt,
  });
  const context = { importId: 'independently-fictional-original' };
  assert.equal(writer.capture('another-fictional-profile', 'model.request', context, {}), null);
  assert.ok(
    writer.capture(
      profileId,
      'model.request',
      context,
      { text: 'fictional request', credential: 'fictional-secret' },
      ['fictional-secret'],
    ),
  );
  assert.ok(
    writer.capture(profileId, 'tool.request', context, {
      name: 'fictional_read',
      arguments: { page: 1 },
    }),
  );
  const partition = readdirSync(trace.directory);
  assert.equal(partition.length, 1);
  const files = readdirSync(join(trace.directory, partition[0]));
  assert.equal(files.length, 2);
  for (const filename of files) {
    const path = join(trace.directory, partition[0], filename);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const content = gunzipSync(readFileSync(path)).toString();
    assert.doesNotMatch(content, /fictional-secret/);
    assert.equal(JSON.parse(content).format, 'circus-private-import-trace-v1');
  }
  now = new Date(Date.parse(readiness.expiresAt) + 1);
  assert.equal(writer.status(profileId).reason, 'grant_expired');
  assert.equal(writer.capture(profileId, 'tool.response', context, {}), null);
  revokeQualificationPrivateTrace(trace);
  revokeQualificationPrivateTrace(trace);
  assert.equal(existsSync(trace.grantFile), false);
  assert.equal(writer.status(profileId).enabled, false);
  await assert.rejects(
    prepareQualificationTraceProfile(trace, profileId, new Set([profileId]), {
      diagnostics: async () => ({ privateTrace: enabledStatus() }),
      requestBudget: () => budget,
    }),
    /cannot be replaced or renewed/,
  );
});

test('foreign profile and failed runtime readiness cannot proceed to model probes', async (t) => {
  const root = fixture(t);
  for (const [index, scenario] of [
    { owned: false, status: enabledStatus(), budget },
    { owned: true, status: undefined, budget },
    {
      owned: true,
      status: { ...enabledStatus(), enabled: false, reason: 'unsafe_or_unwritable_directory' },
      budget,
    },
    { owned: true, status: { ...enabledStatus(), omittedEvents: 1 }, budget },
    {
      owned: true,
      status: { ...enabledStatus(), limits: { ...qualificationPrivateTraceLimits, maxEntries: 1 } },
      budget,
    },
    { owned: true, status: enabledStatus(), budget: { ...budget, admitted: 1 } },
    { owned: true, status: enabledStatus(), budget: { ...budget, runtimeClaimed: false } },
  ].entries()) {
    const attempt = join(root, `case-${index}`);
    mkdirSync(attempt, { mode: 0o700 });
    const trace = prepareQualificationPrivateTrace(attempt);
    let probes = 0;
    await assert.rejects(async () => {
      await prepareQualificationTraceProfile(
        trace,
        profileId,
        new Set(scenario.owned ? [profileId] : []),
        {
          diagnostics: async () => ({ privateTrace: scenario.status }),
          requestBudget: () => scenario.budget,
        },
      );
      probes++;
    });
    assert.equal(probes, 0);
    if (!scenario.owned) assert.equal(existsSync(trace.grantFile), false);
    revokeQualificationPrivateTrace(trace);
  }
});

test('trace override mounts the whole read-only grant directory and preserves literal path dollars', (t) => {
  const root = fixture(t);
  const attempt = join(root, 'fictional-$attempt');
  mkdirSync(attempt, { mode: 0o700 });
  const trace = prepareQualificationPrivateTrace(attempt);
  const override = qualificationPrivateTraceCompose(trace);
  assert.equal(override.environment.CRS_IMPORT_PRIVATE_TRACE, 'contains-health-data');
  assert.equal(override.environment.CRS_IMPORT_PRIVATE_TRACE_MAX_TOTAL_MIB, '512');
  assert.equal(override.environment.CRS_IMPORT_PRIVATE_TRACE_MAX_ENTRY_MIB, '24');
  assert.equal(override.environment.CRS_IMPORT_PRIVATE_TRACE_MAX_ENTRIES, '8192');
  assert.equal(override.volumes[0].read_only, undefined);
  assert.equal(override.volumes[1].read_only, true);
  assert.equal(
    override.volumes[1].source,
    trace.grantDirectory.replaceAll('$', () => '$$'),
  );
  assert.equal(
    override.volumes[1].target + '/grant.json',
    override.environment.CRS_IMPORT_PRIVATE_TRACE_GRANT_FILE,
  );
  assert.ok(override.volumes.every((volume) => volume.bind.create_host_path === false));
});

test('metadata report distinguishes expiry, missing evidence, omissions and truncation without including payloads', () => {
  for (const status of [
    { ...enabledStatus(), enabled: false, reason: 'grant_expired' },
    { ...enabledStatus(), recordedEvents: 3, omittedEvents: 1 },
    { ...enabledStatus(), recordedEvents: 3, truncatedEvents: 1 },
  ]) {
    const report = qualificationPrivateTraceReport(true);
    retainQualificationPrivateTraceStatus(report, status);
    finalizeQualificationPrivateTraceReport(report);
    assert.ok(report.failure);
    assert.equal(report.latestStatus?.reason, status.reason);
    assert.ok(report.latestStatusAt);
    assert.match(report.scope, /Capability probes.*excluded/);
    assert.doesNotMatch(JSON.stringify(report), /fictional-secret|tool arguments|raw payload/);
  }
  const missing = qualificationPrivateTraceReport(true);
  finalizeQualificationPrivateTraceReport(missing);
  assert.match(missing.failure!, /missing/);
  const disabled = qualificationPrivateTraceReport(false);
  finalizeQualificationPrivateTraceReport(disabled);
  assert.equal(disabled.failure, null);
});

test('teardown freezes the last pre-revocation status and labels the unobserved tail explicitly', async (t) => {
  const trace = prepareQualificationPrivateTrace(fixture(t));
  const report = qualificationPrivateTraceReport(true);
  report.readiness = await prepareQualificationTraceProfile(
    trace,
    profileId,
    new Set([profileId]),
    {
      diagnostics: async () => ({ privateTrace: enabledStatus() }),
      requestBudget: () => budget,
    },
  );
  retainQualificationPrivateTraceStatus(report, { ...enabledStatus(), recordedEvents: 2 });
  revokeQualificationPrivateTraceForReport(trace, report);
  assert.equal(existsSync(trace.grantFile), false);
  assert.equal(report.grantRevoked, true);
  assert.equal(report.teardown?.lastStatus?.enabled, true);
  assert.equal(report.teardown?.lastStatus?.recordedEvents, 2);
  assert.equal(report.teardown?.lastStatusAt, report.latestStatusAt);
  assert.ok(report.teardown?.revokedAt);
  assert.match(report.teardown!.boundary, /shutdown tail and probe payloads are not covered/);
  finalizeQualificationPrivateTraceReport(report);
  assert.equal(report.failure, null);
});
