# Deployment readiness brief

_Last updated: 2026-09-23._

**What this is.** A work brief for an agent session. It collects work worth doing _regardless of
whether Circus Health is ever deployed remotely_, and that would otherwise be done under deployment
pressure. Deployment itself remains undecided and unauthorized.

**What this is not.** Not a design, not a release gate, and not authorization to provision hosting,
publish the repository, or run a real provider. Task status is maintained only in the
[application work list](application-todo.md) using `CRS-###` identifiers; nothing here creates a
second backlog. The deployment proposal this derives from is
[remote-deployment-design.md](remote-deployment-design.md).

## Hard constraints

Not negotiable, and enforced outside this document.

- **No Git writes.** No commit, push, branch, tag, rebase or history rewrite. Leave changes in the
  working tree and say what to run; the human commits. A `PreToolUse` hook denies non-read `git`
  subcommands, including inside compound commands.
- **No repository history rewrite, no `.git` removal, no publication.** CRS-007 assigns history
  reinitialization to the user.
- **No provisioning.** No DigitalOcean, DNS, Tailscale, registry or Terraform apply.
- **No real-provider runs.** Budgeted and human-gated under CRS-038, CRS-039 and CRS-066. Do not
  start one to "get a measurement."
- **No health records, recovery material, credentials, logs or generated runtime databases in Git.**
  Tests and documentation use independently fictional data.
- **Preserve open requirements.** Do not close, delete or narrow a work-list item. If one turns out
  to be already satisfied, say so with evidence and let the human decide.
- **Verify before claiming.** An old plan or receipt is not proof of current behavior.

## Precondition — check this first and stop if it fails

The repository history still contains development profile archives: `data/checkpoints/*.sqlite` at
roughly 76 MB each and 49 MB `data/profiles/*/curation/snapshots/*.json`, across several revisions,
accounting for most of a 299 MB `.git` against a working tree whose largest tracked file is 276 KB.
`/data/` is now ignored and a content scan found no credential material in tracked files, but
unreachable objects stay fetchable by hash and survive in forks and caches, so a force-push does not
remove them. The migration to a fresh repository with no history is the user's task.

**Before any other work in this brief, verify the migration has happened.** At minimum: total
`.git` size, object count, and whether any object matches the ignored data paths above.

If it has not happened, **stop and say so plainly** — "this does not look like a clean repository
yet; history still contains development archives" — and do not proceed to deployment-preparatory
work. Items 1 and 2 below are independent of the repository state and may still be done; item 3 is
not. Do not attempt the migration yourself.

A re-runnable verification script for this check is a welcome deliverable: argument-driven, no
hardcoded paths, safe to run against a candidate repository before its first push.

## Read first

1. [`docs/application-todo.md`](application-todo.md) — the authority. Read CRS-046, CRS-084, CRS-086
   and CRS-087 in full.
2. [`docs/remote-deployment-design.md`](remote-deployment-design.md) — sections P1, A4 and E.
3. [Import reconciliation](import-reconciliation.md) and the current CRS-046 requirement describe
   the collision guard and remaining migration boundary. Verify current implementation evidence
   before repeating a historical fix; private notes are not a prerequisite.

## Environment

Verified 2026-09-23. Skipping this costs an hour of confusing failures.

- **Node 24 is required** (`.nvmrc`, `engines: >=24.19.0`). The suite loads `.ts` directly; Node 20
  cannot. A subshell missing the nvm switch fails every test file with `ERR_UNKNOWN_FILE_EXTENSION`,
  which is not a code problem.
- **`qpdf` must be on PATH** for native PDF extraction. Without it `test:server` reports **28 failures,
  all native-PDF tests failing `PDF_NATIVE_UNSUPPORTED`** — the known-clean baseline on a machine
  without qpdf is 1,091 of 1,125 passing, 6 skipped. Those 28 are not regressions; do not "fix" them.
  Confirm the count matches before and after your changes.
- **Exit codes lie if you pipe to `tail`.** Read the summary lines.

## The work, in order

### 1. CRS-046 — migrate the clinical key to carry report scope

**Why now, specifically.** The collision guard is implemented and refuses rather than merges, so the
silent-merge defect is closed and this is no longer a correctness emergency. What makes it urgent is
timing, not severity: the migration is expensive only because the key domain is **persisted**. All
current local data is development data, and any hosted archive would start from a fresh import — so
doing this before real records are accepted costs no migration at all. **That window closes
permanently once a real archive exists.** CRS-046 now records this argument; read it there.

**Evidence.** `src/server/intake-source-identity.ts` pins two deliberately distinct v1 domains:
`clinicalSourceIdentityV1` hashes `['origin', sourceSystem, sourceRecordId]` while
`candidateSourceIdentityV1` additionally folds `[report.memberId || null, report.subject]`. The
clinical key therefore does not separate report subjects; the guard compensates by refusing.

**Done looks like.** The clinical key carries report scope, dependent receipts and exceptions migrate
with it, and the refusals the guard currently produces for distinct-subject entries become ordinary
correct separation. The staged, versioned migration CRS-046 already requires still applies — this
item removes the _data_ cost of that migration, not the requirement for it.

**Ask before starting.** Confirm with the human that no archive they intend to keep has been created.
If one has, this item reverts to its normal staged cost and should be re-planned, not rushed.

### 2. CRS-087 — PDF heading extraction feasibility spike

**Why now.** CRS-086 is blocked on a post-eviction measurement that is human-gated and costs provider
budget. This spike is not, and costs nothing. If its assumption is false, CRS-086 is much larger than
it currently looks.

**The assumption.** CRS-086 proposes extending the mechanism HTML and text already use.
[`src/server/intake-plan.ts:118`](../src/server/intake-plan.ts#L118) `extractionUnits` accepts
`unitSize` and `overlap`; the PDF branch honors overlap (`start = end + 1 - overlap`) but defaults it
to `0`; HTML and text units attach header rows and the preceding heading to every unit.
`sharedHeadings` is derived from an HTML navigation index PDFs never build.

**Done looks like.** A recommendation, not a feature: does the pdf.js text layer expose repeated table
column headers as distinguishable runs, tested against real multi-page tabular PDFs? Report whether
this is plumbing or parsing, with examples. Label anything built throwaway.

**Out of scope.** Do not change the PDF `overlap` default, implement CRS-086, or add page triage
(withheld under CRS-044). A spike result does not substitute for CRS-086's measurement.

### 3. CRS-084 — session expiry, and a decision on pre-login disclosure

Narrow, and deliberately smaller than it first appeared.

**Session cookies are already the right mechanism — do not change them.**
[`src/server/vault-app.ts:82`](../src/server/vault-app.ts#L82) sets
`circus-session=…; Path=/; HttpOnly; SameSite=Strict`. `HttpOnly` keeps the value unreadable by page
scripts and `SameSite=Strict` closes cross-site attachment, so the usual argument for moving a session
to browser storage does not apply here — that move would forfeit `HttpOnly` and gain nothing. The
cookie also carries no key material: keys are memory-only server-side, and `requireAccess` returns
423 when the profile is not open. `Secure` is absent because the supported path is HTTP on localhost;
it becomes required the moment anything is served over TLS, and belongs with that change.

**The actual gap is expiry.** Sessions are in-memory so a restart clears them, but there is no idle or
absolute timeout. CRS-084 already lists session expiry and resource limits; implement against that
item's wording, not this summary.

**Decide, do not silently change: pre-login disclosure.** `/api/profiles`, `/api/storage/archive`,
`/api/ai/status`, `/api/ai/test-connection`, `/api/profile-setups/resume` and `/api/profile-setups`
answer before authentication, exposing profile display names and archive byte totals. This is an open
question in the deployment design and narrowing it may break the unlock flow. Write down what each
route discloses and why it is or is not acceptable; change behavior only if the answer is clearly no,
and say so rather than deciding silently.

**Response-body capture, while in the area.** `deploy/litellm/response_diagnostics.py:12` sets
`RESPONSE_BODY_PATH = Path('/tmp/circus-litellm-response-body.txt')` and writes up to 8 MiB of
plaintext model responses. It is gated, defaults off, and `deploy/litellm/configure.py` already fails
closed against operator-set callbacks. Make enabling it impossible outside an explicit development
configuration, or loud and recorded. Do not delete the capability; it is a real debugging tool.

## Deferred with the deployment decision — do not do these now

- **Hosted admission.** [`src/server/runtime.ts:106`](../src/server/runtime.ts#L106) rejects any
  request whose `Host` header is not `127.0.0.1` or `localhost`. This blocks serving a real hostname,
  but there is no hostname to allow until deployment is decided, and the effective control today is
  the Compose binding `127.0.0.1:${PORT:-3001}:3001`, which is sound. The header check is redundant
  with a correct control, not a live weakness. Worth one comment so nobody later removes the binding
  believing the header check covers it — nothing more.
- **CRS-088, profile-less passkey unlock.** A first-class feature in its own right, and it would
  cut re-entry to one gesture locally as well as hosted — but it is gated on CRS-072, real-device
  passkey and PRF acceptance, which is still open and needs physical authenticators. Do not build a
  usernameless flow on an unlock path that has not been confirmed against real devices. Once CRS-072
  passes, this becomes a strong candidate for the next brief.
- Deployment design sections B and C.
- CRS-044 triage and Tier 2 reading concurrency, both explicitly withheld.

## Reporting

For each item: what changed, what was verified and how, what was left open and why. State plainly
which claims are tested and which are read-carefully-and-believed — they are different claims.
Confirm the `test:server` count against the qpdf baseline. Leave everything in the working tree.
