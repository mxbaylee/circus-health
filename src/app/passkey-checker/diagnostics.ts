/** Allowlisted shape evidence only; never retain credential references or PRF contents. */
export type DiagnosticShape =
  | 'absent'
  | 'null'
  | 'array-buffer'
  | 'array-buffer-view'
  | 'array'
  | 'string'
  | 'object'
  | 'boolean'
  | 'number'
  | 'other';
export interface PrfDiagnostics {
  requestMode: 'eval' | 'evalByCredential';
  inputShape: DiagnosticShape;
  /** Bytes for buffers/views, items for arrays, characters for strings. */
  inputLength?: number;
  extensionPresent?: boolean;
  resultsPresent?: boolean;
  outputShape?: DiagnosticShape;
  outputLength?: number;
  credentialMatched?: boolean;
}
export type PrfDiagnosticsObserver = (diagnostics: PrfDiagnostics) => void;
export type DiagnosticObserver = PrfDiagnosticsObserver;
const SHAPES: readonly DiagnosticShape[] = [
  'absent',
  'null',
  'array-buffer',
  'array-buffer-view',
  'array',
  'string',
  'object',
  'boolean',
  'number',
  'other',
];
const FIELDS = [
  'requestMode',
  'inputShape',
  'inputLength',
  'extensionPresent',
  'resultsPresent',
  'outputShape',
  'outputLength',
  'credentialMatched',
] as const;
function shape(value: unknown): { shape: DiagnosticShape; length?: number } {
  let type: DiagnosticShape, length: number | undefined;
  if (value === undefined) type = 'absent';
  else if (value === null) type = 'null';
  else if (ArrayBuffer.isView(value)) {
    type = 'array-buffer-view';
    length = value.byteLength;
  } else if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    type = 'array-buffer';
    length = (value as ArrayBuffer).byteLength;
  } else if (Array.isArray(value)) {
    type = 'array';
    length = value.length;
  } else if (typeof value === 'string') {
    type = 'string';
    length = value.length;
  } else if (typeof value === 'object') type = 'object';
  else if (typeof value === 'boolean') type = 'boolean';
  else if (typeof value === 'number') type = 'number';
  else type = 'other';
  return {
    shape: type,
    ...(length !== undefined && Number.isInteger(length) && length >= 0 && length <= 65_536
      ? { length }
      : {}),
  };
}
export function describePrfRequest(
  requestMode: PrfDiagnostics['requestMode'],
  input: unknown,
): PrfDiagnostics {
  const inputShape = shape(input);
  return {
    requestMode,
    inputShape: inputShape.shape,
    ...(inputShape.length !== undefined ? { inputLength: inputShape.length } : {}),
  };
}
/** Capture first once for transient decoding; only the shape evidence enters diagnostics. */
export function describePrfResponse(
  diagnostics: PrfDiagnostics,
  extensions: unknown,
): { prf: { results: { first: unknown } } } {
  const prf = (extensions as { prf?: { results?: { first?: unknown } } } | undefined)?.prf;
  const results = prf?.results;
  const first = results?.first;
  const output = shape(first);
  diagnostics.extensionPresent = prf !== undefined;
  diagnostics.resultsPresent = results !== undefined;
  diagnostics.outputShape = output.shape;
  if (output.length !== undefined) diagnostics.outputLength = output.length;
  return { prf: { results: { first } } };
}
function fieldValid(key: (typeof FIELDS)[number], value: unknown): boolean {
  switch (key) {
    case 'requestMode':
      return value === 'eval' || value === 'evalByCredential';
    case 'inputShape':
    case 'outputShape':
      return SHAPES.includes(value as DiagnosticShape);
    case 'inputLength':
    case 'outputLength':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65_536;
    default:
      return typeof value === 'boolean';
  }
}
/** Project a fresh copy without serializing unknown properties or evaluating accessors. */
export function projectPrfDiagnostics(value: unknown): PrfDiagnostics | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const projected: Record<string, unknown> = {};
  for (const key of FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (!('value' in descriptor) || !fieldValid(key, descriptor.value)) return undefined;
    projected[key] = descriptor.value;
  }
  if (!('requestMode' in projected) || !('inputShape' in projected)) return undefined;
  return projected as unknown as PrfDiagnostics;
}
/** Stored diagnostics reject unknown keys, in addition to validating the allowlisted projection. */
export function isPrfDiagnostics(value: unknown): value is PrfDiagnostics {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return (
    projectPrfDiagnostics(value) !== undefined &&
    Reflect.ownKeys(value as object).every(
      (key) => typeof key === 'string' && (FIELDS as readonly string[]).includes(key),
    )
  );
}
/** An observer is optional evidence collection, and must never change a credential outcome. */
export function emitPrfDiagnostics(
  diagnostics: PrfDiagnostics,
  observer?: PrfDiagnosticsObserver,
): void {
  try {
    observer?.({ ...diagnostics });
  } catch {
    // Keep the native operation's result/error if an optional observer fails.
  }
}
