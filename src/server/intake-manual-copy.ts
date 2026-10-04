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
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from './intake-collection-envelope.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import { INTAKE_LEGACY_BRIDGE_CONTROL } from './intake-state-migration.ts';
import { canonicalLiteral, validateJSONL } from './intake-format.ts';
import { profileOriginal } from './profile-storage.ts';
import { validProfileId } from './profiles.ts';
import { hashFile } from './vault-store.ts';
import { validatePortableIntakeSourceTextRows } from './intake-source-text.ts';
import type { IntakeCopyPublicationReader } from './intake-state-bootstrap.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { DEFAULT_LIMITS } from './intake-state-evidence.ts';

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
  scratch: ReturnType<typeof disposableSqlite>;
}
const plans = new WeakMap<ManualSourceCopyPlan, PlanData>();
const planCleanup = new FinalizationRegistry<ReturnType<typeof disposableSqlite>>((scratch) =>
  scratch.close(),
);
export function disposeManualSourceCopyPlan(plan: ManualSourceCopyPlan): void {
  const data = plans.get(plan);
  if (data) {
    plans.delete(plan);
    planCleanup.unregister(plan);
    data.scratch.close();
  }
}
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
function sourceTextInventory(db: Database, profileId: string): { has(key: string): boolean } {
  validatePortableIntakeSourceTextRows(
    {
      rows: (table) =>
        table === 'app_meta'
          ? db
              .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_source_text:*'")
              .iterate()
          : table === 'source_files'
            ? db.prepare("SELECT * FROM source_files WHERE kind='intake_original'").iterate()
            : [],
    },
    profileId,
  );
  return { has: (key) => !!db.prepare('SELECT 1 FROM app_meta WHERE key=?').get(key) };
}
/** Only the proposal's copy eligibility fields are read from native schema.
 * Each page is bound to the selected root; unknown proposal evidence stays in
 * the authority copied by the separate checked graph traversal. */
function* copyProposals(db: Database, source: IntakeEnvelopeSource) {
  const selected = selectedEnvelopeStore(db, source);
  const control =
    selected.binding.logicalHead === undefined
      ? undefined
      : selected.collections.get(
          selected.collections.openView(),
          'logical',
          'envelope.control',
          'representation',
        );
  if (control === undefined || control === INTAKE_LEGACY_BRIDGE_CONTROL) {
    yield* storedIntakeDetails(db, source)!.proposals;
    return;
  }
  const reader = openIntakeCollectionEnvelope(db, source),
    intake = reader.child(reader.root(), 'intake');
  if (!intake) fail('selected intake missing');
  let after: string | undefined;
  for (;;) {
    const page = reader.children(intake, 'proposals', { after, items: 32, bytes: 65536 });
    for (const proposal of page.records) {
      const receipt = reader.field(proposal, 'manualSourceRecord', { bytes: 256 * 1024 });
      if (receipt.kind === 'missing' || (receipt.kind === 'value' && !receipt.value)) continue;
      // A historical receipt may include a long retained person name or unknown
      // fields. Preserve the existing strict per-value legacy byte allowance;
      // the UI field-page budget is not an evidence admission limit.
      let value: unknown;
      if (receipt.kind === 'fragmented') {
        let text = '',
          bytes = 0;
        for (const piece of reader.fieldChunks(proposal, 'manualSourceRecord')) {
          bytes += Buffer.byteLength(piece);
          if (bytes > DEFAULT_LIMITS.bytes) fail('manual receipt exceeds legacy per-value budget');
          text += piece;
        }
        value = JSON.parse(text);
      } else value = receipt.value;
      const id = reader.field(proposal, 'id'),
        revision = reader.field(proposal, 'sourceTextRevisionId');
      if (
        id.kind !== 'value' ||
        typeof id.value !== 'string' ||
        revision.kind !== 'value' ||
        typeof revision.value !== 'string'
      )
        fail('manual proposal identity');
      yield {
        id: id.value,
        sourceTextRevisionId: revision.value,
        manualSourceRecord: value as ManualSourceRecordReceipt,
      };
    }
    if (page.complete) return;
    if (!page.after || page.after === after) fail('proposal traversal cursor');
    after = page.after;
  }
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
  const scratch = disposableSqlite('manual-source-copy-'),
    spool = scratch.db;
  try {
    spool.exec(
      'CREATE TABLE source(key TEXT PRIMARY KEY,value TEXT NOT NULL,used INTEGER DEFAULT 0); CREATE TABLE proofs(ordinal INTEGER PRIMARY KEY,value TEXT NOT NULL);',
    );
    for (const row of db
      .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_manual_copy:*' ORDER BY key")
      .iterate()) {
      const proof = parseProof(row.value);
      if (proof.profileId !== sourceProfileId || row.key !== proofKey(proof))
        fail('source proof namespace or owner');
      spool.prepare('INSERT INTO source(key,value) VALUES(?,?)').run(row.key, row.value);
    }
    const copyId = randomUUID();
    let revisions: { has(key: string): boolean } | undefined;
    for (const original of db
      .prepare("SELECT * FROM source_files WHERE kind='intake_original' ORDER BY id")
      .iterate()) {
      let verifiedOriginal = false;
      for (const proposal of copyProposals(db, original as unknown as IntakeEnvelopeSource)) {
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
        spool.prepare('UPDATE source SET used=1 WHERE key=?').run(proofKey(scope));
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
        const proof: CopyProof = {
          ...scope,
          profileId: targetProfileId,
          format: FORMAT,
          copyId,
          sourceProfileId,
          sourceHeadHash: digest(head),
          authorProfileId: receipt.profileId,
          receiptHash: digest(receipt),
          sourceTextRevisionId: receipt.sourceTextRevisionId,
        };
        spool.prepare('INSERT INTO proofs(value) VALUES(?)').run(JSON.stringify(proof));
      }
    }
    if (spool.prepare('SELECT 1 FROM source WHERE used=0 LIMIT 1').get())
      fail('orphan or conflicting source proof');
    if (sourceHead(db, sourceProfileId) !== head) fail('source changed during copy preparation');
    const plan = Object.freeze({ sourceProfileId, targetProfileId });
    plans.set(plan, { source: db, head, scratch });
    planCleanup.register(plan, scratch, plan);
    return plan;
  } catch (error) {
    scratch.close();
    throw error;
  }
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
    const spool = data.scratch.db;
    let count = 0;
    for (const row of db
      .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_manual_copy:*'")
      .iterate()) {
      if (spool.prepare('SELECT value FROM source WHERE key=?').get(row.key)?.value !== row.value)
        fail('copied proof inventory differs');
      count++;
    }
    if (count !== Number(spool.prepare('SELECT count(*) n FROM source').get()!.n))
      fail('copied proof inventory differs');
    const revisions = spool.prepare('SELECT 1 FROM proofs LIMIT 1').get()
      ? sourceTextInventory(db, plan.targetProfileId)
      : new Set<string>();
    for (const row of spool.prepare('SELECT value FROM proofs ORDER BY ordinal').iterate()) {
      const proof = parseProof(row.value);
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
    for (const row of spool.prepare('SELECT key,value FROM source ORDER BY key').iterate()) {
      const archive = `private_copy_source_receipt:v1:${plan.sourceProfileId}:${row.key}`,
        prior = metadata(db, archive);
      if (prior !== undefined && prior !== row.value) fail('archived proof collision');
      db.prepare('INSERT OR IGNORE INTO app_meta(key,value) VALUES(?,?)').run(archive, row.value);
      db.prepare('DELETE FROM app_meta WHERE key=?').run(row.key);
    }
    for (const row of spool.prepare('SELECT value FROM proofs ORDER BY ordinal').iterate()) {
      const proof = parseProof(row.value);
      db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
        proofKey(proof),
        JSON.stringify(proof),
      );
    }
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
