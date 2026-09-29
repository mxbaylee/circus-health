import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProposalSourceTextHandoff } from '../../shared/intake-source-text.ts';
import { proposalSourceTextHandoff } from '../proposal-source-text-handoff.ts';

test('a source revision advance withdraws the old proposal pin until current passages are read', () => {
  const ready = proposalSourceTextHandoff('fictional-revision-one', 'fictional-revision-one');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.readRequired, false);
  assert.equal(ready.sourceTextRevisionId, ready.currentRevisionId);
  const advanced = proposalSourceTextHandoff('fictional-revision-two', ready.sourceTextRevisionId);
  assert.equal(advanced.status, 'read_required');
  assert.equal(advanced.readRequired, true);
  assert.equal(advanced.currentRevisionId, 'fictional-revision-two');
  assert.equal(advanced.sourceTextRevisionId, null);
  assert.match(advanced.instruction, /read the relevant current durable passages/);
  const reread = proposalSourceTextHandoff(advanced.currentRevisionId, 'fictional-revision-two');
  assert.equal(reread.status, 'ready');
  assert.equal(reread.sourceTextRevisionId, 'fictional-revision-two');
});

test('unavailable text never advertises a stale pin, and unread text never advertises readiness', () => {
  for (const lastRead of [undefined, null, 'fictional-old-revision']) {
    const unavailable = proposalSourceTextHandoff(null, lastRead);
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(unavailable.currentRevisionId, null);
    assert.equal(unavailable.sourceTextRevisionId, null);
    assert.equal(unavailable.readRequired, false);
    assert.match(unavailable.instruction, /No durable text revision is available/);
  }
  for (const lastRead of [undefined, null]) {
    const unread = proposalSourceTextHandoff('fictional-current-revision', lastRead);
    assert.equal(unread.status, 'read_required');
    assert.equal(unread.sourceTextRevisionId, null);
    assert.equal(unread.readRequired, true);
  }
});

// Compile-time regression: consumers narrow the dependency state before using
// the pin; contradictory field combinations are not valid host handoffs.
function acceptsContract(_value: ProposalSourceTextHandoff): void {}
// @ts-expect-error An unread revision cannot advertise a usable proposal pin.
acceptsContract({
  status: 'read_required',
  currentRevisionId: 'fictional-current',
  sourceTextRevisionId: 'fictional-current',
  readRequired: true,
  instruction: '',
});
// @ts-expect-error A ready handoff cannot require another read.
acceptsContract({
  status: 'ready',
  currentRevisionId: 'fictional-current',
  sourceTextRevisionId: 'fictional-current',
  readRequired: true,
  instruction: '',
});
// @ts-expect-error An unavailable handoff cannot advertise a current revision.
acceptsContract({
  status: 'unavailable',
  currentRevisionId: 'fictional-current',
  sourceTextRevisionId: null,
  readRequired: false,
  instruction: '',
});
