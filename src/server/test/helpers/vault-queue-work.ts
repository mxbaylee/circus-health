import fs from 'node:fs';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

const empty = () => ({
  opens: 0,
  stats: 0,
  metadataChecks: 0,
  syncs: 0,
  mutations: 0,
  directoryReads: 0,
  directoryEntries: 0,
  reads: 0,
  readBytes: 0,
  writes: 0,
  writeBytes: 0,
});

/** Independent observation of real synchronous I/O. Classification uses actual
 * paths/fds, never journal/vault counters or reconstructed index metadata. */
export function observeVaultQueueWork<T>(run: () => T) {
  const work = {
    queue: empty(),
    otherWorkspace: empty(),
    objects: empty(),
    indices: empty(),
    manifest: empty(),
    other: empty(),
    sha256Bytes: 0,
  };
  const files = new Map<number, string>();
  const classify = (input: unknown) => {
    const path = typeof input === 'number' ? (files.get(input) ?? '') : String(input);
    if (path.includes('/intake-batches/')) return work.queue;
    if (path.includes('/vault/objects/')) return work.objects;
    if (path.includes('/vault/indices/')) return work.indices;
    if (path.includes('/vault/manifest.enc')) return work.manifest;
    if (path.includes('/data/profiles/')) return work.otherWorkspace;
    return work.other;
  };
  const originals = new Map<string, unknown>();
  const instrument = (name: string, wrap: (original: any) => any) => {
    const target = fs as unknown as Record<string, any>;
    originals.set(name, target[name]);
    target[name] = wrap(target[name]);
  };
  let readingFile = 0;
  let writingFile = 0;
  instrument('openSync', (original) => (...args: any[]) => {
    const fd = original(...args);
    files.set(fd, String(args[0]));
    classify(args[0]).opens++;
    return fd;
  });
  instrument('closeSync', (original) => (fd: number) => {
    try {
      return original(fd);
    } finally {
      files.delete(fd);
    }
  });
  for (const method of ['statSync', 'lstatSync', 'fstatSync'])
    instrument(method, (original) => (...args: any[]) => {
      classify(args[0]).stats++;
      return original(...args);
    });
  instrument('existsSync', (original) => (...args: any[]) => {
    classify(args[0]).metadataChecks++;
    return original(...args);
  });
  instrument('realpathSync', (original) => {
    const observed = (...args: any[]) => {
      classify(args[0]).metadataChecks++;
      return original(...args);
    };
    observed.native = (...args: any[]) => {
      classify(args[0]).metadataChecks++;
      return original.native(...args);
    };
    return observed;
  });
  instrument('fsyncSync', (original) => (...args: any[]) => {
    classify(args[0]).syncs++;
    return original(...args);
  });
  for (const method of ['mkdirSync', 'renameSync', 'linkSync', 'unlinkSync', 'rmSync'])
    instrument(method, (original) => (...args: any[]) => {
      classify(args[0]).mutations++;
      return original(...args);
    });
  instrument('readdirSync', (original) => (...args: any[]) => {
    const result = original(...args);
    const counters = classify(args[0]);
    counters.directoryReads++;
    counters.directoryEntries += result.length;
    return result;
  });
  instrument('opendirSync', (original) => (...args: any[]) => {
    const counters = classify(args[0]);
    counters.directoryReads++;
    const dir = original(...args);
    const read = dir.readSync.bind(dir);
    dir.readSync = () => {
      const entry = read();
      if (entry) counters.directoryEntries++;
      return entry;
    };
    return dir;
  });
  instrument('readSync', (original) => (...args: any[]) => {
    const bytes = original(...args);
    if (!readingFile) {
      const counters = classify(args[0]);
      counters.reads++;
      counters.readBytes += bytes;
    }
    return bytes;
  });
  instrument('readFileSync', (original) => (...args: any[]) => {
    readingFile++;
    try {
      const bytes = original(...args);
      const counters = classify(args[0]);
      counters.reads++;
      counters.readBytes += Buffer.byteLength(bytes);
      return bytes;
    } finally {
      readingFile--;
    }
  });
  instrument('writeSync', (original) => (...args: any[]) => {
    const bytes = original(...args);
    if (!writingFile) {
      const counters = classify(args[0]);
      counters.writes++;
      counters.writeBytes += bytes;
    }
    return bytes;
  });
  instrument('writeFileSync', (original) => (...args: any[]) => {
    writingFile++;
    try {
      const result = original(...args);
      const counters = classify(args[0]);
      counters.writes++;
      counters.writeBytes += Buffer.byteLength(args[1]);
      return result;
    } finally {
      writingFile--;
    }
  });
  const originalHash = crypto.createHash;
  crypto.createHash = ((...args: Parameters<typeof originalHash>) => {
    const hash = originalHash(...args);
    if (args[0] === 'sha256') {
      const update = hash.update.bind(hash);
      hash.update = ((data: string | Buffer, encoding?: BufferEncoding) => {
        work.sha256Bytes +=
          typeof data === 'string' ? Buffer.byteLength(data, encoding) : data.byteLength;
        return typeof data === 'string' ? update(data, encoding ?? 'utf8') : update(data);
      }) as typeof hash.update;
    }
    return hash;
  }) as typeof originalHash;
  syncBuiltinESMExports();
  try {
    return { value: run(), work };
  } finally {
    for (const [name, value] of originals) (fs as unknown as Record<string, unknown>)[name] = value;
    crypto.createHash = originalHash;
    syncBuiltinESMExports();
  }
}
