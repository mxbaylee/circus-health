import { copyDiagnosticValidation } from './import-diagnostic-error.ts';
/** Explicit host-approved validation feedback; arbitrary application errors never use this path. */
export class ModelToolValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string, original?: unknown) {
    super(message.slice(0, 4000));
    this.name = 'ModelToolValidationError';
    this.code = code;
    copyDiagnosticValidation(this, original);
  }
}

// The bridge must distinguish a host tool rejection that synchronously ended
// the assistant from a late rejection after Stop/profile lock. Keep the marker
// process-local so it cannot become provider-visible data or be forged by a
// serialized model/tool payload.
const terminalToolErrors = new WeakSet<object>();

export function markModelToolTerminalError<T>(error: T): T {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function')
    terminalToolErrors.add(error as object);
  return error;
}

export function isModelToolTerminalError(error: unknown): boolean {
  return (
    ((typeof error === 'object' && error !== null) || typeof error === 'function') &&
    terminalToolErrors.has(error as object)
  );
}
