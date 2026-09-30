import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { ModelContextLimitError, ModelError, privateAddress } from './model-config.ts';
import { isModelToolTerminalError, ModelToolValidationError } from './model-tool-validation.ts';
import { validateToolArguments } from './tool-arguments.ts';
import { diagnosticValidationPath } from './import-diagnostic-error.ts';
import {
  compactConsumedProxyHistory,
  compactIntakeMutationArguments,
  compactIntakeReadResult,
  proxyTranscriptLimit,
  proxyTranscriptSize,
  PROXY_TRANSCRIPT_LIMITS,
} from './proxy-transcript.ts';
import {
  importDiagnostics,
  structuralFields,
  beginImportPhase,
  measureImportPhase,
  diagnosticFailureFields,
  type ImportDiagnosticFields,
  type ImportDiagnosticContext,
  type ImportDiagnosticSink,
} from './import-diagnostics.ts';

type UnknownRecord = Record<string, unknown>;

// A turn may yield to automatic continuation, but may not reset whole-job budgets.
export const PROXY_MAX_TOOL_ROUNDS = 64;

function requestMediaCounts(body: unknown): { pdfParts: number; imageParts: number } {
  let pdfParts = 0,
    imageParts = 0;
  if (object(body) && Array.isArray(body.messages))
    for (const message of body.messages) {
      if (!object(message) || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (!object(part)) continue;
        if (
          part.type === 'file' &&
          object(part.file) &&
          typeof part.file.file_data === 'string' &&
          part.file.file_data.startsWith('data:application/pdf;base64,')
        )
          pdfParts++;
        if (part.type === 'image_url') imageParts++;
      }
    }
  return { pdfParts, imageParts };
}

export interface ToolSchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean';
  enum?: readonly unknown[];
  properties?: Record<string, ToolSchema>;
  required?: readonly string[];
  additionalProperties?: boolean | ToolSchema;
  items?: ToolSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

export interface HealthTool {
  type: 'function';
  name: string;
  description: string;
  inputSchema: ToolSchema;
}

export interface ProxyConfig {
  backend: 'litellm';
  model: string;
  baseUrl: string;
  apiKey: string;
  reasoning: null;
  images: boolean;
  pdf: boolean;
  /** Auto probes the selected route with fictional evidence; disabled is an operator opt-out. */
  pdfMode?: 'auto' | 'disabled';
  promptCache: boolean;
  localOnly: boolean;
  resolvedModel: string | null;
  timeoutSeconds: number;
}

export interface ProxyCapabilities {
  tools: true;
  images: boolean;
  pdf: boolean;
  promptCache: boolean;
  localOnly: boolean;
  evidence: 'private-proxy-endpoint-and-explicit-mapping' | 'explicit-proxy-configuration';
}

type ResolveHost = (
  hostname: string,
  options: { all: true },
) => Promise<readonly Pick<LookupAddress, 'address'>[]>;
type DiagnosticHandler = (diagnostic: string) => void;
type BridgeEventHandler = (method: string, params: UnknownRecord) => void;
type RetryDelay = (milliseconds: number, signal: AbortSignal) => Promise<void>;
type BridgeToolHandler = (request: {
  tool: string;
  arguments: UnknownRecord;
  callId: string;
  /** Host-only identity when a provider reuses a call ID in a later group. */
  attributionCallId?: string;
  /** Host-selected format capability, never a model-controlled tool argument. */
  pdf?: boolean;
  /** Production evidence cursors advance only after a valid later model response. */
  deferReadConsumption?: boolean;
}) => unknown | Promise<unknown>;

export interface ProxyModelBridgeOptions {
  config: ProxyConfig;
  /** Host-only budget gate evaluated immediately before each provider request. */
  beforeRequest?: () => void;
  durableRetries?: boolean;
  onEvent?: BridgeEventHandler;
  onTool?: BridgeToolHandler;
  onExit?: (error: ModelError) => void;
  fetchImpl?: typeof fetch;
  resolveHost?: ResolveHost;
  onDiagnostic?: DiagnosticHandler;
  diagnostics?: ImportDiagnosticSink;
  diagnosticContext?: ImportDiagnosticContext;
  /** Test seam for the cancellable bounded delay between transient provider attempts. */
  retryDelay?: RetryDelay;
}

interface ToolArgumentDiagnostic {
  code: string;
  field: string;
  allowedKeys?: string[];
}

interface ToolCallWire {
  type: 'function';
  id: string;
  function: { name: string; arguments: string };
}

interface ParsedToolCall {
  id: string;
  name: string;
  args: UnknownRecord;
  wire: ToolCallWire;
}

type ProxyMessage = UnknownRecord & {
  role: string;
  content: unknown;
  tool_calls?: ToolCallWire[];
};

interface ProxyHistoryGroup {
  consumed: boolean;
  calls: Array<{
    successful: boolean;
    compacted: boolean;
    compactArguments: string | null;
    wire: ToolCallWire;
  }>;
  // Tool results are aliased here so compaction can reach them. `wire` is the
  // same object pushed into `messages`; the compaction flag stays beside it so
  // no host-only field is ever serialised into the request body.
  results: Array<{
    hasMedia?: boolean;
    hasEvidenceText?: boolean;
    attributionCallId?: string;
    compactContent: string | null;
    compacted: boolean;
    wire: ProxyMessage;
  }>;
  imageMessage: ProxyMessage | null;
  imageCompacted: boolean;
  pdfFallbacks: Array<{
    part: UnknownRecord;
    read: (() => Promise<unknown>) | null;
    result: ProxyHistoryGroup['results'][number];
    tool: string;
    arguments: UnknownRecord;
  }>;
}

const fail = (message: string): never => {
  throw new ModelError(message);
};
const object = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const toolSchema = (value: unknown): value is ToolSchema => {
  if (!object(value)) return false;
  if (value.properties !== undefined) {
    if (!object(value.properties)) return false;
    if (!Object.values(value.properties).every(toolSchema)) return false;
  }
  if (value.items !== undefined && !toolSchema(value.items)) return false;
  return true;
};
const modelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;
const proxyErrorBodyLimit = 16 * 1024;
const responsesTransformFailure = 'Unknown items in responses API response: []';
// Hoisted so the byte-stable static prefix (`messages[0]`) can be kept
// identical across rounds when prompt caching is enabled: the notice becomes
// a separate system message instead of being concatenated onto the
// instructions. Off (the default), it is concatenated exactly as before.
const CONTINUATION_NOTICE =
  '\n\nThis request continues the same response after scoped tools. The opening response has already been attempted. Do not greet or introduce yourself again, even if the original conversation context says firstAssistantResponse. Continue from the retained assistant text and tool results without repeating it. Keep substantive findings in response text; if health_assistant_progress is registered, use it only for transient working status.';
const maxConsecutiveToolArgumentErrors = 3;
const transientAvailabilityRetryDelaysMs = [1000, 2000] as const;

interface ProxyRequestFailure {
  status: number;
  classification: string;
  retryAfterMs?: number;
}

const proxyRequestFailures = new WeakMap<ModelError, ProxyRequestFailure>();
const successfulStatuses = new WeakMap<object, number>();
/** HTTP Retry-After is an interval or absolute HTTP date, never document content. */
export function proxyRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value) * 1000
    : Date.parse(value) - now;
  return Number.isFinite(seconds) && seconds >= 0 && now + seconds <= 8.64e15 ? seconds : undefined;
}

export function isUnsupportedPdfError(error: unknown): boolean {
  const failure = error instanceof ModelError ? proxyRequestFailures.get(error) : undefined;
  return (
    !!failure && [400, 422].includes(failure.status) && failure.classification === 'pdf_unsupported'
  );
}

export function isUnsupportedImageError(error: unknown): boolean {
  const failure = error instanceof ModelError ? proxyRequestFailures.get(error) : undefined;
  return (
    !!failure &&
    [400, 422].includes(failure.status) &&
    failure.classification === 'image_unsupported'
  );
}

function proxyRequestError(
  message: string,
  status: number,
  classification: string,
  retryAfterMs?: number,
): ModelError {
  const error = new ModelError(message);
  proxyRequestFailures.set(error, { status, classification, retryAfterMs });
  return error;
}

function cancellableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function fieldPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function toolArgumentDiagnostic(
  value: unknown,
  schema: ToolSchema,
  path = 'arguments',
  depth = 0,
): ToolArgumentDiagnostic | null {
  if (depth > 30) return { code: 'nesting_too_deep', field: path };
  if (schema.enum && !schema.enum.includes(value))
    return { code: 'outside_allowed_choices', field: path };
  if (schema.type === 'object') {
    if (!object(value)) return { code: 'expected_object', field: path };
    for (const key of schema.required || [])
      if (!Object.hasOwn(value, key))
        return {
          code: 'missing_required_field',
          field: fieldPath(path, key),
          allowedKeys: Object.keys(schema.properties || {}),
        };
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key];
      if (!childSchema) {
        if (schema.additionalProperties === false)
          return {
            code: 'unknown_field',
            field: `${path}[unknown]`,
            allowedKeys: Object.keys(schema.properties || {}),
          };
      } else {
        const diagnostic = toolArgumentDiagnostic(
          child,
          childSchema,
          fieldPath(path, key),
          depth + 1,
        );
        if (diagnostic) return diagnostic;
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return { code: 'expected_array', field: path };
    if (value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? 10000))
      return { code: 'invalid_array_length', field: path };
    for (const [index, child] of value.entries()) {
      const diagnostic = toolArgumentDiagnostic(
        child,
        schema.items || {},
        `${path}[${index}]`,
        depth + 1,
      );
      if (diagnostic) return diagnostic;
    }
  } else if (schema.type === 'string') {
    if (
      typeof value !== 'string' ||
      value.length < (schema.minLength || 0) ||
      value.length > (schema.maxLength ?? 1000000)
    )
      return { code: 'invalid_text', field: path };
  } else if (schema.type === 'integer' || schema.type === 'number') {
    if (
      !Number.isFinite(value) ||
      (schema.type === 'integer' && !Number.isSafeInteger(value)) ||
      (typeof value === 'number' && value < (schema.minimum ?? -Infinity)) ||
      (typeof value === 'number' && value > (schema.maximum ?? Infinity))
    )
      return { code: 'invalid_number', field: path };
  } else if (schema.type === 'boolean' && typeof value !== 'boolean')
    return { code: 'invalid_boolean', field: path };
  return null;
}

function argumentError(tool: string, diagnostic: ToolArgumentDiagnostic) {
  return {
    error: {
      code: 'invalid_tool_arguments',
      message:
        'This registered tool call failed schema validation. Correct the indicated field and retry the complete tool-call batch.',
      tool,
      field: diagnostic.field,
      problem: diagnostic.code,
      ...(diagnostic.allowedKeys ? { allowedKeys: diagnostic.allowedKeys } : {}),
    },
  };
}

function rejectedSibling(tool: string) {
  return {
    error: {
      code: 'tool_batch_rejected',
      message:
        'No tool in this response was run because another registered tool call failed schema validation. Retry the complete tool-call batch.',
      tool,
    },
  };
}

async function inspectProxyError(
  response: Response,
  capture?: (text: string, truncated: boolean) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '',
    bytes = 0;
  let truncated = false;
  try {
    const reader = response.body?.getReader();
    if (!reader) return 'unclassified';
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const remaining = proxyErrorBodyLimit - bytes;
      if (part.value.byteLength > remaining) {
        truncated = true;
        text += decoder.decode(part.value.subarray(0, remaining));
        await reader.cancel();
        break;
      }
      bytes += part.value.byteLength;
      text += decoder.decode(part.value, { stream: true });
      if (bytes === proxyErrorBodyLimit) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    text += decoder.decode();
  } catch {
    return 'unclassified';
  }
  capture?.(text, truncated);
  try {
    const body: unknown = JSON.parse(text);
    const error = object(body) && object(body.error) ? body.error : null;
    if (
      error &&
      ['context_length_exceeded', 'context_window_exceeded'].includes(
        String(error.code || error.type),
      )
    )
      return 'context_limit';
    if (
      error &&
      ['unsupported_file_type', 'unsupported_pdf', 'pdf_not_supported'].includes(
        String(error.code || error.type),
      )
    )
      return 'pdf_unsupported';
    if (
      error &&
      ['unsupported_image', 'image_not_supported', 'vision_not_supported'].includes(
        String(error.code || error.type),
      )
    )
      return 'image_unsupported';
  } catch {
    /* Untrusted error prose never supplies a context-limit classification. */
  }
  // Retry only an explicit format rejection, never corrupt files, size limits,
  // authentication errors, timeouts, or generic invalid-request failures.
  if (
    /\b(?:pdf|application\/pdf|input_file|file_data)\b/i.test(text) &&
    /\b(?:unsupported|not supported|does not support|doesn't support|not allowed|unrecognized|unknown)\b/i.test(
      text,
    )
  )
    return 'pdf_unsupported';
  if (
    /\b(?:model|route)\b.{0,100}\b(?:does not support|doesn't support)\b.{0,60}\b(?:images?|image inputs?|vision)\b/i.test(
      text,
    ) ||
    /\bimage inputs?\b.{0,60}\b(?:not supported|unsupported)\b/i.test(text)
  )
    return 'image_unsupported';
  // The proxy or upstream provider rejecting the `cache_control` field as an
  // unrecognized/unsupported request parameter is otherwise indistinguishable
  // from any other opaque 400 — see the actionable message this classification
  // enables in proxyRequest. Never used to auto-retry without the field: that
  // silent reroute is exactly what docs/setup/docker-ai.md forbids.
  if (
    /cache_control/i.test(text) &&
    /unrecognized|unexpected|unknown|not allowed|unsupported|invalid/i.test(text)
  )
    return 'prompt_cache_unsupported';
  return text.includes(responsesTransformFailure) ? 'responses-to-chat-transform' : 'unclassified';
}

function reportProxyFailure(
  onDiagnostic: DiagnosticHandler | undefined,
  correlationId: string,
  status: number | null,
  durationMs: number,
  classification: string,
): void {
  const diagnostic = {
    event: 'litellm_proxy_request_failed',
    correlationId,
    status,
    durationMs,
    classification,
  };
  try {
    (onDiagnostic || console.error)(JSON.stringify(diagnostic));
  } catch {
    // Diagnostics must not replace the safe request failure returned to the application.
  }
}

// model-config owns the archive-secret-location check. This parser validates
// the proxy mapping without exposing credentials in public configuration.
export function validateProxyConfig(
  env: NodeJS.ProcessEnv = process.env,
  common: { apiKey?: string | null } = {},
): Readonly<ProxyConfig> {
  const candidateModel = env.CRS_AI_MODEL?.trim();
  const model =
    candidateModel && modelPattern.test(candidateModel)
      ? candidateModel
      : fail('CRS_AI_MODEL must be an exact LiteLLM proxy model alias.');
  const configuredBaseUrl =
    env.CRS_AI_BASE_URL ?? fail('CRS_AI_BASE_URL is required for LiteLLM Proxy.');
  const baseUrl = (() => {
    try {
      return new URL(configuredBaseUrl);
    } catch {
      return fail('The LiteLLM Proxy endpoint must be an HTTP(S) origin.');
    }
  })();
  if (
    !['http:', 'https:'].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    baseUrl.pathname !== '/'
  )
    fail('The LiteLLM Proxy endpoint must be an origin without credentials, query, or path.');
  if (env.CRS_AI_API_KEY && env.CRS_AI_API_KEY_FILE)
    fail('Set only one LiteLLM credential setting: API key or key file.');
  let apiKey: string | null | undefined = Object.hasOwn(common, 'apiKey')
    ? common.apiKey
    : env.CRS_AI_API_KEY || null;
  if (!Object.hasOwn(common, 'apiKey') && env.CRS_AI_API_KEY_FILE) {
    try {
      apiKey = readFileSync(env.CRS_AI_API_KEY_FILE, 'utf8').trim();
    } catch {
      fail('The LiteLLM credential file could not be read.');
    }
    if (!apiKey) fail('The LiteLLM credential file is empty.');
  }
  const verifiedApiKey =
    apiKey ??
    fail('LiteLLM Proxy requires a virtual key or master key supplied outside the health archive.');
  if (!verifiedApiKey)
    fail('LiteLLM Proxy requires a virtual key or master key supplied outside the health archive.');
  if (verifiedApiKey.length > 16000 || /[\r\n\x00]/.test(verifiedApiKey))
    fail('The LiteLLM credential is invalid.');
  const images =
    env.CRS_AI_PROXY_IMAGES === 'true'
      ? true
      : env.CRS_AI_PROXY_IMAGES === 'false' || !env.CRS_AI_PROXY_IMAGES
        ? false
        : fail('CRS_AI_PROXY_IMAGES must be true or false.');
  const pdf =
    env.CRS_AI_PROXY_PDF === 'true'
      ? true
      : env.CRS_AI_PROXY_PDF === 'false' || env.CRS_AI_PROXY_PDF === 'auto' || !env.CRS_AI_PROXY_PDF
        ? false
        : fail('CRS_AI_PROXY_PDF must be true or false, or auto.');
  // Absence must degrade silently in behaviour (no breakpoint sent) but visibly
  // in diagnostics — unlike `images`, a missing cache costs money and time, not
  // correctness, so this never fails closed the way `dataImage` does.
  const promptCache =
    env.CRS_AI_PROXY_PROMPT_CACHE === 'true'
      ? true
      : env.CRS_AI_PROXY_PROMPT_CACHE === 'false' || !env.CRS_AI_PROXY_PROMPT_CACHE
        ? false
        : fail('CRS_AI_PROXY_PROMPT_CACHE must be true or false.');
  const localOnly =
    env.CRS_AI_PROXY_LOCAL_ONLY === 'true'
      ? true
      : env.CRS_AI_PROXY_LOCAL_ONLY === 'false' || !env.CRS_AI_PROXY_LOCAL_ONLY
        ? false
        : fail('CRS_AI_PROXY_LOCAL_ONLY must be true or false.');
  const resolvedModel = env.CRS_AI_PROXY_RESOLVED_MODEL?.trim() || null;
  if (resolvedModel && !modelPattern.test(resolvedModel))
    fail('CRS_AI_PROXY_RESOLVED_MODEL must be a model identifier.');
  if (localOnly && !resolvedModel)
    fail(
      'Local-only LiteLLM Proxy requires CRS_AI_PROXY_RESOLVED_MODEL from its verified Ollama mapping.',
    );
  if (
    localOnly &&
    resolvedModel &&
    /(?:cloud|https?:|openai|anthropic|azure|bedrock|vertex|gemini)/i.test(resolvedModel)
  )
    fail('Local-only LiteLLM Proxy requires a local Ollama model identity.');
  if (env.CRS_AI_REASONING_EFFORT)
    fail(
      'LiteLLM Proxy reasoning effort must be configured in the selected proxy model; CRS_AI_REASONING_EFFORT is unsupported.',
    );
  const timeoutValue = env.CRS_AI_PROXY_TIMEOUT_SECONDS ?? '300';
  if (!/^\d+$/.test(timeoutValue) || Number(timeoutValue) < 30 || Number(timeoutValue) > 600)
    fail('CRS_AI_PROXY_TIMEOUT_SECONDS must be an integer from 30 to 600.');
  return Object.freeze({
    backend: 'litellm',
    model,
    baseUrl: baseUrl.origin,
    apiKey: verifiedApiKey,
    reasoning: null,
    images,
    pdf,
    pdfMode: env.CRS_AI_PROXY_PDF === 'false' ? 'disabled' : 'auto',
    promptCache,
    localOnly,
    resolvedModel,
    timeoutSeconds: Number(timeoutValue),
  });
}
export const proxyConfig = validateProxyConfig;

// A local-only declaration is not proof of an upstream's hardware or routing.
// It does, however, prevent the app from sending the request to a public proxy
// and pins an HTTP request to the checked private address before it is sent.
export async function localProxyTransport(
  config: ProxyConfig,
  resolveHost: ResolveHost = lookup,
): Promise<{ requestOrigin: string; hostHeader: string } | null> {
  if (!config?.localOnly) return null;
  const url = new URL(config.baseUrl),
    host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: readonly Pick<LookupAddress, 'address'>[] = [];
  try {
    addresses = isIP(host) ? [{ address: host }] : await resolveHost(host, { all: true });
  } catch {
    fail('The local LiteLLM Proxy address could not be resolved.');
  }
  if (!addresses.length || addresses.some((item) => !privateAddress(item.address)))
    fail('Local-only LiteLLM Proxy requires a loopback or private-network endpoint.');
  const address = addresses[0].address;
  if (url.protocol === 'https:' && host !== address)
    fail(
      'Local-only LiteLLM Proxy HTTPS requires a literal private IP endpoint; use HTTP for trusted local DNS names.',
    );
  const hostHeader = url.host;
  url.hostname = address.includes(':') ? `[${address}]` : address;
  return { requestOrigin: url.origin, hostHeader };
}

function scopedTools(tools: unknown): Map<string, HealthTool> {
  const arrayTools = Array.isArray(tools)
    ? tools
    : fail('Only unique scoped health tools can be registered.');
  if (
    arrayTools.some(
      (tool) =>
        !object(tool) ||
        tool.type !== 'function' ||
        typeof tool.name !== 'string' ||
        !/^health_[a-z][a-z0-9_]*$/.test(tool.name),
    ) ||
    new Set(arrayTools.map((tool) => (object(tool) ? tool.name : undefined))).size !==
      arrayTools.length
  )
    fail('Only unique scoped health tools can be registered.');
  const result = new Map<string, HealthTool>();
  for (const tool of arrayTools) {
    if (
      !object(tool) ||
      tool.type !== 'function' ||
      typeof tool.name !== 'string' ||
      typeof tool.description !== 'string' ||
      !toolSchema(tool.inputSchema)
    )
      fail('Only unique scoped health tools can be registered.');
    result.set(tool.name, {
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
  }
  return result;
}

// Millisecond sub-timings that arrive as fractional host measurements. Rounded
// to integers before recording so the diagnostics export stays readable.
const HOST_TIMING_MS_FIELDS = new Set([
  'queueWaitMs',
  'sessionSetupMs',
  'base64Ms',
  'verifyMs',
  'textMs',
  'renderMs',
  'encodeMs',
  'annotationMs',
  'nativePdfMs',
]);

// `readIntakeEvidence` attaches host-side sub-timings as a sibling `hostTimings`
// field on its return value (never inside `.metadata`, which is what reaches
// the model). Extract just the finite numeric fields, plus the small set of
// booleans the host also records there (e.g. `firstRead`), so they land as
// top-level diagnostic fields on `model.tool.completed` — counts, durations
// and flags only, never health content.
function hostTimingFields(value: unknown): Record<string, number | boolean> {
  if (!object(value) || !object(value.hostTimings)) return {};
  const fields: Record<string, number | boolean> = {};
  for (const [key, raw] of Object.entries(value.hostTimings)) {
    if (typeof raw === 'boolean') {
      fields[key] = raw;
      continue;
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    fields[key] = HOST_TIMING_MS_FIELDS.has(key) ? Math.max(0, Math.round(raw)) : raw;
  }
  return fields;
}

function dataImage(value: unknown, capable: boolean) {
  if (!object(value) || !value.imageContent) return null;
  if (!capable)
    fail(
      'This proxy model is not configured for image evidence. Select a verified vision alias explicitly.',
    );
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-zA-Z0-9+/=]+)$/.exec(
    typeof value.imageContent === 'string' ? value.imageContent : '',
  );
  const verifiedMatch = match ?? fail('The host supplied an unsupported image.');
  return { url: verifiedMatch[0], metadata: value.metadata };
}

function dataPdf(value: unknown, capable: boolean) {
  if (!object(value) || !value.pdfContent) return null;
  if (!capable) fail('This proxy model is not configured for PDF evidence.');
  if (value.imageContent) fail('The host supplied ambiguous PDF and image evidence.');
  const match = /^data:application\/pdf;base64,([a-zA-Z0-9+/=]+)$/.exec(
    typeof value.pdfContent === 'string' ? value.pdfContent : '',
  );
  const verified = match ?? fail('The host supplied an unsupported PDF.');
  if (!Buffer.from(verified[1].slice(0, 12), 'base64').subarray(0, 5).equals(Buffer.from('%PDF-')))
    fail('The host supplied an unsupported PDF.');
  return {
    url: verified[0],
    metadata: value.metadata,
    fallback:
      typeof value.pdfFallback === 'function'
        ? (value.pdfFallback as () => Promise<unknown>)
        : null,
  };
}

export async function proxyRequest(
  config: ProxyConfig,
  body: unknown,
  {
    fetchImpl = fetch,
    signal,
    requestOrigin,
    hostHeader,
    onDiagnostic,
    createCorrelationId = randomUUID,
    now = () => performance.now(),
    createTimeoutSignal = (milliseconds: number) => AbortSignal.timeout(milliseconds),
    diagnostics = importDiagnostics,
    diagnosticContext,
  }: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    requestOrigin?: string;
    hostHeader?: string;
    onDiagnostic?: DiagnosticHandler;
    createCorrelationId?: () => string;
    now?: () => number;
    createTimeoutSignal?: (milliseconds: number) => AbortSignal;
    diagnostics?: ImportDiagnosticSink;
    diagnosticContext?: ImportDiagnosticContext;
  } = {},
): Promise<unknown> {
  if (config.localOnly && !requestOrigin)
    fail('Local-only LiteLLM Proxy endpoint was not verified.');
  const correlationId = createCorrelationId();
  const startedAt = now();
  const timeoutMs = signal ? (config.timeoutSeconds ?? 300) * 1000 : 15000;
  const requestContext = { ...diagnosticContext, providerRequestId: correlationId };
  diagnostics.capturePayload?.('model.request', body, requestContext, [config.apiKey]);
  const requestBytes = diagnostics.enabled
    ? (() => {
        try {
          return Buffer.byteLength(JSON.stringify(body));
        } catch {
          return 0;
        }
      })()
    : null;
  diagnostics.record(
    'model.request.started',
    {
      model: config.model,
      timeoutMs,
      requestBytes,
      ...requestMediaCounts(body),
      ...(diagnostics.enabled ? structuralFields('request', body) : {}),
    },
    requestContext,
  );
  const timeoutSignal = createTimeoutSignal(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const requestFailure = () => {
    const classification = signal?.aborted
      ? 'cancelled'
      : timeoutSignal.aborted
        ? 'timeout'
        : 'transport';
    const elapsed = now() - startedAt;
    reportProxyFailure(
      onDiagnostic,
      correlationId,
      null,
      Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0,
      classification,
    );
    diagnostics.record(
      'model.request.failed',
      { classification, status: null, durationMs: Math.max(0, Math.round(elapsed)), requestBytes },
      requestContext,
    );
    const message =
      classification === 'cancelled'
        ? 'AI request cancelled.'
        : classification === 'timeout'
          ? `LiteLLM Proxy request timed out after ${timeoutMs / 1000} seconds. No fallback was attempted.`
          : 'LiteLLM Proxy connection failed. Check the selected proxy. No fallback was attempted.';
    fail(`${message} Reference: ${correlationId}.`);
  };
  let response: Response | undefined;
  try {
    requestSignal.throwIfAborted();
    response = await fetchImpl((requestOrigin || config.baseUrl) + '/v1/chat/completions', {
      method: 'POST',
      redirect: 'error',
      signal: requestSignal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
        ...(hostHeader ? { host: hostHeader } : {}),
      },
      body: JSON.stringify(body),
    });
    requestSignal.throwIfAborted();
  } catch {
    requestFailure();
  }
  const receivedResponse =
    response ?? fail('LiteLLM Proxy connection failed. No fallback was attempted.');
  if (!receivedResponse.ok) {
    const inspectedClassification = await inspectProxyError(receivedResponse, (text, truncated) =>
      diagnostics.capturePayload?.(
        'model.response',
        { status: receivedResponse.status, errorBody: text, truncated },
        requestContext,
        [config.apiKey],
        { truncated },
      ),
    );
    if (requestSignal.aborted) requestFailure();
    const classification =
      receivedResponse.status === 429
        ? 'quota'
        : [401, 403].includes(receivedResponse.status)
          ? 'authentication'
          : receivedResponse.status === 503
            ? 'transient_availability'
            : [400, 422].includes(receivedResponse.status) &&
                ['pdf_unsupported', 'image_unsupported'].includes(inspectedClassification)
              ? inspectedClassification
              : receivedResponse.status === 500 ||
                  ([400, 413].includes(receivedResponse.status) &&
                    ['context_limit', 'prompt_cache_unsupported'].includes(inspectedClassification))
                ? inspectedClassification
                : 'unclassified';
    const elapsed = now() - startedAt;
    reportProxyFailure(
      onDiagnostic,
      correlationId,
      receivedResponse.status,
      Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0,
      classification,
    );
    diagnostics.record(
      'model.request.failed',
      {
        classification,
        status: receivedResponse.status,
        durationMs: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0,
        requestBytes,
      },
      requestContext,
    );
    const reference = ` Reference: ${correlationId}.`;
    if (classification === 'context_limit' && [400, 413].includes(receivedResponse.status)) {
      const error = new ModelContextLimitError(
        `The selected model reached its context limit. Completed work is kept; productive import reading can continue with a fresh context.${reference}`,
        'provider',
      );
      proxyRequestFailures.set(error, { status: receivedResponse.status, classification });
      throw error;
    }
    const message =
      classification === 'responses-to-chat-transform'
        ? `LiteLLM could not translate the selected model's Responses API reply (HTTP ${receivedResponse.status}). Check the selected proxy model's Responses-to-chat compatibility, then retry.${reference}`
        : classification === 'prompt_cache_unsupported'
          ? `LiteLLM Proxy rejected the prompt-cache request field (HTTP ${receivedResponse.status}). Set CRS_AI_PROXY_PROMPT_CACHE=false and retry.${reference}`
          : receivedResponse.status === 401 || receivedResponse.status === 403
            ? `LiteLLM Proxy authentication failed.${reference}`
            : receivedResponse.status === 429
              ? `LiteLLM Proxy rate limit reached. Retry later.${reference}`
              : receivedResponse.status === 404
                ? `The selected LiteLLM Proxy model or endpoint was not found.${reference}`
                : `LiteLLM Proxy request failed (HTTP ${receivedResponse.status}).${reference}`;
    throw proxyRequestError(
      message,
      receivedResponse.status,
      classification,
      proxyRetryAfterMs(receivedResponse.headers.get('retry-after')),
    );
  }
  let text = '';
  let bytes = 0;
  let responseFailureRecorded = false;
  const failResponse = (classification: string, message: string): never => {
    diagnostics.record(
      'model.request.failed',
      {
        classification,
        status: receivedResponse.status,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
        requestBytes,
        responseBytes: bytes,
      },
      requestContext,
    );
    responseFailureRecorded = true;
    return fail(message);
  };
  try {
    // Reader acquisition can throw too (for example, an already locked body).
    // A bodyless 2xx is a failed provider reply, never a completed request.
    const reader =
      receivedResponse.body?.getReader() ??
      failResponse('empty_response', 'LiteLLM Proxy returned an empty response.');
    const decoder = new TextDecoder();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8 * 1024 * 1024) {
        await reader.cancel();
        diagnostics.omitPayload?.('model.response', 'response_size', requestContext);
        failResponse('response_size', 'AI response exceeded the supported size.');
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    requestSignal.throwIfAborted();
  } catch (error) {
    // Only our already-recorded protocol failures bypass transport handling;
    // a stream may reject with any error type and still needs a terminal event.
    if (responseFailureRecorded) throw error;
    requestFailure();
  }
  diagnostics.capturePayload?.(
    'model.response',
    { status: receivedResponse.status, responseBody: text },
    requestContext,
    [config.apiKey],
    { truncated: false },
  );
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object')
      successfulStatuses.set(parsed, receivedResponse.status);
    const counts = usage(parsed)?.total;
    diagnostics.record(
      'model.request.completed',
      {
        status: receivedResponse.status,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
        requestBytes,
        responseBytes: bytes,
        inputTokens: counts?.inputTokens ?? null,
        outputTokens: counts?.outputTokens ?? null,
        totalTokens: counts?.totalTokens ?? null,
        cachedInputTokens: counts?.cachedInputTokens ?? null,
      },
      requestContext,
    );
    if (diagnostics.enabled)
      diagnostics.record(
        'model.response.shape',
        {
          ...structuralFields('response', parsed),
          choiceCount: object(parsed) && Array.isArray(parsed.choices) ? parsed.choices.length : 0,
          hasUsage: object(parsed) && object(parsed.usage),
        },
        requestContext,
      );
    return parsed;
  } catch {
    diagnostics.record(
      'model.request.failed',
      {
        classification: 'malformed_json',
        status: receivedResponse.status,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
        requestBytes,
        responseBytes: bytes,
      },
      requestContext,
    );
    fail('LiteLLM Proxy returned malformed JSON.');
  }
}

export async function proxyCapabilities(
  config: ProxyConfig,
  { resolveHost }: { resolveHost?: ResolveHost } = {},
): Promise<ProxyCapabilities> {
  if (!config?.model || !config?.baseUrl || !config?.apiKey)
    fail('LiteLLM Proxy configuration is incomplete.');
  if (config.localOnly) await localProxyTransport(config, resolveHost);
  return {
    tools: true,
    images: config.images === true,
    pdf: config.pdf === true,
    promptCache: config.promptCache === true,
    localOnly: config.localOnly === true,
    evidence: config.localOnly
      ? 'private-proxy-endpoint-and-explicit-mapping'
      : 'explicit-proxy-configuration',
  };
}

function usage(result: unknown) {
  if (!object(result) || !object(result.usage)) return null;
  const input = result.usage.prompt_tokens,
    output = result.usage.completion_tokens,
    total = result.usage.total_tokens;
  if (
    typeof input !== 'number' ||
    typeof output !== 'number' ||
    typeof total !== 'number' ||
    ![input, output, total].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    total !== input + output
  )
    return null;
  const cached = object(result.usage.prompt_tokens_details)
    ? result.usage.prompt_tokens_details.cached_tokens
    : undefined;
  return {
    total: {
      inputTokens: input,
      outputTokens: output,
      totalTokens: total,
      cachedInputTokens:
        typeof cached === 'number' && Number.isSafeInteger(cached) && cached >= 0 && cached <= input
          ? cached
          : null,
      cacheWriteInputTokens: null,
    },
  };
}

function parseCalls(message: UnknownRecord): ParsedToolCall[] {
  if (!Array.isArray(message.tool_calls)) return [];
  if (message.tool_calls.length > 32) fail('AI returned an excessive tool request.');
  const ids = new Set();
  return message.tool_calls.map((call): ParsedToolCall => {
    if (
      !object(call) ||
      call.type !== 'function' ||
      typeof call.id !== 'string' ||
      !call.id.trim() ||
      call.id.length > 2000 ||
      /[\x00-\x1f\x7f]/.test(call.id) ||
      ids.has(call.id) ||
      !object(call.function) ||
      typeof call.function.name !== 'string' ||
      !call.function.name ||
      call.function.name.length > 200 ||
      typeof call.function.arguments !== 'string'
    )
      fail('AI returned an unsupported tool request.');
    ids.add(call.id);
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments) as unknown;
    } catch {
      fail('AI returned malformed tool arguments.');
    }
    const parsedArguments = object(args)
      ? args
      : fail('AI returned tool arguments that were not an object.');
    return {
      id: call.id,
      name: call.function.name,
      args: parsedArguments,
      wire: {
        type: 'function',
        id: call.id,
        function: { name: call.function.name, arguments: call.function.arguments },
      },
    };
  });
}

export class ProxyModelBridge {
  readonly config: ProxyConfig;
  readonly onEvent: BridgeEventHandler;
  readonly onTool: BridgeToolHandler;
  readonly onExit: (error: ModelError) => void;
  readonly durableRetries: boolean;
  readonly beforeRequest: (() => void) | undefined;
  readonly fetchImpl: typeof fetch | undefined;
  readonly resolveHost: ResolveHost | undefined;
  readonly onDiagnostic: DiagnosticHandler | undefined;
  readonly diagnostics: ImportDiagnosticSink;
  readonly diagnosticContext: ImportDiagnosticContext | undefined;
  private readonly retryDelay: RetryDelay;
  readonly controller: AbortController;
  closed: boolean;
  ready = false;
  running = false;
  turnId: string | undefined;
  completion: Promise<void> | undefined;
  tools = new Map<string, HealthTool>();
  transport: { requestOrigin: string; hostHeader: string } | null = null;
  capabilities: ProxyCapabilities | undefined;
  instructions = '';

  constructor({
    config,
    beforeRequest,
    durableRetries = false,
    onEvent = () => {},
    onTool = async () => {},
    onExit = () => {},
    fetchImpl,
    resolveHost,
    onDiagnostic,
    diagnostics = importDiagnostics,
    diagnosticContext,
    retryDelay = cancellableDelay,
  }: ProxyModelBridgeOptions) {
    this.config = config;
    this.beforeRequest = beforeRequest;
    this.durableRetries = durableRetries;
    this.onEvent = onEvent;
    this.onTool = onTool;
    this.onExit = onExit;
    this.fetchImpl = fetchImpl;
    this.resolveHost = resolveHost;
    this.onDiagnostic = onDiagnostic;
    this.diagnostics = diagnostics;
    this.diagnosticContext = diagnosticContext;
    this.retryDelay = retryDelay;
    this.controller = new AbortController();
    this.closed = false;
  }
  async start(instructions: string, tools: HealthTool[]) {
    if (this.ready || this.closed) fail('AI connection is already started or closed.');
    if (typeof instructions !== 'string') fail('AI instructions must be text.');
    this.tools = scopedTools(tools);
    this.transport = await localProxyTransport(this.config, this.resolveHost);
    this.capabilities = await proxyCapabilities(this.config, { resolveHost: this.resolveHost });
    if (this.closed) fail('AI request cancelled.');
    this.instructions = instructions;
    this.ready = true;
    return {
      model: this.config.model,
      backend: this.config.backend,
      reasoningEffort: null,
      capabilities: this.capabilities,
    };
  }
  async turn(text: string) {
    if (!this.ready || this.closed || this.running)
      fail('Start an idle AI connection before sending a turn.');
    if (typeof text !== 'string') fail('AI turns must be text.');
    this.running = true;
    this.turnId = randomUUID();
    const turnContext = { ...this.diagnosticContext, turnId: this.turnId };
    this.onEvent('turn/started', { turn: { id: this.turnId } });
    this.completion = this.diagnostics
      .run(turnContext, () => this.loop(text))
      .catch((error) => {
        if (!this.closed)
          this.onExit(
            error instanceof ModelError
              ? error
              : new ModelError('AI returned an unsupported response.'),
          );
      })
      .finally(() => {
        this.running = false;
      });
    return { turn: { id: this.turnId } };
  }
  private async request(body: unknown, exposedCallIds: string[] = []): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      this.beforeRequest?.();
      const requestId = randomUUID();
      const serialized = JSON.stringify(body);
      const measuredEnvelope = proxyTranscriptSize(object(body) ? body : {});
      this.onEvent('model/requestStarted', {
        turnId: this.turnId,
        requestId,
        attempt: attempt + 1,
        startedAt: new Date().toISOString(),
        requestDigest: createHash('sha256').update(serialized).digest('hex'),
        requestBytes: Buffer.byteLength(serialized),
        model: this.config.model,
        requestFit: {
          policy: 'proxy-byte-envelope-v1',
          qualified: false,
          ...measuredEnvelope,
          maxTextCharacters: PROXY_TRANSCRIPT_LIMITS.textCharacters,
          maxMediaBytes: PROXY_TRANSCRIPT_LIMITS.mediaBytes,
          inputTokens: null,
          outputReserveTokens: null,
          maxResponseBytes: 8 * 1024 * 1024,
        },
        exposedCallIds,
        ...requestMediaCounts(body),
      });
      if (this.closed) return undefined;
      try {
        const result = await measureImportPhase(
          'provider_request',
          () =>
            proxyRequest(this.config, body, {
              fetchImpl: this.fetchImpl,
              signal: this.controller.signal,
              onDiagnostic: this.onDiagnostic,
              diagnostics: this.diagnostics,
              diagnosticContext: this.diagnosticContext,
              ...this.transport,
            }),
          { attempt: attempt + 1, ...requestMediaCounts(body) },
          this.diagnosticContext,
          this.diagnostics,
        );
        this.onEvent('model/requestFinished', {
          requestId,
          failed: false,
          outcome: 'response',
          classification: null,
          status:
            result && typeof result === 'object' ? (successfulStatuses.get(result) ?? null) : null,
          retryAt: null,
          finishedAt: new Date().toISOString(),
          usage: usage(result)?.total ?? null,
        });
        return result;
      } catch (error) {
        const failure = error instanceof ModelError ? proxyRequestFailures.get(error) : undefined;
        const rejected =
          !!failure && [400, 401, 403, 404, 413, 422, 429, 503].includes(failure.status);
        const classification =
          failure?.classification === 'transient_availability'
            ? 'transient'
            : failure?.classification === 'quota'
              ? 'quota'
              : failure?.classification === 'authentication'
                ? 'authentication'
                : failure?.classification === 'context_limit'
                  ? 'context_limit'
                  : ['pdf_unsupported', 'image_unsupported', 'prompt_cache_unsupported'].includes(
                        failure?.classification || '',
                      )
                    ? 'unsupported'
                    : rejected
                      ? 'invalid_request'
                      : 'unknown';
        const retryAt =
          rejected && ['quota', 'transient'].includes(classification)
            ? new Date(
                Date.now() +
                  Math.max(
                    1000,
                    failure?.retryAfterMs ?? (classification === 'quota' ? 60_000 : 1000),
                  ),
              ).toISOString()
            : null;
        this.onEvent('model/requestFinished', {
          requestId,
          failed: true,
          usage: null,
          finishedAt: new Date().toISOString(),
          outcome: rejected ? 'rejected' : 'unknown',
          classification,
          status: failure?.status ?? null,
          retryAt,
        });
        const baseDelay = transientAvailabilityRetryDelaysMs[attempt];
        const delay =
          baseDelay === undefined ? undefined : Math.max(baseDelay, failure?.retryAfterMs || 0);
        if (
          this.closed ||
          this.durableRetries ||
          delay === undefined ||
          delay > 60_000 ||
          failure?.status !== 503 ||
          failure.classification !== 'transient_availability'
        )
          throw error;
        await measureImportPhase(
          'provider_retry_backoff',
          () => this.retryDelay(delay, this.controller.signal),
          { attempt: attempt + 1, plannedDelayMs: delay },
          this.diagnosticContext,
          this.diagnostics,
        );
        if (this.closed) return undefined;
      }
    }
  }
  async loop(text: string): Promise<void> {
    const messages: ProxyMessage[] = [
      {
        role: 'system',
        // Explicit-cache providers order the prefix as tools, system, messages.
        // Marking a tool alone would leave these instructions outside the cache.
        // Keep the original string wire shape when the capability is disabled.
        content:
          this.capabilities?.promptCache === true
            ? [
                {
                  type: 'text',
                  text: this.instructions,
                  cache_control: { type: 'ephemeral' },
                },
              ]
            : this.instructions,
      },
      { role: 'user', content: text },
    ];
    const history: ProxyHistoryGroup[] = [];
    const exposedCallIds = () =>
      history.flatMap((group) =>
        group.results
          .filter(
            (result, index) =>
              group.calls[index]?.successful &&
              ((result.hasEvidenceText && !result.compacted) ||
                (result.hasMedia && !group.imageCompacted)),
          )
          .map((result) => result.attributionCallId)
          .filter((id): id is string => typeof id === 'string'),
      );
    const consumeHistory = () => {
      const callIds = history
        .filter((group) => !group.consumed)
        .flatMap((group) =>
          group.calls.filter((call) => call.successful).map((call) => call.wire.id),
        );
      if (callIds.length) this.onEvent('model/toolResultsConsumed', { callIds });
      const attributionCallIds = history
        .filter((group) => !group.consumed)
        .flatMap((group) =>
          group.results
            .filter((_result, index) => group.calls[index]?.successful)
            .map((result) => result.attributionCallId)
            .filter((id): id is string => typeof id === 'string'),
        );
      if (attributionCallIds.length)
        this.onEvent('model/evidenceAcknowledged', { attributionCallIds });
      for (const group of history) group.consumed = true;
    };
    let pdfEnabled = this.capabilities?.pdf === true;
    const tools = [...this.tools.values()].map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
    let inputTokens = 0,
      outputTokens = 0,
      consecutiveToolArgumentErrors = 0;
    let cachedInputTokens: number | null = 0;
    for (let round = 0; round < PROXY_MAX_TOOL_ROUNDS; round++) {
      if (this.closed) return;
      const request = {
        model: this.config.model,
        messages:
          round === 0
            ? messages
            : this.capabilities?.promptCache === true
              ? // Prompt caching on: keep messages[0] byte-identical to round 0 by
                // sending the continuation notice as a separate system
                // message, rather than folding it into the cached instructions.
                [
                  messages[0],
                  { role: 'system', content: CONTINUATION_NOTICE },
                  ...messages.slice(1),
                ]
              : // Prompt caching off (default): today's exact byte sequence,
                // unchanged — a deployment that has not opted in cannot regress.
                [
                  { role: 'system', content: this.instructions + CONTINUATION_NOTICE },
                  ...messages.slice(1),
                ],
        tools,
        tool_choice: 'auto',
        stream: false,
        disable_fallbacks: true,
      };
      const limit = proxyTranscriptLimit(request);
      if (limit) throw new ModelContextLimitError(limit.message, round === 0 ? 'initial' : 'slice');
      let rawResult: unknown;
      try {
        rawResult = await this.request(request, exposedCallIds());
      } catch (error) {
        if (error instanceof ModelContextLimitError)
          throw new ModelContextLimitError(error.message, round === 0 ? 'initial' : 'slice');
        const failure = error instanceof ModelError ? proxyRequestFailures.get(error) : undefined;
        const fallbacks = history
          .filter((group) => !group.imageCompacted)
          .flatMap((group) => group.pdfFallbacks);
        if (
          this.closed ||
          !pdfEnabled ||
          this.capabilities?.images !== true ||
          failure?.classification !== 'pdf_unsupported' ||
          ![400, 422].includes(failure.status) ||
          !fallbacks.length ||
          fallbacks.some((entry) => !entry.read)
        )
          throw error;
        // Only the evidence representation changes. The selected route, model,
        // tool calls, and already-completed writes are never replayed or changed.
        pdfEnabled = false;
        const fallbackStartedAt = performance.now();
        for (const entry of fallbacks) {
          if (this.closed) return;
          const replacement =
            dataImage(await entry.read!(), true) ??
            fail('The host could not supply scoped PDF image fallback.');
          entry.part.type = 'image_url';
          delete entry.part.file;
          entry.part.image_url = { url: replacement.url };
          entry.result.compactContent = compactIntakeReadResult(
            entry.tool,
            replacement.metadata,
            entry.arguments,
          );
          entry.result.wire.content =
            (entry.result.compacted && entry.result.compactContent) ||
            JSON.stringify(replacement.metadata);
        }
        for (const group of history) group.pdfFallbacks = [];
        this.onEvent('model/evidenceFallback', {
          format: 'png',
          reason: 'pdf_unsupported',
          pageCount: fallbacks.length,
          durationMs: Math.max(0, performance.now() - fallbackStartedAt),
        });
        const fallbackLimit = proxyTranscriptLimit(request);
        if (fallbackLimit)
          throw new ModelContextLimitError(
            fallbackLimit.message,
            round === 0 ? 'initial' : 'slice',
          );
        try {
          rawResult = await this.request(request, exposedCallIds());
        } catch (error) {
          if (error instanceof ModelContextLimitError)
            throw new ModelContextLimitError(error.message, round === 0 ? 'initial' : 'slice');
          throw error;
        }
      }
      if (this.closed) return;
      const result = object(rawResult)
        ? rawResult
        : fail('LiteLLM Proxy returned an unsupported response.');
      if (
        typeof result.model !== 'string' ||
        ![this.config.model, this.config.resolvedModel].filter(Boolean).includes(result.model)
      )
        fail(
          'LiteLLM Proxy returned a different model than the selected verified mapping. No fallback is allowed.',
        );
      const choices = Array.isArray(result.choices) ? result.choices : [];
      if (
        choices.length !== 1 ||
        !object(choices[0]) ||
        choices[0].index !== 0 ||
        !object(choices[0].message) ||
        choices[0].message.role !== 'assistant'
      )
        fail('LiteLLM Proxy returned an unsupported message.');
      const choice = object(choices[0])
        ? choices[0]
        : fail('LiteLLM Proxy returned an unsupported message.');
      const message = object(choice.message)
        ? choice.message
        : fail('LiteLLM Proxy returned an unsupported message.');
      const counts = usage(result);
      this.onEvent('model/requestUsage', { turnId: this.turnId, measured: !!counts });
      // Optional cache usage is a whole-turn total only when every request reports it.
      // A later known count must not turn an earlier unknown request into an apparent zero.
      cachedInputTokens =
        cachedInputTokens !== null && counts?.total.cachedInputTokens != null
          ? cachedInputTokens + counts.total.cachedInputTokens
          : null;
      if (counts) {
        inputTokens += counts.total.inputTokens;
        outputTokens += counts.total.outputTokens;
        this.onEvent('thread/tokenUsage/updated', {
          turnId: this.turnId,
          tokenUsage: {
            total: {
              ...counts.total,
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
              cachedInputTokens,
            },
          },
        });
      }
      if (
        message.content !== null &&
        message.content !== undefined &&
        typeof message.content !== 'string'
      )
        fail('AI returned invalid response text.');
      if (message.content)
        this.onEvent('item/completed', {
          item: { id: randomUUID(), type: 'agentMessage', text: message.content },
        });
      const calls = parseCalls(message);
      if (!calls.length) {
        if (choice.finish_reason !== 'stop')
          fail('AI response ended before completion. Partial work is retained.');
        consumeHistory();
        if (this.closed) return;
        this.onEvent('turn/completed', { turn: { id: this.turnId, status: 'completed' } });
        return;
      }
      if (choice.finish_reason !== 'tool_calls') fail('AI returned an incomplete tool request.');
      const diagnostics: Array<ToolArgumentDiagnostic & { index: number; tool: string }> = [];
      for (const [index, call] of calls.entries()) {
        const schema =
          this.tools.get(call.name)?.inputSchema ?? fail('AI requested an unregistered tool.');
        const diagnostic = toolArgumentDiagnostic(call.args, schema);
        if (diagnostic) diagnostics.push({ index, tool: call.name, ...diagnostic });
        else validateToolArguments(call.args, schema);
      }
      if (diagnostics.length) {
        consecutiveToolArgumentErrors += 1;
        const assistantMessage = {
          role: 'assistant',
          content: message.content ?? null,
          tool_calls: calls.map((call) => ({
            ...call.wire,
            function: { ...call.wire.function },
          })),
        };
        messages.push(assistantMessage);
        const byIndex = new Map(diagnostics.map((diagnostic) => [diagnostic.index, diagnostic]));
        for (const [index, call] of calls.entries()) {
          const diagnostic = byIndex.get(index);
          if (diagnostic)
            this.diagnostics.record(
              'model.tool.failed',
              {
                toolName: call.name,
                toolIndex: index,
                reasonCode: 'invalid_tool_arguments',
                errorType: 'model_tool_validation',
                errorCategory: 'validation',
                validationCode: diagnostic.code,
                validationPath: diagnosticValidationPath(diagnostic.field),
                dispatched: false,
              },
              this.diagnosticContext,
            );
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: JSON.stringify(
              diagnostic ? argumentError(call.name, diagnostic) : rejectedSibling(call.name),
            ),
          });
        }
        try {
          this.onDiagnostic?.(
            JSON.stringify({
              event: 'litellm_registered_tool_arguments_rejected',
              turnId: this.turnId,
              attempt: consecutiveToolArgumentErrors,
              errors: diagnostics.map(({ tool, field, code }) => ({ tool, field, problem: code })),
            }),
          );
        } catch {
          // Structural diagnostics must not replace the bounded correction response.
        }
        if (consecutiveToolArgumentErrors >= maxConsecutiveToolArgumentErrors)
          fail(
            `AI repeatedly returned invalid arguments for registered tool ${diagnostics[0].tool} at ${diagnostics[0].field}. Partial work is retained; continue explicitly to retry.`,
          );
        continue;
      }
      consecutiveToolArgumentErrors = 0;
      consumeHistory();
      if (this.closed) return;
      compactConsumedProxyHistory(history);
      for (const previous of history) if (previous.imageCompacted) previous.pdfFallbacks = [];
      // Reserve the last admitted request for consuming the preceding results.
      // Executing its new tools would leave their results outside every model
      // request when this loop ends. In particular, a host-read checkpoint would
      // then skip evidence the model never received when the next slice resumes.
      // No terminal-round tools (including mutations) have executed, so a fresh
      // context can safely choose its next operation from the retained state.
      if (round === PROXY_MAX_TOOL_ROUNDS - 1)
        throw new ModelContextLimitError(
          'AI reached the bounded tool-call limit before dispatching another tool group. Partial work is retained. Productive import reading can continue with a fresh context.',
          'slice',
        );
      const assistantMessage = {
        role: 'assistant',
        content: message.content ?? null,
        // Later compaction changes only this transient projection. Never mutate
        // the provider response or parsed arguments used for app execution.
        tool_calls: calls.map((call) => ({
          ...call.wire,
          function: { ...call.wire.function },
        })),
      };
      messages.push(assistantMessage);
      const group: ProxyHistoryGroup = {
        consumed: false,
        calls: calls.map((_call, index) => ({
          successful: false,
          compacted: false,
          compactArguments: null,
          wire: assistantMessage.tool_calls[index],
        })),
        results: [],
        imageMessage: null,
        imageCompacted: false,
        pdfFallbacks: [],
      };
      const media: UnknownRecord[] = [];
      for (const [index, call] of calls.entries()) {
        const attributionCallId = randomUUID();
        if (this.closed) return;
        let value,
          toolError = false,
          terminalToolError = false;
        let toolFailureFields: ImportDiagnosticFields = {};
        const toolStartedAt = performance.now();
        this.diagnostics.capturePayload?.(
          'tool.request',
          {
            tool: call.name,
            arguments: call.args,
          },
          undefined,
          [this.config.apiKey],
        );
        this.diagnostics.record('model.tool.started', {
          toolName: call.name,
          toolIndex: index,
          ...(this.diagnostics.enabled ? structuralFields('arguments', call.args) : {}),
        });
        const toolSpan = beginImportPhase(
          'model_tool',
          { toolName: call.name, toolIndex: index },
          this.diagnosticContext,
          this.diagnostics,
        );
        try {
          value = await toolSpan.run(() =>
            this.onTool({
              tool: call.name,
              arguments: call.args,
              callId: call.id,
              attributionCallId,
              pdf: pdfEnabled,
              deferReadConsumption: true,
            }),
          );
          toolSpan.finish();
        } catch (error) {
          toolFailureFields = diagnosticFailureFields(error);
          toolSpan.fail(error);
          toolError = true;
          terminalToolError = isModelToolTerminalError(error);
          value = {
            ...(error instanceof ModelToolValidationError
              ? { code: error.code }
              : object(error) && error.code === 'CONVERSION_COVERAGE_PENDING'
                ? { code: 'CONVERSION_COVERAGE_PENDING' }
                : {}),
            error:
              error instanceof ModelToolValidationError
                ? ['VERSION_CONFLICT', 'INTAKE_PLAN_CREATE_VERSION'].includes(error.code)
                  ? error.message
                  : error.message +
                    '\nCorrect the rejected proposal structure and resubmit. Preserve every original literal and leave unsupported claims unknown; no records were accepted.'
                : 'The scoped tool rejected this request. Refresh the record and review the required arguments before trying again.',
          };
        }
        if (this.closed) {
          if (!toolError || !terminalToolError) return;
          // A terminal host rejection can synchronously finish the assistant and
          // close this bridge before the awaited handler resumes here. The host
          // captured the exact private failure before closing; retain only this
          // allowlisted metadata reason and never dispatch a sibling tool.
          // The host captured this private response while executing inside the
          // tool phase. Keep its exact context for the public join after await
          // restores the surrounding turn, including explicit scope clears.
          toolSpan.run(() =>
            this.diagnostics.record(
              'model.tool.failed',
              {
                toolName: call.name,
                toolIndex: index,
                durationMs: Math.max(0, Math.round(performance.now() - toolStartedAt)),
                errorCode: 'tool_rejected_after_close',
                ...toolFailureFields,
                ...(this.diagnostics.enabled ? structuralFields('result', value) : {}),
              },
              this.diagnosticContext,
            ),
          );
          return;
        }
        this.diagnostics.capturePayload?.(
          'tool.response',
          {
            tool: call.name,
            failed: !!toolError,
            result: value,
          },
          undefined,
          [this.config.apiKey],
        );
        this.diagnostics.record(toolError ? 'model.tool.failed' : 'model.tool.completed', {
          toolName: call.name,
          toolIndex: index,
          durationMs: Math.max(0, Math.round(performance.now() - toolStartedAt)),
          ...toolFailureFields,
          ...hostTimingFields(value),
          ...(this.diagnostics.enabled ? structuralFields('result', value) : {}),
        });
        group.calls[index].successful = !toolError;
        if (!toolError)
          group.calls[index].compactArguments = compactIntakeMutationArguments(
            call.name,
            call.args,
          );
        const pdf = dataPdf(value, pdfEnabled);
        const image = pdf ? null : dataImage(value, this.capabilities?.images === true);
        const resultValue = pdf ? pdf.metadata : image ? image.metadata : (value ?? null);
        const resultMessage: ProxyMessage = {
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(resultValue),
          ...(toolError ? { name: call.name } : {}),
        };
        // Precompute the receipt while the exact original result is in hand,
        // the same way `compactArguments` is computed above. A failed call is
        // never compacted: its result is the correction the model must read.
        group.results.push({
          attributionCallId,
          hasMedia: !!pdf || !!image,
          hasEvidenceText: (() => {
            if (!object(resultValue)) return false;
            const original = object(resultValue.original) ? resultValue.original : resultValue;
            return (
              (typeof original.text === 'string' && original.text.length > 0) ||
              (typeof original.literal === 'string' && original.literal.length > 0) ||
              object(resultValue.structure)
            );
          })(),
          compactContent: toolError
            ? null
            : compactIntakeReadResult(call.name, resultValue, call.args),
          compacted: false,
          wire: resultMessage,
        });
        messages.push(resultMessage);
        if (image) media.push({ type: 'image_url', image_url: { url: image.url } });
        if (pdf) {
          const part = {
            type: 'file',
            file: { filename: 'scoped-page.pdf', file_data: pdf.url },
          };
          media.push(part);
          group.pdfFallbacks.push({
            part,
            read: pdf.fallback,
            result: group.results.at(-1)!,
            tool: call.name,
            arguments: call.args,
          });
        }
      }
      if (media.length) {
        group.imageMessage = {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'The immediately preceding scoped tool results include the following visual evidence. Each PDF contains only its scoped original page; use the original page references in tool metadata. Inspect the evidence before continuing.',
            },
            ...media,
          ],
        };
        messages.push(group.imageMessage);
      }
      history.push(group);
    }
    throw new ModelContextLimitError(
      'AI reached the bounded tool-call limit. Partial work is retained. Productive import reading can continue with a fresh context.',
      'slice',
    );
  }
  async cancel(): Promise<void> {
    this.close();
  }
  close(): void {
    this.closed = true;
    this.ready = false;
    this.controller.abort();
  }
}
