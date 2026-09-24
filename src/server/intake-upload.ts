import type { IncomingHttpHeaders } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, openSync, writeSync, closeSync, fsyncSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './database.ts';
import { intakeLimits } from './intake-files.ts';
import {
  beginImportPhase,
  measureImportPhase,
  diagnosticReasonCode,
  importDiagnostics,
  type ImportDiagnosticSink,
} from './import-diagnostics.ts';

export interface UploadReceipt {
  path: string;
  bytes: number;
  sha256: string;
  prefix: Buffer;
}
export interface UploadRequest extends AsyncIterable<string | Uint8Array> {
  headers?: IncomingHttpHeaders;
  iterator?: (options: { destroyOnReturn: boolean }) => AsyncIterable<string | Uint8Array>;
  aborted?: boolean;
  complete?: boolean;
  destroyed?: boolean;
  resume?: () => unknown;
}

// Only a fully received and fsynced original reaches publish. Staging lives outside
// the profile so a concurrent durable snapshot cannot include partial uploads.
export async function receiveIntakeUpload<T>(
  req: UploadRequest,
  publish: (receipt: UploadReceipt) => T | Promise<T>,
  {
    maxBytes = intakeLimits().uploadBytes,
    tempRoot,
    diagnostics = importDiagnostics,
  }: { maxBytes?: number; tempRoot?: string; diagnostics?: ImportDiagnosticSink } = {},
) {
  if (!tempRoot)
    throw new HttpError(503, 'UPLOAD_STAGING', 'A private upload staging directory is required');
  const lengthHeader = req.headers?.['content-length'],
    expectedHash = req.headers?.['x-content-sha256'];
  if (lengthHeader != null && !/^(0|[1-9][0-9]*)$/.test(lengthHeader as string))
    throw new HttpError(400, 'UPLOAD_LENGTH', 'Invalid Content-Length');
  const length = lengthHeader == null ? null : Number(lengthHeader);
  if (length != null && (!Number.isSafeInteger(length) || length > maxBytes))
    throw new HttpError(
      413,
      'FILE_SIZE',
      `Original exceeds the configured ${maxBytes / 1024 / 1024} MiB upload limit`,
    );
  if (expectedHash != null && !/^[a-fA-F0-9]{64}$/.test(expectedHash as string))
    throw new HttpError(
      400,
      'UPLOAD_HASH',
      'X-Content-SHA256 must be a complete SHA-256 hex digest',
    );
  const uploadStarted = performance.now();
  diagnostics.record('import.phase.started', { phase: 'upload_receive' });
  let directory: string | undefined,
    fd: number | undefined,
    size = 0,
    prefix = Buffer.alloc(0);
  let hashMs = 0,
    stagingWriteMs = 0,
    streamWaitMs = 0,
    chunkCount = 0;
  const streamSpan = beginImportPhase('upload_stream', {}, {}, diagnostics);
  try {
    directory = mkdtempSync(join(tempRoot, 'health-intake-upload-'));
    const path = join(directory, 'original'),
      hash = createHash('sha256');
    fd = openSync(path, 'wx', 0o600);
    // Avoid destroying the HTTP connection when rejecting an oversized chunk:
    // the route must still be able to return its explicit error response.
    const chunks = req.iterator ? req.iterator({ destroyOnReturn: false }) : req;
    try {
      let waitingAt = performance.now();
      for await (const chunk of chunks) {
        streamWaitMs += Math.max(0, performance.now() - waitingAt);
        chunkCount++;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes)
          throw new HttpError(
            413,
            'FILE_SIZE',
            `Original exceeds the configured ${maxBytes / 1024 / 1024} MiB upload limit`,
          );
        if (prefix.length < 512)
          prefix = Buffer.concat([prefix, bytes.subarray(0, 512 - prefix.length)]);
        const hashingAt = performance.now();
        hash.update(bytes);
        hashMs += performance.now() - hashingAt;
        const writingAt = performance.now();
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
        stagingWriteMs += performance.now() - writingAt;
        waitingAt = performance.now();
      }
      streamWaitMs += Math.max(0, performance.now() - waitingAt);
    } catch (error) {
      if (
        error instanceof HttpError ||
        ['ENOSPC', 'EDQUOT', 'EIO', 'EROFS', 'EACCES'].includes(
          (error as NodeJS.ErrnoException).code!,
        )
      )
        throw error;
      throw new HttpError(
        400,
        'UPLOAD_INTERRUPTED',
        'Upload interrupted; no original was published. Retry the complete file.',
      );
    }
    if (req.aborted || req.complete === false || (length != null && length !== size))
      throw new HttpError(400, 'UPLOAD_LENGTH', 'Upload was incomplete; no original was published');
    if (!size) throw new HttpError(400, 'FILE_SIZE', 'Choose a nonempty original file');
    const sha256 = hash.digest('hex');
    if (expectedHash && (expectedHash as string).toLowerCase() !== sha256)
      throw new HttpError(
        400,
        'UPLOAD_HASH',
        'Uploaded bytes do not match X-Content-SHA256; no original was published',
      );
    streamSpan.finish({ receivedBytes: size, chunkCount, hashMs, stagingWriteMs, streamWaitMs });
    measureImportPhase('upload_staging_fsync', () => fsyncSync(fd!), {}, {}, diagnostics);
    closeSync(fd);
    fd = undefined;
    // `publish` is `publishIntake` in production: verified staging adoption
    // (copy fallback across filesystems), SHA-256 and the database insert.
    // Measured separately because `durationMs` covers
    // receive *and* publish, and pairing that total with `receivedBytes` would read as a
    // transfer rate that is badly wrong.
    const publishStarted = performance.now();
    const result = await measureImportPhase(
      'upload_publish',
      () => publish({ path, bytes: size, sha256, prefix }),
      { receivedBytes: size },
      {},
      diagnostics,
    );
    const publishMs = Math.round(performance.now() - publishStarted);
    diagnostics.record('import.phase.completed', {
      phase: 'upload_receive',
      durationMs: Math.round(performance.now() - uploadStarted),
      receivedBytes: size,
      publishMs,
    });
    return result;
  } catch (error) {
    let outgoing = error;
    if (['ENOSPC', 'EDQUOT'].includes((error as NodeJS.ErrnoException).code!))
      outgoing = new HttpError(
        507,
        'UPLOAD_STORAGE',
        'Insufficient storage to retain this original; upload was not acknowledged. Retry the complete file after storage is available.',
      );
    else if (['EIO', 'EROFS', 'EACCES'].includes((error as NodeJS.ErrnoException).code!))
      outgoing = new HttpError(
        503,
        'UPLOAD_STORAGE',
        'Original storage is unavailable; upload was not acknowledged. Retry the complete file after storage is available.',
      );
    streamSpan.fail(outgoing, {
      receivedBytes: size,
      chunkCount,
      hashMs,
      stagingWriteMs,
      streamWaitMs,
    });
    diagnostics.record('import.phase.failed', {
      phase: 'upload_receive',
      durationMs: Math.round(performance.now() - uploadStarted),
      reasonCode: diagnosticReasonCode(outgoing),
    });
    throw outgoing;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    if (!req.complete && !req.destroyed) req.resume?.();
  }
}
