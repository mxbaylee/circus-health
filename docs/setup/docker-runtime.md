# Circus Health Docker runtime

Docker Compose serves the encrypted profile runtime alongside a private LiteLLM Proxy. Startup reads public profile cards; each profile stays locked until recovery verification or an available passkey unlocks it. Unlock validates an encrypted SQLite cache or rebuilds that profile from accepted encrypted record versions. Archive readiness and [LiteLLM readiness](docker-ai.md) are separate.

From the repository root:

```sh
CRS_DATA_DIR=/absolute/path/to/archive/data CRS_MODEL=health-primary CRS_LITELLM_CONFIG=/absolute/path/to/proxy/config/litellm.yaml CRS_STATE_DIR=/absolute/path/to/proxy/state npm run start
```

The host needs Node.js 24.19 or newer, npm, and Docker Compose v2.30 or newer. `CRS_DATA_DIR` must be an existing writable absolute directory outside Git ending in `/data`. `CRS_LITELLM_CONFIG` must be an existing external file and is mounted read-only into the proxy. The archive may be empty: create a profile, download its recovery kit and verify the complete phrase/file before activation. This fresh-data runtime does not migrate old plaintext profile registries. The operator supplies mount permissions and any synchronization. Private copies and Placebo accounts receive independent encryption and recovery keys. `npm run image:build` builds the images without opening an archive; `npm run help` lists launcher settings.

The health image contains code, production dependencies, qpdf for scoped original-page PDF extraction, and the static UI. Profile data, repository documentation and Git history are excluded. The health container runs as UID 1000 with a read-only root filesystem. That user must be able to write the supplied data mount. Durable encrypted objects, record history, indexes, keyrings and public cards live at `/archive/data`. Public cards intentionally disclose limited identity/unlock metadata. Originals, active databases, upload staging and other unlocked plaintext live only in the `/run/health` and `/tmp` tmpfs mounts. Lock removes the selected profile's plaintext workspace; container removal discards those tmpfs mounts. The proxy has no archive mount and cannot write accepted data.

`npm run start` binds the published port to `127.0.0.1:3001` and recommends opening `http://localhost:3001`; `CRS_PORT=3002` changes the host port. The container receives `CRS_PUBLIC_PORT`, so both exact local origins are allowed on that published port. Use `localhost` for passkeys. It forwards `CRS_PUBLIC_ORIGIN` and the [upload/extraction limits](../import/import-reconciliation.md), as well as model settings. A custom origin must be the exact browser origin, for example:

```sh
CRS_PUBLIC_ORIGIN=https://circus.example.test \
CRS_INTAKE_UPLOAD_MIB=256 CRS_INTAKE_EXTRACTION_MIB=96 \
CRS_RUNTIME_TMPFS_MIB=768 \
CRS_DATA_DIR=/absolute/path/to/archive/data CRS_PORT=3002 CRS_MODEL=health-primary CRS_LITELLM_CONFIG=/absolute/path/to/proxy/config/litellm.yaml CRS_STATE_DIR=/absolute/path/to/proxy/state npm run start
```

The origin setting authorizes the configured host/origin; it does not provision TLS or a reverse proxy. The launcher keeps the published port bound to loopback. Writes require an allowed Origin, and each HTTP session must unlock a profile before reading its records or originals.

Bounded, encrypted, profile-scoped performance summaries are captured by default. `CRS_IMPORT_DIAGNOSTICS=true` on `npm run start` additionally enables detailed metadata events in a bounded memory window and encrypted chunk archive; this detailed-tracing flag defaults to `false`. Console logging and private payload tracing are separate controls and are not forwarded or mounted by the supported Compose configuration. See [diagnostic retention and export](../import/import-performance.md).

### Runtime capacity and containment

The application gets a 1024 MiB `/run/health` tmpfs (`CRS_RUNTIME_TMPFS_MIB=1024`). Each container gets its own 128 MiB `/tmp` tmpfs (`CRS_TMP_TMPFS_MIB=128`); that setting changes both mounts. The application also has 128 MiB of shared memory for Chromium. These are ceilings, not preallocated RAM. Both runtime entry points refuse Linux startup if `CRS_RUNTIME_DIR` is missing, relative, not a directory, or not on a tmpfs. The launcher runs the filesystem preflight in an attached one-off container before starting services with persistent logging disabled, so that failure remains visible. Native macOS/Windows contributor checks skip the Linux filesystem-type check and do not acquire this guarantee.

The [storage planner](../../src/server/archive-storage.ts) allows, for a nonempty upload, `2 × original MiB + max(extraction MiB, 100)` for upload staging, a materialized original and extraction/ZIP space. Normal retention now adopts the staging file without a second plaintext copy; the conservative planning allowance still covers cross-filesystem fallback. With the default 64 MiB extraction limit:

- 128 MiB upload: `2 × 128 + 100 = 356 MiB`; the default 1024 MiB runtime mount leaves 668 MiB for the workspace and other headroom.
- 256 MiB upload: `2 × 256 + 100 = 612 MiB`; a 1536 MiB runtime mount leaves 924 MiB for the workspace and other headroom.
- 1024 MiB upload: `2 × 1024 + 100 = 2148 MiB` (about 2.10 GiB); a 3072 MiB runtime mount leaves 924 MiB beyond this allowance.

These examples cover one upload and are planning allowances, not peak measurements or guarantees. Unlock checks the eager workspace, database headroom and one configured upload allowance against reported free runtime capacity before materialization. Source and attachment originals stay encrypted until an authorized consumer needs the individual file; opening one also checks available space. A cache-loss rebuild authenticates originals without retaining every original as plaintext. This is per-file access, not seeking within secretstream ciphertext. Files opened during the session still consume runtime space until lock.

Existing unlocked profiles, SQLite growth, rendered images, nested ZIPs and concurrent work need additional headroom. Recalculate if the extraction allowance exceeds 100 MiB. Authenticated uploads with a known size are refused before staging if they exceed the upload limit or reported free runtime space cannot hold the full processing allowance. Archive reuse is decided only after byte verification. These observations reserve no space and cannot establish unknown quotas or future expansion; capacity failures can still occur later. ZIP members use [verified streamed staging and paged inventory](../data/streamed-package-originals.md), with no native file-count, aggregate-name, member-byte or aggregate expanded-byte cap; the estimate is not a bound on expansion. Other parser/output safeguards remain. [CRS-233](../todo/CRS-233.md) owns storage-based admission and unlock headroom; [CRS-232](../todo/CRS-232.md) retains text/JSONL and embedded-file processing work.

Both containers retain their read-only filesystems, add `no-new-privileges`, drop all capabilities, disable core dumps, and mount every tmpfs with `noexec,nosuid,nodev`. CPU quotas default to `CRS_CPUS=2` and `CRS_LITELLM_CPUS=1`: the app has CPU-heavy parsing/rendering, while the proxy primarily routes requests. Process/thread ceilings default to `CRS_PIDS_LIMIT=512` and `CRS_LITELLM_PIDS_LIMIT=256`, leaving room for Node workers, PDF/export subprocesses and proxy threads while bounding process proliferation. These configurable containment defaults are not measured throughput guarantees; validate them with the chosen workload and increase them when needed.

The one-off ChatGPT login helper also drops capabilities, enables no-new-privileges, disables core dumps and applies process/CPU limits and a sized non-executable temporary mount. Note PDF export keeps these protections; Playwright's current launch uses its existing Chromium sandbox setting. Legacy portable backup builds its database projection beside the backup destination and copies originals from their source, instead of duplicating the entire profile into the small container `/tmp`. Allow destination space for both the projection and complete backup; encrypted archive backup retains its separate contract.

There is no container memory cap: no measured peak supports a safe one yet. The PDF child is recycled after reaching 320 MiB RSS, but that threshold is not an allocation ceiling; rendering, base64 assembly, the application, the proxy and tmpfs pages add to peak memory. An arbitrary cap could kill an otherwise valid import. See [installation memory guidance](installation.md#prerequisites) and verify the [remaining container checks](#verification-boundaries) before relying on these new settings.

When investigating a slow desktop or startup, record host RAM, active swap traffic and Docker VM memory separately from container CPU and memory samples. An idle CPU or absence of a container OOM does not rule out host paging; allocated swap alone can reflect earlier pressure, so compare interval activity during the complaint. Builds and other open applications also consume host memory. Closing unused applications can reduce that contention, while increasing Docker's memory allowance can increase it. Compare startup and import timings under recorded conditions before attributing a delay to hardware or changing resource limits.

`GET /health/ready` and `GET /api/runtime` report startup readiness, public-profile startup time and the immutable production `buildId` shared with the browser bundle. HTTP readiness does not unlock profiles, run a model, or claim that every profile cache has been validated. The browser's [connection control and update notice](connection-awareness.md) use this probe independently of private reads. Unlock responses distinguish `metrics.cacheHit` and `metrics.loadMs`. Corrupt accepted history fails instead of being replaced with an empty profile.

The app joins a browser bridge for its loopback port and the internal proxy network. LiteLLM joins the internal proxy network and a separate provider network. Only the app receives the health archive mount.

## Stopping the launcher

Ctrl-C and SIGTERM/SIGHUP delivered to the launcher or its terminal process group start shutdown. Signalling only an npm wrapper PID is not a supported shutdown mechanism; use the terminal or the launcher process group. The TypeScript launcher forwards the first signal to its Docker CLI process group, then runs `compose down --remove-orphans` for its own archive-derived project. Repeated signals do not cancel that cleanup. Launcher and writer leases stay held until cleanup finishes or reports failure; another instance's project is not stopped. Teardown removes this project's containers and networks without deleting the external archive, credentials, images or volumes.

Shutdown has bounded waits for stuck Docker commands: the interrupted command gets 20 seconds, then TERM and KILL waits of 5 seconds each; teardown gets 60 seconds with the same escalation. A cleanup failure is reported explicitly rather than treated as success. SIGKILL, a host crash, power loss or an unavailable Docker daemon cannot be made reliable by a signal handler, so those cases may leave containers requiring operator cleanup. Never use a global Docker prune or remove another archive's containers to recover this launcher.

## Accepted writes, recovery and backup

Before SQLite acknowledges a clinical or personal change, the encrypted record journal retains its immutable versions and publishes its authenticated accepted head. Original files are encrypted and indexed before successful responses can acknowledge them. SQLite and its encrypted cache are disposable projections. A missing cache rebuilds from accepted encrypted records and authenticated originals without model access. Stable IDs, historical versions and literal source bytes survive that reconstruction. See the [vault format](../security/vault-format.md) and [record-version implementation](../../src/server/RECORD-VERSIONS.md).

A durable publication may succeed before the caller loses its response; refresh versioned state before retrying an uncertain operation. Unattached partial objects are not promoted to accepted history. Previous accepted clinical versions, originals and attachments are not pruned. Cache failure cannot make the cache the recovery authority.

The encrypted runtime blocks the former plaintext per-profile backup endpoints. Retain a consistent copy of the encrypted durable data directory, including its registry, keyrings, indexes, objects and record versions. Preserve the recovery kit separately. Stop the writer or use a filesystem snapshot with suitable consistency; copying changing individual files is not an application backup. Proxy master keys, OAuth tokens and provider credentials live in `CRS_STATE_DIR` or operator configuration outside `CRS_DATA_DIR` and must be protected separately. Legacy recovery CLI commands and older portable snapshot formats are not the current encrypted backup workflow.

## Writer and mount contract

The mount must support advisory locks within each writer domain, atomic file creation/rename and hard links, file fsync and directory fsync. A retained `.health-writer.lock` inode is locked by a small Node process for the complete app lifetime. A second writer fails immediately. Process/container loss releases the kernel lock; no stale PID-file guessing is needed.

Docker Desktop on macOS does not share advisory locks between the host and its Linux VM. The additional `.health-writer-domain` marker reserves this Docker-only deployment for `linux`; an incompatible external writer refuses startup even if its own kernel lock succeeds. `npm run start` holds the host lease while reserving the archive for Linux, then the health container becomes the sole application writer. Do not remove lock/domain files to bypass a blocked startup. External writers must take the same exclusive lock or run while the app is stopped. A filesystem with names but without these locking/publication semantics is insufficient.

## Verification boundaries

On 2026-09-23, the updated production image passed the dedicated hardened-consumer test: Chromium generated an actual note PDF, and legacy portable backup/restore preserved seven fictional originals totaling 140 MiB with only 128 MiB of container temporary space. Running-kernel assertions verified capability drop, no-new-privileges, zero core limits, CPU/process limits, and the configured runtime, temporary and shared-memory mount sizes and protections. The tested production module hashes matched the working source; later changes only wired contributor test commands and CI. A real device sign-in also completed in the hardened login helper. These checks establish consumer compatibility, not the earlier full forced-kill lifecycle, representative peak capacity or provider extraction quality.

Configuration preflight reads PDF capability hints directly from the pinned LiteLLM package's bundled metadata, with an 8 MiB input bound. It locates the package without initializing LiteLLM, loading provider integrations or authenticating. Explicit boolean settings take precedence; metadata aliases retain canonical-key precedence and exact provider matching. Missing or malformed metadata supplies no trusted hint. This avoids loading the full library once for configuration and again for the proxy server. Actual tool/media capability is still proved with fictional content before model work; metadata alone never authorizes native PDF delivery.

An earlier source snapshot passed the complete opt-in npm → Compose integration on 2026-09-22 with the pinned LiteLLM image and independently fictional data. It verified actual read-only roots, capability drop, no-new-privileges, zero core limits, tmpfs non-executability, CPU/process ceilings, Linux tmpfs-backed PDF input descriptors, model PDF readiness through the real proxy, original upload/download, review-before-acceptance, encrypted archive contents, recreation, cache-loss rebuild and forced-kill recovery. The earlier claim that its assertions also verified `nosuid`, `nodev` and mount sizes was too broad; those properties were configured but not asserted by that snapshot. That run's final container matched 13 critical source hashes from its tested snapshot; it does not certify later application changes. No noexec exception was needed for LiteLLM. Exact pinned-image offline PDF/stream/response tests also pass without network access. These checks establish deployment compatibility and the fictional lifecycle, not a safe memory cap, clinical extraction quality, live account eligibility or maximum-upload capacity.

The revised application passed the controlled performance-only launcher check on 2026-09-22 (then using Make) with the default one-CPU proxy quota and unchanged readiness bounds. It verified hardening, 23 native-PDF container tests, fictional PDF capability proof, upload inode adoption, known upload/provider/browser-review delays, exact request correlation and compact-summary retention after lock, container recreation and unlock. The run also verified current server source, browser bundle and deployment hashes. An earlier attempt exposed a real diagnostics defect: completion inherited a later model-turn ID and left processing falsely active. The corrected lifecycle context passed independent review, 255 affected tests and the final deployed assertions. Scripted processing ended with no progress and accepted no clinical extraction result; this is instrumentation evidence, not provider-quality or cache-savings evidence. The performance-only run does not repeat the full cache-loss and forced-kill lifecycle described above.

Startup and health under load remain variable on the validation host: an 8 GiB Mac with a two-CPU Docker VM and about 1.92 GiB of VM memory, below the 4 GiB starting guidance. Earlier default-CPU and two-CPU attempts, plus the post-fix run immediately following a rebuild, failed proxy readiness before app admission. The final successful run used cached builds after a Docker restart and took about seven minutes, including the deliberate delays and container recreation; this is not an import-throughput measurement. During its heavier checks the proxy missed three health probes, became unhealthy and then recovered. No OOM event was observed, while host sampling recorded active swap traffic. A separate isolated one-CPU proxy trace started in 15–30 seconds, but networking, interpreter lifecycle and probe conditions differed. These observations establish neither a minimum RAM requirement nor a single cause for the slowdown. Representative provider qualification, stable performance under load and maximum-size capacity remain open.

That earlier cold run exceeded its original 15-minute harness timeout while building browser dependencies and running alongside host tests on an 8 GiB machine. The complete warm run passed with a 30-minute harness bound; this is validation elapsed time, not import throughput. Run `CRS_LAUNCH_TEST=1 node --test src/server/test/launch.integration.test.ts` with supported contributor dependencies to repeat the fictional test. It removes only its own containers and network.

### Deployment drive qualification

For an existing external `/data` directory on the drive to be used, an already built application image and a separate existing external receipt directory, run:

```sh
CRS_DRIVE_QUALIFICATION=1 CRS_DATA_DIR=/absolute/path/data \
CRS_IMAGE=circus-health:qualified-build \
CRS_QUALIFICATION_OUTPUT_DIR=/absolute/path/receipts npm run qualify:drive
```

This opt-in command creates only a fresh fictional scratch directory under the selected data directory. It tests exclusive creation, hard links, publication rename, file and directory fsync, rejection of a concurrent writer, retained lock inodes, normal release and forced-kill reacquisition. It repeats the checks with UID 1000 in a read-only-root, network-disabled application container, then starts a new container to verify the first container's exact publication and reacquire its writer lease. The probe uses the current repository's storage-lock source. It never opens an existing profile, mounts provider credentials or changes the archive's writer-domain marker. Only its own scratch directory is removed; a metadata-only receipt is created with mode 0600 outside the archive and Git.

A passing receipt establishes these filesystem/mount operations on that installation. It does not establish power-loss durability, actual provider credential persistence or a complete import lifecycle; those remaining gates are [CRS-152](../todo/CRS-152.md). An unavailable image, denied mount, unsupported filesystem operation, corrupted publication or unexpected container result fails explicitly. The UID 1000 container probe currently runs only on macOS Docker Desktop. It refuses Linux before creating scratch data because a different host UID can prevent container access or cleanup. Linux support needs an explicit mount identity and cleanup design. `npm run check:data` remains a location check, rather than a filesystem qualification.

For a smaller startup-only check, this smoke recipe starts an isolated archive/state with a fictional model route pointed at a closed container-local port. It uses no provider credentials or real records. Choose a free browser port before running it:

```sh
verify_dir=$(mktemp -d "${TMPDIR:-/tmp}/circus-containment.XXXXXX")
mkdir "$verify_dir/data" "$verify_dir/state"
printf 'OPENAI_API_KEY=fictional-smoke-only\n' > "$verify_dir/provider.env"
cat > "$verify_dir/config.yaml" <<'YAML'
model_list:
  - model_name: fictional-smoke
    litellm_params:
      model: openai/fictional-smoke
      api_base: http://127.0.0.1:9/v1
      api_key: os.environ/OPENAI_API_KEY
    model_info:
      supports_function_calling: true
      supports_vision: false
YAML
CRS_DATA_DIR="$verify_dir/data" CRS_STATE_DIR="$verify_dir/state" CRS_LITELLM_CONFIG="$verify_dir/config.yaml" CRS_LITELLM_ENV_FILE="$verify_dir/provider.env" CRS_MODEL=fictional-smoke CRS_RESPONSE_MODEL=fictional-smoke CRS_IMAGES=false CRS_PDF=false CRS_PROMPT_CACHE=false CRS_PORT=5301 CRS_PUBLIC_ORIGIN=http://localhost:5301 npm run start
```

The fresh data directory must be writable by container UID 1000 under the same mount contract as any installation; adjust only that fictional directory's ownership if the host requires it. In another terminal, `curl --fail http://localhost:5301/health/ready` checks application startup; Compose starts it only after LiteLLM is healthy. Open a separate browser profile or private context because localhost ports share cookies. Create a fictional profile and upload a fictional text/PDF original there, then check its download after lock/unlock. Model extraction is not part of this smoke: the fictional route cannot complete inference. Inspect both containers' effective tmpfs flags, capability/core/process settings and CPU quotas. Ctrl-C in the launcher stops only this archive's project. Retain failures as evidence; if LiteLLM cannot start with `noexec`, diagnose that compatibility failure before changing the proxy mount.

The encrypted Linux image passed the Docker smoke: recovery creation, saved Self fields, original upload/download, session/origin gates, container recreation, cache-loss rebuild, recovery after a forced container kill, and encrypted durable-file/permission checks. Earlier packaged adapters also passed fictional application tool/readiness checks with container networking disabled. Those adapter paths are superseded, and their synthetic responses do not establish LiteLLM provider authentication, model quality, hardware suitability, TLS proxy deployment or real-device WebAuthn PRF support.

Earlier all-profile rebuild, PDF and writer-exclusion results remain historical in the previous engine record. They describe the earlier portable runtime and do not replace verification of the current encrypted lifecycle. Real-provider completion gates remain in [model providers](model-providers.md).
