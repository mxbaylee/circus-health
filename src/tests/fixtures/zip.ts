import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipFixtureEntry {
  name: string;
  data: string | Buffer;
  mode?: number;
  encrypted?: boolean;
  checksum?: number;
}

// Test-only ZIP writer deliberately accepts unsafe names, duplicate entries,
// symlinks, and corrupt CRC values to exercise the production reader's guards.
export function zipFixture(
  entries: ZipFixtureEntry[],
  { store = false } = {},
): Buffer<ArrayBuffer> {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      bytes = Buffer.from(entry.data);
    const compressed = store ? bytes : deflateRawSync(bytes);
    const checksum = entry.checksum ?? crc32(bytes);
    const flags = (/[^\x00-\x7f]/.test(entry.name) ? 0x800 : 0) | (entry.encrypted ? 1 : 0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(store ? 0 : 8, 8);
    header.writeUInt16LE(((2026 - 1980) << 9) | (1 << 5) | 1, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x314, 4);
    header.copy(directory, 6, 4, 30);
    directory.writeUInt32LE(((entry.mode ?? 0o100600) * 65536) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    locals.push(header, name, compressed);
    central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const directoryBytes = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directoryBytes, end]);
}
