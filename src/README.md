# Circus Health application

The application is a React client and Node server for a local, profile-scoped health archive. SQLite supplies query views; durable profile files retain originals, reviewed curation, and app-owned personal state.

## Development

The supported application is the repository's Docker Compose stack:

```sh
CRS_DATA_DIR=/absolute/path/to/archive/data CRS_MODEL=health-primary CRS_LITELLM_CONFIG=/absolute/path/to/proxy/config/litellm.yaml CRS_STATE_DIR=/absolute/path/to/proxy/state npm run start
```

Run commands from the repository root, which owns `package.json`, the lockfile and tool configuration. The host needs Node 24.19 or newer, npm, and Docker Compose v2.30 or newer. Run `npm ci` once before using the npm commands. Python is confined to the LiteLLM proxy container. Native server/browser contributor checks also need qpdf on `PATH`; see [Contributing](../CONTRIBUTING.md). The application image includes qpdf.

Common contributor checks are `npm run typecheck`, `npm run test:server`, `npm run test:ui`, `npm run test:state`, and `npm run build`. `npm run image:build` builds the application Docker image without opening an archive.

## Main behavior

- Home is the selected patient’s Self profile, using their saved display name.
- Test Results exposes history, result detail, source evidence, and complete-series charts.
- Prescriptions separates provider records from personal current-use selections.
- Procedures use reviewed categories and retain supporting evidence.
- Notes contains editable notes and historical drafts/finished entries. People is a separate first-class destination.
- Sources preserves indexed source records, documents, provenance, and retained originals.
- Import supports upload, assistant conversion, report/record/People review, exact evidence and explicit acceptance without routing through Sources.
- Profiles are independent local archives. Empty and generated-fictional profile creation are supported; private copies remain private.
- The optional assistant uses current page context and explicit reviewable operations.

## Layout

- `app/`: routes, pages, UI components, feature state, and API helpers.
- `server/`: HTTP API, SQLite schema, profile lifecycle, import, assistant bridge, portable export, recovery, and runtime.
- `shared/`: shared TypeScript contracts.
- `tests/`: mounted browser behavior and state tests.

## Data rules

Every private data route is scoped to an unlocked `/api/profiles/:profileId`. The server checks session authorization, database ownership and source containment. Original source content is immutable. Clinical projections link to source records and evidence; personal edits publish as retained record versions. Startup reads public cards; selected-profile unlock validates a cache or reconstructs disposable SQLite from encrypted durable inputs. `/api/runtime` identifies the active encrypted runtime.

Runtime profile data is not application source code. Keep sources, generated databases, backups, portable generations, mappings containing private decisions, and assistant journals outside commits intended for sharing.

See [API](server/API.md), [intake](server/INTAKE.md), [portable state](server/PORTABLE.md), [note exports](server/NOTE-EXPORTS.md), and [repository architecture](../docs/architecture/code-organization.md).
