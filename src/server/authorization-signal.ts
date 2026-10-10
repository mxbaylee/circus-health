const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;

/** Closing owner seals must not enter a caller-supplied property accessor. */
export function authorizationSignalAborted(signal: AbortSignal): boolean {
  return Reflect.apply(aborted, signal, []) as boolean;
}
