import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

export type PrivateTraceEvent =
  'model.request' | 'model.response' | 'tool.request' | 'tool.response';
export interface PrivateTraceStatus {
  enabled: boolean;
  recordedEvents: number;
  recordedBytes: number;
  omittedEvents: number;
  truncatedEvents: number;
  reason: string | null;
  limits: {
    maxTotalBytes: number;
    maxEntryBytes: number;
    maxEntries: number;
  };
  warning: string;
}
export type PrivateTraceOmissionReason = 'response_size';
export interface PrivateImportTrace {
  capture(
    profileId: string,
    event: PrivateTraceEvent,
    context: Record<string, string>,
    payload: unknown,
    secrets?: readonly string[],
    options?: { truncated?: boolean },
  ): string | null;
  omit(
    profileId: string,
    event: PrivateTraceEvent,
    context: Record<string, string>,
    reason: PrivateTraceOmissionReason,
  ): void;
  status(profileId: string): PrivateTraceStatus;
}
interface Options {
  directory?: string;
  grantFile?: string;
  acknowledged?: boolean;
  maxTotalBytes?: number;
  maxEntryBytes?: number;
  maxEntries?: number;
  configurationError?: 'invalid_limits';
  now?: () => Date;
  createId?: () => string;
}
const warning =
  'Private trace files contain health information and model/tool payloads. They are not included in shareable metadata exports. Review before sharing; retain outside Git.';
const bounded = (value: number | undefined, fallback: number, maximum: number) =>
  Number.isSafeInteger(value) && value! > 0 && value! <= maximum ? value! : fallback;
const grantBytesLimit = 4 * 1024;
const grantLifetimeLimitMs = 24 * 60 * 60 * 1000;
const processUid = typeof process.getuid === 'function' ? process.getuid() : null;

function outsideGit(path: string): boolean {
  let ancestor = path;
  for (;;) {
    if (existsSync(join(ancestor, '.git'))) return false;
    const parent = dirname(ancestor);
    if (parent === ancestor) return true;
    ancestor = parent;
  }
}

function canonicalOwnerDirectory(path: string): boolean {
  if (!isAbsolute(path) || realpathSync(path) !== resolve(path)) return false;
  const info = statSync(path);
  return (
    processUid !== null &&
    info.isDirectory() &&
    info.uid === processUid &&
    (info.mode & 0o077) === 0 &&
    outsideGit(path)
  );
}

function validProfileId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !/[\r\n\x00-\x1f\x7f]/.test(value)
  );
}

type GrantResult = { authorized: true } | { authorized: false; reason: string };

function grantAuthorization(grantFile: string, profileId: string, now: Date): GrantResult {
  let descriptor: number | null = null;
  try {
    if (!isAbsolute(grantFile) || realpathSync(grantFile) !== resolve(grantFile))
      return { authorized: false, reason: 'unsafe_grant_file' };
    if (lstatSync(grantFile).isSymbolicLink() || !outsideGit(grantFile))
      return { authorized: false, reason: 'unsafe_grant_file' };
    descriptor = openSync(grantFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (
      processUid === null ||
      !info.isFile() ||
      info.uid !== processUid ||
      (info.mode & 0o777) !== 0o600 ||
      info.size <= 0 ||
      info.size > grantBytesLimit
    )
      return { authorized: false, reason: 'unsafe_grant_file' };
    const content = readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(content) > grantBytesLimit)
      return { authorized: false, reason: 'unsafe_grant_file' };
    let grant: unknown;
    try {
      grant = JSON.parse(content);
    } catch {
      return { authorized: false, reason: 'invalid_grant' };
    }
    if (
      !grant ||
      typeof grant !== 'object' ||
      Array.isArray(grant) ||
      Object.keys(grant).sort().join(',') !== 'expiresAt,profileId'
    )
      return { authorized: false, reason: 'invalid_grant' };
    const { profileId: grantedProfile, expiresAt } = grant as Record<string, unknown>;
    if (
      !validProfileId(grantedProfile) ||
      typeof expiresAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt)
    )
      return { authorized: false, reason: 'invalid_grant' };
    const expires = new Date(expiresAt);
    if (!Number.isFinite(expires.getTime()) || expires.toISOString() !== expiresAt)
      return { authorized: false, reason: 'invalid_grant' };
    const remaining = expires.getTime() - now.getTime();
    if (remaining <= 0) return { authorized: false, reason: 'grant_expired' };
    if (remaining > grantLifetimeLimitMs) return { authorized: false, reason: 'grant_too_distant' };
    return grantedProfile === profileId
      ? { authorized: true }
      : { authorized: false, reason: 'profile_not_authorized' };
  } catch {
    return { authorized: false, reason: 'grant_unavailable' };
  } finally {
    if (descriptor !== null)
      try {
        closeSync(descriptor);
      } catch {
        /* A grant close failure must still deny or preserve the completed read, never crash import. */
      }
  }
}

/** Explicit operator opt-in only. No headers, connection objects or credentials are accepted. */
export function createPrivateImportTrace({
  directory,
  grantFile,
  acknowledged = false,
  maxTotalBytes,
  maxEntryBytes,
  maxEntries,
  configurationError,
  now = () => new Date(),
  createId = randomUUID,
}: Options = {}): PrivateImportTrace {
  const totalLimit = bounded(maxTotalBytes, 512 * 1024 * 1024, 2 * 1024 * 1024 * 1024);
  const entryLimit = bounded(maxEntryBytes, 24 * 1024 * 1024, 32 * 1024 * 1024);
  const countLimit = bounded(maxEntries, 8192, 16384);
  let reason: string | null = 'not_enabled';
  let output: string | null = null;
  let totalBytes = 0,
    sequence = 0;
  const profiles = new Map<
    string,
    {
      recordedEvents: number;
      recordedBytes: number;
      omittedEvents: number;
      truncatedEvents: number;
      reason: string | null;
    }
  >();
  if (configurationError) reason = configurationError;
  else if (acknowledged && directory && grantFile) {
    try {
      if (!canonicalOwnerDirectory(directory)) throw new Error('directory');
      accessSync(directory, constants.W_OK);
      output = join(directory, `private-import-${randomUUID()}`);
      mkdirSync(output, { mode: 0o700 });
      reason = null;
    } catch {
      reason = 'unsafe_or_unwritable_directory';
      output = null;
    }
  } else if (acknowledged && directory) reason = 'grant_file_required';
  else if (acknowledged) reason = 'directory_required';
  const profileState = (profileId: string) => {
    let state = profiles.get(profileId);
    if (!state) {
      state = {
        recordedEvents: 0,
        recordedBytes: 0,
        omittedEvents: 0,
        truncatedEvents: 0,
        reason: null,
      };
      profiles.set(profileId, state);
    }
    return state;
  };
  const authorization = (profileId: string): GrantResult => {
    if (!output || !grantFile) return { authorized: false, reason: reason || 'not_enabled' };
    return grantAuthorization(grantFile, profileId, now());
  };
  const tracePathsRemainSafe = (): boolean => {
    try {
      return (
        !!directory &&
        !!output &&
        canonicalOwnerDirectory(directory) &&
        canonicalOwnerDirectory(output) &&
        outsideGit(directory) &&
        outsideGit(output)
      );
    } catch {
      return false;
    }
  };
  const stopTrace = (
    state: ReturnType<typeof profileState>,
    stopReason: 'unsafe_or_unwritable_directory' | 'write_failed',
  ): void => {
    state.omittedEvents++;
    state.reason = stopReason;
    reason = stopReason;
    output = null;
  };
  return {
    capture(profileId, event, context, payload, secrets = [], options = {}) {
      if (!output) return null;
      const grant = authorization(profileId);
      if (!grant.authorized) return null;
      const state = profileState(profileId);
      if (!tracePathsRemainSafe()) {
        stopTrace(state, 'unsafe_or_unwritable_directory');
        return null;
      }
      try {
        const traceEventId = createId();
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            traceEventId,
          )
        )
          throw new Error('trace event id');
        const content = JSON.stringify(
          {
            format: 'circus-private-import-trace-v1',
            at: new Date().toISOString(),
            traceEventId,
            event,
            context,
            truncated: options.truncated === true,
            payload,
          },
          (_key, value: unknown) =>
            typeof value === 'string'
              ? secrets
                  .filter(Boolean)
                  .reduce(
                    (text, secret) => text.replaceAll(secret, '[redacted connection credential]'),
                    value,
                  )
              : value,
        );
        const bytes = Buffer.byteLength(content);
        if (bytes > entryLimit || totalBytes + bytes > totalLimit || sequence >= countLimit) {
          state.omittedEvents++;
          state.reason = bytes > entryLimit ? 'entry_limit' : 'trace_limit';
          return null;
        }
        const compressed = gzipSync(content);
        if (!authorization(profileId).authorized) return null;
        if (!tracePathsRemainSafe()) {
          stopTrace(state, 'unsafe_or_unwritable_directory');
          return null;
        }
        const partition = createHash('sha256').update(profileId).digest('hex').slice(0, 20);
        const filename = `${partition}-${String(++sequence).padStart(6, '0')}-${event.replace('.', '-')}.json.gz`;
        writeFileSync(join(output, filename), compressed, { mode: 0o600, flag: 'wx' });
        totalBytes += bytes;
        state.recordedBytes += bytes;
        state.recordedEvents++;
        if (options.truncated) state.truncatedEvents++;
        return traceEventId;
      } catch {
        stopTrace(state, 'write_failed');
        return null;
      }
    },
    omit(profileId, _event, _context, omissionReason) {
      if (!output || !authorization(profileId).authorized) return;
      const state = profileState(profileId);
      if (!tracePathsRemainSafe()) {
        stopTrace(state, 'unsafe_or_unwritable_directory');
        return;
      }
      state.omittedEvents++;
      state.reason = omissionReason;
    },
    status(profileId) {
      const state = profiles.get(profileId);
      const grant = authorization(profileId);
      const tracePathsSafe = !!output && tracePathsRemainSafe();
      return {
        enabled: tracePathsSafe && grant.authorized,
        recordedEvents: state?.recordedEvents || 0,
        recordedBytes: state?.recordedBytes || 0,
        omittedEvents: state?.omittedEvents || 0,
        truncatedEvents: state?.truncatedEvents || 0,
        limits: {
          maxTotalBytes: totalLimit,
          maxEntryBytes: entryLimit,
          maxEntries: countLimit,
        },
        reason:
          !output || !tracePathsSafe
            ? reason || 'unsafe_or_unwritable_directory'
            : grant.authorized
              ? state?.reason || null
              : grant.reason,
        warning,
      };
    },
  };
}
