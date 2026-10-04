import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profilePaths } from '../profile-storage.ts';
import { writeChat, clearChatJournalCache } from '../assistant-journal.ts';
import {
  writeIntakeBatch,
  trackIntakeBatch,
  clearIntakeBatchJournalCache,
  listIntakeBatches,
} from '../intake-batch-journal.ts';
import type { IntakeBatch } from '../../shared/intake-batch.ts';
import {
  clearJournalActivityIndex,
  prepareJournalActivity,
  readChatActivityHeader,
  iterateIntakeBatchActivity,
  journalActivityBinding,
} from '../journal-activity-index.ts';
import { journalJsonWork } from '../journal-json-index.ts';

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), 'fictional-journal-activity-')),
    profileId = 'fictional-profile';
  fs.mkdirSync(profilePaths(root, profileId).root, { recursive: true });
  t.after(() => {
    clearChatJournalCache(root);
    clearIntakeBatchJournalCache(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const chat = {
    id: randomUUID(),
    status: 'running',
    context: { intakeId: 'fictional-source' },
    conversionCheckpoint: {
      format: 'health-intake-conversion-checkpoint-v2',
      profileId,
      intakeId: 'fictional-source',
      sourceHash: 'fictional-sha',
    },
    messages: [{ content: 'Fictional history '.repeat(16_000) }],
    operations: [] as { id: number; text: string }[],
  };
  const batch = trackIntakeBatch({
    id: randomUUID(),
    profileId,
    operationId: 'fictional-operation',
    status: 'running',
    reason: null,
    currentIndex: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: Array.from({ length: 100 }, (_, i) => ({
      intakeId: 'fictional-' + i,
      sourceHash: 'fictional-hash',
      filename: 'fictional.txt',
      mimeType: 'text/plain',
      status: 'queued',
      reason: null,
      chatId: null,
      proposalIds: [],
      reading: null,
      startedAt: null,
      endedAt: null,
    })),
  } as IntakeBatch);
  return {
    root,
    profileId,
    chat,
    batch,
    chatDirectory: join(profilePaths(root, profileId).root, 'chats', chat.id, 'events'),
    batchDirectory: join(profilePaths(root, profileId).root, 'intake-batches', batch.id, 'events'),
  };
}
test('cold complete disk replay, warm changed header and cache loss preserve exact activity without full DTOs', async (t) => {
  const f = fixture(t),
    work = journalJsonWork();
  writeChat(f.root, f.profileId, f.chat, 'initial');
  writeIntakeBatch(f.root, f.profileId, f.batch, 'initial');
  for (let i = 0; i < 40; i++) {
    f.chat.operations.push({ id: i, text: 'Fictional operation '.repeat(40) });
    writeChat(f.root, f.profileId, f.chat, 'history');
    f.batch.items[1]!.reason = 'fictional-' + i;
    writeIntakeBatch(f.root, f.profileId, f.batch, 'history');
  }
  await prepareJournalActivity(f.root, f.profileId, { work });
  assert.equal(work.events, 82);
  assert.equal(work.maxBufferBytes, 64 * 1024);
  const coldBytes = work.bytes,
    coldNodes = work.nodes,
    binding = journalActivityBinding(f.root, f.profileId);
  assert.equal(
    readChatActivityHeader(f.root, f.profileId, f.chat.id)?.conversionCheckpoint.sourceHash,
    'fictional-sha',
  );
  assert.equal([...iterateIntakeBatchActivity(f.root, f.profileId)].length, 100);
  assert.equal(work.bytes, coldBytes, 'ready getters replay no event bytes');
  f.chat.status = 'cancelled';
  writeChat(f.root, f.profileId, f.chat, 'cancel');
  f.batch.items[0]!.status = 'review_ready';
  f.batch.items[0]!.reason = 'stopped';
  f.batch.items[0]!.reading = { status: 'paused', reason: 'reading_exhausted' } as any;
  writeIntakeBatch(f.root, f.profileId, f.batch, 'pause');
  assert.equal(work.events, 84, 'one changed selected event per warm publication');
  assert.ok(work.bytes - coldBytes < 4096);
  assert.ok(work.nodes - coldNodes < 100);
  assert.equal(readChatActivityHeader(f.root, f.profileId, f.chat.id)?.status, 'cancelled');
  const before = [...iterateIntakeBatchActivity(f.root, f.profileId)];
  assert.deepEqual(before[0]?.reading, { status: 'paused', reason: 'reading_exhausted' });
  assert.equal(before[0]?.reason, 'stopped');
  assert.notEqual(journalActivityBinding(f.root, f.profileId), binding);
  clearJournalActivityIndex(f.root, f.profileId);
  assert.throws(() => readChatActivityHeader(f.root, f.profileId, f.chat.id), {
    code: 'JOURNAL_ACTIVITY_NOT_PREPARED',
  });
  await prepareJournalActivity(f.root, f.profileId);
  assert.deepEqual([...iterateIntakeBatchActivity(f.root, f.profileId)], before);
});
test('interruption exposes no partial state and replay validates off-header malformed changes', async (t) => {
  const f = fixture(t);
  writeChat(f.root, f.profileId, f.chat, 'initial');
  writeIntakeBatch(f.root, f.profileId, f.batch, 'initial');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareJournalActivity(f.root, f.profileId, { signal: controller.signal }));
  assert.throws(() => iterateIntakeBatchActivity(f.root, f.profileId).next(), {
    code: 'JOURNAL_ACTIVITY_NOT_PREPARED',
  });
  await prepareJournalActivity(f.root, f.profileId);
  const tip = JSON.parse(fs.readFileSync(join(f.chatDirectory, 'current'), 'utf8'));
  const selected = join(f.chatDirectory, tip.tail);
  const bytes = fs.readFileSync(selected);
  fs.writeFileSync(
    selected,
    Buffer.from(bytes.toString().replace('Fictional history', 'Corrupted history')),
  );
  clearJournalActivityIndex(f.root, f.profileId);
  await assert.rejects(prepareJournalActivity(f.root, f.profileId));
  assert.throws(() => readChatActivityHeader(f.root, f.profileId, f.chat.id), {
    code: 'JOURNAL_ACTIVITY_NOT_PREPARED',
  });
});
test('disk ordering preserves localeCompare, stable equal dates, and exact first-item order', async (t) => {
  const f = fixture(t);
  for (const date of ['Z', 'a', 'A', 'a', '2026-12', '2026-01']) {
    const batch = trackIntakeBatch({
      ...f.batch,
      id: randomUUID(),
      updatedAt: date,
      items: [{ ...f.batch.items[0]!, intakeId: date }],
    });
    writeIntakeBatch(f.root, f.profileId, batch, 'initial');
  }
  const expected = listIntakeBatches(f.root, f.profileId).map((b) => b.id);
  await prepareJournalActivity(f.root, f.profileId);
  assert.deepEqual(
    [...iterateIntakeBatchActivity(f.root, f.profileId)].map((b) => b.batchId),
    expected,
  );
});
test('new known chat cannot become false absence while projection is stale', async (t) => {
  const f = fixture(t);
  await prepareJournalActivity(f.root, f.profileId);
  assert.equal(readChatActivityHeader(f.root, f.profileId, f.chat.id), null);
  writeChat(f.root, f.profileId, f.chat, 'initial');
  assert.equal(readChatActivityHeader(f.root, f.profileId, f.chat.id)?.status, 'running');
});
test('supported legacy batch events adopt v3 without changing exact headers or retained bytes', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.batchDirectory, { recursive: true });
  const first = '000000000001-' + randomUUID() + '.json',
    second = '000000000002-' + randomUUID() + '.json';
  fs.writeFileSync(
    join(f.batchDirectory, first),
    JSON.stringify({
      format: 'health-intake-batch-v1',
      profileId: f.profileId,
      sequence: 1,
      reason: 'initial',
      savedAt: '2026-01-01T00:00:00.000Z',
      batch: f.batch,
    }),
  );
  fs.writeFileSync(
    join(f.batchDirectory, second),
    JSON.stringify({
      format: 'health-intake-batch-delta-v2',
      profileId: f.profileId,
      batchId: f.batch.id,
      sequence: 2,
      reason: 'legacy-change',
      savedAt: '2026-01-01T00:00:01.000Z',
      changes: [
        [['items', '0', 'status'], 'paused'],
        [['items', '1', 'reason'], 'stopped'],
        [['items', 'length'], 2],
      ],
      removed: [['items', '2']],
    }),
  );
  const retained = fs.readFileSync(join(f.batchDirectory, first));
  await prepareJournalActivity(f.root, f.profileId);
  const headers = [...iterateIntakeBatchActivity(f.root, f.profileId)];
  assert.equal(headers.length, 2);
  assert.equal(headers[0]!.status, 'paused');
  assert.equal(headers[1]!.reason, 'stopped');
  const batch = listIntakeBatches(f.root, f.profileId)[0]!;
  batch.status = 'stopped';
  writeIntakeBatch(f.root, f.profileId, batch, 'adopt');
  assert.equal([...iterateIntakeBatchActivity(f.root, f.profileId)][0]?.batchStatus, 'stopped');
  clearJournalActivityIndex(f.root, f.profileId);
  await prepareJournalActivity(f.root, f.profileId);
  assert.equal([...iterateIntakeBatchActivity(f.root, f.profileId)][1]?.reason, 'stopped');
  assert.deepEqual(fs.readFileSync(join(f.batchDirectory, first)), retained);
});
test('valid unselected candidates are checked without adoption; invalid candidates fail closed', async (t) => {
  const f = fixture(t);
  writeIntakeBatch(f.root, f.profileId, f.batch, 'initial');
  const head = JSON.parse(fs.readFileSync(join(f.batchDirectory, 'current'), 'utf8')),
    name = '000000000002-' + randomUUID() + '.json';
  const candidate = {
    format: 'health-intake-batch-delta-v3',
    profileId: f.profileId,
    batchId: f.batch.id,
    sequence: 2,
    previous: head.tail,
    reason: 'unselected',
    savedAt: '2026-01-01T00:00:01.000Z',
    changes: [{ op: 'set', path: ['status'], value: 'stopped' }],
  };
  fs.writeFileSync(join(f.batchDirectory, name), JSON.stringify(candidate));
  await prepareJournalActivity(f.root, f.profileId);
  assert.equal([...iterateIntakeBatchActivity(f.root, f.profileId)][0]?.batchStatus, 'running');
  clearJournalActivityIndex(f.root, f.profileId);
  candidate.changes[0]!.path = ['missing', 'invalid'];
  fs.writeFileSync(join(f.batchDirectory, name), JSON.stringify(candidate));
  await assert.rejects(prepareJournalActivity(f.root, f.profileId));
  assert.throws(() => journalActivityBinding(f.root, f.profileId), {
    code: 'JOURNAL_ACTIVITY_NOT_PREPARED',
  });
});
test('complete replay refuses off-header invalid paths even with recomputed selected digests', async (t) => {
  const f = fixture(t);
  writeChat(f.root, f.profileId, f.chat, 'initial');
  const originalHead = JSON.parse(fs.readFileSync(join(f.chatDirectory, 'current'), 'utf8'));
  const malformed = {
    format: 'health-chat-delta-v2',
    profileId: f.profileId,
    chatId: f.chat.id,
    sequence: 2,
    previous: originalHead.tail,
    reason: 'invalid history edit',
    savedAt: '2026-01-01T00:00:01.000Z',
    changes: [{ op: 'set', path: ['messages', '0', 'missing', 'field'], value: 'invalid' }],
  };
  const bytes = Buffer.from(JSON.stringify(malformed)),
    name = '000000000002-' + createHash('sha256').update(bytes).digest('hex') + '.json';
  fs.writeFileSync(join(f.chatDirectory, name), bytes);
  fs.writeFileSync(
    join(f.chatDirectory, 'current'),
    JSON.stringify({
      ...originalHead,
      tail: name,
      usage: { ...originalHead.usage, eventBytes: originalHead.usage.eventBytes + bytes.length },
    }),
  );
  await assert.rejects(prepareJournalActivity(f.root, f.profileId));
  assert.throws(() => readChatActivityHeader(f.root, f.profileId, f.chat.id), {
    code: 'JOURNAL_ACTIVITY_NOT_PREPARED',
  });
});

for (const phase of ['parse', 'apply'] as const)
  test(`one initial journal event yields and cancels during ${phase} before exposing activity`, async (t) => {
    const f = fixture(t),
      work = journalJsonWork(),
      controller = new AbortController();
    if (phase === 'apply')
      f.chat.messages = Array.from({ length: 1500 }, (_, i) => ({
        content: 'Fictional retained message ' + i,
      }));
    writeChat(f.root, f.profileId, f.chat, 'initial');
    const before = JSON.parse(fs.readFileSync(join(f.chatDirectory, 'current'), 'utf8'));
    const selected = join(f.chatDirectory, before.tail),
      bytes = fs.statSync(selected).size;
    let active = true,
      observed = false;
    const heartbeat = () => {
      if (!active) return;
      if (
        phase === 'parse'
          ? work.parsedCodeUnits > 0 && work.events === 0
          : work.validatedNodes >= 128
      ) {
        observed = true;
        controller.abort(new Error('Fictional scheduled cancellation'));
      } else setImmediate(heartbeat);
    };
    setImmediate(heartbeat);
    try {
      await assert.rejects(
        prepareJournalActivity(f.root, f.profileId, { signal: controller.signal, work }),
        /Fictional scheduled cancellation/,
      );
    } finally {
      active = false;
    }
    assert.equal(observed, true);
    assert.ok(work.yields > 0);
    if (phase === 'parse') {
      assert.equal(work.events, 0);
      assert.ok(work.bytes < bytes);
    } else {
      assert.equal(work.events, 1);
      assert.equal(work.appliedChanges, 1);
      assert.ok(work.validatedNodes < work.nodes);
    }
    assert.throws(() => readChatActivityHeader(f.root, f.profileId, f.chat.id), {
      code: 'JOURNAL_ACTIVITY_NOT_PREPARED',
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(join(f.chatDirectory, 'current'), 'utf8')), before);
    await prepareJournalActivity(f.root, f.profileId);
    assert.equal(readChatActivityHeader(f.root, f.profileId, f.chat.id)?.status, f.chat.status);
  });

test('yielded event parsing refuses a replaced retained path even when the open descriptor still contains selected bytes', async (t) => {
  const f = fixture(t),
    work = journalJsonWork();
  writeChat(f.root, f.profileId, f.chat, 'initial');
  const head = JSON.parse(fs.readFileSync(join(f.chatDirectory, 'current'), 'utf8')),
    selected = join(f.chatDirectory, head.tail),
    original = fs.readFileSync(selected);
  let active = true,
    replaced = false;
  const replace = () => {
    if (!active) return;
    if (work.parsedCodeUnits > 0) {
      fs.renameSync(selected, selected + '.retired');
      fs.writeFileSync(selected, original);
      replaced = true;
    } else setImmediate(replace);
  };
  setImmediate(replace);
  try {
    await assert.rejects(
      prepareJournalActivity(f.root, f.profileId, { work }),
      /Invalid journal JSON index input/,
    );
  } finally {
    active = false;
  }
  assert.equal(replaced, true);
  assert.throws(() => readChatActivityHeader(f.root, f.profileId, f.chat.id), {
    code: 'JOURNAL_ACTIVITY_NOT_PREPARED',
  });
});
