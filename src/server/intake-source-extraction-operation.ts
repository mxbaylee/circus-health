import { createHash } from 'node:crypto';
import { HttpError, transaction, type Database } from './database.ts';
import { recordDurabilityStatus } from './record-versions.ts';
import { getIntakeSourceText, currentIntakeSourceTextRevisionId } from './intake-source-text.ts';
import { extractIntakeSourceText } from './intake-source-extraction.ts';
import type { IntakeSourceText } from '../shared/intake-source-text.ts';

export interface SourceExtractionOperationResult {
  sourceText: IntakeSourceText;
  operation: {
    operationId: string;
    status: 'completed' | 'interrupted';
    revisionId: string | null;
    requiresNewOperation: boolean;
    reasonCode: string | null;
  };
}
interface Receipt {
  format: 'intake-source-extraction-operation-v1';
  profileId: string;
  intakeId: string;
  sourceHash: string;
  operationId: string;
  fingerprint: string;
  expectedRevisionId: string | null;
  status: 'started' | 'completed' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  revisionId: string | null;
  reasonCode: string | null;
  maxPages: 2;
}
interface Context {
  db: Database;
  root: string;
  profileId: string;
  id: string;
  operationId: string;
  expectedRevisionId: string | null;
  sourceHash?: string;
  assertRunning?: () => void;
  /** Test seam for a local extraction step; production uses the bounded adapter. */
  extract?: typeof extractIntakeSourceText;
}
interface Active {
  fingerprint: string;
  intakeId: string;
  promise: Promise<SourceExtractionOperationResult>;
}
const activeByDatabase = new WeakMap<Database, Map<string, Active>>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const operationPattern = /^[a-zA-Z0-9_-]{8,128}$/;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (operationId: string) => `intake_source_extraction:v1:${operationId}`;
const conflict = (message: string): never => {
  throw new HttpError(409, 'SOURCE_EXTRACTION_OPERATION_CONFLICT', message);
};
function requireDurability(db: Database, profileId: string) {
  if (
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !== profileId
  )
    throw new HttpError(403, 'PROFILE_SCOPE', 'Source extraction belongs to a different profile');
  const status = recordDurabilityStatus(db);
  if (!status || status.conflicted)
    throw new HttpError(
      503,
      'SOURCE_TEXT_DURABILITY',
      'Source extraction requires the unlocked durable profile journal',
    );
}
function readReceipt(db: Database, operationId: string): Receipt | null {
  const row = db.prepare('SELECT value FROM app_meta WHERE key=?').get(key(operationId));
  if (!row) return null;
  let envelope: unknown;
  try {
    envelope = JSON.parse(String(row.value));
  } catch {
    conflict('Invalid durable extraction operation receipt');
  }
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    !('receipt' in envelope) ||
    !('sha256' in envelope) ||
    envelope.sha256 !== hash(envelope.receipt)
  )
    conflict('Extraction operation receipt integrity failed');
  const receipt = (envelope as { receipt: Receipt }).receipt;
  if (
    receipt.format !== 'intake-source-extraction-operation-v1' ||
    receipt.operationId !== operationId ||
    !['started', 'completed', 'interrupted'].includes(receipt.status) ||
    receipt.maxPages !== 2 ||
    !Number.isFinite(Date.parse(receipt.startedAt)) ||
    !/^[0-9a-f]{64}$/.test(receipt.sourceHash) ||
    !/^[0-9a-f]{64}$/.test(receipt.fingerprint) ||
    (receipt.expectedRevisionId !== null && !UUID.test(receipt.expectedRevisionId)) ||
    (receipt.revisionId !== null && !UUID.test(receipt.revisionId)) ||
    (receipt.status !== 'started' &&
      (!receipt.finishedAt || !Number.isFinite(Date.parse(receipt.finishedAt))))
  )
    conflict('Invalid durable extraction operation identity');
  return receipt;
}
/** Read-only, profile-scoped operation outcome; does not fabricate page inventory. */
export function getIntakeSourceExtractionFailure(
  db: Database,
  profileId: string,
  intakeId: string,
  sourceHash: string,
): { scope: 'file'; reasonCode: string } | undefined {
  if (
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !== profileId
  )
    throw new HttpError(403, 'PROFILE_SCOPE', 'Source extraction belongs to a different profile');
  const row = db
    .prepare(
      "SELECT json_extract(value,'$.receipt.operationId') AS operationId FROM app_meta WHERE key LIKE 'intake_source_extraction:v1:%' AND json_extract(value,'$.receipt.profileId')=? AND json_extract(value,'$.receipt.intakeId')=? ORDER BY json_extract(value,'$.receipt.startedAt') DESC, rowid DESC LIMIT 1",
    )
    .get(profileId, intakeId);
  if (!row) return;
  const receipt = readReceipt(db, String(row.operationId));
  if (
    !receipt ||
    receipt.profileId !== profileId ||
    receipt.intakeId !== intakeId ||
    receipt.sourceHash !== sourceHash
  )
    conflict('Extraction operation source identity changed');
  if (receipt!.status === 'interrupted')
    return {
      scope: 'file',
      reasonCode:
        typeof receipt!.reasonCode === 'string' &&
        /^[A-Z][A-Z0-9_]{0,95}$/.test(receipt!.reasonCode)
          ? receipt!.reasonCode
          : 'SOURCE_EXTRACTION_FAILED',
    };
}
function writeReceipt(db: Database, receipt: Receipt) {
  db.prepare(
    'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(key(receipt.operationId), JSON.stringify({ receipt, sha256: hash(receipt) }));
}
function response(context: Context, receipt: Receipt): SourceExtractionOperationResult {
  if (receipt.status === 'started') conflict('Extraction is still in progress');
  return {
    sourceText: receipt.revisionId
      ? getIntakeSourceText(
          context.db,
          context.root,
          context.profileId,
          context.id,
          receipt.revisionId,
        )
      : { status: 'unavailable', revision: null, summary: null },
    operation: {
      operationId: receipt.operationId,
      status: receipt.status as 'completed' | 'interrupted',
      revisionId: receipt.revisionId,
      requiresNewOperation: receipt.status === 'interrupted',
      reasonCode: receipt.reasonCode,
    },
  };
}
function finish(
  context: Context,
  receipt: Receipt,
  status: 'completed' | 'interrupted',
  revisionId: string | null,
  reasonCode: string | null,
): Receipt {
  context.assertRunning?.();
  requireDurability(context.db, context.profileId);
  return transaction(
    context.db,
    () => {
      const existing = readReceipt(context.db, receipt.operationId);
      if (!existing || existing.fingerprint !== receipt.fingerprint)
        conflict('Extraction operation changed before its terminal receipt');
      if (existing!.status !== 'started') return existing!;
      const terminal = {
        ...receipt,
        status,
        revisionId,
        reasonCode,
        finishedAt: new Date().toISOString(),
      };
      writeReceipt(context.db, terminal);
      return terminal;
    },
    {
      actor: 'profile-owner',
      origin: 'source-extraction-operation-terminal',
      references: {
        intakeId: context.id,
        operationId: receipt.operationId,
        sourceHash: receipt.sourceHash,
      },
    },
  );
}
/** A two-page local step has a durable admission and exact terminal result. No transaction
 * spans an await. A missing process cannot authorize repeating its unknown in-flight work.
 */
export function runIntakeSourceExtractionOperation(
  context: Context,
): Promise<SourceExtractionOperationResult> {
  const { db, root, profileId, id, operationId, expectedRevisionId } = context;
  if (
    !operationPattern.test(operationId) ||
    (expectedRevisionId !== null && !UUID.test(expectedRevisionId))
  )
    throw new HttpError(
      400,
      'INVALID_INPUT',
      'Extraction requires a stable operation ID and expected source-text revision',
    );
  context.assertRunning?.();
  requireDurability(db, profileId);
  const current = getIntakeSourceText(db, root, profileId, id);
  const sourceHash = String(
    db.prepare("SELECT sha256 FROM source_files WHERE id=? AND kind='intake_original'").get(id)!
      .sha256,
  );
  if (context.sourceHash !== undefined && context.sourceHash !== sourceHash)
    conflict('The extraction original changed');
  const fingerprint = hash({
    profileId,
    intakeId: id,
    sourceHash,
    operationId,
    expectedRevisionId,
    maxPages: 2,
    policy: 'local-source-step-v1',
  });
  const active = activeByDatabase.get(db) ?? new Map<string, Active>();
  activeByDatabase.set(db, active);
  const running = active.get(operationId);
  if (running) {
    if (running.fingerprint !== fingerprint)
      conflict('Operation ID was already used with different extraction arguments');
    return running.promise;
  }
  const prior = readReceipt(db, operationId);
  if (prior) {
    if (
      prior.fingerprint !== fingerprint ||
      prior.profileId !== profileId ||
      prior.intakeId !== id ||
      prior.sourceHash !== sourceHash
    )
      conflict('Operation ID was already used with different extraction arguments');
    if (prior.status === 'started') {
      // The original process/worker is absent. Capture current retained evidence, including
      // any intervening human work, and require a fresh explicit continuation operation.
      const terminal = finish(
        context,
        prior,
        'interrupted',
        current.revision?.id ?? null,
        'SOURCE_EXTRACTION_RECOVERED_PARTIAL',
      );
      return Promise.resolve(response(context, terminal));
    }
    return Promise.resolve(response(context, prior));
  }
  if ([...active.values()].some((entry) => entry.intakeId === id))
    throw new HttpError(
      409,
      'SOURCE_TEXT_EXTRACTION_ACTIVE',
      'Source extraction is already running; retry the same operation or wait',
    );
  if ((current.revision?.id ?? null) !== expectedRevisionId)
    throw new HttpError(
      409,
      'SOURCE_TEXT_CHANGED',
      'Reload source text before continuing extraction',
    );
  // Recover abandoned work without requiring the browser to remember its former key.
  // This new request receives its OWN interrupted receipt; retrying it must not dispatch.
  const pending = db
    .prepare(
      "SELECT value FROM app_meta WHERE key LIKE 'intake_source_extraction:v1:%' AND json_extract(value,'$.receipt.status')='started' AND json_extract(value,'$.receipt.profileId')=? AND json_extract(value,'$.receipt.intakeId')=?",
    )
    .all(profileId, id);
  const receipt: Receipt = {
    format: 'intake-source-extraction-operation-v1',
    profileId,
    intakeId: id,
    sourceHash,
    operationId,
    fingerprint,
    expectedRevisionId,
    status: 'started',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    revisionId: null,
    reasonCode: null,
    maxPages: 2,
  };
  if (pending.length) {
    const interrupted: Receipt = {
      ...receipt,
      status: 'interrupted',
      finishedAt: new Date().toISOString(),
      revisionId: current.revision?.id ?? null,
      reasonCode: 'SOURCE_EXTRACTION_PRIOR_INTERRUPTED',
    };
    transaction(
      db,
      () => {
        for (const row of pending) {
          const saved = JSON.parse(String(row.value)) as { receipt: Receipt };
          const earlier = readReceipt(db, saved.receipt.operationId)!;
          if (earlier.sourceHash !== sourceHash)
            conflict('Abandoned extraction belongs to a changed original');
          writeReceipt(db, {
            ...earlier,
            status: 'interrupted',
            finishedAt: interrupted.finishedAt,
            revisionId: interrupted.revisionId,
            reasonCode: 'SOURCE_EXTRACTION_RECOVERED_PARTIAL',
          });
        }
        writeReceipt(db, interrupted);
      },
      {
        actor: 'profile-owner',
        origin: 'source-extraction-operation-recovery',
        references: { intakeId: id, operationId, sourceHash },
      },
    );
    return Promise.resolve(response(context, interrupted));
  }
  transaction(
    db,
    () => {
      if (readReceipt(db, operationId)) conflict('Extraction operation was concurrently created');
      if (currentIntakeSourceTextRevisionId(db, profileId, id) !== expectedRevisionId)
        conflict('Source text changed before extraction admission');
      writeReceipt(db, receipt);
    },
    {
      actor: 'profile-owner',
      origin: 'source-extraction-operation-started',
      references: { intakeId: id, operationId, sourceHash },
    },
  );
  // Defer invocation until the in-memory lease is installed: even synchronously invoked
  // adapter hooks cannot launch a second worker before the first lease exists.
  const promise = Promise.resolve().then(async () => {
    try {
      context.assertRunning?.();
      const result = await (context.extract ?? extractIntakeSourceText)({
        db,
        root,
        profileId,
        id,
        maxPages: 2,
        assertRunning: context.assertRunning,
      });
      context.assertRunning?.();
      const terminal = finish(
        context,
        receipt,
        'completed',
        result.sourceText.revision?.id ?? null,
        null,
      );
      return response(context, terminal);
    } catch (error) {
      // Lock or unavailable durable storage cannot acknowledge a terminal state. The
      // admission remains recoverable after authorized unlock, never automatically rerun.
      context.assertRunning?.();
      requireDurability(db, profileId);
      const retained = getIntakeSourceText(db, root, profileId, id);
      const reasonCode =
        error instanceof HttpError && /^[A-Z0-9_]{1,80}$/.test(error.code)
          ? error.code
          : 'SOURCE_EXTRACTION_INTERRUPTED';
      const terminal = finish(
        context,
        receipt,
        'interrupted',
        retained.revision?.id ?? null,
        reasonCode,
      );
      return response(context, terminal);
    } finally {
      if (active.get(operationId)?.promise === promise) active.delete(operationId);
    }
  });
  active.set(operationId, { fingerprint, intakeId: id, promise });
  return promise;
}
