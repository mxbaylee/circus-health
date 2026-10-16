/** Complete warning content shares immutable rows across version-specific scope bindings. */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  IntakeIdentityReview,
  IntakeIdentityScopeReference,
} from '../shared/intake-identity.ts';
import type {
  ReportSnapshotCatalog,
  ReportSnapshotMapReader,
} from './intake-report-snapshot-catalog.ts';
import { createIdentitySnapshotDelta } from './intake-identity-snapshot-delta.ts';
import { schemaOrdinal } from './intake-envelope-schema.ts';
import { identityUtf8Chunks } from './intake-identity-commitment.ts';
import { recordIntakeWork, withIntakeWork, type IntakeHostWork } from './intake-work-accounting.ts';
const recordWarningWork = (db: DatabaseSync, metric: keyof IntakeHostWork, amount = 1) =>
  withIntakeWork(db, 'warm', () => recordIntakeWork(metric, amount));
import { HttpError } from './database.ts';

type Reference = Extract<
  NonNullable<IntakeIdentityReview['warningsReference']>,
  { format: 'health-intake-identity-warnings-v2' }
>;
const CONTENT_FORMAT = 'health-intake-identity-warning-content-v1';
const BINDING_FORMAT = 'health-intake-identity-warning-binding-v1';
const sha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const identityWarningSnapshotId = (scopeToken: string, digest: string) =>
  'identity-warnings:' + scopeToken + ':' + digest;
const contentId = (digest: string) => 'identity-warning-content:' + digest;

function contentHeader(reader: ReportSnapshotMapReader, digest: string, expectedCount?: number) {
  const raw = reader.get('$count'),
    count = typeof raw === 'string' ? Number(raw) : NaN;
  if (
    reader.get('$format') !== CONTENT_FORMAT ||
    reader.get('$sha256') !== digest ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    raw !== String(count) ||
    (expectedCount !== undefined && count !== expectedCount)
  )
    throw Error('Invalid retained identity warning content');
  return count;
}

function* verifyContentWork(
  db: DatabaseSync,
  reader: ReportSnapshotMapReader,
  digest: string,
  count: number,
): Generator<void, void, void> {
  // Authenticate the complete namespace, including absent warning tails and
  // metadata keys, before a prior tree can become a publication base.
  const expectedHeaders = ['$count', '$format', '$sha256'];
  let after: string | undefined,
    seen = 0;
  for (;;) {
    reader.assertCurrent();
    const page = reader.range({ after, items: 16, bytes: 64 * 1024 });
    if (
      page.count !== count + 3 ||
      page.items.length > 16 ||
      page.bytes < 0 ||
      page.bytes > 64 * 1024 ||
      (page.complete && page.after !== null) ||
      (!page.complete && !page.items.length)
    )
      throw Error('Invalid retained identity warning namespace');
    for (const item of page.items) {
      const expected = seen < 3 ? expectedHeaders[seen] : 'warnings:' + schemaOrdinal(seen - 3);
      if (item.key !== expected) throw Error('Retained identity warning namespace changed');
      seen++;
      yield;
    }
    if (page.complete) break;
    if (!page.after || page.after === after || page.after !== page.items.at(-1)?.key)
      throw Error('Retained identity warning namespace did not advance');
    after = page.after;
  }
  if (seen !== count + 3) throw Error('Retained identity warning rows missing');
  reader.assertCurrent();
  const hash = createHash('sha256').update('[');
  recordWarningWork(db, 'identitySnapshotWarningHashBytes', 1);
  for (let ordinal = 0; ordinal < count; ordinal++) {
    yield;
    if (ordinal) {
      hash.update(',');
      recordWarningWork(db, 'identitySnapshotWarningHashBytes', 1);
    }
    for (const piece of identityUtf8Chunks(reader.chunks('warnings:' + schemaOrdinal(ordinal)))) {
      hash.update(piece);
      recordWarningWork(db, 'identitySnapshotWarningReadBytes', Buffer.byteLength(piece));
      recordWarningWork(db, 'identitySnapshotWarningHashBytes', Buffer.byteLength(piece));
      yield;
    }
  }
  hash.update(']');
  recordWarningWork(db, 'identitySnapshotWarningHashBytes', 1);
  if (hash.digest('hex') !== digest) throw Error('Retained identity warning content changed');
}

export function openIdentityWarningsSnapshot(
  catalog: ReportSnapshotCatalog,
  scope: IntakeIdentityScopeReference,
  snapshotId: string,
) {
  const prefix = 'identity-warnings:' + scope.scopeToken + ':',
    digest = snapshotId.slice(prefix.length);
  if (!snapshotId.startsWith(prefix) || !sha256(scope.scopeToken) || !sha256(digest))
    throw new HttpError(409, 'IDENTITY_SCOPE', 'The identity warning snapshot reference changed');
  const binding = catalog.open(snapshotId);
  if (
    !binding ||
    binding.get('$format') !== BINDING_FORMAT ||
    binding.get('$scopeToken') !== scope.scopeToken ||
    binding.get('$sha256') !== digest
  )
    throw Error('Missing or invalid retained identity warning binding');
  const reader = binding.reference('$warnings');
  if (!reader) throw Error('Missing retained identity warning content');
  const count = contentHeader(reader, digest);
  if (binding.get('$count') !== String(count))
    throw Error('Identity warning binding count changed');
  return { reader, count, digest };
}

export interface WarningContentInput {
  db: DatabaseSync;
  catalog: ReportSnapshotCatalog;
  digest: string;
  count: number;
  rows: Iterable<{ chunks(): Iterable<string> }>;
  /** Authenticated same-owner prior content; corruption refuses the update. */
  priorContent?: ReportSnapshotMapReader;
  run: <T>(work: Generator<void, T, void>) => Promise<T>;
}

/** Immutable content rows are forked by both main scopes and tiny warning bindings. */
export async function retainIdentityWarningContent(
  input: WarningContentInput,
): Promise<ReportSnapshotMapReader> {
  const { db, catalog, digest, count } = input;
  if (!sha256(digest) || !Number.isSafeInteger(count) || count < 0)
    throw Error('Invalid complete identity warning preparation');
  if (input.priorContent) {
    const priorDigest = input.priorContent.get('$sha256');
    if (!sha256(priorDigest)) throw Error('Invalid prior identity warning digest');
    const priorCount = contentHeader(input.priorContent, priorDigest);
    await input.run(verifyContentWork(db, input.priorContent, priorDigest, priorCount));
  }
  const prior = catalog.open(contentId(digest));
  if (prior) {
    contentHeader(prior, digest, count);
    await input.run(verifyContentWork(db, prior, digest, count));
    return prior;
  }
  const content = input.priorContent
      ? await catalog.forkReference(input.priorContent)
      : await catalog.fork(),
    delta = createIdentitySnapshotDelta({
      db,
      writer: content,
      onChanged: (key, bytes) => {
        if (key.startsWith('warnings:')) {
          recordWarningWork(db, 'identityWarningContentWrittenRows');
          recordWarningWork(db, 'identityWarningContentWrittenBytes', bytes);
        }
      },
    });
  try {
    await delta.put('$format', CONTENT_FORMAT);
    await delta.put('$sha256', digest);
    await delta.put('$count', String(count));
    const writtenHash = createHash('sha256').update('[');
    recordWarningWork(db, 'identityWarningContentWriteHashBytes', 1);
    let ordinal = 0;
    for (const row of input.rows) {
      if (ordinal) {
        writtenHash.update(',');
        recordWarningWork(db, 'identityWarningContentWriteHashBytes', 1);
      }
      const key = 'warnings:' + schemaOrdinal(ordinal++);
      let passes = 0;
      await delta.putText(key, () => {
        const desiredPass = passes++ === 0;
        return (function* () {
          for (const piece of identityUtf8Chunks(row.chunks())) {
            if (desiredPass) {
              writtenHash.update(piece);
              recordWarningWork(
                db,
                'identityWarningContentWriteHashBytes',
                Buffer.byteLength(piece),
              );
            }
            yield piece;
          }
        })();
      });
    }
    if (ordinal !== count) throw Error('Complete identity warning preparation changed');
    writtenHash.update(']');
    recordWarningWork(db, 'identityWarningContentWriteHashBytes', 1);
    if (writtenHash.digest('hex') !== digest)
      throw Error('Complete identity warning bytes changed during publication');
    await delta.finishCleanup();
    // Publish only after the producer seal and exact desired keyset have passed.
    await delta.certify(content);
    await catalog.publish(contentId(digest), content);
    const retained = catalog.open(contentId(digest));
    if (!retained) throw Error('Missing newly retained identity warning content');
    return retained;
  } finally {
    delta.close();
  }
}

export async function retainIdentityWarningsSnapshot(
  input: WarningContentInput & {
    scope: IntakeIdentityScopeReference;
  },
): Promise<Reference> {
  const { db, catalog, scope, digest, count } = input;
  if (!sha256(scope.scopeToken)) throw Error('Invalid identity warning scope binding');
  const snapshotId = identityWarningSnapshotId(scope.scopeToken, digest),
    existing = catalog.open(snapshotId);
  if (existing) {
    const selected = openIdentityWarningsSnapshot(catalog, scope, snapshotId);
    if (selected.count !== count || selected.digest !== digest)
      throw Error('Identity warning preparation count changed');
    await input.run(verifyContentWork(db, selected.reader, digest, count));
  } else {
    const reader = await retainIdentityWarningContent(input);
    const content = await catalog.forkReference(reader),
      binding = await catalog.fork();
    await binding.putMany([
      { key: '$format', value: BINDING_FORMAT },
      { key: '$scopeToken', value: scope.scopeToken },
      { key: '$sha256', value: digest },
      { key: '$count', value: String(count) },
    ]);
    await binding.attach('$warnings', content);
    await catalog.publish(snapshotId, binding);
    recordWarningWork(db, 'identityWarningBindingsWritten');
  }
  return {
    format: 'health-intake-identity-warnings-v2',
    scopeToken: scope.scopeToken,
    snapshotId,
    count,
    sha256: digest,
  };
}
