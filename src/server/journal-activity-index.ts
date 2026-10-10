import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { disposableSqlite } from './disposable-sqlite.ts';
import { profilePaths } from './profile-storage.ts';
import { HttpError } from './database.ts';
import { chatDecodeBudget, type ChatDecodeBudget } from './chat-journal-codec.ts';
import {
  JournalJsonIndex,
  journalJsonWork,
  drainJournalWork,
  type JournalJsonWork,
} from './journal-json-index.ts';
import { JournalActivityOrder } from './journal-activity-order.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHAT_EVENT = /^(\d{12})-([0-9a-f]{64})\.json$/;
const BATCH_EVENT = /^(\d{12})-([0-9a-f-]{36})\.json$/;
type Kind = 'chat' | 'batch';
interface Selected {
  id: string;
  kind: Kind;
  root: number;
  pin: string;
  ordinal: number;
  tail: string | null;
  digest: string | null;
  bytes: number;
  legacyCount: number;
  legacyDigest: string | null;
  remaining: string | null;
}
interface ActivityIndex {
  scratch: ReturnType<typeof disposableSqlite>;
  json: JournalJsonIndex;
  order: JournalActivityOrder;
  ready: boolean;
  profileId: string;
  root: string;
  work: JournalJsonWork;
  containers: { chat: string; batch: string };
}
const indexes = new Map<string, ActivityIndex>();
const scope = (root: string, profileId: string) => resolve(profilePaths(root, profileId).root);
function invalid(): never {
  throw Error('Invalid or unsupported journal activity evidence');
}
function pending(): never {
  throw new HttpError(
    409,
    'JOURNAL_ACTIVITY_NOT_PREPARED',
    'Reading activity is being prepared; retry after preparation completes',
  );
}
function path(index: ActivityIndex, kind: Kind, id: string) {
  return join(
    scope(index.root, index.profileId),
    kind === 'chat' ? 'chats' : 'intake-batches',
    id,
    'events',
  );
}
function select(index: ActivityIndex, kind: Kind, id: string): Selected | undefined {
  return index.scratch.db
    .prepare('SELECT * FROM activity_journals WHERE kind=? AND id=?')
    .get(kind, id) as unknown as Selected | undefined;
}
function checkedFile(file: string, maximum: number): Buffer {
  if (realpathSync(file) !== file) invalid();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) invalid();
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) invalid();
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null)) invalid();
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function container(index: ActivityIndex, kind: Kind): string {
  const base = join(
    scope(index.root, index.profileId),
    kind === 'chat' ? 'chats' : 'intake-batches',
  );
  if (!existsSync(base)) return 'absent';
  if (realpathSync(base) !== base) invalid();
  const stat = statSync(base, { bigint: true });
  if (!stat.isDirectory()) invalid();
  return [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join(':');
}
function head(index: ActivityIndex, kind: Kind, id: string): { value: any; pin: string } {
  const file = join(path(index, kind, id), 'current');
  if (!existsSync(file)) return { value: null, pin: 'legacy' };
  const bytes = checkedFile(file, 4096),
    value = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || value.profileId !== index.profileId) invalid();
  if (kind === 'chat') {
    if (
      value.format !== 'health-chat-head-v2' ||
      value.chatId !== id ||
      Object.keys(value).length !== 5 ||
      !CHAT_EVENT.test(value.tail) ||
      !value.usage ||
      Object.keys(value.usage).length !== 2 ||
      !value.usage.remaining ||
      Object.keys(value.usage.remaining).length !== 3
    )
      invalid();
    if (
      !Number.isSafeInteger(value.usage.eventBytes) ||
      value.usage.eventBytes < 1 ||
      value.usage.eventBytes > 256 * 1024 * 1024 - 4096
    )
      invalid();
    for (const [key, maximum] of Object.entries(chatDecodeBudget()))
      if (
        !Number.isSafeInteger(value.usage.remaining[key]) ||
        value.usage.remaining[key] < 0 ||
        value.usage.remaining[key] > maximum
      )
        invalid();
  } else {
    if (
      value.format !== 'health-intake-batch-head-v3' ||
      value.batchId !== id ||
      Object.keys(value).length !== 6 ||
      !value.usage ||
      Object.keys(value.usage).length !== 1 ||
      !Number.isSafeInteger(value.usage.eventBytes) ||
      value.usage.eventBytes < 0 ||
      (value.tail !== null && !reference(value.tail))
    )
      invalid();
    if (
      value.legacy !== null &&
      (!value.legacy ||
        Object.keys(value.legacy).length !== 2 ||
        !Number.isSafeInteger(value.legacy.count) ||
        value.legacy.count < 1 ||
        !/^[0-9a-f]{64}$/.test(value.legacy.digest))
    )
      invalid();
    if (value.tail === null && (value.usage.eventBytes !== 0 || value.legacy !== null)) invalid();
  }
  return { value, pin: createHash('sha256').update(bytes).digest('hex') };
}
function reference(value: any): boolean {
  return (
    !!value &&
    Object.keys(value).length === 2 &&
    typeof value.name === 'string' &&
    BATCH_EVENT.test(value.name) &&
    UUID.test(value.name.slice(13, -5)) &&
    typeof value.digest === 'string' &&
    /^[0-9a-f]{64}$/.test(value.digest)
  );
}
function ref(index: ActivityIndex, id: number): { name: string; digest: string } | null {
  if (index.json.node(id).kind === 'null') return null;
  index.json.exact(id, ['name', 'digest']);
  const value = { name: index.json.field(id, 'name'), digest: index.json.field(id, 'digest') };
  if (!reference(value)) invalid();
  return value;
}
function* verifyValue(
  index: ActivityIndex,
  value: number,
  depth: number,
  remaining?: ChatDecodeBudget,
): Generator<void> {
  let count = 0;
  // Co-routine rows avoid a whole-subtree aggregate before the first yield.
  const rows = index.scratch.db
    .prepare(
      `WITH RECURSIVE tree(id,depth,kind,length,key) AS (
    SELECT id,?,kind,length,key FROM journal_nodes WHERE id=? UNION ALL
    SELECT n.id,t.depth+1,n.kind,n.length,n.key FROM journal_nodes n JOIN tree t ON n.parent=t.id)
    SELECT depth,kind,length,journal_key_valid(key) AS valid FROM tree`,
    )
    .iterate(depth, value);
  for (const row of rows) {
    if (
      Number(row.depth) > 64 ||
      (['array', 'object'].includes(String(row.kind)) &&
        Number(row.length) > (remaining ? 1_000_000 : Number.MAX_SAFE_INTEGER)) ||
      !row.valid
    )
      invalid();
    index.work.validatedNodes++;
    count++;
    if (remaining && --remaining.nodes < 0)
      throw new HttpError(413, 'CHAT_READ_LIMIT', 'Conversation decoded work limit exceeded');
    if (count % 128 === 0) yield;
  }
  if (!count) invalid();
}
function* applyChanges(
  index: ActivityIndex,
  state: number | undefined,
  changes: number,
  remaining?: ChatDecodeBudget,
): Generator<void, number> {
  const json = index.json,
    container = json.node(changes);
  if (container.kind !== 'array' || (remaining && container.length > 1_000_000)) invalid();
  let current = state;
  for (let i = 0; i < container.length; i++) {
    index.work.appliedChanges++;
    if (i % 128 === 0) yield;
    const change = json.child(changes, String(i)),
      op = json.field(change, 'op'),
      keys = json.keys(json.child(change, 'path'));
    json.exact(
      change,
      op === 'set'
        ? ['op', 'path', 'value']
        : op === 'remove'
          ? ['op', 'path']
          : op === 'truncate'
            ? ['op', 'path', 'length']
            : op === 'splice' && remaining
              ? ['op', 'path', 'offset', 'remove', 'text']
              : invalid(),
    );
    if (remaining) {
      remaining.operations -= 1 + keys.length;
      if (remaining.operations < 0)
        throw new HttpError(413, 'CHAT_READ_LIMIT', 'Conversation decoded work limit exceeded');
    }
    if (!keys.length && op === 'set') {
      if (current !== undefined) invalid();
      current = json.child(change, 'value');
      yield* verifyValue(index, current, 0, remaining);
      json.detach(current);
      continue;
    }
    if (current === undefined) invalid();
    const parent = keys.length ? json.path(current, keys.slice(0, -1)) : current;
    if (op === 'set') {
      if (!keys.length) invalid();
      const value = json.child(change, 'value');
      yield* verifyValue(index, value, keys.length, remaining);
      yield* json.replaceSteps(parent, keys.at(-1)!, value);
    } else if (op === 'remove') {
      if (!keys.length || json.node(parent).kind !== 'object') invalid();
      yield* json.dropSteps(json.child(parent, keys.at(-1)!));
    } else if (op === 'truncate')
      yield* json.truncateSteps(json.path(current, keys), json.field(change, 'length'));
    else {
      const target = json.path(current, keys),
        text = json.child(change, 'text');
      remaining!.stringWork -= json.node(target).length + json.node(text).length;
      if (remaining!.stringWork < 0)
        throw new HttpError(413, 'CHAT_READ_LIMIT', 'Conversation decoded work limit exceeded');
      const value = yield* json.spliceSteps(
        target,
        json.field(change, 'offset'),
        json.field(change, 'remove'),
        text,
      );
      if (keys.length) yield* json.replaceSteps(parent, keys.at(-1)!, value);
      else {
        yield* json.dropSteps(current);
        current = value;
      }
    }
  }
  if (current === undefined || json.node(current).kind !== 'object') invalid();
  return current;
}
function identity(index: ActivityIndex, kind: Kind, id: string, state: number): void {
  if (index.json.field(state, 'id') !== id) invalid();
  if (
    kind === 'batch' &&
    (index.json.field(state, 'profileId') !== index.profileId ||
      index.json.node(index.json.child(state, 'items')).kind !== 'array')
  )
    invalid();
}
function* replay(
  index: ActivityIndex,
  kind: Kind,
  id: string,
  name: string,
  state: Selected | undefined,
  remaining?: ChatDecodeBudget,
  selectedHead = true,
): Generator<void, Selected> {
  const parsed = yield* index.json.parseSteps(join(path(index, kind, id), name), index.work);
  const json = index.json,
    event = parsed.root;
  let succeeded = false;
  try {
    const sequence = Number(name.slice(0, 12)),
      format = json.field(event, 'format');
    if (
      sequence !== (state?.tail ? Number(state.tail.slice(0, 12)) + 1 : 1) ||
      json.field(event, 'profileId') !== index.profileId ||
      json.field(event, 'sequence') !== sequence ||
      typeof json.field(event, 'reason') !== 'string' ||
      !Number.isFinite(Date.parse(json.field(event, 'savedAt')))
    )
      invalid();
    let root: number,
      legacyCount = state?.legacyCount ?? 0;
    if (kind === 'chat') {
      json.exact(event, [
        'format',
        'profileId',
        'chatId',
        'sequence',
        'previous',
        'reason',
        'savedAt',
        'changes',
      ]);
      if (
        format !== 'health-chat-delta-v2' ||
        json.field(event, 'chatId') !== id ||
        json.field(event, 'previous') !== (state?.tail ?? null) ||
        parsed.digest !== CHAT_EVENT.exec(name)?.[2] ||
        String(json.field(event, 'reason')).length > 10_000
      )
        invalid();
      root = yield* applyChanges(index, state?.root, json.child(event, 'changes'), remaining);
    } else if (format === 'health-intake-batch-delta-v3') {
      if (!selectedHead) invalid();
      json.exact(event, [
        'format',
        'profileId',
        'batchId',
        'sequence',
        'previous',
        'reason',
        'savedAt',
        'changes',
      ]);
      const previous = ref(index, json.child(event, 'previous'));
      if (
        json.field(event, 'batchId') !== id ||
        (previous === null
          ? !!state?.tail
          : previous.name !== state?.tail || previous.digest !== state?.digest)
      )
        invalid();
      root = yield* applyChanges(index, state?.root, json.child(event, 'changes'));
    } else if (format === 'health-intake-batch-v1' || format === 'health-intake-batch-delta-v2') {
      if (sequence !== legacyCount + 1) invalid();
      legacyCount++;
      if (format === 'health-intake-batch-v1') {
        root = json.child(event, 'batch');
        yield* verifyValue(index, root, 0);
        json.detach(root);
        if (state) yield* json.dropSteps(state.root);
      } else {
        if (!state || json.field(event, 'batchId') !== id) invalid();
        root = state.root;
        const changes = json.child(event, 'changes'),
          removed = json.child(event, 'removed');
        for (const field of [changes, removed]) if (json.node(field).kind !== 'array') invalid();
        for (let i = 0; i < json.node(changes).length; i++) {
          index.work.appliedChanges++;
          if (i % 128 === 0) yield;
          const entry = json.child(changes, String(i));
          if (json.node(entry).kind !== 'array' || json.node(entry).length !== 2) invalid();
          const keys = json.keys(json.child(entry, '0'));
          if (!keys.length) invalid();
          const parent = json.path(root, keys.slice(0, -1)),
            key = keys.at(-1)!,
            value = json.child(entry, '1');
          if (json.node(parent).kind === 'array' && key === 'length')
            yield* json.truncateSteps(parent, json.scalar(value), true);
          else {
            yield* verifyValue(index, value, keys.length);
            yield* json.replaceSteps(parent, key, value);
          }
        }
        for (let i = 0; i < json.node(removed).length; i++) {
          index.work.appliedChanges++;
          if (i % 128 === 0) yield;
          const keys = json.keys(json.child(removed, String(i)));
          if (!keys.length) invalid();
          const parent = json.path(root, keys.slice(0, -1)),
            key = keys.at(-1)!;
          if (
            !['array', 'object'].includes(json.node(parent).kind) ||
            (json.node(parent).kind === 'array' && !/^(0|[1-9]\d*)$/.test(key))
          )
            invalid();
          const value = json.maybe(parent, key);
          if (value !== undefined) yield* json.dropSteps(value);
        }
      }
    } else invalid();
    identity(index, kind, id, root);
    succeeded = true;
    return {
      id,
      kind,
      root,
      pin: '',
      ordinal: state?.ordinal ?? 0,
      tail: name,
      digest: parsed.digest,
      bytes: (state?.bytes ?? 0) + parsed.bytes,
      legacyCount,
      legacyDigest: null,
      remaining: remaining ? JSON.stringify(remaining) : null,
    };
  } finally {
    if (succeeded) yield* json.dropSteps(event);
  }
}
function* validateOrphan(
  index: ActivityIndex,
  id: string,
  name: string,
  state: Selected | undefined,
): Generator<void> {
  const directory = path(index, 'batch', id),
    json = index.json;
  const parsed = yield* json.parseSteps(
    join(directory, name),
    index.work,
    undefined,
    resolve(directory, '..', 'unpublished', name + '.pending'),
  );
  let candidate: number | undefined,
    succeeded = false;
  try {
    const event = parsed.root;
    json.exact(event, [
      'format',
      'profileId',
      'batchId',
      'sequence',
      'previous',
      'reason',
      'savedAt',
      'changes',
    ]);
    const previous = ref(index, json.child(event, 'previous'));
    if (
      json.field(event, 'format') !== 'health-intake-batch-delta-v3' ||
      json.field(event, 'profileId') !== index.profileId ||
      json.field(event, 'batchId') !== id ||
      json.field(event, 'sequence') !== Number(name.slice(0, 12)) ||
      typeof json.field(event, 'reason') !== 'string' ||
      !Number.isFinite(Date.parse(json.field(event, 'savedAt'))) ||
      (previous === null
        ? !!state?.tail
        : previous.name !== state?.tail || previous.digest !== state?.digest)
    )
      invalid();
    candidate = state ? yield* json.cloneSteps(state.root) : undefined;
    candidate = yield* applyChanges(index, candidate, json.child(event, 'changes'));
    identity(index, 'batch', id, candidate);
    succeeded = true;
  } finally {
    if (succeeded) {
      if (candidate !== undefined) yield* json.dropSteps(candidate);
      yield* json.dropSteps(parsed.root);
    }
  }
}
function put(index: ActivityIndex, selected: Selected): void {
  const date = String(index.json.nullable(selected.root, 'updatedAt') ?? '');
  index.scratch.db
    .prepare('INSERT OR REPLACE INTO activity_journals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(
      selected.id,
      selected.kind,
      selected.root,
      selected.pin,
      selected.ordinal,
      selected.tail,
      selected.digest,
      selected.bytes,
      selected.legacyCount,
      selected.legacyDigest,
      selected.remaining,
      date,
    );
  if (selected.kind === 'batch') index.order.put(selected.id, date, selected.ordinal);
}
export function clearJournalActivityIndex(root: string, profileId?: string): void {
  for (const [key, index] of indexes)
    if (profileId ? key === scope(root, profileId) : key.startsWith(resolve(root) + '/')) {
      indexes.delete(key);
      index.scratch.close();
    }
}
export function forgetJournalActivityScope(profileRoot: string): void {
  const key = resolve(profileRoot),
    index = indexes.get(key);
  if (!index) return;
  indexes.delete(key);
  index.scratch.close();
}
/** Explicit cold/recovery phase. Nothing is readable until the complete selected
 * journal set validates; interruption discards the partial private projection. */
export async function prepareJournalActivity(
  root: string,
  profileId: string,
  options: { signal?: AbortSignal; assertRunning?: () => void; work?: JournalJsonWork } = {},
): Promise<void> {
  const assertRunning = () => {
    options.signal?.throwIfAborted();
    options.assertRunning?.();
    options.signal?.throwIfAborted();
  };
  assertRunning();
  const key = scope(root, profileId),
    existing = indexes.get(key);
  if (realpathSync(key) !== join(realpathSync(root), 'data', 'profiles', profileId)) invalid();
  if (existing?.ready) {
    let valid = false;
    try {
      journalActivityBinding(root, profileId);
      valid = true;
    } catch {
      clearJournalActivityIndex(root, profileId);
    }
    if (valid) {
      assertRunning();
      if (indexes.get(key) !== existing) pending();
      return;
    }
  } else if (existing) pending();
  const scratch = disposableSqlite('health-journal-activity-'),
    work = options.work ?? journalJsonWork(),
    index: ActivityIndex = {
      scratch,
      json: new JournalJsonIndex(scratch.db, work),
      order: new JournalActivityOrder(scratch.db),
      ready: false,
      profileId,
      root,
      work,
      containers: { chat: '', batch: '' },
    };
  scratch.db.exec(
    'CREATE TABLE activity_journals(id TEXT,kind TEXT,root INTEGER,pin TEXT,ordinal INTEGER,tail TEXT,digest TEXT,bytes INTEGER,legacyCount INTEGER,legacyDigest TEXT,remaining TEXT,updatedAt TEXT,PRIMARY KEY(kind,id)); CREATE TABLE activity_events(name TEXT PRIMARY KEY);',
  );
  const assertActive = () => {
    assertRunning();
    if (indexes.get(key) !== index) pending();
  };
  const cooperate = async <T>(steps: Generator<void, T>): Promise<T> => {
    try {
      for (;;) {
        assertActive();
        const next = steps.next();
        if (next.done) {
          assertActive();
          return next.value;
        }
        index.work.yields++;
        await setImmediate();
      }
    } finally {
      steps.return(undefined as never);
    }
  };
  indexes.set(key, index);
  try {
    index.containers = { chat: container(index, 'chat'), batch: container(index, 'batch') };
    let enumerated = 0;
    const enumerationCheckpoint = async () => {
      assertActive();
      if (++enumerated % 64 === 0) {
        index.work.yields++;
        await setImmediate();
        assertActive();
      }
    };
    let ordinal = 0;
    for (const kind of ['chat', 'batch'] as const) {
      const base = join(key, kind === 'chat' ? 'chats' : 'intake-batches');
      if (!existsSync(base)) continue;
      if (realpathSync(base) !== base) invalid();
      const ids = opendirSync(base);
      try {
        for (let entry = ids.readSync(); entry; entry = ids.readSync()) {
          await enumerationCheckpoint();
          if (!UUID.test(entry.name)) continue;
          const id = entry.name,
            directory = path(index, kind, id);
          if (!existsSync(directory)) continue;
          if (realpathSync(directory) !== directory) invalid();
          const selected = head(index, kind, id);
          scratch.db.exec('DELETE FROM activity_events');
          const files = opendirSync(directory);
          let entries = 0;
          try {
            for (let file = files.readSync(); file; file = files.readSync()) {
              await enumerationCheckpoint();
              if (kind === 'chat' && ++entries > 100_000)
                throw new HttpError(
                  413,
                  'CHAT_READ_LIMIT',
                  'Conversation history exceeds its aggregate read limit',
                );
              const valid =
                kind === 'chat'
                  ? CHAT_EVENT.test(file.name)
                  : BATCH_EVENT.test(file.name) && UUID.test(file.name.slice(13, -5));
              if (valid) {
                if (kind === 'chat' && !selected.value) invalid();
                scratch.db.prepare('INSERT INTO activity_events VALUES(?)').run(file.name);
              } else if (
                kind === 'chat'
                  ? file.name.endsWith('.json')
                  : file.name !== 'current' && !file.name.endsWith('.pending')
              )
                invalid();
            }
          } finally {
            files.closeSync();
          }
          let state: Selected | undefined;
          const remaining = kind === 'chat' ? chatDecodeBudget() : undefined,
            legacyHash = createHash('sha256');
          const tip = kind === 'chat' ? selected.value?.tail : selected.value?.tail?.name;
          for (const row of scratch.db
            .prepare('SELECT name FROM activity_events ORDER BY name')
            .iterate()) {
            assertActive();
            const name = String(row.name);
            if (selected.value && (!tip || Number(name.slice(0, 12)) > Number(tip.slice(0, 12)))) {
              if (
                kind === 'batch' &&
                Number(name.slice(0, 12)) !==
                  (state?.tail ? Number(state.tail.slice(0, 12)) : 0) + 1
              )
                invalid();
              if (kind === 'batch') await cooperate(validateOrphan(index, id, name, state));
              continue;
            }
            state = await cooperate(
              replay(index, kind, id, name, state, remaining, !!selected.value),
            );
            if (state.legacyCount === Number(name.slice(0, 12)))
              legacyHash.update(name).update(state.digest!);
            if (kind === 'chat' && state.bytes > 256 * 1024 * 1024 - 4096)
              throw new HttpError(
                413,
                'CHAT_READ_LIMIT',
                'Conversation history exceeds its aggregate read limit',
              );
            await setImmediate();
          }
          if (!state) {
            if (tip) invalid();
            continue;
          }
          if (state.legacyCount) state.legacyDigest = legacyHash.digest('hex');
          if (selected.value) {
            const value = selected.value;
            if (
              state.tail !== tip ||
              state.bytes !== value.usage.eventBytes ||
              (kind === 'chat'
                ? JSON.stringify(remaining) !== JSON.stringify(value.usage.remaining)
                : state.digest !== value.tail.digest ||
                  (state.legacyCount
                    ? value.legacy?.count !== state.legacyCount ||
                      value.legacy?.digest !== state.legacyDigest
                    : value.legacy !== null))
            )
              invalid();
          }
          state.pin = selected.pin;
          state.ordinal = ordinal++;
          put(index, state);
          if (head(index, kind, id).pin !== selected.pin) pending();
        }
      } finally {
        ids.closeSync();
      }
    }
    assertActive();
    activityBinding(index);
    assertActive();
    index.ready = true;
  } catch (error) {
    if (indexes.get(key) === index) indexes.delete(key);
    scratch.close();
    throw error;
  }
}
function current(root: string, profileId: string): ActivityIndex {
  const index = indexes.get(scope(root, profileId));
  if (!index?.ready) pending();
  return index;
}
function checked(index: ActivityIndex, row: Selected): void {
  if (head(index, row.kind, row.id).pin !== row.pin) pending();
}
/** Compact dependency binding, recomputed from selected small markers; never a
 * growing array of pins and never an implicit cold replay during a GET. */
export function journalActivityBinding(root: string, profileId: string): string {
  return activityBinding(current(root, profileId));
}
function activityBinding(index: ActivityIndex): string {
  const hash = createHash('sha256');
  for (const kind of ['chat', 'batch'] as const)
    if (container(index, kind) !== index.containers[kind]) pending();
  for (const row of index.scratch.db
    .prepare('SELECT * FROM activity_journals ORDER BY kind,id')
    .iterate()) {
    const selected = row as unknown as Selected;
    checked(index, selected);
    hash.update(JSON.stringify([selected.kind, selected.id, selected.pin]));
  }
  return hash.digest('hex');
}
export interface ChatActivityHeader {
  pin: string;
  status: unknown;
  context: { intakeId: unknown };
  reading: { status: unknown; reason: unknown } | null;
  conversionCheckpoint: {
    format: unknown;
    sessionId: unknown;
    profileId: unknown;
    intakeId: unknown;
    sourceHash: unknown;
    version: unknown;
    pendingCount: number | null;
    seenCount: number | null;
    distinctReads: unknown;
    pagesProcessed: unknown;
  };
}
export function readChatActivityHeader(
  root: string,
  profileId: string,
  id: string,
): ChatActivityHeader | null {
  if (!UUID.test(id)) throw new HttpError(404, 'CHAT_NOT_FOUND', 'Conversation not found');
  const index = current(root, profileId),
    selected = select(index, 'chat', id);
  if (!selected) {
    if (
      container(index, 'chat') !== index.containers.chat ||
      existsSync(join(path(index, 'chat', id), 'current'))
    )
      pending();
    return null;
  }
  checked(index, selected);
  const json = index.json,
    context = json.maybe(selected.root, 'context'),
    checkpoint = json.maybe(selected.root, 'conversionCheckpoint'),
    reading = json.maybe(selected.root, 'reading');
  const count = (field: string): number | null => {
    const value = checkpoint === undefined ? undefined : json.maybe(checkpoint, field);
    if (value === undefined) return null;
    const node = json.node(value);
    return node.kind === 'array' ? node.length : null;
  };
  return {
    pin: selected.pin,
    status: json.nullable(selected.root, 'status'),
    context: { intakeId: json.nullable(context, 'intakeId') },
    reading:
      reading === undefined || json.node(reading).kind === 'null'
        ? null
        : { status: json.nullable(reading, 'status'), reason: json.nullable(reading, 'reason') },
    conversionCheckpoint: {
      format: json.nullable(checkpoint, 'format'),
      sessionId: json.nullable(checkpoint, 'sessionId'),
      profileId: json.nullable(checkpoint, 'profileId'),
      intakeId: json.nullable(checkpoint, 'intakeId'),
      sourceHash: json.nullable(checkpoint, 'sourceHash'),
      version: json.nullable(checkpoint, 'version'),
      pendingCount: count('pending'),
      seenCount: count('seen'),
      distinctReads: json.nullable(checkpoint, 'distinctReads'),
      pagesProcessed: json.nullable(checkpoint, 'pagesProcessed'),
    },
  };
}
export interface IntakeBatchActivityHeader {
  pin: string;
  batchId: string;
  batchStatus: unknown;
  updatedAt: string;
  itemIndex: number;
  intakeId: string;
  sourceHash: unknown;
  status: unknown;
  reason: unknown;
  reading: { status: unknown; reason: unknown } | null;
}
export function* iterateIntakeBatchActivity(
  root: string,
  profileId: string,
): Generator<IntakeBatchActivityHeader> {
  const index = current(root, profileId),
    json = index.json;
  if (container(index, 'batch') !== index.containers.batch) pending();
  for (const id of index.order.ids()) {
    const selected = select(index, 'batch', id)!;
    checked(index, selected);
    const items = json.child(selected.root, 'items');
    for (let i = 0; i < json.node(items).length; i++) {
      const item = json.child(items, String(i)),
        reading = json.maybe(item, 'reading');
      yield {
        pin: selected.pin,
        batchId: selected.id,
        batchStatus: json.nullable(selected.root, 'status'),
        updatedAt: String(json.nullable(selected.root, 'updatedAt') ?? ''),
        itemIndex: i,
        intakeId: String(json.nullable(item, 'intakeId')),
        sourceHash: json.nullable(item, 'sourceHash'),
        status: json.nullable(item, 'status'),
        reason: json.nullable(item, 'reason'),
        reading:
          reading === undefined || json.node(reading).kind === 'null'
            ? null
            : {
                status: json.nullable(reading, 'status'),
                reason: json.nullable(reading, 'reason'),
              },
      };
    }
  }
}
/** Called only after the owning journal publishes its marker. Cache failure
 * invalidates the disposable projection and cannot change publication success. */
export function publishedJournalActivity(
  root: string,
  profileId: string,
  kind: Kind,
  id: string,
): void {
  const index = indexes.get(scope(root, profileId));
  if (!index?.ready) return;
  try {
    const before = select(index, kind, id),
      selected = head(index, kind, id),
      tip = kind === 'chat' ? selected.value?.tail : selected.value?.tail?.name;
    if (selected.pin === before?.pin) return;
    if (
      !tip ||
      Number(tip.slice(0, 12)) !== (before?.tail ? Number(before.tail.slice(0, 12)) : 0) + 1
    ) {
      clearJournalActivityIndex(root, profileId);
      return;
    }
    const remaining =
      kind === 'chat'
        ? before?.remaining
          ? (JSON.parse(before.remaining) as ChatDecodeBudget)
          : chatDecodeBudget()
        : undefined;
    const next = drainJournalWork(replay(index, kind, id, tip, before, remaining));
    if (
      next.bytes !== selected.value.usage.eventBytes ||
      (kind === 'chat'
        ? JSON.stringify(remaining) !== JSON.stringify(selected.value.usage.remaining)
        : next.digest !== selected.value.tail.digest)
    )
      invalid();
    next.pin = selected.pin;
    next.ordinal =
      before?.ordinal ??
      Number(index.scratch.db.prepare('SELECT count(*) AS n FROM activity_journals').get()!.n);
    next.legacyDigest = before?.legacyDigest ?? null;
    if (
      kind === 'batch' &&
      (next.legacyCount
        ? selected.value.legacy?.count !== next.legacyCount ||
          selected.value.legacy?.digest !== next.legacyDigest
        : selected.value.legacy !== null)
    )
      invalid();
    put(index, next);
    if (kind === 'batch' && !before) {
      // A new directory can change the filesystem's enumeration order (including
      // equal-date ties). Revisit only batch IDs, never their retained histories.
      const directory = opendirSync(join(scope(root, profileId), 'intake-batches'));
      try {
        let ordinal = 0;
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (!UUID.test(entry.name)) continue;
          const row = select(index, 'batch', entry.name);
          if (!row) continue;
          if (row.ordinal !== ordinal) {
            row.ordinal = ordinal;
            put(index, row);
          }
          ordinal++;
        }
      } finally {
        directory.closeSync();
      }
    }
    index.containers[kind] = container(index, kind);
  } catch {
    clearJournalActivityIndex(root, profileId);
  }
}
