import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { ManualSourceRecordReceipt } from '../shared/intake-manual-source-record.ts';
import {
  currentTransactionToken,
  hasTransactionDurability,
  rejectCurrentTransaction,
  type Database,
} from './database.ts';
import { flushRecordDurability, recordDurabilityStatus } from './record-versions.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from './intake-collection-envelope.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import { INTAKE_LEGACY_BRIDGE_CONTROL } from './intake-state-migration.ts';
import { canonicalLiteral, MAX_INTAKE_BYTES, validateJSONL } from './intake-format.ts';
import { profileOriginal } from './profile-storage.ts';
import { validProfileId } from './profiles.ts';
import { validatePortableIntakeSourceTextRows } from './intake-source-text.ts';
import type { IntakeCopyPublicationReader, IntakeStateCopyPlan } from './intake-state-bootstrap.ts';
import { portableCopySourceTextInventory } from './intake-state-portable-copy.ts';
import {
  prepareContributorCopyCertification,
  contributorCopySourceTextInventory,
  disposeContributorCopyCertification,
  type ContributorCopyCertification,
} from './contributor-durability.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { prepareIntakeLegacyReplaySteps } from './intake-state-legacy-replay.ts';
import { prepareIntakeJsonCanonicalSteps } from './intake-json-canonical.ts';
import {
  finishIntakeCopySteps,
  finishIntakeCopyStepsAsync,
  intakeCopyNativeSelect,
} from './intake-copy-work.ts';
import { createIntakeTree } from './intake-state-tree.ts';
import { parseIntakeCollectionHistory } from './intake-state-collections.ts';
import {
  COLLECTION_FORMAT,
  HEAD_BYTES,
  decode,
  limits,
  intakeNamespace,
  parseIntakeHead,
  parseIntakeCollectionHead,
} from './intake-state-evidence.ts';
import {
  intakeCopyJsonHashSteps,
  intakeCopyJsonString,
  intakeCopyJsonTree,
  intakeCopyManualReceiptSteps,
  intakeCopyTextPieces,
} from './intake-copy-json.ts';

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
  intakeCopyNativeSelect(db, 'SELECT value FROM main.app_meta WHERE key=?').get(key)?.value;
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
  assertSourceCurrent?: () => void;
  certification?: ContributorCopyCertification;
}
const plans = new WeakMap<ManualSourceCopyPlan, PlanData>();
const planCleanup = new FinalizationRegistry<PlanData>((data) => {
  try {
    data.scratch.close();
  } finally {
    if (data.certification) disposeContributorCopyCertification(data.certification);
  }
});
export function disposeManualSourceCopyPlan(plan: ManualSourceCopyPlan): void {
  const data = plans.get(plan);
  if (data) {
    plans.delete(plan);
    planCleanup.unregister(plan);
    try {
      data.scratch.close();
    } finally {
      if (data.certification) disposeContributorCopyCertification(data.certification);
    }
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
  const head = intakeCopyNativeSelect(
    db,
    'SELECT head_json FROM main.__record_state WHERE singleton=1',
  ).get()?.head_json;
  if (typeof head !== 'string') fail('source selected head missing');
  return head;
}
function sourceTextInventory(db: Database, profileId: string): { has(key: string): boolean } {
  validatePortableIntakeSourceTextRows(
    {
      rows: (table) =>
        table === 'app_meta'
          ? intakeCopyNativeSelect(
              db,
              "SELECT key,value FROM main.app_meta WHERE key GLOB 'intake_source_text:*'",
            ).iterate()
          : table === 'source_files'
            ? intakeCopyNativeSelect(
                db,
                "SELECT * FROM main.source_files WHERE kind='intake_original'",
              ).iterate()
            : [],
    },
    profileId,
  );
  return {
    has: (key) => !!intakeCopyNativeSelect(db, 'SELECT 1 FROM main.app_meta WHERE key=?').get(key),
  };
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
    const identity = {
        profileId: String(metadata(db, 'owner_profile_id')),
        intakeId: source.id,
        sourceHash: String(source.sha256),
      },
      prefix = intakeNamespace(identity),
      read = (key: string) => metadata(db, key),
      rawHead = read(prefix + 'head'),
      header = decode(rawHead, HEAD_BYTES);
    let head;
    if (Reflect.get(header as object, 'format') === COLLECTION_FORMAT) {
      const selectedHead = parseIntakeCollectionHead(rawHead, identity)!,
        tree = createIntakeTree(identity, (hash) => read(prefix + 'node:' + hash), new Map()),
        first = tree.get(selectedHead.history, String(1).padStart(16, '0'));
      if (first === undefined) fail('missing manual legacy bridge');
      const history = parseIntakeCollectionHistory(first!, identity),
        previous = history.previous;
      if (!previous || previous.format !== 'health-intake-legacy-v3')
        fail('missing manual legacy bridge');
      head = previous.head;
    } else head = parseIntakeHead(rawHead, identity, limits())!;
    const replay = yield* prepareIntakeLegacyReplaySteps(identity, limits(), head, read);
    let tree: ReturnType<typeof intakeCopyJsonTree> | undefined;
    try {
      tree = yield* prepareIntakeJsonCanonicalSteps(replay.envelopePieces());
      if (tree.kind(tree.root) !== 'object') fail('selected intake missing');
      const intake = tree.field(tree.root, 'intake');
      if (!intake || tree.kind(intake) !== 'object') fail('selected intake missing');
      const proposals = tree.field(intake!, 'proposals');
      if (!proposals || tree.kind(proposals) !== 'array') fail('selected proposal list missing');
      for (const proposal of tree.arrayItems(proposals!)) {
        yield;
        if (tree.kind(proposal) !== 'object') fail('manual proposal object');
        const receipt = tree.field(proposal, 'manualSourceRecord');
        if (!receipt || tree.kind(receipt) === 'null') continue;
        if (tree.kind(receipt) !== 'object') {
          const kind = tree.kind(receipt);
          if (
            (kind === 'boolean' && [...tree.pieces(receipt)].join('') === 'false') ||
            (kind === 'number' && [...tree.pieces(receipt)].join('') === '0') ||
            (kind === 'string' && intakeCopyJsonString(tree, receipt) === '')
          )
            continue;
          fail('manual receipt object');
        }
        const checked = yield* intakeCopyManualReceiptSteps(tree.pieces(receipt));
        if (!checked) fail('manual receipt object');
        const id = intakeCopyJsonString(tree, tree.field(proposal, 'id')),
          revision = intakeCopyJsonString(tree, tree.field(proposal, 'sourceTextRevisionId'));
        if (id === undefined || revision === undefined) fail('manual proposal identity');
        yield {
          id: id!,
          sourceTextRevisionId: revision!,
          manualSourceRecord: checked!.receipt,
          receiptHash: checked!.hash,
        };
      }
    } finally {
      tree?.close();
      replay.close();
    }
    return;
  }
  const reader = openIntakeCollectionEnvelope(db, source),
    intake = reader.child(reader.root(), 'intake');
  if (!intake) fail('selected intake missing');
  let after: string | undefined;
  for (;;) {
    const page = reader.children(intake, 'proposals', { after, items: 32, bytes: 65536 });
    for (const proposal of page.records) {
      yield;
      const receipt = reader.field(proposal, 'manualSourceRecord', { bytes: 4096 });
      if (receipt.kind === 'missing' || (receipt.kind === 'value' && !receipt.value)) continue;
      const checked = yield* intakeCopyManualReceiptSteps(
        reader.fieldChunks(proposal, 'manualSourceRecord'),
      );
      if (!checked) fail('manual receipt object');
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
        manualSourceRecord: checked.receipt,
        receiptHash: checked.hash,
      };
    }
    if (page.complete) return;
    if (!page.after || page.after === after) fail('proposal traversal cursor');
    after = page.after;
  }
}

/** Retain the existing JSONL validation and row allowance while reading the
 * physical proposal once. Blank lines cannot grow a retained row buffer. */
function* checkManualProposalFileSteps(
  path: string,
  expected: { bytes: number; sha256: string },
  operationId: string,
): Generator<void, void> {
  const fd = openSync(path, 'r'),
    block = Buffer.alloc(65536),
    decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }),
    hash = createHash('sha256');
  let bytes = 0,
    line = '',
    lineBytes = 0,
    nonempty = false,
    records = 0;
  const endLine = () => {
    if (nonempty) {
      if (lineBytes > 2 * 1024 * 1024 + (line.endsWith('\r') ? 1 : 0))
        fail('manual proposal row exceeds existing JSONL budget');
      const parsed = validateJSONL(Buffer.from(line));
      if (
        !parsed.valid ||
        parsed.entries.length !== 1 ||
        parsed.entries[0].value.id !== `manual:${operationId}` ||
        ++records !== 1
      )
        fail('manual proposal entry binding');
    }
    line = '';
    lineBytes = 0;
    nonempty = false;
  };
  const text = (piece: string) => {
    let at = 0;
    for (;;) {
      const newline = piece.indexOf('\n', at),
        part = piece.slice(at, newline === -1 ? undefined : newline);
      lineBytes += Buffer.byteLength(part);
      nonempty ||= part.trim().length > 0;
      if (lineBytes <= 2 * 1024 * 1024 + 1) line += part;
      if (newline === -1) return;
      endLine();
      at = newline + 1;
    }
  };
  try {
    for (;;) {
      const count = readSync(fd, block, 0, block.length, null);
      if (!count) break;
      bytes += count;
      if (bytes > MAX_INTAKE_BYTES) fail('manual proposal exceeds existing JSONL budget');
      hash.update(block.subarray(0, count));
      text(decoder.decode(block.subarray(0, count), { stream: true }));
      yield;
    }
    text(decoder.decode());
    endLine();
    if (records !== 1) fail('manual proposal entry binding');
    if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256)
      fail('proposal evidence changed');
  } finally {
    closeSync(fd);
  }
}

function copiedProjectedReceiptApplies(
  db: Database,
  scope: Boundary,
  receipt: ManualSourceRecordReceipt,
  receiptHash: string,
): boolean {
  if (metadata(db, 'owner_profile_id') !== scope.profileId) return false;
  const raw = metadata(db, proofKey(scope));
  if (raw === undefined) return false;
  const proof = parseProof(raw);
  if (
    !receiptMatches(receipt, scope) ||
    !Object.entries(scope).every(([key, value]) => proof[key as keyof Boundary] === value) ||
    proof.authorProfileId !== receipt.profileId ||
    proof.receiptHash !== receiptHash ||
    proof.sourceTextRevisionId !== receipt.sourceTextRevisionId
  )
    fail('retained proof does not match target receipt/source/proposal');
  return true;
}
/** Preparation runs under the existing authorized source copy lease, before
 * owner/path changes. An opaque plan is required; supplied proof objects cannot
 * mint a target grant. Existing grants are checked against the current source. */
export function prepareManualSourceCopy(
  ...args: Parameters<typeof prepareManualSourceCopySteps>
): ManualSourceCopyPlan {
  return finishIntakeCopySteps(prepareManualSourceCopySteps(...args));
}

export async function prepareManualSourceCopyAsync(
  db: Database,
  root: string,
  sourceProfileId: string,
  targetProfileId: string,
  options: { signal?: AbortSignal; intakePlan?: IntakeStateCopyPlan } = {},
): Promise<ManualSourceCopyPlan> {
  let certification: ContributorCopyCertification | undefined;
  try {
    let inventory = options.intakePlan
      ? portableCopySourceTextInventory(
          options.intakePlan,
          db,
          root,
          sourceProfileId,
          options.signal,
        )
      : undefined;
    if (!inventory) {
      certification = await prepareContributorCopyCertification(
        db,
        root,
        sourceProfileId,
        undefined,
        options.signal,
      );
      inventory = contributorCopySourceTextInventory(
        certification,
        db,
        root,
        sourceProfileId,
        options.signal,
      );
    }
    const plan = await finishIntakeCopyStepsAsync(
      prepareManualSourceCopyStepsInside(
        db,
        root,
        sourceProfileId,
        targetProfileId,
        options,
        await inventory,
      ),
      options.signal,
    );
    if (certification) {
      plans.get(plan)!.certification = certification;
      certification = undefined;
    }
    return plan;
  } finally {
    if (certification) disposeContributorCopyCertification(certification);
  }
}

export function* prepareManualSourceCopySteps(
  db: Database,
  root: string,
  sourceProfileId: string,
  targetProfileId: string,
  options: { signal?: AbortSignal } = {},
): Generator<void, ManualSourceCopyPlan> {
  return yield* prepareManualSourceCopyStepsInside(
    db,
    root,
    sourceProfileId,
    targetProfileId,
    options,
  );
}

function* prepareManualSourceCopyStepsInside(
  db: Database,
  root: string,
  sourceProfileId: string,
  targetProfileId: string,
  options: { signal?: AbortSignal },
  certifiedInventory?: Awaited<ReturnType<typeof contributorCopySourceTextInventory>>,
): Generator<void, ManualSourceCopyPlan> {
  certifiedInventory?.assertCurrent();
  options.signal?.throwIfAborted();
  if (!validProfileId(targetProfileId) || targetProfileId === sourceProfileId)
    fail('target profile identity');
  const head = sourceHead(db, sourceProfileId);
  const scratch = disposableSqlite('manual-source-copy-'),
    spool = scratch.db;
  try {
    spool.exec(
      'CREATE TABLE source(key TEXT PRIMARY KEY,value TEXT NOT NULL,used INTEGER DEFAULT 0); CREATE TABLE proofs(ordinal INTEGER PRIMARY KEY,value TEXT NOT NULL);',
    );
    for (const row of intakeCopyNativeSelect(
      db,
      "SELECT key,value FROM main.app_meta WHERE key GLOB 'intake_manual_copy:*' ORDER BY key",
    ).iterate()) {
      yield;
      options.signal?.throwIfAborted();
      const proof = parseProof(row.value);
      if (proof.profileId !== sourceProfileId || row.key !== proofKey(proof))
        fail('source proof namespace or owner');
      spool.prepare('INSERT INTO source(key,value) VALUES(?,?)').run(row.key, row.value);
    }
    const copyId = randomUUID();
    let revisions: { has(key: string): boolean } | undefined = certifiedInventory;
    for (const original of intakeCopyNativeSelect(
      db,
      "SELECT * FROM main.source_files WHERE kind='intake_original' ORDER BY id",
    ).iterate()) {
      yield;
      options.signal?.throwIfAborted();
      let verifiedOriginal = false;
      for (const proposal of copyProposals(db, original as unknown as IntakeEnvelopeSource)) {
        yield;
        options.signal?.throwIfAborted();
        if (proposal === undefined) continue;
        const receipt = proposal.manualSourceRecord;
        if (!receipt) continue;
        const file = intakeCopyNativeSelect(db, 'SELECT * FROM main.source_files WHERE id=?').get(
          proposal.id,
        );
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
          !copiedProjectedReceiptApplies(db, scope, receipt, proposal.receiptHash)
        )
          continue;
        spool.prepare('UPDATE source SET used=1 WHERE key=?').run(proofKey(scope));
        const proposalDetails = yield* prepareIntakeJsonCanonicalSteps(
          intakeCopyTextPieces(String(file.details_json)),
        );
        try {
          if (proposalDetails.kind(proposalDetails.root) !== 'object')
            fail('manual proposal receipt or source-text binding');
          const retainedReceipt = proposalDetails.field(proposalDetails.root, 'manualSourceRecord');
          if (
            intakeCopyJsonString(
              proposalDetails,
              proposalDetails.field(proposalDetails.root, 'originalSourceFileId'),
            ) !== original.id ||
            !retainedReceipt ||
            (yield* intakeCopyJsonHashSteps(proposalDetails, retainedReceipt)) !==
              proposal.receiptHash ||
            proposal.sourceTextRevisionId !== receipt.sourceTextRevisionId ||
            intakeCopyJsonString(
              proposalDetails,
              proposalDetails.field(proposalDetails.root, 'sourceTextRevisionId'),
            ) !== receipt.sourceTextRevisionId
          )
            fail('manual proposal receipt or source-text binding');
        } finally {
          proposalDetails.close();
        }
        revisions ??= sourceTextInventory(db, sourceProfileId);
        if (
          !revisions.has(
            `intake_source_text:v1:${original.id}:revision:${receipt.sourceTextRevisionId}`,
          )
        )
          fail('manual source-text revision missing');
        if (!verifiedOriginal) {
          const path = profileOriginal(root, original.path, sourceProfileId);
          if (
            statSync(path).size !== original.bytes ||
            (yield* hashCopyFileSteps(path)) !== original.sha256
          )
            fail('original evidence changed');
          verifiedOriginal = true;
        }
        yield* checkManualProposalFileSteps(
          profileOriginal(root, file.path, sourceProfileId),
          { bytes: Number(file.bytes), sha256: scope.proposalHash },
          receipt.operationId,
        );
        const proof: CopyProof = {
          ...scope,
          profileId: targetProfileId,
          format: FORMAT,
          copyId,
          sourceProfileId,
          sourceHeadHash: digest(head),
          authorProfileId: receipt.profileId,
          receiptHash: proposal.receiptHash,
          sourceTextRevisionId: receipt.sourceTextRevisionId,
        };
        spool.prepare('INSERT INTO proofs(value) VALUES(?)').run(JSON.stringify(proof));
      }
    }
    if (spool.prepare('SELECT 1 FROM source WHERE used=0 LIMIT 1').get())
      fail('orphan or conflicting source proof');
    if (sourceHead(db, sourceProfileId) !== head) fail('source changed during copy preparation');
    certifiedInventory?.assertCurrent();
    const plan = Object.freeze({ sourceProfileId, targetProfileId });
    const data = {
      source: db,
      head,
      scratch,
      assertSourceCurrent: certifiedInventory?.assertCurrent,
    };
    plans.set(plan, data);
    planCleanup.register(plan, data, plan);
    return plan;
  } catch (error) {
    scratch.close();
    throw error;
  }
}

function* hashCopyFileSteps(path: string): Generator<void, string> {
  const fd = openSync(path, 'r'),
    block = Buffer.alloc(65536),
    hash = createHash('sha256');
  try {
    for (;;) {
      const count = readSync(fd, block, 0, block.length, null);
      if (!count) return hash.digest('hex');
      hash.update(block.subarray(0, count));
      yield;
    }
  } finally {
    closeSync(fd);
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
    data.assertSourceCurrent?.();
    if (sourceHead(data.source, plan.sourceProfileId) !== data.head)
      fail('source selected head changed before staging');
    if (
      metadata(db, 'owner_profile_id') !== plan.targetProfileId ||
      hasTransactionDurability(db) ||
      recordDurabilityStatus(db) ||
      intakeCopyNativeSelect(
        db,
        "SELECT 1 FROM main.sqlite_schema WHERE name GLOB '__record_*' LIMIT 1",
      ).get() ||
      publication.profileId !== plan.targetProfileId ||
      publication.readSelectedHead() !== null
    )
      fail('destination is not unpublished and target bound');
    const spool = data.scratch.db;
    let count = 0;
    for (const row of intakeCopyNativeSelect(
      db,
      "SELECT key,value FROM main.app_meta WHERE key GLOB 'intake_manual_copy:*'",
    ).iterate()) {
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
      const original = intakeCopyNativeSelect(
        db,
        'SELECT kind,sha256,path FROM main.source_files WHERE id=?',
      ).get(proof.intakeId);
      const proposal = intakeCopyNativeSelect(
        db,
        'SELECT kind,sha256,path FROM main.source_files WHERE id=?',
      ).get(proof.proposalId);
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
    data.assertSourceCurrent?.();
  } catch (error) {
    if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
    throw error;
  }
}
