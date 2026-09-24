# Repository guidance

These instructions apply to the whole repository.

- Start ordinary commit subjects with any Unicode emoji (or an existing Gitmoji shortcode), for example `✨ Add import review` or `🐛 Fix upload retry`. Merge operations are exempt. This is a contributor default, and `git commit --no-verify` is available when an exception is useful. See `CONTRIBUTING.md` for setup.
- After initial publication, send changes to `main` through pull requests and squash merge using an emoji-prefixed PR title. Do not push directly to `main`; see `CONTRIBUTING.md` for the hosted settings that enforce this policy.
- Treat `README.md` and `docs/README.md` as public entry points. Keep setup on the supported npm → Docker Compose → LiteLLM path.
- Put browser code in `src/app/`, server code in `src/server/`, cross-runtime contracts in `src/shared/`, deployment code in `deploy/`, and durable model instructions beside their server consumer.
- Reuse existing components, tokens, data adapters, and domain contracts before adding a parallel implementation.
- Keep health records, recovery material, credentials, local model state, logs, screenshots, and generated runtime databases outside Git. Tests and documentation must use independently fictional data.
- Treat originals and accepted record versions as durable evidence. Do not make SQLite, temporary extraction output, or model responses the recovery authority.
- Keep private operations profile scoped and session authorized. Model output must remain reviewable before an accepted write.
- The public repository supports Docker Compose with LiteLLM. Root npm commands launch and verify the Compose deployment; direct server execution remains a contributor facility.
- Use TypeScript for application and Node tooling. Keep Python confined to deploy/litellm/ for the proxy and its in-process compatibility tests. Host tooling, application code, ZIP inspection and filesystem locking use Node/TypeScript.
- Run formatting, type checking, and focused tests for touched behavior. From the repository root, use `npm run format:check`, `npm run typecheck`, and the relevant test command.
- Update maintained documentation when an API, storage, security, import, model, or deployment contract changes. Preserve open requirements in `docs/application-todo.md`.
- Do not treat an old plan or validation receipt as proof of current behavior. Verify claims against code and current tests.

Personal environment details and raw validation artifacts are excluded from this repository. Public documentation and contributor checks must be self-contained, without references to private maintainer repositories or their layout. Keep approved open requirements and release gates in the public work list; `docs/workspace-and-handoffs.md` describes included source material, exclusions and portable evidence.
