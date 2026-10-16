/** Exact retained PDF page order and unique membership, prepared once in bounded batches. */
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import {
  prepareIntakeJsonCanonical,
  type IntakeJsonCanonicalWork,
} from './intake-json-canonical.ts';
import { schemaOrdinal } from './intake-envelope-schema.ts';

export async function prepareRetainedUnitPages(
  view: IntakeCollectionEnvelopeReader,
  unit: IntakeEnvelopeRecord,
  writer: { put(key: string, value: string): Promise<void>; peek(key: string): unknown },
  prefix: string,
  options: {
    assertRunning?: () => void;
    onWork?: (work: Readonly<IntakeJsonCanonicalWork>) => void;
  } = {},
) {
  let count = 0,
    uniqueCount = 0;
  if (view.has(unit, 'pages')) {
    const parsed = await prepareIntakeJsonCanonical(view.fieldChunks(unit, 'pages'), {
      ...options,
      mode: 'stringify',
    });
    try {
      if (parsed.kind(parsed.root) !== 'array') throw Error('Retained unit pages must be an array');
      for (const item of parsed.arrayItems(parsed.root)) {
        options.assertRunning?.();
        let text = '';
        for (const piece of parsed.pieces(item)) {
          text += piece;
          if (text.length > 32) throw Error('Invalid retained page number');
        }
        const page: unknown = JSON.parse(text);
        if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1)
          throw Error('Invalid retained page number');
        await writer.put(prefix + 'raw:' + schemaOrdinal(count++), String(page));
        if (writer.peek(prefix + 'page:' + page) === undefined) {
          await writer.put(prefix + 'page:' + page, String(uniqueCount));
          await writer.put(prefix + 'unique:' + schemaOrdinal(uniqueCount++), String(page));
        }
      }
    } finally {
      parsed.close();
    }
  }
  await writer.put(prefix + 'count', String(count));
  await writer.put(prefix + 'uniqueCount', String(uniqueCount));
}

export function readRetainedUnitPages(get: (key: string) => unknown, prefix: string) {
  const number = (key: string, minimum = 0) => {
    const value = get(prefix + key);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
      throw Error('Retained page scope is not completely prepared');
    return value;
  };
  const count = number('count'),
    uniqueCount = number('uniqueCount');
  if (uniqueCount > count) throw Error('Invalid retained unique page count');
  const at = (kind: 'raw' | 'unique', ordinal: number, total: number) => {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= total) return undefined;
    return number(kind + ':' + schemaOrdinal(ordinal), 1);
  };
  return {
    count,
    uniqueCount,
    pageAt: (ordinal: number) => at('raw', ordinal, count),
    uniquePageAt: (ordinal: number) => at('unique', ordinal, uniqueCount),
    pageOrdinal(page: number) {
      if (!Number.isSafeInteger(page) || page < 1) return undefined;
      const value = get(prefix + 'page:' + page);
      if (value === undefined) return undefined;
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value >= uniqueCount ||
        at('unique', value, uniqueCount) !== page
      )
        throw Error('Retained page ordinal proof conflicts');
      return value;
    },
  };
}
