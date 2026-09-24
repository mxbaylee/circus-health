# Remote proxy, hosted deployment and placement metrics

_Proposed design, 2026-09-23. Not a deployed service, not a supported installation path, and not
authorization to provision hosting._ The current supported path remains
[npm → Docker Compose → LiteLLM](installation.md). This document specifies work; it closes no
release gate. Task status is maintained only in the [application work list](application-todo.md).

Related: [private home deployment options](home-cloud-deployment.md) records the placement
options and dated prices this design builds on. CRS-079 already asks for the local-versus-hosted
comparison specified below.

## Scope

Two deployment modes, with **separate archives**. The local instance is a development instance
holding independently fictional data. The hosted instance holds the household archive. Nothing
synchronises them.

1. **App local, proxy remote.** Development. The archive and the app stay on the maintainer's
   computer; model requests go to the private remote proxy.
2. **App and proxy remote.** Household use. Devices reach the app over the private network.

The hosted archive starts empty: sources are imported fresh, and all existing local data is treated
as development data. No archive migration is in scope.

Separate archives are a requirement, not an accident of the current implementation.
[Deployment](deployment.md#filesystem-and-process-requirements) enforces one writer through
`.health-writer.lock`, and those advisory locks are filesystem-local: two computers cannot see
each other's lock. The vault also publishes a single accepted record-stream head per profile.
Two writers would fork that head silently. Do not add synchronisation between the two instances
without a separate design for merge and conflict.

## Prerequisites

Two pieces of work come before any deployment work, in this order or in parallel with each other.

### P1. Clean repository migration

The current Git history contains development profile archives — `data/checkpoints/*.sqlite` at
roughly 76 MB each and 49 MB `data/profiles/*/curation/snapshots/*.json` blobs, across several
revisions, accounting for most of a 299 MB `.git` against a working tree whose largest tracked file
is 276 KB. `/data/` is now ignored, so the current tree is clean and a content scan found no
credential material anywhere in tracked files. The objects remain reachable in history.

A force-push does not remove them. Unreachable objects stay fetchable by hash, survive in forks and
caches, and persist until the host garbage-collects on request. The migration is therefore a new
repository with no history, with the old one deleted rather than left private. Verify the new
history is clean before its first push.

This gates publication absolutely, and publication gates free container-registry use, which is the
open registry question in section C. Treat it as prerequisite zero.

### P2. Real-device passkey acceptance

[Profile encryption](profile-encryption.md) records that real-device passkey and PRF acceptance
remains open. Section D builds on that path and section C's deployment cadence assumes re-entry
costs one authenticator gesture. Confirm the existing unlock path against the actual authenticators
before either assumption is relied on.

## Workload reality

The measured 2026-09-23 slice covered 20 pages. Real sources are much larger: a 900-page source is
in hand. A constant-rate scenario using 46.2 s of provider-request time and 122,254 input tokens
per page gives the following figures. Provider-request time includes proxy, transport and upstream
wait; it is not total import time. These are historical scenario calculations, not current-code
measurements or predictions for an arbitrary document:

| Pages | Provider-path time | Requests | Input tokens |
| ----- | ------------------ | -------- | ------------ |
| 20    | 0.3 h              | 31       | 2.4 M        |
| 100   | 1.3 h              | 155      | 12.2 M       |
| 900   | 11.5 h             | 1,395    | 110 M        |

Against the whole-job bounds of two active hours, 16 slices, 256 turns, 2,048 requests and
20 million measured tokens, three things follow.

**Time would bind slightly first under these assumptions.** Two hours at 46.2 seconds per page
allows about 156 pages. The 20-million token allowance includes input and output: at 122,254.5
input plus 1,314.7 output tokens per page it allows about 162 pages. This corrects the earlier
claim that tokens bind first. Both allowances would be exceeded in the 900-page scenario; its
projected request count still fits.

**This scenario requires repeated explicit continuation.** A 900-page source would need at least
six time allowances: the initial allowance plus five explicit Resumes, with an unlocked profile.
This is not proof that current code or a particular real document requires those extensions.

**These projections use pre-eviction numbers and cannot establish current feasibility.** They come from a run
whose per-request input grew from 11,446 to 136,739 tokens; transcript eviction landed afterwards
and CRS-039 records that the post-eviction per-page rate is unmeasured. Current tokens, elapsed
time, requests, turns and slices all matter. Token rate alone does not decide completion or prove
extraction accuracy. A budget stop with explicit Resume is also different from an inability to
process the source at all.

### How the 900-page projection was derived

From the retained 2026-09-23 slice: 20 pages, 31 provider requests, 2,445,090 input tokens, 26,294
output tokens and 104,960 reported cached input tokens.

    input per page   = 2,445,090 / 20 =  122,254
    output per page  =    26,294 / 20 =    1,315
    900 pages        -> 110.0 M input, 1.18 M output

A page does not contain 122,254 tokens. That figure is the cumulative cost of resending the
transcript on every round trip for that page: per-request input rose from 11,446 to 136,739 tokens
across the slice, so later pages each carried the accumulated history of earlier ones. This is the
quantity transcript eviction attacks. The projection is neither a proven upper bound nor a
current estimate: other documents, rereads or provider conditions can exceed it. Cached input
was 104,960 tokens, about 4.3 percent of input, with the optional cache
setting off.

### What an 800-page import must achieve

One default allowance requires averages no greater than 25,000 reported input-plus-output tokens,
nine active seconds and 2.56 physical provider requests per page across 800 pages. The 256-turn
and 16-slice limits must also fit. These are necessary averages derived from the current limits,
not a prediction of extraction quality or completion. Explicit Resume grants another allowance.

An offline 2026-09-24 experiment extended the existing
[controlled PDF harness](../src/server/test/intake-pdf-controlled.integration.test.ts) to an
800-page dense fictional PDF, using the current application, native-PDF bridge and Import
coordinator with unchanged production budgets. A scripted provider read one page per tool call
and published one synthetic record per page in ten-page batches, an existing configurable plan
size. All 800 pages were delivered and all 80 units accounted for in 896 requests and 14 slices,
with no budget extension, unchanged original hash and no accepted records. Local execution took
about 303 seconds; this measures the synthetic host workload with immediate scripted replies,
not real model processing time or deployment performance.

The same run sent 393,189,513 serialized text characters cumulatively, excluding media data; its
largest request contained 822,130 text characters and at most two PDF parts. First requests in
fresh contexts ranged from about 46,000 to 65,000 characters, while the last requests grew to
roughly 690,000–822,000. This establishes repeated context in this workload despite existing
evidence eviction. Characters are not provider tokens, and current capped 64-request contexts
must not be modeled as one uninterrupted quadratic 800-page conversation.

Repeating the same 800-page fixture with the default two-page plan size and one publication per
unit stopped at `job_limit`: 671 pages delivered, 670 records in 335 accounted units, 65 units
still remaining, 1,024 requests and 16 slices. It sent 830,087,567 text characters before stopping;
the largest request was 1,532,547 characters. There were no budget extensions or accepted records,
and the original hash remained unchanged. The batch container's terminal status was `complete`,
but its item reason and reading checkpoint explicitly reported the budget pause; that container
status does not establish complete document coverage. Local execution took about 757 seconds.

The scripted schedule explains the difference. With one tool call per response, 800 reads plus
80 ten-page publications and two setup calls require 882 executed calls. Each full 64-request
context can execute 63 calls and use its final response to acknowledge results, giving 14 contexts
and 896 requests. Two-page publications instead require 1,202 executed calls, which would need
20 contexts and 1,222 requests; the default 16-slice allowance stops first. This proves a budget
failure for that particular schedule, not for every possible model behavior or plan. Larger
batches are not validated extraction-quality recommendations, and this comparison does not
establish adaptive section boundaries or a live-model speedup.

This is a counterexample to an absolute claim that the current pipeline cannot traverse 800 pages.
It does not establish real-model feasibility: the fake provider retained perfect progress outside
its conversation, generated records from page numbers rather than extracting them, and reported
no token usage. The measured-token gate was therefore not exercised. Provider accuracy, media
tokenization, elapsed time and autonomous recovery remain unqualified. A new adaptive scheduler
has not been implemented or shown superior by this experiment.

### Historical 900-page cost illustration

For the 2026-09-23 pre-eviction constant-rate scenario only, cost follows once the applicable
provider rates are known:

    cost ~= 110.0 x (input rate per million)  +  1.18 x (output rate per million)

At illustrative input rates — these are placeholders for sensitivity, not quoted prices — 110 M
input tokens costs roughly 550, 1,100 or 1,650 units at 5, 10 or 15 per million respectively.
Output tokens are about one percent of input-token volume; their cost share depends on the separate
output rate. Substitute the configured route's actual published
rates before treating any of it as a budget.

Transcript eviction landed after that 2026-09-23 slice. A reduction in one removed payload is not the same
as a whole-request or whole-import reduction; current repeated context, rereads and provider media
usage require measurement. Provider prompt caching can change the price of eligible repeated
prefixes when supported, but does not eliminate context limits or necessarily reduce the app's
reported-token accounting. CRS-039 must measure actual usage and latency separately.

**Transport needs its own measurement.** As a bandwidth-only illustration, 0.9 decimal GB would
take about 206 seconds at 35 Mbit/s or 14.4 seconds at 500 Mbit/s, before protocol overhead and
latency. Neither that transfer volume nor sustained bandwidth has been established for a current
900-page import. Provider-request timing includes transport and proxy work, so it cannot by itself
rule out a transport constraint or determine placement.

## A. Placement metrics

### The problem

The application records one duration for a provider request. That duration covers the local
proxy, the network, upstream queueing and the provider's own work, and
[import performance](import-performance.md) is explicit that it "does not measure upstream
compute separately." Moving the proxy may affect several components of that duration; comparing
two aggregate numbers cannot identify which component changed or establish upstream dominance.

The measured 2026-09-23 slice spent 923,903 ms of 931,179 ms in 31 provider-request spans, against
274 ms of upload receive and about 2,389 ms across 20 host page reads. Any placement claim has to
survive that ratio.

### A1. Transport probe

Two measurements, neither of which calls the provider.

- `proxyRttMs` — timed `GET /health/liveliness` against the configured proxy. Median of five
  samples; discard the first. The compose healthcheck already uses this route.
- `proxyUploadMbps` — timed `POST` of a fixed-size payload of incompressible random bytes naming
  a model that is not in `model_list`. [configure.py](../deploy/litellm/configure.py) pins
  `config['model_list'] = [selected]`, so an unknown model is rejected at the proxy: the bytes
  cross the wire and are measured, and nothing reaches the provider or is charged.

Retained fields, correlated by the existing `providerRequestId`:
`proxyRttMs`, `proxyUploadMbps`, `proxyProbeAt`, `proxyProbeSamples`,
`proxyEndpointKind: loopback | remote`. The probe runs on request and once at the start of any
import with diagnostics enabled, so a retained run describes its own transport conditions.

The payload is generated fictional bytes. No medical evidence, no profile content.

### A2. Upstream split — verify before building

**Step 0, required first:** issue one authenticated request to a running proxy and inspect the
response headers for an upstream duration reported by LiteLLM 1.99.1. If the pinned build already
emits one, the whole of A2 reduces to reading a header in `proxy-model-bridge.ts`, which today
reads no response headers at all. Do not build the callback before answering this.

If no such header exists, the callback pattern is already established. A second `CustomLogger`
module, gated by a new `CIRCUS_LITELLM_TIMING` flag validated exactly like the two existing flags
at [configure.py:110](../deploy/litellm/configure.py), recording `start_time`, `end_time`, model and
a correlation identifier. Never bodies, never prompts. Note that `litellm_settings['callbacks']` is
assigned rather than appended, so enabling more than one project callback requires building that
list conditionally.

**The unresolved difficulty, stated plainly.** The existing hook publishes to a file inside the
proxy container. That works for a local proxy and is useless for a remote one, which is exactly
the case being measured. A `CustomLogger` runs in the logging path and cannot set response
headers. If Step 0 finds no native header, the honest fallback is to **model** the split rather
than measure it: A1 supplies round-trip time and throughput, request payload size is known, so
transport is approximately `bytes / throughput + rtt` and proxy overhead remains folded into the
remainder. That is less precise and still sufficient to decide whether placement helped or hurt.
Prefer it over patching the proxy image to add a read endpoint.

### A3. Metrics on disk, served from an endpoint

Permitted, with four constraints.

1. **Reuse the existing allowlist.** Serialize through the same default-deny `safeFields` path in
   `import-diagnostics.ts`. Do not introduce a second serializer; a metrics-specific one would not
   inherit the value patterns that keep document text out.
2. **Separate route, authenticated.** Not `/health/ready`. The host-header defect in A4 must be
   fixed first.
3. **No `profileId` in the exposed payload.** It is opaque, but it is a durable correlation handle
   and this endpoint is reachable from outside the process.
4. **Bounded and evictable**, following the retention rules already in
   [INTAKE.md](../src/server/INTAKE.md).

### A4. Pre-production checks

Three, as tests and startup assertions rather than documentation.

- **Raw response capture is off.** `CIRCUS_LITELLM_CAPTURE_RESPONSE` must be `false` and
  `/tmp/circus-litellm-response-body.txt` must not exist. This is the one place plaintext clinical
  content reaches disk today: [response_diagnostics.py](../deploy/litellm/response_diagnostics.py)
  writes up to 8 MiB of raw model response body under that flag. It is already default-off, mode
  `0600`, on `noexec,nosuid,nodev` tmpfs under a read-only rootfs, with container logging disabled.
  The check asserts that posture rather than assuming it.
- **Loopback gating is not a host header.** `runtime.ts` currently returns 403 unless the `Host`
  header matches `127.0.0.1` or `localhost`. Behind any reverse proxy that rejects the healthcheck
  and the deploy feedback loop; worse, a request to a public interface carrying `Host: localhost`
  passes it. Today the compose binding `127.0.0.1:${PORT}:3001` provides the real protection, and
  hosting removes that binding. Replace the header test with a trusted-peer or explicit
  allowed-origin check before any remote exposure.
- **Pre-login disclosure is a decision, not an inheritance.** `GET /api/profiles` exposes display
  names and icons and `GET /api/storage/archive` exposes byte totals, both before authentication.
  Record whether private-network admission is accepted as sufficient.

### A5. Rejected: hosted observability vendors

Datadog and equivalents are rejected for three independent reasons. The proxy configuration guard
already refuses operator callbacks outright — "Circus Health config cannot enable fallback routes,
payload logging, caches, databases or callbacks" — and a vendor integration is exactly that shape.
Routing telemetry from a health-record request path to a third party contradicts the documented
threat model. And the free tiers do not fit: one-day metric retention cannot support a comparison
run a week apart, and tracing is not included.

Self-hosted Prometheus and Grafana avoid the privacy objection but remain disproportionate:
two additional services to secure on the host, to answer a question about two numbers on a
single-user application. Revisit only if the hosted instance later needs continuous health
monitoring, which is a different question from this comparison.

### A6. How to decide placement, and when to stop measuring

Three claims are at stake and they need very different effort.

**Local resource relief is already established.** The proxy container measured roughly 0.9 GiB
including file cache plus a CPU allocation. Removing it from the development computer is a
reduction by definition; container resource statistics before and after are sufficient evidence.

**The development-loop benefit is structural and needs no measurement.** Every local launch
currently waits on `depends_on: litellm: condition: service_healthy` with a 180-second start period.
Removing the service removes the wait.

**Only "hosting does not make imports worse" needs evidence, and it can be predicted first.**
Added latency is approximately `payload bytes / uplink throughput + requests × 2 × round-trip time`.
With known uplink speed and the workload table above, compute the expected penalty before building
anything. Where the prediction is a small fraction of import time — as it is at every size measured
so far — the A1 probe becomes a confirmation rather than an investigation.

Record the threshold before running the comparison: state the percentage of import wall time that
added transport must not exceed, and revert to a local proxy if the measurement exceeds it. Choosing
that number afterwards converts the measurement into a justification.

## B. Remote proxy

### Additive, not a reversal

`AI_URL` is currently a **retired** option. [run.py:258](../deploy/run.ts) raises
"Retired options … Circus Health only runs in Docker through LiteLLM." Reintroducing remote-proxy
support reverses a deliberate decision, so make it additive: a new `LITELLM_URL` that, when set,
skips the local `litellm` service and drops the `depends_on` coupling, and when unset preserves
today's behavior byte for byte. Offline development keeps working.

The dev-loop benefit is direct. `compose.yaml` currently makes the app wait on
`depends_on: litellm: condition: service_healthy` with a 180-second start period; observed proxy
startup was 59/130 seconds before the Docker Scout indexing change and 10/10 seconds after. In mode
1 that wait disappears entirely.

### What actually needs work

Not bandwidth. With fast symmetric residential service the transport cost is not the constraint:
100 MiB at 500 Mbit/s is roughly 1.6 seconds and 31 round trips at 20 ms is roughly 1.2 seconds,
against a measured 923-second import. The real items are:

- **Provider authentication state moves.** `CIRCUS_AUTH_DIR` holds the ChatGPT `auth.json` and is
  bind-mounted into the proxy container. Hosted, it lives on the server, and `npm run login:chatgpt`
  must target the remote. This is the largest piece of work in this section.
- **Shared master key.** Currently generated per run and mounted as a Docker secret from
  `CIRCUS_PROXY_KEY`. Both the local app and the hosted app need the same value, provisioned
  deliberately.
- **Offline capability regresses** in mode 1 whenever connectivity is lost. The additive
  `LITELLM_URL` design preserves the local fallback.

### Bandwidth trade-offs, recorded

The three placements differ sharply in how many bytes cross the maintainer's uplink, and the
most appealing option is the least efficient:

| Placement               | Bytes over the home uplink                                    |
| ----------------------- | ------------------------------------------------------------- |
| Both local              | None beyond provider traffic                                  |
| App local, proxy remote | Every page on every request — 31 requests for a 20-page slice |
| Both remote             | The uploaded file once                                        |

Three refinements. The workload is upload-heavy and residential service is usually upload-poor, so
on an asymmetric connection this moves traffic onto the thinnest available link; on symmetric
service the effect is small. Requests are sequential, so transport cost adds rather than overlaps.
And the remote-to-provider leg is likely faster and less variable than home-to-provider, returning
part of the cost.

The coupling worth acting on: **prompt caching changes the byte profile.** If CRS-039's
`cache_control` is accepted on the configured route, repeated bytes fall sharply, and transcript
eviction already removes roughly 30x per evicted page. Settle the cache question before measuring
placement, or the placement measurement describes a byte profile that is about to change.

Mode 2 has the best transport profile and the weakest privacy position: the server holds unlock
material and reads decrypted records while a profile is open. This is not zero-knowledge hosting.

## C. Deployment on merge to main

### Approach

GitHub-hosted runner joining the private network for the deploy step. The alternatives were a
self-hosted runner on the server, which executes workflow code on the machine holding the
household archive, and a registry-pull timer, which removes the feedback loop this approach is
chosen to preserve: a green check on main should mean the new version is actually serving.

Credentials are an OAuth client rather than a reusable auth key, held as repository secrets, with
an access-control tag restricting that ephemeral node to the server and to the deploy port only.
Match the existing [code checks workflow](../.github/workflows/code-checks.yml) posture: actions
pinned by commit, `permissions: contents: read`, `persist-credentials: false`.

Image distribution is a registry, not an on-server build; `home-cloud-deployment.md` already
requires "pinned images built outside the small production server." Note that a private repository
draws on GitHub Packages storage and transfer quota, which a container image consumes quickly on
the free plan. Confirm the quota, or use the hosting provider's registry, before relying on this.

### Hostname and certificate

Use a maintainer-controlled name, `circus.baylee.dev`, rather than the private network's own
generated name. Obscurity is not a control here and cannot be achieved anyway: any publicly trusted
certificate publishes its hostname to Certificate Transparency logs permanently. The reason to
prefer an owned name is that WebAuthn binds credentials to it. `profile-passkeys.ts` filters by
`rpID`, and [home-cloud-deployment.md](home-cloud-deployment.md) records that changing hostname
requires fresh recovery and passkey enrollment. A name on infrastructure that might change means
re-enrolling every credential when it does.

Point the record at the private network address, which is not routable from the internet, and issue
the certificate by DNS challenge so no public listener is required. The accepted costs are the
hostname appearing in transparency logs and the record disclosing the private-network address;
neither is reachable.

Fix this name before enrolling any credential.

### Provisioning

Terraform, in an `infra/` directory in this repository, covering the server, firewall, object
storage and DNS record, with first-boot configuration supplied by cloud-init. State holds secrets in
plain text and must never be committed. Terraform provisions the machine; the existing launcher
still deploys the application.

### Backup

The archive is ciphertext at rest, so untrusted object storage is acceptable. Use restic, which adds
deduplication, integrity verification and its own encryption, so the store cannot see file names,
per-object sizes or public cards.

Apply the 3-2-1 rule: three copies of the data, on at least two different kinds of storage, with at
least one in a different physical place. Concretely, the live archive on the server, a restic
repository in the provider's object storage, and a periodic restic snapshot to an external disk kept
at home. The first two are one vendor and one account, so they share failure modes — account
compromise, billing suspension, a deletion with a shared token — which is exactly what the third
copy answers. Scope the object-storage key to write without delete.

Back up `DATA_DIR` specifically. Whole-disk server snapshots are not a substitute: they sweep up
provider credentials and the proxy key alongside the archive, which `home-cloud-deployment.md`
warns against. Provider authentication state is backed up separately.

The third copy may be automated to a second provider instead of a manual disk, without weakening
the arrangement, provided the credential cannot destroy what it writes. Use an append-only key —
write without delete or overwrite — and object lock with a retention period, so stored snapshots
cannot be removed even by a holder of full account credentials until that period expires. The
threat to defend against is destruction, not disclosure: the repository password must live on the
server for an unattended backup, so an attacker holding the server can read the repository, but its
contents are the archive's own ciphertext and the profile key is never written to disk. Full server
compromise therefore still yields encrypted records absent a recovery key or passkey. Use distinct
credentials per destination.

Keeping one copy that no automated credential can reach at all remains worthwhile, since a second
provider is a different vendor but not a different everything.

The recovery kit is not one of the three copies. It is the key, it never travels with the archive,
and anyone holding both can open it. The backup passphrase is a second secret of the same class:
losing it makes every automated copy unreadable, so it belongs with the recovery material and not
only on the server.

Practise a restore before relying on any of this.

### Cadence and superseding an in-flight deployment

Every merge to the main branch deploys. A newer deployment supersedes an older one that has not yet
reached its point of no return.

That point is precisely when the running container is stopped. Before it — building, publishing,
waiting for the deferral condition, or draining — nothing is committed and the older run can be
abandoned, because the current version is still serving normally. After it, nothing is serving until
the replacement is ready, so the swap, the readiness check and any rollback must finish. Cancelling
there is the one action that can leave the service down or a failed version live with no recovery.

Two mechanisms, matching the existing [code checks workflow](../.github/workflows/code-checks.yml),
which already cancels superseded runs:

- A workflow concurrency group with in-progress cancellation, covering build, publish, deferral and
  drain.
- A lock held on the server across the committed window. A newer deployment waits for that lock
  rather than cancelling it, then proceeds immediately. Deployments therefore never interleave and
  a half-completed swap is never abandoned.

This composes well with the deferral guardrail. Merges landing while a profile is unlocked queue
rather than interrupt, superseding one another as they arrive, so when the profile finally locks a
single deployment runs carrying the newest code.

### Verified deploy, using what already exists

`buildId` is already stamped at build time as a random UUID by
[build-identity.ts](../src/scripts/build-identity.ts), written to `src/dist/build-info.json`, read
by `readBuildId()`, and returned from `/health/ready` and `/api/runtime`. The workflow builds the
image and therefore knows the identifier it produced, so the final step polls the deployed instance
until the reported `buildId` matches, with a timeout.

This needs no new field and exposes no commit identifier to an unauthenticated caller. It does
require the A4 host-header fix, because the endpoint carrying `buildId` is currently unreachable
through a reverse proxy.

### Guardrails

- Refuse to swap while an import is active: check the writer lock and active-run state.
- Snapshot the archive and record the outgoing image digest before swapping.
- Health-check after the swap; on failure, roll back to the recorded digest automatically.
- **Never deploy a vault or schema migration automatically.** Manual flag only. CRS-046's
  versioned migration is open, and an automatic deployment carrying an unversioned migration is
  the failure this rule exists to prevent. Image swaps alone do not touch the archive, which is a
  bind mount; migrations are the only path that does.
- Main currently carries commits titled `wip`. Deploying on merge ships those. Decide branch
  protection alongside this.

### Restart without losing an import

Hot reload is not available and is not required. Node has no equivalent of JVM class redefinition,
and more fundamentally the writer lock permits one application process per archive, so blue-green
against the same archive is prevented by design rather than by omission.

The mechanism that solves this already exists. CRS-039 implemented continuation: interruptions
retain unconsumed evidence for a later slice, the conversion checkpoint is durable, and Stop and
lock are immediate. The deploy sequence is therefore **drain, stop, swap, restart, resume**, where
draining stops new work from starting and allows the in-flight provider request to complete within
`HEALTH_AI_PROXY_TIMEOUT_SECONDS` rather than cancelling it and discarding tokens already spent.
Size the drain deadline against that request timeout rather than the swap window; 60 seconds is a
reasonable starting point, since waiting the full 300 seconds makes every deployment potentially
five minutes long to save one request's tokens.

Only uploads must be refused during drain. Upload staging is tmpfs and
[deployment.md](deployment.md#filesystem-and-process-requirements) records that removing the
container discards it, so a transfer in progress would be destroyed. Model work is checkpointed and
resumes, so new imports of already-published originals need not be refused. Reads, reviews and
navigation are served normally throughout: draining stops new volatile work, it does not stop
serving.

Requests arriving during the swap itself — after the lock is released and before the replacement is
ready — should be held at the reverse proxy already terminating TLS, with a cap below browser
patience and a maintenance response beyond it.

Because every restart locks every profile (see section D), extend the guardrail: defer the swap
while any profile is unlocked, using a boolean derived from `manager.opened` and carrying no
profile identifier. For a single household the archive is unlocked a small fraction of the day, so
deployments land in the gaps. Provide an explicit override for deploying anyway.

## D. Passkey as a first-class unlock method

_Tracked as CRS-088 in the [work list](application-todo.md), which owns it. This section motivates
it and records the design; it is not a second backlog entry._

### Why this belongs with the deployment work

Every deployment logs every user out, by two independent mechanisms. The HTTP session map in
`vault-app.ts` is process memory, and the profile data key exists only in the running process:
[vault format](vault-format.md) states that raw keys "remain in memory … never archive files", and
locking "clears live key references". `requireAccess` checks both the session and `manager.opened`,
so neither survives a restart. A replacement instance therefore starts locked and cannot continue
work until a person unlocks it, which [INTAKE.md](../src/server/INTAKE.md) also requires as policy:
startup "persist[s] an interrupted pause and never auto-resume[s] work".

That is correct behavior for medical records and should not change. What can change is the cost of
re-entry. Today it is: choose a profile, choose Use passkey, then authenticate. It should be:
authenticate.

This does not remove the logout. It makes the logout cheap enough that deploying is unremarkable,
and it pairs with the deferral guardrail in section C.

### The hard part already exists

An unlock passkey here is not only an authenticator; its PRF output unwraps the profile data key,
and each credential carries its own salt. A sign-in that does not yet know which credential the
user will choose must therefore supply every candidate salt in advance, keyed by credential.
`profile-passkeys.ts` already does exactly this, because one profile may hold several passkeys:

    prf: { evalByCredential: Object.fromEntries(allowed.map((p) => [p.id, { first: p.salt }])) }

The remaining limitation is scope, not cryptography. `authenticationOptions(profileId, …)` requires
a profile, reads that one keyring, and filters to the current `rpID`.

### The change

1. An options path that takes no profile identifier: read every profile keyring, union the passkeys
   whose `rpID` matches the current hostname, and build `allowCredentials` and `evalByCredential`
   from that union.
2. Retain the candidate set on the challenge record rather than a single profile.
3. Resolve the profile from the credential identifier the authenticator returns, then continue
   through the existing verification, unwrap and unlock path unchanged.
4. Apply the existing generation and freshness assertions to the resolved profile.

Keep `allowCredentials` populated with the union rather than empty. It is indistinguishable to the
user, and it avoids depending on whether an empty allow-list may be combined with per-credential
PRF evaluation.

Conditional mediation — offering passkeys through autofill without an explicit action — is a
separate, additive improvement. It is not required for the benefit described here.

### Constraints

- **Pre-authentication enumeration.** The union exposes how many passkey-bearing profiles exist to
  an unauthenticated caller. `GET /api/profiles` already discloses display names and icons before
  login, so this is not a new category, but it must be decided together with the pre-login question
  in A4 rather than inherited.
- **Hostname binding.** Credentials are filtered by `rpID`, and
  [home-cloud-deployment.md](home-cloud-deployment.md) records that moving to a new hostname
  requires fresh recovery and passkey enrollment for that origin. Fix the hosted hostname before
  enrolling anything, or plan to enroll twice.
- **Unverified foundation.** [Profile encryption](profile-encryption.md) still records that
  "real-device passkey/PRF acceptance remains open". Confirm the existing PRF unlock path against
  the actual authenticators before building a usernameless flow on top of it. If PRF does not work
  on those devices, re-entry falls back to a 24-word recovery phrase and the deployment cadence
  assumptions in section C no longer hold.

## E. Large-source completion (deferred)

**2026-09-24 review amendment.** The options below preserve earlier reasoning. The user now
requires productive background imports to continue without routine manual Resume at artificial
whole-job allowance boundaries; that direction is no longer an undecided option. Current code
still has those gates. Bounded model sessions remain useful and are distinct from cumulative job
limits. Partitioning solely to get another allowance and a mandatory upfront allowance that
recreates the same interruption are not the recommended design. The
[processing proposal](processing-context-proposal.md) appends the measured findings, corrections,
unselected alternatives and independent review criteria; CRS-039 and CRS-086 own the requirements.

Recorded here because it sets the deployment cadence and the budget questions above. Not scheduled;
do not begin before the measurement in the first step.

Under the historical constant-rate scenario, a 900-page source projects to roughly 110 million
input tokens against a 20-million input-plus-output allowance, and at least six time allowances
(five additional explicit Resumes). Sources of this size require current measurement; that
scenario alone does not establish whether today's implementation can complete a particular chart.

**First, measure — the option set depends on it.** Those projections use pre-eviction figures.
CRS-039 records that the post-eviction per-page rate is unmeasured. Establish current scaling with
offline transport/budget checks, then calibrate actual usage with a bounded provider test. If the
result brings a large source within the existing allowances, some of what follows is unnecessary.

If it does not, the options, none yet chosen:

- **Raise the allowances.** Simplest, and the one that removes a deliberate protection. Establish
  why the current numbers were chosen before changing them; they bound runaway provider spend, and
  a defect behind a raised ceiling is expensive rather than merely slow.
- **Partition the source.** Divide a large original into several budgeted jobs tracked as one set.
  The existing plan/unit model provides a starting point, but separate job allowances increase the
  aggregate authorization for one original. This requires an explicit aggregate budget decision.
- **Continue across allowance boundaries automatically.** Today only an explicit Resume grants a new
  budget. Automating it changes that deliberate authorization rule. A budget boundary alone does
  not lock the profile; after a restart or actual lock, authentication is still necessary to resume.
- **Skip low-yield pages.** This is CRS-044, which explicitly withholds triage until evidence
  supports it: low text density cannot by itself distinguish administrative content from missed
  extraction. Large charts make it attractive and the same caution applies.
- **Reduce cost per page.** Now tracked separately as CRS-086, which owns the design: bounded
  per-unit context — shared headings plus a small typed continuation summary — instead of resending
  the whole transcript. It is a product change, not a deployment concern, and is referenced here
  only because it decides whether a large source fits the budget at all. Prompt caching remains
  tied to CRS-039 and to whether `cache_control` is accepted on the configured route.

The interaction with deployment is direct. A source needing repeated manual continuation may span
multiple sessions and unlocks, depending on operator availability; days of elapsed time are not a
mathematical consequence. The deferral guardrail in section C and re-entry work in section D can
make such an import easier alongside ordinary deployments.

## Open questions

- Does the pinned LiteLLM build already report an upstream duration header? A2 Step 0 gates
  whether the timing callback is written at all.
- Is pre-login disclosure of profile display names and archive byte totals accepted under
  private-network admission, or does it need an enrollment gate? Section D's credential union
  widens the same surface and must be decided with it.
- What is the post-eviction per-page token rate? The workload table shows this decides whether a
  900-page source can complete under the whole-job token budget. Measure it in the CRS-038 run.
- What threshold of added transport, as a share of import wall time, would send the proxy back to
  the development machine? Record it before the comparison runs.
- ~~Where does the backup passphrase live?~~ **Resolved: 1Password**, alongside the recovery kit,
  with an operational copy on the server so unattended backups can run. The residual question is
  narrower: 1Password's own Emergency Kit becomes the single point of failure for every layer, so
  it must exist on paper off-device before any of this is relied on.
- Registry choice resolves once P1 completes and the repository is public; until then it is open.

## What this document does not do

It provisions nothing, authorizes no public signup, changes no supported runtime, and closes no
release gate. Provider qualification remains open under CRS-039 and CRS-066. Placement claims
remain unproven until the comparison in A1 runs on both configurations with the same route,
workload and disclosed cache conditions.
