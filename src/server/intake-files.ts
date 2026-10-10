import { finishClinicalReviewWork } from './clinical-review-work.ts';
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { regularFileIdentity } from './regular-file-identity.ts';
import { HttpError } from './database.ts';
import type { IntakeImageEncoding } from './intake-image.ts';
import { recordIntakeFileWork } from './intake-file-work.ts';
const MiB = 1024 * 1024;

// PDF parsing runs in one reusable, profile-scoped worker at a time. These are
// parser/output bounds rather than accepted-original byte limits: the retained
// file is verified once per isolated child session in fixed-size chunks and
// PDF.js requests only needed ranges through that same open file descriptor.
// Native image/font caches require process recycling in addition to a V8 cap.
export const INTAKE_PDF_BOUNDS = Object.freeze({
  rangeChunkBytes: 256 * 1024,
  maxRangeRequestBytes: 32 * MiB,
  verificationChunkBytes: 256 * 1024,
  maxPages: Number.MAX_SAFE_INTEGER,
  maxReferences: 5_000,
  maxIndexOutputBytes: 16 * MiB,
  maxTextCharactersPerRead: 24_000,
  maxIdentityTextCharacters: 250_000,
  maxTextCharactersPerPage: 4_000_000,
  maxRenderDimension: 1_800,
  reducedRenderDimension: 1_400,
  maxRenderPixels: 3_240_000,
  // PNG remains the PDF image fallback. Keep format and quality together so changing
  // this setting also changes the MIME type delivered with the encoded bytes.
  imageEncoding: Object.freeze({ mimeType: 'image/png' } satisfies IntakeImageEncoding),
  maxImageBytes: 10 * MiB,
  // Two base64 pages fit within the existing 16 MiB model-media envelope.
  maxNativePdfBytes: 5 * MiB,
  maxNativePdfDictionaryBytes: MiB,
  nativePdfTimeoutMs: 60_000,
  nativePdfAddressSpaceMiB: 384,
  maxSourceImagePixels: 32_000_000,
  maxAttachments: 300,
  maxAttachmentBytes: 25 * MiB,
  maxAttachmentBytesPerRead: 100 * MiB,
  maxPageOutputBytes: 112 * MiB,
  workerOldGenerationMiB: 384,
  maxRenderedPagesPerSession: 32,
  workerRecycleRssBytes: 320 * MiB,
  openTimeoutMs: 120_000,
  indexTimeoutMs: 180_000,
  searchTimeoutMs: 180_000,
  pageTimeoutMs: 90_000,
  idleTimeoutMs: 5 * 60_000,
});
function limit(env: NodeJS.ProcessEnv, key: string, fallback: number, maximum: number) {
  const value = env[key] == null || env[key] === '' ? fallback : Number(env[key]);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new HttpError(
      503,
      'INTAKE_CONFIG',
      `${key} must be an integer between 1 and ${maximum} MiB`,
    );
  return value * MiB;
}
export function intakeLimits(env = process.env) {
  return {
    uploadBytes: limit(env, 'CRS_INTAKE_UPLOAD_MIB', 128, 1024),
    extractionBytes: limit(env, 'CRS_INTAKE_EXTRACTION_MIB', 64, 256),
  };
}
// Hash and text inspection keep one bounded file chunk; originals are never rewritten.
export function inspectIntakeFile(...input: Parameters<typeof inspectIntakeFileWork>) {
  return finishClinicalReviewWork(inspectIntakeFileWork(...input));
}
export function* inspectIntakeFileWork(
  path: string,
  expected: { bytes?: number | null; sha256?: string | null } = {},
  window: { offset: number; limit: number } | null = null,
): Generator<
  void,
  { bytes: number; sha256: string; text: string | null; totalCharacters: number | null },
  void
> {
  const fd = openSync(path, 'r'),
    hash = createHash('sha256'),
    chunk = Buffer.allocUnsafe(256 * 1024);
  recordIntakeFileWork('inspectionBufferBytes', chunk.length);
  const decoder = window ? new TextDecoder('utf-8', { fatal: true }) : null;
  let size = 0,
    characters = 0,
    text = '',
    validText = true;
  function decoded(value: string) {
    const start = characters;
    characters += value.length;
    if (characters > window!.offset && start < window!.offset + window!.limit)
      text += value.slice(
        Math.max(0, window!.offset - start),
        window!.offset + window!.limit - start,
      );
  }
  try {
    if (!fstatSync(fd).isFile())
      throw new HttpError(409, 'SOURCE_CHANGED', 'Retained original is not a regular file');
    let n;
    while (true) {
      recordIntakeFileWork('streamReadAttempts');
      n = readSync(fd, chunk, 0, chunk.length, null);
      recordIntakeFileWork('streamReadCalls');
      recordIntakeFileWork('streamReadBytes', n);
      if (!n) break;
      const bytes = chunk.subarray(0, n);
      size += n;
      hash.update(bytes);
      recordIntakeFileWork('streamHashCalls');
      recordIntakeFileWork('streamHashBytes', n);
      yield;
      if (decoder && validText)
        try {
          decoded(decoder.decode(bytes, { stream: true }));
        } catch {
          validText = false;
        }
    }
    if (decoder && validText)
      try {
        decoded(decoder.decode());
      } catch {
        validText = false;
      }
  } finally {
    closeSync(fd);
  }
  const sha256 = hash.digest('hex');
  if (
    (expected.bytes != null && size !== expected.bytes) ||
    (expected.sha256 && sha256 !== expected.sha256)
  )
    throw new HttpError(409, 'SOURCE_CHANGED', 'The retained original no longer matches its hash');
  return {
    bytes: size,
    sha256,
    text: validText ? text : null,
    totalCharacters: validText ? characters : null,
  };
}
// Originals are never rewritten, so a file whose identity and timestamps are
// unchanged since it last hashed correctly is not read again. Any write changes
// ctime, and a replacement changes the inode, so either forces a full rehash.
const verified = new Map<string, string>();
const VERIFIED_LIMIT = 256;
export function intakeFileIdentity(path: string): string {
  const identity = regularFileIdentity(path);
  if (identity === undefined)
    throw new HttpError(409, 'SOURCE_CHANGED', 'Retained original is not a regular file');
  return identity;
}
export function verifyIntakeFileHash(path: string, expected: { bytes: number; sha256: string }) {
  finishClinicalReviewWork(verifyIntakeFileHashWork(path, expected));
}
export function* verifyIntakeFileHashWork(
  path: string,
  expected: { bytes: number; sha256: string },
): Generator<void, string, void> {
  const key = `${expected.sha256}:${expected.bytes}:${path}`;
  const identity = intakeFileIdentity(path);
  if (verified.get(key) === identity) {
    recordIntakeFileWork('verificationCacheHits');
    return identity;
  }
  verified.delete(key);
  yield* inspectIntakeFileWork(path, expected);
  if (intakeFileIdentity(path) !== identity)
    throw new HttpError(409, 'SOURCE_CHANGED', 'Retained original changed during verification');
  if (verified.size >= VERIFIED_LIMIT) verified.delete(verified.keys().next().value!);
  verified.set(key, identity);
  return identity;
}
export function assertExtractionSize(bytes: number) {
  const maximum = intakeLimits().extractionBytes;
  if (bytes > maximum)
    throw new HttpError(
      413,
      'EXTRACTION_LIMIT',
      `Original retained; this extraction requires loading the document and exceeds the configured ${maximum / MiB} MiB extraction limit. Text reads remain bounded; no extraction was completed.`,
    );
}
