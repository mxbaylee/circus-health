import type { TestContext } from 'node:test';
// Extraction plans pin model identity even when their fixture never runs inference.
// Keep those tests independent of the operator's provider settings and credentials.
export function fictionalModel(t: TestContext) {
  const settings = {
    HEALTH_AI_BACKEND: 'litellm',
    HEALTH_AI_MODEL: 'fictional-test-alias',
    HEALTH_AI_BASE_URL: 'http://fictional-proxy.invalid:4000',
    HEALTH_AI_API_KEY: 'fictional-test-key',
    HEALTH_AI_API_KEY_FILE: undefined,
    HEALTH_AI_REASONING_EFFORT: undefined,
    HEALTH_AI_PROXY_LOCAL_ONLY: undefined,
    HEALTH_AI_PROXY_RESOLVED_MODEL: undefined,
    HEALTH_AI_PROXY_IMAGES: 'false',
    HEALTH_AI_PROXY_PROMPT_CACHE: 'false',
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
