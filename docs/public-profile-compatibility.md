# Public profile compatibility

The repository contains only public fictional seed metadata. Private profile IDs, names, and ownership are supplied by the archive's registry and verified owner metadata; they are not compiled into a profile list. Existing private archives keep their exact IDs, Self notes, original paths and accepted history.

`validProfileId` validates a bounded lowercase legacy path component or a generated `p-<UUID v4>` ID. It is not an authorization check. The `p-` namespace remains reserved for generated opaque IDs. Runtime selection uses the profile registry and authenticated profile session; a syntactically valid ID does not become a listed or accessible profile. New personal profiles use opaque IDs and their explicitly supplied Self name. A fresh contributor database without a supplied name starts as `Patient`; it never receives a private person's name by default.

## Opening and discovering existing owners

`openDatabase(path, profileId)` verifies a nonempty existing database's `app_meta.owner_profile_id` through a read-only connection before opening a writable connection or running migrations. A mismatch or missing owner fails before that writable open. An omitted ID is allowed only for an existing database with verified owner metadata. Creating a database requires an explicit ID, and a call with neither path nor ID fails. Opening an unowned old archive does not assign it an arbitrary owner; explicit ownership recovery is required separately.

The plaintext compatibility registry is `data/profiles.json`, format `health-profiles-v1`, with its existing revision and profile entries. An entry may retain an optional `legacyDatabase` relative path beneath `data/`. Paths must be canonical relative `.sqlite` paths and may not traverse symbolic links. The selected database must independently name the exact registry owner.

When an older archive has no registry, compatibility discovery verifies each symmetric `data/profiles/<id>/db/database.sqlite` owner against its directory. If that rebuildable database has been removed, the current checksummed personal generation provides verified profile metadata. A directory without either form of verified metadata fails explicitly. Historic `data/database.sqlite` and flat `data/profiles/*.sqlite` files are discovered by their stored owner metadata, not their filenames. Multiple historical databases claiming one owner are ambiguous and require an explicit registry instead of an arbitrary selection.

An explicit registry remains authoritative. Legacy lookup may use its `legacyDatabase` or the generic historical defaults only when the actual stored owner matches. The public fictional placebo retains its previous own-directory boundary; no private owner name grants a broad provider directory.

## Originals and backup compatibility

Symmetric originals stay within the selected profile's `sources/` or `attachments/` tree, including after realpath checks. Historical `providers/` and `data/attachments/<id>/` files additionally require an exact reference in the verified owner's `source_files` or `assets` table and matching byte length and SHA-256. Unindexed neighboring originals, another registered profile's provider directory, altered bytes, conflicting references, and symlink redirects are rejected. Backup/restore may pass its independently verified database snapshot for these exact checks; a snapshot naming another owner is rejected.

Restore verifies the manifest checksum, database integrity and exact owner before reading legacy originals. New version-one backups retain `databasePath` when their original database had a safe path below `data/`; restore preserves it. Older version-one manifests without that field use the generic historic database location (and the fictional placebo's existing historical path), then publish an explicit registry pointing that unchanged owner ID to the restored location. Version-two backups keep the symmetric layout. Restore targets must still be new or empty, and restored registry metadata does not rewrite originals or accepted history.

The offline backup/rebuild CLI selects an existing registry owner; ID syntax alone does not authorize a command. Modern encrypted profiles continue to use their existing opaque registry/keyring identities and verified durable storage. No live archive migration or private-data inspection is needed to apply the repository change.

Fictional contributor tests cover arbitrary legacy IDs, read-only owner derivation, unowned/mismatched database rejection, original default paths, registry selection, traversal/symlinks, exact legacy source references, profile isolation, old/new backup manifests, cache loss and rebuild from verified durable generations. Current protected archives still require the existing separate operational backup and restore verification; these repository fixtures do not claim a test against private data.
