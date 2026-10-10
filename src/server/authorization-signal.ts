const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const throwIfAborted = AbortSignal.prototype.throwIfAborted;

/** Closing owner seals must not enter a caller-supplied property accessor. */
export function authorizationSignalAborted(signal: AbortSignal): boolean {
  return Reflect.apply(aborted, signal, []) as boolean;
}

/** Preserve the native reason without consulting caller-owned methods or accessors. */
export function assertAuthorizationSignalRunning(signal: AbortSignal): void {
  Reflect.apply(throwIfAborted, signal, []);
}
