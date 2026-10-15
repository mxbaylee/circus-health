import type { Readable, Writable } from 'node:stream';

export const PACKAGE_PROTOCOL_FRAME_BYTES = 32 * 1024;
// One central entry has 16-bit raw name/extra lengths. This bounds one encoded
// declaration (including JSON escaping), not total archive metadata or names.
export const PACKAGE_PROTOCOL_RECORD_BYTES = 1024 * 1024;
export interface PackageSourceBinding {
  profileId: string;
  intakeId: string;
  sourceHash: string;
  bytes: number;
}
export interface PackageCentralDescriptor {
  centralOrdinal: number;
  ordinal: number | null;
  filename: string;
  rawName: string;
  directory: boolean;
  localHeaderOffset: number;
  compressedBytes: number;
  bytes: number;
  compression: 0 | 8;
  flags: number;
  crc32: number;
  externalAttributes: number;
}
export interface VerifiedPackageDescriptor extends PackageCentralDescriptor {
  ordinal: number;
  sourceHash: string;
  duplicateOrdinal: number | null;
}
export interface PackageTraversalWork {
  centralDeclarations: number;
  descriptorReads: number;
  memberReadBytes: number;
  hashBytes: number;
  crcBytes: number;
  writtenBytes: number;
  peakChunkBytes: number;
  membersVerified: number;
  membersReused: number;
  reusedPayloadBytes: number;
}
export const emptyPackageTraversalWork = (): PackageTraversalWork => ({
  centralDeclarations: 0,
  descriptorReads: 0,
  memberReadBytes: 0,
  hashBytes: 0,
  crcBytes: 0,
  writtenBytes: 0,
  peakChunkBytes: 0,
  membersVerified: 0,
  membersReused: 0,
  reusedPayloadBytes: 0,
});
export interface PackageTraversalSummary {
  entries: number;
  members: number;
  expandedBytes: number;
}
export function safePackageFilename(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/[\\:\x00-\x1f\x7f]/.test(value) &&
    !value.startsWith('/') &&
    !value
      .replace(/\/$/, '')
      .split('/')
      .some((p) => ['', '.', '..'].includes(p))
  );
}
export function validPackageDescriptor(value: unknown): value is PackageCentralDescriptor {
  if (!value || typeof value !== 'object') return false;
  const d = value as PackageCentralDescriptor;
  const integer = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  if (
    !integer(d.centralOrdinal) ||
    !(d.ordinal === null || integer(d.ordinal)) ||
    !safePackageFilename(d.filename) ||
    typeof d.rawName !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(d.rawName) ||
    !integer(d.localHeaderOffset) ||
    !integer(d.compressedBytes) ||
    !integer(d.bytes) ||
    ![0, 8].includes(d.compression) ||
    !integer(d.flags) ||
    d.flags > 0xffff ||
    d.flags & 1 ||
    !integer(d.crc32) ||
    d.crc32 > 0xffffffff ||
    !integer(d.externalAttributes) ||
    d.externalAttributes > 0xffffffff ||
    typeof d.directory !== 'boolean' ||
    d.directory !== d.filename.endsWith('/') ||
    d.directory !== (d.ordinal === null) ||
    (d.directory && d.bytes !== 0)
  )
    return false;
  const raw = Buffer.from(d.rawName, 'base64');
  const mode = (d.externalAttributes >>> 16) & 0o170000;
  return (
    raw.length > 0 &&
    raw.length <= 0xffff &&
    !raw.some((b) => b < 32 || b === 127) &&
    (!mode || mode === 0o100000 || mode === 0o040000)
  );
}
/** One bounded transport frame is outstanding. The receiver additionally ACKs
 * declaration/member consumption before the producer advances its iterator. */
export async function writePackageRecord(output: Writable, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > PACKAGE_PROTOCOL_RECORD_BYTES) throw Error('PACKAGE_PROTOCOL');
  for (let offset = 0; offset < bytes.length; offset += 12 * 1024) {
    const piece = bytes.subarray(offset, offset + 12 * 1024);
    const frame =
      JSON.stringify({
        part: piece.toString('base64'),
        last: offset + piece.length === bytes.length,
      }) + '\n';
    await new Promise<void>((resolve, reject) => {
      output.write(frame, (error) => (error ? reject(error) : resolve()));
    });
  }
}
export async function* readPackageRecords(
  input: Readable,
): AsyncGenerator<Record<string, unknown>> {
  let frame = Buffer.alloc(0),
    record: Buffer[] = [],
    recordBytes = 0;
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset);
      const piece = chunk.subarray(offset, end < 0 ? chunk.length : end);
      if (frame.length + piece.length > PACKAGE_PROTOCOL_FRAME_BYTES)
        throw Error('PACKAGE_PROTOCOL');
      frame = frame.length ? Buffer.concat([frame, piece]) : Buffer.from(piece);
      if (end < 0) break;
      const part = JSON.parse(frame.toString('utf8')) as { part?: unknown; last?: unknown };
      frame = Buffer.alloc(0);
      if (
        typeof part.part !== 'string' ||
        typeof part.last !== 'boolean' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.part)
      )
        throw Error('PACKAGE_PROTOCOL');
      const bytes = Buffer.from(part.part, 'base64');
      if (!bytes.length || bytes.length > 12 * 1024 || (!part.last && bytes.length !== 12 * 1024))
        throw Error('PACKAGE_PROTOCOL');
      recordBytes += bytes.length;
      if (recordBytes > PACKAGE_PROTOCOL_RECORD_BYTES) throw Error('PACKAGE_PROTOCOL');
      record.push(bytes);
      offset = end + 1;
      if (part.last) {
        const result: unknown = JSON.parse(Buffer.concat(record, recordBytes).toString('utf8'));
        record = [];
        recordBytes = 0;
        if (!result || typeof result !== 'object' || Array.isArray(result))
          throw Error('PACKAGE_PROTOCOL');
        yield result as Record<string, unknown>;
      }
    }
  }
  if (frame.length || recordBytes) throw Error('PACKAGE_PROTOCOL');
}
