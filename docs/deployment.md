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

Stop the stack cleanly, make a consistent archive backup, update the repository, then run the same `npm run start` command. The launcher rebuilds the application image for the archive. Review release notes and configuration changes before opening an important archive. Do not run two versions against one `CRS_DATA_DIR`.

`npm run image:build` builds `circus-health:build` without opening an archive. `CRS_IMAGE=repository:tag` selects an explicit local tag when an operator needs controlled image promotion.

## Backup and recovery

The durable authority is the complete encrypted `CRS_DATA_DIR`, not SQLite. Stop the writer or use a filesystem snapshot with suitable consistency, then copy the whole directory, including the registry, keyrings, indexes, objects, originals, and record-version history. Copying individual files while the app runs is not an application backup.

Store recovery kits separately from the archive. Back up `CRS_STATE_DIR` and provider credentials separately; they contain proxy keys and authentication state, not health history. Practice restore with a fictional profile and verify unlock, an original download, history, and rebuild after cache loss.

## Filesystem and process requirements

The archive filesystem must provide advisory locks in the writer domain, atomic create and rename, hard links, and file and directory `fsync`. The launcher and container enforce one writer. Do not delete `.health-writer.lock` or `.health-writer-domain` to bypass a conflict.

The health container runs as UID 1000 with a read-only root filesystem. Unlocked SQLite, upload staging, and plaintext derivatives live in tmpfs. Locking removes the profile workspace; removing the container discards tmpfs. The LiteLLM container receives no archive mount.

## Upload and archive limits

Uploads default to 128 MiB and can be configured from 1–1024 MiB with `CRS_INTAKE_UPLOAD_MIB`. Non-PDF whole-document extraction defaults to 64 MiB and can be configured from 1–256 MiB with `CRS_INTAKE_EXTRACTION_MIB`. PDFs within the upload limit use one isolated, hash-pinned range session rather than this complete-document byte gate; PDF page count, range allocations, rendered output, worker heap and wall time remain independently bounded. Raising either configured limit can still increase work and does not promise successful parsing or complete extraction.

ZIP inspection accepts at most 10,000 total entries, 5,000 files, 2 MiB of encoded names, 100 MiB of expanded file data, and 25 MiB per file. ZIPs may be followed through three source levels. Packages are inventoried before selected members are read; nested archives require explicit inspection. These limits do not promise successful extraction for every delivery within them.

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

See [Docker runtime contracts](docker-runtime.md), [LiteLLM routing](docker-ai.md), and the [security model](security.md) for implementation details and remaining risks.
