/** Cold journal decoding without a second complete JSON-version string. */
import {
  prepareIntakeJsonCanonicalSteps,
  type IntakeJsonCanonicalHandle,
  type IntakeJsonCanonicalWork,
} from './intake-json-canonical.ts';
import { hashIntakeJsonScalarSteps } from './intake-json-scalar.ts';

export interface RecordJsonPieceWork {
  decodedScalars: number;
  maxScalarWindowCodeUnits: number;
  maxDecodedScalarCodeUnits: number;
  yields: number;
}

/** Scalar strings required by SQLite still materialize once. Containers and
 * giant numeric tokens are decoded through the authenticated parser's spool. */
export function* parseRecordJsonPiecesSteps(
  pieces: Iterable<string>,
  options: {
    assertRunning?: () => void;
    onParserWork?: (work: Readonly<IntakeJsonCanonicalWork>) => void;
    onWork?: (work: Readonly<RecordJsonPieceWork>) => void;
  } = {},
): Generator<void, unknown> {
  const work: RecordJsonPieceWork = {
    decodedScalars: 0,
    maxScalarWindowCodeUnits: 0,
    maxDecodedScalarCodeUnits: 0,
    yields: 0,
  };
  const tree = yield* prepareIntakeJsonCanonicalSteps(pieces, {
    mode: 'stringify',
    preserveNumbers: true,
    assertRunning: options.assertRunning,
    onWork: options.onParserWork,
  });
  const string = function* (pieces: Iterable<string>): Generator<void, string> {
    const parts: string[] = [];
    let window = '',
      length = 0;
    const scalar = hashIntakeJsonScalarSteps(pieces, [], (unit) => {
      window += unit;
      length += unit.length;
      work.maxScalarWindowCodeUnits = Math.max(work.maxScalarWindowCodeUnits, window.length);
      if (window.length === 4096) {
        parts.push(window);
        window = '';
      }
    });
    try {
      for (;;) {
        options.assertRunning?.();
        const next = scalar.next();
        if (next.done) break;
        work.yields++;
        yield;
      }
      if (window) parts.push(window);
      work.decodedScalars++;
      work.maxDecodedScalarCodeUnits = Math.max(work.maxDecodedScalarCodeUnits, length);
      return parts.join('');
    } finally {
      scalar.return(undefined as never);
    }
  };
  interface Pending {
    value: IntakeJsonCanonicalHandle;
    assign(value: unknown): void;
  }
  interface Frame {
    children: Iterator<{ value: IntakeJsonCanonicalHandle; name?: () => Iterable<string> }>;
    target: Record<string, unknown> | unknown[];
  }
  let result: unknown,
    pending: Pending | undefined = {
      value: tree.root,
      assign(value) {
        result = value;
      },
    },
    visits = 0;
  const stack: Frame[] = [];
  try {
    while (pending || stack.length) {
      options.assertRunning?.();
      if (pending) {
        const selected = pending,
          kind = tree.kind(selected.value);
        pending = undefined;
        if (kind === 'string') selected.assign(yield* string(tree.pieces(selected.value)));
        else if (kind === 'object') {
          const object: Record<string, unknown> = {};
          selected.assign(object);
          // Keep only one child iterator at each nesting level, not a queue of
          // every member of a wide retained record.
          stack.push({
            children: tree.objectFields(selected.value)[Symbol.iterator](),
            target: object,
          });
        } else if (kind === 'array') {
          const array: unknown[] = [];
          selected.assign(array);
          stack.push({
            children: (function* () {
              for (const item of tree.arrayItems(selected.value)) yield { value: item };
            })(),
            target: array,
          });
        } else if (kind === 'number') {
          let number: number | undefined;
          const scalar = hashIntakeJsonScalarSteps(
            tree.pieces(selected.value),
            [],
            undefined,
            (value) => {
              number = value;
            },
          );
          try {
            for (;;) {
              options.assertRunning?.();
              const next = scalar.next();
              if (next.done) break;
              work.yields++;
              yield;
            }
          } finally {
            scalar.return(undefined as never);
          }
          if (number === undefined) throw Error('Record numeric scalar missing');
          work.decodedScalars++;
          selected.assign(number);
        } else {
          selected.assign(
            kind === 'null' ? null : [...tree.pieces(selected.value)].join('') === 'true',
          );
          work.decodedScalars++;
        }
        if (++visits % 64 === 0) {
          work.yields++;
          yield;
        }
      }
      while (!pending && stack.length) {
        const frame = stack[stack.length - 1]!,
          next = frame.children.next();
        if (next.done) stack.pop();
        else {
          const child = next.value;
          if (Array.isArray(frame.target)) {
            const target = frame.target;
            pending = {
              value: child.value,
              assign(value) {
                target.push(value);
              },
            };
          } else {
            const target = frame.target,
              name = yield* string(child.name!());
            pending = {
              value: child.value,
              assign(value) {
                Object.defineProperty(target, name, {
                  value,
                  writable: true,
                  enumerable: true,
                  configurable: true,
                });
              },
            };
          }
        }
      }
    }
    options.assertRunning?.();
    return result;
  } finally {
    for (const frame of stack) frame.children.return?.();
    tree.close();
    options.onWork?.(Object.freeze({ ...work }));
  }
}
