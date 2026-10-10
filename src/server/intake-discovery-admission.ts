import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import {
  currentTransactionToken,
  observeDatabaseClose,
  rejectCurrentTransaction,
} from './database.ts';
import { createTransactionOutcomeIssuer } from './transaction-observer-issuer.ts';
const outcomes = createTransactionOutcomeIssuer();
export const intakeDiscoveryTerminalOutcome = outcomes.recognizes;
import { assertClinicalOperation, currentClinicalOperation } from './clinical-operation.ts';
import { intakeEnvelopeAuthorityBinding, type IntakeEnvelopeSource } from './intake-authority.ts';
import { identityGroundingGeneration } from './intake-identity-grounding.ts';
import { intakeLookupProjectionGeneration } from './intake-lookup-projection.ts';
import {
  INTAKE_LOOKUP_INDEX_POLICY,
  preparedIntakeDiscoveryRevision,
} from './intake-lookup-state.ts';
import { intakeCollectionCacheGeneration } from './intake-state-collections.ts';
import { recordDurabilityStatus } from './record-versions.ts';

declare const admissionBrand: unique symbol;
export type IntakeDiscoveryAdmission = { readonly [admissionBrand]: true };

type Proof = {
  raw: string;
  profile: string;
  sequence: number;
  revision: number;
  registry: object;
  grounding: object;
  projection: object | undefined;
  operation: NonNullable<ReturnType<typeof currentClinicalOperation>>;
};
type State = {
  db: DatabaseSync;
  proof: Proof;
  alive: boolean;
  used: boolean;
  removeClose: () => void;
  removeOutcome: () => void;
};
const admissions = new WeakMap<IntakeDiscoveryAdmission, State>();
const unavailable = () => Error('Intake discovery frontier admission changed');

function rawReader(db: DatabaseSync) {
  const main = db.prepare(
    'SELECT total_changes() AS changes,(SELECT data_version FROM pragma_data_version) AS external,(SELECT schema_version FROM pragma_schema_version) AS schema',
  );
  main.setReadBigInts(true);
  const temp = db.prepare('PRAGMA temp.schema_version');
  temp.setReadBigInts(true);
  return () => {
    const row = main.get();
    const tempRow = temp.get();
    if (
      typeof row?.changes !== 'bigint' ||
      typeof row.external !== 'bigint' ||
      typeof row.schema !== 'bigint' ||
      typeof tempRow?.schema_version !== 'bigint'
    )
      throw unavailable();
    return `${row.changes}:${row.external}:${row.schema}:${tempRow.schema_version}`;
  };
}

function profileAndAuthority(db: DatabaseSync) {
  const profile = db
    .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
    .get()?.value;
  const durability = recordDurabilityStatus(db);
  if (
    typeof profile !== 'string' ||
    !profile ||
    durability?.configured !== true ||
    durability.dirty ||
    durability.conflicted
  )
    throw unavailable();
  return { profile, sequence: durability.sequence, revision: durability.revision };
}

function captureProof(db: DatabaseSync, readRaw: () => string): Proof {
  if (!db.isOpen || db.isTransaction) throw unavailable();
  const operation = currentClinicalOperation(db);
  if (!operation) throw unavailable();
  const raw = readRaw();
  const authority = profileAndAuthority(db);
  const registry = intakeCollectionCacheGeneration(db),
    grounding = identityGroundingGeneration(db),
    projection = intakeLookupProjectionGeneration(db);
  if (readRaw() !== raw) throw unavailable();
  if (
    intakeCollectionCacheGeneration(db) !== registry ||
    identityGroundingGeneration(db) !== grounding ||
    intakeLookupProjectionGeneration(db) !== projection
  )
    throw unavailable();
  assertClinicalOperation(db, operation);
  return { raw, ...authority, registry, grounding, projection, operation };
}

function assertProof(
  db: DatabaseSync,
  proof: Proof,
  readRaw: () => string,
  state: State,
  assertRunning?: () => void,
  transactionToken?: object,
) {
  if (!state.alive || !db.isOpen || db.isTransaction !== !!transactionToken) throw unavailable();
  assertRunning?.();
  if (currentClinicalOperation(db) !== proof.operation) throw unavailable();
  if (transactionToken && currentTransactionToken(db) !== transactionToken) throw unavailable();
  if (readRaw() !== proof.raw) throw unavailable();
  const authority = profileAndAuthority(db);
  if (
    authority.profile !== proof.profile ||
    authority.sequence !== proof.sequence ||
    authority.revision !== proof.revision ||
    intakeCollectionCacheGeneration(db) !== proof.registry ||
    identityGroundingGeneration(db) !== proof.grounding ||
    intakeLookupProjectionGeneration(db) !== proof.projection ||
    readRaw() !== proof.raw
  )
    throw unavailable();
  if (
    !state.alive ||
    intakeCollectionCacheGeneration(db) !== proof.registry ||
    identityGroundingGeneration(db) !== proof.grounding ||
    intakeLookupProjectionGeneration(db) !== proof.projection ||
    (transactionToken && currentTransactionToken(db) !== transactionToken)
  )
    throw unavailable();
  assertClinicalOperation(db, proof.operation);
}

/** Complete original-order digest work stays outside the acceptance transaction. */
export async function prepareIntakeDiscoveryAdmission(
  db: DatabaseSync,
  expected: string,
  options: {
    assertRunning?: () => void;
    onCheckpoint?: (visited: number) => void | Promise<void>;
  } = {},
): Promise<IntakeDiscoveryAdmission> {
  if (!/^[a-f0-9]{64}$/.test(expected) || !db.isOpen || db.isTransaction) throw unavailable();
  options.assertRunning?.();
  const readRaw = rawReader(db);
  const proof = captureProof(db, readRaw);
  const token = Object.freeze({}) as IntakeDiscoveryAdmission;
  const state: State = {
    db,
    proof,
    alive: true,
    used: false,
    removeClose: () => {},
    removeOutcome: () => {},
  };
  const dispose = () => {
    state.alive = false;
    state.removeClose();
    state.removeOutcome();
    admissions.delete(token);
  };
  state.removeClose = observeDatabaseClose(db, dispose);
  state.removeOutcome = outcomes.observe(db, dispose);
  try {
    if (preparedIntakeDiscoveryRevision(db) === expected) {
      assertProof(db, proof, readRaw, state, options.assertRunning);
      admissions.set(token, state);
      return token;
    }
    const revision = createHash('sha256');
    revision.update(JSON.stringify([INTAKE_LOOKUP_INDEX_POLICY, proof.profile]));
    const first = db.prepare(
      "SELECT rowid AS frontier_rowid,id,kind,sha256,details_json FROM source_files WHERE kind='intake_original' ORDER BY rowid LIMIT 1",
    );
    const next = db.prepare(
      "SELECT rowid AS frontier_rowid,id,kind,sha256,details_json FROM source_files WHERE kind='intake_original' AND rowid>? ORDER BY rowid LIMIT 1",
    );
    first.setReadBigInts(true);
    next.setReadBigInts(true);
    let cursor: bigint | undefined;
    let visited = 0;
    for (;;) {
      if (visited % 64 === 0) assertProof(db, proof, readRaw, state, options.assertRunning);
      const row = (cursor === undefined ? first.get() : next.get(cursor)) as
        (IntakeEnvelopeSource & { frontier_rowid: bigint }) | undefined;
      if (!row) break;
      if (typeof row.frontier_rowid !== 'bigint') throw unavailable();
      const binding = intakeEnvelopeAuthorityBinding(db, row);
      revision.update(
        JSON.stringify([row.id, row.sha256, binding.key, binding.logicalHead ?? binding.head]),
      );
      cursor = row.frontier_rowid;
      visited++;
      if (visited % 64 === 0) {
        assertProof(db, proof, readRaw, state, options.assertRunning);
        await options.onCheckpoint?.(visited);
        assertProof(db, proof, readRaw, state, options.assertRunning);
        await setImmediate();
        assertProof(db, proof, readRaw, state, options.assertRunning);
      }
    }
    if (revision.digest('hex') !== expected) throw unavailable();
    assertProof(db, proof, readRaw, state, options.assertRunning);
    admissions.set(token, state);
    return token;
  } catch (error) {
    dispose();
    throw error;
  }
}

export function consumeIntakeDiscoveryAdmission(
  db: DatabaseSync,
  admission: IntakeDiscoveryAdmission,
): void {
  const state = admissions.get(admission);
  try {
    const transactionToken = currentTransactionToken(db);
    if (!state || state.db !== db || state.used || !transactionToken || !db.isTransaction)
      throw unavailable();
    state.used = true;
    assertProof(db, state.proof, rawReader(db), state, undefined, transactionToken);
  } catch (error) {
    if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
    throw error;
  }
}

export function disposeIntakeDiscoveryAdmission(admission: IntakeDiscoveryAdmission): void {
  const state = admissions.get(admission);
  if (!state) return;
  state.alive = false;
  state.removeClose();
  state.removeOutcome();
  admissions.delete(admission);
}
