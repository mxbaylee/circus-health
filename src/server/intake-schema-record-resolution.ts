/** Shared exact header/ancestry recipe. This pure validator owns no cache. */
import {
  schemaOrdinal,
  schemaKey,
  type SchemaRecord,
  type SchemaTarget,
  type SchemaOrder,
} from './intake-envelope-schema.ts';
import { hashIntakeJsonScalar } from './intake-json-scalar.ts';
const fail = (reason: string): never => {
  throw Error('Intake collection envelope: ' + reason);
};
export function schemaResolvedHeader(text: string): SchemaRecord {
  const value = JSON.parse(text) as SchemaRecord;
  if (
    Object.keys(value).sort().join(',') !== 'count,kind,shape' ||
    typeof value.kind !== 'string' ||
    !['object', 'array', 'scalar'].includes(value.shape) ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0
  )
    fail('record header');
  return value;
}
export function schemaResolvedTarget(value: unknown): SchemaTarget {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'id,type')
    return fail('target grammar');
  const item = value as SchemaTarget;
  if (!['cell', 'record'].includes(item.type) || !/^[a-f0-9]{64}$/.test(item.id))
    fail('target grammar');
  return item;
}
export function schemaResolvedOrder(text: string): SchemaOrder {
  const parsed = JSON.parse(text) as SchemaOrder;
  if (
    !parsed ||
    !/^[a-f0-9]{64}$/.test(parsed.prefix) ||
    (parsed.name !== undefined && !/^[a-f0-9]{64}$/.test(parsed.name))
  )
    fail('order entry');
  schemaResolvedTarget(parsed.target);
  return parsed;
}
export function resolveSchemaMetadata(
  text: (key: string) => string,
  root: () => string,
  id: string,
  fieldSelection: 'first' | 'last',
): SchemaRecord {
  if (!/^[a-f0-9]{64}$/.test(id)) fail('record address');
  const meta = schemaResolvedHeader(text('r:' + id));
  let cursor = id,
    depth = 0;
  while (cursor !== root()) {
    if (++depth > 128) fail('record ancestry');
    const edge = JSON.parse(text('p:' + cursor)) as {
      parent: string;
      ordinal: number;
      field: string | null;
    };
    const item =
      edge.field === null
        ? schemaResolvedOrder(text('o:' + edge.parent + ':' + schemaOrdinal(edge.ordinal))).target
        : fieldSelection === 'last'
          ? schemaResolvedTarget(JSON.parse(text('f:' + edge.parent + ':' + edge.field)))
          : schemaResolvedOrder(
              text(
                'o:' +
                  edge.parent +
                  ':' +
                  schemaOrdinal(Number(text('b:' + edge.parent + ':' + edge.field))),
              ),
            ).target;
    if (item.type !== 'record' || item.id !== cursor) fail('detached or shadowed record');
    cursor = edge.parent;
  }
  return meta;
}

/** Exact named-field grammar, shared by the fixed owner and custom-store fallback.
 * The caller must authenticate the record header and its complete ancestry. */
export function resolveSchemaFieldTarget(
  meta: SchemaRecord,
  id: string,
  name: string,
  fieldSelection: 'first' | 'last',
  read: (key: string) => unknown,
  text: (key: string) => string,
  chunks: (key: string) => Iterable<string>,
): SchemaTarget | undefined {
  if (meta.shape === 'scalar' && name === 'value') return { type: 'cell', id };
  const key = schemaKey(name);
  const value = read('f:' + id + ':' + key);
  if (value === undefined) return undefined;
  let selected = schemaResolvedTarget(
    JSON.parse(typeof value === 'string' ? value : fail('field descriptor')),
  );
  const ordinal = Number(text((fieldSelection === 'first' ? 'b:' : 'l:') + id + ':' + key));
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) fail('field ordinal');
  const entry = schemaResolvedOrder(text('o:' + id + ':' + schemaOrdinal(ordinal)));
  if (fieldSelection === 'first') selected = entry.target;
  if (
    entry.name === undefined ||
    hashIntakeJsonScalar(chunks('n:' + entry.name)).hash !== key ||
    JSON.stringify(entry.target) !== JSON.stringify(selected)
  )
    fail('field/order disagreement');
  return selected;
}
