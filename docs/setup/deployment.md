# Deploy and operate Circus Health

The supported deployment is npm → Docker Compose → encrypted application plus LiteLLM Proxy. The default published address is loopback only. This guide assumes [installation](installation.md) is complete.

## Start, stop, and restart

Run from the repository root:

```sh
CRS_DATA_DIR=/absolute/path/to/archive/data CRS_MODEL=health-primary CRS_LITELLM_CONFIG=/absolute/path/to/proxy/config/litellm.yaml CRS_STATE_DIR=/absolute/path/to/proxy/state npm run start
```

Stop the foreground stack with Ctrl-C and wait for Compose cleanup to finish. Starting the same command again recreates containers while retaining the external archive and state. A forced host or Docker shutdown can leave the archive's Compose project running; inspect that specific project before restarting. Do not use global Docker pruning as recovery.

Each archive gets a path-derived Compose project and default image tag. Different user and test installations need different data, configuration, state, and browser profiles. Different localhost ports still share the same cookie namespace.

## Update

Follow the [release update and failed-candidate recovery procedure](release-updates.md). Record current/candidate build identities and review the maintained configuration/format notes, stop the sole writer, verify a complete independent backup and separately retained kits, then start the candidate with the same explicit archive/proxy settings. Verify exact originals, accepted history, corrections, pending review and Stop before treating the candidate as usable. Do not run two versions against one `CRS_DATA_DIR`.

If startup or unlock refuses unsupported authority, preserve the candidate archive/evidence and recover the prior app only against a fresh isolated copy of the untouched verified backup. This returns the backup's state; post-backup writes, general downgrade compatibility and rollback prevention are not promised.

`npm run image:build` builds `circus-health:build` without opening an archive. The launcher builds the invoking checkout; `CRS_IMAGE=repository:tag` selects the local build tag, not an immutable prebuilt release.

## Backup and recovery

The durable authority is the complete encrypted `CRS_DATA_DIR`, not SQLite. The supported backup is a consistent copy of that whole directory. The npm `backup` and `restore` aliases are removed. Direct invocation of `src/server/recovery-cli.ts` refuses all operations with guidance before opening an archive or touching a destination; its retired plaintext portable commands are not a vault backup, restore or Takeout export.

Follow the self-contained [independent encrypted-archive restore runbook](archive-restore.md) to stop the sole writer, copy the whole directory into fresh owner-only external storage, compare inventory/hashes, retain recovery kits separately, and restore into a distinct path and isolated Compose/browser session. It includes verification of originals, person attribution, accepted history, pending review and explicit Stop, cache-loss reconstruction, and explicit failure handling. Preserve source and backup copies; never overlay an existing archive or bypass a writer/integrity refusal.

A recovery kit restores access to retained data; it contains no copy of the records. Provider credentials and `CRS_STATE_DIR` are separate from health history. A cache rebuild reconstructs SQLite from the same authority and does not prove an independent backup is complete. Use the runbook's fictional qualification command and retain actual build-scoped results before claiming a successful restore.
Backups retain the clinical and key state at the time of the copy. Removing a passkey or deleting a profile from the active archive does not revoke independently retained copies. Portable export for other applications remains separate work in [CRS-148](../todo/CRS-148.md). `npm run help` points to this procedure without opening an archive or invoking Docker.

## Filesystem and process requirements

The archive filesystem must provide advisory locks in the writer domain, atomic create and rename, hard links, and file and directory `fsync`. The launcher and container enforce one writer. Do not delete `.health-writer.lock` or `.health-writer-domain` to bypass a conflict.

The health container runs as UID 1000 with a read-only root filesystem. Unlocked SQLite, upload staging, and plaintext derivatives live in tmpfs. Locking removes the profile workspace; removing the container discards tmpfs. The LiteLLM container receives no archive mount.

## Upload and archive limits

Uploads default to 128 MiB and can be configured from 1–1024 MiB with `CRS_INTAKE_UPLOAD_MIB`. Non-PDF whole-document extraction defaults to 64 MiB and can be configured from 1–256 MiB with `CRS_INTAKE_EXTRACTION_MIB`. PDFs within the upload limit use one isolated, hash-pinned range session rather than this complete-document byte gate; PDF page count, range allocations, rendered output, worker heap and wall time remain independently bounded. Raising either configured limit can still increase work and does not promise successful parsing or complete extraction.

The [native ZIP path](../data/streamed-package-originals.md) uses paged inventories and streamed member publication without file-count, aggregate-name, per-member-byte or aggregate-expanded-byte product limits. Packages are validated before selected members are read; nested archives require separate explicit inspection and checked ancestry. Storage availability, supported compression, integrity checks and downstream parser/output limits still apply. Bounded buffers do not establish sufficient disk capacity or successful clinical extraction.

Interrupted file uploads restart from the beginning. Extraction work resumes after a complete original has been retained.

## HTTPS and access from another device

The launcher always publishes the app on host loopback. `CRS_PUBLIC_ORIGIN=https://health.example.test` configures the exact allowed browser origin; it does not expose the loopback port, provision DNS, provide TLS, authenticate remote users, or configure a reverse proxy.

Remote or phone access therefore requires an operator-managed HTTPS reverse proxy or tunnel to loopback plus a separate review of access control, headers, cookies, WebAuthn relying-party behavior, firewall rules, and the security of every connected device. No offline web app or installable phone-app behavior is claimed.

## Troubleshooting

- **Archive path rejected:** use an existing absolute directory outside Git whose resolved basename is `data`; keep config, credentials, and state separate.
- **Writer already active:** stop the existing instance for that archive and allow its cleanup to finish. Inspect its specific Compose project after a crash.
- **Proxy healthy but requests fail:** health only proves that the proxy process is reachable. Check the selected alias, upstream credentials or OAuth, account quota, and exact model identity with fictional content.
- **ChatGPT device prompt missing:** stop the stack, run `npm run login:chatgpt` with the same `CRS_STATE_DIR`, complete the terminal flow, and restart.
- **Ollama unreachable:** confirm the model is installed, cloud features are disabled, and the proxy container can reach the configured restricted host endpoint.
- **Image not inspected:** verify that the route really accepts images and that `model_info.supports_vision` matches it. Preserve the coverage gap when it does not.
- **Passkey fails:** use `localhost` consistently. Recover with the saved recovery kit; real browser/password-manager PRF behavior is still an acceptance gate.
- **Import retained but not extracted:** compare the effective upload/extraction/ZIP bounds and model image support. Retention does not imply complete extraction.

See [Docker runtime contracts](docker-runtime.md), [LiteLLM routing](docker-ai.md), and the [security model](../security/model.md) for implementation details and remaining risks.
