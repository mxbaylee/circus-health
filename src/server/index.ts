import { recordOwner } from './record-owner.ts';
import { readProfileRegistry, recoverProfileDeletions } from './profile-registry.ts';
import { diagnosticRoute } from '../shared/import-diagnostic-route.ts';
import { createProfileLifecycle } from './profile-lifecycle.ts';
import { disposePdfEvidenceSessions } from './intake-pdf-session.ts';
import { visibilityState, setVisibility } from './visibility.ts';
import { clinicalRedirect } from './clinical-references.ts';
import { clinicalRecordHistory } from './clinical-history.ts';
import { createNoteExports } from './note-exports.ts';
import { personFilterOptions } from './collection-filters.ts';
import { personSourceEvidence } from './person-source-evidence.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { listIntakes } from './intake.ts';
import { exportImportAttribution } from './intake-attribution.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import type { LinkTargetType } from '../shared/api.ts';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase, REPO_ROOT, HttpError, revision, required, json } from './database.ts';
import * as q from './queries.ts';
import { visionPrescriptions } from './vision.ts';
import * as n from './notes.ts';
import { noteHistory, restoreNoteFields, previewNoteRestoration } from './note-history.ts';
import * as a from './assets.ts';
import { profilePaths } from './profile-storage.ts';
export { PROFILES } from './profiles.ts';
import { attachPersonalDurability, personalDurabilityStatus, flushPersonal } from './portable.ts';
import { createBackup } from './recovery.ts';
import { createAssistant } from './assistant.ts';
import { mappingAssistantExtensions } from './mapping-actions.ts';
import { intakeDraftRepairAssistantExtensions } from './intake-draft-repair.ts';
import { resolvedSource } from './source-view.ts';
import { handleIntakeRoute } from './intake-routes.ts';
import { handleClinicalReviewRoute } from './clinical-review-routes.ts';
import { handleClinicalRelationshipRoute } from './clinical-relationship-routes.ts';
import { createIntakeBatchManager } from './intake-batches.ts';
import { handleIntakeBatchRoute } from './intake-batch-routes.ts';
import { historicalNotes, getHistoricalNote, historicalNoteOptions } from './historical-notes.ts';
import {
  importDiagnostics as defaultImportDiagnostics,
  type ImportDiagnostics,
} from './import-diagnostics.ts';
const responseBodySizes = new WeakMap<ServerResponse, number>();
function prefixUrls(value: unknown, prefix: string): unknown {
  if (Array.isArray(value)) return value.map((v) => prefixUrls(v, prefix));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        ['raw', 'extra', 'details', 'person'].includes(key)
          ? v
          : ['contentUrl', 'detailsUrl'].includes(key) &&
              typeof v === 'string' &&
              v.startsWith('/api/')
            ? prefix + v.slice(4)
            : prefixUrls(v, prefix),
      ]),
    );
  return value;
}
function envelope(
  db: Database,
  data: unknown,
  {
    total = Array.isArray(data) ? data.length : 1,
    complete = true,
    ...meta
  }: Record<string, unknown> = {},
) {
  return {
    data,
    meta: {
      revision: revision(db),
      durability: personalDurabilityStatus(db),
      total,
      complete,
      ...meta,
    },
  };
}
function send(res: ServerResponse, status: number, data: unknown) {
  const serialized = JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  responseBodySizes.set(res, Buffer.byteLength(serialized));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(serialized),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(serialized);
}
async function body(req: IncomingMessage, max = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, 'BODY_SIZE', 'Request exceeds the permitted size');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req: IncomingMessage, max?: number): Promise<Record<string, unknown>> {
  if ((req.headers['content-type'] || '').split(';')[0] !== 'application/json')
    throw new HttpError(415, 'CONTENT_TYPE', 'Use application/json');
  try {
    const obj = JSON.parse((await body(req, max)).toString('utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error();
    return obj;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'INVALID_JSON', 'Request must contain a JSON object');
  }
}
function serveOriginal(
  res: ServerResponse,
  path: string,
  mime: string | null,
  name: string | undefined,
) {
  const allowed = new Set([
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'text/plain',
    'application/json',
    'application/x-ndjson',
  ]);
  const safeMime = allowed.has(mime!) ? mime! : 'application/octet-stream';
  responseBodySizes.set(res, statSync(path).size);
  res.writeHead(200, {
    'Content-Type': safeMime,
    'Content-Length': statSync(path).size,
    'Content-Disposition': `${safeMime === 'application/octet-stream' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name!)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'no-store',
  });
  createReadStream(path).pipe(res);
}
export interface AppOptions {
  root?: string;
  port?: number;
  databases?: Map<string, Database>;
  allowedOrigins?: string[];
  assistantOptions?: Partial<Parameters<typeof createAssistant>[0]>;
  intakeBatchOptions?: Partial<Parameters<typeof createIntakeBatchManager>[0]>;
  databaseDirectory?: string;
  runtimeRoot?: string;
  diagnostics?: ImportDiagnostics;
}
export function createApp({
  root = REPO_ROOT,
  port = 3001,
  databases,
  allowedOrigins,
  assistantOptions,
  intakeBatchOptions,
  databaseDirectory,
  runtimeRoot,
  diagnostics = defaultImportDiagnostics,
}: AppOptions = {}) {
  recoverProfileDeletions(root);
  const dbs = databases || new Map<string, Database>();
  if (!databases) {
    // Validate every path first: a missing playground must not create an empty
    // profile, reuse another owner's legacy file, or migrate the other stores.
    const paths = readProfileRegistry(root).profiles.map((profile) => {
      const path = profilePaths(root, profile.id).database;
      if (!existsSync(path))
        throw new Error(
          `Missing ${profile.id} database. Restore or rebuild this profile before starting the app.`,
        );
      return [profile.id, path] as const;
    });
    try {
      for (const [profileId, path] of paths) dbs.set(profileId, openDatabase(path, profileId));
      for (const [profileId, db] of dbs) attachPersonalDurability(db, { root, profileId });
    } catch (error) {
      for (const db of dbs.values()) db.close();
      throw error;
    }
  }
  const origins = new Set(
    allowedOrigins || [
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      'http://127.0.0.1:4173',
      `http://127.0.0.1:${port}`,
    ],
  );
  const mappingActions = mappingAssistantExtensions();
  const draftRepairActions = intakeDraftRepairAssistantExtensions();
  const assistant = createAssistant({
    root,
    databases: dbs,
    diagnostics,
    actionExtensions: {
      tools: [...mappingActions.tools, ...draftRepairActions.tools],
      call(tool, args, context) {
        return tool.startsWith('health_intake_draft_repair_')
          ? draftRepairActions.call(tool, args, context)
          : mappingActions.call(tool, args, context);
      },
      apply(proposal, context) {
        return proposal.kind === 'intake_draft_repair'
          ? draftRepairActions.apply(proposal, context)
          : mappingActions.apply(proposal, context);
      },
      reconcile(proposal, context) {
        return proposal.kind === 'intake_draft_repair'
          ? draftRepairActions.reconcile(proposal, context)
          : mappingActions.reconcile(proposal, context);
      },
    },
    ...assistantOptions,
  });
  const intakeBatches = createIntakeBatchManager({
    root,
    databases: dbs,
    assistant,
    diagnostics,
    ...intakeBatchOptions,
  });
  const noteExports = createNoteExports();
  const activeRequests = new Map<string, number>();
  const lifecycle = createProfileLifecycle({
    root,
    databases: dbs,
    databaseDirectory,
    runtimeRoot,
    busy: (id: string) =>
      (activeRequests.get(id) || 0) > 0 || assistant.isBusy(id) || intakeBatches.isBusy(id),
  });
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const host = req.headers.host || '';
      if (
        !/^((127\.0\.0\.1)|(localhost))(:\d+)?$/.test(host) &&
        ![...origins].some((origin) => new URL(origin).host === host)
      )
        throw new HttpError(403, 'HOST_REJECTED', 'Local access only');
      if (req.headers.origin && !origins.has(req.headers.origin!))
        throw new HttpError(403, 'ORIGIN_REJECTED', 'Cross-origin requests are not allowed');
      const url = new URL(req.url!, 'http://' + host),
        method = req.method || 'GET';
      const mutating = !['GET', 'HEAD'].includes(method);
      if (mutating && !origins.has(req.headers.origin!))
        throw new HttpError(403, 'ORIGIN_REQUIRED', 'Writes require the local app origin');
      if (url.pathname === '/api/profiles' && method === 'GET') {
        send(res, 200, {
          data: lifecycle.list(),
          meta: { revision: 0, total: lifecycle.list().length, complete: true },
        });
        return;
      }
      if (url.pathname === '/api/profiles' && method === 'POST') {
        send(res, 201, { data: await lifecycle.create(await jsonBody(req)) });
        return;
      }
      const lifecycleMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)(\/copy)?$/);
      if (lifecycleMatch && (method === 'DELETE' || method === 'POST')) {
        const id = decodeURIComponent(lifecycleMatch[1]);
        if (!dbs.has(id)) throw new HttpError(404, 'PROFILE_NOT_FOUND', 'Profile not found');
        const input = await jsonBody(req);
        if (method === 'DELETE' && !lifecycleMatch[2])
          send(res, 200, { data: lifecycle.remove(id, input) });
        else if (method === 'POST' && lifecycleMatch[2])
          send(res, 201, { data: await lifecycle.create(input, id) });
        else throw new HttpError(404, 'NOT_FOUND', 'Profile action not found');
        return;
      }
      const match = url.pathname.match(/^\/api\/profiles\/([^/]+)(\/.*)$/);
      if (!match) throw new HttpError(404, 'NOT_FOUND', 'API resource not found');
      const profileId = decodeURIComponent(match[1]);
      if (!dbs.has(profileId)) throw new HttpError(404, 'PROFILE_NOT_FOUND', 'Profile not found');
      if (lifecycle.isLocked(profileId))
        throw new HttpError(409, 'PROFILE_BUSY', 'Profile management is in progress');
      activeRequests.set(profileId, (activeRequests.get(profileId) || 0) + 1);
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          activeRequests.set(profileId, activeRequests.get(profileId)! - 1);
        }
      };
      res.once('finish', release);
      res.once('close', release);
      const db = required(dbs.get(profileId)),
        prefix = '/api/profiles/' + profileId,
        parts = match[2].split('/').filter(Boolean).map(decodeURIComponent),
        [resource, id, action] = parts,
        params = url.searchParams;
      const respond = (data: unknown, options: Record<string, unknown> = {}, status = 200) =>
        send(
          res,
          status,
          prefixUrls(
            envelope(db, data, {
              ...options,
              profile: {
                ...readProfileRegistry(root).profiles.find((profile) => profile.id === profileId),
                ...n.selfIdentity(db),
                version: n.selfIdentity(db).nameVersion,
              },
            }),
            prefix,
          ),
        );
      const list = <T extends { data: unknown }>(result: T) => {
        const { data, ...meta } = result;
        respond(data, meta);
      };
      if (resource === 'import-diagnostics' && id === 'status' && method === 'GET') {
        send(res, 200, { data: { enabled: diagnostics.enabled } });
        return;
      }
      if (resource === 'import-diagnostics' && parts.length === 1 && method === 'GET') {
        const salt = randomBytes(32);
        const snapshot = diagnostics.exportSnapshot(profileId, salt);
        let attribution: unknown;
        try {
          const intakes = listIntakes(db, profileId, { visibility: 'all', limit: 100 }, root);
          const metadata = assistant.attributionMetadata(profileId, intakes.data);
          attribution = {
            ...exportImportAttribution({
              intakes: intakes.data,
              chats: metadata.chats,
              selectionIncomplete: intakes.total > intakes.data.length,
              historyIncomplete: metadata.omittedChats > 0 || metadata.unavailableChats > 0,
              salt,
            }),
            journalReadBytes: metadata.readBytes,
            omittedChats: metadata.omittedChats,
            unavailableChats: metadata.unavailableChats,
            omittedImports: Math.max(0, intakes.total - intakes.data.length),
          };
        } catch {
          attribution = { unavailable: true };
        }
        // Diagnostics carry no normal envelope/profile identity or medical durability metadata.
        send(res, 200, { data: { enabled: diagnostics.enabled, ...snapshot, attribution } });
        return;
      }
      if (resource === 'import-diagnostics' && parts.length === 1 && method === 'POST') {
        if (!diagnostics.recordClientOperation(profileId, await jsonBody(req, 32 * 1024)))
          throw new HttpError(400, 'INVALID_DIAGNOSTICS', 'Invalid performance summary');
        send(res, 200, { data: { recorded: true } });
        return;
      }
      if (resource === 'assistant') {
        if (id === 'status' && parts.length === 2 && method === 'GET')
          respond(await assistant.status(profileId));
        else if (id === 'test-connection' && parts.length === 2 && method === 'POST') {
          const input = await jsonBody(req);
          respond(
            await assistant.testConnection(
              { image: input.image === true, pdf: input.pdf === true },
              profileId,
            ),
          );
        } else if (id === 'chats' && parts.length === 2 && method === 'GET')
          respond(assistant.list(profileId));
        else if (id === 'chats' && parts.length === 2 && method === 'POST')
          respond(assistant.create(profileId, await jsonBody(req)));
        else if (id === 'chats' && parts.length === 3 && method === 'GET')
          respond(assistant.get(profileId, action));
        else if (id === 'chats' && parts.length === 4 && method === 'POST') {
          if (parts[3] === 'messages')
            respond(assistant.send(profileId, action, await jsonBody(req)));
          else if (parts[3] === 'retry') respond(assistant.retry(profileId, action));
          else if (parts[3] === 'cancel') respond(assistant.cancel(profileId, action));
          else if (parts[3] === 'apply')
            respond(assistant.apply(profileId, action, (await jsonBody(req)).proposalId as string));
          else throw new HttpError(404, 'NOT_FOUND', 'Assistant action not found');
        } else throw new HttpError(404, 'NOT_FOUND', 'Assistant resource not found');
        return;
      }
      if (parts.length > 3) throw new HttpError(404, 'NOT_FOUND', 'API resource not found');
      if (
        await handleClinicalRelationshipRoute({
          resource,
          id,
          action,
          method,
          params,
          req,
          db,
          root,
          profileId,
          body,
          respond,
        })
      )
        return;
      if (
        await handleClinicalReviewRoute({
          resource,
          id,
          action,
          method,
          params,
          req,
          db,
          root,
          profileId,
          body,
          respond,
        })
      )
        return;
      if (
        await handleIntakeBatchRoute({
          resource,
          id,
          action,
          method,
          req,
          profileId,
          respond,
          jsonBody,
          intakeBatches,
        })
      )
        return;
      if (
        await noteExports({
          resource,
          id,
          action,
          method,
          req,
          res,
          db,
          profileId,
          respond,
          jsonBody,
        })
      )
        return;
      if (
        await handleIntakeRoute({
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
        })
      )
        return;
      if (['historical-notes', 'historical-note-options'].includes(resource) && mutating)
        throw new HttpError(
          405,
          'READ_ONLY_RESOURCE',
          'This historical collection is read-only. Edit personal drafts through Notes.',
        );
      if (
        resource === 'notes' &&
        id &&
        action === 'source-evidence' &&
        parts.length === 3 &&
        mutating
      )
        throw new HttpError(405, 'READ_ONLY_RESOURCE', 'Imported source evidence is read-only.');
      if (
        resource === 'source-records' &&
        id &&
        action === 'evidence' &&
        parts.length === 3 &&
        mutating
      )
        throw new HttpError(405, 'READ_ONLY_RESOURCE', 'Clinical source evidence is read-only.');
      if (method === 'GET') {
        if (resource === 'vision-prescriptions' && !id) {
          list(visionPrescriptions(db, params));
          return;
        }
        if (resource === 'record-history' && !id) {
          respond(
            clinicalRecordHistory(db, {
              profileId,
              kind: params.get('kind'),
              recordId: params.get('recordId'),
              ...(params.has('field') ? { field: params.get('field') } : {}),
              ...(params.has('beforeSequence')
                ? { beforeSequence: Number(params.get('beforeSequence')) }
                : {}),
              ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
            }),
          );
          return;
        }
        if (id && !action) {
          const kind = (
            {
              tests: 'observation',
              medications: 'medication',
              procedures: 'procedure',
              documents: 'document',
              'historical-notes': 'document',
            } as Record<string, 'observation' | 'medication' | 'procedure' | 'document'>
          )[resource];
          if (
            kind &&
            !(
              resource === 'historical-notes' &&
              db.prepare('SELECT 1 FROM notes WHERE id=?').get(id)
            )
          ) {
            const redirected = clinicalRedirect(db, kind, id);
            if (redirected) {
              respond(redirected);
              return;
            }
          }
        }
        if (resource === 'visibility' && id && action && parts.length === 3) {
          respond(visibilityState(db, id, action));
          return;
        }
        if (resource === 'historical-notes' && !action) {
          id ? respond(getHistoricalNote(db, id)) : list(historicalNotes(db, params));
          return;
        }
        if (resource === 'historical-note-options' && !id) {
          respond(historicalNoteOptions(db, params));
          return;
        }
        if (resource === 'storage' && !id) {
          respond(personalDurabilityStatus(db));
          return;
        }
        if (resource === 'overview' && !id) {
          const counts: Record<string, number> = {};
          for (const [key, table] of Object.entries({
            observations: 'observations',
            testTypes: 'test_types',
            medications: 'medications',
            procedures: 'procedures',
            sourceFiles: 'source_files',
            sourceRecords: 'source_records',
            notes: 'notes',
          })) {
            const scope =
              key === 'procedures'
                ? " WHERE person_id='patient' AND category NOT IN ('laboratory','pathology')"
                : key === 'observations' || key === 'medications'
                  ? " WHERE person_id='patient'"
                  : key === 'testTypes'
                    ? " WHERE id IN (SELECT test_type_id FROM observations WHERE person_id='patient')"
                    : '';
            counts[key] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}${scope}`).get()!
              .n as number;
          }
          respond({
            counts,
            recentResults: q.observations(db, new URLSearchParams({ limit: '6' })).data,
            pinnedNotes: n.listNotes(db, new URLSearchParams({ pinned: '1', limit: '8' })).data,
            coverage: q.coverage(db),
            batches: db.prepare('SELECT * FROM manual_batches ORDER BY created_at DESC').all(),
          });
          return;
        }
        if (resource === 'evidence' && !id) {
          const type = params.get('entityType'),
            entityId = params.get('entityId');
          if (
            ![
              'observation',
              'medication',
              'procedure',
              'document',
              'report',
              'note',
              'person',
            ].includes(type!) ||
            !entityId
          )
            throw new HttpError(
              400,
              'INVALID_INPUT',
              'Provide a supported entityType and entityId',
            );
          respond(q.evidenceFor(db, type!, entityId));
          return;
        }
        if (resource === 'providers' && !id) {
          respond(q.providerList(db));
          return;
        }
        if (resource === 'tests') {
          if (id) {
            const result = q.getObservation(db, id);
            Object.assign(result, {
              attachments: n.attachments(db, 'observation', id),
              evidence: q.evidenceFor(db, 'observation', id),
            });
            respond(result);
          } else list(q.observations(db, params));
          return;
        }
        if (resource === 'test-types' && !id) {
          respond(q.testTypes(db, params));
          return;
        }
        if (resource === 'trends' && !id) {
          respond(q.trends(db, params, { root, profileId }));
          return;
        }
        if (resource === 'medications' || resource === 'procedures') {
          const result = q.clinicalList(db, resource, params, id);
          if (id) {
            const kind = resource === 'medications' ? 'medication' : 'procedure';
            Object.assign(result, {
              evidence: q.evidenceFor(db, kind, id),
              attachments: n.attachments(db, kind, id),
            });
            respond(result);
          } else list(result as Exclude<typeof result, { id: string }>);
          return;
        }
        if (resource === 'sources') {
          if (id && action === 'content') {
            const f = q.getSourceFile(db, id),
              path = a.profileFile(root, f.path, profileId);
            serveOriginal(res, path, f.mimeType, f.path.split('/').pop());
          } else if (id) respond(q.getSourceFile(db, id));
          else list(q.sourceFiles(db, params));
          return;
        }
        if (resource === 'source-records') {
          if (id && action === 'evidence') {
            list(q.sourceRecordClinicalEvidence(db, id, params));
            return;
          }
          if (id && action === 'resolved') {
            respond(resolvedSource(db, id, { fileView: q.sourceRecordFileView(params) }));
            return;
          }
          id
            ? respond(
                q.sourceRecordFileView(params) === 'reference'
                  ? q.getSourceRecord(db, id, { fileView: 'reference' })
                  : q.getSourceRecord(db, id, { fileView: 'full' }),
              )
            : list(q.sourceRecords(db, params));
          return;
        }
        if (resource === 'record-owner') {
          respond({ personId: recordOwner(db, params.get('type') || '', params.get('id') || '') });
          return;
        }
        if (resource === 'clinical-people' && !id) {
          respond(q.clinicalPeople(db));
          return;
        }
        if (resource === 'clinical-person' && id) {
          respond(q.clinicalPerson(db, id));
          return;
        }
        if (resource === 'documents' && !id) {
          list(q.documents(db, params));
          return;
        }
        if (resource === 'documents' && id) {
          const r = required(db.prepare('SELECT * FROM documents WHERE id=?').get(id));
          respond({
            id: r.id,
            personId: q.documentPersonId(r.extra_json),
            title: r.title,
            date: r.effective_at,
            sourceRecordId: r.source_record_id,
            text: r.text_content,
            extra: json(r.extra_json as string),
            attachments: n.attachments(db, 'document', id),
            evidence: q.evidenceFor(db, 'document', id),
          });
          return;
        }
        if (resource === 'notes' && id && action === 'source-evidence' && parts.length === 3) {
          list(personSourceEvidence(db, id, params));
          return;
        }
        if (resource === 'notes' && id && action === 'history') {
          respond(noteHistory(db, root, profileId, id, params));
          return;
        }
        if (resource === 'notes') {
          id ? respond(n.getNote(db, id)) : list(n.listNotes(db, params));
          return;
        }
        if (resource === 'person-filter-options' && !id) {
          respond(personFilterOptions(db));
          return;
        }
        if (resource === 'person-tags' && !id) {
          respond(n.personTags(db));
          return;
        }
        if (resource === 'note-types' && !id) {
          respond(n.typeLabels(db));
          return;
        }
        if (resource === 'link-target' && !id) {
          respond(n.linkTarget(db, params.get('type'), params.get('id')));
          return;
        }
        if (resource === 'related-notes' && !id) {
          respond(
            n.relatedNotes(db, params.get('targetType') as LinkTargetType, params.get('targetId')!),
          );
          return;
        }
        if (resource === 'link-targets' && !id) {
          respond(n.linkTargets(db, params), { complete: false });
          return;
        }
        if (resource === 'assets' && id) {
          const asset = required(db.prepare('SELECT * FROM assets WHERE id=?').get(id));
          if (action === 'content')
            serveOriginal(
              res,
              a.profileFile(root, asset.stored_path, profileId),
              asset.mime_type as string,
              asset.original_name as string,
            );
          else respond(n.assetDTO(asset));
          return;
        }
        if (resource === 'attachments' && !id) {
          respond(n.attachments(db, params.get('ownerType')!, params.get('ownerId')!));
          return;
        }
      }
      if (resource === 'assets' && method === 'POST' && !id) {
        let name;
        try {
          name = decodeURIComponent((req.headers['x-filename'] || '') as string);
        } catch {
          throw new HttpError(400, 'INVALID_FILENAME', 'Filename encoding is invalid');
        }
        respond(
          a.uploadAsset(
            db,
            root,
            profileId,
            await body(req, 25 * 1024 * 1024),
            name,
            (req.headers['content-type'] || '').split(';')[0],
          ),
          {},
          201,
        );
        return;
      }
      if (mutating) {
        const input = await jsonBody(req);
        if (resource === 'visibility' && id && action && parts.length === 3 && method === 'PATCH') {
          respond(setVisibility(db, id, action, input));
          return;
        }
        if (resource === 'medications' && id && action === 'current-status' && method === 'PATCH') {
          const result = q.setMedicationCurrentStatus(db, id, input);
          Object.assign(result, {
            attachments: n.attachments(db, 'medication', id),
            evidence: q.evidenceFor(db, 'medication', id),
          });
          respond(result);
          return;
        }
        if (resource === 'storage' && id === 'flush' && method === 'POST') {
          respond(flushPersonal(db));
          return;
        }
        if (resource === 'notes') {
          if (method === 'POST' && !id) {
            respond(n.createNote(db, input), {}, 201);
            return;
          }
          if (method === 'PUT' && id && !action) {
            respond(n.saveNote(db, id, input));
            return;
          }
          if (method === 'POST' && id) {
            if (action === 'restore-preview') {
              respond(previewNoteRestoration(db, root, profileId, id, input));
              return;
            }
            if (action === 'restore') {
              respond(restoreNoteFields(db, root, profileId, id, input));
              return;
            }
            if (action === 'convert') {
              respond(n.convertNote(db, id, input));
              return;
            }
            if (action === 'finish') {
              respond(
                n.finishNote(db, id, input, (noteId) =>
                  a.verifyNoteAssets(db, root, profileId, noteId),
                ),
              );
              return;
            }
            if (action === 'correction') {
              respond(n.correctionNote(db, id, input), {}, 201);
              return;
            }
          }
        }
        if (resource === 'attachments') {
          if (method === 'POST' && !id) {
            respond(
              a.createAttachment(
                db,
                root,
                profileId,
                input as unknown as Parameters<typeof a.createAttachment>[3],
              ),
              {},
              201,
            );
            return;
          }
          if (id && ['PATCH', 'DELETE'].includes(method)) {
            respond(a.editAttachment(db, id, input, method === 'DELETE'));
            return;
          }
        }
        if (resource === 'backups' && method === 'POST' && !id) {
          respond(await createBackup(db, root, profileId), {}, 201);
          return;
        }
      }
      throw new HttpError(404, 'NOT_FOUND', 'API resource not found');
    } catch (caught) {
      const error = caught as Error & { status?: number; code?: string };
      const status = error.status || 500;
      send(res, status, {
        error: {
          code:
            error.code && typeof error.code === 'string' && !error.code.startsWith('ERR_')
              ? error.code
              : 'INTERNAL_ERROR',
          message:
            status === 500 ? 'The local service could not complete this request' : error.message,
        },
      });
      if (status === 500) console.error(error);
    }
  };
  const server = createServer((req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-ID', requestId);
    const startedAt = performance.now();
    const profileId = (() => {
      const encoded = req.url?.match(/^\/api\/profiles\/([^/?#]+)/)?.[1];
      if (!encoded) return undefined;
      try {
        const candidate = decodeURIComponent(encoded);
        return dbs.has(candidate) ? candidate : undefined;
      } catch {
        return undefined;
      }
    })();
    const contentLength = req.headers['content-length'];
    const requestBytes =
      typeof contentLength === 'string' && /^\d+$/.test(contentLength)
        ? Number(contentLength)
        : null;
    const suppliedClientRequestId = req.headers['x-client-request-id'];
    const clientRequestId =
      typeof suppliedClientRequestId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        suppliedClientRequestId,
      )
        ? suppliedClientRequestId
        : undefined;
    const route = diagnosticRoute(req.url || '');
    if (route === '/profiles/:profile/import-diagnostics') return handleRequest(req, res);
    const suppliedOperationId = req.headers['x-client-operation-id'];
    const operationId =
      typeof suppliedOperationId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        suppliedOperationId,
      )
        ? suppliedOperationId
        : undefined;
    const requestContext = { requestId, clientRequestId, operationId, profileId };
    return diagnostics.run(requestContext, () => {
      let terminalRecorded = false;
      const active =
        profileId && operationId ? diagnostics.startActive(profileId, requestContext) : undefined;
      diagnostics.record(
        'http.request.started',
        { method: req.method || 'GET', route, requestBytes },
        requestContext,
      );
      const terminal = (aborted: boolean): void => {
        if (terminalRecorded) return;
        terminalRecorded = true;
        active?.finish({
          outcome: aborted ? 'cancelled' : res.statusCode >= 400 ? 'failed' : 'completed',
        });
        const responseLength = responseBodySizes.get(res) ?? res.getHeader('content-length');
        diagnostics.record(
          aborted ? 'http.request.aborted' : 'http.request.completed',
          {
            method: req.method || 'GET',
            route,
            status: res.statusCode,
            requestBytes,
            responseBytes:
              typeof responseLength === 'number'
                ? responseLength
                : typeof responseLength === 'string' && /^\d+$/.test(responseLength)
                  ? Number(responseLength)
                  : null,
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          },
          requestContext,
        );
      };
      req.once('aborted', () => terminal(true));
      req.once('close', () => {
        if (req.aborted || !req.complete) terminal(true);
      });
      res.once('finish', () => terminal(false));
      res.once('close', () => terminal(!res.writableFinished));
      return handleRequest(req, res);
    });
  });
  return {
    server,
    assistant,
    intakeBatches,
    databases: dbs,
    diagnostics,
    close(reason = 'interrupted') {
      lifecycle.close();
      intakeBatches.close(reason);
      assistant.close();
      server.close();
      for (const [profileId, db] of dbs) {
        void disposePdfEvidenceSessions(profileId);
        diagnostics.clear(profileId);
        db.close();
      }
    },
  };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  throw new Error(
    'Start from the repository root with CRS_DATA_DIR=/absolute/path/data CRS_MODEL=health-primary CRS_LITELLM_CONFIG=/absolute/path/litellm.yaml npm start; standalone index.ts is unsupported.',
  );
}
