/** Filter canonical selected evidence without cloning providers or collecting JSON values. */
const ephemeral = new Set([
  'selectionReviewToken',
  'comparisonPage',
  'comparisonDrafts',
  'draftScopeStatus',
]);
const pairPins = new Set(['requestRevision', 'intakeVersion', 'token']);
const completeCharacters = (text: string) => !/[\uD800-\uDBFF]$/.test(text);
class Cursor {
  readonly input: Iterator<string>;
  chunk = '';
  offset = 0;
  done = false;
  constructor(chunks: Iterable<string>) {
    this.input = chunks[Symbol.iterator]();
  }
  peek(): string {
    while (this.offset === this.chunk.length && !this.done) {
      const next = this.input.next();
      this.done = !!next.done;
      this.chunk = next.done ? '' : next.value;
      this.offset = 0;
    }
    return this.chunk[this.offset] || '';
  }
  take(): string {
    const char = this.peek();
    if (char) this.offset++;
    return char;
  }
  close() {
    this.input.return?.();
  }
}
/** Input is already canonical: format sorts before all three conditional pair pins. */
export function* canonicalSelectionChunks(chunks: Iterable<string>): Generator<string> {
  const cursor = new Cursor(chunks);
  function* string(emit: boolean, capture = false): Generator<string, string | undefined> {
    let buffer = '',
      literal: string | undefined = '',
      escaped = false;
    const first = cursor.take();
    if (first !== '"') throw Error('Invalid canonical selected string');
    if (emit) buffer = first;
    if (capture) literal = first;
    for (;;) {
      const char = cursor.take();
      if (!char) throw Error('Incomplete canonical selected string');
      if (emit) buffer += char;
      if (capture && literal !== undefined)
        literal = literal.length < 512 ? literal + char : undefined;
      const end = char === '"' && !escaped;
      escaped = char === '\\' && !escaped;
      if (buffer.length >= 8192 && completeCharacters(buffer)) {
        yield buffer;
        buffer = '';
      }
      if (end) break;
    }
    if (buffer) yield buffer;
    return literal;
  }
  function* fieldName(
    emit: boolean,
    comma: boolean,
  ): Generator<string, { key?: string; literal?: string; written: boolean }> {
    let buffer = '',
      escaped = false,
      written = false;
    if (cursor.take() !== '"') throw Error('Invalid canonical selected key');
    buffer = '"';
    for (;;) {
      const char = cursor.take();
      if (!char) throw Error('Incomplete canonical selected key');
      buffer += char;
      const end = char === '"' && !escaped;
      escaped = char === '\\' && !escaped;
      if (!written && buffer.length > 512 && completeCharacters(buffer)) {
        // Every excluded ASCII key has at most six literal bytes per character.
        // A longer key cannot match; emit it without retaining the whole scalar.
        if (emit) yield (comma ? ',' : '') + buffer;
        buffer = '';
        written = true;
      } else if (written && buffer.length >= 8192 && completeCharacters(buffer)) {
        if (emit) yield buffer;
        buffer = '';
      }
      if (end) break;
    }
    if (written) {
      if (emit && buffer) yield buffer;
      return { written: true };
    }
    return { key: JSON.parse(buffer) as string, literal: buffer, written: false };
  }
  function* value(emit: boolean, path: readonly string[]): Generator<string> {
    // Retained intake JSON already limits literal depth to 100; reserve room
    // for the surrounding review and selection records without unbounded stacks.
    if (path.length > 128) throw Error('Canonical selected evidence exceeds retained depth');
    const next = cursor.peek();
    // The historical canonical recipe represents undefined array entries as holes.
    if (next === ',' || next === ']') return;
    if (next === '"') {
      yield* string(emit);
      return;
    }
    if (next === '[') {
      cursor.take();
      if (emit) yield '[';
      let first = true;
      while (cursor.peek() !== ']') {
        if (!first) {
          if (cursor.take() !== ',') throw Error('Invalid canonical selected array');
          if (emit) yield ',';
        }
        first = false;
        yield* value(emit, [...path, '[]']);
      }
      cursor.take();
      if (emit) yield ']';
      return;
    }
    if (next === '{') {
      cursor.take();
      if (emit) yield '{';
      let first = true,
        emitted = false,
        pair = false;
      while (cursor.peek() !== '}') {
        if (!first && cursor.take() !== ',') throw Error('Invalid canonical selected object');
        first = false;
        const field = yield* fieldName(emit, emitted),
          key = field.key || '';
        if (cursor.take() !== ':') throw Error('Invalid canonical selected field');
        const include: boolean = emit && !ephemeral.has(key) && !(pair && pairPins.has(key));
        if (include) {
          if (!field.written) {
            if (emitted) yield ',';
            yield field.literal!;
          }
          emitted = true;
          yield ':';
        }
        if (key === 'format' && cursor.peek() === '"') {
          // Decode this one scalar discriminator, never a retained evidence body.
          const format: string | undefined = yield* string(include, true);
          pair = format !== undefined && JSON.parse(format) === 'intake-pair-scope-v2';
        } else yield* value(include, [...path, key]);
      }
      cursor.take();
      if (emit) yield '}';
      return;
    }
    let buffer = '',
      seen = false;
    while (cursor.peek() && ![',', ']', '}'].includes(cursor.peek())) {
      const char = cursor.take();
      seen = true;
      if (emit) buffer += char;
      if (buffer.length >= 8192) {
        yield buffer;
        buffer = '';
      }
    }
    if (!seen) throw Error('Invalid canonical selected scalar');
    if (buffer) yield buffer;
  }
  try {
    yield* value(true, []);
    if (cursor.peek()) throw Error('Trailing canonical selected evidence');
  } finally {
    cursor.close();
  }
}
