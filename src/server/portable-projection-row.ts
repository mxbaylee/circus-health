import type {
  IntakeJsonCanonicalHandle,
  PreparedIntakeJsonCanonical,
} from './intake-json-canonical.ts';
import { hashIntakeJsonScalarSteps } from './intake-json-scalar.ts';
import { portableJsonStringPieces } from './portable-json-pieces.ts';

export type PortableProjectionCell =
  | { readonly name: string; readonly kind: 'text'; readonly pieces: () => Iterable<string> }
  | { readonly name: string; readonly kind: 'number'; readonly value: number }
  | { readonly name: string; readonly kind: 'null' };

function scalar(
  tree: PreparedIntakeJsonCanonical,
  handle: IntakeJsonCanonicalHandle,
): { kind: 'number'; value: number } | { kind: 'null' } {
  let value: number | undefined;
  const steps = hashIntakeJsonScalarSteps(tree.pieces(handle), [], undefined, (number) => {
    value = number;
  });
  try {
    for (;;) {
      const step = steps.next();
      if (!step.done) continue;
      if (step.value.kind === 'null') return { kind: 'null' };
      if (step.value.kind !== 'number' || value === undefined)
        throw Error('Unsupported portable projection value');
      return { kind: 'number', value };
    }
  } finally {
    steps.return(undefined as never);
  }
}

/** Match only fresh target columns; unknown giant keys never become host strings. */
export function portableProjectionCells(
  tree: PreparedIntakeJsonCanonical,
  columns: readonly string[],
  ignoredFields: ReadonlySet<string> = new Set(),
): readonly PortableProjectionCell[] {
  if (tree.kind(tree.root) !== 'object') throw Error('Invalid portable projection row');
  const cells: PortableProjectionCell[] = [];
  const seen = new Set<string>();
  for (const field of tree.objectFields(tree.root)) {
    if ([...ignoredFields].some((name) => field.matches(name))) continue;
    const name = columns.find((candidate) => field.matches(candidate));
    if (!name || seen.has(name)) throw Error('Unknown portable projection column');
    seen.add(name);
    const kind = tree.kind(field.value);
    if (kind === 'string') {
      cells.push({
        name,
        kind: 'text',
        pieces: () => portableJsonStringPieces(tree, field.value),
      });
    } else if (kind === 'number' || kind === 'null') {
      cells.push({ name, ...scalar(tree, field.value) });
    } else throw Error('Unsupported portable projection value');
  }
  if (!cells.length) throw Error('Invalid portable projection row');
  return cells;
}
