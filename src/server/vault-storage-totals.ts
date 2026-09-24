import type { VaultMetadata } from './vault-store.ts';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
const categories = [
  ['sources', 'Source files'],
  ['attachments', 'Attachments'],
  ['chats', 'Conversations'],
  ['intake-batches', 'Reading batches'],
  ['fileHistory', 'Retained file versions'],
  ['records', 'Record history'],
  ['indexes', 'File indexes'],
  ['cache', 'Encrypted SQLite cache'],
  ['metadata', 'Profile metadata'],
];
function files(root: string) {
  const result: Array<{ path: string; bytes: number }> = [];
  if (!existsSync(root)) return result;
  function visit(path: string) {
    const s = lstatSync(path);
    if (s.isSymbolicLink()) throw Error('Storage cannot contain symbolic links');
    if (s.isDirectory()) for (const name of readdirSync(path)) visit(resolve(path, name));
    else if (s.isFile()) result.push({ path: relative(root, path), bytes: s.size });
  }
  visit(root);
  return result;
}
/** Stored ciphertext bytes are counted once, independently of reference count. */
export function vaultStorageTotals(
  directory: string,
  metadata: VaultMetadata,
  runtimeRoot: string,
) {
  const byObject = new Map<string, string>();
  for (const [name, id] of Object.entries(metadata.files)) {
    const category = name.startsWith('sources/')
      ? 'sources'
      : name.startsWith('attachments/')
        ? 'attachments'
        : name.startsWith('chats/')
          ? 'chats'
          : name.startsWith('intake-batches/')
            ? 'intake-batches'
            : 'metadata';
    // An original attached in two places remains one physical source object.
    const previous = byObject.get(id);
    if (
      !previous ||
      categories.findIndex(([key]) => key === category) <
        categories.findIndex(([key]) => key === previous)
    )
      byObject.set(id, category);
  }
  const breakdown = categories.map(([id, label]) => ({ id, label, bytes: 0, files: 0 }));
  for (const file of files(directory)) {
    const object = file.path.match(/^vault\/objects\/([0-9a-f-]+)\.enc$/);
    const kind = object
      ? byObject.get(object[1]) || 'fileHistory'
      : file.path.startsWith('vault/versions/')
        ? 'records'
        : file.path.startsWith('vault/indices/')
          ? 'indexes'
          : file.path.startsWith('cache/')
            ? 'cache'
            : 'metadata';
    const row = breakdown.find((row) => row.id === kind)!;
    row.bytes += file.bytes;
    row.files++;
  }
  return {
    storedBytes: breakdown.reduce((n, row) => n + row.bytes, 0),
    breakdown,
    runtimeBytes: files(runtimeRoot).reduce((n, file) => n + file.bytes, 0),
    notes: [
      'Totals count encrypted files once, even when several records reference them.',
      'Runtime files are temporary decrypted working copies and are shown separately.',
      'Archive-level backups and external copies are not part of this profile total.',
    ],
  };
}
