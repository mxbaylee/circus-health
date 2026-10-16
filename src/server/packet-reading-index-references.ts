import type { PacketReadingGap } from './packet-reading-gaps-native.ts';

/** Read capacity disclosures from the exact retained direct source index. Skip
 * unrelated sections/rows as a stream; only emitted locator/reason text is held. */
export function* packetReadingIndexReferences(
  pieces: Iterable<string>,
): Generator<PacketReadingGap> {
  const iterator = pieces[Symbol.iterator]();
  let block = '',
    at = 0,
    ended = false;
  const peek = (): string => {
    while (at === block.length && !ended) {
      const next = iterator.next();
      block = next.value || '';
      at = 0;
      ended = !!next.done;
    }
    return block[at] || '';
  };
  const take = () => {
    const value = peek();
    if (value) at++;
    return value;
  };
  const whitespace = () => {
    while (/^[\x20\t\r\n]$/.test(peek())) take();
  };
  const expect = (expected: string) => {
    whitespace();
    if (take() !== expected) throw Error('Invalid retained reading index');
  };
  const string = (retain: boolean) => {
    expect('"');
    let value = '';
    for (;;) {
      let unit = take();
      if (!unit) throw Error('Invalid retained reading index string');
      if (unit === '"') return value;
      if (unit === '\\') {
        const escape = take();
        if (escape === 'u') {
          let digits = '';
          for (let i = 0; i < 4; i++) {
            const digit = take();
            if (!/^[a-fA-F0-9]$/.test(digit)) throw Error('Invalid reading index escape');
            digits += digit;
          }
          unit = String.fromCharCode(parseInt(digits, 16));
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
          if (!Object.hasOwn(escapes, escape)) throw Error('Invalid reading index escape');
          unit = escapes[escape]!;
        }
      }
      if (retain) value += unit;
    }
  };
  const skip = () => {
    whitespace();
    let depth = 0;
    for (;;) {
      const next = peek();
      if (!next || (!depth && /[,}\]\x20\t\r\n]/.test(next))) return;
      if (next === '"') {
        string(false);
        if (!depth) return;
        continue;
      }
      take();
      if (next === '{' || next === '[') depth++;
      else if (next === '}' || next === ']') {
        if (--depth === 0) return;
      }
    }
  };
  try {
    expect('{');
    whitespace();
    while (peek() !== '}') {
      const key = string(true);
      expect(':');
      if (key === 'references') {
        expect('[');
        whitespace();
        while (peek() !== ']') {
          expect('{');
          whitespace();
          let status = '',
            locator = '',
            note = '';
          while (peek() !== '}') {
            const name = string(true);
            expect(':');
            whitespace();
            if (['status', 'locator', 'note'].includes(name) && peek() === '"') {
              const value = string(true);
              if (name === 'status') status = value;
              else if (name === 'locator') locator = value;
              else note = value;
            } else skip();
            whitespace();
            if (peek() === '}') break;
            expect(',');
          }
          expect('}');
          if (status === 'capacity_exception')
            yield {
              locator,
              reason: 'capacity exception: ' + (note || 'references were not indexed'),
            };
          whitespace();
          if (peek() === ']') break;
          expect(',');
        }
        expect(']');
      } else skip();
      whitespace();
      if (peek() === '}') break;
      expect(',');
    }
    expect('}');
    whitespace();
    if (peek()) throw Error('Trailing retained reading index');
  } finally {
    iterator.return?.();
  }
}
