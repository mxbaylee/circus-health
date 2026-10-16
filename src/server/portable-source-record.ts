/** Resolve a selected portable raw-source reference without hydrating its JSON. */
import type {
  IntakeJsonCanonicalHandle,
  PreparedIntakeJsonCanonical,
} from './intake-json-canonical.ts';
import { prepareIntakeJsonCanonicalSteps } from './intake-json-canonical.ts';
import { hashIntakeJsonScalarSteps } from './intake-json-scalar.ts';
import { portableJsonStringPieces } from './portable-json-pieces.ts';
import { portableProjectionCells, type PortableProjectionCell } from './portable-projection-row.ts';
import { openPortableRawRange } from './portable-raw-range.ts';
import type { PortableSourceIndex } from './portable-source-index.ts';
import { profileOriginal } from './profile-storage.ts';

function required(
  tree: PreparedIntakeJsonCanonical,
  parent: IntakeJsonCanonicalHandle,
  name: string,
  kind: 'object' | 'string' | 'number',
): IntakeJsonCanonicalHandle {
  const value = tree.field(parent, name);
  if (!value || tree.kind(value) !== kind) throw Error('Invalid canonical raw JSON reference');
  return value;
}

function number(tree: PreparedIntakeJsonCanonical, handle: IntakeJsonCanonicalHandle): number {
  let value: number | undefined;
  const steps = hashIntakeJsonScalarSteps(tree.pieces(handle), [], undefined, (found) => {
    value = found;
  });
  try {
    for (;;) {
      const step = steps.next();
      if (!step.done) continue;
      if (step.value.kind !== 'number' || value === undefined)
        throw Error('Invalid canonical raw JSON reference');
      return value;
    }
  } finally {
    steps.return(undefined as never);
  }
}

function string(
  tree: PreparedIntakeJsonCanonical,
  handle: IntakeJsonCanonicalHandle,
  maximum?: number,
): string {
  let value = '';
  for (const piece of portableJsonStringPieces(tree, handle)) {
    value += piece;
    if (maximum !== undefined && value.length > maximum)
      throw Error('Invalid canonical raw JSON reference');
  }
  return value;
}

function sameText(
  left: Iterable<string>,
  right: Iterable<string>,
  checkpoint: () => void,
): boolean {
  const a = left[Symbol.iterator]();
  const b = right[Symbol.iterator]();
  let x = a.next();
  let y = b.next();
  let atX = 0;
  let atY = 0;
  let equal = true;
  try {
    for (;;) {
      checkpoint();
      if (x.done || y.done) {
        if (!!x.done !== !!y.done) equal = false;
        if (!x.done) for (; !x.done; x = a.next()) checkpoint();
        if (!y.done) for (; !y.done; y = b.next()) checkpoint();
        return equal;
      }
      const count = Math.min(x.value.length - atX, y.value.length - atY);
      if (x.value.slice(atX, atX + count) !== y.value.slice(atY, atY + count)) equal = false;
      atX += count;
      atY += count;
      if (atX === x.value.length) {
        x = a.next();
        atX = 0;
      }
      if (atY === y.value.length) {
        y = b.next();
        atY = 0;
      }
    }
  } finally {
    a.return?.();
    b.return?.();
  }
}

function selectedSource(
  pieces: Iterable<string>,
  checkpoint: () => void,
): { path: string; bytes: number } {
  const steps = prepareIntakeJsonCanonicalSteps(pieces, {
    mode: 'stringify',
    assertRunning: checkpoint,
  });
  let source: PreparedIntakeJsonCanonical | undefined;
  try {
    for (;;) {
      const step = steps.next();
      if (!step.done) continue;
      source = step.value;
      break;
    }
    if (source.kind(source.root) !== 'object') throw Error('Invalid portable source row');
    const path = string(source, required(source, source.root, 'path', 'string'));
    const bytes = number(source, required(source, source.root, 'bytes', 'number'));
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('Invalid portable source row');
    return { path, bytes };
  } finally {
    source?.close();
    steps.return(undefined as never);
  }
}

/** Callback must consume every text cell synchronously within this tree's lifetime. */
export function withPortableSourceRecordCells<T>(
  tree: PreparedIntakeJsonCanonical,
  columns: readonly string[],
  sources: PortableSourceIndex,
  root: string,
  profileId: string,
  checkpoint: () => void,
  run: (cells: readonly PortableProjectionCell[]) => T,
): T {
  if (tree.kind(tree.root) !== 'object') throw Error('Invalid portable source row');
  const ref = tree.field(tree.root, 'raw_source');
  if (!ref) {
    const raw = tree.field(tree.root, 'raw_json');
    if (!raw || tree.kind(raw) !== 'string') throw Error('Missing verbatim source record');
    return run(portableProjectionCells(tree, columns));
  }
  if (tree.kind(ref) !== 'object' || tree.field(tree.root, 'raw_json'))
    throw Error('Invalid canonical raw JSON reference');
  const sourceId = required(tree, ref, 'sourceFileId', 'string');
  const recordSourceId = required(tree, tree.root, 'source_file_id', 'string');
  if (
    !sameText(
      portableJsonStringPieces(tree, sourceId),
      portableJsonStringPieces(tree, recordSourceId),
      checkpoint,
    )
  )
    throw Error('Invalid canonical raw JSON reference');
  const offset = number(tree, required(tree, ref, 'offset', 'number'));
  const bytes = number(tree, required(tree, ref, 'bytes', 'number'));
  const sha256 = string(tree, required(tree, ref, 'sha256', 'string'), 64);
  const source = sources.find(() => portableJsonStringPieces(tree, sourceId));
  if (!source) throw Error('Invalid canonical raw JSON reference');
  const selected = selectedSource(source(), checkpoint);
  const range = openPortableRawRange(
    profileOriginal(root, selected.path, profileId),
    selected.bytes,
    offset,
    bytes,
    sha256,
    checkpoint,
  );
  let primary: unknown;
  try {
    if (!columns.includes('raw_json')) throw Error('Unknown portable projection column');
    const cells = portableProjectionCells(tree, columns, new Set(['raw_source']));
    const result = run([
      ...cells,
      { name: 'raw_json', kind: 'text', pieces: () => range.pieces() },
    ]);
    range.assertComplete();
    return result;
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      range.close();
    } catch (error) {
      if (primary === undefined) throw error;
    }
  }
}
