import type { IncomingMessage } from 'node:http';
import { HttpError, type Database } from './database.ts';
import {
  previewRecordOwnership,
  commitRecordOwnership,
  getRecordOwnershipReceipt,
  ownershipPeople,
  prepareOwnershipEvidence,
} from './record-ownership.ts';
import {
  usesNativeOwnershipEvidence,
  previewNativeRecordOwnership,
  commitNativeRecordOwnership,
  nativeOwnershipNamePlan,
  nativeOwnershipBlockerStore,
  chooseNativeOwnershipName,
  nativeOwnershipReportPlan,
  chooseNativeOwnershipReport,
} from './record-ownership-native.ts';
import {
  ownershipReceiptReference,
  replayOwnershipReceiptReference,
  ownershipOutcomePage,
} from './ownership-outcome-page.ts';
import { publishedOwnershipNameSupportPage } from './ownership-name-support-page.ts';
import { prepareOwnershipDecisionIndex } from './ownership-decision-index.ts';

/** Mounted only after the existing unlocked-profile, session and origin checks. */
export async function handleRecordOwnershipRoute(context: {
  resource?: string;
  id?: string;
  action?: string;
  method: string;
  req: IncomingMessage;
  db: Database;
  root: string;
  profileId: string;
  body: (req: IncomingMessage, max?: number) => Promise<Buffer>;
  respond: (data: unknown, options?: Record<string, unknown>, status?: number) => void;
}): Promise<boolean> {
  const { resource, id, action, method, req, db, root, profileId, body, respond } = context;
  if (resource !== 'record-ownership') return false;
  if (method === 'POST' && id === 'report-evidence' && action) {
    if ((req.headers['content-type'] || '').split(';')[0] !== 'application/json')
      throw new HttpError(415, 'CONTENT_TYPE', 'Use application/json');
    let choice: unknown;
    try {
      choice = JSON.parse((await body(req, 1024 * 1024)).toString('utf8'));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'INVALID_JSON', 'Expected one report decision');
    }
    respond(await chooseNativeOwnershipReport(db, profileId, action, choice));
    return true;
  }
  if (method === 'GET' && id === 'blocker-evidence' && action) {
    const url = new URL(req.url || '/', 'http://profile.invalid'),
      store = nativeOwnershipBlockerStore(db, profileId, action),
      key = url.searchParams.get('contribution') || '';
    respond(
      url.searchParams.has('ordinal')
        ? store.fragment(
            key,
            Number(url.searchParams.get('ordinal')),
            Number(url.searchParams.get('offset') ?? '0'),
            Number(url.searchParams.get('bytes') ?? '32768'),
          )
        : store.page(
            key,
            Number(url.searchParams.get('after') ?? '-1'),
            Number(url.searchParams.get('limit') ?? '16'),
            Number(url.searchParams.get('bytes') ?? '65536'),
          ),
    );
    return true;
  }
  if (method === 'GET' && id === 'report-evidence' && action) {
    const url = new URL(req.url || '/', 'http://profile.invalid'),
      section = url.searchParams.get('section') || 'records';
    if (!['records', 'pending', 'relationships', 'holds'].includes(section))
      throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Invalid report evidence section');
    const plan = nativeOwnershipReportPlan(db, profileId, action);
    if (url.searchParams.has('contribution')) {
      const key = url.searchParams.get('contribution')!,
        source = url.searchParams.get('source');
      respond(
        url.searchParams.has('ordinal')
          ? plan.contributionFragment(
              key,
              source,
              Number(url.searchParams.get('ordinal')),
              Number(url.searchParams.get('offset') ?? '0'),
              Number(url.searchParams.get('bytes') ?? '32768'),
            )
          : plan.contributionPage(
              key,
              source,
              Number(url.searchParams.get('after') ?? '-1'),
              Number(url.searchParams.get('limit') ?? '16'),
              Number(url.searchParams.get('bytes') ?? '65536'),
            ),
      );
      return true;
    }
    if (url.searchParams.has('ordinal'))
      respond(
        plan.fragment(
          section as 'records' | 'pending' | 'relationships' | 'holds',
          Number(url.searchParams.get('ordinal')),
          Number(url.searchParams.get('offset') ?? '0'),
          Number(url.searchParams.get('bytes') ?? '65536'),
        ),
      );
    else
      respond(
        plan.page(
          section as 'records' | 'pending' | 'relationships' | 'holds',
          Number(url.searchParams.get('after') ?? '-1'),
          Number(url.searchParams.get('limit') ?? '32'),
          Number(url.searchParams.get('bytes') ?? '65536'),
        ),
      );
    return true;
  }
  if (method === 'GET' && id === 'outcomes' && action) {
    await prepareOwnershipDecisionIndex(db);
    const url = new URL(req.url || '/', 'http://profile.invalid');
    respond(
      ownershipOutcomePage(
        db,
        profileId,
        action,
        url.searchParams.get('after') || '',
        Number(url.searchParams.get('limit') ?? '32'),
      ),
    );
    return true;
  }
  if (method === 'GET' && id === 'name-supports' && action) {
    await prepareOwnershipDecisionIndex(db);
    if (!ownershipReceiptReference(db, profileId, action))
      getRecordOwnershipReceipt(db, profileId, action);
    const url = new URL(req.url || '/', 'http://profile.invalid');
    const effect = url.searchParams.get('effect');
    if (!effect)
      throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Select an exact remembered name effect');
    const numeric = (name: string, fallback: number) => {
      const value = url.searchParams.get(name);
      if (value === null) return fallback;
      if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Invalid accepted support page cursor');
      return Number(value);
    };
    respond(
      publishedOwnershipNameSupportPage(
        db,
        profileId,
        action,
        effect,
        numeric('after', -1),
        numeric('limit', 32),
      ),
    );
    return true;
  }
  if (method === 'POST' && id === 'name-evidence' && action) {
    if ((req.headers['content-type'] || '').split(';')[0] !== 'application/json')
      throw new HttpError(415, 'CONTENT_TYPE', 'Use application/json');
    let choice: unknown;
    try {
      choice = JSON.parse((await body(req, 4096)).toString('utf8'));
    } catch {
      throw new HttpError(400, 'INVALID_JSON', 'Expected an exact name decision');
    }
    if (
      !choice ||
      typeof choice !== 'object' ||
      Object.keys(choice).some((k) => !['key', 'outcome'].includes(k)) ||
      !('key' in choice) ||
      typeof choice.key !== 'string' ||
      !('outcome' in choice) ||
      !['old', 'destination', 'both', 'unresolved'].includes(String(choice.outcome))
    )
      throw new HttpError(400, 'OWNERSHIP_DECISION', 'Select an exact name association outcome');
    respond(
      chooseNativeOwnershipName(
        db,
        root,
        profileId,
        action,
        choice.key,
        choice.outcome as import('../shared/record-ownership.ts').OwnershipNameEffect['decision'],
      ),
    );
    return true;
  }
  if (method === 'GET' && id === 'name-evidence' && action) {
    const plan = nativeOwnershipNamePlan(db, profileId, action);
    const url = new URL(req.url || '/', 'http://profile.invalid');
    const effect = url.searchParams.get('effect'),
      support = url.searchParams.get('support');
    const numeric = (name: string, fallback: number) => {
      const text = url.searchParams.get(name);
      if (text === null) return fallback;
      if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text)))
        throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Invalid evidence page cursor');
      return Number(text);
    };
    if (support !== null) {
      if (!effect || !/^\d+$/.test(support) || !Number.isSafeInteger(Number(support)))
        throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Select an exact effect and support');
      respond(plan.targets(effect, Number(support), numeric('after', -1), numeric('limit', 32)));
    } else if (effect) respond(plan.supports(effect, numeric('after', 0), numeric('limit', 16)));
    else respond(plan.effects(url.searchParams.get('after') || '', numeric('limit', 16)));
    return true;
  }
  if (method === 'GET' && id === 'people' && !action) {
    respond(ownershipPeople(db, profileId));
    return true;
  }
  if (method === 'GET' && id && !action && id !== 'preview') {
    await prepareOwnershipDecisionIndex(db);
    respond(
      ownershipReceiptReference(db, profileId, id) ?? getRecordOwnershipReceipt(db, profileId, id),
    );
    return true;
  }
  if (method !== 'POST' || action || (id && id !== 'preview'))
    throw new HttpError(404, 'NOT_FOUND', 'Ownership correction action not found');
  if ((req.headers['content-type'] || '').split(';')[0] !== 'application/json')
    throw new HttpError(415, 'CONTENT_TYPE', 'Use application/json');
  let input: unknown;
  try {
    input = JSON.parse((await body(req, 1024 * 1024)).toString('utf8'));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_JSON', 'Expected a JSON object');
  }
  // Replays resolve before any original read; this also works after the source was archived.
  if (id !== 'preview' && input && typeof input === 'object' && 'operationId' in input) {
    await prepareOwnershipDecisionIndex(db);
    const replay = replayOwnershipReceiptReference(db, profileId, input);
    if (replay) {
      respond(replay);
      return true;
    }
    try {
      getRecordOwnershipReceipt(db, profileId, String(input.operationId));
      respond(commitRecordOwnership(db, root, profileId, input));
      return true;
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'OWNERSHIP_NOT_FOUND') throw error;
    }
  }
  const native = usesNativeOwnershipEvidence(db);
  if (!native)
    await prepareOwnershipEvidence(
      db,
      root,
      profileId,
      id === 'preview' ? input : (input as { request?: unknown })?.request,
    );
  if (native)
    respond(
      id === 'preview'
        ? await previewNativeRecordOwnership(db, root, profileId, input)
        : await commitNativeRecordOwnership(db, root, profileId, input),
    );
  else
    respond(
      id === 'preview'
        ? previewRecordOwnership(db, root, profileId, input)
        : commitRecordOwnership(db, root, profileId, input),
    );
  return true;
}
