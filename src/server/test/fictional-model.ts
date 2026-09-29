import type { TestContext } from 'node:test';
// Extraction plans pin model identity even when their fixture never runs inference.
// Keep those tests independent of the operator's provider settings and credentials.
export function fictionalModel(t: TestContext) {
  const settings = {
    CRS_AI_BACKEND: 'litellm',
    CRS_AI_MODEL: 'fictional-test-alias',
    CRS_AI_BASE_URL: 'http://fictional-proxy.invalid:4000',
    CRS_AI_API_KEY: 'fictional-test-key',
    CRS_AI_API_KEY_FILE: undefined,
    CRS_AI_REASONING_EFFORT: undefined,
    CRS_AI_PROXY_LOCAL_ONLY: undefined,
    CRS_AI_PROXY_RESOLVED_MODEL: undefined,
    CRS_AI_PROXY_IMAGES: 'false',
    CRS_AI_PROXY_PROMPT_CACHE: 'false',
  };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(settings);
  t.after(() => apply(previous));
}
