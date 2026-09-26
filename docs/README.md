# Documentation

Start with [installation](installation.md) for a new Circus Health archive. Use [deployment and operations](deployment.md) for updates, shutdown, backup, recovery, remote-access constraints, and troubleshooting. The supported product runtime is npm → Docker Compose → encrypted application plus LiteLLM Proxy.

## Maintained references

These documents describe current contracts. Update the relevant reference when behavior changes, and verify claims against code and current tests.

- **Contributing and architecture:** [contributing](../CONTRIBUTING.md), [code organization](code-organization.md), [source checks](../src/README.md), [formatting](code-formatting.md), and the [API reference](../src/server/API.md).
- **Security:** [security model and risk register](security.md), [encrypted profiles](profile-encryption.md), [vault format](vault-format.md), and [vulnerability reporting](../SECURITY.md).
- **Runtime and models:** [deployment](deployment.md), [Docker runtime](docker-runtime.md), [connection behavior](connection-awareness.md), [LiteLLM boundary](docker-ai.md), and [provider gates](model-providers.md).
- **Data and durability:** [data contracts](data-model-contracts.md), [profile storage and rebuild](profile-storage-and-rebuild.md), [record versions](record-version-storage.md), [change review and restoration](change-history.md), and [storage accounting](storage-accounting.md), and [measurement comparison](measurement-comparison.md).
- **Import and assistant:** [assistant and intake](assistant-and-intake.md), [import and rebuild](import-and-rebuild.md), [reconciliation and limits](import-reconciliation.md), [performance diagnostics](import-performance.md), and the [intake API](../src/server/INTAKE.md).
- **Profiles and interface:** [profile management](profile-management.md), [People](people-tags.md), [Notes](../src/app/features/notes/README.md), [search and filters](filter-inventory.md), and [visual design](design/app-design.md).

Source-adjacent references cover [record publication](../src/server/RECORD-VERSIONS.md), [portable data](../src/server/PORTABLE.md), and [note exports](../src/server/NOTE-EXPORTS.md). They describe lower-level contracts used by the encrypted runtime and recovery or test helpers; they are not alternate setup guides.

## Work and evidence

[Repository scope and handoffs](workspace-and-handoffs.md) defines included source and documentation, excluded private artifacts, and portable validation evidence.

The [application work list](application-todo.md) is the single source for approved open requirements, release checks and deferred ideas, with stable `CRS-###` identifiers. Keep status there; other documents provide design and evidence links. A checked implementation item or old passing test does not prove real-provider compatibility, physical passkeys, a target filesystem, model quality, or other explicitly open acceptance work.

[Processing context and unattended continuation](processing-context-proposal.md) records the large-document proposal, corrections to earlier assumptions, offline scaling evidence and criteria for independent review before choosing an implementation. It does not establish live extraction quality or an adaptive-processing speedup. [Processing experiments](processing-experiments.md) holds the briefs and append-only results for the experiments that proposal requires before a design is chosen. The [import specification](import-scenarios.md) states, independently of this implementation, how uploads must behave from the person's side and the record-integrity principles every design must keep. Its gaps against the current tree are listed in the processing proposal.

[Follow-up import experiments](processing-follow-up-experiments.md) records a unit-size sweep,
live quality comparisons, and targeted OCR and fingerprinting follow-ups from those results.
Its append-only results preserve the original designs, measured failures and independent
verification. The [extrapolation register](processing-extrapolated-results.md) distinguishes
executed tests, conditional estimates and unsupported forecasts. These experiments do not
establish production behavior or close provider acceptance gates.

[Private home deployment options](home-cloud-deployment.md) records the proposed local/cloud arrangements, access controls, implementation prerequisites and dated DigitalOcean cost estimates. It is planning reference, not an additional supported installation path.

Personal coordination journals, raw validation receipts, generated repository inventories and private reference artwork are excluded from the public repository. Maintained documentation contains the contracts contributors need; ordinary work must not depend on private notes.

Personal records, credentials, recovery material, local logs, runtime databases, and screenshots containing private desktop or browser content belong outside Git. Public examples and fixtures must be independently fictional.
