import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Database } from '../../database.ts';
import { openIntakeCollectionEnvelope } from '../../intake-collection-envelope.ts';
import { reviewIntakeRead } from '../../intake.ts';
import type { IntakeReviewRecord } from '../../../shared/intake.ts';

export function selectedFixtureOptionalValue<T>(
  db: Database,
  id: string,
  path: readonly string[],
): T | undefined {
  assert.ok(path.length);
  const { view, record } = selected(db, id, path.slice(0, -1));
  return view.has(record, path.at(-1)!) ? selectedFixtureValue<T>(db, id, path) : undefined;
}

/** Complete tiny fictional review selected through the real public page API. */
export async function selectedFixtureReview(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  proposalId: string,
) {
  const page = await reviewIntakeRead(db, root, profileId, id, proposalId, {
    items: 12,
    bytes: 128 * 1024,
  });
  assert.ok('format' in page && page.format === 'health-intake-clinical-review-page-v2');
  assert.equal(page.nextCursor, null, 'the fictional review fits one actual bounded page');
  assert.equal(page.total, page.items.length);
  const records = page.items.map((item) => {
    assert.ok(item.kind === 'value', 'the fictional record is completely inline');
    const value = item.value;
    assert.ok(value && typeof value === 'object' && 'id' in value && 'mapping' in value);
    return value as IntakeReviewRecord;
  });
  return {
    version: page.version,
    reviewToken: page.reviewToken,
    proposalId: page.proposalId,
    sourceTextStale: page.sourceTextStale,
    records,
  };
}

/** A bounded selected fixture value, never a reconstructed Intake DTO. */
export function selectedFixtureValue<T>(db: Database, id: string, path: readonly string[]): T {
  assert.ok(path.length);
  const parent = selected(db, id, path.slice(0, -1));
  const field = path.at(-1)!;
  if (!parent.view.child(parent.record, field)) {
    const value = parent.view.field(parent.record, field, { bytes: 64 * 1024 });
    assert.equal(value.kind, 'value', 'the selected fictional scalar is present and bounded');
    assert.ok(value.kind === 'value');
    return value.value as T;
  }
  const { view, record } = selected(db, id, path);
  assert.ok(record, 'the selected fictional evidence exists: ' + path.join('.'));
  const chunks: string[] = [];
  let bytes = 0;
  for (const chunk of view.recordChunks(record)) {
    bytes += Buffer.byteLength(chunk);
    assert.ok(bytes <= 512 * 1024, 'the selected fictional value is bounded');
    chunks.push(chunk);
  }
  return JSON.parse(chunks.join('')) as T;
}

/** Exact complete history comparison without hydrating retained workflow arrays. */
export function selectedFixtureHash(db: Database, id: string, path: readonly string[]): string {
  const { view, record } = selected(db, id, path);
  assert.ok(record, 'the selected fictional evidence exists: ' + path.join('.'));
  const hash = createHash('sha256');
  for (const chunk of view.recordChunks(record)) hash.update(chunk);
  return hash.digest('hex');
}

function selected(db: Database, id: string, path: readonly string[]) {
  const view = openIntakeCollectionEnvelope(db, { id });
  let record = view.root();
  for (const field of path) {
    const child = view.child(record, field);
    assert.ok(child, 'the selected fictional scope exists: ' + path.join('.'));
    record = child;
  }
  return { view, record };
}
