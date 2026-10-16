import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { fixture, envelope } from './intake-identity-native-fixture.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { profileOriginal } from '../profile-storage.ts';
import { HttpError } from '../database.ts';
import { borrowCollectionClinicalReviewAsync } from '../intake-review-collection-host.ts';
import { preparedClinicalReviewRead } from '../intake-clinical-review-read-cache.ts';

// One fictional native record: unchanged interleaved read requests reuse one
// verified selected review instead of rebuilding it from the original each time.
async function oneRecord(t: test.TestContext) {
  const f = await fixture(
    t,
    true,
    1,
    true,
    (n) => envelope('retained-' + n, true),
    undefined,
    true,
  );
  const api = f.base.replace(/intakes\/[^/]+\/$/, 'intakes/');
  const get = async (url: string, status = 200) => {
    const response = await fetch(url);
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body).slice(0, 400));
    return body.data ?? body;
  };
  const feedUrl = api + 'import-feed?view=active&state=pending&limit=40&bytes=65536';
  const feed = await get(feedUrl);
  const row = feed.records[0];
  const pins = row.detail.kind === 'record' ? row.detail.record : row.detail.selection;
  const recordId = row.detail.kind === 'record' ? row.detail.record.id : pins.recordId;
  const urls = {
    feed: feedUrl,
    group:
      api +
      'report-queue/' +
      encodeURIComponent(f.groupId) +
      '?view=all&limit=40&bytes=65536&intakeId=' +
      encodeURIComponent(f.original.id),
    identity: f.base + 'identity-review?groupId=' + encodeURIComponent(f.groupId),
    record:
      f.base +
      'review-record?' +
      new URLSearchParams({
        recordId,
        proposalId: row.proposalId,
        candidateVersionId: pins.candidateVersionId,
      }),
  };
  const work = () => {
    const { warm, reconstruction } = intakeWorkCounters(f.db);
    return {
      preparations:
        warm.collectionClinicalReviewPreparations +
        reconstruction.collectionClinicalReviewPreparations,
      borrows:
        warm.collectionRetainedClinicalReviewBorrows +
        reconstruction.collectionRetainedClinicalReviewBorrows,
    };
  };
  const round = async () => {
    const counts: Record<string, { preparations: number; borrows: number }> = {};
    for (const [name, url] of Object.entries(urls)) {
      const before = work();
      await get(url);
      const after = work();
      counts[name] = {
        preparations: after.preparations - before.preparations,
        borrows: after.borrows - before.borrows,
      };
    }
    return counts;
  };
  return { ...f, proposalId: row.proposalId as string, urls, get, work, round };
}

test('unchanged interleaved review reads reuse one verified selected review', async (t) => {
  const f = await oneRecord(t);
  // First pass may publish derived identity snapshots and prepare once.
  await f.round();
  await f.round();
  assert.deepEqual(
    await f.round(),
    {
      // The feed queue keeps its own guarded private preparation (outside this slot).
      feed: { preparations: 1, borrows: 0 },
      group: { preparations: 0, borrows: 1 },
      // The unchanged identity preview is served from its own verified cache.
      identity: { preparations: 0, borrows: 0 },
      record: { preparations: 0, borrows: 1 },
    },
    'unchanged group and record reads re-prove one retained review instead of rebuilding it',
  );
});

test('retained selected review is rebuilt after its read stamp changes', async (t) => {
  const f = await oneRecord(t);
  await f.round();
  await f.round();
  const before = f.work();
  f.db.exec('CREATE TEMP TABLE fictional_retained_review_stamp(n INTEGER)');
  await f.get(f.urls.group);
  const changed = f.work();
  assert.equal(changed.preparations - before.preparations, 1, 'changed stamp prepares once');
  await f.get(f.urls.identity);
  await f.get(f.urls.record);
  await f.get(f.urls.group);
  assert.equal(f.work().preparations, changed.preparations, 'the rebuilt review is retained');
});

test('a same-byte original replacement is a reuse miss before admission', async (t) => {
  const f = await oneRecord(t);
  await f.round();
  await f.round();
  const path = originalPath(f);
  const bytes = readFileSync(path),
    before = statSync(path, { bigint: true });
  writeFileSync(path, bytes);
  assert.notEqual(statSync(path, { bigint: true }).ctimeNs, before.ctimeNs);
  const work = f.work();
  await f.get(f.urls.record);
  const after = f.work();
  assert.equal(after.borrows, work.borrows, 'a stale proof is never adopted as a new baseline');
  assert.equal(after.preparations - work.preparations, 1, 'the review is rebuilt from bytes');
});

test('a retained selected review refuses an original replaced during use', async (t) => {
  const f = await oneRecord(t);
  await f.round();
  await f.round();
  const path = originalPath(f);
  const bytes = readFileSync(path);
  const borrows = f.work().borrows;
  await assert.rejects(
    borrowCollectionClinicalReviewAsync(
      f.db,
      f.root,
      f.profileId,
      f.original.id,
      f.proposalId,
      {},
      () => writeFileSync(path, bytes),
    ),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  assert.equal(f.work().borrows, borrows, 'a refused proof counts no reuse');
  assert.equal(preparedClinicalReviewRead(f.db), undefined, 'the refused review is discarded');
});

function originalPath(f: Awaited<ReturnType<typeof oneRecord>>) {
  const file = f.db.prepare('SELECT path FROM source_files WHERE id=?').get(f.original.id) as {
    path: string;
  };
  return profileOriginal(f.root, file.path, f.profileId);
}
