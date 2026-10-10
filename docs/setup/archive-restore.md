# Independently restore an encrypted archive

Use the supported localhost npm → Docker Compose → LiteLLM installation. An archive backup is a complete, consistent copy of the encrypted `CRS_DATA_DIR`, plus separately retained usable recovery material. Keep the source installation and backup intact while proving a restore in a third location. This procedure does not require OCR or inference to reconstruct accepted state.

## Four different operations

| Operation       | What it recovers                                      | What it requires                                                            |
| --------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- |
| Access recovery | Unlocks retained encrypted data                       | The matching recovery kit and intact archive                                |
| Archive restore | Recovers an independently retained installation copy  | A complete encrypted-directory backup and separately retained matching kits |
| Cache rebuild   | Reconstructs SQLite and searchable history            | Intact originals, indexes and accepted versions in the same archive         |
| Portable export | Transfers selected information to another application | A separately supported export format; it is not an archive backup           |

A recovery kit contains an unlock secret, not records. SQLite and temporary extraction output are not recovery authority. The [storage layout](../data/profile-storage-and-rebuild.md) and [encrypted format](../security/vault-format.md) describe that authority. Retired plaintext backup/restore commands are unavailable. General portable export remains [open work](../todo/CRS-148.md).

## Prepare and stop the only writer

Choose three separate absolute external locations: the source `data` directory, a fresh backup `data` directory, and a fresh restored `data` directory. Each must be outside Git; the restored directory's resolved basename must be `data`. Use owner-only storage on a filesystem satisfying the [runtime requirements](deployment.md#filesystem-and-process-requirements). Keep recovery kits in a separate protected location, away from all three archive copies. Retain the kit for every profile whose data must be recoverable. Keep proxy configuration, provider credentials and `CRS_STATE_DIR` separately: provider authentication is not health history.

Before stopping, record the app/build identity, current storage format and the scope you expect to recover. For a fictional drill, include Self and a managed person, original downloads and their SHA-256 hashes, accepted records and person attribution, a note with attachment, a field/ownership correction with actor/time/source and prior versions, pending review and an explicitly stopped import. Store this private verification record outside Git. Do not infer a successful clinical import from an original's presence.

Stop the foreground `npm run start` process with Ctrl-C and wait for its Compose cleanup to finish. Ensure no other launcher or process writes this archive. If cleanup failed or the host crashed, inspect this archive's specific Compose project and stop its containers cleanly before copying. Do not bypass `.health-writer.lock` or `.health-writer-domain`, run competing writers or use global Docker pruning. Do not restart the source during the copy or restore drill.

## Copy and check the complete directory

Create a destination that does not already exist; never merge or overwrite an existing backup. With the writer stopped, copy every entry, including hidden entries and empty directories. For example, on a local POSIX filesystem, replace the placeholders and run:

```sh
umask 077
SOURCE_DATA=/absolute/source/data
BACKUP_DATA=/absolute/backup/data
mkdir "$BACKUP_DATA"
cp -pR "$SOURCE_DATA/." "$BACKUP_DATA/"
chmod -R u=rwX,go= "$BACKUP_DATA"
```

Run each step only after the previous step succeeds. The parent location must already exist and be protected; `mkdir` must fail if `BACKUP_DATA` exists. A failed copy is incomplete: preserve it for inspection and choose another fresh destination for a retry. A snapshot needs its own consistency guarantee; selected-file copies and live copies are not this procedure.

Explicitly compare inventories and SHA-256 hashes before using the backup. The following Node 24 check inventories all directories and hashes all regular files, rejects symbolic links or special files, and writes a restricted private receipt only if both copies match. Choose a fresh external receipt filename; keep it separate from both directories.

```sh
export SOURCE_DATA BACKUP_DATA
export RESTORE_RECEIPT=/absolute/private-receipts/backup-inventory.json
node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
async function inventory(root) {
  const entries = [];
  async function visit(relative) {
    const path = join(root, relative);
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      entries.push({ path: relative, type: 'directory' });
      for (const name of (await readdir(path)).sort())
        await visit(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) {
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(path)) hash.update(bytes);
      entries.push({ path: relative, type: 'file', bytes: stat.size, sha256: hash.digest('hex') });
    } else throw new Error('Unsupported archive entry; preserve copies and investigate');
  }
  await visit('');
  return entries;
}
const source = resolve(process.env.SOURCE_DATA);
const backup = resolve(process.env.BACKUP_DATA);
if (source === backup || source.startsWith(`${backup}/`) || backup.startsWith(`${source}/`))
  throw new Error('Archive locations must be separate');
const original = await inventory(source);
const copied = await inventory(backup);
if (JSON.stringify(original) !== JSON.stringify(copied))
  throw new Error('Inventory/hash mismatch; do not restore this copy');
await writeFile(process.env.RESTORE_RECEIPT, JSON.stringify({ algorithm: 'sha256', entries: copied }, null, 2),
  { flag: 'wx', mode: 0o600 });
console.log(`Matched ${copied.filter(entry => entry.type === 'file').length} encrypted files`);
NODE
```

Hash equality proves the copied bytes match the stopped source; it does not prove that the source authority is healthy or that a recovery kit works. Keep the receipt private: opaque paths, sizes and hashes can still identify an installation. Record build/format identity alongside it without storing secrets.

## Restore into an isolated installation

Copy the complete backup into a third fresh directory using the same copy and inventory check, with `SOURCE_DATA` set to the backup and `BACKUP_DATA` set to the restored directory. Never start the backup itself. Keep the original source stopped; the only running writer during verification should belong to the restored archive. The launcher derives a distinct Compose project from the distinct resolved archive path.

Use separate proxy configuration/state and a fresh browser profile or isolated browser session with no source cookies, stored keys or passkey automation. Different localhost ports share a cookie namespace and do not isolate sessions. Start from the repository root, selecting the intended release build and separate restore settings:

```sh
CRS_DATA_DIR=/absolute/restored/data \
CRS_PORT=3002 \
CRS_MODEL=health-primary \
CRS_LITELLM_CONFIG=/absolute/restore-proxy/litellm.yaml \
CRS_STATE_DIR=/absolute/restore-proxy/state npm run start
```

Open `http://localhost:3002` in the fresh browser session. The launcher builds from the current checkout; select the intended release checkout before starting and record the resulting image/build identity. `CRS_IMAGE` changes the image tag used for that build; it does not select an immutable prebuilt release. Unlock the copied profile using the independently retained recovery file or phrase. Do not reuse an unlocked source runtime or cached source secret. A kit for another profile, malformed kit or unavailable key must fail; it is not permission to create a replacement profile. Recovery-only unlock supports Skip when offered passkey enrollment.

Compare the restored scope against the pre-copy verification record:

- Download retained originals and attachments and compare exact hashes.
- Check accepted records, Self/managed-person attribution, note and attachment relationships.
- Check the correction's actor, timestamp and source, plus prior accepted versions and history.
- Check pending review remains reviewable and unaccepted; explicit Stop remains stopped.
- Lock the profile and verify private records/files are refused until authorized unlock.

Do not accept matching counts alone as proof of matching clinical state. The restored clinical state and unlock settings are those retained in this backup. Authenticated older copies can still be accepted; there is no rollback prevention. Removing a passkey or deleting a profile in the active archive does not revoke old independent backups, which may retain earlier wrapped keys and clinical history.

## Prove cache reconstruction and explicit failures

Stop the restored installation cleanly. Remove only its disposable `profiles/<opaque-id>/cache/` directories, keeping the encrypted registry, keyrings, manifests, index generations, objects and accepted versions intact. Restart the same isolated restored installation, unlock again from the separate kit, and repeat every verification above. Reconstruction must reproduce accepted state and history without OCR or inference. This proves a cache rebuild from the restored authority; it does not replace the independent copy/unlock checks.

For failure testing, use additional fresh disposable copies of the fictional backup. Remove one required referenced authority component from one copy and try an unusable or wrong-profile kit against another. Require an explicit refusal/error and identify the unavailable scope. Preserve the complete source, backup and successful restored copy; never damage them to manufacture a failure case. Do not reset an archive, discard history, bypass authentication/integrity checks or borrow another profile's key to make a failed restore appear successful. Preserve failed copies and receipts for diagnosis.

## Repeatable fictional qualification

Run the opt-in drill from the repository root with Docker and the contributor Node/browser prerequisites available. Its output location must be a fresh absolute external directory outside Git:

```sh
CRS_ARCHIVE_RESTORE_TEST=1 \
CRS_RESTORE_OUTPUT_DIR=/absolute/fresh/external/directory \
npm run qualify:archive-restore
```

The drill uses a small committed, independently fictional fixture, fresh runtime encryption keys, the supported Compose deployment, and local unavailable/scripted upstream behavior. It requires no paid provider or OCR. It checks the independent copy, retained kit, restore, cache reconstruction, private-access refusal and explicit failure cases described above. Archives, kits and raw receipts remain outside Git. A command's existence is not evidence that a particular build passed: retain its actual result and build/format identity before claiming qualification. Publish only safe counts and scoped conclusions.

The fictional oracle uses `circus-fictional-archive-restore-v2`; regenerate a fresh disposable fixture for this build instead of reusing a v1 qualification oracle. This changes qualification evidence, not personal archive formats. The fixture reads all native review sections with consistent version/token pins and accepts only its exact candidate versions through public report acceptance. Its oracle retains the explicit acceptance receipts, complete pending review, original bytes, ownership/correction history and Stop state. Cache-loss verification rereads the same public evidence and receipts; a summary is never treated as an unloaded history being empty.

A passing fictional drill covers its observed release build and local setup. It does not certify power-loss behavior, forensic erasure, every filesystem, physical passkeys, an absent device or a configured live provider. Those require separate evidence.

## Operator recovery record

As an operator-chosen workflow, record backup storage locations, separately retained kit locations, retention choices, app/build/format identity, covered profiles and the last verified independent restore with its result and scope. Choose these according to the installation's needs; this is a proposal for manual operation, not an automatic schedule or deletion policy. Update the record when actually making or verifying a copy. An untested backup, an old test receipt and a container restart are not evidence of a current successful independent restore.
