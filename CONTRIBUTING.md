# Contributing to Circus Health

Thank you for helping improve Circus Health. This repository handles sensitive subject matter, so examples, fixtures, screenshots, and test archives must be independently fictional. Never commit personal records, credentials, OAuth state, recovery kits, runtime databases, or local logs.

## Before you start

Install Node.js 24.19 or newer for contributor checks. Root npm commands launch the product through Docker Compose and LiteLLM. Read the [code organization reference](docs/architecture/code-organization.md), [security model](docs/security/model.md), and the maintained contract related to your change.

Native server, browser and benchmark-tooling checks also require `qpdf` on `PATH` for scoped original PDF extraction: install it with `brew install qpdf` on macOS or `sudo apt-get install qpdf` on Debian/Ubuntu. These checks must exercise native PDF extraction rather than skip it when the executable is missing. The application image includes qpdf, and the Linux test jobs install it before the relevant suites.

Server source-capture fixtures also require Tesseract and English language data: `brew install tesseract` on macOS or `sudo apt-get install tesseract-ocr tesseract-ocr-eng` on Debian/Ubuntu. `tesseract --list-langs` must include `eng`. The application image and CI server jobs install these prerequisites; this does not replace the separately opted-in packaged OCR qualification.

Run `npm run icons` from the repository root after changing the canonical logo or brand palette. It generates the React, SVG, ICO, PNG, and manifest outputs in the pinned Node 24 Docker `brand-tools` stage, so rendering uses the pinned container toolchain; the launcher itself uses host Node. Contributors already using Node 24.19 or newer can run `npm run brand:generate` or `npm run brand:check` from the repository root directly.

Brand rasterization uses a pinned WebAssembly renderer and PNG encoder, giving the same bytes on supported macOS/Linux ARM64 and Linux x64 environments. Commit regenerated assets with their source changes. Builds and local brand checks verify the committed bytes strictly; they do not regenerate or tolerate visual differences. The workflow platform matrix documents supported macOS/Linux environments.

Keep changes focused. Preserve original evidence, append-only accepted history, profile isolation, explicit review before model-proposed writes, and the supported Docker/LiteLLM deployment boundary. Reuse shared components and types rather than creating feature-local copies.

## Source layout

- `src/app/` contains React UI, features, and browser data adapters.
- `src/server/` contains HTTP APIs, encrypted profile lifecycle, imports, model tools, and durable publication.
- `src/shared/` contains contracts safe for both browser and server use, including `schemas/health-record-v1.schema.json`.
- `deploy/`, `compose.yaml`, `Dockerfile`, and root npm scripts define the supported runtime.
- `docs/` contains maintained product, operations, architecture, data, and security references.

The complete placement rules and known duplication are in [docs/architecture/code-organization.md](docs/architecture/code-organization.md).

## Develop and verify

Install dependencies and run focused checks from the repository root. For each change, run formatting, type checking, and the relevant tests locally. GitHub Actions runs the full validation suite on pull requests; its required checks, together with independent review, must pass before squash merging. Run the full local suite when persistent CI failures justify reproducing them on your machine.

The focused baseline is:

```sh
npm ci
npm run format:check
npm run typecheck
```

Then run the test command relevant to the behavior you changed.

The complete local suite is useful when persistent CI failures need reproduction. Its lane commands are listed below for that purpose; routine changes do not require running every lane locally.

```sh
node scripts/repository-file-inventory.ts --check
npm test
npm run build:assets
npm run test:browser:run
npm run brand:check
node --test src/tests/brand-assets.test.ts
```

The offline proxy compatibility lane from `.github/workflows/code-checks.yml` is also part of full local validation. Build and run it from the repository root:

```sh
docker build --tag circus-proxy-test deploy/litellm
docker run --rm --network none --entrypoint python \
  -e LITELLM_LOCAL_MODEL_COST_MAP=True \
  --mount type=bind,source="$PWD/deploy",target=/workspace/deploy,readonly \
  --workdir /workspace/deploy/litellm \
  circus-proxy-test -m unittest test_chatgpt_stream_semantics test_native_pdf test_response_diagnostics test_configure test_chatgpt_login test_oauth_qualification
```

These commands cover the repository's current local validation lanes. Browser tests use an already built frontend, so run `npm run build:assets` first. Brand validation can run on macOS and Linux; where available, run it in both environments to check the supported platform outputs. A local run covers only the machine and platform used, so it does not replace evidence from another platform.

Use the narrowest meaningful test while iterating and run the relevant focused tests before submitting; CI runs the complete lanes. `npm run test:browser` builds the app and runs the browser suite; `npm run test:browser:run` expects an existing build. Browser tests may require additional local dependencies; see [src/README.md](src/README.md). Deployment changes also need `npm run test:deploy`; proxy Python tests run only inside the pinned LiteLLM container as shown in the workflow reference.

Routine Node suites use `src/scripts/test-suite.ts`. It clears inherited model/provider settings, private data/runtime roots and external-test opt-ins in child processes. Server tests exercise functions, disposable databases and narrowly scoped local HTTP runtimes; they require no built frontend, Compose deployment, LiteLLM service or provider account. Install qpdf and Tesseract with English language data (`qpdf tesseract-ocr tesseract-ocr-eng` on Ubuntu), as the CI server lanes do: ordinary PDF/image assistant fixtures exercise the real automatic source-capture prerequisite. Real encryption, persistence, PDF extraction and cache-loss rebuilds remain real where those are the contract under test. Live-provider, packaged OCR and deployment/container qualification files are excluded from the routine server list; run those explicitly with their documented opt-ins when qualifying the corresponding integration. Exercising source capture in fictional assistant fixtures does not replace packaged OCR qualification. Tests using local scripted upstreams remain in the routine suites.

`npm run test:browser` builds and runs the browser suite. `npm run test:browser:run` uses an already built frontend; finish builds before starting journeys in that checkout. Each file runs alone locally, with isolated app/storage state and a fresh Chromium. The shared browser harness supplies unavailable model/connection stubs unless a journey explicitly provides a scripted bridge. Browser tests require the app and its storage, not a third-party service. Real rendering, focus, PDF workers and WebAuthn stay browser tests; ordinary component and state behavior belongs in `test:ui` or `test:state`.

Routine Node tests default to a 30-second hang guard, browser tests to 60 seconds. Browser actions wait up to five seconds and navigation up to ten; the scope-specific source-review tabs also set their own bounded waits. A whole-test budget covers multiple steps and is not a performance target. The controlled 100-page continuation regression uses a test-local 900-second host hang guard and an 840-second completion wait for 100 durable page reads against an immediate fictional upstream. Its request, page, coverage, no-acceptance and original-hash assertions remain the correctness requirements; these guards do not measure model latency. The continuation runner retains its 180-second default for cases without an explicit timeout, while this case overrides that default. The CI continuation job allows 20 minutes, including dependency setup. The three-step field-correction browser case uses 120 seconds for its three durable edits, intervening reloads and refusal checks, final acceptance and complete saved history. Any longer fixture-specific budget needs a concrete integration reason. The runner reports the ten slowest tests above one second, including passes, so rising runtime remains visible. There are no automatic whole-test retries: fix the failed assertion, fixture ordering or infrastructure cause, then rerun explicitly.

The deferred-unit acceptance fixture uses 90 seconds for real encrypted publication, exact retry and database reconstruction. Each counted-acceptance race has its own host-integration guard and preserves the accepted records and receipt while proving refusal of a stale retry. The four-cycle assistant recovery and three-context private-trace fixtures use 90 seconds for their complete durable host sequences; their request, refusal and redaction assertions are unchanged. The 270KB manual-receipt copy uses 90 seconds for author/source certification, journal reconstruction and replay; the HTTP PDF workflow uses 120 seconds for conversion, review, mapping changes and encrypted reconstruction after SQLite deletion. The 33-record draft handoff fixture uses 120 seconds for native proposal and draft publication, complete policy comparison and two review sessions across cache disposal; reconstruction and handoff counts establish the reuse claim. These controlled fixtures make no model network requests.

The complete 140-question fixture uses a test-local 450-second host guard. Its controlled run took about 351 seconds through exact policy and tokens, late-blocker refusal, answering, cache-loss recovery and final acceptance. Every original assertion is retained; this is neither a model-latency target nor evidence of acceptable interactive performance. Counted collection and physical-head reads remain substantial and are documented in [bounded intake views](docs/data/intake-bounded-views.md).

The 257-artifact identity fixture also uses a 450-second host guard. Its complete
controlled run took about 412 seconds through real native history publication,
public membership, warm verification, cancellation and same-byte file-replacement
refusal. Its 449 occurrence checks and payload-work counters remain the oracle;
the large preparation footprint remains an explicit cost limitation.

The retained-plan retry fixture uses 300 seconds to publish 65 plans, clear their selected catalog in one version and verify units after cache loss. The off-page proposal-closure fixture uses 180 seconds for 65 questions and 65 unrelated versions, cancellation, atomic publication and reconstruction. The corrected-ownership fixture uses 180 seconds for a committed person correction, 97 retained identity receipts, exact policy comparison, in-history request progress and cancellation cleanup. Their work counts, retained evidence and exact replay assertions determine correctness; these budgets only bound a stalled host fixture.

Browser journeys that need only HTTP access can run the actual server in a separate process so synchronous storage work cannot block the browser controller's event loop. The profile journey uses 180 seconds for four imports, relationship review, encrypted reopen and a second isolated profile. The draft journey also uses 180 seconds for consecutive corrections to two document shapes, restoration after encrypted SQLite cache deletion and resumed acceptance; its cache-rebuilding unlock request shares this whole-test guard. The two-upload batch journey uses 180 seconds for Stop/reload/Resume, two reviewed acceptances and recovery of a lost acknowledgement. The grounding journey uses 120 seconds for original checks before and after a real process restart, encrypted profile reopen and final acceptance. The exact clinical-destination journey uses 120 seconds for three reviewed destinations, their saved pages and DTOs, retained original bytes, and a final encrypted reload; its five-second Saved-link assertion remains unchanged. Browser action deadlines remain unchanged.

After the first batch acceptance, the browser fixture observes the fresh pending
feed request caused by Back to Import and requires its successful completion
before checking the next card. An older record-scoped response cannot satisfy
that barrier. The existing card deadline and whole-test guard still apply.

The server suite includes the real encrypted 5,001-file/10,002-entry package qualification. It validates interrupted inventory, public upload/plan activation and reconstruction after deleting the encrypted SQLite cache; its explicit longer hang guard accommodates that complete integration. Server CI jobs allow 30 minutes including the other tests and setup. Work counts and exact recovered evidence determine correctness, not completion within a product latency target. Run this focused file when changing its authority or activation path; do not repeat it unchanged during unrelated UI iteration.

Browser assertions wait for the state they inspect: a queue count or network response can arrive before the associated view renders. Use bounded locator waits and controlled response ordering. Chromium closes when a test is cancelled, and the runtime registers writer cleanup before browser launch.

The draft-recovery upload assertion includes child-process diagnostics only on
failure. Its checkpoint selects output received since the upload began from the
existing 8,000-character buffer. A single event-loop turn allows queued output to
arrive; it is not a child-process barrier or proof that concurrent output belongs
to the failed request.

Coordinator tests should observe published journal checkpoints before asserting state or simulating the next model result. A dispatch callback can run before its `running` checkpoint is saved. Await terminal publication and assert whether it is `complete` or `paused`, rather than polling for one assumed outcome until a short wall-clock deadline expires. Keep a whole-test timeout as a hang guard, and explicitly set and restore any environment variable whose absence is part of the fixture.

Batch coordinator waits use the owning test's cancellation signal across native host preparation. The appended-selection restart fixture has a 120-second guard for its complete accepted-journal reconstruction and exact operation replay; that recovery measured about a minute on the qualification host. Proposal counts, model-job counts and the recovered selections remain the correctness checks.

The explicit partial Resume fixture uses 90 seconds for six synthetic request
windows, three retained stalls, coordinator recreation and another exact proposal;
its cumulative request accounting and no-acceptance checks stay intact. The native
fallback-reference fixture uses 120 seconds for publication of 96 unrelated
candidates and 96 historical occurrences, complete policy/token parity and
cancellation cleanup. Their complete host runs measured about 44 and 68 seconds,
respectively; these guards do not constrain model response time.

The native repair-scope fixture uses 120 seconds for repeated complete policy
preparations over 96 retained drafts, including cancellation, cross-source
invalidation and scratch cleanup. Its complete host run measured about 36 seconds;
the policy parity and refusal assertions establish correctness.

The malformed-plan-envelope fixture uses 120 seconds for 17 independent native
conversion setups followed by validation and unchanged-state checks. Its complete
host run measured about 46 seconds; every malformed request must still be rejected
before dispatch.

The superseded identity-receipt fixture uses 300 seconds for publishing 70
retained historical receipts, complete public review, fresh confirmation and exact
replay. Its complete host run measured about 235 seconds; the original 120-second
guard did not cover that sequence. Header visits, counted read bytes and exact
confirmation/replay results remain the evidence. This guard is not a response-time
target or a claim of constant history cost.

Node suites run at most two files concurrently, and browser suites run one. These fixtures perform real PDF extraction, encryption and archive rebuilds; allowing concurrency to grow with the host CPU count can starve their bounded waits. HTTP upload tests should observe the automatically queued conversion rather than start a competing conversion immediately after upload. Large report fixtures establish each report-wide identity once; they retain representative row/version counts and full acceptance/rebuild assertions.

The workflows in `.github/workflows/` run the full validation lanes on pull requests and remain useful for reproducing individual jobs or shards locally when CI failures persist. Server tests use four deterministic file shards and browser tests use three, with fail-fast disabled so one failure does not hide another lane's results. These distribute the complete suites across the existing job budgets, including large encrypted recovery and browser journeys. Each browser runner builds assets once; the unit lane owns type checking. The ordinary `build` command still includes type checking. To reproduce a server shard locally, append `-- --test-shard=1/4` through `4/4` to `npm run test:server`; for a browser shard, append `-- --test-shard=1/3` through `3/3` to `npm run test:browser:run`. Console logs retain assertions and the slow-test summary. On GitHub Actions, the reporter also publishes up to 50 bounded failure annotations containing test names and error causes, with an explicit omission notice if more failures occur. These help identify failures when full logs are unavailable; they do not change test results or budgets. Reruns are explicit validation runs, not a mechanism to turn a flaky test green.

Static-render fixtures using Vite middleware mode disable both `hmr` and `ws`. Disabling hot reload alone leaves the WebSocket server enabled in the pinned Vite version, causing concurrent fixtures to compete for its default port.

Local validation includes `npm run test:tools` for the qualification/benchmark oracles and `npm run test:continuation` for the controlled 100-page automatic-continuation regression. The latter explicitly sets `CRS_PDF_CONTROLLED_TEST=1` and requires qpdf. It verifies the first real 64-request boundary, productive continuation at later unit boundaries, exact page delivery and final coverage; a fixed total number of contexts is not the contract. These use fictional local fixtures and a scripted upstream; real-provider qualification remains a separate opt-in command described in [import performance diagnostics](docs/import/import-performance.md#representative-provider-qualification).

The [intake mutation qualification](docs/data/intake-mutation-qualification.md#accounting-boundaries) has a small actual-application regression in ordinary server CI and a dedicated 300-cycle host check enabled by `CRS_INTAKE_MUTATION_QUALIFY=1` with its documented direct Node command. Routine suite launchers clear that opt-in. A small CI pass does not replace current 100/200/300 receipts, later small-mutation evidence and reconstruction checks when claiming full growth qualification; retain partial or failed runs as partial evidence.

For work-count qualification, detach mutable counters, including nested groups, when capturing each measurement. Preserve pre-operation, post-operation and subsequent parity measurements separately outside Git. The routine fixture should prove that later mutations cannot change earlier snapshots and that reported work agrees with actual operations. A passing correctness oracle does not repair missing or aliased measurements; retain the valid evidence, identify the affected scope and requalify it from actual application state before publishing those counts.

The offline local proxy checks build the pinned LiteLLM compatibility image and run its response, native PDF translation, diagnostics and fictional OAuth tests without external network access. These test the adapter and persistence logic, not real account authentication or provider PDF acceptance. Deployment/container and real-provider qualification remain separately opt-in procedures.

The [hosted passkey checker](docs/security/hosted-passkey-checker.md) has an independent static build (`npm run build:passkey-checker`) and a manual publication workflow restricted to reviewed `main`. Its generated assets belong only on `gh-pages`; it does not build or deploy the health application. Controlled checker tests are development evidence, never physical qualification receipts.

Update documentation with contract changes. Cite current implementation and tests for security or durability claims. Keep open requirements and evidence limits intact; fixture tests do not prove real provider, device, filesystem, or model behavior.

## Working across computers

Every new ticket needs a user story grounded in the canonical [personas and jobs](docs/design/personas.md), a plain-English user walkthrough and Given–When–Then acceptance criteria. The existing backlog was backfilled in PR #54; ordinary edits preserve those stories, updating them when the user outcome or scope changes. Use the [ticket guidance and template](docs/todo/readme.md#ticket-writing-and-review) to separate persona goal/value and understandable user experience from technical requirements and ambiguity. Keep the structure proportionate; preserve useful existing contracts rather than mechanically rewriting them or inventing scope. Split at useful complexity boundaries; coherent high-effort work can proceed with independent review, and effort alone does not require owner grading.

Keep short open items in the [single CRS work list](docs/todo/readme.md); give an item its own file only when necessary context justifies it. Preserve durable requirements, owner decisions and review findings in the owning CRS item so another agent can continue without chat history. Transient execution notes may stay in chats or issues. Maintain documentation of current behavior and limitations alongside code.

Use repository-relative paths and reproducible commands when handing off changes. Keep health records, credentials, local paths, raw diagnostics and runtime state out of contributions. Follow [repository scope and handoffs](docs/architecture/workspace-and-handoffs.md) when transferring changes or interpreting another computer’s test receipts.

## Commit messages and pull requests

Start ordinary commit subjects with any Unicode emoji, followed by a space and description, for example `📚 Update docs`, `✨ Add import review`, `🐛 Fix upload retry` or `📝 Clarify provider setup`. Existing [Gitmoji shortcodes](https://gitmoji.dev/) such as `:sparkles:` are also accepted for compatibility; literal emojis are not restricted to that catalog. This default applies to human and agent commits; merge operations are exempt.

[Husky](https://typicode.github.io/husky/) runs commitlint with a single leading-emoji rule. The local hook and PR-title workflow use the same Unicode emoji rule supported by the contributor Node version, including flags, skin tones, keycaps and joined emoji. No `feat:` prefix is required. Brackets and text before the emoji are rejected; an emoji in the body cannot rescue a subject without one. Commitlint's default ignores remain enabled for generated messages such as reverts and fixups.

Installing contributor dependencies with `npm ci` from the repository root installs the local hook through `prepare`. After recreating `.git`, run:

```sh
nvm use
npm run prepare
```

Use the contributor Node version on Git's PATH, including in graphical Git clients. The hook setup is local to each clone and uses relative paths. Husky configures `core.hooksPath`; integrate any existing custom hooks before enabling it. Docker disables hook installation with `HUSKY=0`.

Exceptions are fine: use `git commit --no-verify` or `HUSKY=0 git commit ...` to skip local hooks, including when amending a merge. Branch commits are not scanned by CI.

Push changes on a feature branch and open a pull request with an emoji-prefixed title. Request independent review against requirements and current evidence without supplying a desired score or expected conclusion; resolve blocking findings and request concrete improvement feedback. Wait for the required GitHub Actions checks to pass, then squash merge the pull request. Do not push directly to `main`. Leave other worktrees, including the main demo checkout, unchanged. Use the full local lane and shard commands above when persistent CI failures need reproduction; do not weaken checks solely to make a failing change pass. Preserve the Git protections on `main`.

## Submit a change

Explain the concrete problem, resulting behavior, and verification. Include screenshots only when they are useful, newly generated from fictional data, and free of private browser or desktop content. Do not publish secrets in issue text, test output, or review artifacts.

Report suspected vulnerabilities using [SECURITY.md](SECURITY.md) instead of a public issue.
