import { createSchemaEnvelopeReader } from '../../intake-collection-envelope.ts';
import {
  ENVELOPE_SCHEMA,
  lexicalEntries,
  schemaKey,
  schemaOrdinal,
  structuredKind,
  type SchemaTarget,
} from '../../intake-envelope-schema.ts';

/** Isolated schema-reader fixture, without accepted checkpoint construction costs.
 * These exact lexical cells and first/last indexes are read by the production reader. */
export function retainedEnvelopeReader(value: unknown) {
  const text = JSON.stringify(value),
    cells = new Map<string, string>();
  const root = schemaKey('fictional-counted-envelope');
  const put = (key: string, value: unknown) => cells.set(key, JSON.stringify(value));
  function record(start: number, end: number, kind: string, id: string, parent?: string) {
    const shape = text[start] === '{' ? 'object' : text[start] === '[' ? 'array' : 'scalar';
    if (shape === 'scalar') {
      cells.set('c:' + id, text.slice(start, end));
      put('r:' + id, { kind, shape, count: 0 });
      return;
    }
    let count = 0,
      suffix = start,
      publicId: string | undefined;
    for (const entry of lexicalEntries(text, start, end)) {
      const occurrence = schemaKey(id, count),
        prefix = schemaKey(occurrence, 'prefix');
      let target: SchemaTarget;
      if (shape === 'array') {
        put('p:' + occurrence, { parent: id, ordinal: count, field: null });
        record(
          entry.start,
          entry.end,
          text[entry.start] === '{' ? kind : 'scalar',
          occurrence,
          parent,
        );
        target = { type: 'record', id: occurrence };
      } else {
        const nested = structuredKind(kind, entry.name!, text[entry.start]!);
        if (nested) {
          put('p:' + occurrence, { parent: id, ordinal: count, field: schemaKey(entry.name!) });
          record(entry.start, entry.end, nested, occurrence, id);
          target = { type: 'record', id: occurrence };
        } else {
          cells.set('c:' + occurrence, text.slice(entry.start, entry.end));
          target = { type: 'cell', id: occurrence };
        }
        const field = schemaKey(entry.name!);
        put('b:' + id + ':' + field, count);
        put('l:' + id + ':' + field, count);
        put('f:' + id + ':' + field, target);
        put('n:' + occurrence, entry.name);
        if (entry.name === 'id' && parent)
          publicId = JSON.parse(text.slice(entry.start, entry.end));
      }
      cells.set('c:' + prefix, text.slice(entry.prefixStart, entry.start));
      put('o:' + id + ':' + schemaOrdinal(count), {
        target,
        prefix,
        ...(entry.name === undefined ? {} : { name: occurrence }),
      });
      suffix = entry.end;
      count++;
    }
    cells.set('s:' + id, text.slice(suffix, end));
    put('r:' + id, { kind, shape, count });
    put('x:' + id, count);
    if (shape === 'object') put('u:' + id, count);
    if (publicId !== undefined && parent) {
      const key = 'i:' + parent + ':' + schemaKey(kind, publicId);
      if (!cells.has(key)) cells.set(key, id);
      cells.set('j:' + parent + ':' + schemaKey(kind, publicId), id);
    }
  }
  record(0, text.length, 'root', root);
  const sorted = [...cells].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createSchemaEnvelopeReader(
    {
      check() {},
      get: (key) => cells.get(key),
      range(after, items, bytes) {
        const result: Array<{ key: string; value: string }> = [];
        let size = 0;
        for (const [key, value] of sorted) {
          if (key <= after) continue;
          const next = Buffer.byteLength(key) + Buffer.byteLength(value);
          if (result.length === items || size + next > bytes)
            return { items: result, complete: false };
          result.push({ key, value });
          size += next;
        }
        return { items: result, complete: true };
      },
      chunks() {
        throw Error('Count fixture has only inline retained cells');
      },
    },
    { format: ENVELOPE_SCHEMA, mode: 'normalized', root },
    { domainVersion: 1, root: null },
  );
}
