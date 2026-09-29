# Environment configuration

Circus Health's own environment variables use the `CRS_` prefix. The supported launch path remains npm → Docker Compose → LiteLLM. Provider/library settings such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CHATGPT_TOKEN_DIR`, `NODE_ENV`, `PLAYWRIGHT_BROWSERS_PATH`, and Docker's own variables retain their upstream names.

## Save and load an operator environment

Keep the file outside the checkout and the archive's `data` directory. This is a **shell file**: source it before running npm. Neither the launcher nor Node automatically loads a project `.env`. Compose's interpolation file is deliberately empty; it receives the validated launcher environment instead. A provider credential file is separate and is passed only to LiteLLM.

For example, put the following in an external `circus.env`, replacing these example paths:

```sh
export CRS_DATA_DIR="$HOME/circus-installation/data"
export CRS_STATE_DIR="$HOME/circus-installation/proxy/state"
export CRS_LITELLM_CONFIG="$HOME/circus-installation/proxy/config/litellm.yaml"
export CRS_MODEL=health-primary
export CRS_IMPORT_DIAGNOSTICS=true
```

Then run from the application checkout:

```sh
source /absolute/path/to/circus.env
mkdir -p "$CRS_DATA_DIR" "$CRS_STATE_DIR" "$(dirname "$CRS_LITELLM_CONFIG")"
chmod 700 "$CRS_STATE_DIR" "$(dirname "$CRS_LITELLM_CONFIG")"
chmod 600 /absolute/path/to/circus.env
npm run check:data
npm start
```

The LiteLLM YAML must already exist (see [installation](installation.md)). Reusing the same state/config/data paths retains your proxy login and archive; the variable rename does not move data or require a new login. Restart the app with the loaded environment after changing settings.

## Operator settings

- `CRS_DATA_DIR`: required existing absolute directory outside Git, ending in `/data`. Used by launch, archive checks and recovery tooling. The container sees `/archive/data`.
- `CRS_STATE_DIR`: external proxy state, default `~/.local/state/circus-health`. Use the same value for `npm run login:chatgpt` and `npm start`; includes durable authentication and proxy key.
- `CRS_LITELLM_CONFIG`: required external LiteLLM YAML file. Keep it separate from data and credentials.
- `CRS_MODEL`: required exact `model_name` alias in that YAML, for example `health-primary`.
- `CRS_LITELLM_ENV_FILE`: optional external provider credential file using `KEY=value` syntax, passed only to LiteLLM. Without it the launcher supplies an empty file. Do not put `export` statements in this provider file.
- `CRS_PORT`: browser loopback port, default `3001`, integer 1–65535.
- `CRS_PUBLIC_ORIGIN`: exact public HTTP(S) origin, default `http://localhost:<CRS_PORT>`. Non-loopback origins require HTTPS. See [deployment](deployment.md).
- `CRS_RESPONSE_MODEL`: optional exact model identifier expected in responses; otherwise derived from proxy configuration.
- `CRS_IMAGES`: `true`/`false` override of the selected route's image declaration. Without an override, derived from proxy metadata; missing support is false. Capability checks still apply.
- `CRS_PDF`: `auto` (default), `true`, or `false`. Native PDF requires a fictional runtime capability check even when true.
- `CRS_PROMPT_CACHE`: `true`/`false` override of provider prompt-cache support. Default comes from proxy metadata, otherwise false. This does not enable a response cache.
- `CRS_AI_PROXY_TIMEOUT_SECONDS`: integer 30–600; default 300 seconds per inference request. Does not extend overall run or retry limits.
- `CRS_IMPORT_DIAGNOSTICS`: `true` enables detailed bounded metadata events and the sidebar download control; otherwise off. Basic authorized performance summaries remain available. This is not private payload tracing. Read the [privacy boundary](import-performance.md) before sharing exports.
- `CRS_INTAKE_UPLOAD_MIB`: maximum upload size, default 128 MiB.
- `CRS_INTAKE_EXTRACTION_MIB`: maximum in-memory text extraction size, default 64 MiB.
- `CRS_CPUS`, `CRS_LITELLM_CPUS`: Compose CPU limits, defaults 2 and 1 respectively.
- `CRS_PIDS_LIMIT`, `CRS_LITELLM_PIDS_LIMIT`: process limits, defaults 512 and 256.
- `CRS_RUNTIME_TMPFS_MIB`, `CRS_TMP_TMPFS_MIB`: default 1024 MiB application runtime tmpfs and 128 MiB `/tmp` per container. See [capacity constraints](docker-runtime.md#runtime-capacity-and-containment) before raising limits.
- `CRS_IMAGE`: optional app image tag; default is an archive-specific tag (`circus-health:build` for a standalone image build).
- `CRS_DOCKER`: Docker executable override; default `docker`.

Only environment entries wired through `compose.yaml` reach the application container. Exporting an internal setting on the host does not automatically override the Compose service environment.

## Internal runtime and contributor settings

These are not additional requirements for normal `npm start` use. Compose or the launcher supplies the production values.

- `CRS_RUNTIME_DIR`: ephemeral decrypted runtime directory, `/run/health` in Docker. Never put it in a durable archive or a shared persistent directory.
- `CRS_PUBLIC_PORT`: external browser port supplied to the container separately from its internal `CRS_PORT=3001` listener.
- `CRS_AI_BACKEND`: only `litellm` is supported.
- `CRS_AI_MODEL`, `CRS_AI_BASE_URL`: selected proxy alias and private proxy endpoint.
- `CRS_AI_API_KEY_FILE`: proxy credential file supplied through Docker secrets. `CRS_AI_API_KEY` is the alternative for isolated contributor fixtures; do not set both.
- `CRS_AI_PROXY_RESOLVED_MODEL`, `CRS_AI_PROXY_IMAGES`, `CRS_AI_PROXY_PDF`, `CRS_AI_PROXY_PROMPT_CACHE`: runtime equivalents of the launcher assertions above.
- `CRS_AI_PROXY_LOCAL_ONLY`: contributor-side local endpoint constraint; false by default. It needs a verified resolved Ollama mapping and is not a shortcut around route validation.
- `CRS_AI_REASONING_EFFORT`: rejected; configure reasoning in the selected LiteLLM route instead.
- `CRS_DEV=1`: native contributor development mode; not a supported production alternative to Compose.
- `CRS_BUILD_REVISION`, `CRS_BUILD_WORKTREE`: build-time provenance derived by the launcher from Git; do not use these to assert an unverified revision.
- `CRS_AUTH_DIR`, `CRS_PROXY_KEY`: generated Compose inputs for the state directory's authentication mount and secret file; do not set manually.

Additional trace controls are off by default and are **not** enabled by the metadata download flag:

- `CRS_IMPORT_DIAGNOSTICS_CONSOLE=true` opts into diagnostic console output.
- `CRS_IMPORT_PRIVATE_TRACE=contains-health-data`, `CRS_IMPORT_PRIVATE_TRACE_DIR`, and `CRS_IMPORT_PRIVATE_TRACE_GRANT_FILE` require the explicit profile-scoped grant and protected paths described in [private trace configuration](import-performance.md). They capture sensitive payloads and are not forwarded by the standard Compose file.
- `CRS_IMPORT_PRIVATE_TRACE_MAX_TOTAL_MIB`, `CRS_IMPORT_PRIVATE_TRACE_MAX_ENTRY_MIB`, `CRS_IMPORT_PRIVATE_TRACE_MAX_ENTRIES` bound trace storage (defaults 512 MiB, 24 MiB, 8192 entries; maxima 2048 MiB, 32 MiB, 16384 entries).
- `CRS_LITELLM_RESPONSE_DIAGNOSTICS=true` enables proxy response diagnostics; `CRS_LITELLM_CAPTURE_RESPONSE=true` additionally captures response content. These are proxy-only contributor controls, separate from the app's metadata export; see [proxy diagnostics](import-performance.md). Never enable payload capture just to show the download button.

## Test and evidence controls

Tests do not need a personal archive or real provider by default. Explicit live/Docker/OCR gates retain their consent requirements after renaming. See [contributing](../CONTRIBUTING.md), [provider qualification](model-providers.md), and each owning script's usage.

- Opt-in gates: `CRS_AI_LIVE_TEST`, `CRS_AI_LIVE_IMAGE_TEST`, `CRS_AI_NATIVE_WORKFLOW_TEST`, `CRS_LITELLM_INTEGRATION_TEST`, `CRS_LAUNCH_TEST`, `CRS_PASSKEY_DOCKER_TEST`, `CRS_SOURCE_OCR_REAL`, `CRS_PDF_CONTROLLED_TEST`, and `CRS_PROVIDER_QUALIFICATION`. `CRS_CODEX_INTEGRATION_TEST` is a retained CI compatibility setting, not a supported provider route.
- Launch fixtures: `CRS_LAUNCH_PERFORMANCE_ONLY`, `CRS_LAUNCH_LITELLM_CPUS`, `CRS_CONSUMER_TEST_IMAGE`, `CRS_FICTIONAL_CONSUMER_CHECK`, `CRS_TEST_CODE_ROOT`, `CRS_SIGNAL_ROOT`.
- PDF benchmark: `CRS_PDF_BENCHMARK_FIXTURE`, `CRS_PDF_BENCHMARK_PAGES`, `CRS_PDF_BENCHMARK_BYTES`, `CRS_PDF_BENCHMARK_ORDER`, `CRS_PDF_BENCHMARK_FORMAT`, `CRS_PDF_BENCHMARK_READ_ALL`, `CRS_PDF_BENCHMARK_KEEP`; controlled report destination `CRS_PDF_CONTROLLED_REPORT`.
- Qualification settings: `CRS_QUALIFICATION_OUTPUT_DIR`, `CRS_QUALIFICATION_SCENARIO`, `CRS_QUALIFICATION_FORMAT`, `CRS_QUALIFICATION_CACHE`, `CRS_QUALIFICATION_REPEAT`, `CRS_QUALIFICATION_ACCEPT`.
- External screenshot destinations: `CRS_SCREENSHOTS_DIR`, `CRS_TEST_SCREENSHOTS`, `CRS_BRAND_VISUAL_DIR`, `CRS_COLLECTION_FILTER_VISUAL_DIR`, `CRS_CONNECTION_VISUAL_DIR`, `CRS_CONTACT_VISUAL_DIR`, `CRS_NOTE_TYPE_VISUAL_DIR`, `CRS_PASSKEY_VISUAL_DIR`, `CRS_PEOPLE_VISUAL_DIR`, `CRS_PERSON_SCOPE_VISUAL_DIR`, `CRS_PROFILE_VISUAL_DIR`.
- Proxy test script overrides: `CRS_CONFIGURE_SCRIPT`, `CRS_LOGIN_SCRIPT`.

Generated screenshots, traces and benchmark artifacts stay outside Git and use fictional inputs.

## Migrating older commands

Replace `HEALTH_` or `CIRCUS_` prefixes with `CRS_` for app-owned environment variables. Prefix formerly unqualified launcher names: `DATA_DIR` → `CRS_DATA_DIR`, `STATE_DIR` → `CRS_STATE_DIR`, `MODEL` → `CRS_MODEL`, and similarly for the operator settings listed above. These are replacements, not persistent aliases. The launcher rejects a supplied old setting without its new counterpart before touching Docker or state; if both exist, the new name controls behavior. Remove obsolete exports from your shell setup.

Historical experiment recordings retain their original commands and variable names as evidence; translate names using this reference when intentionally reproducing them against current code. A renamed flag does not authorize an old live experiment or revive a retired provider workflow. Compile-time browser constants and protocol format identifiers are not environment variables and retain their existing names.
