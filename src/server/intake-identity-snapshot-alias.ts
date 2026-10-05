/** Source-owned certified complete identity trees; immutable receipts keep their original IDs. */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  IntakeIdentityReview,
  IntakeIdentityScopeReference,
} from '../shared/intake-identity.ts';
import type {
  ReportSnapshotCatalog,
  ReportSnapshotMapReader,
} from './intake-report-snapshot-catalog.ts';
import {
  IDENTITY_SNAPSHOT_FORMAT,
  identitySnapshotScopeMatches,
} from './intake-identity-snapshot.ts';
import { identityScopeCommitmentsWork } from './intake-identity-commitment.ts';
import { identitySnapshotDeltaCertificate } from './intake-identity-snapshot-delta.ts';
import { recordIntakeWork, withIntakeWork } from './intake-work-accounting.ts';
import { schemaOrdinal } from './intake-envelope-schema.ts';

export const IDENTITY_SCOPE_ALIAS_FORMAT = 'health-intake-identity-scope-alias-v1';
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const identityEvidenceAliasId = (digest: string) => 'identity-evidence:' + digest;
export const identityCompleteSnapshotId = (proof: string, token: string) =>
  'identity-complete:' + proof + ':' + token;
const currentId = (groupId: string) =>
  'identity-current:' + createHash('sha256').update(groupId).digest('hex');
type Proof = NonNullable<IntakeIdentityReview['evidenceCommitment']>;
interface Boundary {
  profileId: string;
  intakeId: string;
  groupId: string;
  sourceHash: string;
}
export interface IdentityScopeAlias {
  reader: ReportSnapshotMapReader;
  snapshot: ReportSnapshotMapReader;
  warningContent: ReportSnapshotMapReader;
  scopeToken: string;
  intakeVersion: number;
  collection: Omit<IntakeIdentityScopeReference['collection'], 'snapshotId'>;
  proof: Proof;
  originalSourceHash: string;
  warningsSha256: string;
  warningCount: number;
}
function refuse(): never {
  throw Error('Invalid retained complete identity scope alias');
}
function string(reader: ReportSnapshotMapReader, key: string) {
  const value = reader.get(key);
  return typeof value === 'string' ? value : refuse();
}
function count(reader: ReportSnapshotMapReader, key: string) {
  const text = string(reader, key),
    value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== text) refuse();
  return value;
}
function validateAlias(
  catalog: ReportSnapshotCatalog,
  reader: ReportSnapshotMapReader,
  boundary: Boundary,
): IdentityScopeAlias {
  const proof: Proof = {
      format: 'health-intake-identity-evidence-v1',
      sha256: string(reader, '$proofSha256'),
    },
    digest = string(reader, '$warningsSha256'),
    warningCount = count(reader, '$warningCount');
  if (
    string(reader, '$format') !== IDENTITY_SCOPE_ALIAS_FORMAT ||
    string(reader, '$aliasId') !== identityEvidenceAliasId(proof.sha256) ||
    string(reader, '$proofFormat') !== proof.format ||
    !sha(proof.sha256) ||
    !sha(digest) ||
    string(reader, '$profileId') !== boundary.profileId ||
    string(reader, '$intakeId') !== boundary.intakeId ||
    string(reader, '$groupId') !== boundary.groupId ||
    string(reader, '$sourceHash') !== boundary.sourceHash ||
    !sha(string(reader, '$originalSourceHash')) ||
    !sha(string(reader, '$namespaceSha256')) ||
    count(reader, '$namespaceCount') < 3
  )
    refuse();
  const snapshot = reader.reference('$snapshot'),
    warningContent = reader.reference('$warningContent');
  if (!snapshot || !warningContent || snapshot.get('$format') !== IDENTITY_SNAPSHOT_FORMAT)
    refuse();
  const scopeToken = string(reader, '$scopeToken'),
    intakeVersion = count(reader, '$intakeVersion'),
    rawCollection = string(reader, '$collectionCounts');
  if (rawCollection.length > 1024) refuse();
  const { format: scopeFormat, ...collection } = JSON.parse(
    rawCollection,
  ) as IdentityScopeAlias['collection'] & { format: unknown };
  if (scopeFormat !== 'health-intake-identity-scope-v2') refuse();
  if (
    !collection ||
    !sha(scopeToken) ||
    snapshot.get('$warningCount') !== String(warningCount) ||
    warningContent.get('$format') !== 'health-intake-identity-warning-content-v1' ||
    warningContent.get('$sha256') !== digest ||
    warningContent.get('$count') !== String(warningCount)
  )
    refuse();
  for (const section of [
    'membership',
    'targets',
    'assignmentTargets',
    'questions',
    'competingSubjects',
  ] as const)
    if (!Number.isSafeInteger(collection[section]) || collection[section] < 0) refuse();
  catalog.assertCurrent();
  return {
    reader,
    snapshot,
    warningContent,
    scopeToken,
    intakeVersion,
    collection,
    proof,
    originalSourceHash: string(reader, '$originalSourceHash'),
    warningsSha256: digest,
    warningCount,
  };
}
/** An absent locator is a pre-upgrade bootstrap. Present broken references never become a miss. */
export function currentIdentityScopeAlias(catalog: ReportSnapshotCatalog, boundary: Boundary) {
  const selected = catalog.identityScopeReuseReader(currentId(boundary.groupId));
  if (!selected) return undefined;
  const { reader: locator, area } = selected;
  if (
    locator.get('$format') !== IDENTITY_SCOPE_ALIAS_FORMAT ||
    locator.get('$groupId') !== boundary.groupId ||
    locator.get('$intakeId') !== boundary.intakeId ||
    locator.get('$sourceHash') !== boundary.sourceHash ||
    locator.get('$profileId') !== boundary.profileId
  )
    refuse();
  const id = string(locator, '$aliasId');
  if (!/^identity-evidence:[a-f0-9]{64}$/.test(id)) refuse();
  const selectedAlias = catalog.identityScopeReuseReader(id, area);
  if (!selectedAlias) refuse();
  return validateAlias(catalog, selectedAlias.reader, boundary);
}
export function exactIdentityScopeAlias(
  catalog: ReportSnapshotCatalog,
  boundary: Boundary,
  proof: Proof,
) {
  const selected = catalog.identityScopeReuseReader(identityEvidenceAliasId(proof.sha256));
  if (!selected) return undefined;
  const alias = validateAlias(catalog, selected.reader, boundary);
  if (alias.proof.format !== proof.format || alias.proof.sha256 !== proof.sha256) refuse();
  return alias;
}
/** Complete proof equality allows only the three version-derived storage identities to change. */
export function identityScopeAliasMatches(
  alias: IdentityScopeAlias,
  scope: IntakeIdentityScopeReference,
  originalSourceHash: string,
  warningsSha256: string,
  warningCount: number,
) {
  const rebound: IntakeIdentityScopeReference = {
    ...scope,
    intakeVersion: alias.intakeVersion,
    scopeToken: alias.scopeToken,
    collection: { ...scope.collection, snapshotId: 'identity:' + alias.scopeToken },
  };
  if (
    alias.originalSourceHash !== originalSourceHash ||
    alias.warningsSha256 !== warningsSha256 ||
    alias.warningCount !== warningCount ||
    !identitySnapshotScopeMatches(alias.snapshot, rebound)
  )
    refuse();
}
/** Initial certification reconstructs complete primary evidence from retained bytes.
 * The independent desired-key certificate additionally checks every derived key and absence. */
function* verifyAliasEvidenceWork(input: {
  db: DatabaseSync;
  reader: ReportSnapshotMapReader;
  scope: IntakeIdentityScopeReference;
  proof: Proof;
  originalSourceHash: string;
  warningsSha256: string;
  warningCount: number;
}): Generator<void, void, void> {
  const { format: _format, collection, scopeToken: _scopeToken, ...header } = input.scope;
  const array = function* (section: string, count: number) {
    yield '[';
    for (let ordinal = 0; ordinal < count; ordinal++) {
      if (ordinal) yield ',';
      for (const piece of input.reader.chunks(section + ':' + schemaOrdinal(ordinal))) {
        withIntakeWork(input.db, 'warm', () =>
          recordIntakeWork('identitySnapshotAliasReadBytes', Buffer.byteLength(piece)),
        );
        yield piece;
      }
    }
    yield ']';
  };
  if (
    input.scope.format !== 'health-intake-identity-scope-v2' ||
    !sha(input.scope.scopeToken) ||
    input.scope.collection.snapshotId !== 'identity:' + input.scope.scopeToken ||
    !sha(input.originalSourceHash) ||
    input.proof.format !== 'health-intake-identity-evidence-v1' ||
    !sha(input.proof.sha256) ||
    input.reader.get('$format') !== IDENTITY_SNAPSHOT_FORMAT ||
    !identitySnapshotScopeMatches(input.reader, input.scope) ||
    input.reader.get('$warningCount') !== String(input.warningCount)
  )
    refuse();
  const result = yield* identityScopeCommitmentsWork({
    header,
    sourceHash: input.originalSourceHash,
    sections: {
      membership: array('membership', collection.membership),
      targets: array('targets', collection.targets),
      assignmentTargets: array('assignmentTargets', collection.assignmentTargets),
      ...(collection.questions ? { questions: array('questions', collection.questions) } : {}),
      ...(collection.competingSubjects
        ? { competingSubjects: array('competingSubjects', collection.competingSubjects) }
        : {}),
    },
    warnings: array('warnings', input.warningCount),
    onHash: (_kind, bytes) =>
      withIntakeWork(input.db, 'warm', () =>
        recordIntakeWork('identitySnapshotAliasHashBytes', bytes),
      ),
  });
  if (
    result.scopeToken !== input.scope.scopeToken ||
    result.evidenceCommitment.format !== input.proof.format ||
    result.evidenceCommitment.sha256 !== input.proof.sha256 ||
    result.warningsSha256 !== input.warningsSha256
  )
    refuse();
}
export async function publishIdentityScopeAlias(input: {
  db: DatabaseSync;
  catalog: ReportSnapshotCatalog;
  snapshot: ReportSnapshotMapReader;
  warningContent: ReportSnapshotMapReader;
  scope: IntakeIdentityScopeReference;
  proof: Proof;
  originalSourceHash: string;
  warningsSha256: string;
  warningCount: number;
  run: <T>(work: Generator<void, T, void>) => Promise<T>;
}) {
  const namespace = identitySnapshotDeltaCertificate(input.snapshot);
  await input.run(verifyAliasEvidenceWork({ ...input, reader: input.snapshot }));
  const wrapper = await input.catalog.fork(),
    scope = input.scope,
    snapshot = await input.catalog.forkReference(input.snapshot),
    warnings = await input.catalog.forkReference(input.warningContent);
  await wrapper.putMany([
    { key: '$format', value: IDENTITY_SCOPE_ALIAS_FORMAT },
    { key: '$aliasId', value: identityEvidenceAliasId(input.proof.sha256) },
    { key: '$profileId', value: scope.profileId },
    { key: '$intakeId', value: scope.intakeId },
    { key: '$groupId', value: scope.groupId },
    { key: '$sourceHash', value: scope.sourceHash },
    { key: '$originalSourceHash', value: input.originalSourceHash },
    { key: '$proofFormat', value: input.proof.format },
    { key: '$proofSha256', value: input.proof.sha256 },
    { key: '$warningsSha256', value: input.warningsSha256 },
    { key: '$warningCount', value: String(input.warningCount) },
    { key: '$scopeToken', value: scope.scopeToken },
    { key: '$intakeVersion', value: String(scope.intakeVersion) },
    {
      key: '$collectionCounts',
      value: JSON.stringify({
        format: scope.format,
        ...(({ snapshotId: _id, ...counts }) => counts)(scope.collection),
      }),
    },
    { key: '$namespaceSha256', value: namespace.sha256 },
    { key: '$namespaceCount', value: String(namespace.count) },
  ]);
  await wrapper.attach('$snapshot', snapshot);
  await wrapper.attach('$warningContent', warnings);
  await input.catalog.publish(identityEvidenceAliasId(input.proof.sha256), wrapper);
  const alias = exactIdentityScopeAlias(input.catalog, scope, input.proof);
  if (!alias) refuse();
  withIntakeWork(input.db, 'warm', () => recordIntakeWork('identitySnapshotAliasesWritten'));
  return alias;
}
