import type { APIRequestContext } from 'playwright';

type FetchOptions = Parameters<APIRequestContext['fetch']>[1];

export function fixtureApiHeaders(input?: Record<string, string>) {
  const headers = { ...input };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'connection') delete headers[key];
  }
  return { ...headers, Connection: 'close' };
}

// Close these fixture calls without leaving new idle sockets in the shared agent.
// A socket pooled by an earlier default request can still be reused once.
export function fetchFixtureApi(context: APIRequestContext, url: string, options?: FetchOptions) {
  return context.fetch(url, { ...options, headers: fixtureApiHeaders(options?.headers) });
}
