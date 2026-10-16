import type { IncomingMessage, ServerResponse } from 'node:http';

/** Response disconnects cancel this subscriber; ordinary parsed GET close does not. */
export function intakeIdentityRequestLifetime(req: IncomingMessage, res?: ServerResponse) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const closed = () => {
    if (!res?.writableFinished) abort();
  };
  req.once('aborted', abort);
  res?.once('close', closed);
  if (req.aborted || (res?.destroyed && !res.writableFinished)) abort();
  return {
    signal: controller.signal,
    dispose() {
      req.removeListener('aborted', abort);
      res?.removeListener('close', closed);
    },
  };
}
