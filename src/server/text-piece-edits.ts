import { createHash } from 'node:crypto';

/** Pure plans, not a storage or recovery authority. All offsets are UTF-16 units. */
export const TEXT_PIECE_LIMITS = Object.freeze({
  maxContentBytes: 4096,
  maxRowBytes: 32768,
  maxHeadBytes: 1024,
  maxPieces: 100000,
  maxRetainedContentRows: 100000,
  maxRetainedContentBytes: 67108864,
  maxOperations: 1000,
  maxTextUtf16Units: 16777216,
  maxTextBytes: 33554432,
  maxScanSteps: 2000000,
  maxValidationUtf16Units: 134217728,
  maxReconstructionUtf16Units: 67108864,
  maxHashBytes: 268435456,
  maxCopiedUtf16Units: 134217728,
  maxCopiedBytes: 268435456,
  maxExistingContentReadBytes: 134217728,
  maxPlanBytes: 67108864,
});
export type TextPieceLimits = { -readonly [K in keyof typeof TEXT_PIECE_LIMITS]: number };
export interface TextPieceContent {
  readonly id: string;
  readonly text: string;
}
export interface TextPieceOccurrence {
  readonly id: string;
  readonly contentId: string;
  readonly start: number;
  readonly end: number;
}
export interface TextPieceLink {
  readonly id: string;
  readonly next: string | null;
}
export interface TextPieceHead {
  readonly format: 'text-pieces-v1';
  readonly sequenceId: string;
  readonly revision: number;
  readonly first: string | null;
  readonly pieces: number;
  readonly utf16Length: number;
  readonly utf8Bytes: number;
  readonly digest: string;
  readonly topologyDigest: string;
  readonly nextOrdinal: number;
}
export interface TextPieceSnapshot {
  readonly head: TextPieceHead;
  readonly contents: ReadonlyMap<string, TextPieceContent>;
  readonly occurrences: ReadonlyMap<string, TextPieceOccurrence>;
  readonly links: ReadonlyMap<string, TextPieceLink>;
}
export type TextPieceEdit =
  | {
      readonly kind: 'splice';
      readonly at: number;
      readonly deleteCount: number;
      readonly insert: string;
    }
  | { readonly kind: 'move'; readonly from: number; readonly length: number; readonly to: number };
export interface TextPieceMetrics {
  contentRowsWritten: number;
  contentBytesWritten: number;
  occurrenceRowsWritten: number;
  occurrenceBytesWritten: number;
  linkRowsWritten: number;
  linkBytesWritten: number;
  occurrenceRowsDeleted: number;
  occurrenceBytesDeleted: number;
  linkRowsDeleted: number;
  linkBytesDeleted: number;
  headBytesWritten: number;
  existingContentReads: number;
  existingContentReadBytes: number;
  existingOccurrenceReads: number;
  existingLinkReads: number;
  validatedRows: number;
  validationUtf16Units: number;
  scanSteps: number;
  reconstructionUtf16Units: number;
  reconstructionBytes: number;
  hashBytes: number;
  copiedUtf16Units: number;
  copiedBytes: number;
  comparisonUtf16Units: number;
  utf8EncodedBytes: number;
  operations: number;
}
export interface TextPiecePlan {
  readonly expectedHead: TextPieceHead | null;
  readonly head: TextPieceHead;
  readonly contentWrites: readonly TextPieceContent[];
  readonly occurrenceWrites: readonly TextPieceOccurrence[];
  readonly linkWrites: readonly TextPieceLink[];
  readonly occurrenceDeletes: readonly string[];
  readonly linkDeletes: readonly string[];
  readonly metrics: Readonly<TextPieceMetrics>;
}
export class TextPieceError extends Error {
  readonly code: 'invalid' | 'limit' | 'mismatch';
  constructor(code: 'invalid' | 'limit' | 'mismatch', message: string) {
    super(`Text pieces ${code}: ${message}`);
    this.name = 'TextPieceError';
    this.code = code;
  }
}
function invalid(message: string): never {
  throw new TextPieceError('invalid', message);
}
function mismatch(message: string): never {
  throw new TextPieceError('mismatch', message);
}
function bound(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new TextPieceError('limit', name);
}
function natural(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(name);
}
function exact(
  value: unknown,
  keys: readonly string[],
  name: string,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    invalid(`${name} object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    keys.some(
      (key) =>
        !Object.hasOwn(descriptors, key) ||
        !Object.hasOwn(descriptors[key], 'value') ||
        !descriptors[key].enumerable,
    )
  )
    invalid(`${name} fields`);
}
const HEAD_KEYS = [
  'format',
  'sequenceId',
  'revision',
  'first',
  'pieces',
  'utf16Length',
  'utf8Bytes',
  'digest',
  'topologyDigest',
  'nextOrdinal',
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
function sequence(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value))
    invalid('sequence identity must be a lowercase UUIDv4');
}
function digestId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !DIGEST.test(value)) invalid('content digest identity');
}
function occurrenceId(value: unknown, head: TextPieceHead): asserts value is string {
  if (typeof value !== 'string' || value.length > 53 || !value.startsWith(`${head.sequenceId}:`))
    invalid('occurrence identity scope');
  const suffix = value.slice(37);
  if (!/^(0|[1-9][0-9]{0,15})$/.test(suffix)) invalid('occurrence identity ordinal');
  const ordinal = Number(suffix);
  if (!Number.isSafeInteger(ordinal) || ordinal >= head.nextOrdinal)
    invalid('occurrence identity nextOrdinal');
}
function headShape(value: unknown): asserts value is TextPieceHead {
  exact(value, HEAD_KEYS, 'head');
  if (value.format !== 'text-pieces-v1') invalid('head format');
  sequence(value.sequenceId);
  for (const key of ['revision', 'pieces', 'utf16Length', 'utf8Bytes', 'nextOrdinal'])
    natural(value[key], `head ${key}`);
  digestId(value.digest);
  digestId(value.topologyDigest);
  if (value.first !== null) occurrenceId(value.first, value as unknown as TextPieceHead);
}
function mapShape(value: unknown, name: string): asserts value is Map<string, unknown> {
  if (
    !(value instanceof Map) ||
    Object.getPrototypeOf(value) !== Map.prototype ||
    Reflect.ownKeys(value).length
  )
    invalid(`${name} must be an ordinary Map`);
}
function limitsFor(input?: Partial<TextPieceLimits>): TextPieceLimits {
  const result: TextPieceLimits = { ...TEXT_PIECE_LIMITS };
  if (input === undefined) return result;
  if (
    !input ||
    typeof input !== 'object' ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  )
    invalid('limits object');
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !Object.hasOwn(result, key)) invalid('unknown limit');
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    const name = key as keyof TextPieceLimits;
    if (!Object.hasOwn(descriptor, 'value')) invalid('limit accessor');
    const value: unknown = descriptor.value;
    natural(value, name);
    if (
      value > TEXT_PIECE_LIMITS[name] ||
      (['maxContentBytes', 'maxRowBytes', 'maxHeadBytes'].includes(name) && value === 0)
    )
      invalid(`limit ${name} may only be lowered to a supported value`);
    result[name] = value;
  }
  return result;
}
function freshMetrics(): TextPieceMetrics {
  return {
    contentRowsWritten: 0,
    contentBytesWritten: 0,
    occurrenceRowsWritten: 0,
    occurrenceBytesWritten: 0,
    linkRowsWritten: 0,
    linkBytesWritten: 0,
    occurrenceRowsDeleted: 0,
    occurrenceBytesDeleted: 0,
    linkRowsDeleted: 0,
    linkBytesDeleted: 0,
    headBytesWritten: 0,
    existingContentReads: 0,
    existingContentReadBytes: 0,
    existingOccurrenceReads: 0,
    existingLinkReads: 0,
    validatedRows: 0,
    validationUtf16Units: 0,
    scanSteps: 0,
    reconstructionUtf16Units: 0,
    reconstructionBytes: 0,
    hashBytes: 0,
    copiedUtf16Units: 0,
    copiedBytes: 0,
    comparisonUtf16Units: 0,
    utf8EncodedBytes: 0,
    operations: 0,
  };
}
class Work {
  readonly limits: TextPieceLimits;
  readonly metrics = freshMetrics();
  constructor(limits?: Partial<TextPieceLimits>) {
    this.limits = limitsFor(limits);
  }
  scan(count: number) {
    this.metrics.scanSteps += count;
    bound(this.metrics.scanSteps, this.limits.maxScanSteps, 'scan steps');
  }
  validateText(text: unknown, maximum = this.limits.maxTextUtf16Units): void {
    if (typeof text !== 'string') invalid('text must be a string');
    bound(text.length, maximum, 'text UTF-16 units');
    this.metrics.validationUtf16Units += text.length;
    bound(
      this.metrics.validationUtf16Units,
      this.limits.maxValidationUtf16Units,
      'validation UTF-16 units',
    );
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = text.charCodeAt(++i);
        if (!(low >= 0xdc00 && low <= 0xdfff)) invalid('raw unpaired surrogate');
      } else if (code >= 0xdc00 && code <= 0xdfff) invalid('raw unpaired surrogate');
    }
  }
  copy(units: number, bytes: number) {
    this.metrics.copiedUtf16Units += units;
    this.metrics.copiedBytes += bytes;
    bound(this.metrics.copiedUtf16Units, this.limits.maxCopiedUtf16Units, 'copied UTF-16 units');
    bound(this.metrics.copiedBytes, this.limits.maxCopiedBytes, 'copied bytes');
  }
  encode(text: string): Buffer {
    const bytes = Buffer.byteLength(text, 'utf8');
    this.copy(0, bytes);
    this.metrics.utf8EncodedBytes += bytes;
    return Buffer.from(text, 'utf8');
  }
  hash(text: string): string {
    const bytes = Buffer.byteLength(text, 'utf8');
    this.metrics.hashBytes += bytes;
    bound(this.metrics.hashBytes, this.limits.maxHashBytes, 'hash bytes');
    return createHash('sha256').update(this.encode(text)).digest('hex');
  }
  serialize(row: object | string, maximum = this.limits.maxRowBytes): string {
    // All callers preflight row fields/lengths before serializing.
    const text = JSON.stringify(row);
    const bytes = Buffer.byteLength(text, 'utf8');
    bound(bytes, maximum, 'serialized row bytes');
    this.copy(text.length, bytes);
    return text;
  }
  rowBytes(row: object | string, maximum = this.limits.maxRowBytes): number {
    return Buffer.byteLength(this.serialize(row, maximum));
  }
}
function scalarBoundary(text: string, offset: number): void {
  if (offset <= 0 || offset >= text.length) return;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
    invalid('unsafe scalar boundary');
}
function canonicalHead(head: TextPieceHead): TextPieceHead {
  return Object.freeze({
    format: head.format,
    sequenceId: head.sequenceId,
    revision: head.revision,
    first: head.first,
    pieces: head.pieces,
    utf16Length: head.utf16Length,
    utf8Bytes: head.utf8Bytes,
    digest: head.digest,
    topologyDigest: head.topologyDigest,
    nextOrdinal: head.nextOrdinal,
  });
}
interface State {
  pieces: TextPieceOccurrence[];
  contents: Map<string, TextPieceContent>;
  contentWrites: TextPieceContent[];
  nextOrdinal: number;
  sequenceId: string;
  length: number;
  bytes: number;
  retainedBytes: number;
}
function reconstruct(state: State, work: Work): string {
  work.scan(state.pieces.length);
  let units = 0;
  let bytes = 0;
  const parts: string[] = [];
  for (const piece of state.pieces) {
    const content = state.contents.get(piece.contentId)!;
    const size = piece.end - piece.start;
    units += size;
    bound(units, work.limits.maxTextUtf16Units, 'reconstruction text units');
    work.metrics.reconstructionUtf16Units += size;
    bound(
      work.metrics.reconstructionUtf16Units,
      work.limits.maxReconstructionUtf16Units,
      'reconstruction UTF-16 units',
    );
    // Slices and final join are charged as logical text copies, regardless of V8's representation.
    work.copy(size, 0);
    const part = content.text.slice(piece.start, piece.end);
    const partBytes = Buffer.byteLength(part);
    bytes += partBytes;
    bound(bytes, work.limits.maxTextBytes, 'reconstruction text bytes');
    work.metrics.reconstructionBytes += partBytes;
    work.copy(0, partBytes);
    parts.push(part);
  }
  work.copy(units, bytes);
  return parts.join('');
}
function topology(state: State, work: Work): string {
  const hash = createHash('sha256');
  work.scan(state.pieces.length);
  for (let i = 0; i < state.pieces.length; i++) {
    const row = state.pieces[i];
    // Canonical field order binds occurrence identity, immutable slice and next link.
    const line =
      work.serialize({
        id: row.id,
        contentId: row.contentId,
        start: row.start,
        end: row.end,
        next: state.pieces[i + 1]?.id ?? null,
      }) + '\n';
    const bytes = Buffer.byteLength(line);
    work.metrics.hashBytes += bytes;
    bound(work.metrics.hashBytes, work.limits.maxHashBytes, 'hash bytes');
    hash.update(work.encode(line));
  }
  return hash.digest('hex');
}
function validateSnapshot(snapshot: TextPieceSnapshot, work: Work): { state: State; text: string } {
  exact(snapshot, ['head', 'contents', 'occurrences', 'links'], 'snapshot');
  headShape(snapshot.head);
  const head = snapshot.head;
  work.rowBytes(head, work.limits.maxHeadBytes);
  work.metrics.validatedRows++;
  bound(head.pieces, work.limits.maxPieces, 'head pieces');
  bound(head.utf16Length, work.limits.maxTextUtf16Units, 'head UTF-16 units');
  bound(head.utf8Bytes, work.limits.maxTextBytes, 'head UTF-8 bytes');
  mapShape(snapshot.contents, 'contents');
  mapShape(snapshot.occurrences, 'occurrences');
  mapShape(snapshot.links, 'links');
  bound(snapshot.contents.size, work.limits.maxRetainedContentRows, 'retained content rows');
  if (snapshot.occurrences.size !== head.pieces || snapshot.links.size !== head.pieces)
    invalid('occurrence/link inventory does not match head pieces');
  const state: State = {
    pieces: [],
    contents: new Map(),
    contentWrites: [],
    nextOrdinal: head.nextOrdinal,
    sequenceId: head.sequenceId,
    length: head.utf16Length,
    bytes: head.utf8Bytes,
    retainedBytes: 0,
  };
  let retainedBytes = 0;
  work.scan(snapshot.contents.size);
  // Retained orphan content is allowed but also bounded, validated and counted.
  for (const [key, row] of snapshot.contents) {
    exact(row, ['id', 'text'], 'content');
    digestId(key);
    if (row.id !== key) invalid('content key identity');
    work.validateText(row.text, work.limits.maxContentBytes);
    const bytes = Buffer.byteLength(row.text);
    bound(bytes, work.limits.maxContentBytes, 'content bytes');
    retainedBytes += bytes;
    bound(retainedBytes, work.limits.maxRetainedContentBytes, 'retained content bytes');
    work.metrics.existingContentReads++;
    work.metrics.existingContentReadBytes += bytes;
    bound(
      work.metrics.existingContentReadBytes,
      work.limits.maxExistingContentReadBytes,
      'existing content read bytes',
    );
    work.metrics.validatedRows++;
    work.rowBytes(row);
    if (work.hash(row.text) !== key) mismatch('content hash');
    state.contents.set(key, Object.freeze({ id: key, text: row.text }));
  }
  state.retainedBytes = retainedBytes;
  let current = head.first;
  const seen = new Set<string>();
  let length = 0;
  while (current !== null) {
    work.scan(1);
    occurrenceId(current, head);
    if (seen.has(current)) invalid('cycle in occurrence chain');
    seen.add(current);
    bound(seen.size, work.limits.maxPieces, 'selected pieces');
    const row = snapshot.occurrences.get(current);
    const link = snapshot.links.get(current);
    work.metrics.existingOccurrenceReads++;
    work.metrics.existingLinkReads++;
    exact(row, ['id', 'contentId', 'start', 'end'], 'occurrence');
    exact(link, ['id', 'next'], 'link');
    if (row.id !== current || link.id !== current) invalid('occurrence/link key identity');
    digestId(row.contentId);
    natural(row.start, 'slice start');
    natural(row.end, 'slice end');
    const content = state.contents.get(row.contentId);
    if (!content) invalid('missing content reference');
    if (row.start >= row.end || row.end > content.text.length) invalid('occurrence slice range');
    scalarBoundary(content.text, row.start);
    scalarBoundary(content.text, row.end);
    if (link.next !== null) occurrenceId(link.next, head);
    length += row.end - row.start;
    bound(length, work.limits.maxTextUtf16Units, 'selected text units');
    work.rowBytes(row);
    work.rowBytes(link);
    work.metrics.validatedRows += 2;
    state.pieces.push(
      Object.freeze({ id: current, contentId: row.contentId, start: row.start, end: row.end }),
    );
    current = link.next;
  }
  if (seen.size !== head.pieces || length !== head.utf16Length) mismatch('head chain counters');
  const text = reconstruct(state, work);
  if (
    Buffer.byteLength(text) !== head.utf8Bytes ||
    work.hash(text) !== head.digest ||
    topology(state, work) !== head.topologyDigest
  )
    mismatch('head text/topology result');
  return { state, text };
}
function allocate(
  state: State,
  contentId: string,
  start: number,
  end: number,
): TextPieceOccurrence {
  if (!Number.isSafeInteger(state.nextOrdinal + 1))
    throw new TextPieceError('limit', 'next occurrence ordinal');
  return Object.freeze({ id: `${state.sequenceId}:${state.nextOrdinal++}`, contentId, start, end });
}
function insertPieces(text: string, state: State, work: Work): TextPieceOccurrence[] {
  work.validateText(text);
  bound(Buffer.byteLength(text), work.limits.maxTextBytes, 'inserted text bytes');
  const pieces: TextPieceOccurrence[] = [];
  let start = 0;
  let offset = 0;
  let bytes = 0;
  const emit = () => {
    work.copy(offset - start, bytes);
    const part = text.slice(start, offset);
    const id = work.hash(part);
    if (!state.contents.has(id)) {
      bound(state.contents.size + 1, work.limits.maxRetainedContentRows, 'retained content rows');
      bound(
        state.retainedBytes + bytes,
        work.limits.maxRetainedContentBytes,
        'retained content bytes',
      );
      state.retainedBytes += bytes;
      const row = Object.freeze({ id, text: part });
      work.rowBytes(row);
      state.contents.set(id, row);
      state.contentWrites.push(row);
    } else if (state.contents.get(id)!.text !== part) mismatch('content hash collision');
    bound(pieces.length + 1, work.limits.maxPieces, 'inserted pieces');
    pieces.push(allocate(state, id, 0, part.length));
    start = offset;
    bytes = 0;
  };
  // Only inserted text is chunked; retained boundaries are never globally refreshed.
  work.metrics.validationUtf16Units += text.length;
  bound(
    work.metrics.validationUtf16Units,
    work.limits.maxValidationUtf16Units,
    'chunk scan UTF-16 units',
  );
  while (offset < text.length) {
    const code = text.codePointAt(offset)!;
    const width = code > 0xffff ? 2 : 1;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    bound(size, work.limits.maxContentBytes, 'scalar exceeds content byte limit');
    if (bytes + size > work.limits.maxContentBytes) emit();
    offset += width;
    bytes += size;
  }
  if (offset > start) emit();
  return pieces;
}
/** Split one boundary only; the left occurrence keeps its identity. */
function splitAt(state: State, offset: number, work: Work): number {
  natural(offset, 'edit offset');
  if (offset > state.length) invalid('edit offset range');
  let position = 0;
  for (let i = 0; i < state.pieces.length; i++) {
    work.scan(1);
    const piece = state.pieces[i];
    if (position === offset) return i;
    const end = position + piece.end - piece.start;
    if (offset < end) {
      const cut = piece.start + offset - position;
      scalarBoundary(state.contents.get(piece.contentId)!.text, cut);
      bound(state.pieces.length + 1, work.limits.maxPieces, 'split pieces');
      const left = Object.freeze({ ...piece, end: cut });
      const right = allocate(state, piece.contentId, cut, piece.end);
      work.scan(state.pieces.length - i + 1);
      state.pieces.splice(i, 1, left, right);
      return i + 1;
    }
    position = end;
  }
  return state.pieces.length;
}
function rangeBoundary(state: State, offset: number, work: Work): void {
  if (offset > state.length) invalid('edit offset range');
  let position = 0;
  for (const piece of state.pieces) {
    work.scan(1);
    const end = position + piece.end - piece.start;
    if (offset <= end) {
      scalarBoundary(state.contents.get(piece.contentId)!.text, piece.start + offset - position);
      return;
    }
    position = end;
  }
}
function rangeBytes(state: State, start: number, end: number, work: Work): number {
  if (start === end) return 0;
  let position = 0;
  let bytes = 0;
  for (const piece of state.pieces) {
    work.scan(1);
    const through = position + piece.end - piece.start;
    if (through > start && position < end) {
      const from = piece.start + Math.max(0, start - position);
      const to = piece.start + Math.min(through - position, end - position);
      work.copy(to - from, 0);
      const part = state.contents.get(piece.contentId)!.text.slice(from, to);
      const size = Buffer.byteLength(part);
      work.copy(0, size);
      bytes += size;
    }
    position = through;
    if (position >= end) break;
  }
  return bytes;
}
function applyEdit(state: State, edit: TextPieceEdit, work: Work): void {
  work.metrics.operations++;
  bound(work.metrics.operations, work.limits.maxOperations, 'edit operations');
  if (!edit || typeof edit !== 'object') invalid('edit object');
  const kindDescriptor = Object.getOwnPropertyDescriptor(edit, 'kind');
  if (!kindDescriptor || !Object.hasOwn(kindDescriptor, 'value')) invalid('edit kind');
  if (edit.kind === 'splice') {
    exact(edit, ['kind', 'at', 'deleteCount', 'insert'], 'splice');
    natural(edit.at, 'splice offset');
    natural(edit.deleteCount, 'splice delete count');
    if (edit.at > state.length || edit.deleteCount > state.length - edit.at)
      invalid('splice range');
    work.validateText(edit.insert);
    const nextLength = state.length - edit.deleteCount + edit.insert.length;
    bound(nextLength, work.limits.maxTextUtf16Units, 'candidate text units');
    if (edit.deleteCount === 0 && edit.insert.length === 0) {
      rangeBoundary(state, edit.at, work);
      return;
    }
    // Validate and retain the two boundary indexes in the same walks. Splitting
    // changes only the private plan state and preserves the removed text bytes.
    const from = splitAt(state, edit.at, work);
    const through = splitAt(state, edit.at + edit.deleteCount, work);
    const nextBytes =
      state.bytes -
      rangeBytes(state, edit.at, edit.at + edit.deleteCount, work) +
      Buffer.byteLength(edit.insert);
    bound(nextBytes, work.limits.maxTextBytes, 'candidate text bytes');
    const inserted = insertPieces(edit.insert, state, work);
    bound(
      state.pieces.length - (through - from) + inserted.length,
      work.limits.maxPieces,
      'candidate pieces',
    );
    work.scan(2 * (state.pieces.length - (through - from)) + inserted.length);
    // Avoid spread argument limits for large bounded insertions.
    state.pieces = state.pieces.slice(0, from).concat(inserted, state.pieces.slice(through));
    state.length = nextLength;
    state.bytes = nextBytes;
  } else if (edit.kind === 'move') {
    exact(edit, ['kind', 'from', 'length', 'to'], 'move');
    natural(edit.from, 'move source');
    natural(edit.length, 'move length');
    natural(edit.to, 'move destination');
    if (
      edit.from > state.length ||
      edit.length > state.length - edit.from ||
      edit.to > state.length
    )
      invalid('move range');
    const end = edit.from + edit.length;
    if (edit.to > edit.from && edit.to < end) invalid('move destination inside source');
    if (!edit.length || edit.to === edit.from || edit.to === end) {
      // Even a no-op must refuse an offset that splits a Unicode scalar.
      rangeBoundary(state, edit.from, work);
      rangeBoundary(state, end, work);
      rangeBoundary(state, edit.to, work);
      return;
    }
    // Ascending boundary splits ensure every already assigned boundary index stays valid.
    // splitAt validates scalar boundaries itself. Retain its indexes instead of
    // walking the entire prefix again for validation and each index lookup.
    const boundaries = [...new Set([edit.from, end, edit.to])].sort((a, b) => a - b);
    const indexes = new Map<number, number>();
    for (const offset of boundaries) indexes.set(offset, splitAt(state, offset, work));
    const from = indexes.get(edit.from)!;
    const through = indexes.get(end)!;
    const to = indexes.get(edit.to)!;
    work.scan(4 * state.pieces.length - 2 * (through - from));
    const moved = state.pieces.slice(from, through);
    const rest = state.pieces.slice(0, from).concat(state.pieces.slice(through));
    const destination = to > from ? to - (through - from) : to;
    state.pieces = rest.slice(0, destination).concat(moved, rest.slice(destination));
  } else invalid('unknown edit kind');
}
function finish(
  state: State,
  old: TextPieceSnapshot | null,
  expectedText: string,
  work: Work,
): TextPiecePlan {
  bound(state.pieces.length, work.limits.maxPieces, 'candidate pieces');
  let retainedBytes = 0;
  work.scan(state.contents.size);
  for (const row of state.contents.values()) retainedBytes += Buffer.byteLength(row.text);
  bound(retainedBytes, work.limits.maxRetainedContentBytes, 'retained content bytes');
  const text = reconstruct(state, work);
  work.metrics.comparisonUtf16Units += Math.max(text.length, expectedText.length);
  if (text !== expectedText) mismatch('exact expected text result');
  // Explicit byte comparison documents the UTF-8 contract separately from JS equality.
  if (!work.encode(text).equals(work.encode(expectedText))) mismatch('exact expected UTF-8 result');
  const head = canonicalHead({
    format: 'text-pieces-v1',
    sequenceId: state.sequenceId,
    revision: old ? old.head.revision + 1 : 0,
    first: state.pieces[0]?.id ?? null,
    pieces: state.pieces.length,
    utf16Length: text.length,
    utf8Bytes: Buffer.byteLength(text),
    digest: work.hash(text),
    topologyDigest: topology(state, work),
    nextOrdinal: state.nextOrdinal,
  });
  natural(head.revision, 'head revision overflow');
  const occurrenceWrites: TextPieceOccurrence[] = [];
  const linkWrites: TextPieceLink[] = [];
  const occurrenceDeletes: string[] = [];
  const linkDeletes: string[] = [];
  const live = new Set<string>();
  work.scan(state.pieces.length);
  for (let i = 0; i < state.pieces.length; i++) {
    const row = state.pieces[i];
    live.add(row.id);
    const before = old?.occurrences.get(row.id);
    if (old) work.metrics.existingOccurrenceReads++;
    if (
      !before ||
      before.contentId !== row.contentId ||
      before.start !== row.start ||
      before.end !== row.end
    )
      occurrenceWrites.push(row);
    const next = state.pieces[i + 1]?.id ?? null;
    const beforeLink = old?.links.get(row.id);
    if (old) work.metrics.existingLinkReads++;
    if (!beforeLink || beforeLink.next !== next)
      linkWrites.push(Object.freeze({ id: row.id, next }));
  }
  if (old) {
    work.scan(old.occurrences.size);
    for (const id of old.occurrences.keys())
      if (!live.has(id)) {
        occurrenceDeletes.push(id);
        linkDeletes.push(id);
      }
  }
  const m = work.metrics;
  for (const row of state.contentWrites) {
    m.contentRowsWritten++;
    m.contentBytesWritten += work.rowBytes(row);
  }
  for (const row of occurrenceWrites) {
    m.occurrenceRowsWritten++;
    m.occurrenceBytesWritten += work.rowBytes(row);
  }
  for (const row of linkWrites) {
    m.linkRowsWritten++;
    m.linkBytesWritten += work.rowBytes(row);
  }
  m.occurrenceRowsDeleted = occurrenceDeletes.length;
  m.linkRowsDeleted = linkDeletes.length;
  m.headBytesWritten = work.rowBytes(head, work.limits.maxHeadBytes);
  // Delete keys are individual bounded storage mutations too; include their encoded bytes in the plan cap.
  for (const id of occurrenceDeletes) m.occurrenceBytesDeleted += work.rowBytes(id);
  for (const id of linkDeletes) m.linkBytesDeleted += work.rowBytes(id);
  const deletionBytes = m.occurrenceBytesDeleted + m.linkBytesDeleted;
  bound(
    m.contentBytesWritten +
      m.occurrenceBytesWritten +
      m.linkBytesWritten +
      m.headBytesWritten +
      deletionBytes,
    work.limits.maxPlanBytes,
    'changed plan bytes',
  );
  return Object.freeze({
    expectedHead: old ? canonicalHead(old.head) : null,
    head,
    contentWrites: Object.freeze(state.contentWrites),
    occurrenceWrites: Object.freeze(occurrenceWrites),
    linkWrites: Object.freeze(linkWrites),
    occurrenceDeletes: Object.freeze(occurrenceDeletes),
    linkDeletes: Object.freeze(linkDeletes),
    metrics: Object.freeze({ ...m }),
  });
}
/** Initialize exact text. Caller applies each returned row and the head in its own transaction. */
export function createTextPiecePlan(
  text: string,
  options: { sequenceId: string; limits?: Partial<TextPieceLimits> },
): TextPiecePlan {
  sequence(options?.sequenceId);
  const work = new Work(options.limits);
  work.validateText(text);
  const state: State = {
    pieces: [],
    contents: new Map(),
    contentWrites: [],
    nextOrdinal: 0,
    sequenceId: options.sequenceId,
    length: text.length,
    bytes: Buffer.byteLength(text),
    retainedBytes: 0,
  };
  state.pieces = insertPieces(text, state, work);
  return finish(state, null, text, work);
}
/** Edits are sequential. Move.to is in the text BEFORE that move removes its source. */
export function planTextPieceEdits(
  snapshot: TextPieceSnapshot,
  options: {
    expectedHead: TextPieceHead;
    edits: readonly TextPieceEdit[];
    expectedText: string;
    limits?: Partial<TextPieceLimits>;
  },
): TextPiecePlan {
  const work = new Work(options?.limits);
  headShape(options?.expectedHead);
  headShape(snapshot?.head);
  if (HEAD_KEYS.some((key) => options.expectedHead[key] !== snapshot.head[key]))
    mismatch('expected old head');
  work.validateText(options.expectedText);
  bound(Buffer.byteLength(options.expectedText), work.limits.maxTextBytes, 'expected text bytes');
  const edits = options.edits;
  if (!Array.isArray(edits) || Object.getPrototypeOf(edits) !== Array.prototype)
    invalid('edits must be an ordinary array');
  bound(edits.length, work.limits.maxOperations, 'edit operations');
  const descriptors = Object.getOwnPropertyDescriptors(edits);
  if (Reflect.ownKeys(descriptors).length !== edits.length + 1) invalid('edits array fields');
  for (let i = 0; i < edits.length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
      invalid('edits array entry');
  }
  const { state } = validateSnapshot(snapshot, work);
  for (let i = 0; i < edits.length; i++) applyEdit(state, edits[i], work);
  return finish(state, snapshot, options.expectedText, work);
}
/** Cold validation/reconstruction counts every retained content row, including orphan content. */
export function reconstructTextPieces(
  snapshot: TextPieceSnapshot,
  options: { limits?: Partial<TextPieceLimits> } = {},
): { text: string; metrics: Readonly<TextPieceMetrics> } {
  const work = new Work(options.limits);
  const { text } = validateSnapshot(snapshot, work);
  return { text, metrics: Object.freeze({ ...work.metrics }) };
}
