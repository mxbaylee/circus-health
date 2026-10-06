/** Availability evidence only. This module never returns error text or credential data. */
const TEXT_STATES = ['absent', 'text', 'non-text', 'unavailable'] as const;
export interface ErrorMetadata {
  nativeMessageState?: (typeof TEXT_STATES)[number];
  nativeStackState?: (typeof TEXT_STATES)[number];
  nativeCauseState?: 'absent' | 'present' | 'unavailable';
  nativeMessageLength?: number;
  nativeStackLength?: number;
}
export const ERROR_METADATA_LABELS = [
  ['nativeMessageState', 'native message availability (text not exported)'],
  ['nativeStackState', 'native stack availability (stack not exported)'],
  ['nativeCauseState', 'native cause availability (cause not exported)'],
  ['nativeMessageLength', 'native message character count'],
  ['nativeStackLength', 'native stack character count'],
] as const satisfies readonly (readonly [keyof ErrorMetadata, string])[];

export function validErrorMetadataField(key: keyof ErrorMetadata, value: unknown): boolean {
  if (key === 'nativeMessageLength' || key === 'nativeStackLength')
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (key === 'nativeCauseState')
    return value === 'absent' || value === 'present' || value === 'unavailable';
  return TEXT_STATES.includes(value as (typeof TEXT_STATES)[number]);
}

/** Observe each known property once without enumerating objects or invoking toString/toJSON. */
export function inspectErrorMetadata(error: unknown): ErrorMetadata {
  const output: ErrorMetadata = {};
  const object = error !== null && typeof error === 'object';
  for (const [field, stateKey, lengthKey] of [
    ['message', 'nativeMessageState', 'nativeMessageLength'],
    ['stack', 'nativeStackState', 'nativeStackLength'],
  ] as const) {
    try {
      const value = object
        ? Reflect.get(error as object, field)
        : field === 'message' && typeof error === 'string'
          ? error
          : undefined;
      output[stateKey] =
        value === undefined ? 'absent' : typeof value === 'string' ? 'text' : 'non-text';
      if (typeof value === 'string') output[lengthKey] = value.length;
    } catch {
      output[stateKey] = 'unavailable';
    }
  }
  try {
    output.nativeCauseState =
      object && Reflect.get(error as object, 'cause') !== undefined ? 'present' : 'absent';
  } catch {
    output.nativeCauseState = 'unavailable';
  }
  return output;
}
