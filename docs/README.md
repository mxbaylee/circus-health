# Documentation

Start with [installation](setup/installation.md). The supported runtime is npm → Docker Compose → encrypted application plus LiteLLM Proxy. [Deployment and operations](setup/deployment.md) covers updates, shutdown, backup, recovery and troubleshooting.

## Current application references

- **Setup and operation:** [environment](setup/environment.md), [Docker runtime](setup/docker-runtime.md), [LiteLLM boundary](setup/docker-ai.md), [model providers](setup/model-providers.md), [connection behavior](setup/connection-awareness.md).
- **Security:** [security model and limitations](security/model.md), [profile encryption](security/profile-encryption.md), [vault format](security/vault-format.md), [vulnerability reporting](../SECURITY.md).
- **Import:** [import and rebuild](import/import-and-rebuild.md), [processing and evidence review](import/processing.md), [reconciliation](import/import-reconciliation.md), [performance diagnostics](import/import-performance.md).
- **Data:** [data contracts](data/data-model-contracts.md), [profile storage/rebuild](data/profile-storage-and-rebuild.md), [record versions](data/record-version-storage.md), [change history](data/change-history.md), [storage accounting](data/storage-accounting.md), [clinical relationships](data/clinical-relationships.md), [public-profile compatibility](data/public-profile-compatibility.md).
- **Features:** [assistant and intake](features/assistant-and-intake.md), [profile management](features/profile-management.md), [People](features/people-tags.md), [filters](features/filter-inventory.md), [measurement comparison](features/measurement-comparison.md), [Notes](../src/app/features/notes/README.md), [visual design](design/app-design.md).
- **Contributors:** [contributing](../CONTRIBUTING.md), [code organization](architecture/code-organization.md), [formatting](architecture/code-formatting.md), [repository scope and handoffs](architecture/workspace-and-handoffs.md), [source checks](../src/README.md).

Source-adjacent references describe the [API](../src/server/API.md), [intake API](../src/server/INTAKE.md), [record publication](../src/server/RECORD-VERSIONS.md), [portable data](../src/server/PORTABLE.md) and [note exports](../src/server/NOTE-EXPORTS.md).

## Work tracking

[TODOs](todo/readme.md) hold numbered open work. Most items live directly in the index; a separate CRS file holds an item's specification, proposal, owner decisions, open questions and review findings when it needs more room. The [import specification](todo/CRS-126.md) states required upload behavior and the owner's import decisions. Documentation outside `todo/` describes implemented behavior and current limitations.

## Experiment material

Existing [experiment material](experiments/README.md) is grouped separately pending a retention discussion. It includes historical results and research plans, not current application guarantees. This reorganization does not change experiment outcomes or authorize additional runs.

Health records, credentials, recovery material, private screenshots, raw logs and runtime databases stay outside Git. Public examples and fixtures are independently fictional.
