import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  realpathSync,
  existsSync,
  copyFileSync,
  openSync,
  fsyncSync,
  closeSync,
  fstatSync,
  readSync,
  constants,
  opendirSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { profilePaths } from './profile-storage.ts';
import { HttpError } from './database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT = /^\d{12}-[0-9a-f-]{36}\.json$/;
type UnknownRecord = Record<string, unknown>;
const object = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function directories(root: string, profileId: string, chatId: string, create = false): string {
  if (!UUID.test(chatId)) throw new HttpError(404, 'CHAT_NOT_FOUND', 'Conversation not found');
  const base = realpathSync(profilePaths(root, profileId).root);
  let directory = base;
  for (const segment of ['chats', chatId, 'events']) {
    directory = join(directory, segment);
    if (!existsSync(directory)) {
      if (!create) throw new HttpError(404, 'CHAT_NOT_FOUND', 'Conversation not found');
      mkdirSync(directory, { mode: 0o700 });
    }
    if (realpathSync(directory) !== directory)
      throw new Error('Conversation path escaped its profile');
  }
  return directory;
}
export interface ChatReadOptions {
  /** Optional diagnostic budget. Ordinary conversation loading is unchanged. */
  maxBytes: number;
  /** Directory entries inspected for its latest generation; defaults to 10,000. */
  maxEntries?: number;
  onReadBytes?: (bytes: number) => void;
}
function boundedLatestEvent(directory: string, maxEntries = 10_000): string | undefined {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
    throw new RangeError('Conversation entry limit must be a positive safe integer');
  const entries = opendirSync(directory);
  let latest: string | undefined;
  let inspected = 0;
  try {
    for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
      if (++inspected > maxEntries)
        throw new HttpError(
          413,
          'CHAT_READ_LIMIT',
          'Conversation history exceeds its diagnostic entry limit',
        );
      if (EVENT.test(entry.name) && (!latest || entry.name > latest)) latest = entry.name;
    }
  } finally {
    entries.closeSync();
  }
  return latest;
}
function boundedChatBytes(file: string, options: ChatReadOptions): string {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
    throw new RangeError('Conversation read limit must be a positive safe integer');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > options.maxBytes)
      throw new HttpError(
        413,
        'CHAT_READ_LIMIT',
        'Conversation journal exceeds its diagnostic read limit',
      );
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!read) break;
      options.onReadBytes?.(read);
      offset += read;
    }
    // Published generations are immutable. Reject concurrent growth without
    // allowing readFileSync to allocate beyond the stat-checked budget.
    const extra = readSync(fd, Buffer.alloc(1), 0, 1, null);
    if (extra) {
      options.onReadBytes?.(extra);
      throw new HttpError(
        413,
        'CHAT_READ_LIMIT',
        'Conversation journal changed during its diagnostic read',
      );
    }
    return bytes.subarray(0, offset).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
export function readChat(
  root: string,
  profileId: string,
  id: string,
  options?: ChatReadOptions,
): unknown {
  const directory = directories(root, profileId, id);
  const latest = options
    ? boundedLatestEvent(directory, options.maxEntries)
    : readdirSync(directory)
        .filter((name) => EVENT.test(name))
        .sort()
        .at(-1);
  if (!latest) throw new HttpError(404, 'CHAT_NOT_FOUND', 'Conversation not found');
  const file = join(directory, latest);
  if (realpathSync(file) !== file)
    throw new Error('Conversation journal cannot be a symbolic link');
  const saved: unknown = JSON.parse(
    options ? boundedChatBytes(file, options) : readFileSync(file, 'utf8'),
  );
  if (
    !object(saved) ||
    saved.format !== 'health-chat-v1' ||
    saved.profileId !== profileId ||
    !object(saved.chat) ||
    saved.chat.id !== id
  )
    throw new Error('Conversation journal profile mismatch');
  return saved.chat;
}
export function listChats(root: string, profileId: string): unknown[] {
  const directory = join(profilePaths(root, profileId).root, 'chats');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((id) => UUID.test(id))
    .map((id) => {
      try {
        return readChat(root, profileId, id);
      } catch (error) {
        if (error instanceof HttpError && error.code === 'CHAT_NOT_FOUND') return null;
        throw error;
      }
    })
    .filter((chat): chat is UnknownRecord => object(chat))
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
}
export function writeChat(root: string, profileId: string, chat: unknown, reason: string): void {
  if (!object(chat) || typeof chat.id !== 'string')
    throw new Error('Conversation journal requires a valid chat');
  const directory = directories(root, profileId, chat.id, true);
  const names = readdirSync(directory)
    .filter((name) => EVENT.test(name))
    .sort();
  const latest = names.at(-1);
  const sequence = latest ? Number(latest.slice(0, 12)) + 1 : 1;
  const file = join(directory, `${String(sequence).padStart(12, '0')}-${randomUUID()}.json`);
  const temporary = file + '.pending';
  const value = {
    format: 'health-chat-v1',
    profileId,
    sequence,
    reason,
    savedAt: new Date().toISOString(),
    chat,
  };
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  const dir = openSync(directory, 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
export function copyAssistantJournals(
  root: string,
  profileId: string,
  targetRoot: string,
): string[] {
  const copied: string[] = [];
  for (const value of listChats(root, profileId)) {
    const chat = object(value) ? value : {};
    const chatId =
      typeof chat.id === 'string'
        ? chat.id
        : (() => {
            throw new Error('Conversation journal has an invalid ID');
          })();
    const directory = directories(root, profileId, chatId);
    // Snapshot the filenames once. Later streamed saves are separate immutable
    // files, so a backup never contains half of a conversation generation.
    for (const name of readdirSync(directory)
      .filter((name) => EVENT.test(name))
      .sort()) {
      const source = join(directory, name);
      if (realpathSync(source) !== source)
        throw new Error('Conversation journal cannot be a symbolic link');
      const value: unknown = JSON.parse(readFileSync(source, 'utf8'));
      if (
        !object(value) ||
        value.profileId !== profileId ||
        !object(value.chat) ||
        value.chat.id !== chatId ||
        value.format !== 'health-chat-v1'
      )
        throw new Error('Conversation journal profile mismatch');
      const path = `${profilePaths(root, profileId).relativeRoot}/chats/${chatId}/events/${name}`;
      const target = resolve(targetRoot, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(source, target);
      copied.push(path);
    }
  }
  return copied;
}
