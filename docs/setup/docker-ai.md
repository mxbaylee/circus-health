# LiteLLM model connection

The Assistant and dedicated **Import** page share one LiteLLM Proxy. Circus Health does not expose a native runtime, direct provider adapter, Codex CLI login, or external-agent startup mode. The application owns the tool loop, profile scope, review operations, and accepted writes; LiteLLM owns provider translation and authentication.

Saved data, unlock, and cache rebuild work while the upstream provider is unavailable. Initial stack startup waits for the LiteLLM container to become healthy. A ready archive and a ready model are separate states. The current Make integration check exercises actual LiteLLM tool translation and encrypted persistence against a controlled upstream. Historical direct-adapter receipts do not verify this deployment; real provider workflows remain open in the [completion gates](model-providers.md#compatibility-limits).

For ChatGPT subscription, hosted API, and local Ollama setup, use the commands in [installation](installation.md#choose-a-model-route).

## Launch contract

Supply an existing absolute archive directory ending in `/data`, an existing LiteLLM YAML file outside Git and the archive, and the exact `model_name` alias configured in that file:

```sh
CRS_DATA_DIR=/absolute/path/to/archive/data CRS_MODEL=health-primary CRS_LITELLM_CONFIG=/absolute/path/to/proxy/config/litellm.yaml CRS_STATE_DIR=/absolute/path/to/proxy/state npm run start
```

The host needs Node.js 24.19 or newer, npm, and Docker Compose v2.30 or newer. The launcher starts exactly the application and proxy containers and publishes only `127.0.0.1:3001`. `CRS_PORT` changes the loopback port. The application receives a generated proxy credential; its value is not placed in command arguments. `npm run image:build` needs no data directory and uses `circus-health:build`. Running an archive uses its own path-derived Compose project and application image tag; `CRS_IMAGE` can override the image explicitly. Separate test and user deployments need different data/config/state directories and tags. Separate localhost ports do not isolate the `circus-session` browser cookie: use dedicated browser profiles or isolated automation contexts. `CRS_DATA_DIR=/absolute/path/to/archive/data npm run check:data` validates only the archive target.

`CRS_LITELLM_CONFIG` is mounted read-only into the proxy and is never exposed to the health container. If the provider needs environment credentials, pass a separate absolute file with `CRS_LITELLM_ENV_FILE`. That file is loaded only into the proxy:

```sh
CRS_DATA_DIR=/absolute/path/to/archive/data CRS_MODEL=health-primary CRS_LITELLM_CONFIG=/absolute/path/to/proxy/config/litellm.yaml CRS_LITELLM_ENV_FILE=/absolute/path/to/proxy/credentials/provider.env CRS_STATE_DIR=/absolute/path/to/proxy/state npm run start
```

The launcher rejects archive, configuration, credential, and state paths inside Git or inside one another where their roles would overlap. Keep provider credentials, proxy configuration, model weights, OAuth tokens, and the proxy master key outside `CRS_DATA_DIR`. The proxy receives no archive mount; the application remains the only archive writer. Runtime SQLite and unlocked plaintext stay in the application's tmpfs.

## Persistent proxy and OAuth state

By default, generated operational state lives at `~/.local/state/circus-health`. `CRS_STATE_DIR=/absolute/path/to/proxy/state` selects another location outside Git and the health archive. The directory retains the generated LiteLLM master key and provider authentication state across container recreation. Protect it like a credential store and back it up separately from profiles. Docker's persistent log driver is disabled; the attached proxy terminal may still report provider errors.

The default template uses `chatgpt/gpt-6-astra` with explicit Responses mode. [OpenAI documents the Astra model identifier](https://developers.openai.com/api/docs/models/gpt-6-astra); a 2026-09-23 fictional run verified real Astra tool, image and native-PDF requests through the pinned LiteLLM 1.99.1 proxy for one signed-in account. Complete-file extraction and reviewed acceptance remain unverified. Before starting the proxy, run the pinned-image login helper in your own terminal:

```sh
CRS_DATA_DIR=/absolute/path/to/archive/data CRS_STATE_DIR=/absolute/path/to/proxy/state npm run login:chatgpt
```

Enable device-code login in the account/workspace settings, follow the terminal URL/code, then launch using the same `CRS_STATE_DIR`. The command mounts only `CRS_STATE_DIR/chatgpt` and its read-only helper, sends no inference request, and confirms persistence to `auth.json`. State directories are mode 700; the auth file is mode 600. `CRS_DATA_DIR` is optional for login but recommended to validate separation; it is never mounted by that command. Keep the state directory separate even when omitting it.

This is LiteLLM-owned OAuth for subscription access, independent of host CLI tokens and Platform API-key billing. The pinned authenticator supports reuse and refresh; fictional offline responses verify those code paths. The hardened login helper completed a real device sign-in and saved protected authentication state on 2026-09-23. A separate fictional run subsequently verified inference using this state after stack recreation. This establishes the tested account/route, not every account's eligibility or live refresh after token expiry. The guarded [natural-expiry qualification command](model-providers.md#provider-routes) records a pending result until expiry, then checks real refresh and fresh-container reuse without interactive login; its receipt must be paired with a refreshed-route fictional tool request. Do not rely on an inference-triggered device prompt: the application test times out sooner than device login, and persistent proxy logs are disabled. See [OpenAI authentication](https://learn.chatgpt.com/docs/auth), [LiteLLM ChatGPT support](https://docs.litellm.ai/docs/providers/chatgpt) and the [verification boundary](model-providers.md#verification-boundary).

Other hosted providers use their LiteLLM routes and credential variables. Use exact provider/model identifiers supported by the installed proxy version. Keep secrets in the proxy-only environment file and reference them from the YAML; do not put secrets in `CRS_MODEL`, URLs, the health archive, or browser-visible settings.

## Local Ollama through the proxy

Ollama remains an upstream behind LiteLLM. Run it natively or on another trusted host reachable from the proxy container, install the exact local model yourself, and disable cloud inference. Docker loopback addresses refer to the proxy container, so use a host address that the container can actually reach. The template uses `host.docker.internal:11434`; Docker Desktop reached the existing loopback listener on the tested Mac. Try that before changing the listener. On Linux or another host, verify its specific network path and restrict any required listener change to trusted callers.

The text/tool template selects `ollama_chat/qwen3:4b`; [local Ollama setup](installation.md#local-ollama) covers the operator boundary. Do not infer privacy or capability from an Ollama label. Verify that the endpoint is local, cloud fallback is disabled, and the installed model supports the tool calls required by Moxie. Image-bearing records additionally require image input support; otherwise the application must retain an explicit coverage gap rather than claim those images were inspected.

## Routing and privacy controls

The LiteLLM YAML must expose the exact alias selected by `CRS_MODEL`, matching one unique, non-wildcard entry. The launcher creates the runtime proxy configuration from only that selected entry and disables retries and fallbacks. An unavailable route must fail explicitly. Configured default deployments, duplicate/wildcard routes, logging callbacks, caches, databases, and payload logging are rejected.

The launcher normally derives the expected response identity by stripping the provider prefix from the selected entry's `litellm_params.model`; it also derives image declaration from `model_info.supports_vision`, defaulting to false. `CRS_RESPONSE_MODEL=EXACT_RETURNED_IDENTITY` and `CRS_IMAGES=true|false` are advanced overrides for provider-specific response behavior. Neither derived metadata nor an override proves capability: the application fictional setup must exercise real tools and images.

`CRS_PDF=auto|true|false` controls native PDF delivery through `CRS_AI_PROXY_PDF`, defaulting to `auto`. Before the first model work after process startup, the application checks the exact configured route with a small fictional PDF and requires the model to return a challenge present only in its bytes. The check runs when a connection is needed, not on HTTP readiness or container boot. `true` also requires this proof; `false` explicitly opts out. Static route metadata is a hint, not acceptance authority. Results are held in process memory for the exact configuration and profile; restart or configuration changes require fresh proof. A failed PDF capability check permits a separately verified image route. Authentication, rate-limit, timeout and server failures remain explicit. Native pages are bounded to 5 MiB; unsupported page structures or sizes use the same page's lossless PNG. An explicit PDF-unsupported HTTP 400/422 during private work permits one same-route PNG retry and disables PDF for later bridges until retested. See the [capability and verification contract](model-providers.md#configuration-and-routing-controls).

`CRS_PROMPT_CACHE=true|false` (derived from `model_info.supports_prompt_caching`, defaulting to false) is a separate opt-in: when true, the application marks a cache breakpoint on the byte-stable instructions-and-tools prefix sent with every request. It leaves accepted records unchanged and stays off unless explicitly enabled or declared; cache savings depend on the selected provider. If the selected route rejects the field, the reported error names `CRS_AI_PROXY_PROMPT_CACHE=false` rather than silently retrying without it. With the supported launcher, set `CRS_PROMPT_CACHE=false` on `npm run start` to supply that application setting. An absent capability leaves normal requests without an explicit cache marker working without a warning or failure. Diagnostics still expose `cachedInputTokens` when the provider reports it; absent cache usage is `null` (unknown), not zero. Neither the metadata declaration nor these counters prove cache support: acceptance of the breakpoint and the separate continuation system message, plus actual cache savings, require a check against the selected provider.

The application sends `disable_fallbacks: true` with proxy requests and validates model/tool replies. Those request controls cannot independently attest the provider account, external network, model weights, provider-side filesystem, or upstream logging. Operators remain responsible for the complete configured route.

For an independently fictional performance run, add `CRS_IMPORT_DIAGNOSTICS=true` to `npm run start`. This enables bounded profile-scoped metadata only and defaults to false; console and private-payload tracing are not forwarded by the supplied Compose configuration. See [import diagnostics](../../src/server/INTAKE.md) for fields and retention.

## Test, then import

Open Assistant and run **Test tools with fictional content**. It sends a generated challenge and exercises the application-owned tool loop without reading patient data. Run **Test fictional image** separately when `CRS_IMAGES=true`; the upstream must read the returned image rather than infer support from its name. Receipts are renewed after app restart or configuration changes.

Tool arguments, cancellation, authentication failures, model mismatch, image support, and usage reporting must fail without partial acceptance or silent rerouting. A passing probe does not establish clinical extraction quality, supported-size PDF coverage, authentication persistence, or provider compatibility. Complete the fictional end-to-end gates in [Model providers](model-providers.md) before relying on a route for real records.
