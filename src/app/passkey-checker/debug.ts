/** Full local diagnostics for fictional checker credentials only. No production imports. */
export const DEBUG_SCHEMA = 'circus-passkey-debug-v1';
export const DEBUG_LIMITS = {
  reportCharacters: 4 * 1024 * 1024,
  valueCharacters: 1024 * 1024,
  binaryBytes: 512 * 1024,
  nodes: 20_000,
  depth: 20,
  events: 500,
} as const;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const unavailable = (reason: string): Json => ({ $unavailable: reason });
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;

/** Lossless ordinary values and binary bytes; explicit markers for unavailable or bounded data. */
export function debugValue(value: unknown): Json {
  let nodes = 0;
  let characters = 0;
  const seen = new WeakMap<object, string>();
  const visit = (input: unknown, path: string, depth: number): Json => {
    if (++nodes > DEBUG_LIMITS.nodes || depth > DEBUG_LIMITS.depth)
      return { $omitted: 'node/depth limit' };
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') {
      const remaining = Math.max(0, DEBUG_LIMITS.valueCharacters - characters);
      characters += Math.min(input.length, remaining);
      return input.length <= remaining
        ? input
        : { $truncated: input.slice(0, remaining), originalCharacters: input.length };
    }
    if (typeof input === 'number') return Number.isFinite(input) ? input : { $number: String(input) };
    if (typeof input === 'undefined') return { $undefined: true };
    if (typeof input === 'bigint') return { $bigint: String(input) };
    if (typeof input !== 'object') return { $type: typeof input };
    if (seen.has(input)) return { $reference: seen.get(input)! };
    seen.set(input, path);
    try {
      let bytes: Uint8Array | undefined;
      if (ArrayBuffer.isView(input))
        bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      else {
        try {
          bytes = new Uint8Array(input as ArrayBuffer, 0, bufferLength.call(input));
        } catch {
          // Not an ArrayBuffer. Inspect its own properties without executing accessors.
        }
      }
      if (bytes) {
        const count = Math.min(bytes.byteLength, DEBUG_LIMITS.binaryBytes);
        let binary = '';
        for (let offset = 0; offset < count; offset += 8192)
          binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 8192, count)));
        return {
          $binary: btoa(binary),
          encoding: 'base64',
          byteLength: bytes.byteLength,
          capturedBytes: count,
          view: ArrayBuffer.isView(input),
          byteOffset: ArrayBuffer.isView(input) ? input.byteOffset : 0,
          representation: Object.prototype.toString.call(input),
          truncated: count !== bytes.byteLength,
        };
      }
      const output: { [key: string]: Json } = Object.create(null);
      const keys = Reflect.ownKeys(input);
      for (const key of keys) {
        if (nodes >= DEBUG_LIMITS.nodes || characters >= DEBUG_LIMITS.valueCharacters) {
          output.$omitted = 'value budget reached; remaining properties not captured';
          break;
        }
        const label = typeof key === 'symbol' ? String(key) : key;
        characters += label.length;
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (descriptor)
          output[label] =
            'value' in descriptor
              ? visit(descriptor.value, `${path}.${label}`, depth + 1)
              : unavailable('accessor not invoked');
      }
      // Error.stack is nonstandard; DOMException fields may live on the prototype.
      // Preserve browser text, stacks, causes and AggregateError members, never String(object).
      if (
        input instanceof Error ||
        ['[object Error]', '[object DOMException]'].includes(Object.prototype.toString.call(input))
      ) {
        for (const key of ['name', 'message', 'stack', 'code', 'cause', 'errors']) {
          const captured = output[key];
          const unread =
            captured !== null && typeof captured === 'object' && Object.hasOwn(captured, '$unavailable');
          if (Object.hasOwn(output, key) && !unread) continue;
          try {
            output[key] = visit(Reflect.get(input, key), `${path}.${key}`, depth + 1);
          } catch {
            output[key] = unavailable('error property getter threw');
          }
        }
      }
      return Array.isArray(input) ? { $array: output } : output;
    } catch {
      return unavailable('inspection threw; original operation unchanged');
    }
  };
  return visit(value, '$', 0);
}

function readFields(object: unknown, names: string[]): Record<string, unknown> {
  const output: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    try {
      output[name] = object == null ? undefined : Reflect.get(Object(object), name);
    } catch {
      output[name] = unavailable('property getter threw');
    }
  }
  return output;
}

export function browserContext(): Record<string, unknown> {
  const nav = globalThis.navigator;
  const doc = globalThis.document;
  const win = typeof window === 'undefined' ? undefined : window;
  const context: Record<string, unknown> = {
    navigator: readFields(nav, [
      'userAgent',
      'platform',
      'vendor',
      'language',
      'languages',
      'maxTouchPoints',
      'hardwareConcurrency',
      'deviceMemory',
      'cookieEnabled',
      'onLine',
      'webdriver',
    ]),
    location: readFields(globalThis.location, ['href', 'origin', 'hostname', 'protocol']),
    document: readFields(doc, ['visibilityState', 'referrer', 'readyState']),
    window: readFields(win, [
      'isSecureContext',
      'crossOriginIsolated',
      'innerWidth',
      'innerHeight',
      'devicePixelRatio',
    ]),
    timeOrigin: globalThis.performance?.timeOrigin,
  };
  try {
    context.userActivation = readFields(nav?.userActivation, ['isActive', 'hasBeenActive']);
    context.focused = doc?.hasFocus();
    context.topLevel = win ? win.top === win.self : undefined;
    context.clientHints = readFields(Reflect.get(nav ?? {}, 'userAgentData'), [
      'brands',
      'mobile',
      'platform',
    ]);
    const policy =
      doc && (Reflect.get(doc, 'permissionsPolicy') ?? Reflect.get(doc, 'featurePolicy'));
    context.permissionsPolicy = policy?.allowsFeature
      ? Object.fromEntries(
          [
            'publickey-credentials-create',
            'publickey-credentials-get',
            'ch-ua-high-entropy-values',
          ].map((name) => [name, policy.allowsFeature(name)]),
        )
      : unavailable('Permissions Policy API unavailable');
    const scripts = doc ? Array.from(doc.scripts, (script) => script.src).filter(Boolean) : [];
    context.scripts = scripts;
    context.sourceMaps = scripts.filter((url) => url.endsWith('.js')).map((url) => `${url}.map`);
    context.resources = globalThis.performance?.getEntriesByType('resource').map((entry) =>
      readFields(entry, [
        'name',
        'initiatorType',
        'startTime',
        'duration',
        'transferSize',
        'encodedBodySize',
        'decodedBodySize',
        'nextHopProtocol',
      ]),
    );
  } catch (error) {
    context.inspectionError = error;
  }
  return context;
}

/** Noninteractive probes run at initialization, never awaited on a button gesture. */
export function probeBrowser(): { values: Record<string, unknown>; close(): void } {
  const values: Record<string, unknown> = Object.create(null);
  let closed = false;
  const probe = (name: string, owner: unknown, method: string, args: unknown[] = []) => {
    values[name] = { status: 'pending' };
    try {
      const callable = owner && Reflect.get(Object(owner), method);
      if (typeof callable !== 'function') {
        values[name] = { status: 'unavailable' };
        return;
      }
      void Promise.resolve(Reflect.apply(callable, owner, args)).then(
        (result) => {
          if (!closed) values[name] = { status: 'returned', result };
        },
        (error) => {
          if (!closed) values[name] = { status: 'rejected', error };
        },
      );
    } catch (error) {
      values[name] = { status: 'threw', error };
    }
  };
  const publicKey = globalThis.PublicKeyCredential;
  probe('clientCapabilities', publicKey, 'getClientCapabilities');
  probe('platformAuthenticatorAvailable', publicKey, 'isUserVerifyingPlatformAuthenticatorAvailable');
  probe('conditionalMediationAvailable', publicKey, 'isConditionalMediationAvailable');
  try {
    const hints = Reflect.get(globalThis.navigator ?? {}, 'userAgentData');
    probe('highEntropyClientHints', hints, 'getHighEntropyValues', [
      ['architecture', 'bitness', 'formFactors', 'fullVersionList', 'model', 'platformVersion', 'wow64'],
    ]);
  } catch (error) {
    values.highEntropyClientHints = { status: 'threw', error };
  }
  return {
    values,
    close: () => {
      closed = true;
    },
  };
}

export interface DebugTrace {
  record(event: string, value?: unknown): void;
  credential(value: unknown): void;
  export(): string;
  close(): void;
}
export function createDebugTrace(context: unknown): DebugTrace {
  const entries: { event: string; at: string; elapsedMs: number; value: Json }[] = [];
  const started = performance.now();
  let characters = 0;
  let omittedEvents = 0;
  let closed = false;
  const removers: (() => void)[] = [];
  const record = (event: string, value?: unknown) => {
    if (closed) return;
    try {
      if (entries.length >= DEBUG_LIMITS.events || characters >= DEBUG_LIMITS.reportCharacters - 4096) {
        omittedEvents++;
        return;
      }
      const entry = {
        event,
        at: new Date().toISOString(),
        elapsedMs: performance.now() - started,
        value: debugValue(value),
      };
      const size = JSON.stringify(entry).length;
      if (characters + size > DEBUG_LIMITS.reportCharacters - 4096) omittedEvents++;
      else {
        entries.push(entry);
        characters += size + 1;
      }
    } catch {
      omittedEvents++;
    }
  };
  const trace: DebugTrace = {
    record,
    credential(value) {
      try {
        const credential = readFields(value, [
          'id',
          'rawId',
          'type',
          'authenticatorAttachment',
          'response',
        ]);
        const response = readFields(credential.response, [
          'clientDataJSON',
          'attestationObject',
          'authenticatorData',
          'signature',
          'userHandle',
        ]);
        const methods: Record<string, unknown> = Object.create(null);
        for (const name of [
          'getTransports',
          'getAuthenticatorData',
          'getPublicKey',
          'getPublicKeyAlgorithm',
        ]) {
          try {
            const method = credential.response && Reflect.get(Object(credential.response), name);
            methods[name] =
              typeof method === 'function'
                ? Reflect.apply(method, credential.response, [])
                : unavailable('method unavailable');
          } catch (error) {
            methods[name] = { error };
          }
        }
        let clientData: unknown;
        try {
          const data = response.clientDataJSON;
          clientData =
            data instanceof ArrayBuffer
              ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
              : undefined;
        } catch (error) {
          clientData = { decodingError: error };
        }
        record('native.credential', {
          ownProperties: value,
          ...credential,
          response,
          methods,
          decodedClientDataJSON: clientData,
          extensionRead:
            'Captured separately only when the checker reads extensions; never read early for a wrong credential.',
        });
      } catch (error) {
        record('capture.credential-error', error);
      }
    },
    export() {
      return JSON.stringify({ schema: DEBUG_SCHEMA, limits: DEBUG_LIMITS, omittedEvents, entries });
    },
    close() {
      closed = true;
      for (const remove of removers) remove();
    },
  };
  record('operation.context', context);
  try {
    record('browser.context', browserContext());
  } catch (error) {
    record('browser.context-error', error);
  }
  record('browser.capabilities', browserProbes.values);
  const listen = (
    target: EventTarget | undefined,
    name: string,
    capture: (event: Event) => unknown,
  ) => {
    if (!target) return;
    const listener = (event: Event) => {
      try {
        record(`page.${name}`, capture(event));
      } catch (error) {
        record('capture.event-error', error);
      }
    };
    target.addEventListener(name, listener);
    removers.push(() => target.removeEventListener(name, listener));
  };
  const win = typeof window === 'undefined' ? undefined : window;
  for (const name of ['focus', 'blur', 'pageshow', 'pagehide', 'online', 'offline'])
    listen(win, name, (event) => ({ trusted: event.isTrusted, context: browserContext() }));
  listen(globalThis.document, 'visibilitychange', () => browserContext());
  listen(win, 'error', (event) =>
    readFields(event, ['message', 'filename', 'lineno', 'colno', 'error']),
  );
  listen(win, 'unhandledrejection', (event) => readFields(event, ['reason']));
  listen(globalThis.document, 'securitypolicyviolation', (event) =>
    readFields(event, [
      'blockedURI',
      'violatedDirective',
      'effectiveDirective',
      'originalPolicy',
      'sourceFile',
      'lineNumber',
      'columnNumber',
      'disposition',
      'sample',
    ]),
  );
  return trace;
}

const browserProbes = probeBrowser();

/** Stored text is data, never executed. Old attempts without a trace remain valid. */
export function isDebugReport(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > DEBUG_LIMITS.reportCharacters) return false;
  try {
    const parsed = JSON.parse(value);
    return (
      parsed?.schema === DEBUG_SCHEMA &&
      Array.isArray(parsed.entries) &&
      parsed.entries.length <= DEBUG_LIMITS.events &&
      Number.isSafeInteger(parsed.omittedEvents) &&
      parsed.omittedEvents >= 0
    );
  } catch {
    return false;
  }
}

export function debugMarkdown(value: unknown): string[] {
  if (!isDebugReport(value)) return ['', 'Full diagnostic capture unavailable for this attempt.', ''];
  const json = JSON.stringify(JSON.parse(value), null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return [
    '',
    '#### Full unredacted fictional-test diagnostics',
    '',
    'Browser-exposed values, including test credential IDs, salts and PRF output when returned. ' +
      'Stacks are the browser-provided error stack and a separately labelled invocation stack. ' +
      'Unavailable fields and capture limits are explicit; no password-manager internals are inferred.',
    '',
    '```json',
    json,
    '```',
    '',
  ];
}

/** Not async: preserve synchronous native exceptions and the original user gesture. */
export function captureNative<T>(
  trace: DebugTrace | undefined,
  options: unknown,
  operation: () => Promise<T>,
): Promise<T> {
  if (!trace) return operation();
  try {
    trace.record('native.invocation', {
      options,
      browser: browserContext(),
      invocationStack: new Error('Checker native invocation call site (not a browser/provider stack)'),
    });
  } catch {
    // Never prevent the native operation because optional diagnostics failed.
  }
  try {
    return operation().then(
      (result) => {
        trace.record('native.returned');
        trace.credential(result);
        return result;
      },
      (error) => {
        trace.record('native.rejected', error);
        throw error;
      },
    );
  } catch (error) {
    trace.record('native.threw', error);
    throw error;
  }
}
