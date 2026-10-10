/** Presentation derivative only. Exact syntax remains in the selected envelope. */
import {
  prepareIntakeFilenameFactsSteps,
  type IntakeFilenameFacts,
} from './intake-filename-facts.ts';

export const COMPACT_SCALAR_FORMAT = 'health-intake-source-scalar-v1';
export const COMPACT_SCALAR_BYTES = 16384;
export type IntakeCompactScalarField = 'originalName' | 'locator';
export interface IntakeCompactScalar {
  format: typeof COMPACT_SCALAR_FORMAT;
  field: IntakeCompactScalarField;
  scalarHash: string;
  bytes: number;
  preview: string;
  suffix: string;
  truncated: boolean;
}
export function compactIntakeScalar(
  field: IntakeCompactScalarField,
  facts: IntakeFilenameFacts,
): IntakeCompactScalar {
  return {
    format: COMPACT_SCALAR_FORMAT,
    field,
    scalarHash: facts.scalarHash,
    bytes: facts.bytes,
    preview: facts.preview,
    suffix: facts.suffix,
    truncated: facts.truncated,
  };
}
export function isIntakeCompactScalar(value: unknown): value is IntakeCompactScalar {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as IntakeCompactScalar;
  return (
    Object.keys(item).sort().join(',') ===
      'bytes,field,format,preview,scalarHash,suffix,truncated' &&
    item.format === COMPACT_SCALAR_FORMAT &&
    ['originalName', 'locator'].includes(item.field) &&
    typeof item.scalarHash === 'string' &&
    /^[a-f0-9]{64}$/.test(item.scalarHash) &&
    Number.isSafeInteger(item.bytes) &&
    item.bytes > COMPACT_SCALAR_BYTES &&
    typeof item.preview === 'string' &&
    item.preview.length <= 120 &&
    typeof item.suffix === 'string' &&
    item.suffix.length <= 64 &&
    typeof item.truncated === 'boolean' &&
    (!item.truncated || !/[\uD800-\uDBFF]$/.test(item.preview))
  );
}
export function* compactIntakeScalarSteps(
  field: IntakeCompactScalarField,
  pieces: Iterable<string>,
): Generator<void, IntakeCompactScalar> {
  return compactIntakeScalar(field, yield* prepareIntakeFilenameFactsSteps(pieces, ''));
}
export function intakeMetadataLabel(value: string | IntakeCompactScalar): string {
  return typeof value === 'string'
    ? value
    : value.preview + (value.truncated ? ' [shortened]' : '');
}
export function intakeMetadataScalarMatches(
  value: string | IntakeCompactScalar | undefined,
  exact: string | undefined,
): boolean {
  if (typeof value === 'string' || value === undefined) return value === exact;
  if (exact === undefined) return false;
  const steps = compactIntakeScalarSteps(value.field, [JSON.stringify(exact)]);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value.scalarHash === value.scalarHash;
  }
}
