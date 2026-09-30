import { readFileSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { relative } from 'node:path';
import { validateProxyConfig } from './proxy-model-bridge.ts';
import type { ProxyConfig } from './proxy-model-bridge.ts';

export class ModelError extends Error {}
/** Distinguish a local reading slice from an initial or provider context rejection. */
export class ModelContextLimitError extends ModelError {
  readonly origin: 'slice' | 'initial' | 'provider';
  constructor(message: string, origin: 'slice' | 'initial' | 'provider') {
    super(message);
    this.origin = origin;
  }
}
const fail = (message: string): never => {
  throw new ModelError(message);
};
export function modelConfig(env: NodeJS.ProcessEnv = process.env): Readonly<ProxyConfig> {
  const backend = env.CRS_AI_BACKEND || 'litellm';
  if (backend !== 'litellm')
    fail(
      'Only LiteLLM Proxy is supported. Remove the legacy CRS_AI_BACKEND setting and configure the Docker LiteLLM service.',
    );
  if (env.CRS_AI_API_KEY && env.CRS_AI_API_KEY_FILE)
    fail('Set only one AI credential setting: API key or key file.');
  if (env.CRS_DATA_DIR && env.CRS_AI_API_KEY_FILE) {
    try {
      const data = realpathSync(env.CRS_DATA_DIR);
      for (const path of [env.CRS_AI_API_KEY_FILE].filter(Boolean)) {
        const rel = relative(data, realpathSync(path));
        if (!rel || !rel.startsWith('../'))
          fail('AI credentials must remain outside the health data directory.');
      }
    } catch (error) {
      if (error instanceof ModelError) throw error;
      fail('The AI credential location could not be verified.');
    }
  }
  let apiKey = env.CRS_AI_API_KEY || null;
  if (env.CRS_AI_API_KEY_FILE) {
    try {
      apiKey = readFileSync(env.CRS_AI_API_KEY_FILE, 'utf8').trim();
    } catch {
      fail('The AI credential file could not be read.');
    }
    if (!apiKey) fail('The AI credential file is empty.');
  }
  if (apiKey && (apiKey.length > 16000 || /[\r\n\x00]/.test(apiKey)))
    fail('The AI credential is invalid.');
  return validateProxyConfig(env, { apiKey });
}
export function publicModelConfig(config: ProxyConfig) {
  return {
    backend: config.backend,
    model: config.model,
    reasoningEffort: config.reasoning,
    endpoint: config.baseUrl,
    authentication: config.apiKey ? 'api-key' : 'none',
    localOnly: config.localOnly === true,
    // Declared transport support is distinct from the fictional text/image probe.
    declaredCapabilities: { pdf: config.pdf === true },
  };
}
export function privateAddress(address: string): boolean {
  if (address.startsWith('::ffff:')) return privateAddress(address.slice(7));
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  return address === '::1' || /^(fc|fd)[\da-f]{2}:/i.test(address);
}
