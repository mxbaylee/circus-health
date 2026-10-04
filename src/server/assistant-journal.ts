import {
  mkdirSync,
  readdirSync,
  realpathSync,
  existsSync,
  openSync,
  fsyncSync,
  closeSync,
  fstatSync,
  readSync,
  writeFileSync,
  constants,
  opendirSync,
  linkSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { profilePaths } from './profile-storage.ts';
import { portableWork } from './portable-work.ts';
import { HttpError } from './database.ts';
import {
  clearJournalActivityIndex,
  forgetJournalActivityScope,
  publishedJournalActivity,
} from './journal-activity-index.ts';
import {
  applyChatChanges,
  chatChanges,
  cloneChatJson,
  chatDecodeBudget,
  ChatDecodeLimitError,
  type ChatDecodeBudget,
  type ChatJson,
} from './chat-journal-codec.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT = /^(\d{12})-([0-9a-f]{64})\.json$/;
const FORMAT = 'health-chat-delta-v2';
const HEAD = 'health-chat-head-v2';
const DEFAULT_BYTES = 256 * 1024 * 1024;
const DEFAULT_ENTRIES = 100_000;
type UnknownRecord = Record<string, unknown>;
const object = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function invalid(): never {
  throw Error('Invalid conversation journal');
}
interface Usage {
  eventBytes: number;
  remaining: ChatDecodeBudget;
}
interface Tip {
  tail: string;
  usage: Usage;
}
interface Remembered {
  usage: Usage;
  directory: string;
  tail: string;
  state: ChatJson;
  scope: string;
}
// Weak caller-owned keys never keep plaintext alive; closure also drops copies.
const remembered = new WeakMap<object, Remembered>();
const scopes = new Map<string, Set<WeakRef<object>>>();
function remember(chat: object, value: Remembered) {
  const old = remembered.get(chat);
  remembered.set(chat, value);
  if (old?.scope === value.scope) return;
  const references = scopes.get(value.scope) ?? new Set<WeakRef<object>>();
  for (const reference of references) if (!reference.deref()) references.delete(reference);
  references.add(new WeakRef(chat));
  scopes.set(value.scope, references);
}
export function forgetChatJournal(chat: object): void {
  const prior = remembered.get(chat);
  if (prior) forgetJournalActivityScope(prior.scope);
  remembered.delete(chat);
}
export function clearChatJournalCache(root: string, profileId?: string): void {
  clearJournalActivityIndex(root, profileId);
  const prefix = resolve(root) + '/';
  const selected = profileId ? resolve(profilePaths(root, profileId).root) : null;
  for (const [scope, references] of scopes) {
    if (selected ? scope !== selected : !scope.startsWith(prefix)) continue;
    for (const reference of references) {
      const chat = reference.deref();
      if (chat) remembered.delete(chat);
    }
    scopes.delete(scope);
  }
}
function directories(root: string, profileId: string, chatId: string, create = false): string {
  if (!UUID.test(chatId)) throw new HttpError(404, 'CHAT_NOT_FOUND', 'Conversation not found');
  const base = realpathSync(profilePaths(root, profileId).root);
  if (base !== join(realpathSync(root), 'data', 'profiles', profileId)) invalid();
  let directory = base;
  for (const segment of ['chats', chatId, 'events']) {
    directory = join(directory, segment);
    if (!existsSync(directory)) {
      if (!create) throw new HttpError(404, 'CHAT_NOT_FOUND', 'Conversation not found');
      mkdirSync(directory, { mode: 0o700 });
    }
    if (realpathSync(directory) !== directory) invalid();
  }
  return directory;
}
export interface ChatReadOptions {
  /** Aggregate physical bytes across every generation needed for replay. */
  maxBytes: number;
  /** All inspected directory entries, including unfinished files; default 10,000. */
  maxEntries?: number;
  onReadBytes?: (bytes: number) => void;
}
interface Budget {
  remaining: number;
  entries: number;
  onReadBytes?: (bytes: number) => void;
}
function budget(options?: ChatReadOptions): Budget {
  const maxBytes = options?.maxBytes ?? DEFAULT_BYTES;
  const entries = options?.maxEntries ?? (options ? 10_000 : DEFAULT_ENTRIES);
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(entries) ||
    entries < 1
  )
    throw new RangeError('Conversation read limits must be positive safe integers');
  return { remaining: maxBytes, entries, onReadBytes: options?.onReadBytes };
}
function limited(): never {
  throw new HttpError(
    413,
    'CHAT_READ_LIMIT',
    'Conversation history exceeds its aggregate read limit',
  );
}
function inventory(
  directory: string,
  limits: Budget,
  tail: string | null,
  cleanup?: { profileId: string; id: string },
): string[] {
  const entries = opendirSync(directory),
    names: string[] = [];
  try {
    for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
      if (--limits.entries < 0) limited();
      if (EVENT.test(entry.name)) {
        if (!tail) invalid(); // A lost commit marker is not an absent conversation.
        if (Number(entry.name.slice(0, 12)) <= Number(tail?.slice(0, 12) ?? 0))
          names.push(entry.name);
        else if (cleanup) {
          if (Number(entry.name.slice(0, 12)) !== Number(tail?.slice(0, 12) ?? 0) + 1) invalid();
          readEvent(directory, entry.name, limits, cleanup.profileId, cleanup.id, tail);
          // A crash between event and tip publication did not commit this file.
          // Preserve its bytes as pending evidence, never adopt it on retry.
          renameSync(
            join(directory, entry.name),
            join(pendingDirectory(directory), entry.name + '.' + randomUUID() + '.pending'),
          );
        }
      } else if (entry.name.endsWith('.json')) invalid();
    }
  } finally {
    entries.closeSync();
  }
  names.sort();
  for (let i = 0; i < names.length; i++) if (Number(names[i]!.slice(0, 12)) !== i + 1) invalid();
  if (tail !== (names.at(-1) ?? null)) invalid();
  return names;
}
function pendingDirectory(directory: string): string {
  const pending = join(dirname(directory), 'unpublished');
  mkdirSync(pending, { recursive: true, mode: 0o700 });
  if (realpathSync(pending) !== pending) invalid();
  return pending;
}
function readBytes(file: string, limits: Budget, maximum = DEFAULT_BYTES): Buffer {
  if (realpathSync(file) !== file) invalid();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) invalid();
    if (stat.size > limits.remaining || stat.size > maximum) limited();
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) invalid();
      offset += count;
      limits.remaining -= count;
      limits.onReadBytes?.(count);
    }
    const extra = readSync(fd, Buffer.alloc(1), 0, 1, null);
    if (extra) {
      limits.remaining -= extra;
      limits.onReadBytes?.(extra);
      invalid();
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function readHead(directory: string, limits: Budget, profileId: string, id: string): Tip | null {
  const file = join(directory, 'current');
  if (!existsSync(file)) return null;
  const value: unknown = JSON.parse(readBytes(file, limits, 4096).toString('utf8'));
  if (
    !object(value) ||
    value.format !== HEAD ||
    value.profileId !== profileId ||
    value.chatId !== id ||
    typeof value.tail !== 'string' ||
    !EVENT.test(value.tail) ||
    Object.keys(value).length !== 5 ||
    !object(value.usage)
  )
    invalid();
  const usage = value.usage;
  if (
    Object.keys(usage).length !== 2 ||
    !Number.isSafeInteger(usage.eventBytes) ||
    Number(usage.eventBytes) < 1 ||
    Number(usage.eventBytes) > DEFAULT_BYTES - 4096 ||
    !object(usage.remaining)
  )
    invalid();
  const maximum = chatDecodeBudget();
  if (Object.keys(usage.remaining).length !== 3) invalid();
  for (const key of ['nodes', 'operations', 'stringWork'] as const)
    if (
      !Number.isSafeInteger(usage.remaining[key]) ||
      Number(usage.remaining[key]) < 0 ||
      Number(usage.remaining[key]) > maximum[key]
    )
      invalid();
  return { tail: value.tail, usage: usage as unknown as Usage };
}
function apply(initial: ChatJson | undefined, changes: unknown, remaining: ChatDecodeBudget) {
  try {
    return applyChatChanges(initial, changes, remaining);
  } catch (error) {
    if (error instanceof ChatDecodeLimitError) limited();
    throw error;
  }
}
function publishHead(directory: string, profileId: string, chatId: string, tip: Tip): void {
  const file = join(directory, 'current');
  const pending = join(pendingDirectory(directory), 'current.' + randomUUID() + '.pending');
  try {
    const fd = openSync(pending, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ format: HEAD, profileId, chatId, ...tip }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(pending, file);
    const dir = openSync(directory, 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } finally {
    if (existsSync(pending)) unlinkSync(pending);
  }
}
function readEvent(
  directory: string,
  name: string,
  limits: Budget,
  profileId: string,
  chatId: string,
  previous: string | null | undefined,
  capture?: (bytes: Buffer) => void,
): UnknownRecord {
  const match = EVENT.exec(name);
  if (!match) invalid();
  const bytes = readBytes(join(directory, name), limits);
  if (digest(bytes) !== match[2]) invalid();
  const saved: unknown = JSON.parse(bytes.toString('utf8'));
  if (
    !object(saved) ||
    saved.format !== FORMAT ||
    saved.profileId !== profileId ||
    saved.chatId !== chatId ||
    saved.sequence !== Number(match[1]) ||
    (previous !== undefined && saved.previous !== previous) ||
    typeof saved.reason !== 'string' ||
    saved.reason.length > 10_000 ||
    typeof saved.savedAt !== 'string' ||
    !Number.isFinite(Date.parse(saved.savedAt)) ||
    Object.keys(saved).length !== 8 ||
    !Object.hasOwn(saved, 'changes')
  )
    invalid();
  capture?.(bytes);
  return saved;
}
function reconstruct(
  directory: string,
  names: string[],
  limits: Budget,
  profileId: string,
  id: string,
  tip: Tip | null,
  capture?: (name: string, bytes: Buffer) => void,
): { state: ChatJson; usage: Usage } {
  if (!names.length || !tip) throw new HttpError(404, 'CHAT_NOT_FOUND', 'Conversation not found');
  let state: ChatJson | undefined;
  const remaining = chatDecodeBudget();
  const initialBytes = limits.remaining;
  for (let i = 0; i < names.length; i++) {
    let bytes: Buffer | undefined;
    const saved = readEvent(
      directory,
      names[i]!,
      limits,
      profileId,
      id,
      names[i - 1] ?? null,
      capture
        ? (value) => {
            bytes = value;
          }
        : undefined,
    );
    state = apply(state, saved.changes, remaining);
    if (!object(state) || state.id !== id) invalid();
    if (capture) capture(names[i]!, bytes!);
  }
  const usage = { eventBytes: initialBytes - limits.remaining, remaining };
  if (JSON.stringify(usage) !== JSON.stringify(tip.usage)) invalid();
  return { state: state!, usage };
}
export function readChat(
  root: string,
  profileId: string,
  id: string,
  options?: ChatReadOptions,
): unknown {
  const directory = directories(root, profileId, id),
    limits = budget(options);
  const tip = readHead(directory, limits, profileId, id);
  const names = inventory(directory, limits, tip?.tail ?? null);
  const decoded = reconstruct(directory, names, limits, profileId, id, tip);
  if (!options && object(decoded.state))
    remember(decoded.state, {
      directory,
      tail: tip!.tail,
      state: cloneChatJson(decoded.state),
      usage: decoded.usage,
      scope: resolve(profilePaths(root, profileId).root),
    });
  return decoded.state;
}
function* chatIds(root: string, profileId: string): Generator<string> {
  const path = join(realpathSync(profilePaths(root, profileId).root), 'chats');
  if (!existsSync(path)) return;
  if (realpathSync(path) !== path) invalid();
  const directory = opendirSync(path);
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync())
      if (UUID.test(entry.name)) yield entry.name;
  } finally {
    directory.closeSync();
  }
}
/** Startup validates every journal but retains only one decoded conversation. */
export function countChats(root: string, profileId: string): number {
  let total = 0;
  for (const id of chatIds(root, profileId)) {
    try {
      if (
        object(
          readChat(root, profileId, id, {
            maxBytes: DEFAULT_BYTES,
            maxEntries: DEFAULT_ENTRIES,
            onReadBytes: (bytes) => portableWork('journalReadBytes', bytes),
          }),
        )
      )
        total++;
    } catch (error) {
      if (!(error instanceof HttpError && error.code === 'CHAT_NOT_FOUND')) throw error;
    }
  }
  return total;
}
export function listChats(root: string, profileId: string): unknown[] {
  const directory = join(realpathSync(profilePaths(root, profileId).root), 'chats');
  if (!existsSync(directory)) return [];
  if (realpathSync(directory) !== directory) invalid();
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
    .filter(object)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
}
export function writeChat(root: string, profileId: string, chat: unknown, reason: string): void {
  if (
    !object(chat) ||
    typeof chat.id !== 'string' ||
    typeof reason !== 'string' ||
    reason.length > 10_000
  )
    invalid();
  const directory = directories(root, profileId, chat.id, true),
    limits = budget();
  let file: string | undefined, nextTail: string | undefined;
  try {
    const tip = readHead(directory, limits, profileId, chat.id);
    let prior = remembered.get(chat);
    if (
      prior?.directory !== directory ||
      prior.tail !== tip?.tail ||
      JSON.stringify(prior.usage) !== JSON.stringify(tip?.usage)
    )
      prior = undefined;
    if (prior && tip) {
      const sequence = Number(tip.tail.slice(0, 12));
      const saved = readEvent(
        directory,
        tip.tail,
        limits,
        profileId,
        chat.id,
        sequence === 1 ? null : undefined,
      );
      if (
        sequence > 1 &&
        (typeof saved.previous !== 'string' ||
          !EVENT.test(saved.previous) ||
          Number(saved.previous.slice(0, 12)) !== sequence - 1)
      )
        invalid();
    }
    const decoded =
      prior ??
      (tip
        ? reconstruct(
            directory,
            inventory(directory, limits, tip.tail, { profileId, id: chat.id }),
            limits,
            profileId,
            chat.id,
            tip,
          )
        : undefined);
    if (!tip) inventory(directory, limits, null, { profileId, id: chat.id });
    const before = decoded?.state;
    const changes =
      before === undefined
        ? [{ op: 'set', path: [], value: cloneChatJson(chat) }]
        : chatChanges(before, chat);
    const remaining = { ...(decoded?.usage.remaining ?? chatDecodeBudget()) };
    // Only the private basis is mutated. Any failure drops it; recovery uses files.
    const state = apply(before, changes, remaining);
    if (!object(state) || state.id !== chat.id) invalid();
    const sequence = tip ? Number(tip.tail.slice(0, 12)) + 1 : 1;
    if (sequence >= DEFAULT_ENTRIES) limited();
    const value = {
      format: FORMAT,
      profileId,
      chatId: chat.id,
      sequence,
      previous: tip?.tail ?? null,
      reason,
      savedAt: new Date().toISOString(),
      changes,
    };
    const bytes = Buffer.from(JSON.stringify(value));
    const usage = { eventBytes: (decoded?.usage.eventBytes ?? 0) + bytes.length, remaining };
    if (usage.eventBytes > DEFAULT_BYTES - 4096) limited();
    nextTail = String(sequence).padStart(12, '0') + '-' + digest(bytes) + '.json';
    file = join(directory, nextTail);
    const temporary = join(pendingDirectory(directory), nextTail + '.' + randomUUID() + '.pending');
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      linkSync(temporary, file);
      unlinkSync(temporary);
      const dir = openSync(directory, 'r');
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
      publishHead(directory, profileId, chat.id, { tail: nextTail, usage });
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    remember(chat, {
      directory,
      tail: nextTail,
      state,
      usage,
      scope: resolve(profilePaths(root, profileId).root),
    });
    publishedJournalActivity(root, profileId, 'chat', chat.id);
  } catch (error) {
    clearJournalActivityIndex(root, profileId);
    forgetChatJournal(chat);
    // Keep an ambiguously committed generation if the current pointer names it.
    // Never delete prior history or rely on a failed append's cached basis.
    if (file && existsSync(file)) {
      try {
        if (readHead(directory, budget(), profileId, chat.id)?.tail !== nextTail) unlinkSync(file);
      } catch {}
    }
    if (error instanceof ChatDecodeLimitError) limited();
    throw error;
  }
}
export function copyAssistantJournals(
  root: string,
  profileId: string,
  targetRoot: string,
  { onFile }: { onFile?: (path: string) => void } = {},
): string[] {
  const copied: string[] = [];
  const chats = join(realpathSync(profilePaths(root, profileId).root), 'chats');
  if (!existsSync(chats)) return copied;
  if (realpathSync(chats) !== chats) invalid();
  mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  const targetBase = realpathSync(targetRoot);
  for (const id of chatIds(root, profileId)) {
    const directory = directories(root, profileId, id),
      limits = budget({
        maxBytes: DEFAULT_BYTES,
        maxEntries: DEFAULT_ENTRIES,
        onReadBytes: (bytes) => portableWork('journalReadBytes', bytes),
      });
    const tip = readHead(directory, limits, profileId, id);
    const names = inventory(directory, limits, tip?.tail ?? null);
    if (!names.length) continue;
    const save = (name: string, bytes: Buffer) => {
      const path = `${profilePaths(root, profileId).relativeRoot}/chats/${id}/events/${name}`;
      const target = resolve(targetBase, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (realpathSync(dirname(target)) !== dirname(target)) invalid();
      portableWork('outputBytes', bytes.length);
      portableWork('maxOutputChunkBytes', bytes.length, true);
      writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
      if (onFile) onFile(path);
      else copied.push(path);
    };
    reconstruct(directory, names, limits, profileId, id, tip, save);
    save('current', Buffer.from(JSON.stringify({ format: HEAD, profileId, chatId: id, ...tip! })));
  }
  return copied;
}
