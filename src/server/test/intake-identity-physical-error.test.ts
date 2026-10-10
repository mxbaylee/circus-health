import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { profileOriginal } from '../profile-storage.ts';
import { intakeFileIdentity } from '../intake-files.ts';
import { nativeIdentityPreviewCounts } from '../intake-identity-preview-cache.ts';
import { getNativeIntakeIdentityReview } from '../intake-identity-native.ts';
import { fixture } from './intake-identity-native-fixture.ts';

test(
  'native identity reports a worker-observed same-byte replacement as changed source',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, true, 1, false, undefined, undefined, true);
    await f.review();
    await f.review();
    assert.equal(nativeIdentityPreviewCounts(f.db).entries, 1);
    const row = f.db.prepare("SELECT path FROM source_files WHERE kind='intake_proposal'").get();
    assert.ok(row);
    const path = profileOriginal(f.root, String(row.path), f.profileId),
      displaced = path + '.fictional-displaced',
      replacement = path + '.fictional-replacement',
      bytes = readFileSync(path),
      identity = intakeFileIdentity(path),
      originalPost = Worker.prototype.postMessage;
    let replaced = 0;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...args: unknown[]) {
      const page = message as {
        type?: string;
        items?: { kind: string; path: string }[];
      };
      if (
        !replaced &&
        page?.type === 'page' &&
        page.items?.some((item) => item.kind === 'identity' && item.path === path)
      ) {
        writeFileSync(replacement, bytes);
        renameSync(path, displaced);
        renameSync(replacement, path);
        replaced++;
        assert.notEqual(intakeFileIdentity(path), identity);
        assert.deepEqual(readFileSync(path), bytes);
      }
      return Reflect.apply(originalPost, this, [message, ...args]);
    } as typeof Worker.prototype.postMessage;
    try {
      const refused = await f.request(
        'identity-review?groupId=' + encodeURIComponent(f.groupId),
        undefined,
        409,
      );
      assert.equal(refused.error.code, 'SOURCE_CHANGED');
      assert.equal(replaced, 1);
      assert.equal(nativeIdentityPreviewCounts(f.db).entries, 0);
    } finally {
      Worker.prototype.postMessage = originalPost;
      if (replaced) renameSync(displaced, path);
      rmSync(replacement, { force: true });
    }
  },
);

test(
  'native identity does not classify a verifier protocol failure as changed source',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, true, 1, false, undefined, undefined, true);
    await f.review();
    await f.review();
    assert.equal(nativeIdentityPreviewCounts(f.db).entries, 1);
    const originalPost = Worker.prototype.postMessage;
    let corrupted = 0;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...args: unknown[]) {
      const page = message as { type?: string; id?: number; items?: unknown[] };
      if (!corrupted && page?.type === 'page' && Array.isArray(page.items)) {
        corrupted++;
        return Reflect.apply(originalPost, this, [{ ...page, id: page.id! + 1 }, ...args]);
      }
      return Reflect.apply(originalPost, this, [message, ...args]);
    } as typeof Worker.prototype.postMessage;
    try {
      const refused = await f.request(
        'identity-review?groupId=' + encodeURIComponent(f.groupId),
        undefined,
        500,
      );
      assert.equal(refused.error.code, 'INTERNAL_ERROR');
      assert.equal(corrupted, 1);
      assert.equal(nativeIdentityPreviewCounts(f.db).entries, 0);
    } finally {
      Worker.prototype.postMessage = originalPost;
    }
  },
);

test(
  'native identity preserves the caller abort reason at a physical worker page',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, true, 1, false, undefined, undefined, true);
    await f.review();
    await f.review();
    const controller = new AbortController(),
      reason = Error('Fictional caller cancelled identity review'),
      originalPost = Worker.prototype.postMessage;
    let aborted = 0;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...args: unknown[]) {
      const page = message as { type?: string; items?: unknown[] };
      if (!aborted && page?.type === 'page' && Array.isArray(page.items)) {
        controller.abort(reason);
        aborted++;
      }
      return Reflect.apply(originalPost, this, [message, ...args]);
    } as typeof Worker.prototype.postMessage;
    try {
      await assert.rejects(
        getNativeIntakeIdentityReview(f.db, f.root, f.profileId, f.original.id, f.groupId, {
          signal: controller.signal,
        }),
        (error) => error === reason,
      );
      assert.equal(aborted, 1);
      assert.equal(nativeIdentityPreviewCounts(f.db).entries, 1);
    } finally {
      Worker.prototype.postMessage = originalPost;
    }
  },
);
