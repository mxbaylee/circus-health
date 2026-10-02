import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type ArchiveInventoryEntry =
  | { path: string; kind: 'directory' }
  | { path: string; kind: 'file'; bytes: number; sha256: string };

export interface ArchiveSummary {
  files: number;
  bytes: number;
  treeHash: string;
}

export interface ArchiveInventory extends ArchiveSummary {
  entries: ArchiveInventoryEntry[];
}

const failure = () => new Error('Encrypted archive qualification failed.');

function rootPath(input: string): string {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw failure();
  const path = resolve(input);
  if (dirname(path) === path) throw failure();
  return path;
}

// Check every ancestor, including the root: a symlinked parent is also unsafe.
async function assertDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await assertDirectory(parent);
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure();
}

async function reserveDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

function contained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  await assertDirectory(dirname(path));
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw failure();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw failure();
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      hash.update(chunk);
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (
      bytes !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.ino !== opened.ino ||
      current.dev !== opened.dev ||
      !current.isFile() ||
      current.isSymbolicLink()
    )
      throw failure();
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function inventory(root: string): Promise<ArchiveInventory> {
  await assertDirectory(root);
  const entries: ArchiveInventoryEntry[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    await assertDirectory(directory);
    const before = await lstat(directory);
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\'))
        throw failure();
      const path = join(directory, name);
      if (!contained(root, path)) throw failure();
      const entryPath = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw failure();
      if (stat.isDirectory()) {
        entries.push({ path: entryPath, kind: 'directory' });
        await visit(path, entryPath);
      } else if (stat.isFile()) {
        entries.push({ path: entryPath, kind: 'file', ...(await hashFile(path)) });
      } else throw failure();
    }
    const after = await lstat(directory);
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.mtimeMs !== after.mtimeMs ||
      !after.isDirectory()
    )
      throw failure();
  }
  await visit(root, '');
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const fileEntries = entries.filter((entry) => entry.kind === 'file');
  return {
    entries,
    files: fileEntries.length,
    bytes: fileEntries.reduce((total, entry) => total + entry.bytes, 0),
    treeHash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  };
}

/** Content-free byte inventory. This does not make a live writer consistent. */
export async function inventoryArchive(root: string): Promise<ArchiveInventory> {
  try {
    return await inventory(rootPath(root));
  } catch {
    throw failure();
  }
}

export async function assertArchiveInventory(
  root: string,
  expected: ArchiveInventory,
): Promise<ArchiveSummary> {
  try {
    const actual = await inventory(rootPath(root));
    if (
      actual.files !== expected.files ||
      actual.bytes !== expected.bytes ||
      actual.treeHash !== expected.treeHash ||
      JSON.stringify(actual.entries) !== JSON.stringify(expected.entries)
    )
      throw failure();
    return { files: actual.files, bytes: actual.bytes, treeHash: actual.treeHash };
  } catch {
    throw failure();
  }
}

/**
 * Qualification only: the caller must stop the writer and check project/leases first.
 * The destination parent must already exist. Failure leaves any partial copy intact.
 */
export async function copyArchiveForDrill(
  source: string,
  destination: string,
): Promise<ArchiveInventory> {
  try {
    const sourceRoot = rootPath(source);
    const destinationRoot = rootPath(destination);
    if (contained(sourceRoot, destinationRoot) || contained(destinationRoot, sourceRoot))
      throw failure();
    await assertDirectory(dirname(destinationRoot));
    const expected = await inventory(sourceRoot);
    // Atomic reservation; existing destinations, including empty ones, are refused.
    await reserveDirectory(destinationRoot);
    for (const entry of expected.entries) {
      const target = join(destinationRoot, ...entry.path.split('/'));
      if (!contained(destinationRoot, target)) throw failure();
      await assertDirectory(dirname(target));
      if (entry.kind === 'directory') {
        await reserveDirectory(target);
        continue;
      }
      const original = join(sourceRoot, ...entry.path.split('/'));
      await assertDirectory(dirname(original));
      const input = await open(
        original,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        if (!(await input.stat()).isFile()) throw failure();
        const output = await open(
          target,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await output.chmod(0o600);
          for await (const chunk of input.createReadStream({ autoClose: false })) {
            let offset = 0;
            while (offset < chunk.length) {
              const written = await output.write(chunk, offset, chunk.length - offset);
              if (!written.bytesWritten) throw failure();
              offset += written.bytesWritten;
            }
          }
          await output.sync();
        } finally {
          await output.close();
        }
      } finally {
        await input.close();
      }
    }
    await assertArchiveInventory(destinationRoot, expected);
    await assertArchiveInventory(sourceRoot, expected);
    return expected;
  } catch {
    throw failure();
  }
}
