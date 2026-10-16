/** Provisional bounded row staging from one selected portable generation. */
import type { PortableProjectionTransfer } from './portable-projection-transfer.ts';
import { portableProjectionCells } from './portable-projection-row.ts';
import { portableJsonStringPieces } from './portable-json-pieces.ts';
import { streamPortableJson } from './portable-json-stream.ts';
import type { PortableOriginalInventory } from './portable-original-inventory.ts';
import type { PortableSourceIndex } from './portable-source-index.ts';
import { withPortableSourceRecordCells } from './portable-source-record.ts';

type Expected = Readonly<{ bytes: number; sha256: string }>;

function startsWithPieces(pieces: Iterable<string>, prefix: string): boolean {
  let at = 0;
  for (const part of pieces)
    for (let index = 0; index < part.length; index++) {
      if (at === prefix.length) return true;
      if (part[index] !== prefix[at++]) return false;
    }
  return at === prefix.length;
}
type Result = Readonly<{
  header: Record<string, unknown>;
  rows: ReadonlyMap<string, number>;
  deferred: ReadonlyMap<string, number>;
}>;

/**
 * The transfer remains provisional. The caller must authenticate originals,
 * validate special tables, prove the complete selected inventory, and seal it.
 */
export function stagePortableGenerationRows(
  file: string,
  expected: Expected,
  schema: ReadonlyMap<string, readonly string[]>,
  transfer: PortableProjectionTransfer,
  checkpoint: () => void,
  deferredTables: ReadonlySet<string>,
  sourceIndex?: PortableSourceIndex,
  rawRecords?: Readonly<{ root: string; profileId: string }>,
  originals?: PortableOriginalInventory,
  initialOrdinals: ReadonlyMap<string, number> = new Map(),
  omitAppMetaPrefix?: string,
): Result {
  if (rawRecords && (!sourceIndex || deferredTables.has('source_records')))
    throw Error('Portable raw-source stage requires selected source index');
  const starts = new Map(initialOrdinals);
  for (const [table, ordinal] of starts)
    if (!schema.has(table) || !Number.isSafeInteger(ordinal) || ordinal < 0)
      throw Error('Portable selected row ordinal changed');
  const final = new Map<string, number>();
  const observed = new Map<string, number>();
  const finalFields = new Map<string, number>();
  const observedFields = new Map<string, number>();
  let rootTables = 0;
  const first = streamPortableJson(
    file,
    (name, field) => {
      checkpoint();
      const counts = field ? observedFields : observed;
      const finals = field ? finalFields : final;
      const occurrence = (counts.get(name) ?? 0) + 1;
      counts.set(name, occurrence);
      finals.set(name, occurrence);
    },
    () => {
      throw Error('Portable row unexpectedly hydrated');
    },
    expected,
    {
      tablesStart: () => {
        rootTables++;
        final.clear();
        observed.clear();
      },
      rowPieces: () => checkpoint(),
    },
  );
  checkpoint();

  const seen = new Map<string, number>();
  const seenFields = new Map<string, number>();
  const rows = new Map<string, number>();
  const deferred = new Map<string, number>();
  let selected = false;
  let selectedField = false;
  let currentRoot = 0;
  const second = streamPortableJson(
    file,
    (name, field) => {
      checkpoint();
      if (field) {
        selectedField = true;
        const occurrence = (seenFields.get(name) ?? 0) + 1;
        seenFields.set(name, occurrence);
        selected = occurrence === finalFields.get(name);
        if (selected) deferred.set(name, 0);
        return;
      }
      if (currentRoot !== rootTables) {
        selected = false;
        selectedField = false;
        return;
      }
      selectedField = false;
      const occurrence = (seen.get(name) ?? 0) + 1;
      seen.set(name, occurrence);
      selected = occurrence === final.get(name);
      if (!selected) return;
      if (name === 'source_records' && rawRecords) rows.set(name, starts.get(name) ?? 0);
      else if (deferredTables.has(name)) deferred.set(name, 0);
      else if (schema.has(name)) rows.set(name, starts.get(name) ?? 0);
      else throw Error('Unknown portable projection table: ' + name);
    },
    () => {
      throw Error('Portable row unexpectedly hydrated');
    },
    expected,
    {
      tablesStart: () => {
        currentRoot++;
        seen.clear();
      },
      rowPieces: (name, _pieces, parsed) => {
        checkpoint();
        if (!selected) return;
        if (name === 'source_records' && rawRecords) return;
        if (selectedField || deferredTables.has(name)) {
          deferred.set(name, (deferred.get(name) ?? 0) + 1);
          return;
        }
        const columns = schema.get(name);
        if (!columns) throw Error('Unknown portable projection table: ' + name);
        const ordinal = rows.get(name) ?? 0;
        if (!Number.isSafeInteger(ordinal) || ordinal < 0)
          throw Error('Portable selected row ordinal changed');
        if (name === 'app_meta' && omitAppMetaPrefix) {
          if (parsed.kind(parsed.root) !== 'object') throw Error('Invalid portable projection row');
          const key = parsed.field(parsed.root, 'key');
          if (
            key &&
            parsed.kind(key) === 'string' &&
            startsWithPieces(portableJsonStringPieces(parsed, key), omitAppMetaPrefix)
          )
            return;
        }
        const cells = portableProjectionCells(parsed, columns);
        if (originals && (name === 'source_files' || name === 'assets')) originals.add(name, cells);
        transfer.putRow(name, ordinal, cells);
        if (name === 'source_files' && sourceIndex) {
          const id = cells.find((cell) => cell.name === 'id');
          if (!id || id.kind !== 'text') throw Error('Portable source ID must be text');
          sourceIndex.add(id.pieces, () => _pieces);
        }
        rows.set(name, ordinal + 1);
      },
    },
  );
  checkpoint();
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw Error('Portable generation changed between row passes');
  if (seen.size !== final.size || [...seen].some(([name, count]) => count !== final.get(name)))
    throw Error('Portable generation table inventory changed');
  if (
    seenFields.size !== finalFields.size ||
    [...seenFields].some(([name, count]) => count !== finalFields.get(name))
  )
    throw Error('Portable generation field inventory changed');
  if (rawRecords) {
    let thirdRoot = 0;
    let active = false;
    const occurrences = new Map<string, number>();
    const third = streamPortableJson(
      file,
      (name, field) => {
        checkpoint();
        active = false;
        if (field || thirdRoot !== rootTables) return;
        const occurrence = (occurrences.get(name) ?? 0) + 1;
        occurrences.set(name, occurrence);
        active = name === 'source_records' && occurrence === final.get(name);
      },
      () => {
        throw Error('Portable row unexpectedly hydrated');
      },
      expected,
      {
        tablesStart: () => {
          thirdRoot++;
          occurrences.clear();
          active = false;
        },
        rowPieces: (name, _pieces, parsed) => {
          if (!active || name !== 'source_records') return;
          checkpoint();
          const columns = schema.get(name);
          if (!columns) throw Error('Unknown portable projection table: ' + name);
          const ordinal = rows.get(name) ?? 0;
          if (!Number.isSafeInteger(ordinal) || ordinal < 0)
            throw Error('Portable selected row ordinal changed');
          withPortableSourceRecordCells(
            parsed,
            columns,
            sourceIndex!,
            rawRecords.root,
            rawRecords.profileId,
            checkpoint,
            (cells) => transfer.putRow(name, ordinal, cells),
          );
          rows.set(name, ordinal + 1);
        },
      },
    );
    checkpoint();
    if (JSON.stringify(third) !== JSON.stringify(second))
      throw Error('Portable generation changed between raw-source passes');
  }
  return { header: second, rows, deferred };
}
