/** SQLite's default LIKE grammar: % and _, no escape, ASCII case folding, and
 * codepoint comparison. State is bounded by the pattern, never by source size.
 * SQLite TEXT transport replaces lone UTF-16 surrogates. Its UTF-8 reader also
 * maps U+FFFE/U+FFFF to U+FFFD, and LIKE stops at NUL.
 */
export const SQLITE_LIKE_PATTERN_BYTES = 50_000;
const fold = (point: number) => (point >= 65 && point <= 90 ? point + 32 : point);
const sqlitePoint = (point: number) => (point === 0xfffe || point === 0xffff ? 0xfffd : point);

export interface SourceDetailsLikeMatcher {
  /** Numeric buffer bytes, excluding bounded JS object/container overhead. */
  readonly retainedBytes: number;
  write(chunk: string): void;
  finish(): boolean;
}

export function createSourceDetailsLikeMatcher(pattern: string): SourceDetailsLikeMatcher {
  if (Buffer.byteLength(pattern) > SQLITE_LIKE_PATTERN_BYTES)
    throw Error('LIKE or GLOB pattern too complex');
  const compiled: number[] = [];
  for (const char of Buffer.from(pattern, 'utf8').toString('utf8')) {
    const point = sqlitePoint(char.codePointAt(0)!);
    if (point === 0) break;
    if (point !== 37 || compiled.at(-1) !== 37) compiled.push(fold(point));
  }
  const tokens = Uint32Array.from(compiled);
  const words = Math.ceil((tokens.length + 1) / 32);
  const percent = new Uint32Array(words);
  const any = new Uint32Array(words);
  const positionsByPoint = new Map<number, number[]>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === 37) percent[index >>> 5]! |= 1 << (index & 31);
    else if (token === 95) any[index >>> 5]! |= 1 << (index & 31);
    else {
      const positions = positionsByPoint.get(token) ?? [];
      positions.push(index);
      positionsByPoint.set(token, positions);
    }
  }
  const literals = new Map(
    [...positionsByPoint].map(([point, positions]) => [point, Uint32Array.from(positions)]),
  );
  let literalBytes = 0;
  for (const positions of literals.values()) literalBytes += positions.byteLength;
  let active = new Uint32Array(words);
  let next = new Uint32Array(words);
  let pending = '';
  let ended = false;
  let finished = false;
  let acceptsSuffix = false;
  const closure = () => {
    // Consecutive % tokens were collapsed, so one epsilon step is sufficient.
    let carry = 0;
    for (let word = 0; word < words; word++) {
      const stars = active[word]! & percent[word]!;
      active[word]! |= (stars << 1) | carry;
      carry = stars >>> 31;
    }
    acceptsSuffix =
      tokens.at(-1) === 37 && !!(active[tokens.length >>> 5]! & (1 << (tokens.length & 31)));
  };
  active[0] = 1;
  closure();
  const consume = (point: number) => {
    point = sqlitePoint(point);
    if (point === 0) {
      ended = true;
      return;
    }
    let carry = 0;
    for (let word = 0; word < words; word++) {
      const underscores = active[word]! & any[word]!;
      next[word] = (active[word]! & percent[word]!) | (underscores << 1) | carry;
      carry = underscores >>> 31;
    }
    for (const index of literals.get(fold(point)) ?? []) {
      if (active[index >>> 5]! & (1 << (index & 31))) {
        const after = index + 1;
        next[after >>> 5]! |= 1 << (after & 31);
      }
    }
    [active, next] = [next, active];
    closure();
  };
  return {
    // Four bitsets, compiled tokens and literal positions. Map/container counts
    // and temporary compilation storage also stay O(pattern bytes).
    retainedBytes: words * 16 + tokens.byteLength + literalBytes,
    write(chunk) {
      if (finished) throw Error('Source details LIKE matcher is finished');
      if (ended || acceptsSuffix) return;
      const text = pending + chunk;
      pending = '';
      for (let index = 0; index < text.length && !ended && !acceptsSuffix; index++) {
        const first = text.charCodeAt(index);
        if (first >= 0xd800 && first <= 0xdbff) {
          if (index + 1 === text.length) {
            pending = text[index]!;
            break;
          }
          const second = text.charCodeAt(index + 1);
          if (second >= 0xdc00 && second <= 0xdfff) {
            consume(0x10000 + ((first - 0xd800) << 10) + second - 0xdc00);
            index++;
          } else consume(0xfffd);
        } else consume(first >= 0xdc00 && first <= 0xdfff ? 0xfffd : first);
      }
    },
    finish() {
      if (!finished && pending && !ended) consume(0xfffd);
      pending = '';
      finished = true;
      return !!(active[tokens.length >>> 5]! & (1 << (tokens.length & 31)));
    },
  };
}
