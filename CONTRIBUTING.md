# Contributing to Circus Health

Thank you for helping improve Circus Health. This repository handles sensitive subject matter, so examples, fixtures, screenshots, and test archives must be independently fictional. Never commit personal records, credentials, OAuth state, recovery kits, runtime databases, or local logs.

## Before you start

Install Node.js 24.19 or newer for contributor checks. Root npm commands launch the product through Docker Compose and LiteLLM. Read the [code organization reference](docs/architecture/code-organization.md), [security model](docs/security/model.md), and the maintained contract related to your change.

Native server and browser checks also require `qpdf` on `PATH` for scoped original PDF extraction: install it with `brew install qpdf` on macOS or `sudo apt-get install qpdf` on Debian/Ubuntu. These checks must exercise native PDF extraction rather than skip it when the executable is missing. The application image includes qpdf, and the Linux test job installs it before the server/browser suites.

Run `npm run icons` from the repository root after changing the canonical logo or brand palette. It generates the React, SVG, ICO, PNG, and manifest outputs in the pinned Node 24 Docker `brand-tools` stage, so rendering uses the pinned container toolchain; the launcher itself uses host Node. Contributors already using Node 24.19 or newer can run `npm run brand:generate` or `npm run brand:check` from the repository root directly.

Brand rasterization uses a pinned WebAssembly renderer and PNG encoder, giving the same bytes on supported macOS/Linux ARM64 and Linux x64 environments. Commit regenerated assets with their source changes. Builds and the focused macOS/Linux CI job check the committed bytes strictly; they do not regenerate or tolerate visual differences.

Keep changes focused. Preserve original evidence, append-only accepted history, profile isolation, explicit review before model-proposed writes, and the supported Docker/LiteLLM deployment boundary. Reuse shared components and types rather than creating feature-local copies.

## Source layout

- `src/app/` contains React UI, features, and browser data adapters.
- `src/server/` contains HTTP APIs, encrypted profile lifecycle, imports, model tools, and durable publication.
- `src/shared/` contains contracts safe for both browser and server use, including `schemas/health-record-v1.schema.json`.
- `deploy/`, `compose.yaml`, `Dockerfile`, and root npm scripts define the supported runtime.
- `docs/` contains maintained product, operations, architecture, data, and security references.

The complete placement rules and known duplication are in [docs/architecture/code-organization.md](docs/architecture/code-organization.md).

## Develop and verify

Install dependencies and run checks from the repository root:

```sh
npm ci
npm run format:check
npm run typecheck
npm test
```

Use the narrowest meaningful test while iterating, then run the relevant complete suite before submitting. Browser tests build the app and may require additional local dependencies; see [src/README.md](src/README.md). Deployment changes also need `npm run test:deploy`; proxy Python tests run only inside the pinned LiteLLM container as shown in CI.

`npm run test:browser` runs one browser test file at a time, bounding concurrent Chromium instances and encrypted runtimes in local checks and CI. Finish builds before starting journeys in the same checkout: rebuilding replaces the assets those pages are using. Browser assertions should wait for the state they inspect: a queue count or network response can arrive before the associated view renders. Use bounded locator waits and controlled response ordering to cover these races; whole-test retries must not hide assertion failures.

`npm test` and CI include `npm run test:tools` for the qualification/benchmark oracles and `npm run test:continuation` for the controlled 100-page automatic-continuation regression. The latter explicitly sets `CRS_PDF_CONTROLLED_TEST=1` and requires qpdf. These use fictional local fixtures and a scripted upstream; real-provider qualification remains a separate opt-in command described in [import performance diagnostics](docs/import/import-performance.md#representative-provider-qualification).

CI also builds the pinned LiteLLM compatibility image and runs its response, native PDF translation, diagnostics and fictional OAuth tests without external network access. These test the adapter and persistence logic, not real account authentication or provider PDF acceptance. The application Docker workflow and real-provider checks remain separately enabled integration gates.

Update documentation with contract changes. Cite current implementation and tests for security or durability claims. Keep open requirements and evidence limits intact; fixture tests do not prove real provider, device, filesystem, or model behavior.

## Working across computers

Keep short open items in the [single CRS work list](docs/todo/readme.md); give an item its own file only when necessary context justifies it. Maintain documentation of current behavior and limitations alongside code. Keep implementation plans and feedback in chats or issues, not repository specifications. Use repository-relative paths and reproducible commands when handing off changes. Keep health records, credentials, local paths, raw diagnostics and runtime state out of contributions. Follow [repository scope and handoffs](docs/architecture/workspace-and-handoffs.md) when transferring changes or interpreting another computer’s test receipts.

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

Submit changes to `main` through a pull request, then squash merge. The PR title supplies the squash commit title and must begin with an unbracketed Unicode emoji or existing Gitmoji shortcode followed by a space and description: `✨ Add import review` or `:sparkles: Add import review`. Bracketed prefixes are rejected. GitHub runs the **PR title** check when a PR opens, its title or commits change, or it reopens. Contributors using the GitHub editor or another language do not need Node locally to satisfy this check.

The title workflow uses Unicode emoji matching and installs a pinned Gitmoji catalog only for shortcode compatibility in an isolated runner directory. Parity tests exercise the actual workflow script and local validator against the same accepted and rejected titles. It checks out no repository code, runs no package install scripts, never evaluates title text as code, and requests no token permissions or secrets. Merge-message and revert ignores apply only to local commitlint, not the proposed PR title.

### Repository administrator setup

These are required hosted settings, not settings that a clone or workflow can enable automatically. After the initial repository contents and this workflow are published, run a sample PR to make **PR title** available as a required check, then configure GitHub:

1. Under **Settings → General → Pull Requests**, enable squash merging and disable merge commits and rebase merging. Set the default squash commit title to **Pull request title**. Its body may remain blank.
2. Add or update an active branch ruleset targeting exactly `refs/heads/main`. Require a pull request, allow only squash merges, require the **PR title** status check from GitHub Actions, block force pushes and branch deletion, and require linear history. Keep the bypass list empty so administrators also use PRs. Zero required approvals permits the solo maintainer to merge their own PR; preserve any existing stricter review or check requirements.
3. Preserve existing rulesets and required checks when adding this policy. Verify that a direct push to `main` is rejected and that a PR with a plain title cannot merge. An emoji title should pass; confirm the proposed squash title before merging, because GitHub's default title remains editable.

For the [repository settings API](https://docs.github.com/en/rest/repos/repos#update-a-repository), the corresponding fields are `allow_squash_merge: true`, `allow_merge_commit: false`, `allow_rebase_merge: false`, `squash_merge_commit_title: "PR_TITLE"`, and `squash_merge_commit_message: "BLANK"`. Branch rulesets require repository Administration permission; see [GitHub's ruleset API](https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset). Do not enable the required check before the initial workflow exists on `main`: an empty repository needs its initial publication before this policy can run.

## Submit a change

Explain the concrete problem, resulting behavior, and verification. Include screenshots only when they are useful, newly generated from fictional data, and free of private browser or desktop content. Do not publish secrets in issue text, test output, or review artifacts.

Report suspected vulnerabilities using [SECURITY.md](SECURITY.md) instead of a public issue.
