import { ERROR_MESSAGES } from './types.ts';
import type { ErrorCode } from './types.ts';
import { ERROR_METADATA_LABELS, inspectErrorMetadata, validErrorMetadataField } from './debug.ts';
import type { ErrorMetadata } from './debug.ts';

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
export const DIAGNOSTIC_STAGES = [
  'request-construction',
  'preflight',
  'native-create',
  'native-get',
  'credential-validation',
  'credential-match',
  'extension-read',
  'prf-validation',
  'key-derivation',
  'encryption',
  'decryption',
  'plaintext-comparison',
  'complete',
] as const;
export const VALIDATION_RULES = [
  'secure-context',
  'relying-party-scope',
  'required-browser-api',
  'alias-unused',
  'credential-unconfirmed',
  'credential-confirmed',
  'credential-returned',
  'credential-type',
  'credential-id-buffer',
  'credential-id-length',
  'extension-reader',
  'selected-credential',
  'distinct-credential',
  'prf-extension-present',
  'prf-results-present',
  'prf-output-present',
  'prf-output-buffer-length',
  'prf-output-array-length',
  'prf-output-array-bytes',
  'prf-output-base64url-length',
  'prf-output-base64url-alphabet',
  'prf-output-base64url-canonical',
  'prf-output-supported-shape',
  'fictional-decryption',
  'fictional-plaintext-match',
] as const;
export const NATIVE_ERROR_NAMES = [
  'NotAllowedError',
  'InvalidStateError',
  'NotSupportedError',
  'SecurityError',
  'AbortError',
  'UnknownError',
  'ConstraintError',
  'DataError',
  'OperationError',
  'NotReadableError',
  'TimeoutError',
  'EncodingError',
  'InvalidCharacterError',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'unrecognized',
] as const;
export type ValidationRule = (typeof VALIDATION_RULES)[number];
export interface PrfDiagnostics extends ErrorMetadata {
  requestMode: 'eval' | 'evalByCredential' | 'enable-only';
  operation?: 'create' | 'confirm' | 'verify';
  stage?: (typeof DIAGNOSTIC_STAGES)[number];
  applicationError?: ErrorCode;
  nativeErrorName?: (typeof NATIVE_ERROR_NAMES)[number];
  nativeErrorCategory?: 'dom-name' | 'js-name' | 'unrecognized';
  validationRule?: ValidationRule;
  allowCredentialCount?: number;
  excludedCredentialCount?: number;
  requestCredentialMatched?: boolean;
  userIdLength?: number;
  requiredUserVerification?: boolean;
  requiredResidentKey?: boolean;
  credentialReturned?: boolean;
  credentialTypeMatched?: boolean;
  credentialIdShape?: DiagnosticShape;
  credentialIdLength?: number;
  extensionReaderPresent?: boolean;
  arrayEntriesValid?: boolean;
  diagnosticsUnavailable?: boolean;
  inputShape: DiagnosticShape;
  /** Bytes for buffers/views, items for arrays, characters for strings. */
  inputLength?: number;
  extensionShape?: DiagnosticShape;
  resultsShape?: DiagnosticShape;
  extensionPresent?: boolean;
  resultsPresent?: boolean;
  outputShape?: DiagnosticShape;
  outputLength?: number;
  credentialMatched?: boolean;
  prfEnabled?: boolean;
  prfEnabledShape?: DiagnosticShape;
  residentCredentialReported?: boolean;
  credentialIdTextMatched?: boolean;
  attachmentHint?: 'platform' | 'cross-platform' | 'other';
  userActivationAtInvocation?: boolean;
  documentVisibleAtInvocation?: boolean;
  documentFocusedAtInvocation?: boolean;
  topLevelContext?: boolean;
  nativeOutcome?: 'returned' | 'threw' | 'rejected';
  nativeDuration?: 'under-1s' | '1-5s' | '5-15s' | '15-60s' | 'over-60s';
  nativeErrorCode?: number;
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
/** The report uses the same field list as the privacy projection. */
export const ADDITIONAL_DIAGNOSTIC_LABELS = [
  ...ERROR_METADATA_LABELS,
  ['prfEnabled', 'PRF enabled flag'],
  ['prfEnabledShape', 'PRF enabled flag shape'],
  ['residentCredentialReported', 'resident credential reported'],
  ['credentialIdTextMatched', 'returned id and rawId agree'],
  ['attachmentHint', 'authenticator attachment hint'],
  ['userActivationAtInvocation', 'user activation at native invocation'],
  ['documentVisibleAtInvocation', 'document visible at native invocation'],
  ['documentFocusedAtInvocation', 'document focused at native invocation'],
  ['topLevelContext', 'top-level browsing context'],
  ['nativeOutcome', 'native invocation outcome'],
  ['nativeDuration', 'native duration bucket'],
  ['nativeErrorCode', 'native numeric error code'],
] as const satisfies readonly (readonly [keyof PrfDiagnostics, string])[];
const FIELDS = [
  ...ADDITIONAL_DIAGNOSTIC_LABELS.map(([key]) => key),
  'operation',
  'stage',
  'applicationError',
  'nativeErrorName',
  'nativeErrorCategory',
  'validationRule',
  'allowCredentialCount',
  'excludedCredentialCount',
  'requestCredentialMatched',
  'userIdLength',
  'requiredUserVerification',
  'requiredResidentKey',
  'credentialReturned',
  'credentialTypeMatched',
  'credentialIdShape',
  'credentialIdLength',
  'extensionReaderPresent',
  'arrayEntriesValid',
  'diagnosticsUnavailable',
  'requestMode',
  'inputShape',
  'inputLength',
  'extensionShape',
  'resultsShape',
  'extensionPresent',
  'resultsPresent',
  'outputShape',
  'outputLength',
  'credentialMatched',
] as const;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength',
)!.get!;
const dataViewLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!;
/** Use native buffer slots rather than consulting arbitrary toStringTag accessors. */
export function diagnosticShape(value: unknown): { shape: DiagnosticShape; length?: number } {
  let type: DiagnosticShape, length: number | undefined;
  if (value === undefined) type = 'absent';
  else if (value === null) type = 'null';
  else if (Array.isArray(value)) {
    type = 'array';
    length = value.length;
  } else if (ArrayBuffer.isView(value)) {
    type = 'array-buffer-view';
    try {
      length = typedArrayLength.call(value);
    } catch {
      length = dataViewLength.call(value);
    }
  } else if (typeof value === 'object') {
    try {
      length = bufferLength.call(value);
      type = 'array-buffer';
    } catch {
      type = 'object';
    }
  } else if (typeof value === 'string') {
    type = 'string';
    length = value.length;
  } else if (typeof value === 'boolean') type = 'boolean';
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
  let inputShape: { shape: DiagnosticShape; length?: number };
  try {
    inputShape = diagnosticShape(input);
  } catch {
    return { requestMode, inputShape: 'other', diagnosticsUnavailable: true };
  }
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
  diagnostics.extensionPresent = prf !== undefined;
  try {
    diagnostics.extensionShape = diagnosticShape(prf).shape;
  } catch {
    diagnostics.diagnosticsUnavailable = true;
  }
  // Optional creation metadata cannot veto a valid output or a successful creation.
  try {
    const enabled = (prf as { enabled?: unknown } | undefined)?.enabled;
    if (enabled !== undefined) diagnostics.prfEnabledShape = diagnosticShape(enabled).shape;
    if (typeof enabled === 'boolean') diagnostics.prfEnabled = enabled;
  } catch {
    diagnostics.diagnosticsUnavailable = true;
  }
  try {
    const rk = (extensions as { credProps?: { rk?: unknown } } | undefined)?.credProps?.rk;
    if (typeof rk === 'boolean') diagnostics.residentCredentialReported = rk;
  } catch {
    diagnostics.diagnosticsUnavailable = true;
  }
  const results = prf?.results;
  diagnostics.resultsPresent = results !== undefined;
  try {
    diagnostics.resultsShape = diagnosticShape(results).shape;
  } catch {
    diagnostics.diagnosticsUnavailable = true;
  }
  const first = results?.first;
  try {
    const output = diagnosticShape(first);
    diagnostics.outputShape = output.shape;
    if (output.length !== undefined) diagnostics.outputLength = output.length;
  } catch {
    diagnostics.diagnosticsUnavailable = true;
  }
  return { prf: { results: { first } } };
}
function fieldValid(key: (typeof FIELDS)[number], value: unknown): boolean {
  switch (key) {
    case 'nativeMessageState':
    case 'nativeStackState':
    case 'nativeCauseState':
    case 'nativeMessageLength':
    case 'nativeStackLength':
      return validErrorMetadataField(key, value);
    case 'nativeErrorCode':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 25;
    case 'attachmentHint':
      return ['platform', 'cross-platform', 'other'].includes(value as string);
    case 'nativeOutcome':
      return ['returned', 'threw', 'rejected'].includes(value as string);
    case 'nativeDuration':
      return ['under-1s', '1-5s', '5-15s', '15-60s', 'over-60s'].includes(value as string);
    case 'operation':
      return ['create', 'confirm', 'verify'].includes(value as string);
    case 'stage':
      return DIAGNOSTIC_STAGES.includes(value as (typeof DIAGNOSTIC_STAGES)[number]);
    case 'validationRule':
      return VALIDATION_RULES.includes(value as ValidationRule);
    case 'nativeErrorName':
      return NATIVE_ERROR_NAMES.includes(value as (typeof NATIVE_ERROR_NAMES)[number]);
    case 'nativeErrorCategory':
      return ['dom-name', 'js-name', 'unrecognized'].includes(value as string);
    case 'applicationError':
      return typeof value === 'string' && Object.hasOwn(ERROR_MESSAGES, value);
    case 'allowCredentialCount':
    case 'excludedCredentialCount':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2;
    case 'userIdLength':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 64;
    case 'requestMode':
      return value === 'eval' || value === 'evalByCredential' || value === 'enable-only';
    case 'inputShape':
    case 'outputShape':
    case 'credentialIdShape':
    case 'extensionShape':
    case 'resultsShape':
    case 'prfEnabledShape':
      return SHAPES.includes(value as DiagnosticShape);
    case 'inputLength':
    case 'outputLength':
    case 'credentialIdLength':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65_536;
    default:
      return typeof value === 'boolean';
  }
}
/** Project a fresh copy without serializing unknown properties or evaluating accessors. */
export function projectPrfDiagnostics(value: unknown): PrfDiagnostics | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const projected: Record<string, unknown> = {};
  try {
    if (Array.isArray(value)) return undefined;
    for (const key of FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if (!('value' in descriptor) || !fieldValid(key, descriptor.value)) return undefined;
      projected[key] = descriptor.value;
    }
    if (!('requestMode' in projected) || !('inputShape' in projected)) return undefined;
    return projected as unknown as PrfDiagnostics;
  } catch {
    return undefined;
  }
}
/** Stored diagnostics reject unknown keys, in addition to validating the allowlisted projection. */
export function isPrfDiagnostics(value: unknown): value is PrfDiagnostics {
  if (!value || typeof value !== 'object') return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return (
      projectPrfDiagnostics(value) !== undefined &&
      Reflect.ownKeys(value as object).every(
        (key) => typeof key === 'string' && (FIELDS as readonly string[]).includes(key),
      )
    );
  } catch {
    return false;
  }
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

/** Bounded name and availability evidence; never retain the error's text or attached payload. */
export function nativeErrorEvidence(
  error: unknown,
): Pick<PrfDiagnostics, 'nativeErrorName' | 'nativeErrorCategory'> & ErrorMetadata {
  let name: unknown;
  try {
    name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  } catch {
    /* unknown remains bounded */
  }
  const nativeErrorName = NATIVE_ERROR_NAMES.includes(name as (typeof NATIVE_ERROR_NAMES)[number])
    ? (name as (typeof NATIVE_ERROR_NAMES)[number])
    : 'unrecognized';
  const nativeErrorCategory =
    nativeErrorName === 'unrecognized'
      ? 'unrecognized'
      : ['Error', 'TypeError', 'RangeError', 'SyntaxError'].includes(nativeErrorName)
        ? 'js-name'
        : 'dom-name';
  return { nativeErrorName, nativeErrorCategory, ...inspectErrorMetadata(error) };
}

/** Never await before invoking the operation: Safari needs the original button gesture. */
export async function observeNative<T>(
  diagnostics: PrfDiagnostics,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    const active = globalThis.navigator?.userActivation?.isActive;
    if (typeof active === 'boolean') diagnostics.userActivationAtInvocation = active;
  } catch {
    diagnostics.diagnosticsUnavailable = true;
  }
  try {
    if (typeof document !== 'undefined') {
      if (['visible', 'hidden'].includes(document.visibilityState))
        diagnostics.documentVisibleAtInvocation = document.visibilityState === 'visible';
      if (typeof document.hasFocus === 'function')
        diagnostics.documentFocusedAtInvocation = document.hasFocus();
    }
    if (typeof window !== 'undefined') diagnostics.topLevelContext = window.top === window.self;
  } catch {
    diagnostics.diagnosticsUnavailable = true;
  }
  let started: number | undefined;
  try {
    started = globalThis.performance?.now();
  } catch {
    diagnostics.diagnosticsUnavailable = true;
  }
  let returned = false;
  try {
    const pending = operation();
    returned = true;
    const result = await pending;
    diagnostics.nativeOutcome = 'returned';
    return result;
  } catch (error) {
    diagnostics.nativeOutcome = returned ? 'rejected' : 'threw';
    try {
      const code =
        error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      if (typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 25)
        diagnostics.nativeErrorCode = code;
    } catch {
      diagnostics.diagnosticsUnavailable = true;
    }
    throw error;
  } finally {
    try {
      const elapsed = started === undefined ? undefined : performance.now() - started;
      if (elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0)
        diagnostics.nativeDuration =
          elapsed < 1000
            ? 'under-1s'
            : elapsed < 5000
              ? '1-5s'
              : elapsed < 15000
                ? '5-15s'
                : elapsed < 60000
                  ? '15-60s'
                  : 'over-60s';
    } catch {
      diagnostics.diagnosticsUnavailable = true;
    }
  }
}
