import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import {
  readChat,
  listChats,
  countChats,
  writeChat,
  copyAssistantJournals,
  clearChatJournalCache,
  forgetChatJournal,
} from '../assistant-journal.ts';
import { profilePaths } from '../profile-storage.ts';
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), 'fictional-incremental-chat-'));
  const profileId = 'fictional-profile';
  fs.mkdirSync(profilePaths(root, profileId).root, { recursive: true });
  const chat = {
    id: randomUUID(),
    title: 'Fictional conversation',
    messages: [{ content: 'Independently fictional text. '.repeat(1000) }],
    operations: [] as { id: number; status: string; text: string }[],
    intakeModelAttempts: [] as { id: number; status: string; requestBytes: number }[],
  };
  const directory = join(profilePaths(root, profileId).root, 'chats', chat.id, 'events');
  t.after(() => {
    clearChatJournalCache(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, chat, directory };
}
function names(directory: string) {
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort();
}
function snapshot(directory: string) {
  return fs
    .readdirSync(directory)
    .reduce((n, name) => n + fs.statSync(join(directory, name)).size, 0);
}
function mockFs(t: test.TestContext) {
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test('hundreds of appended operations and physical attempts write proportional bytes with bounded warm reads', (t) => {
  const f = fixture(t);
  writeChat(f.root, f.profileId, f.chat, 'initial');
  const read = fs.readSync,
    write = fs.writeFileSync,
    open = fs.opendirSync;
  let reads = 0,
    writes = 0,
    inventories = 0;
  mockFs(t);
  t.mock.method(fs, 'readSync', (...args: Parameters<typeof read>) => {
    const n = (read as (...a: Parameters<typeof read>) => number)(...args);
    reads += n;
    return n;
  });
  t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof write>) => {
    const data = args[1];
    writes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    return write(...args);
  });
  t.mock.method(fs, 'opendirSync', (...args: Parameters<typeof open>) => {
    inventories++;
    return open(...args);
  });
  syncBuiltinESMExports();
  const growth: number[] = [];
  for (let i = 0; i < 400; i++) {
    f.chat.operations.push({
      id: i,
      status: 'started',
      text: 'Fictional operation ' + 'x'.repeat(100),
    });
    f.chat.intakeModelAttempts.push({ id: i, status: 'unknown', requestBytes: 2000 + i });
    writeChat(f.root, f.profileId, f.chat, 'attempt');
    if ([100, 200, 400].includes(i + 1)) growth.push(writes);
  }
  assert.equal(inventories, 0, 'warm writes do not scan the growing directory');
  assert.ok(reads < 1_000_000, String(reads));
  assert.ok(growth[1]! < growth[0]! * 2.1);
  assert.ok(growth[2]! < growth[1]! * 2.1);
  assert.equal(names(f.directory).length, 401);
  assert.ok(snapshot(f.directory) < 500_000);
  const before = writes;
  f.chat.operations[0]!.status = 'completed';
  f.chat.messages[0]!.content += 'Additional fictional words';
  writeChat(f.root, f.profileId, f.chat, 'small-edit');
  assert.ok(
    writes - before < 1500,
    'one item/text edit does not copy historical items or prior text',
  );
  const latest = JSON.parse(fs.readFileSync(join(f.directory, names(f.directory).at(-1)!), 'utf8'));
  assert.ok(
    latest.changes.some(
      (change: { op: string; text?: string }) =>
        change.op === 'splice' && change.text === 'Additional fictional words',
    ),
  );
  assert.deepEqual(readChat(f.root, f.profileId, f.chat.id), f.chat);
  const warm = reads;
  forgetChatJournal(f.chat);
  writeChat(f.root, f.profileId, f.chat, 'cold-noop');
  assert.ok(reads - warm > 100_000, 'cold writer reconstructs, then later writes stay warm');
  assert.deepEqual(readChat(f.root, f.profileId, f.chat.id), f.chat);
});

test('no-op, object deletion and array truncation retain reasons and exact reconstruction', (t) => {
  const f = fixture(t);
  f.chat.operations.push({ id: 0, status: 'started', text: 'Fictional' });
  writeChat(f.root, f.profileId, f.chat, 'initial');
  writeChat(f.root, f.profileId, f.chat, 'no-op');
  const unchanged = JSON.parse(fs.readFileSync(join(f.directory, names(f.directory)[1]!), 'utf8'));
  assert.deepEqual(unchanged.changes, []);
  assert.equal(unchanged.reason, 'no-op');
  delete (f.chat as Partial<typeof f.chat>).title;
  f.chat.operations.length = 0;
  writeChat(f.root, f.profileId, f.chat, 'remove');
  assert.deepEqual(readChat(f.root, f.profileId, f.chat.id), f.chat);
});

test('diagnostic budgets aggregate pointer and all generations without cache bypass', (t) => {
  const f = fixture(t);
  writeChat(f.root, f.profileId, f.chat, 'initial');
  f.chat.title = 'Changed fictional title';
  writeChat(f.root, f.profileId, f.chat, 'changed');
  const total = snapshot(f.directory);
  let readBytes = 0;
  assert.throws(
    () =>
      readChat(f.root, f.profileId, f.chat.id, {
        maxBytes: total - 1,
        onReadBytes: (n) => {
          readBytes += n;
        },
      }),
    { code: 'CHAT_READ_LIMIT' },
  );
  assert.ok(readBytes > 0 && readBytes < total);
  readBytes = 0;
  assert.deepEqual(
    readChat(f.root, f.profileId, f.chat.id, {
      maxBytes: total,
      onReadBytes: (n) => {
        readBytes += n;
      },
    }),
    f.chat,
  );
  assert.equal(readBytes, total);
  fs.writeFileSync(join(f.directory, 'unfinished.pending'), 'fictional');
  assert.throws(
    () => readChat(f.root, f.profileId, f.chat.id, { maxBytes: total, maxEntries: 3 }),
    { code: 'CHAT_READ_LIMIT' },
  );
  assert.throws(() => readChat(f.root, f.profileId, f.chat.id, { maxBytes: 0 }), RangeError);
});

test('malformed, missing, wrong-profile, linked and unsupported history fail explicitly', (t) => {
  for (const problem of ['corrupt', 'missing', 'profile', 'symlink', 'hardlink', 'old-format']) {
    const f = fixture(t);
    writeChat(f.root, f.profileId, f.chat, 'initial');
    f.chat.title += ' changed';
    writeChat(f.root, f.profileId, f.chat, 'second');
    const tail = join(f.directory, names(f.directory).at(-1)!);
    if (problem === 'corrupt') fs.writeFileSync(tail, 'fictional corrupt bytes');
    if (problem === 'missing') fs.unlinkSync(join(f.directory, names(f.directory)[0]!));
    if (problem === 'profile') {
      const head = JSON.parse(fs.readFileSync(join(f.directory, 'current'), 'utf8'));
      head.profileId = 'another-fictional-profile';
      fs.writeFileSync(join(f.directory, 'current'), JSON.stringify(head));
    }
    if (problem === 'symlink') {
      fs.unlinkSync(tail);
      fs.symlinkSync(join(f.directory, 'current'), tail);
    }
    if (problem === 'hardlink') fs.linkSync(tail, join(f.root, 'fictional-linked-file'));
    if (problem === 'old-format')
      fs.writeFileSync(
        join(f.directory, '000000000003-' + randomUUID() + '.json'),
        JSON.stringify({ format: 'health-chat-v1' }),
      );
    assert.throws(() => readChat(f.root, f.profileId, f.chat.id), /conversation journal/, problem);
    if (problem === 'corrupt')
      assert.throws(
        () => writeChat(f.root, f.profileId, f.chat, 'retry'),
        /conversation journal/,
        'warm writer checks tail hash',
      );
  }
});

function orphan(f: ReturnType<typeof fixture>, initial: boolean) {
  const head = initial ? null : JSON.parse(fs.readFileSync(join(f.directory, 'current'), 'utf8'));
  if (initial) fs.mkdirSync(f.directory, { recursive: true });
  const sequence = head ? Number(head.tail.slice(0, 12)) + 1 : 1;
  const value = {
    format: 'health-chat-delta-v2',
    profileId: f.profileId,
    chatId: f.chat.id,
    sequence,
    previous: head?.tail ?? null,
    reason: 'unpublished fictional event',
    savedAt: new Date().toISOString(),
    changes: initial
      ? [{ op: 'set', path: [], value: { ...f.chat, title: 'Unpublished first title' } }]
      : [
          {
            op: 'splice',
            path: ['title'],
            offset: 0,
            remove: f.chat.title.length,
            text: 'Unpublished later title',
          },
        ],
  };
  const bytes = Buffer.from(JSON.stringify(value));
  const name =
    String(sequence).padStart(12, '0') +
    '-' +
    createHash('sha256').update(bytes).digest('hex') +
    '.json';
  fs.writeFileSync(join(f.directory, name), bytes, { mode: 0o600 });
  return name;
}
test('missing initial commit marker is ambiguous and never creates a replacement history', (t) => {
  const f = fixture(t);
  const unpublished = orphan(f, true);
  assert.throws(() => readChat(f.root, f.profileId, f.chat.id), /Invalid conversation journal/);
  assert.throws(() => listChats(f.root, f.profileId), /Invalid conversation journal/);
  assert.throws(
    () => copyAssistantJournals(f.root, f.profileId, join(f.root, 'backup')),
    /Invalid conversation journal/,
  );
  assert.throws(
    () => writeChat(f.root, f.profileId, f.chat, 'retry'),
    /Invalid conversation journal/,
  );
  assert.ok(fs.existsSync(join(f.directory, unpublished)));
});
test('missing current marker after committed history fails reads, lists and backups', (t) => {
  const f = fixture(t);
  writeChat(f.root, f.profileId, f.chat, 'initial');
  f.chat.title = 'Second';
  writeChat(f.root, f.profileId, f.chat, 'second');
  fs.unlinkSync(join(f.directory, 'current'));
  assert.throws(() => readChat(f.root, f.profileId, f.chat.id), /Invalid conversation journal/);
  assert.throws(() => listChats(f.root, f.profileId), /Invalid conversation journal/);
  assert.throws(
    () => copyAssistantJournals(f.root, f.profileId, join(f.root, 'backup')),
    /Invalid conversation journal/,
  );
  assert.throws(
    () => writeChat(f.root, f.profileId, f.chat, 'retry'),
    /Invalid conversation journal/,
  );
});
test('unpublished next generation is not adopted and a cold retry quarantines it outside the scanned history', (t) => {
  const f = fixture(t);
  writeChat(f.root, f.profileId, f.chat, 'initial');
  const unpublished = orphan(f, false);
  forgetChatJournal(f.chat);
  assert.deepEqual(readChat(f.root, f.profileId, f.chat.id), f.chat);
  f.chat.title = 'Explicit fictional retry';
  writeChat(f.root, f.profileId, f.chat, 'retry');
  assert.deepEqual(readChat(f.root, f.profileId, f.chat.id), f.chat);
  assert.equal(fs.existsSync(join(f.directory, unpublished)), false);
  assert.ok(
    fs
      .readdirSync(join(f.directory, '..', 'unpublished'))
      .some((name) => name.startsWith(unpublished) && name.endsWith('.pending')),
  );
});

test('publication failures invalidate basis and preserve the committed pointer', (t) => {
  for (const failure of [
    'event-write',
    'event-fsync',
    'link',
    'head-rename',
    'before-head-fsync',
    'after-head-fsync',
  ]) {
    const f = fixture(t);
    writeChat(f.root, f.profileId, f.chat, 'initial');
    f.chat.title = 'New fictional state';
    const expected = { ...f.chat };
    let failed = false,
      dirs = 0;
    const link = fs.linkSync,
      rename = fs.renameSync,
      sync = fs.fsyncSync,
      write = fs.writeFileSync;
    mockFs(t);
    if (failure === 'event-write')
      t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof write>) => {
        if (!failed) {
          failed = true;
          throw Error('fictional content failure');
        }
        return write(...args);
      });
    if (failure === 'event-fsync')
      t.mock.method(fs, 'fsyncSync', (fd: number) => {
        if (!failed && fs.fstatSync(fd).isFile()) {
          failed = true;
          throw Error('fictional content fsync failure');
        }
        return sync(fd);
      });
    if (failure === 'link')
      t.mock.method(fs, 'linkSync', (...args: Parameters<typeof link>) => {
        if (!failed) {
          failed = true;
          throw Error('fictional publication failure');
        }
        return link(...args);
      });
    if (failure === 'head-rename')
      t.mock.method(fs, 'renameSync', (...args: Parameters<typeof rename>) => {
        if (!failed && basename(String(args[1])) === 'current') {
          failed = true;
          throw Error('fictional head failure');
        }
        return rename(...args);
      });
    if (['before-head-fsync', 'after-head-fsync'].includes(failure))
      t.mock.method(fs, 'fsyncSync', (fd: number) => {
        if (
          fs.fstatSync(fd).isDirectory() &&
          ++dirs === (failure === 'before-head-fsync' ? 1 : 2) &&
          !failed
        ) {
          failed = true;
          throw Error('fictional directory failure');
        }
        return sync(fd);
      });
    syncBuiltinESMExports();
    assert.throws(() => writeChat(f.root, f.profileId, f.chat, 'failure'), /fictional/);
    assert.equal(failed, true);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    const saved = readChat(f.root, f.profileId, f.chat.id) as typeof f.chat;
    assert.equal(
      saved.title,
      failure === 'after-head-fsync' ? expected.title : 'Fictional conversation',
    );
    writeChat(f.root, f.profileId, f.chat, 'retry');
    assert.deepEqual(readChat(f.root, f.profileId, f.chat.id), expected);
    assert.equal(
      fs.readdirSync(f.directory).some((name) => name.endsWith('.pending')),
      false,
    );
  }
});

test('backup snapshots one coherent tip even when the source appends while files copy', (t) => {
  const f = fixture(t);
  writeChat(f.root, f.profileId, f.chat, 'initial');
  const target = join(f.root, 'owned-backup'),
    write = fs.writeFileSync;
  let appended = false;
  mockFs(t);
  t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof write>) => {
    if (!appended && typeof args[0] === 'string' && args[0].startsWith(fs.realpathSync(target))) {
      appended = true;
      f.chat.title = 'After backup tip';
      writeChat(f.root, f.profileId, f.chat, 'later');
    }
    return write(...args);
  });
  syncBuiltinESMExports();
  const copied = copyAssistantJournals(f.root, f.profileId, target);
  assert.equal(appended, true);
  assert.equal(copied.length, 2);
  assert.equal(
    (readChat(target, f.profileId, f.chat.id) as typeof f.chat).title,
    'Fictional conversation',
  );
  assert.equal(
    (readChat(f.root, f.profileId, f.chat.id) as typeof f.chat).title,
    'After backup tip',
  );
});

test('cumulative decode work refuses a warm append before it becomes unrecoverable', (t) => {
  const f = fixture(t);
  f.chat.messages[0]!.content = 'x'.repeat(1_000_000);
  writeChat(f.root, f.profileId, f.chat, 'initial');
  let accepted = 0,
    refused = false;
  for (let i = 0; i < 110; i++) {
    f.chat.messages[0]!.content += 'x';
    try {
      writeChat(f.root, f.profileId, f.chat, 'append');
      accepted++;
    } catch (error) {
      assert.equal((error as { code: string }).code, 'CHAT_READ_LIMIT');
      refused = true;
      break;
    }
  }
  assert.equal(refused, true);
  assert.ok(accepted >= 90 && accepted <= 100);
  assert.equal(names(f.directory).length, accepted + 1);
  clearChatJournalCache(f.root);
  const restored = readChat(f.root, f.profileId, f.chat.id) as typeof f.chat;
  assert.equal(restored.messages[0]!.content.length, 1_000_000 + accepted);
  writeChat(f.root, f.profileId, restored, 'cold-noop');
  assert.deepEqual(readChat(f.root, f.profileId, f.chat.id), restored);
  const target = join(f.root, 'work-limit-backup');
  copyAssistantJournals(f.root, f.profileId, target);
  assert.deepEqual(readChat(target, f.profileId, f.chat.id), restored);
});

test('archive sinks and startup chat counts validate one journal at a time', (t) => {
  const f = fixture(t),
    target = join(f.root, 'streamed-chats');
  const ids: string[] = [];
  for (let ordinal = 0; ordinal < 4; ordinal++) {
    const chat = { ...f.chat, id: randomUUID(), title: 'Fictional ' + ordinal };
    writeChat(f.root, f.profileId, chat, 'initial');
    chat.title += ' updated';
    writeChat(f.root, f.profileId, chat, 'progress');
    ids.push(chat.id);
  }
  assert.equal(countChats(f.root, f.profileId), 4);
  let files = 0;
  const collected = copyAssistantJournals(f.root, f.profileId, target, {
    onFile(path) {
      files++;
      assert.equal(fs.existsSync(join(target, path)), true);
    },
  });
  assert.equal(collected.length, 0);
  assert.equal(files, 12);
  assert.equal(countChats(target, f.profileId), 4);
  for (const id of ids)
    assert.deepEqual(readChat(target, f.profileId, id), readChat(f.root, f.profileId, id));
  const corrupt = join(profilePaths(target, f.profileId).root, 'chats', ids[3]!, 'events');
  fs.writeFileSync(join(corrupt, names(corrupt)[0]!), 'corrupt');
  assert.throws(() => countChats(target, f.profileId), /journal|checksum|JSON/i);
});
