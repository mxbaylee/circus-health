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

interface SavedBatchEnvelope {
  format: 'health-intake-batch-v1';
  profileId: string;
  batch: IntakeBatch;
}

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
  const file = join(directory, events.at(-1)!);
  if (realpathSync(file) !== file) throw new Error('Reading batch journal cannot be a link');
  const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (
    !object(saved) ||
    saved.format !== 'health-intake-batch-v1' ||
    saved.profileId !== profileId ||
    !object(saved.batch) ||
    saved.batch.id !== batchId
  )
    throw new Error('Reading batch journal profile mismatch');
  return (saved as unknown as SavedBatchEnvelope).batch;
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
  const temporary = file + '.pending';
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(
      fd,
      JSON.stringify({
        format: 'health-intake-batch-v1',
        profileId,
        sequence,
        reason,
        savedAt: new Date().toISOString(),
        batch,
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
        !object(value.batch) ||
        value.batch.id !== batch.id ||
        value.format !== 'health-intake-batch-v1'
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
