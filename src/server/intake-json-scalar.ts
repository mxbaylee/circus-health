/** Canonical scalar hashing without retaining a string/number token. */
import { createHash } from 'node:crypto';
export function hashIntakeJsonScalar(
  pieces: Iterable<string>,
  leading: readonly (string | null)[] = [],
  onStringUnit?: (unit: string) => void,
): { hash: string; kind: 'string' | 'number' | 'boolean' | 'null'; bytes: number } {
  const steps = hashIntakeJsonScalarSteps(pieces, leading, onStringUnit);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
export function* hashIntakeJsonScalarSteps(
  pieces: Iterable<string>,
  leading: readonly (string | null)[] = [],
  onStringUnit?: (unit: string) => void,
  onNumber?: (value: number) => void,
): Generator<
  void,
  { hash: string; kind: 'string' | 'number' | 'boolean' | 'null'; bytes: number }
> {
  let units = 0;
  const iterator = pieces[Symbol.iterator]();
  let block = '',
    at = 0,
    ended = false;
  const peek = (): string => {
    while (at === block.length && !ended) {
      const next = iterator.next();
      ended = !!next.done;
      block = next.value ?? '';
      at = 0;
    }
    return block[at] ?? '';
  };
  const take = () => {
    const char = peek();
    if (char) {
      at++;
      units++;
    }
    return char;
  };
  const fail = (): never => {
    throw Error('Invalid scalar JSON evidence');
  };
  const ws = function* () {
    while (/^[\x20\t\r\n]$/.test(peek())) {
      take();
      if (units >= 4096) {
        units = 0;
        yield;
      }
    }
  };
  const hash = createHash('sha256'),
    prefix = JSON.stringify(leading);
  let bytes = 0;
  const update = (piece: string) => {
    bytes += Buffer.byteLength(piece);
    hash.update(piece);
  };
  update(prefix.slice(0, -1) + (leading.length ? ',' : ''));
  let kind: 'string' | 'number' | 'boolean' | 'null';
  try {
    yield* ws();
    if (peek() === '"') {
      kind = 'string';
      take();
      update('"');
      let high = '';
      const emit = (char: string) => {
        onStringUnit?.(char);
        if (high) {
          if (/^[\uDC00-\uDFFF]$/.test(char)) {
            update(JSON.stringify(high + char).slice(1, -1));
            high = '';
            return;
          }
          update(JSON.stringify(high).slice(1, -1));
          high = '';
        }
        if (/^[\uD800-\uDBFF]$/.test(char)) high = char;
        else update(JSON.stringify(char).slice(1, -1));
      };
      while (true) {
        if (units >= 4096) {
          units = 0;
          yield;
        }
        let char = take();
        if (!char) fail();
        if (char === '"') break;
        if (char === '\\') {
          const escape = take();
          if (escape === 'u') {
            let digits = '';
            for (let n = 0; n < 4; n++) {
              const hex = take();
              if (!/^[0-9a-fA-F]$/.test(hex)) fail();
              digits += hex;
            }
            char = String.fromCharCode(Number.parseInt(digits, 16));
          } else {
            const escapes: Record<string, string> = {
              '"': '"',
              '\\': '\\',
              '/': '/',
              b: '\b',
              f: '\f',
              n: '\n',
              r: '\r',
              t: '\t',
            };
            if (!Object.hasOwn(escapes, escape)) fail();
            char = escapes[escape]!;
          }
        } else if (char.charCodeAt(0) < 32) fail();
        emit(char);
      }
      if (high) update(JSON.stringify(high).slice(1, -1));
      update('"');
    } else if (['t', 'f', 'n'].includes(peek())) {
      const literal = peek() === 't' ? 'true' : peek() === 'f' ? 'false' : 'null';
      kind = literal === 'null' ? 'null' : 'boolean';
      for (const char of literal) if (take() !== char) fail();
      update(literal);
    } else {
      kind = 'number';
      let negative = false,
        fraction = 0,
        significant = 0,
        kept = '',
        sticky = false,
        started = false;
      if (peek() === '-') {
        negative = true;
        take();
      }
      const digit = (char: string, decimal: boolean) => {
        if (decimal) fraction++;
        if (char !== '0') started = true;
        if (started) {
          significant++;
          if (kept.length < 1200) kept += char;
          else if (char !== '0') sticky = true;
        }
        if (!Number.isSafeInteger(fraction) || !Number.isSafeInteger(significant)) fail();
      };
      if (peek() === '0') digit(take(), false);
      else {
        if (!/^[1-9]$/.test(peek())) fail();
        do {
          if (units >= 4096) {
            units = 0;
            yield;
          }
          digit(take(), false);
        } while (/^\d$/.test(peek()));
      }
      if (peek() === '.') {
        take();
        if (!/^\d$/.test(peek())) fail();
        do {
          if (units >= 4096) {
            units = 0;
            yield;
          }
          digit(take(), true);
        } while (/^\d$/.test(peek()));
      }
      let exponent = 0,
        exponentNegative = false;
      if (peek() === 'e' || peek() === 'E') {
        take();
        if (peek() === '+' || peek() === '-') exponentNegative = take() === '-';
        if (!/^\d$/.test(peek())) fail();
        do {
          if (units >= 4096) {
            units = 0;
            yield;
          }
          exponent = Math.min(Number.MAX_SAFE_INTEGER * 2, exponent * 10 + Number(take()));
        } while (/^\d$/.test(peek()));
      }
      if (exponentNegative) exponent = -exponent;
      // Every binary64 rounding midpoint has fewer than 1200 significant decimal
      // digits. Retain that prefix and one sticky digit: discarded nonzero digits
      // then preserve which side of any exact midpoint the source lies on.
      const adjusted = exponent - fraction + significant - kept.length - (sticky ? 1 : 0),
        number = started
          ? Number((negative ? '-' : '') + kept + (sticky ? '1' : '') + 'e' + adjusted)
          : negative
            ? -0
            : 0;
      onNumber?.(number);
      update(JSON.stringify(number));
    }
    yield* ws();
    if (peek()) fail();
    update(']');
    return { hash: hash.digest('hex'), kind, bytes };
  } finally {
    iterator.return?.();
  }
}
