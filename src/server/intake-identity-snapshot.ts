/** Exact retained identity scope collections share the existing report snapshot authority. */
import type {
  IntakeIdentityScopeReference,
  IntakeIdentityScopeSection,
  IntakeIdentityScope,
} from '../shared/intake-identity.ts';
import type {
  IdentityPolicyMember,
  IdentityPolicyTargets,
  IdentityPolicyTarget,
  IdentityPolicyReceipt,
} from './intake-identity-policy.ts';
import type {
  ReportSnapshotCatalog,
  ReportSnapshotMapReader,
} from './intake-report-snapshot-catalog.ts';
import { selectedSequence } from './intake-selected-sequence.ts';
import { schemaOrdinal } from './intake-envelope-schema.ts';
import { createHash } from 'node:crypto';
import { canonicalLiteral } from './intake-format.ts';
import { HttpError } from './database.ts';
export const IDENTITY_SNAPSHOT_FORMAT = 'health-intake-identity-snapshot-v1';
export function readIdentitySnapshotValue<T>(
  reader: ReportSnapshotMapReader,
  key: string,
  bytes = 256 * 1024,
): T {
  const chunks: string[] = [];
  let used = 0;
  for (const piece of reader.chunks(key)) {
    used += Buffer.byteLength(piece);
    if (used > bytes)
      throw new HttpError(
        409,
        'IDENTITY_SCOPE_FRAGMENT',
        'Read this exact identity item through bounded fragments',
      );
    chunks.push(piece);
  }
  if (!chunks.length) throw Error('Missing retained identity item');
  return JSON.parse(chunks.join('')) as T;
}
export function openIdentityScopeSnapshot(
  catalog: ReportSnapshotCatalog,
  scope: IntakeIdentityScopeReference,
) {
  if (
    scope.format !== 'health-intake-identity-scope-v2' ||
    scope.collection.snapshotId !== 'identity:' + scope.scopeToken
  )
    throw new HttpError(409, 'IDENTITY_SCOPE', 'The identity scope reference changed');
  const reader = catalog.open(scope.collection.snapshotId);
  if (
    !reader ||
    reader.get('$format') !== IDENTITY_SNAPSHOT_FORMAT ||
    reader.get('$scope') !== JSON.stringify(scope)
  )
    throw new HttpError(
      409,
      'IDENTITY_SCOPE',
      'The retained identity scope is unavailable or changed',
    );
  return reader;
}
export function identityScopePolicyCollections(
  catalog: ReportSnapshotCatalog,
  reference: IntakeIdentityScopeReference,
) {
  const reader = openIdentityScopeSnapshot(catalog, reference);
  const sequence = <T>(section: Exclude<IntakeIdentityScopeSection, 'warnings'>) =>
    Object.defineProperty(
      selectedSequence(function* () {
        for (let index = 0; index < reference.collection[section]; index++)
          yield readIdentitySnapshotValue<T>(reader, section + ':' + schemaOrdinal(index));
      }),
      'length',
      { value: reference.collection[section] },
    );
  const targets = (section: 'targets' | 'assignmentTargets') =>
    Object.defineProperty(
      selectedSequence(function* () {
        for (let index = 0; index < reference.collection[section]; index++) {
          const key = section + ':' + schemaOrdinal(index),
            header = readIdentitySnapshotValue<
              IdentityPolicyTarget & { hasIssueIds: boolean; issueCount: number }
            >(reader, 'targetHeader:' + key);
          const { hasIssueIds, issueCount, ...target } = header;
          if (hasIssueIds)
            target.issueIds = selectedSequence(function* () {
              for (let i = 0; i < issueCount; i++)
                yield readIdentitySnapshotValue<string>(
                  reader,
                  'targetIssue:' + key + ':' + schemaOrdinal(i),
                );
            });
          yield target;
        }
      }),
      'length',
      { value: reference.collection[section] },
    );
  return {
    targets: targets('targets') as IdentityPolicyTargets,
    assignmentTargets: targets('assignmentTargets') as IdentityPolicyTargets,
    questions: Object.defineProperty(
      selectedSequence(function* () {
        for (let index = 0; index < reference.collection.questions; index++) {
          const digest = reader.get('questionHash:' + schemaOrdinal(index));
          if (!digest) throw Error('Missing retained identity question proof');
          yield {
            matches(question: NonNullable<IntakeIdentityScope['questions']>[number]) {
              return (
                createHash('sha256').update(canonicalLiteral(question)).digest('hex') === digest
              );
            },
          };
        }
      }),
      'length',
      { value: reference.collection.questions },
    ),
    competingSubjects:
      sequence<NonNullable<IntakeIdentityScope['competingSubjects']>[number]>('competingSubjects'),
    membership: selectedSequence(function* () {
      for (let index = 0; index < reference.collection.membership; index++) {
        const key = schemaOrdinal(index),
          header = readIdentitySnapshotValue<
            Omit<IdentityPolicyMember, 'occurrences'> & { occurrenceCount: number }
          >(reader, 'member:' + key);
        const { occurrenceCount, ...member } = header;
        yield {
          ...member,
          occurrences: selectedSequence(function* () {
            for (let ordinal = 0; ordinal < occurrenceCount; ordinal++)
              yield readIdentitySnapshotValue<
                IntakeIdentityScope['membership'][number]['occurrences'][number]
              >(reader, 'occurrence:' + key + ':' + schemaOrdinal(ordinal));
          }),
        };
      }
    }),
  };
}
export function nativeIdentityPolicyScope(
  catalog: ReportSnapshotCatalog,
  reference: IntakeIdentityScopeReference,
): IdentityPolicyReceipt['scope'] {
  const { format: _format, collection: _collection, ...header } = reference;
  const collections = identityScopePolicyCollections(catalog, reference);
  return { ...header, ...collections } as unknown as IdentityPolicyReceipt['scope'];
}
