import { connectionMonitorActive, waitForConnection } from './connection.ts';
import { holdoutTrace } from './holdout-trace.ts';

type SharedRead = { controller: AbortController; result: Promise<Response>; users: number };
const reads = new Map<string, SharedRead>();
let epoch = 0;
/** New reads after a mutation must not join a pre-mutation snapshot. */
export function separateReadGeneration() {
  epoch++;
}

/** Only in-flight GETs are shared; no mutation replay or durable queue. */
export function readWithRecovery(url: string, options: RequestInit): Promise<Response> {
  const peopleRead = url.includes('/intakes/people/');
  const { signal, headers, ...rest } = options;
  const semanticHeaders = new Headers(headers);
  // Correlation identifies subscribers, not response content. Keep sharing safe
  // reads; all subscribers receive the same server request ID in the response.
  semanticHeaders.delete('X-Client-Request-ID');
  semanticHeaders.delete('X-Client-Operation-ID');
  const key = JSON.stringify([epoch, url, [...semanticHeaders.entries()], rest]);
  let shared = reads.get(key);
  if (!shared) {
    // Bound memory and time even when the local server stays unavailable.
    if (reads.size >= 64) {
      holdoutTrace('read.capacity-refused');
      return Promise.reject(new Error('Too many reads are waiting. Try again shortly.'));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    shared = { controller, users: 0, result: Promise.resolve(null as unknown as Response) };
    const entry = shared;
    shared.result = (async () => {
      const pull = async () => {
        if (peopleRead) holdoutTrace('people.read.fetch-start');
        const response = await fetch(url, { ...options, signal: controller.signal });
        if (peopleRead) holdoutTrace('people.read.headers');
        // Body transport failure is part of the same bounded safe-read attempt.
        const body = await response.arrayBuffer();
        if (peopleRead) holdoutTrace('people.read.body');
        return new Response(body.byteLength ? body : null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      };
      let response: Response | undefined;
      try {
        response = await pull();
        if ([502, 503, 504].includes(response.status) && connectionMonitorActive())
          response = undefined;
      } catch (error) {
        if (controller.signal.aborted || !connectionMonitorActive()) throw error;
      }
      if (!response) {
        await waitForConnection(controller.signal);
        if (controller.signal.aborted) throw new DOMException('Read cancelled.', 'AbortError');
        // One retry only, after a successful probe. Writes never enter this function.
        response = await pull();
      }
      if (peopleRead) holdoutTrace('people.read.response');
      return response;
    })().finally(() => {
      clearTimeout(timeout);
      if (reads.get(key) === entry) reads.delete(key);
    });
    reads.set(key, shared);
  }
  const entry = shared;
  entry.users++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (response?: Response, error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (--entry.users === 0) {
        entry.controller.abort();
        if (reads.get(key) === entry) reads.delete(key);
      }
      if (error) {
        if (peopleRead) holdoutTrace('people.read.failed');
        reject(error);
      } else {
        if (peopleRead) holdoutTrace('people.read.clone-start');
        let copy: Response;
        try {
          copy = response!.clone();
        } catch (cause) {
          if (peopleRead) holdoutTrace('people.read.clone-throw');
          reject(cause);
          return;
        }
        if (peopleRead) holdoutTrace('people.read.clone-done');
        resolve(copy);
        if (peopleRead) holdoutTrace('people.read.subscriber');
      }
    };
    const abort = () => finish(undefined, new DOMException('Read cancelled.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    entry.result.then(
      (response) => finish(response),
      (error) => finish(undefined, error),
    );
  });
}
