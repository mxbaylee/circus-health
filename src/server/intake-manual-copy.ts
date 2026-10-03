import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { ManualSourceRecordReceipt } from '../shared/intake-manual-source-record.ts';
import {
  currentTransactionToken,
  hasTransactionDurability,
  rejectCurrentTransaction,
  type Database,
} from './database.ts';
import { flushRecordDurability, recordDurabilityStatus } from './record-versions.ts';
import { storedIntakeDetails } from './intake-state-access.ts';
import { canonicalLiteral, validateJSONL } from './intake-format.ts';
import { profileOriginal } from './profile-storage.ts';
import { validProfileId } from './profiles.ts';
import { hashFile } from './vault-store.ts';
import { validatePortableIntakeSourceText } from './intake-source-text.ts';
import type { IntakeCopyPublicationReader } from './intake-state-bootstrap.ts';

const PREFIX = 'intake_manual_copy:v1:';
const FORMAT = 'health-intake-manual-copy-v1';
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalLiteral(value)).digest('hex');
function fail(message: string): never {
  throw Error('Manual source copy proof: ' + message);
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
interface Boundary {
  profileId: string;
  intakeId: string;
  sourceHash: string;
  proposalId: string;
  proposalHash: string;
}
interface CopyProof extends Boundary {
  format: typeof FORMAT;
  copyId: string;
  sourceProfileId: string;
  sourceHeadHash: string;
  authorProfileId: string;
  receiptHash: string;
  sourceTextRevisionId: string;
}
const proofKey = (scope: Boundary) =>
  PREFIX + digest([scope.profileId, scope.intakeId, scope.proposalId]);
const metadata = (db: Database, key: string) =>
  db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value;
function parseProof(value: unknown): CopyProof {
  let proof: unknown;
  try {
    proof = typeof value === 'string' ? JSON.parse(value) : null;
  } catch {
    fail('corrupt retained proof');
  }
  if (
    !object(proof) ||
    Object.keys(proof).sort().join(',') !==
      'authorProfileId,copyId,format,intakeId,profileId,proposalHash,proposalId,receiptHash,sourceHash,sourceHeadHash,sourceProfileId,sourceTextRevisionId' ||
    proof.format !== FORMAT ||
    !validProfileId(proof.profileId) ||
    !validProfileId(proof.sourceProfileId) ||
    !validProfileId(proof.authorProfileId) ||
    proof.profileId === proof.sourceProfileId ||
    typeof proof.copyId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(proof.copyId) ||
    !['intakeId', 'proposalId', 'sourceTextRevisionId'].every(
      (key) => typeof proof[key] === 'string' && proof[key].length > 0,
    ) ||
    !['sourceHash', 'proposalHash', 'receiptHash', 'sourceHeadHash'].every(
      (key) => typeof proof[key] === 'string' && /^[0-9a-f]{64}$/.test(proof[key]),
    )
  )
    fail('unsupported retained proof');
  return proof as unknown as CopyProof;
}
function receiptMatches(receipt: ManualSourceRecordReceipt, scope: Boundary): boolean {
  return (
    object(receipt) &&
    receipt.actor === 'profile-owner' &&
    validProfileId(receipt.profileId) &&
    typeof receipt.operationId === 'string' &&
    /^[a-zA-Z0-9_-]{8,128}$/.test(receipt.operationId) &&
    typeof receipt.fingerprint === 'string' &&
    /^[0-9a-f]{64}$/.test(receipt.fingerprint) &&
    receipt.intakeId === scope.intakeId &&
    receipt.sourceHash === scope.sourceHash &&
    typeof receipt.sourceTextRevisionId === 'string' &&
    /^[0-9a-f-]{36}$/.test(receipt.sourceTextRevisionId) &&
    object(receipt.person) &&
    typeof receipt.person.noteId === 'string' &&
    typeof receipt.person.personId === 'string'
  );
}
/** The caller supplies the physically verified proposal's identity. This never
 * changes the original author's receipt or grants authority from JSONL fields. */
export function copiedManualSourceRecordApplies(
  db: Database,
  scope: Boundary,
  receipt: ManualSourceRecordReceipt,
): boolean {
  if (metadata(db, 'owner_profile_id') !== scope.profileId) return false;
  const raw = metadata(db, proofKey(scope));
  if (raw === undefined) return false;
  const proof = parseProof(raw);
  if (
    !receiptMatches(receipt, scope) ||
    !Object.entries(scope).every(([key, value]) => proof[key as keyof Boundary] === value) ||
    proof.authorProfileId !== receipt.profileId ||
    proof.receiptHash !== digest(receipt) ||
    proof.sourceTextRevisionId !== receipt.sourceTextRevisionId
  )
    fail('retained proof does not match target receipt/source/proposal');
  return true;
}
export interface ManualSourceCopyPlan {
  readonly sourceProfileId: string;
  readonly targetProfileId: string;
}
interface PlanData {
  source: Database;
  head: string;
  sourceRows: Array<{ key: string; value: string }>;
  proofs: CopyProof[];
}
const plans = new WeakMap<ManualSourceCopyPlan, PlanData>();
function sourceHead(db: Database, profileId: string): string {
  if (
    !db.isOpen ||
    db.isTransaction ||
    currentTransactionToken(db) ||
    metadata(db, 'owner_profile_id') !== profileId
  )
    fail('source is not idle and owned');
  const status = recordDurabilityStatus(db);
  if (!status?.configured || status.dirty || status.conflicted)
    fail('source accepted authority is not current');
  flushRecordDurability(db);
  const head = db
    .prepare('SELECT head_json FROM __record_state WHERE singleton=1')
    .get()?.head_json;
  if (typeof head !== 'string') fail('source selected head missing');
  return head;
}
function sourceTextInventory(db: Database, profileId: string): Set<string> {
  const rows = db
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_source_text:*'")
    .all();
  validatePortableIntakeSourceText(
    {
      app_meta: rows,
      source_files: db.prepare("SELECT * FROM source_files WHERE kind='intake_original'").all(),
    },
    profileId,
  );
  return new Set(rows.map((row) => String(row.key)));
}
/** Preparation runs under the existing authorized source copy lease, before
 * owner/path changes. An opaque plan is required; supplied proof objects cannot
 * mint a target grant. Existing grants are checked against the current source. */
export function prepareManualSourceCopy(
  db: Database,
  root: string,
  sourceProfileId: string,
  targetProfileId: string,
): ManualSourceCopyPlan {
  if (!validProfileId(targetProfileId) || targetProfileId === sourceProfileId)
    fail('target profile identity');
  const head = sourceHead(db, sourceProfileId);
  const sourceRows = db
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_manual_copy:*' ORDER BY key")
    .all() as Array<{ key: string; value: string }>;
  const unused = new Set(
    sourceRows.map((row) => {
      const proof = parseProof(row.value);
      if (proof.profileId !== sourceProfileId || row.key !== proofKey(proof))
        fail('source proof namespace or owner');
      return row.key;
    }),
  );
  const proofs: CopyProof[] = [],
    copyId = randomUUID();
  let revisions: Set<string> | undefined;
  for (const original of db
    .prepare("SELECT * FROM source_files WHERE kind='intake_original' ORDER BY id")
    .all()) {
    const details = storedIntakeDetails(db, { id: String(original.id), kind: 'intake_original' })!;
    let verifiedOriginal = false;
    for (const proposal of details.proposals) {
      const receipt = proposal.manualSourceRecord;
      if (!receipt) continue;
      const file = db.prepare('SELECT * FROM source_files WHERE id=?').get(proposal.id);
      if (!file || file.kind !== 'intake_proposal') fail('manual proposal evidence missing');
      const scope: Boundary = {
        profileId: sourceProfileId,
        intakeId: String(original.id),
        sourceHash: String(original.sha256),
        proposalId: proposal.id,
        proposalHash: String(file.sha256),
      };
      if (!receiptMatches(receipt, scope)) fail('manual receipt original binding');
      if (
        receipt.profileId !== sourceProfileId &&
        !copiedManualSourceRecordApplies(db, scope, receipt)
      )
        continue;
      unused.delete(proofKey(scope));
      const proposalDetails: unknown = JSON.parse(String(file.details_json));
      if (
        !object(proposalDetails) ||
        proposalDetails.originalSourceFileId !== original.id ||
        digest(proposalDetails.manualSourceRecord) !== digest(receipt) ||
        proposal.sourceTextRevisionId !== receipt.sourceTextRevisionId ||
        proposalDetails.sourceTextRevisionId !== receipt.sourceTextRevisionId
      )
        fail('manual proposal receipt or source-text binding');
      revisions ??= sourceTextInventory(db, sourceProfileId);
      if (
        !revisions.has(
          `intake_source_text:v1:${original.id}:revision:${receipt.sourceTextRevisionId}`,
        )
      )
        fail('manual source-text revision missing');
      if (!verifiedOriginal) {
        const path = profileOriginal(root, original.path, sourceProfileId);
        if (statSync(path).size !== original.bytes || hashFile(path) !== original.sha256)
          fail('original evidence changed');
        verifiedOriginal = true;
      }
      const path = profileOriginal(root, file.path, sourceProfileId),
        bytes = readFileSync(path);
      if (
        bytes.length !== file.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== scope.proposalHash
      )
        fail('proposal evidence changed');
      const parsed = validateJSONL(bytes);
      if (
        !parsed.valid ||
        parsed.entries.length !== 1 ||
        parsed.entries[0].value.id !== `manual:${receipt.operationId}`
      )
        fail('manual proposal entry binding');
      proofs.push({
        ...scope,
        profileId: targetProfileId,
        format: FORMAT,
        copyId,
        sourceProfileId,
        sourceHeadHash: digest(head),
        authorProfileId: receipt.profileId,
        receiptHash: digest(receipt),
        sourceTextRevisionId: receipt.sourceTextRevisionId,
      });
    }
  }
  if (unused.size) fail('orphan or conflicting source proof');
  if (sourceHead(db, sourceProfileId) !== head) fail('source changed during copy preparation');
  const plan = Object.freeze({ sourceProfileId, targetProfileId });
  plans.set(plan, { source: db, head, sourceRows, proofs });
  return plan;
}
/** Install only within the existing unpublished copy transaction, after source
 * text and intake bootstrap rebinding and before the first genuine publication. */
export function stageManualSourceCopy(
  db: Database,
  plan: ManualSourceCopyPlan,
  publication: IntakeCopyPublicationReader,
): void {
  try {
    const data = plans.get(plan);
    if (!data || data.source === db || !db.isTransaction || !currentTransactionToken(db))
      fail('opaque copy plan/application transaction required');
    if (sourceHead(data.source, plan.sourceProfileId) !== data.head)
      fail('source selected head changed before staging');
    if (
      metadata(db, 'owner_profile_id') !== plan.targetProfileId ||
      hasTransactionDurability(db) ||
      recordDurabilityStatus(db) ||
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name GLOB '__record_*' LIMIT 1").get() ||
      publication.profileId !== plan.targetProfileId ||
      publication.readSelectedHead() !== null
    )
      fail('destination is not unpublished and target bound');
    const current = db
      .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_manual_copy:*' ORDER BY key")
      .all();
    if (canonicalLiteral(current) !== canonicalLiteral(data.sourceRows))
      fail('copied proof inventory differs');
    const revisions = data.proofs.length
      ? sourceTextInventory(db, plan.targetProfileId)
      : new Set<string>();
    for (const proof of data.proofs) {
      const original = db
        .prepare('SELECT kind,sha256,path FROM source_files WHERE id=?')
        .get(proof.intakeId);
      const proposal = db
        .prepare('SELECT kind,sha256,path FROM source_files WHERE id=?')
        .get(proof.proposalId);
      if (
        !original ||
        original.kind !== 'intake_original' ||
        original.sha256 !== proof.sourceHash ||
        !proposal ||
        proposal.kind !== 'intake_proposal' ||
        proposal.sha256 !== proof.proposalHash ||
        ![original.path, proposal.path].every(
          (path) =>
            typeof path === 'string' &&
            path.startsWith(`data/profiles/${plan.targetProfileId}/sources/`),
        ) ||
        !revisions.has(
          `intake_source_text:v1:${proof.intakeId}:revision:${proof.sourceTextRevisionId}`,
        )
      )
        fail('destination original/proposal/revision differs');
    }
    for (const row of data.sourceRows) {
      const archive = `private_copy_source_receipt:v1:${plan.sourceProfileId}:${row.key}`,
        prior = metadata(db, archive);
      if (prior !== undefined && prior !== row.value) fail('archived proof collision');
      db.prepare('INSERT OR IGNORE INTO app_meta(key,value) VALUES(?,?)').run(archive, row.value);
      db.prepare('DELETE FROM app_meta WHERE key=?').run(row.key);
    }
    for (const proof of data.proofs)
      db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
        proofKey(proof),
        JSON.stringify(proof),
      );
    if (
      publication.readSelectedHead() !== null ||
      sourceHead(data.source, plan.sourceProfileId) !== data.head
    )
      fail('publication/source changed while staging');
  } catch (error) {
    if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
    throw error;
  }
}
