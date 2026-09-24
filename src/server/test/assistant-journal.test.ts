import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChat, writeChat } from '../assistant-journal.ts';
import { profilePaths } from '../profile-storage.ts';

test('optional diagnostic journal limit rejects oversized bytes before parsing without changing ordinary reads', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-bounded-chat-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileId = 'fictional-profile';
  const directory = profilePaths(root, profileId).root;
  mkdirSync(directory, { recursive: true });
  const chat = {
    id: randomUUID(),
    messages: [{ content: 'Independently fictional conversation' }],
  };
  writeChat(root, profileId, chat, 'fictional-test');
  assert.deepEqual(readChat(root, profileId, chat.id), chat);
  let bytesRead = 0;
  assert.throws(
    () =>
      readChat(root, profileId, chat.id, {
        maxBytes: 16,
        onReadBytes: (bytes) => {
          bytesRead += bytes;
        },
      }),
    { code: 'CHAT_READ_LIMIT' },
  );
  assert.equal(bytesRead, 0);
  const events = join(directory, 'chats', chat.id, 'events');
  const file = join(events, readdirSync(events)[0]);
  const size = statSync(file).size;
  assert.deepEqual(
    readChat(root, profileId, chat.id, {
      maxBytes: size,
      onReadBytes: (bytes) => {
        bytesRead += bytes;
      },
    }),
    chat,
  );
  assert.equal(bytesRead, size);
  writeFileSync(join(events, 'fictional-extra-entry'), 'fictional');
  assert.throws(() => readChat(root, profileId, chat.id, { maxBytes: size, maxEntries: 1 }), {
    code: 'CHAT_READ_LIMIT',
  });
  assert.deepEqual(readChat(root, profileId, chat.id), chat);
  writeFileSync(file, 'x'.repeat(9 * 1024 * 1024));
  assert.throws(() => readChat(root, profileId, chat.id, { maxBytes: 8 * 1024 * 1024 }), {
    code: 'CHAT_READ_LIMIT',
  });
});

test('diagnostic byte accounting charges malformed journals even when JSON parsing fails', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-bounded-chat-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileId = 'fictional-profile';
  const directory = profilePaths(root, profileId).root;
  mkdirSync(directory, { recursive: true });
  const chat = { id: randomUUID() };
  writeChat(root, profileId, chat, 'fictional-test');
  const events = join(directory, 'chats', chat.id, 'events');
  const file = join(events, readdirSync(events)[0]);
  writeFileSync(file, 'fictional invalid JSON');
  let bytesRead = 0;
  assert.throws(
    () =>
      readChat(root, profileId, chat.id, {
        maxBytes: 100,
        onReadBytes: (bytes) => {
          bytesRead += bytes;
        },
      }),
    SyntaxError,
  );
  assert.equal(bytesRead, statSync(file).size);
  assert.throws(() => readChat(root, profileId, chat.id, { maxBytes: 0 }), RangeError);
});
