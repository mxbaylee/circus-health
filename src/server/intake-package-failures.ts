import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IntakePackageFailure } from '../shared/intake.ts';
import { HttpError } from './database.ts';
import { getIntake, workflowMutation } from './intake.ts';
import { workflowSummary } from './intake-workflow.ts';

export interface IntakePackageFailureInput {
  operationKey: string;
  memberId?: string;
  ordinal?: number;
  filename?: string;
  locator?: string;
  reasonCode: string;
  detail: string;
  retryAction?: IntakePackageFailure['retryAction'];
}

function operationKey(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\x00-\x1f\x7f]/.test(value))
    throw new HttpError(400, 'PACKAGE_FAILURE_SCOPE', 'Use a bounded package operation key');
  return value;
}

/** Worker diagnostics are not authority for filesystem paths, URLs or stack traces. */
export function sanitizePackageFailureDetail(value: string): string {
  return (
    String(value)
      .slice(0, 4096)
      .split('\n')
      .filter((line) => !/^\s*at\s/.test(line))
      .join(' ')
      .replace(/\b[a-z][a-z\d+.-]*:\/\/\S+/gi, '[address]')
      .replace(/(^|[\s('"])(?:[A-Z]:\\|\/)[^\s'"<>]*/gi, '$1[path]')
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500) || 'Package processing could not finish. The original remains retained.'
  );
}

function failureKey(sourceHash: string, key: string): string {
  return createHash('sha256')
    .update(JSON.stringify([sourceHash, key]))
    .digest('hex');
}

function validateLocation(input: IntakePackageFailureInput, paged = false): void {
  // The inspector admits 2,000 Unicode code points, including astral names.
  // Preserve those exact names; UTF-16 storage needs up to twice that length.
  for (const [name, maximum] of [
    ['memberId', 200],
    ['filename', paged ? 1024 * 1024 : 4000],
    ['locator', paged ? 1024 * 1024 + 20 : 4200],
  ] as const) {
    const value = input[name];
    if (value !== undefined && (typeof value !== 'string' || !value || value.length > maximum))
      throw new HttpError(400, 'PACKAGE_FAILURE_SCOPE', 'Use an exact bounded package location');
  }
  if (input.ordinal !== undefined && (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0))
    throw new HttpError(400, 'PACKAGE_FAILURE_SCOPE', 'Use an exact package member ordinal');
  if (typeof input.reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(input.reasonCode))
    throw new HttpError(400, 'PACKAGE_FAILURE_REASON', 'Use a package processing reason code');
  if (
    input.retryAction !== undefined &&
    !['inventory', 'read_member', 'read_structure'].includes(input.retryAction)
  )
    throw new HttpError(400, 'PACKAGE_FAILURE_SCOPE', 'Use a supported package retry action');
}

/** Store only the changed pending scope in the existing selected intake journal. */
export function recordIntakePackageFailure(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: IntakePackageFailureInput,
) {
  const key = operationKey(input.operationKey);
  validateLocation(input);
  const intake = getIntake(db, root, profileId, id);
  const failure: IntakePackageFailure = {
    sourceFileId: intake.id,
    sourceHash: intake.sha256,
    operationKey: key,
    originalFilename: intake.filename,
    contentUrl: intake.contentUrl,
    ...(input.memberId === undefined ? {} : { memberId: input.memberId }),
    ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
    ...(input.filename === undefined ? {} : { filename: input.filename }),
    ...(input.locator === undefined ? {} : { locator: input.locator }),
    reasonCode: input.reasonCode,
    detail: sanitizePackageFailureDetail(input.detail),
    status: 'pending',
    scope: 'incomplete',
    retryAction:
      input.retryAction ||
      (key === 'inventory'
        ? 'inventory'
        : key.startsWith('structure:')
          ? 'read_structure'
          : 'read_member'),
  };
  const slot = failureKey(intake.sha256, key);
  if (JSON.stringify(intake.packageFailures?.[slot]) === JSON.stringify(failure)) return intake;
  // Do not add a growing workflow.operations history for transient retries.
  // The selected authority itself retains the bounded per-key change receipt.
  return workflowMutation(
    db,
    root,
    profileId,
    id,
    { version: intake.version },
    (_workflow, _file, details) => {
      details.packageFailures ??= {};
      details.packageFailures[slot] = failure;
    },
  );
}

/** A successful operation clears only its own pending scope on the same original. */
export function resolveIntakePackageFailure(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: { operationKey: string },
) {
  const key = operationKey(input.operationKey);
  const intake = getIntake(db, root, profileId, id);
  const slot = failureKey(intake.sha256, key);
  const pending = intake.packageFailures?.[slot];
  if (
    !pending ||
    pending.sourceFileId !== intake.id ||
    pending.sourceHash !== intake.sha256 ||
    pending.operationKey !== key
  )
    return intake;
  return workflowMutation(
    db,
    root,
    profileId,
    id,
    { version: intake.version },
    (workflow, _file, details) => {
      delete details.packageFailures![slot];
      // Only retire the attention state this processing failure promoted. The
      // normal intake paths' existing receipts determine its underlying state;
      // processing success never creates acceptance or a clinical disposition.
      if (details.state !== 'needs_review' || workflowSummary(details).needsReview) return;
      const latestProposal = details.proposals.at(-1);
      const explicitlyKept = workflow.decisions.some(
        (decision) =>
          decision.action === 'keep_original_only' &&
          (!latestProposal ||
            ('proposalId' in decision && decision.proposalId === latestProposal.id)) &&
          workflow.candidates.some(
            (candidate) =>
              candidate.id === decision.candidateId &&
              candidate.versions.some(
                (version) =>
                  version.id === decision.candidateVersionId && version.status === 'kept_original',
              ),
          ),
      );
      // A historical import and a different later proposal do not establish
      // whether the latest proposal was the person's last reviewed scope.
      // Keep the legacy attention label rather than invent acceptance priority.
      if (
        details.imported &&
        latestProposal &&
        latestProposal.id !== details.acceptedProposalId &&
        !explicitlyKept
      )
        return;
      details.state = details.imported
        ? 'imported'
        : explicitlyKept
          ? 'kept_original'
          : latestProposal
            ? 'conversion_proposed'
            : details.validation.valid
              ? 'ready'
              : 'pending_conversion';
    },
  );
}

/** Native asynchronous adapters never hydrate a selected workflow or all
 * failures. Legacy synchronous DTO callers retain their existing functions. */
async function nativeFailures(db: DatabaseSync, root: string, profileId: string, id: string) {
  const { assertIntakeOwner } = await import('./intake.ts');
  const { intakeSourceVersion } = await import('./intake-state-access.ts');
  const { selectedEnvelopeStore, openIntakeCollectionEnvelope } =
    await import('./intake-collection-envelope.ts');
  const { buildIntakeCollectionEnvelope } = await import('./intake-envelope-build.ts');
  assertIntakeOwner(db, profileId);
  void root;
  const source = db
    .prepare(
      "SELECT id,kind,sha256,details_json FROM source_files WHERE id=? AND kind='intake_original'",
    )
    .get(id) as { id: string; kind: string; sha256: string; details_json: string } | undefined;
  if (!source) throw new HttpError(404, 'NOT_FOUND', 'Retained source intake not found');
  const { collections } = selectedEnvelopeStore(db, source);
  const version = intakeSourceVersion(db, id);
  const control =
    version.logicalBinding === undefined
      ? undefined
      : collections.get(collections.openView(), 'logical', 'envelope.control', 'representation');
  if (
    typeof control !== 'string' ||
    JSON.parse(control).format !== 'health-intake-record-envelope-v1'
  )
    await buildIntakeCollectionEnvelope(db, source);
  const reader = openIntakeCollectionEnvelope(db, source);
  const intake = reader.child(reader.root(), 'intake');
  if (!intake) throw Error('Retained intake envelope is missing');
  return {
    source,
    reader,
    intake,
    dictionary: reader.child(intake, 'packageFailures'),
    version: intakeSourceVersion(db, id),
  };
}
function nativeScalar(
  reader: import('./intake-collection-envelope.ts').IntakeCollectionEnvelopeReader,
  record: import('./intake-collection-envelope.ts').IntakeEnvelopeRecord,
  field: string,
) {
  const value = reader.field(record, field, { bytes: 8192 });
  if (value.kind === 'missing') return undefined;
  if (value.kind === 'value') return value.value;
  let text = '',
    bytes = 0;
  for (const chunk of reader.fieldChunks(record, field)) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 2 * 1024 * 1024) throw Error('Package failure field exceeds ZIP record grammar');
    text += chunk;
  }
  return JSON.parse(text);
}
async function nativeFailureMutation(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  current: Awaited<ReturnType<typeof nativeFailures>>,
  changes: import('./intake-envelope-mutation.ts').IntakeEnvelopeMutation[],
) {
  const { randomUUID } = await import('node:crypto');
  const { prepareIntakeEnvelopeMutation } = await import('./intake-envelope-mutation.ts');
  const { selectedEnvelopeStore } = await import('./intake-collection-envelope.ts');
  const { intakeTransaction } = await import('./intake.ts');
  const { intakeSourceVersion } = await import('./intake-state-access.ts');
  const operationId = randomUUID(),
    requestDigest = createHash('sha256').update(operationId).digest('hex');
  const prepared = await prepareIntakeEnvelopeMutation(db, current.source, {
    reader: current.reader,
    changes,
    operationId,
    requestDigest,
    domainVersion: current.version.rawVersion + 1,
  });
  if (!prepared.prepared) throw Error('New package failure mutation unexpectedly replayed');
  intakeTransaction(
    db,
    () => selectedEnvelopeStore(db, current.source).collections.stage(prepared.prepared!),
    { operationId, fingerprint: requestDigest, actor: 'intake' },
  );
  void root;
  void profileId;
  return { version: intakeSourceVersion(db, id).version, changed: true };
}
export async function recordIntakePackageFailurePaged(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: IntakePackageFailureInput,
) {
  const key = operationKey(input.operationKey);
  validateLocation(input, true);
  const current = await nativeFailures(db, root, profileId, id);
  const { intakeSourceMetadata } = await import('./intake-state-access.ts');
  const failure: IntakePackageFailure = {
    sourceFileId: id,
    sourceHash: current.source.sha256,
    operationKey: key,
    originalFilename: intakeSourceMetadata(db, id).originalName,
    contentUrl: `/api/sources/${encodeURIComponent(id)}/content`,
    ...(input.memberId === undefined ? {} : { memberId: input.memberId }),
    ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
    ...(input.filename === undefined ? {} : { filename: input.filename }),
    ...(input.locator === undefined ? {} : { locator: input.locator }),
    reasonCode: input.reasonCode,
    detail: sanitizePackageFailureDetail(input.detail),
    status: 'pending',
    scope: 'incomplete',
    retryAction:
      input.retryAction ||
      (key === 'inventory'
        ? 'inventory'
        : key.startsWith('structure:')
          ? 'read_structure'
          : 'read_member'),
  };
  const slot = failureKey(current.source.sha256, key),
    existing = current.dictionary && current.reader.child(current.dictionary, slot);
  if (
    existing &&
    [...new Set([...Object.keys(failure), 'memberId', 'ordinal', 'filename', 'locator'])].every(
      (field) =>
        JSON.stringify(nativeScalar(current.reader, existing, field)) ===
        JSON.stringify(failure[field as keyof IntakePackageFailure]),
    )
  )
    return { version: current.version.version, changed: false, failure };
  const changes: import('./intake-envelope-mutation.ts').IntakeEnvelopeMutation[] =
    current.dictionary
      ? [{ op: 'put', record: current.dictionary, field: slot, jsonText: JSON.stringify(failure) }]
      : [
          {
            op: 'set',
            record: current.intake,
            field: 'packageFailures',
            jsonText: JSON.stringify({ [slot]: failure }),
          },
        ];
  if (nativeScalar(current.reader, current.intake, 'state') !== 'needs_review')
    changes.push({ op: 'set', record: current.intake, field: 'state', jsonText: '"needs_review"' });
  return { ...(await nativeFailureMutation(db, root, profileId, id, current, changes)), failure };
}
export async function resolveIntakePackageFailurePaged(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: { operationKey: string },
) {
  const key = operationKey(input.operationKey),
    current = await nativeFailures(db, root, profileId, id);
  const slot = failureKey(current.source.sha256, key),
    pending = current.dictionary && current.reader.child(current.dictionary, slot);
  if (
    !pending ||
    nativeScalar(current.reader, pending, 'sourceFileId') !== id ||
    nativeScalar(current.reader, pending, 'sourceHash') !== current.source.sha256 ||
    nativeScalar(current.reader, pending, 'operationKey') !== key
  )
    return { version: current.version.version, changed: false };
  // The attention label remains until the bounded workflow count owner can
  // prove its exact underlying disposition. Clearing this receipt never mints
  // acceptance or assumes that unrelated review work has completed.
  return nativeFailureMutation(db, root, profileId, id, current, [
    { op: 'delete', record: current.dictionary!, field: slot },
  ]);
}
