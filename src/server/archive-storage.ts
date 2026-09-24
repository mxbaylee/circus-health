import { lstatSync, readdirSync, statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpError } from './database.ts';
import { intakeLimits } from './intake-files.ts';

// Public accounting only reads filesystem metadata. Never follow links into
// external backups or reveal filenames/content-derived categories while locked.
interface Measurement {
  bytes: number;
  complete: boolean;
}

function measure(path: string): Measurement {
  let bytes = 0,
    complete = true;
  function visit(entry: string) {
    try {
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink()) {
        complete = false;
        return;
      }
      if (stat.isDirectory()) for (const name of readdirSync(entry)) visit(resolve(entry, name));
      else if (stat.isFile()) bytes += stat.size;
      else complete = false;
    } catch {
      complete = false;
    }
  }
  visit(path);
  return { bytes, complete };
}

export function archiveStorageTotals(
  dataDirectory: string,
  profileIds: Iterable<string>,
  runtimeDirectory: string,
) {
  const registered = new Set(profileIds),
    rows = {
      profiles: { label: 'Profile directories', bytes: 0 },
      other: { label: 'Backups and other archive files', bytes: 0 },
    };
  let complete = true;
  try {
    for (const name of readdirSync(dataDirectory)) {
      const path = resolve(dataDirectory, name);
      if (name === 'profiles' && !lstatSync(path).isSymbolicLink()) {
        for (const id of readdirSync(path)) {
          const result = measure(resolve(path, id));
          rows[registered.has(id) ? 'profiles' : 'other'].bytes += result.bytes;
          complete &&= result.complete;
        }
      } else {
        const result = measure(path);
        rows.other.bytes += result.bytes;
        complete &&= result.complete;
      }
    }
  } catch {
    complete = false;
  }
  const runtime = measure(runtimeDirectory);
  return {
    measuredAt: new Date().toISOString(),
    status: complete ? 'measured' : 'partial',
    storedBytes: rows.profiles.bytes + rows.other.bytes,
    profileBytes: rows.profiles.bytes,
    otherArchiveBytes: rows.other.bytes,
    runtimeBytes: runtime.bytes,
    runtimeStatus: runtime.complete ? 'measured' : 'partial',
    notes: [
      'Stored file bytes, including retained history and encrypted caches; filesystem allocation may differ.',
      'Backups and legacy files inside this archive are counted separately from active profile directories.',
      'External backups, downloads, container images and model weights are not measured. No external directories are scanned.',
      'Measurements may change while files are being written. Incomplete measurements are lower bounds.',
    ],
  };
}

export function runtimeCapacity(path: string): {
  reportedAvailableBytes: number | null;
  quotaStatus: 'unknown';
} {
  try {
    const info = statfsSync(path),
      available = info.bavail * info.bsize;
    return {
      reportedAvailableBytes: Number.isSafeInteger(available) && available >= 0 ? available : null,
      quotaStatus: 'unknown',
    };
  } catch {
    return { reportedAvailableBytes: null, quotaStatus: 'unknown' };
  }
}

export function importStorageEstimate(
  bytes: unknown,
  dataDirectory: string,
  runtimeDirectory: string,
) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(bytes)) || !Number.isSafeInteger(Number(bytes)))
    throw new HttpError(400, 'IMPORT_SIZE', 'Provide the total original size in whole bytes');
  const originalBytes = Number(bytes),
    limits = intakeLimits();
  // A planning allowance, not a hard bound: adoption normally reuses staging;
  // cross-filesystem copies, ZIP expansion and derivatives need extra space.
  const originalStorageEstimateBytes = Math.ceil(originalBytes * 1.01) + (originalBytes ? 4096 : 0);
  const runtimePlanningBytes =
    originalBytes * 2 + (originalBytes ? Math.max(limits.extractionBytes, 100 * 1024 * 1024) : 0);
  if (!Number.isSafeInteger(runtimePlanningBytes))
    throw new HttpError(400, 'IMPORT_SIZE', 'Original size is too large to estimate');
  return {
    originalBytes,
    originalStorageEstimateBytes,
    runtimePlanningBytes,
    archive: runtimeCapacity(dataDirectory),
    runtime: runtimeCapacity(runtimeDirectory),
    notes: [
      'Original storage assumes new bytes with an encryption allowance; verified identical-file reuse may reduce it.',
      'Temporary planning space includes two original copies and the larger of the extraction allowance or one 100 MiB ZIP expansion. Nested archives, page images, multiple deliveries, history and database growth can require more.',
      'Filesystem availability is reported separately for archive and runtime. Shared-volume readings are not additive and do not establish a cloud or mount quota.',
      'A 2 GB profile allowance is only an example starting point, not a limit or capacity guarantee.',
    ],
  };
}

/** Admission requires the planning allowance but never reserves it. Concurrent
 * work and unreported quotas can still fail; archive reuse is unknown before hashing. */
export function assertImportCapacity(estimate: ReturnType<typeof importStorageEstimate>): void {
  const limit = intakeLimits().uploadBytes;
  if (estimate.originalBytes > limit)
    throw new HttpError(
      413,
      'FILE_SIZE',
      `Original exceeds the configured ${limit / 1024 / 1024} MiB upload limit. Choose a smaller file, or ask the operator to raise the upload and runtime storage limits together.`,
    );
  const available = estimate.runtime.reportedAvailableBytes;
  if (available !== null && available < estimate.runtimePlanningBytes)
    throw new HttpError(
      507,
      'IMPORT_CAPACITY',
      `Not enough runtime space for this upload and its processing allowance: at least ${Math.ceil(estimate.runtimePlanningBytes / 1024 / 1024)} MiB is needed and ${Math.floor(available / 1024 / 1024)} MiB is available. No original was retained. Free space or ask the operator to increase the runtime capacity, then retry.`,
    );
}
