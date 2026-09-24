import { HttpError, required, type Database } from './database.ts';
import { getSourceRecord } from './queries.ts';
import type { SourceRecordFileView } from '../shared/api.ts';

// This is a read-only reconstruction of the already reconciled archive format,
// not an importer or a clinical projection. Literal numeric token spelling is
// retained in resolvedText (including decimals and integers beyond JS precision).
function parseLiteral(text: string) {
  return JSON.parse(text, (_key, value, context) =>
    typeof value === 'number' ? JSON.rawJSON(context.source) : value,
  );
}
export function resolvedSource(
  db: Database,
  id: string,
  {
    maxReferences = 100000,
    maxNodes = 1000000,
    maxBytes = 16 * 1024 * 1024,
    fileView = 'full',
  }: {
    maxReferences?: number;
    maxNodes?: number;
    maxBytes?: number;
    fileView?: SourceRecordFileView;
  } = {},
) {
  const base = required(db.prepare('SELECT * FROM source_records WHERE id=?').get(id)) as {
    provider_id: string | null;
    kind: string;
    raw_json: string;
  };
  const source = getSourceRecord(db, id, { fileView });
  const provider = base.provider_id;
  if (!provider)
    throw new HttpError(
      400,
      'NOT_FACTORED_SOURCE',
      'This record does not identify a factored source provider',
    );
  const poolKind = id.startsWith(provider + ':')
    ? id.slice(provider.length + 1).split(':')[0]
    : null;
  if (base.kind !== 'source_capture' && !['records', 'context', 'text'].includes(poolKind!))
    throw new HttpError(
      400,
      'NOT_FACTORED_SOURCE',
      'This record is not a factored archive source; its literal original is available in the raw view',
    );
  let referenceCount = 0,
    nodeCount = 0;
  const cache = new Map<string, unknown>();
  function lookup(reference: string) {
    if (!/^(records:r\d+|context:c\d+|text:t\d+)$/.test(reference))
      throw new HttpError(
        409,
        'INVALID_ARCHIVE_REFERENCE',
        'Invalid archive reference: ' + reference,
      );
    const fullId = provider + ':' + reference;
    if (!cache.has(fullId)) {
      const row = db
        .prepare('SELECT provider_id,raw_json FROM source_records WHERE id=?')
        .get(fullId);
      if (!row || row.provider_id !== provider)
        throw new HttpError(
          409,
          'MISSING_ARCHIVE_REFERENCE',
          'Missing same-provider archive reference: ' + reference,
        );
      const envelope = parseLiteral(row.raw_json as string);
      if (!envelope || typeof envelope !== 'object' || !Object.hasOwn(envelope, 'data'))
        throw new HttpError(
          409,
          'INVALID_ARCHIVE_REFERENCE',
          'Referenced pool envelope has no literal data: ' + reference,
        );
      cache.set(fullId, (envelope as Record<string, unknown>).data);
    }
    return { fullId, value: cache.get(fullId) };
  }
  function walk(value: unknown, active: Set<string>, depth = 0): unknown {
    if (++nodeCount > maxNodes || depth > 200)
      throw new HttpError(
        413,
        'SOURCE_VIEW_TOO_LARGE',
        'Source reconstruction exceeds the interactive view limit; use the preserved original files',
      );
    if (value === null || typeof value !== 'object' || JSON.isRawJSON(value)) return value;
    if (Array.isArray(value)) return value.map((item) => walk(item, active, depth + 1));
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$health_archive_ref') {
      const ref = (value as Record<string, unknown>).$health_archive_ref;
      if (typeof ref !== 'string')
        throw new HttpError(409, 'INVALID_ARCHIVE_REFERENCE', 'Archive reference must be text');
      if (++referenceCount > maxReferences)
        throw new HttpError(
          413,
          'SOURCE_VIEW_TOO_LARGE',
          'Too many references for the interactive view',
        );
      const { fullId, value: literal } = lookup(ref);
      if (!ref.startsWith('context:')) return literal; // records/text are terminal literal content.
      if (active.has(fullId))
        throw new HttpError(
          409,
          'CYCLIC_ARCHIVE_REFERENCE',
          'Cycle in archive context references: ' + ref,
        );
      const next = new Set(active);
      next.add(fullId);
      return walk(literal, next, depth + 1);
    }
    return Object.fromEntries(
      keys.map((key) => [key, walk((value as Record<string, unknown>)[key], active, depth + 1)]),
    );
  }
  const envelope = parseLiteral(base.raw_json) as Record<string, unknown>;
  let resolved;
  if (base.kind === 'source_capture') {
    if (!Object.hasOwn(envelope, 'content'))
      throw new HttpError(409, 'INVALID_ARCHIVE_SOURCE', 'Source capture has no content');
    resolved = walk(envelope.content, new Set());
  } else if (poolKind === 'context') resolved = walk(envelope.data, new Set([id]));
  else resolved = envelope.data;
  const resolvedText = JSON.stringify(resolved, null, 2);
  if (Buffer.byteLength(resolvedText) > maxBytes)
    throw new HttpError(
      413,
      'SOURCE_VIEW_TOO_LARGE',
      'Reconstructed source exceeds the interactive view limit; its preserved original files remain available',
    );
  return {
    source,
    resolvedText,
    referenceCount,
    providerId: provider,
    format: 'health-archive-v1',
    preservation:
      'Original raw envelope is unchanged. Reconstructed JSON preserves numeric token spelling and array order/repetition. Record and text pools remain literal; context references are expanded. This is a derived source view, not original transport bytes.',
  };
}
