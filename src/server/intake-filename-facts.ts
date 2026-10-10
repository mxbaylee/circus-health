/** Bounded derivative of one exact filename scalar, never a recovery authority. */
import { hashIntakeJsonScalarSteps } from './intake-json-scalar.ts';

export const FILENAME_FACTS_FORMAT = 'health-intake-filename-facts-v1';
export interface IntakeFilenameFacts {
  format: typeof FILENAME_FACTS_FORMAT;
  binding: string;
  scalarHash: string;
  bytes: number;
  preview: string;
  suffix: string;
  truncated: boolean;
}
export function parseIntakeFilenameFacts(raw: string): IntakeFilenameFacts {
  if (Buffer.byteLength(raw) > 4096) throw Error('Filename facts exceed their bounded budget');
  const value = JSON.parse(raw) as IntakeFilenameFacts;
  if (
    !value ||
    Object.keys(value).sort().join(',') !==
      'binding,bytes,format,preview,scalarHash,suffix,truncated' ||
    value.format !== FILENAME_FACTS_FORMAT ||
    typeof value.binding !== 'string' ||
    value.binding.length > 1024 ||
    typeof value.scalarHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.scalarHash) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    typeof value.preview !== 'string' ||
    value.preview.length > 120 ||
    typeof value.suffix !== 'string' ||
    value.suffix.length > 64 ||
    typeof value.truncated !== 'boolean' ||
    (value.truncated && /[\uD800-\uDBFF]$/.test(value.preview))
  )
    throw Error('Invalid prepared filename facts');
  return value;
}
export function* prepareIntakeFilenameFactsSteps(
  pieces: Iterable<string>,
  binding: string,
): Generator<void, IntakeFilenameFacts> {
  let preview = '',
    suffix = '',
    units = 0,
    bytes = 0;
  const counted = function* () {
    for (const piece of pieces) {
      bytes += Buffer.byteLength(piece);
      yield piece;
    }
  };
  const scalar = yield* hashIntakeJsonScalarSteps(counted(), [], (unit) => {
    if (units++ < 120) preview += unit;
    suffix = (suffix + unit).slice(-64);
  });
  if (scalar.kind !== 'string') throw Error('The selected filename is not a JSON string');
  const truncated = units > 120;
  if (truncated && /[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
  return {
    format: FILENAME_FACTS_FORMAT,
    binding,
    scalarHash: scalar.hash,
    bytes,
    preview,
    suffix,
    truncated,
  };
}
