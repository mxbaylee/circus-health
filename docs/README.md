# Documentation

Start with [installation](setup/installation.md). The supported runtime is npm → Docker Compose → encrypted application plus LiteLLM Proxy. [Deployment and operations](setup/deployment.md) covers updates, shutdown, backup, recovery and troubleshooting.

## Current application references

- **Setup and operation:** [independent archive restore](setup/archive-restore.md), [environment](setup/environment.md), [Docker runtime](setup/docker-runtime.md), [LiteLLM boundary](setup/docker-ai.md), [model providers](setup/model-providers.md), [connection behavior](setup/connection-awareness.md).
- **Security:** [security model and limitations](security/model.md), [profile encryption](security/profile-encryption.md), [vault format](security/vault-format.md), [vulnerability reporting](../SECURITY.md).
- **Import:** [import and rebuild](import/import-and-rebuild.md), [processing and evidence review](import/processing.md), [automatic recovery](import/automatic-recovery.md), [report identity](import/identity-review.md), [reconciliation](import/import-reconciliation.md), [reliable review and partial saves](import/review-reliability.md), [performance diagnostics](import/import-performance.md).
- **Data:** [data contracts](data/data-model-contracts.md), [profile storage/rebuild](data/profile-storage-and-rebuild.md), [record versions](data/record-version-storage.md), [intake envelope authority](data/intake-envelope-authority.md), [contributor record authority](data/contributor-record-authority.md), [change history](data/change-history.md), [storage accounting](data/storage-accounting.md), [exact text edits](data/text-piece-edits.md), [automatic exact-text reconciliation](data/text-piece-reconciliation.md), [disposable source-text storage](data/source-text-projection.md), [exact source search](data/source-details-search.md), [clinical relationships](data/clinical-relationships.md), [public-profile compatibility](data/public-profile-compatibility.md).
- **Features:** [assistant and intake](features/assistant-and-intake.md), [profile management](features/profile-management.md), [People](features/people-tags.md), [filters](features/filter-inventory.md), [measurement comparison](features/measurement-comparison.md), [Notes](../src/app/features/notes/README.md), [visual design](design/app-design.md), [personas and jobs with current limits](design/personas.md).
- **Contributors:** [contributing](../CONTRIBUTING.md), [code organization](architecture/code-organization.md), [formatting](architecture/code-formatting.md), [repository scope and handoffs](architecture/workspace-and-handoffs.md), [source checks](../src/README.md).

Source-adjacent references describe the [API](../src/server/API.md), [intake API](../src/server/INTAKE.md), [record publication](../src/server/RECORD-VERSIONS.md), [portable data](../src/server/PORTABLE.md) and [note exports](../src/server/NOTE-EXPORTS.md).

## Work tracking

[TODOs](todo/readme.md) hold numbered open work. Most items live directly in the index; a separate CRS file holds an item's specification, proposal, owner decisions, open questions and review findings when it needs more room. The [import specification](todo/CRS-126.md) states required upload behavior and the owner's import decisions. Documentation outside `todo/` describes implemented behavior and current limitations.

## Experiment material

Existing [experiment material](experiments/README.md) is grouped separately pending a retention discussion. It includes historical results and research plans, not current application guarantees. This reorganization does not change experiment outcomes or authorize additional runs.

Health records, credentials, recovery material, private screenshots, raw logs and runtime databases stay outside Git. Public examples and fixtures are independently fictional.
