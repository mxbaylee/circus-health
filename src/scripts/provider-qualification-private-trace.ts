/** Qualification wiring only. Payload capture remains the existing server trace. */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { outsideGit } from '../../deploy/run.ts';
import type { ImportDiagnosticExport } from '../server/import-diagnostics.ts';
import type { PrivateTraceStatus } from '../server/import-private-trace.ts';
import type { QualificationRequestBudget } from './provider-qualification-request-budget.ts';

const MiB = 1024 * 1024;
const issuedGrants = new WeakSet<QualificationPrivateTrace>();
export const qualificationPrivateTraceLimits = {
  maxTotalBytes: 512 * MiB,
  maxEntryBytes: 24 * MiB,
  maxEntries: 8192,
};
const scope =
  'Existing import trace for this attempt’s independently fictional profile only. Import model/tool payloads remain protected outside Git. Capability probes lack import context and their payloads are excluded. Status snapshots cannot establish complete capture; expiration, omissions, truncation and shutdown tails limit the evidence. No renewal or automatic rerun.';
export interface QualificationPrivateTrace {
  directory: string;
  grantDirectory: string;
  grantFile: string;
}
export interface QualificationPrivateTraceReadiness {
  profileId: string;
  expiresAt: string;
  checkedAt: string;
  admittedRequests: 0;
  status: PrivateTraceStatus;
}
export interface QualificationPrivateTraceReport {
  requested: boolean;
  scope: string;
  readiness: QualificationPrivateTraceReadiness | null;
  latestStatus: PrivateTraceStatus | null;
  latestStatusAt: string | null;
  teardown: {
    boundary: string;
    lastStatusAt: string | null;
    lastStatus: PrivateTraceStatus | null;
    revocationStartedAt: string;
    revokedAt: string | null;
  } | null;
  grantRevoked: boolean;
  failure: string | null;
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}
export function qualificationPrivateTraceRequested(continuing: boolean, env: NodeJS.ProcessEnv) {
  const acknowledged = env.CRS_IMPORT_PRIVATE_TRACE;
  if (acknowledged === undefined) return false;
  check(
    continuing && acknowledged === 'contains-health-data',
    'Private qualification tracing requires continuing approval and the explicit health-data acknowledgment.',
  );
  for (const key of [
    'CRS_IMPORT_PRIVATE_TRACE_DIR',
    'CRS_IMPORT_PRIVATE_TRACE_GRANT_FILE',
    'CRS_IMPORT_PRIVATE_TRACE_MAX_TOTAL_MIB',
    'CRS_IMPORT_PRIVATE_TRACE_MAX_ENTRY_MIB',
    'CRS_IMPORT_PRIVATE_TRACE_MAX_ENTRIES',
  ])
    check(
      env[key] === undefined,
      'Qualification tracing uses only fresh protected attempt paths and fixed limits.',
    );
  return true;
}
export function qualificationPrivateTraceReport(
  requested: boolean,
): QualificationPrivateTraceReport {
  return {
    requested,
    scope,
    readiness: null,
    latestStatus: null,
    latestStatusAt: null,
    teardown: null,
    grantRevoked: false,
    failure: null,
  };
}
function ownerDirectory(path: string) {
  check(
    isAbsolute(path) && realpathSync(path) === resolve(path),
    'Unsafe qualification trace directory.',
  );
  outsideGit(path);
  const info = lstatSync(path);
  check(
    !info.isSymbolicLink() &&
      info.isDirectory() &&
      typeof process.getuid === 'function' &&
      info.uid === process.getuid() &&
      (info.mode & 0o777) === 0o700,
    'Qualification trace directories must be canonical, owner-only and owned by this process.',
  );
}
function syncDirectory(directory: string) {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function prepareQualificationPrivateTrace(attempt: string): QualificationPrivateTrace {
  ownerDirectory(attempt);
  const directory = join(attempt, 'private-import-trace');
  const grantDirectory = join(attempt, 'private-trace-control');
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(grantDirectory, { mode: 0o700 });
  ownerDirectory(directory);
  ownerDirectory(grantDirectory);
  syncDirectory(attempt);
  return { directory, grantDirectory, grantFile: join(grantDirectory, 'grant.json') };
}
export function qualificationPrivateTraceCompose(trace: QualificationPrivateTrace) {
  ownerDirectory(trace.directory);
  ownerDirectory(trace.grantDirectory);
  check(
    trace.grantFile === join(trace.grantDirectory, 'grant.json'),
    'Unexpected qualification trace grant path.',
  );
  // Compose interpolates JSON strings too; preserve literal host dollars.
  const source = (path: string) => path.replace(/\$/gu, () => '$$');
  return {
    environment: {
      CRS_IMPORT_PRIVATE_TRACE: 'contains-health-data',
      CRS_IMPORT_PRIVATE_TRACE_DIR: '/qualification-private-trace',
      CRS_IMPORT_PRIVATE_TRACE_GRANT_FILE: '/qualification-private-trace-control/grant.json',
      CRS_IMPORT_PRIVATE_TRACE_MAX_TOTAL_MIB: '512',
      CRS_IMPORT_PRIVATE_TRACE_MAX_ENTRY_MIB: '24',
      CRS_IMPORT_PRIVATE_TRACE_MAX_ENTRIES: '8192',
    },
    volumes: [
      {
        type: 'bind',
        source: source(trace.directory),
        target: '/qualification-private-trace',
        bind: { create_host_path: false },
      },
      {
        type: 'bind',
        source: source(trace.grantDirectory),
        target: '/qualification-private-trace-control',
        read_only: true,
        bind: { create_host_path: false },
      },
    ],
  };
}
function grant(
  trace: QualificationPrivateTrace,
  profileId: string,
  ownedProfiles: ReadonlySet<string>,
  now: Date,
) {
  ownerDirectory(trace.grantDirectory);
  check(
    ownedProfiles.has(profileId) && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(profileId),
    'Private qualification tracing requires a profile created by this attempt.',
  );
  check(
    trace.grantFile === join(trace.grantDirectory, 'grant.json') &&
      !existsSync(trace.grantFile) &&
      !issuedGrants.has(trace),
    'A qualification trace grant cannot be replaced or renewed.',
  );
  issuedGrants.add(trace);
  // Stay just inside the existing 24-hour authorization ceiling. This is not a
  // model-time target; an expired grant makes later trace evidence incomplete.
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000 - 60_000).toISOString();
  const temporary = join(trace.grantDirectory, `.grant-${randomUUID()}.json`);
  let published = false;
  try {
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, JSON.stringify({ profileId, expiresAt }) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, trace.grantFile);
    published = true;
    syncDirectory(trace.grantDirectory);
  } finally {
    if (!published && existsSync(temporary)) unlinkSync(temporary);
  }
  return expiresAt;
}
/** There is no model call here: the caller must await this gate before probing. */
export async function prepareQualificationTraceProfile(
  trace: QualificationPrivateTrace,
  profileId: string,
  ownedProfiles: ReadonlySet<string>,
  options: {
    diagnostics(): Promise<Pick<ImportDiagnosticExport, 'privateTrace'>>;
    requestBudget(): QualificationRequestBudget;
    now?: () => Date;
  },
): Promise<QualificationPrivateTraceReadiness> {
  const now = options.now ?? (() => new Date());
  const expiresAt = grant(trace, profileId, ownedProfiles, now());
  const diagnostics = await options.diagnostics();
  const budget = options.requestBudget();
  const status = diagnostics.privateTrace;
  check(
    budget.runtimeClaimed && budget.admitted === 0 && budget.denied === 0 && !budget.stopReason,
    'Private trace readiness must precede every admitted model request.',
  );
  check(
    status?.enabled &&
      status.reason === null &&
      status.recordedEvents === 0 &&
      status.recordedBytes === 0 &&
      status.omittedEvents === 0 &&
      status.truncatedEvents === 0 &&
      status.limits.maxTotalBytes === qualificationPrivateTraceLimits.maxTotalBytes &&
      status.limits.maxEntryBytes === qualificationPrivateTraceLimits.maxEntryBytes &&
      status.limits.maxEntries === qualificationPrivateTraceLimits.maxEntries,
    'Private trace readiness failed; no model probe may start.',
  );
  return { profileId, expiresAt, checkedAt: now().toISOString(), admittedRequests: 0, status };
}
export function retainQualificationPrivateTraceStatus(
  report: QualificationPrivateTraceReport,
  status: PrivateTraceStatus | undefined,
) {
  if (!report.requested) return;
  report.latestStatus = status ?? null;
  report.latestStatusAt = new Date().toISOString();
  if (!status?.enabled || status.reason || status.omittedEvents > 0 || status.truncatedEvents > 0)
    report.failure =
      'Private trace is unavailable or partial; inspect protected evidence and its configured limits.';
}
export function finalizeQualificationPrivateTraceReport(report: QualificationPrivateTraceReport) {
  if (!report.requested) return;
  if (!report.readiness || !report.latestStatus?.recordedEvents)
    report.failure ??= 'Private trace readiness or retained import payload evidence is missing.';
  if (!report.grantRevoked)
    report.failure ??= 'Private qualification trace authorization could not be revoked.';
}
export function revokeQualificationPrivateTraceForReport(
  trace: QualificationPrivateTrace,
  report: QualificationPrivateTraceReport,
) {
  if (report.grantRevoked) return;
  report.teardown = {
    boundary:
      'Last completed diagnostic snapshot before authorization revocation and runtime stop. It may precede in-flight model/tool completion; shutdown tail and probe payloads are not covered.',
    lastStatusAt: report.latestStatusAt,
    lastStatus: report.latestStatus,
    revocationStartedAt: new Date().toISOString(),
    revokedAt: null,
  };
  revokeQualificationPrivateTrace(trace);
  report.grantRevoked = true;
  report.teardown.revokedAt = new Date().toISOString();
}
export function revokeQualificationPrivateTrace(trace: QualificationPrivateTrace) {
  ownerDirectory(trace.grantDirectory);
  check(
    trace.grantFile === join(trace.grantDirectory, 'grant.json'),
    'Unexpected qualification trace grant path.',
  );
  try {
    unlinkSync(trace.grantFile);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  syncDirectory(trace.grantDirectory);
}
