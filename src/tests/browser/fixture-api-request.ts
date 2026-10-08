import type { APIRequestContext } from 'playwright';

type FetchOptions = Parameters<APIRequestContext['fetch']>[1];

export function fixtureApiHeaders(input?: Record<string, string>) {
  const headers = { ...input };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'connection') delete headers[key];
  }
  return { ...headers, Connection: 'close' };
}

// Fixture API calls must not leave an idle socket in Playwright's shared agent.
export function fetchFixtureApi(context: APIRequestContext, url: string, options?: FetchOptions) {
  return context.fetch(url, { ...options, headers: fixtureApiHeaders(options?.headers) });
}
