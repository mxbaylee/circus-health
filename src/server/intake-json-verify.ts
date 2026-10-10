/** Syntax-only JSON validation over bounded text pieces; strings and arrays are
 * never accumulated. Auxiliary memory is the input's structural nesting depth. */
export function verifyIntakeJsonPieces(pieces: Iterable<string>): void {
  for (const _progress of iterateIntakeJsonVerification(pieces)) {
    /* synchronous callers */
  }
}

/** Fixed character quanta let asynchronous cold preparation remain cancellable. */
export function* iterateIntakeJsonVerification(pieces: Iterable<string>): Generator<void> {
  let units = 0;
  const iterator = pieces[Symbol.iterator]();
  let block = '',
    offset = 0,
    ended = false;
  const peek = (): string => {
    while (offset === block.length && !ended) {
      const next = iterator.next();
      ended = !!next.done;
      block = next.value ?? '';
      offset = 0;
    }
    return block[offset] ?? '';
  };
  const take = () => {
    const value = peek();
    if (value) {
      offset++;
      units++;
    }
    return value;
  };
  function* ws() {
    while (/[\x20\t\r\n]/.test(peek()) && peek()) {
      take();
      if (units >= 4096) {
        units = 0;
        yield;
      }
    }
  }
  const fail = (): never => {
    throw Error('Invalid selected envelope JSON syntax');
  };
  const expect = (value: string) => {
    if (take() !== value) fail();
  };
  const string = function* () {
    expect('"');
    while (true) {
      if (units >= 4096) {
        units = 0;
        yield;
      }
      const ch = take();
      if (!ch) fail();
      if (ch === '"') return;
      if (ch === '\\') {
        const escaped = take();
        if (escaped === 'u') {
          for (let n = 0; n < 4; n++) if (!/^[0-9a-fA-F]$/.test(take())) fail();
        } else if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(escaped)) fail();
      } else if (ch.charCodeAt(0) < 32) fail();
    }
  };
  const number = function* () {
    if (peek() === '-') take();
    if (peek() === '0') take();
    else {
      if (!/^[1-9]$/.test(take())) fail();
      while (/^\d$/.test(peek())) {
        take();
        if (units >= 4096) {
          units = 0;
          yield;
        }
      }
    }
    if (peek() === '.') {
      take();
      if (!/^\d$/.test(take())) fail();
      while (/^\d$/.test(peek())) {
        take();
        if (units >= 4096) {
          units = 0;
          yield;
        }
      }
    }
    if (peek() === 'e' || peek() === 'E') {
      take();
      if (peek() === '+' || peek() === '-') take();
      if (!/^\d$/.test(take())) fail();
      while (/^\d$/.test(peek())) {
        take();
        if (units >= 4096) {
          units = 0;
          yield;
        }
      }
    }
  };
  type State =
    | 'object-first'
    | 'object-key'
    | 'object-after'
    | 'array-first'
    | 'array-value'
    | 'array-after'
    | 'root-value'
    | 'root-after';
  const stack: State[] = ['root-value'];
  const value = function* () {
    yield* ws();
    const ch = peek();
    if (ch === '{') {
      take();
      stack.push('object-first');
    } else if (ch === '[') {
      take();
      stack.push('array-first');
    } else if (ch === '"') yield* string();
    else if (ch === 't' || ch === 'f' || ch === 'n') {
      for (const expected of ch === 't' ? 'true' : ch === 'f' ? 'false' : 'null') expect(expected);
    } else yield* number();
  };
  try {
    while (stack.length) {
      if (units >= 4096) {
        units = 0;
        yield;
      }
      yield* ws();
      const state = stack.at(-1)!;
      switch (state) {
        case 'root-value':
          stack[stack.length - 1] = 'root-after';
          yield* value();
          break;
        case 'root-after':
          if (peek()) fail();
          stack.pop();
          break;
        case 'object-first':
          if (peek() === '}') {
            take();
            stack.pop();
            break;
          }
          stack[stack.length - 1] = 'object-key';
          break;
        case 'object-key':
          yield* string();
          yield* ws();
          expect(':');
          stack[stack.length - 1] = 'object-after';
          yield* value();
          break;
        case 'object-after':
          if (peek() === '}') {
            take();
            stack.pop();
          } else {
            expect(',');
            stack[stack.length - 1] = 'object-key';
          }
          break;
        case 'array-first':
          if (peek() === ']') {
            take();
            stack.pop();
            break;
          }
          stack[stack.length - 1] = 'array-value';
          break;
        case 'array-value':
          stack[stack.length - 1] = 'array-after';
          yield* value();
          break;
        case 'array-after':
          if (peek() === ']') {
            take();
            stack.pop();
          } else {
            expect(',');
            stack[stack.length - 1] = 'array-value';
          }
          break;
      }
    }
  } finally {
    iterator.return?.();
  }
}
