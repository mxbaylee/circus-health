import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnershipBlockerStore } from '../ownership-blocker-store.ts';
test('ownership blocker inspection binds complete counts and fragments without an aggregate value', () => {
  const store = createOwnershipBlockerStore('fictional');
  try {
    const bucket = store.sink.blockerBucket('fictional-record');
    for (let i = 0; i < 180; i++)
      bucket.push('Fictional identity requirement ' + i + ': ' + 'x'.repeat(1000));
    bucket.push('Fictional giant requirement ' + 'z'.repeat(90000));
    const value = bucket.presentation();
    assert.equal(Array.isArray(value), false);
    if (Array.isArray(value)) throw Error('Expected explicit reference');
    assert.equal(value.count, 181);
    const page = store.page(value.key, -1, 3, 4096);
    assert.equal(page.total, 181);
    assert.equal(page.items.length, 3);
    assert.ok(page.after);
    const giant = store.page(value.key, 179, 1, 4096);
    assert.equal(giant.items[0].type, 'contribution-fragment');
    const first = store.fragment(value.key, 180, 0, 1024);
    assert.equal(first.complete, false);
    assert.equal(Buffer.from(first.data, 'base64').length, 1024);
    assert.equal(first.nextOffset, 1024);
    store.setGuard(() => {
      throw Error('Fictional authority changed');
    });
    assert.throws(() => store.page(value.key), /authority changed/);
  } finally {
    store.close();
  }
});
