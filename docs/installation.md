# Install Circus Health

Circus Health runs as two Docker containers: the encrypted application and a private LiteLLM Proxy. The proxy is the application's only model route. These steps create a new installation; they do not import or migrate an older archive.

## Prerequisites

Install Node.js 24.19 or newer, npm, and Docker with Compose v2.30 or newer. The application image includes qpdf for scoped PDF extraction; no host qpdf is needed to launch it. Native contributor builds and tests require Node.js and qpdf as described in [Contributing](../CONTRIBUTING.md).

Use 8 GiB of host RAM with at least 4 GiB available to Docker as a conservative starting minimum for the default upload limits. This is planning guidance, not a measured minimum or a guarantee for large imports. The default `/run/health` and `/tmp` tmpfs ceilings total 1,280 MiB across both containers, with a separate 128 MiB application `/dev/shm` ceiling. These are capacity ceilings, not preallocated memory or measured peak usage; application/proxy memory, PDF rendering, exports, the browser and the host need additional headroom. Local model weights require separate capacity. Increase available memory and the [runtime tmpfs sizes together](docker-runtime.md#runtime-capacity-and-containment) when raising upload limits; no container memory cap is imposed without a measured safe peak.

The packaged application runs in Linux containers. Automated CI exercises Linux, and the operator
workflow has also been exercised with Docker Desktop on macOS. Native Windows and WSL launch,
filesystem, and passkey behavior have not been verified; do not treat those hosts as supported
until their acceptance checks pass.

## Install launcher dependencies

From the repository root:

```sh
nvm use
npm ci
npm run help
```

Node/npm power the local launcher; the application runs in Docker. No host Python or Make installation is required. Python remains inside the LiteLLM proxy container only.

## Choose external installation paths

Run these commands from the application checkout, for example `~/projects/circus-health`. Replace the example absolute paths with locations you control. The repository includes application code, maintained documentation and fictional tests; it excludes health archives, credentials, recovery material, runtime databases and raw diagnostics.

The supported Docker app keeps unlocked runtime files in container tmpfs at `/run/health`; do not replace it with a persistent host directory. `DATA_DIR` must exist, be writable, resolve outside every Git repository, and end in `/data`. Keep configuration, credentials and proxy state outside `DATA_DIR` and outside Git, with separate directories for their distinct roles.

```sh
mkdir -p /absolute/path/to/archive/data \
  /absolute/path/to/proxy/config \
  /absolute/path/to/proxy/credentials \
  /absolute/path/to/proxy/state
chmod 700 /absolute/path/to/proxy/config \
  /absolute/path/to/proxy/credentials \
  /absolute/path/to/proxy/state
DATA_DIR=/absolute/path/to/archive/data npm run check:data
```

The archive filesystem must support advisory locks, atomic create and rename, hard links, file and directory `fsync`, and a single writer. Network and synchronized folders need specific verification before use.

## Choose a model route

The `MODEL` value is a LiteLLM `model_name` alias. Provider choice and credentials stay in the operator-owned proxy configuration. Circus Health selects exactly one non-wildcard route and disables fallback.

### ChatGPT subscription

Copy the supplied configuration, then sign in from a terminal. This login is independent of a host Codex CLI login and of OpenAI Platform API keys.

```sh
cp deploy/litellm/config.chatgpt.example.yaml /absolute/path/to/proxy/config/litellm.yaml
DATA_DIR=/absolute/path/to/archive/data STATE_DIR=/absolute/path/to/proxy/state npm run login:chatgpt
```

Follow the device-code prompt in that terminal. The login command mounts no health archive and sends no inference request. Use the same `STATE_DIR` when starting the app. Account eligibility, token refresh, and authentication reuse remain release checks.

### Hosted API provider

Copy `deploy/litellm/config.openai.example.yaml` or `config.claude.example.yaml`, choose an exact model supported by the pinned proxy, and place required `KEY=value` credentials in an external mode-600 file. The credential file is passed only to LiteLLM. Do not put secrets in the YAML, `MODEL`, a URL, or the health archive.

### Local Ollama

Install Ollama, disable its cloud features, and pull the exact model selected in `deploy/litellm/config.ollama.example.yaml`. Copy that template to the external configuration path. The template's `host.docker.internal` endpoint works with Docker Desktop when it can reach the host listener; other platforms may need a restricted, platform-specific address.

A local model label alone does not prove local processing. Verify the endpoint, cloud settings, tool support, and image capability before using private records.

## Start the app

```sh
DATA_DIR=/absolute/path/to/archive/data MODEL=health-primary LITELLM_CONFIG=/absolute/path/to/proxy/config/litellm.yaml STATE_DIR=/absolute/path/to/proxy/state npm run start
```

Add `LITELLM_ENV_FILE=/absolute/path/to/proxy/credentials/provider.env` for a hosted provider. Open `http://localhost:3001`. Use `PORT=5180` to choose another loopback port, but keep `localhost` as the browser hostname for passkeys.

Native PDF is preferred after a fictional connection check verifies the selected route. `PDF=auto` is the default; `PDF=true` still requires the check and `PDF=false` opts out. Unknown static metadata does not prevent discovery. Verification happens automatically when the connection is first needed after startup or a configuration change, before private PDF evidence is sent. A separately verified image route supplies lossless PNG fallback. Connection details show PDF status and allow a fictional retest. See [model capabilities](model-providers.md#configuration-and-routing-controls).

Confirm `/api/runtime` reports `encrypted: true`. Create a profile, save its recovery kit separately, verify it, and test recovery with fictional data before importing anything important. In Assistant, run the fictional tool check before chat or imports; run the fictional image check only for a route configured to support images.

The [deployment guide](deployment.md) covers updates, shutdown, backup, HTTPS, limits, and troubleshooting. The [model reference](model-providers.md) lists provider acceptance gates.
