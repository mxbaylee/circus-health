import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './database.ts';
import { profilePaths } from './profile-storage.ts';
import type { IntakeBatch } from '../shared/intake-batch.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT = /^\d{12}-[0-9a-f-]{36}\.json$/;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function batchDirectory(root: string, profileId: string, batchId: string, create = false): string {
  if (!UUID.test(batchId))
    throw new HttpError(404, 'INTAKE_BATCH_NOT_FOUND', 'Reading batch not found');
  const base = realpathSync(profilePaths(root, profileId).root);
  let directory = base;
  for (const segment of ['intake-batches', batchId, 'events']) {
    directory = join(directory, segment);
    if (!existsSync(directory)) {
      if (!create) throw new HttpError(404, 'INTAKE_BATCH_NOT_FOUND', 'Reading batch not found');
      mkdirSync(directory, { mode: 0o700 });
    }
    if (realpathSync(directory) !== directory)
      throw new Error('Reading batch path escaped its profile');
  }
  return directory;
}

export function readIntakeBatch(root: string, profileId: string, batchId: string): IntakeBatch {
  const directory = batchDirectory(root, profileId, batchId);
  const events = readdirSync(directory)
    .filter((name) => EVENT.test(name))
    .sort();
  if (!events.length) throw new HttpError(404, 'INTAKE_BATCH_NOT_FOUND', 'Reading batch not found');
  let batch: IntakeBatch | undefined;
  for (const name of events) {
    const file = join(directory, name);
    if (realpathSync(file) !== file) throw Error('Reading batch journal cannot be a link');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.profileId !== profileId) throw Error('Reading batch journal profile mismatch');
    if (saved.format === 'health-intake-batch-v1' && saved.batch?.id === batchId)
      batch = saved.batch;
    else if (
      saved.format === 'health-intake-batch-delta-v2' &&
      saved.batchId === batchId &&
      batch
    ) {
      for (const [path, value] of saved.changes as [string[], unknown][]) {
        let target = batch as unknown as Record<string, unknown>;
        if (path.some((key) => ['__proto__', 'constructor', 'prototype'].includes(key)))
          throw Error('Invalid batch delta');
        for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
        target[path.at(-1)!] = value;
      }
      for (const path of saved.removed as string[][]) {
        if (path.some((key) => ['__proto__', 'constructor', 'prototype'].includes(key)))
          throw Error('Invalid batch delta');
        let target = batch as unknown as Record<string, unknown>;
        for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
        delete target[path.at(-1)!];
      }
    } else throw Error('Reading batch journal profile mismatch');
  }
  if (!batch || batch.profileId !== profileId)
    throw Error('Reading batch journal profile mismatch');
  return batch;
}

export function listIntakeBatches(root: string, profileId: string): IntakeBatch[] {
  const directory = join(profilePaths(root, profileId).root, 'intake-batches');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((id) => UUID.test(id))
    .map((id) => readIntakeBatch(root, profileId, id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function writeIntakeBatch(
  root: string,
  profileId: string,
  batch: IntakeBatch,
  reason: string,
): void {
  const directory = batchDirectory(root, profileId, batch.id, true);
  const names = readdirSync(directory)
    .filter((name) => EVENT.test(name))
    .sort();
  const sequence = names.length ? Number(names.at(-1)!.slice(0, 12)) + 1 : 1;
  const file = join(directory, `${String(sequence).padStart(12, '0')}-${randomUUID()}.json`);
  const previous = names.length ? readIntakeBatch(root, profileId, batch.id) : null;
  const changes: [string[], unknown][] = [],
    removed: string[][] = [];
  const diff = (before: unknown, after: unknown, path: string[]) => {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    if (
      before &&
      after &&
      typeof before === 'object' &&
      typeof after === 'object' &&
      Array.isArray(before) === Array.isArray(after)
    ) {
      const a = before as Record<string, unknown>,
        b = after as Record<string, unknown>;
      for (const key of Object.keys(a)) if (!(key in b)) removed.push([...path, key]);
      for (const key of Object.keys(b)) diff(a[key], b[key], [...path, key]);
      if (Array.isArray(after) && Array.isArray(before) && after.length !== before.length)
        changes.push([[...path, 'length'], after.length]);
    } else if (after !== undefined) changes.push([path, after]);
  };
  if (previous) diff(previous, batch, []);
  const temporary = file + '.pending';
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(
      fd,
      JSON.stringify({
        ...(previous
          ? { format: 'health-intake-batch-delta-v2', batchId: batch.id, changes, removed }
          : { format: 'health-intake-batch-v1', batch }),
        profileId,
        sequence,
        reason,
        savedAt: new Date().toISOString(),
      }),
    );
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

export function copyIntakeBatchJournals(
  root: string,
  profileId: string,
  targetRoot: string,
): string[] {
  const copied: string[] = [];
  for (const batch of listIntakeBatches(root, profileId)) {
    const directory = batchDirectory(root, profileId, batch.id);
    for (const name of readdirSync(directory)
      .filter((item) => EVENT.test(item))
      .sort()) {
      const source = join(directory, name);
      if (realpathSync(source) !== source)
        throw new Error('Reading batch journal cannot be a symbolic link');
      const value: unknown = JSON.parse(readFileSync(source, 'utf8'));
      if (
        !object(value) ||
        value.profileId !== profileId ||
        !(
          (value.format === 'health-intake-batch-v1' &&
            object(value.batch) &&
            value.batch.id === batch.id) ||
          (value.format === 'health-intake-batch-delta-v2' && value.batchId === batch.id)
        )
      )
        throw new Error('Reading batch journal profile mismatch');
      const path = `${profilePaths(root, profileId).relativeRoot}/intake-batches/${batch.id}/events/${name}`;
      const target = resolve(targetRoot, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(source, target);
      copied.push(path);
    }
  }
  return copied;
}
