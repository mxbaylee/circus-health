import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { IntakeIdentityReview } from '../shared/intake-identity.ts';
import type { Evidence, Medication, Observation, Procedure } from '../shared/api.ts';
import type {
  IntakeImportFeed,
  IntakeReportAcceptanceReceipt,
  IntakeReportAcceptanceResult,
  IntakeClinicalMapping,
  IntakeImportFeedBlock,
  IntakeReportAcceptanceRequest,
} from '../shared/intake.ts';
import {
  gradeProviderQualification,
  answersForQualification,
  qualificationPerson,
  qualificationBirthDate,
  type QualificationRecord,
  type QualificationScenario,
} from './provider-qualification-fixture.ts';
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}

const patientName = (value: string | null | undefined) => value?.replace(/\s+/g, ' ').trim();

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
/** Read the public accepted projections as well as retained mapping metadata.
 * Never synthesize a clinical value from the expected-answer table. */
export function acceptedQualificationRecord(
  kind: 'observation' | 'medication' | 'procedure',
  record: Observation | Medication | Procedure,
): QualificationRecord {
  const retained = object(object(record.extra).import).acceptedMapping;
  const mapping: IntakeClinicalMapping = { ...object(retained) };
  if (kind === 'observation') {
    const value = record as Observation;
    Object.assign(mapping, {
      testLabel: value.label,
      date: value.date ?? '',
      valueText: value.valueText,
      unit: value.unit ?? '',
      referenceText: object(value.reference).text ?? '',
      status: value.status ?? '',
    });
  } else if (kind === 'medication') {
    const value = record as Medication;
    Object.assign(mapping, {
      medicationName: value.label,
      medicationKind: value.kind,
      status: value.status ?? '',
      date: value.sourceRecordedDate ?? '',
      doseText: value.doseText ?? '',
      route: value.route ?? '',
      frequency: value.frequency ?? '',
      startDate: value.startAt ?? '',
      endDate: value.endAt ?? '',
    });
  } else {
    const value = record as Procedure;
    Object.assign(mapping, {
      procedureLabel: value.label,
      procedureCategory: value.category,
      date: value.date ?? '',
      status: value.status ?? '',
    });
  }
  return {
    id: record.id,
    kind,
    mapping,
    ...(kind === 'observation'
      ? {
          observationProjection: {
            value: (record as Observation).value,
            comparator: (record as Observation).comparator,
            datePrecision: (record as Observation).datePrecision,
          },
        }
      : {}),
    evidence: (record.evidence ?? []).map((item: Evidence) => {
      const locator = object(item.locator);
      return {
        label: 'Original source',
        locator: typeof locator.locator === 'string' ? locator.locator : '',
        ...(typeof locator.originalSourceFileId === 'string'
          ? {
              contentUrl: `/api/sources/${encodeURIComponent(locator.originalSourceFileId)}/content`,
            }
          : {}),
      };
    }),
  };
}

/** Feed pages can repeat a proposal block across report groups. Consolidate exact
 * versions, preserve their tokens, and bound one explicitly selected transaction. */
export function qualificationAcceptanceRequest(
  blocks: readonly IntakeImportFeedBlock[],
): IntakeReportAcceptanceRequest {
  const byProposal = new Map<string, IntakeReportAcceptanceRequest['blocks'][number]>();
  const seen = new Set<string>();
  for (const block of blocks) {
    const records = block.records.filter((record) => record.queueState !== 'accepted');
    if (!records.length) continue;
    const key = JSON.stringify([block.intakeId, block.proposalId]);
    if (!byProposal.has(key) && byProposal.size === 50) break;
    const target = byProposal.get(key) ?? {
      intakeId: block.intakeId,
      proposalId: block.proposalId,
      intakeVersion: block.intakeVersion,
      reviewToken: block.reviewToken,
      selections: [],
    };
    if (target.intakeVersion !== block.intakeVersion || target.reviewToken !== block.reviewToken)
      throw Error('Qualification review changed while paginating.');
    byProposal.set(key, target);
    for (const record of records) {
      if (!record.selectable || !record.candidateId || !record.candidateVersionId)
        throw Error(
          'Qualification acceptance requires individually resolved, selectable exact versions.',
        );
      if (seen.has(record.candidateVersionId))
        throw Error('Qualification selection contains duplicate exact versions.');
      seen.add(record.candidateVersionId);
      target.selections.push({
        recordId: record.id,
        candidateId: record.candidateId,
        candidateVersionId: record.candidateVersionId,
        mapping: {},
      });
      if (seen.size > 1000) throw Error('Qualification selection exceeds its record bound.');
    }
  }
  if (!byProposal.size) throw Error('Qualification has no pending records to select.');
  return { operationId: randomUUID(), blocks: [...byProposal.values()] };
}

export interface QualificationAcceptanceOptions {
  prefix: string;
  profileId: string;
  recovery: unknown;
  originalId: string;
  scenario: QualificationScenario;
  ownedProfiles: ReadonlySet<string>;
  dataDirectory: string;
  expectedRecords: number;
  expectedSha256: string;
  request: <T>(path: string, input?: unknown) => Promise<T>;
  collectFeed: (
    prefix: string,
  ) => Promise<{ blocks: IntakeImportFeedBlock[]; feed: IntakeImportFeed }>;
  originalHash: (prefix: string, originalId: string) => Promise<string>;
  afterAcceptedBeforeRecovery?: () => Promise<void>;
}

export async function performQualificationAcceptance({
  prefix,
  profileId,
  recovery,
  originalId,
  scenario,
  ownedProfiles,
  dataDirectory,
  expectedRecords,
  expectedSha256,
  request,
  collectFeed,
  originalHash,
  afterAcceptedBeforeRecovery,
}: QualificationAcceptanceOptions) {
  check(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(profileId) && prefix === `/api/profiles/${profileId}`,
    'Qualification profile path is invalid.',
  );
  check(
    ownedProfiles.has(profileId),
    'Acceptance must use a freshly created qualification profile.',
  );
  check(
    (await originalHash(prefix, originalId)) === expectedSha256,
    'Qualification identity review requires the unchanged independently generated original.',
  );
  let current = await collectFeed(prefix);
  check(
    gradeProviderQualification(
      current.blocks.flatMap((block) => block.records),
      originalId,
      scenario,
      'extracted',
    ).passed,
    'Qualification changed before explicit acceptance.',
  );
  // This opt-in explicitly reviews the independently generated original, whose
  // hash and sole printed patient are known. Model-proposed Self is not authority.
  // Read fresh host identity scopes and refuse conflicting or missing evidence;
  // never repair clinical fields or dismiss non-identity questions.
  const confirmedHumanGroups = new Set<string>();
  const initialBlocks = current.blocks;
  for (const block of initialBlocks) {
    check(block.intakeId === originalId, 'Qualification contains a different original.');
    for (const initialRecord of block.records) {
      const record = current.blocks
        .flatMap((candidateBlock) => candidateBlock.records)
        .find((candidate) => candidate.candidateVersionId === initialRecord.candidateVersionId);
      check(record, 'Qualification candidate disappeared during identity review.');
      const unresolved = (record.issues ?? []).filter(
        (issue) => issue.blocking && issue.status === 'unresolved',
      );
      check(
        unresolved.every((issue) => issue.kind === 'identity'),
        'Fictional acceptance encountered unresolved clinical questions; review manually.',
      );
      check(
        record.identityReview?.status !== 'conflict' && !record.identityReview?.conflicts.length,
        'Qualification contains conflicting patient identity evidence.',
      );
      if (!unresolved.length) {
        check(
          record.mapping.subject === 'self' &&
            (record.identityReview?.status === 'evidenced_match' ||
              record.identityReview?.status === 'prior_confirmation') &&
            patientName(record.identityReview.evidencedIdentity.fullName) === qualificationPerson &&
            (record.identityReview.evidencedIdentity.birthDate === qualificationBirthDate ||
              (record.identityReview.evidencedIdentity.birthDate === undefined &&
                record.reportGroups?.length === 1 &&
                confirmedHumanGroups.has(record.reportGroups[0]!.groupId))),
          'Qualification requires host-evidenced Self or an explicit scoped identity review.',
        );
        continue;
      }
      check(
        record.candidateId && record.candidateVersionId && record.reportGroups?.length === 1,
        'Qualification identity resolution requires one exact report and candidate version.',
      );
      const groupId = record.reportGroups[0]!.groupId;
      const review = await request<IntakeIdentityReview>(
        prefix + `/intakes/${originalId}/identity-review?groupId=${encodeURIComponent(groupId)}`,
      );
      const scope = review.scope;
      check(
        scope &&
          review.status !== 'conflict' &&
          !review.conflicts.length &&
          !review.selfBirthDateConflict &&
          patientName(review.self.fullName) === qualificationPerson &&
          review.self.birthDate === qualificationBirthDate &&
          patientName(review.evidencedIdentity.fullName) === qualificationPerson &&
          (review.evidencedIdentity.birthDate === qualificationBirthDate ||
            (review.evidencedIdentity.birthDate === undefined &&
              scope.verificationMode === 'human_reviewed_original' &&
              typeof scope.original?.page === 'number' &&
              Number.isInteger(scope.original.page) &&
              scope.original.page > 0)) &&
          scope.profileId === profileId &&
          scope.intakeId === originalId &&
          scope.sourceHash === expectedSha256 &&
          scope.groupId === groupId &&
          scope.targets.every((target) =>
            current.blocks.some(
              (candidateBlock) =>
                candidateBlock.intakeId === originalId &&
                candidateBlock.records.some(
                  (candidate) =>
                    candidate.candidateId === target.candidateId &&
                    candidate.candidateVersionId === target.candidateVersionId,
                ),
            ),
          ) &&
          scope.targets.some(
            (target) =>
              target.candidateId === record.candidateId &&
              target.candidateVersionId === record.candidateVersionId,
          ),
        'Qualification identity scope does not prove the exact fictional patient and original.',
      );
      await request(prefix + `/intakes/${originalId}/identity-scope`, {
        version: scope.intakeVersion,
        operationId: randomUUID(),
        scope,
        outcome: 'this_is_me',
        attestation: 'confirmed_displayed_identity_questions',
      });
      if (scope.verificationMode === 'human_reviewed_original') confirmedHumanGroups.add(groupId);
      current = await collectFeed(prefix);
    }
  }
  const accepted = new Map<
    string,
    { kind: 'observation' | 'medication' | 'procedure'; id: string }
  >();
  const requests: ReturnType<typeof qualificationAcceptanceRequest>[] = [];
  const receipts: IntakeReportAcceptanceReceipt[] = [];
  for (let transaction = 0; transaction < 20; transaction++) {
    current = await collectFeed(prefix);
    const records = current.blocks.flatMap((block) => block.records);
    check(
      gradeProviderQualification(records, originalId, scenario).passed,
      'Qualification changed during explicit acceptance.',
    );
    if (records.every((record) => record.queueState === 'accepted')) break;
    const input = qualificationAcceptanceRequest(current.blocks);
    const result = await request<IntakeReportAcceptanceResult>(
      prefix + '/intakes/report-acceptance',
      input,
    );
    const count = input.blocks.reduce((sum, block) => sum + block.selections.length, 0);
    check(
      result.receipt.status === 'accepted' &&
        result.receipt.atomic &&
        result.receipt.acceptedCount === count &&
        result.receipt.selectedCount === count,
      'Qualification acceptance count or atomic receipt mismatch.',
    );
    const replay = await request<IntakeReportAcceptanceResult>(
      prefix + '/intakes/report-acceptance',
      input,
    );
    check(
      replay.replayed && JSON.stringify(replay.receipt) === JSON.stringify(result.receipt),
      'Qualification acceptance retry was not idempotent.',
    );
    requests.push(input);
    receipts.push(result.receipt);
    for (const receipt of result.receipt.receipts)
      for (const record of receipt.records) {
        check(
          record.kind !== 'document' &&
            record.outcome === 'added' &&
            !accepted.has(record.entityId),
          'Qualification acceptance contained an unexpected kind, duplicate or merge.',
        );
        accepted.set(record.entityId, { kind: record.kind, id: record.entityId });
      }
  }
  check(
    accepted.size === expectedRecords,
    'Qualification did not accept exactly the independently expected records.',
  );
  const paths = {
    observation: 'tests',
    medication: 'medications',
    procedure: 'procedures',
  } as const;
  async function acceptedSnapshot() {
    const results: Array<{
      kind: 'observation' | 'medication' | 'procedure';
      record: Observation | Medication | Procedure;
    }> = [];
    for (const item of [...accepted.values()].sort((a, b) => a.id.localeCompare(b.id)))
      results.push({
        kind: item.kind,
        record: await request<Observation | Medication | Procedure>(
          prefix + `/${paths[item.kind]}/${encodeURIComponent(item.id)}`,
        ),
      });
    const feed = await collectFeed(prefix);
    check(
      feed.blocks
        .flatMap((block) => block.records)
        .every((record) => record.queueState === 'accepted'),
      'Qualification retains unaccepted records.',
    );
    return {
      results,
      grade: gradeProviderQualification(
        results.map(({ kind, record }) => acceptedQualificationRecord(kind, record)),
        originalId,
        scenario,
      ),
    };
  }
  async function checkClinicalCounts() {
    const overview = await request<{
      counts: { observations: number; medications: number; procedures: number };
    }>(prefix + '/overview');
    const answers = answersForQualification(scenario);
    for (const [kind, collection] of [
      ['observation', 'observations'],
      ['medication', 'medications'],
      ['procedure', 'procedures'],
    ] as const)
      check(
        overview.counts[collection] === answers.filter((answer) => answer.kind === kind).length,
        'Qualification accepted collection count differs from independent known answers.',
      );
  }
  await checkClinicalCounts();
  const before = await acceptedSnapshot();
  check(
    before.grade.passed,
    'Accepted public clinical projections differ from the independent oracle.',
  );
  check(
    (await originalHash(prefix, originalId)) === expectedSha256,
    'Acceptance changed the retained original.',
  );
  await afterAcceptedBeforeRecovery?.();
  await request(prefix + '/lock', {});
  // Delete only this harness-owned disposable cache after lock. Originals,
  // manifests, accepted versions and the encrypted recovery authority survive.
  const profileDirectory = join(dataDirectory, 'profiles', profileId);
  const cacheDirectory = join(profileDirectory, 'cache');
  check(
    ownedProfiles.has(profileId) &&
      realpathSync(profileDirectory) === profileDirectory &&
      !lstatSync(profileDirectory).isSymbolicLink(),
    'Qualification cache directory escaped its owned archive.',
  );
  check(
    existsSync(cacheDirectory) &&
      realpathSync(cacheDirectory) === cacheDirectory &&
      lstatSync(cacheDirectory).isDirectory(),
    'Qualification expected a regular cache directory.',
  );
  rmSync(cacheDirectory, { recursive: true });
  check(!existsSync(cacheDirectory), 'Qualification cache deletion failed.');
  await request(prefix + '/unlock', { recovery });
  const after = await acceptedSnapshot();
  await checkClinicalCounts();
  check(
    after.grade.passed && JSON.stringify(after.results) === JSON.stringify(before.results),
    'Accepted clinical projections or provenance changed during cache-loss recovery.',
  );
  for (let index = 0; index < requests.length; index++) {
    const recovered = await request<IntakeReportAcceptanceResult>(
      prefix + `/intakes/report-acceptance/${encodeURIComponent(requests[index].operationId)}`,
    );
    check(
      JSON.stringify(recovered.receipt) === JSON.stringify(receipts[index]),
      'Accepted receipt changed during recovery.',
    );
    const replay = await request<IntakeReportAcceptanceResult>(
      prefix + '/intakes/report-acceptance',
      requests[index],
    );
    check(
      replay.replayed && JSON.stringify(replay.receipt) === JSON.stringify(receipts[index]),
      'Recovery lost idempotent acceptance.',
    );
  }
  check(
    (await originalHash(prefix, originalId)) === expectedSha256,
    'Recovery changed the retained original.',
  );
  return {
    passed: true,
    selectedRecords: accepted.size,
    receiptReplayed: true,
    recoveredWithoutCache: true,
    originalUnchanged: true,
    acceptedGrade: after.grade,
  };
}
