import { intakeIdentityRequestLifetime } from './intake-identity-request.ts';
import {
  assertClinicalOperation,
  currentClinicalOperation,
  runExclusiveClinicalOperation,
} from './clinical-operation.ts';
import { measureImportPhase } from './import-diagnostics.ts';
import { intakeSourceRoute } from './intake-source-routes.ts';
import { listSourceAttentionRead } from './intake-source-text.ts';
import {
  acceptIntakeReportSelectionAsync,
  getIntakeReportAcceptanceRead,
} from './intake-report-acceptance.ts';
import { HttpError } from './database.ts';
import * as intake from './intake.ts';
import {
  listIntakeReportQueueRead,
  getIntakeReportQueueGroupRead,
  listIntakeImportFeedRead,
  getIntakePeopleQueueRead,
} from './intake-queue-native.ts';
import { intakeLimits } from './intake-files.ts';
import {
  getIntakeIdentityReview,
  getIntakeIdentityScope,
  confirmIntakeIdentityScope,
} from './intake-identity.ts';
import { getIntakeRelatedRecordsRead } from './intake-clinical-record-sections.ts';
import { applyIntakePersonRead, saveIntakePersonDispositionRead } from './intake-people-native.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { createAssistant } from './assistant.ts';
import type { IntakeMetadataFragmentReference } from '../shared/intake-package-paging.ts';
import { intakeFilenameDisplay, isIntakeSummary } from '../shared/intake-summary.ts';
import { saveIntakeDraftRepairRead } from './intake-draft-repair-native.ts';

type UnknownRecord = Record<string, unknown>;
interface IntakeRouteContext {
  resource?: string;
  id?: string;
  action?: string;
  method: string;
  params: URLSearchParams;
  req: IncomingMessage;
  res?: ServerResponse;
  db: DatabaseSync;
  root: string;
  profileId: string;
  respond: (data: unknown, options?: UnknownRecord, status?: number) => void;
  list: (result: { data: unknown; [key: string]: unknown }) => void;
  body: (req: IncomingMessage, max?: number) => Promise<Buffer>;
  assistant: ReturnType<typeof createAssistant>;
  intakeBatches?: import('./intake-batches.ts').IntakeBatchManager;
}

function selectedPageSource(db: DatabaseSync, profileId: string, id: string) {
  intake.assertIntakeOwner(db, profileId);
  const source = db
    .prepare(
      "SELECT id,kind,sha256,details_json FROM source_files WHERE id=? AND kind='intake_original'",
    )
    .get(id) as { id: string; kind: string; sha256: string; details_json: string } | undefined;
  if (!source) throw new HttpError(404, 'NOT_FOUND', 'Source intake not found');
  return source;
}
function pageInteger(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new HttpError(400, 'PACKAGE_WINDOW', 'Use a bounded nonnegative integer');
  return Number(value);
}

export async function handleIntakeRoute({
  resource,
  id,
  action,
  method,
  params,
  req,
  res,
  db,
  root,
  profileId,
  respond,
  list,
  body,
  assistant,
  intakeBatches,
}: IntakeRouteContext): Promise<boolean> {
  if (resource !== 'intakes') return false;
  if (
    (method === 'GET' || method === 'POST') &&
    id &&
    db.prepare("SELECT 1 FROM source_files WHERE id=? AND kind='intake_original'").get(id)
  ) {
    const lifetime = intakeIdentityRequestLifetime(req, res);
    try {
      await intake.prepareIntakeReadFilenames(
        db,
        profileId,
        { id },
        {
          assertRunning: () => lifetime.signal.throwIfAborted(),
        },
      );
      lifetime.signal.throwIfAborted();
    } finally {
      lifetime.dispose();
    }
  }
  if (
    method === 'GET' &&
    id &&
    action &&
    [
      'source-text',
      'source-issues',
      'source-passage',
      'source-preview',
      'source-history',
      'source-search',
      'source-annotation',
    ].includes(action)
  )
    respond(await intakeSourceRoute({ db, root, profileId, id, action, params }));
  else if (method === 'GET' && id === 'report-acceptance' && action)
    respond(await getIntakeReportAcceptanceRead(db, root, profileId, action));
  else if (method === 'GET' && id === 'people' && action)
    respond(
      await getIntakePeopleQueueRead(db, root, profileId, action, {
        limit: params.get('limit'),
        view: params.get('view'),
        cursor: params.get('cursor'),
        intakeId: params.get('intakeId') || undefined,
        bytes: params.get('bytes'),
        personId: params.get('personId') || undefined,
        q: params.get('q') || undefined,
      }),
    );
  else if (method === 'GET' && id === 'import-feed' && !action)
    respond(
      await listIntakeImportFeedRead(db, root, profileId, {
        view: params.get('view') || undefined,
        limit: params.get('limit'),
        cursor: params.get('cursor'),
        bytes: params.get('bytes'),
        q: params.get('q'),
        state: params.get('state'),
        kind: params.get('kind'),
        edited: params.get('edited'),
        peopleCursor: params.get('peopleCursor'),
        groupId: params.get('groupId'),
        intakeId: params.get('intakeId'),
        recordId: params.get('recordId'),
      }),
    );
  else if (method === 'GET' && id === 'report-queue') {
    const window = {
      view: params.get('view') || undefined,
      limit: params.get('limit'),
      cursor: params.get('cursor'),
      bytes: params.get('bytes'),
      intakeId: params.get('intakeId'),
      peopleCursor: params.get('peopleCursor'),
      personId: params.get('personId') || undefined,
    };
    const lifetime = intakeIdentityRequestLifetime(req, res);
    try {
      const result = action
        ? await getIntakeReportQueueGroupRead(db, root, profileId, action, window, {
            signal: lifetime.signal,
          })
        : await listIntakeReportQueueRead(db, root, profileId, window, {
            signal: lifetime.signal,
          });
      lifetime.signal.throwIfAborted();
      respond(result);
    } finally {
      lifetime.dispose();
    }
  } else if (method === 'GET' && id === 'source-attention' && !action)
    respond(await listSourceAttentionRead(db, profileId, Number(params.get('offset') || 0)));
  else if (method === 'GET' && id === 'limits') respond(intakeLimits());
  else if (method === 'GET' && !id) {
    const options = {
      offset: params.get('offset') as unknown as number,
      limit: params.get('limit') as unknown as number,
      visibility: params.get('visibility') || undefined,
      rootOnly: params.get('rootOnly') === 'true',
    };
    const lifetime = intakeIdentityRequestLifetime(req, res);
    try {
      await intake.prepareIntakeReadFilenames(
        db,
        profileId,
        { list: options },
        {
          assertRunning: () => lifetime.signal.throwIfAborted(),
        },
      );
      lifetime.signal.throwIfAborted();
    } finally {
      lifetime.dispose();
    }
    list(intake.listIntakeReads(db, profileId, options, root));
  } else if (method === 'GET' && id && action === 'package-failures') {
    const { collectionIntakePackageFailures } = await import('./intake-summary.ts');
    respond(
      collectionIntakePackageFailures(db, selectedPageSource(db, profileId, id), {
        cursor: params.get('cursor') ?? undefined,
        limit: pageInteger(params.get('limit')),
      }),
    );
  } else if (method === 'GET' && id && action === 'accepted-destinations') {
    const { collectionIntakeAcceptedDestinations } = await import('./intake-summary.ts');
    respond(
      collectionIntakeAcceptedDestinations(db, selectedPageSource(db, profileId, id), {
        groupId: params.get('groupId') ?? '',
        proposalId: params.get('proposalId'),
        recordIds: params.getAll('recordId'),
      }),
    );
  } else if (method === 'GET' && id && action === 'plan-unit') {
    const { collectionIntakeUnitDetail } = await import('./intake-summary.ts'),
      { readPackagePlanScope } = await import('./intake-package-plan.ts');
    respond(
      collectionIntakeUnitDetail(
        db,
        selectedPageSource(db, profileId, id),
        {
          planId: params.get('planId') ?? '',
          unitId: params.get('unitId') ?? '',
          version: pageInteger(params.get('version')) ?? -1,
        },
        (planId, unitId) => {
          const scope = readPackagePlanScope(db, root, profileId, id, {
            planId,
          });
          return scope?.planId === planId ? scope.unitById(unitId) : undefined;
        },
      ),
    );
  } else if (method === 'GET' && id && action === 'package-units') {
    const { readPackageUnitPage } = await import('./intake-package-plan.ts');
    respond(
      readPackageUnitPage(db, root, profileId, id, {
        offset: pageInteger(params.get('offset')),
        limit: pageInteger(params.get('limit')),
      }),
    );
  } else if (method === 'GET' && id && action === 'plan') {
    const selected = intake.getIntakeRead(db, root, profileId, id);
    respond(isIntakeSummary(selected) ? selected : intake.getIntakePlan(db, root, profileId, id));
  } else if (method === 'GET' && id && action === 'package') {
    const { inventoryIntakePackage, inventoryIntakePackagePaged } =
      await import('./intake-package.ts');
    const window: { offset?: number; limit?: number } = {};
    for (const key of ['offset', 'limit'] as const) {
      const value = params.get(key);
      if (value !== null) {
        if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
          throw new HttpError(
            400,
            'PACKAGE_WINDOW',
            'Package window values must be bounded nonnegative integers',
          );
        window[key] = Number(value);
      }
    }
    const lifetime = intakeIdentityRequestLifetime(req, res);
    try {
      await runExclusiveClinicalOperation(
        db,
        async (operation) => {
          const assertRunning = () => {
            assertClinicalOperation(db, operation);
            lifetime.signal.throwIfAborted();
          };
          const context = { db, root, profileId, id, ...window, assertRunning };
          assertRunning();
          let result;
          if (isIntakeSummary(intake.getIntakeRead(db, root, profileId, id))) {
            const { preparePagedPackagePlanCompatibility, readPackagePlanScope } =
              await import('./intake-package-plan.ts');
            await preparePagedPackagePlanCompatibility(db, root, profileId, id, {
              assertRunning,
            });
            result = await inventoryIntakePackagePaged(context, () =>
              readPackagePlanScope(db, root, profileId, id),
            );
          } else result = await inventoryIntakePackage(context);
          assertRunning();
          respond(result);
        },
        { operation: currentClinicalOperation(db), signal: lifetime.signal },
      );
    } finally {
      lifetime.dispose();
    }
  } else if (method === 'GET' && id && action === 'navigate') {
    const { navigateIntakeEvidence } = await import('./intake-evidence.ts');
    respond(
      await navigateIntakeEvidence({
        db,
        root,
        profileId,
        id,
        action: params.get('action') as string,
        query: params.get('query'),
        referenceId: params.get('referenceId') || undefined,
        offset: pageInteger(params.get('offset')),
        navigationCursor: params.get('cursor') ?? undefined,
        pagedContext: isIntakeSummary(intake.getIntakeRead(db, root, profileId, id)),
      }),
    );
  } else if (method === 'GET' && id && action === 'unit') {
    const { readIntakeUnitRead } = await import('./intake-unit-read.ts');
    respond(
      await readIntakeUnitRead(db, root, profileId, id, params.get('unitId') as string, {
        offset: params.get('offset') as unknown as number,
      }),
    );
  } else if (method === 'GET' && id && action === 'identity-scope-page') {
    const { readNativeIdentityScopePage } = await import('./intake-identity-native.ts');
    respond(
      await readNativeIdentityScopePage(db, root, profileId, id, params.get('groupId') || '', {
        scopeToken: params.get('scopeToken') || '',
        snapshotId: params.get('snapshotId') || undefined,
        section: params.get('section') || '',
        cursor: params.get('cursor') || undefined,
        limit: pageInteger(params.get('limit')),
      }),
    );
  } else if (method === 'GET' && id && action === 'identity-scope-fragment') {
    const { readNativeIdentityScopeFragment } = await import('./intake-identity-native.ts');
    const lifetime = intakeIdentityRequestLifetime(req, res);
    try {
      respond(
        await readNativeIdentityScopeFragment(
          db,
          root,
          profileId,
          id,
          params.get('groupId') || '',
          {
            scopeToken: params.get('scopeToken') || '',
            snapshotId: params.get('snapshotId') || undefined,
            section: params.get('section') || '',
            ordinal: pageInteger(params.get('ordinal')) ?? -1,
            offset: pageInteger(params.get('offset')),
            cursor: params.has('cursor') ? params.get('cursor')! : undefined,
          },
          { signal: lifetime.signal },
        ),
      );
    } finally {
      lifetime.dispose();
    }
  } else if (method === 'GET' && id && action === 'identity-scope')
    respond(await getIntakeIdentityScope(db, root, profileId, id, params.get('groupId') || ''));
  else if (method === 'GET' && id && action === 'identity-review') {
    const lifetime = intakeIdentityRequestLifetime(req, res);
    try {
      respond(
        await getIntakeIdentityReview(db, root, profileId, id, params.get('groupId') || '', {
          signal: lifetime.signal,
        }),
      );
    } finally {
      lifetime.dispose();
    }
  } else if (method === 'GET' && id && action === 'report-source-review')
    respond(
      await intake.getIntakeReportSourceReviewRead(
        db,
        root,
        profileId,
        id,
        params.get('groupId') || '',
        params.get('view') || 'all',
        {
          cursor: params.get('cursor') || undefined,
          sourceCursor: params.get('sourceCursor') || undefined,
          evidenceCursor: params.get('evidenceCursor') || undefined,
          limit: pageInteger(params.get('limit')),
        },
      ),
    );
  else if (method === 'GET' && id && action === 'review-record')
    respond(
      await intake.readIntakeReviewRecord(db, root, profileId, id, {
        proposalId: params.get('proposalId') || null,
        recordId: params.get('recordId') || '',
        candidateVersionId: params.get('candidateVersionId') || undefined,
        bytes: pageInteger(params.get('bytes')),
      }),
    );
  else if (method === 'GET' && id && action === 'review')
    respond(
      await intake.reviewIntakeRead(db, root, profileId, id, params.get('proposalId') || null, {
        section: (params.get('section') || 'records') as
          'records' | 'sourceContext' | 'coverageGaps',
        cursor: params.get('cursor') || undefined,
        items: pageInteger(params.get('limit')),
        bytes: pageInteger(params.get('bytes')),
      }),
    );
  else if (method === 'GET' && id && action === 'read') {
    const selected = intake.getIntakeRead(db, root, profileId, id);
    respond({
      intake: selected,
      ...intake.readIntakeLiteralWindow(db, root, profileId, id, {
        offset: params.get('offset') as unknown as number,
        limit: params.get('limit') as unknown as number,
      }),
    });
  } else if (method === 'GET' && id && !action)
    respond(intake.getIntakeRead(db, root, profileId, id));
  else if (method === 'POST' && !id) {
    let filename, providerId, newProviderName;
    try {
      filename = decodeURIComponent((req.headers['x-filename'] || 'original') as string);
      providerId = decodeURIComponent((req.headers['x-source-id'] || '') as string);
      newProviderName = decodeURIComponent((req.headers['x-source-name'] || '') as string);
    } catch {
      throw new HttpError(400, 'INVALID_INPUT', 'Invalid upload header encoding');
    }
    const retained = await intake.uploadIntakeStream(
      db,
      root,
      profileId,
      {
        filename,
        providerId,
        newProviderName,
        mimeType: req.headers['content-type'],
      },
      req,
    );
    try {
      intakeBatches?.wake(profileId);
    } catch (error) {
      // The original and enqueue intent are already durable. A later wake
      // reconciles the intent; this upload must still be acknowledged.
      console.error('Intake enqueue wake failed after retention', error);
    }
    respond(retained, {}, 201);
  } else if (method === 'POST') {
    if ((req.headers['content-type'] || '').split(';')[0] !== 'application/json')
      throw new HttpError(415, 'CONTENT_TYPE', 'Use application/json');
    let input: UnknownRecord;
    try {
      input = JSON.parse((await body(req, 32 * 1024 * 1024)).toString('utf8')) as UnknownRecord;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'INVALID_JSON', 'Expected a JSON object');
    }
    if (id && action && ['source-text', 'source-extract', 'source-records'].includes(action))
      respond(
        await intakeSourceRoute({
          db,
          root,
          profileId,
          id,
          action,
          params,
          input,
        }),
      );
    else if (id === 'report-acceptance' && !action)
      respond(await acceptIntakeReportSelectionAsync(db, root, profileId, input));
    else if (id === 'people-disposition' && !action)
      respond(
        await saveIntakePersonDispositionRead(
          db,
          root,
          profileId,
          input as unknown as Parameters<typeof saveIntakePersonDispositionRead>[3],
        ),
      );
    else if (id === 'people-apply' && !action)
      respond(
        await applyIntakePersonRead(
          db,
          root,
          profileId,
          input as unknown as Parameters<typeof applyIntakePersonRead>[3],
        ),
      );
    else if (id === 'flush' && !action) respond(intake.flushIntake(db, root, profileId));
    else if (id && action === 'people-fragment') {
      const { prepareCollectionPeopleIndex, readCollectionPersonFragment } =
        await import('./intake-people-collection.ts');
      const reference = input.reference as Parameters<typeof readCollectionPersonFragment>[3];
      selectedPageSource(db, profileId, id);
      if (
        !reference ||
        reference.format !== 'health-intake-person-reference-v2' ||
        reference.intakeId !== id
      )
        throw new HttpError(
          400,
          'INTAKE_PERSON_REFERENCE',
          'Select People evidence from this intake',
        );
      await prepareCollectionPeopleIndex(db, root, profileId, id);
      respond(
        readCollectionPersonFragment(
          db,
          root,
          profileId,
          reference,
          (input.offset ?? 0) as number,
          (input.bytes ?? 32768) as number,
        ),
      );
    } else if (
      id &&
      ['review-record-section', 'review-record-section-fragment', 'review-record-action'].includes(
        action || '',
      )
    ) {
      const {
        readClinicalRecordSection,
        readClinicalRecordSectionFragment,
        applyClinicalRecordAction,
      } = await import('./intake-clinical-record-sections.ts');
      respond(
        action === 'review-record-section'
          ? await readClinicalRecordSection(
              db,
              root,
              profileId,
              id,
              input as unknown as Parameters<typeof readClinicalRecordSection>[4],
            )
          : action === 'review-record-section-fragment'
            ? await readClinicalRecordSectionFragment(
                db,
                root,
                profileId,
                id,
                input as unknown as Parameters<typeof readClinicalRecordSectionFragment>[4],
              )
            : await applyClinicalRecordAction(
                db,
                root,
                profileId,
                id,
                input as unknown as Parameters<typeof applyClinicalRecordAction>[4],
              ),
      );
    } else if (id && action === 'collection-fragment') {
      const { readIntakeCollectionEvidenceFragment } =
        await import('./intake-evidence-fragment.ts');
      respond(
        await readIntakeCollectionEvidenceFragment(
          db,
          root,
          profileId,
          id,
          input as unknown as Parameters<typeof readIntakeCollectionEvidenceFragment>[4],
        ),
      );
    } else if (id && (action === 'review-history' || action === 'review-history-fragment')) {
      const { readReviewDraftHistoryPage, readReviewDraftHistoryFragment } =
        await import('./intake-review-draft-state.ts');
      const source = selectedPageSource(db, profileId, id);
      const reference = input.reference as Parameters<typeof readReviewDraftHistoryPage>[2];
      if (
        !reference ||
        ![
          'health-intake-review-draft-history-v1',
          'health-intake-review-draft-legacy-history-v1',
        ].includes(reference.format)
      )
        throw new HttpError(400, 'REVIEW_HISTORY_REFERENCE', 'Select saved review history');
      if (
        action === 'review-history-fragment' &&
        reference.format === 'health-intake-review-draft-legacy-history-v1'
      ) {
        const { readLegacyDraftHistoryFragment } = await import('./intake-draft-history-legacy.ts');
        respond(
          await readLegacyDraftHistoryFragment(
            db,
            root,
            profileId,
            source,
            reference,
            input as unknown as Parameters<typeof readLegacyDraftHistoryFragment>[5],
          ),
        );
        return true;
      }
      respond(
        action === 'review-history'
          ? readReviewDraftHistoryPage(
              db,
              source,
              reference,
              input as unknown as Parameters<typeof readReviewDraftHistoryPage>[3],
            )
          : readReviewDraftHistoryFragment(
              db,
              source,
              reference as import('../shared/intake.ts').IntakeNativeReviewDraftHistory,
              input as unknown as Parameters<typeof readReviewDraftHistoryFragment>[3],
            ),
      );
    } else if (id && action === 'report-source-fragment')
      respond(
        await intake.readIntakeReportSourceFragment(
          db,
          profileId,
          id,
          input as unknown as Parameters<typeof intake.readIntakeReportSourceFragment>[3],
        ),
      );
    else if (id && action === 'review-fragment')
      respond(
        await intake.readIntakeReviewFragment(
          db,
          root,
          profileId,
          id,
          input as unknown as Parameters<typeof intake.readIntakeReviewFragment>[4],
        ),
      );
    else if (id && action === 'related-records')
      respond(
        await getIntakeRelatedRecordsRead(
          db,
          root,
          profileId,
          id,
          input as unknown as Parameters<typeof getIntakeRelatedRecordsRead>[4],
        ),
      );
    else if (action === 'questions')
      respond(
        await intake.askIntakeQuestionRead(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.askIntakeQuestionRead>[4],
        ),
      );
    else if (action === 'answers')
      respond(
        await intake.answerIntakeQuestionRead(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.answerIntakeQuestionRead>[4],
        ),
      );
    else if (action === 'metadata')
      respond(
        await intake.updateIntakeMetadataRead(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.updateIntakeMetadataRead>[4],
        ),
      );
    else if (action === 'report-source')
      respond(
        await intake.confirmIntakeReportSourceRead(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.confirmIntakeReportSourceRead>[4],
        ),
      );
    else if (action === 'identity-scope')
      respond(
        await confirmIntakeIdentityScope(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof confirmIntakeIdentityScope>[4],
        ),
      );
    else if (action === 'review-draft')
      respond(
        await intake.saveIntakeReviewDraftRead(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.saveIntakeReviewDraftRead>[4],
        ),
      );
    else if (action === 'draft-repair')
      respond(
        await saveIntakeDraftRepairRead(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof saveIntakeDraftRepairRead>[4],
        ),
      );
    else if (action === 'plan')
      respond(
        await intake.createIntakePlanRead(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.createIntakePlanRead>[4],
        ),
      );
    else if (id && action === 'direct-unit-metadata') {
      const { readDirectUnitMetadataFragment } = await import('./intake-direct-plan.ts');
      respond(
        readDirectUnitMetadataFragment(
          db,
          profileId,
          id,
          input.reference as Parameters<typeof readDirectUnitMetadataFragment>[3],
          {
            section: input.section as 'sharedHeadings' | 'sourceIndex',
            cursor: input.cursor as string | undefined,
            bytes: input.bytes as number | undefined,
          },
        ),
      );
    } else if (id && action === 'filename-fragment') {
      const { collectionIntakeFilenameFragment } = await import('./intake-summary.ts');
      respond(
        collectionIntakeFilenameFragment(
          db,
          selectedPageSource(db, profileId, id),
          input as unknown as Parameters<typeof collectionIntakeFilenameFragment>[2],
        ),
      );
    } else if (id && action === 'package-failure-fragment') {
      const { collectionIntakePackageFailureFieldFragment } = await import('./intake-summary.ts');
      respond(
        collectionIntakePackageFailureFieldFragment(
          db,
          selectedPageSource(db, profileId, id),
          input as unknown as Parameters<typeof collectionIntakePackageFailureFieldFragment>[2],
        ),
      );
    } else if (id && action === 'package-metadata') {
      const lifetime = intakeIdentityRequestLifetime(req, res);
      try {
        await runExclusiveClinicalOperation(
          db,
          async (operation) => {
            const assertRunning = () => {
              assertClinicalOperation(db, operation);
              lifetime.signal.throwIfAborted();
            };
            assertRunning();

            selectedPageSource(db, profileId, id);
            const reference = input.reference as IntakeMetadataFragmentReference;
            if (
              !reference ||
              typeof reference !== 'object' ||
              !['package_member', 'package_unit'].includes(reference.kind)
            )
              throw new HttpError(
                400,
                'PACKAGE_METADATA_REFERENCE',
                'Use a metadata reference from the current package page',
              );
            const { readPackagePlanScope, readPackageUnitMetadataFragment } =
              await import('./intake-package-plan.ts');
            if (reference.kind === 'package_unit')
              respond(
                readPackageUnitMetadataFragment(db, root, profileId, id, reference, {
                  offset: input.offset as number | undefined,
                  limit: input.limit as number | undefined,
                }),
              );
            else {
              const { readIntakePackageMetadataFragment } = await import('./intake-package.ts');
              respond(
                await readIntakePackageMetadataFragment(
                  {
                    db,
                    root,
                    profileId,
                    id,
                    assertRunning,
                    signal: lifetime.signal,
                    offset: input.offset as number | undefined,
                    limit: input.limit as number | undefined,
                  },
                  reference,
                  readPackagePlanScope(db, root, profileId, id),
                ),
              );
            }

            assertRunning();
          },
          { operation: currentClinicalOperation(db), signal: lifetime.signal },
        );
      } finally {
        lifetime.dispose();
      }
    } else if (action === 'package-member') {
      const lifetime = intakeIdentityRequestLifetime(req, res);
      try {
        const { readIntakePackageMember, readIntakePackageMemberPaged } =
          await import('./intake-package.ts');
        const context = {
          ...input,
          db,
          root,
          profileId,
          id: id!,
          modelContext: false,
          signal: lifetime.signal,
          assertRunning: () => lifetime.signal.throwIfAborted(),
        } as Parameters<typeof readIntakePackageMember>[0];
        const native = isIntakeSummary(intake.getIntakeRead(db, root, profileId, id!));
        const { preparePagedPackagePlanCompatibility, readPackagePlanScope } =
          await import('./intake-package-plan.ts');
        if (native)
          await runExclusiveClinicalOperation(
            db,
            async (operation) => {
              const assertRunning = () => {
                assertClinicalOperation(db, operation);
                lifetime.signal.throwIfAborted();
              };
              await preparePagedPackagePlanCompatibility(db, root, profileId, id!, {
                assertRunning,
              });
            },
            {
              operation: currentClinicalOperation(db),
              signal: lifetime.signal,
            },
          );
        const result = await measureImportPhase(
          'package_member_read',
          () =>
            native
              ? readIntakePackageMemberPaged(
                  context,
                  readPackagePlanScope(db, root, profileId, id!),
                )
              : readIntakePackageMember(context),
          {},
          { profileId, importId: id! },
        );
        lifetime.signal.throwIfAborted();
        respond(result);
      } finally {
        lifetime.dispose();
      }
    } else if (action === 'package-roles') {
      const lifetime = intakeIdentityRequestLifetime(req, res);
      try {
        const { saveIntakePackageRolesRead } = await import('./intake-package-plan.ts');
        lifetime.signal.throwIfAborted();
        const result = await saveIntakePackageRolesRead(db, root, profileId, id!, {
          ...(input as unknown as Parameters<typeof saveIntakePackageRolesRead>[4]),
          assertRunning: () => lifetime.signal.throwIfAborted(),
        });
        lifetime.signal.throwIfAborted();
        respond(result);
      } finally {
        lifetime.dispose();
      }
    } else if (action === 'batch')
      respond(
        await intake.submitIntakeBatchRead(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.submitIntakeBatchRead>[4],
        ),
      );
    else if (action === 'convert') {
      const current = intake.getIntakeRead(db, root, profileId, id!);
      if (current.version !== input.version)
        throw new HttpError(409, 'VERSION_CONFLICT', 'Reload this delivery before converting');
      if (assistant.isBusy(profileId))
        throw new HttpError(
          409,
          'ASSISTANT_BUSY',
          'A conversion or response is already running for this profile',
        );
      await assistant.ensureConnection?.(
        {
          image: current.mimeType.startsWith('image/'),
          pdf: current.mimeType === 'application/pdf',
        },
        profileId,
      );
      if (intake.getIntakeRead(db, root, profileId, id!).version !== input.version)
        throw new HttpError(409, 'VERSION_CONFLICT', 'Reload this delivery before converting');
      if (assistant.isBusy(profileId))
        throw new HttpError(
          409,
          'ASSISTANT_BUSY',
          'A conversion or response is already running for this profile',
        );
      let chat;
      const conversionChatId = intake.intakeConversionChatId(db, profileId, id!);
      if (conversionChatId) {
        try {
          chat = assistant.get(profileId, conversionChatId);
        } catch (error) {
          if ((error as { code?: string }).code !== 'CHAT_NOT_FOUND') throw error;
        }
      }
      const filename = intakeFilenameDisplay(current);
      chat ||= assistant.create(profileId, { title: `Convert ${filename}` });
      await intake.linkIntakeConversionRead(db, root, profileId, id!, chat.id);
      assistant.send(profileId, chat.id, {
        message: `Convert the selected delivery ${filename} (${id}) from ${current.provider} into a reviewable health-record-v1 proposal. Read all its pages or members using host tools, including selected-page PDFs or rendered page images and extracted embedded files where present. Use the original page references in metadata; each supplied PDF contains only its selected original page. Preserve originals, exact values, subject identity, locators and uncertainty. Propose separate clinical mappings for observed labs, medications, procedures and documents. Do not accept/import. Report any unreviewed pages/assets as coverage gaps.`,
        context: {
          route: `/import?intake=${encodeURIComponent(id!)}`,
          intakeId: id!,
        },
      });
      respond({ chatId: chat.id });
    } else if (action === 'proposals')
      respond(
        await intake.proposeConversionRead(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.proposeConversionRead>[4],
        ),
      );
    else if (action === 'import')
      respond(
        await intake.importIntakeRead(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.importIntakeRead>[4],
        ),
      );
    else throw new HttpError(404, 'NOT_FOUND', 'Intake action not found');
  } else throw new HttpError(404, 'NOT_FOUND', 'Intake resource not found');
  return true;
}
