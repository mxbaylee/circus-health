import { measureImportPhase } from './import-diagnostics.ts';
import { intakeSourceRoute } from './intake-source-routes.ts';
import { listSourceAttention } from './intake-source-text.ts';
import {
  acceptIntakeReportSelection,
  getIntakeReportAcceptance,
} from './intake-report-acceptance.ts';
import { HttpError } from './database.ts';
import * as intake from './intake.ts';
import {
  listIntakeReportQueue,
  getIntakeReportQueueGroup,
  listIntakeImportFeed,
} from './intake-report-queue.ts';
import { intakeLimits } from './intake-files.ts';
import {
  getIntakeIdentityReview,
  getIntakeIdentityScope,
  confirmIntakeIdentityScope,
} from './intake-identity.ts';
import { getIntakeRelatedRecords } from './related-records.ts';
import {
  applyIntakePerson,
  getIntakePeopleQueue,
  saveIntakePersonDisposition,
} from './intake-people.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage } from 'node:http';
import type { createAssistant } from './assistant.ts';

type UnknownRecord = Record<string, unknown>;
interface IntakeRouteContext {
  resource?: string;
  id?: string;
  action?: string;
  method: string;
  params: URLSearchParams;
  req: IncomingMessage;
  db: DatabaseSync;
  root: string;
  profileId: string;
  respond: (data: unknown, options?: UnknownRecord, status?: number) => void;
  list: (result: { data: unknown; [key: string]: unknown }) => void;
  body: (req: IncomingMessage, max?: number) => Promise<Buffer>;
  assistant: ReturnType<typeof createAssistant>;
  intakeBatches?: import('./intake-batches.ts').IntakeBatchManager;
}

export async function handleIntakeRoute({
  resource,
  id,
  action,
  method,
  params,
  req,
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
    respond(getIntakeReportAcceptance(db, root, profileId, action));
  else if (method === 'GET' && id === 'people' && action)
    respond(
      getIntakePeopleQueue(db, root, profileId, action, {
        limit: params.get('limit'),
        cursor: params.get('cursor'),
      }),
    );
  else if (method === 'GET' && id === 'import-feed' && !action)
    respond(
      listIntakeImportFeed(db, root, profileId, {
        view: params.get('view') || undefined,
        limit: params.get('limit'),
        cursor: params.get('cursor'),
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
    };
    respond(
      action
        ? getIntakeReportQueueGroup(db, root, profileId, action, window)
        : listIntakeReportQueue(db, root, profileId, window),
    );
  } else if (method === 'GET' && id === 'source-attention' && !action)
    respond(listSourceAttention(db, profileId, Number(params.get('offset') || 0)));
  else if (method === 'GET' && id === 'limits') respond(intakeLimits());
  else if (method === 'GET' && !id)
    list(
      intake.listIntakes(
        db,
        profileId,
        {
          offset: params.get('offset') as unknown as number,
          limit: params.get('limit') as unknown as number,
          visibility: params.get('visibility') || undefined,
          rootOnly: params.get('rootOnly') === 'true',
        },
        root,
      ),
    );
  else if (method === 'GET' && id && action === 'plan')
    respond(intake.getIntakePlan(db, root, profileId, id));
  else if (method === 'GET' && id && action === 'package') {
    const { inventoryIntakePackage } = await import('./intake-package.ts');
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
    respond(await inventoryIntakePackage({ db, root, profileId, id, ...window }));
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
        offset: params.get('offset') as unknown as number,
      }),
    );
  } else if (method === 'GET' && id && action === 'unit')
    respond(
      intake.readIntakeUnit(db, root, profileId, id, params.get('unitId') as string, {
        offset: params.get('offset') as unknown as number,
      }),
    );
  else if (method === 'GET' && id && action === 'identity-scope')
    respond(await getIntakeIdentityScope(db, root, profileId, id, params.get('groupId') || ''));
  else if (method === 'GET' && id && action === 'identity-review')
    respond(await getIntakeIdentityReview(db, root, profileId, id, params.get('groupId') || ''));
  else if (method === 'GET' && id && action === 'report-source-review')
    respond(
      intake.getIntakeReportSourceReview(
        db,
        root,
        profileId,
        id,
        params.get('groupId') || '',
        params.get('view') || 'all',
      ),
    );
  else if (method === 'GET' && id && action === 'review')
    respond(intake.reviewIntake(db, root, profileId, id, params.get('proposalId') || null));
  else if (method === 'GET' && id && action === 'read')
    respond(
      intake.readIntake(db, root, profileId, id, {
        offset: params.get('offset') as unknown as number,
        limit: params.get('limit') as unknown as number,
      }),
    );
  else if (method === 'GET' && id && !action) respond(intake.getIntake(db, root, profileId, id));
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
      { filename, providerId, newProviderName, mimeType: req.headers['content-type'] },
      req,
    );
    intakeBatches?.wake(profileId);
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
      respond(await intakeSourceRoute({ db, root, profileId, id, action, params, input }));
    else if (id === 'report-acceptance' && !action)
      respond(acceptIntakeReportSelection(db, root, profileId, input));
    else if (id === 'people-disposition' && !action)
      respond(
        saveIntakePersonDisposition(
          db,
          root,
          profileId,
          input as unknown as Parameters<typeof saveIntakePersonDisposition>[3],
        ),
      );
    else if (id === 'people-apply' && !action)
      respond(
        applyIntakePerson(
          db,
          root,
          profileId,
          input as unknown as Parameters<typeof applyIntakePerson>[3],
        ),
      );
    else if (id === 'flush' && !action) respond(intake.flushIntake(db, root, profileId));
    else if (id && action === 'related-records')
      respond(
        getIntakeRelatedRecords(
          db,
          root,
          profileId,
          id,
          input as unknown as Parameters<typeof getIntakeRelatedRecords>[4],
        ),
      );
    else if (action === 'questions')
      respond(
        intake.askIntakeQuestion(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.askIntakeQuestion>[4],
        ),
      );
    else if (action === 'answers')
      respond(
        intake.answerIntakeQuestion(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.answerIntakeQuestion>[4],
        ),
      );
    else if (action === 'metadata')
      respond(
        intake.updateIntakeMetadata(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.updateIntakeMetadata>[4],
        ),
      );
    else if (action === 'report-source')
      respond(
        intake.confirmIntakeReportSource(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.confirmIntakeReportSource>[4],
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
        intake.saveIntakeReviewDraft(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.saveIntakeReviewDraft>[4],
        ),
      );
    else if (action === 'draft-repair')
      respond(
        intake.saveIntakeDraftRepair(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.saveIntakeDraftRepair>[4],
        ),
      );
    else if (action === 'plan')
      respond(
        await intake.createIntakePlan(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.createIntakePlan>[4],
        ),
      );
    else if (action === 'package-member') {
      const { readIntakePackageMember } = await import('./intake-package.ts');
      respond(
        await measureImportPhase(
          'package_member_read',
          () =>
            readIntakePackageMember({
              ...input,
              db,
              root,
              profileId,
              id: id!,
              modelContext: false,
            } as Parameters<typeof readIntakePackageMember>[0]),
          {},
          { profileId, importId: id! },
        ),
      );
    } else if (action === 'package-roles')
      respond(
        await intake.saveIntakePackagePlan(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.saveIntakePackagePlan>[4],
        ),
      );
    else if (action === 'batch')
      respond(
        intake.submitIntakeBatch(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.submitIntakeBatch>[4],
        ),
      );
    else if (action === 'convert') {
      const current = intake.getIntake(db, root, profileId, id!);
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
      if (intake.getIntake(db, root, profileId, id!).version !== input.version)
        throw new HttpError(409, 'VERSION_CONFLICT', 'Reload this delivery before converting');
      if (assistant.isBusy(profileId))
        throw new HttpError(
          409,
          'ASSISTANT_BUSY',
          'A conversion or response is already running for this profile',
        );
      let chat;
      if (current.conversionChatId) {
        try {
          chat = assistant.get(profileId, current.conversionChatId);
        } catch (error) {
          if ((error as { code?: string }).code !== 'CHAT_NOT_FOUND') throw error;
        }
      }
      chat ||= assistant.create(profileId, { title: `Convert ${current.filename}` });
      intake.linkIntakeConversion(db, root, profileId, id!, chat.id);
      assistant.send(profileId, chat.id, {
        message: `Convert the selected delivery ${current.filename} (${id}) from ${current.provider} into a reviewable health-record-v1 proposal. Read all its pages or members using host tools, including selected-page PDFs or rendered page images and extracted embedded files where present. Use the original page references in metadata; each supplied PDF contains only its selected original page. Preserve originals, exact values, subject identity, locators and uncertainty. Propose separate clinical mappings for observed labs, medications, procedures and documents. Do not accept/import. Report any unreviewed pages/assets as coverage gaps.`,
        context: { route: `/import?intake=${encodeURIComponent(id!)}`, intakeId: id! },
      });
      respond({ chatId: chat.id });
    } else if (action === 'proposals')
      respond(
        intake.proposeConversion(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.proposeConversion>[4],
        ),
      );
    else if (action === 'import')
      respond(
        intake.importIntake(
          db,
          root,
          profileId,
          id!,
          input as unknown as Parameters<typeof intake.importIntake>[4],
        ),
      );
    else throw new HttpError(404, 'NOT_FOUND', 'Intake action not found');
  } else throw new HttpError(404, 'NOT_FOUND', 'Intake resource not found');
  return true;
}
