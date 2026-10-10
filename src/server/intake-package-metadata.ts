import { createHash } from 'node:crypto';
import { HttpError } from './database.ts';
import { recordIntakeFileHash } from './intake-file-work.ts';
import type {
  IntakeMetadataFragment,
  IntakeMetadataFragmentReference,
} from '../shared/intake-package-paging.ts';

export function packageMetadataReference(
  identity: Omit<IntakeMetadataFragmentReference, 'format' | 'metadataHash' | 'bytes'>,
  text: string,
): IntakeMetadataFragmentReference {
  const bytes = Buffer.byteLength(text);
  if (bytes > 3 * 1024 * 1024)
    throw new HttpError(
      413,
      'PACKAGE_METADATA',
      'Metadata exceeds the per-entry ZIP grammar envelope',
    );
  recordIntakeFileHash(text);
  return {
    format: 'health-intake-metadata-reference-v1',
    ...identity,
    metadataHash: createHash('sha256').update(text).digest('hex'),
    bytes,
  };
}
export function packageMetadataFragment(
  reference: IntakeMetadataFragmentReference,
  expected: IntakeMetadataFragmentReference,
  text: string,
  { offset = 0, limit = 32768 }: { offset?: number; limit?: number } = {},
): IntakeMetadataFragment {
  if (
    !reference ||
    Object.keys(reference).length !== Object.keys(expected).length ||
    Object.keys(expected).some(
      (key) => reference[key as keyof typeof reference] !== expected[key as keyof typeof expected],
    )
  )
    throw new HttpError(
      409,
      'PACKAGE_METADATA_CHANGED',
      'Metadata reference changed; reload its inventory page',
    );
  const bytes = Buffer.from(text);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > bytes.length ||
    !Number.isInteger(limit) ||
    limit < 4 ||
    limit > 32768 ||
    (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)
  )
    throw new HttpError(
      400,
      'PACKAGE_METADATA_WINDOW',
      'Use a bounded UTF-8 metadata continuation',
    );
  let end = Math.min(bytes.length, offset + limit);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return {
    format: 'health-intake-metadata-fragment-v1',
    reference: expected,
    text: bytes.subarray(offset, end).toString('utf8'),
    offset,
    nextOffset: end < bytes.length ? end : null,
    totalBytes: bytes.length,
    complete: end === bytes.length,
  };
}
