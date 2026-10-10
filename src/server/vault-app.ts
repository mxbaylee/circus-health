import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { authorizationSignalAborted } from './authorization-signal.ts';
import { assistantCompactOwnerCurrent, type AssistantCompactOwner } from './assistant.ts';
import {
  intakeBatchOwnerCurrent,
  type IntakeBatchOwner,
  type IntakeBatchManager,
} from './intake-batches.ts';
import { createApp, type AppOptions } from './index.ts';
import { vaultStorageTotals } from './vault-storage-totals.ts';
import {
  archiveStorageTotals,
  importStorageEstimate,
  assertImportCapacity,
} from './archive-storage.ts';
import {
  createEncryptedProfiles,
  type CreateEncryptedProfilesOptions,
} from './encrypted-profiles.ts';
import { importDiagnostics, type ImportDiagnostics } from './import-diagnostics.ts';
import { createProfilePasskeys } from './profile-passkeys.ts';
import { writeChat, forgetChatJournal } from './assistant-journal.ts';
import { writeIntakeBatch, forgetIntakeBatchJournal } from './intake-batch-journal.ts';
import { HttpError } from './database.ts';
import { modelAvailability, testModelConnection } from './model-bridge.ts';
const send = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
};
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new HttpError(415, 'CONTENT_TYPE', 'Use application/json');
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 64 * 1024) throw new HttpError(413, 'BODY_SIZE', 'Request is too large');
    chunks.push(c);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Expected a JSON object');
  }
}
interface VaultAppOptions {
  dataDirectory: string;
  runtimeDirectory: string;
  allowedOrigins?: string[];
  assistantOptions?: AppOptions['assistantOptions'];
  diagnostics?: ImportDiagnostics;
  port?: number;
  unlockCheckpoint?: CreateEncryptedProfilesOptions['unlockCheckpoint'];
}
interface Session {
  id: string;
  profiles: Set<string>;
}
declare const compactAuthorizationBrand: unique symbol;
export interface VaultCompactAuthorization {
  readonly [compactAuthorizationBrand]: true;
}
const compactAuthorizationContext = new AsyncLocalStorage<VaultCompactAuthorization>();
const nativeMapGet = Map.prototype.get;
const nativeSetHas = Set.prototype.has;
const compactAuthorizations = new WeakMap<
  VaultCompactAuthorization,
  {
    db: DatabaseSync;
    profileId: string;
    sessions: Map<string, Session>;
    client: Session;
    profiles: Set<string>;
    opened: Map<string, unknown>;
    state: object;
    lifecycle: { closed: boolean };
    signal?: AbortSignal;
    request?: { active: boolean };
    job?: AssistantCompactOwner;
    batch?: IntakeBatchOwner;
    isOpen: () => unknown;
  }
>();
/** These checks retain real issuer state, not caller closures or storage reads. */
export function vaultCompactAuthorizationCurrent(
  authorization: VaultCompactAuthorization,
  db: DatabaseSync,
  profileId: string,
): boolean {
  const data = compactAuthorizations.get(authorization);
  return (
    !!data &&
    data.db === db &&
    data.profileId === profileId &&
    !data.lifecycle.closed &&
    (!data.signal || !authorizationSignalAborted(data.signal)) &&
    (!data.request || data.request.active) &&
    (!data.job || assistantCompactOwnerCurrent(data.job, db, profileId)) &&
    (!data.batch || !!intakeBatchOwnerCurrent(data.batch)) &&
    Reflect.apply(data.isOpen, db, []) === true &&
    Reflect.apply(nativeMapGet, data.sessions, [data.client.id]) === data.client &&
    Reflect.apply(nativeSetHas, data.profiles, [profileId]) &&
    Reflect.apply(nativeMapGet, data.opened, [profileId]) === data.state
  );
}
/** Capture only a token minted at the real authenticated HTTP dispatch. */
export function currentVaultCompactAuthorization(
  db: DatabaseSync,
  profileId: string,
): VaultCompactAuthorization | undefined {
  const authorization = compactAuthorizationContext.getStore();
  if (authorization && !vaultCompactAuthorizationCurrent(authorization, db, profileId))
    throw new HttpError(423, 'PROFILE_LOCKED', 'Profile access changed');
  return authorization;
}
const assistantAuthorizations = new WeakMap<AssistantCompactOwner, VaultCompactAuthorization>();
type CompactAuthorizationData = NonNullable<ReturnType<typeof compactAuthorizations.get>>;
const batchIssuers = new WeakMap<
  IntakeBatchManager,
  Pick<
    CompactAuthorizationData,
    'db' | 'profileId' | 'sessions' | 'opened' | 'state' | 'lifecycle' | 'isOpen'
  >
>();
/** Background dispatch has a real manager lifetime, not the expired HTTP response
 * inherited by its timer. Only profileApp registers an encrypted manager issuer. */
export async function withVaultIntakeBatchAuthorization<T>(
  owner: IntakeBatchOwner,
  run: () => Promise<T>,
): Promise<T> {
  const batch = intakeBatchOwnerCurrent(owner);
  if (!batch) throw new HttpError(423, 'PROFILE_LOCKED', 'Batch owner changed');
  const issuer = batchIssuers.get(batch.manager);
  if (!issuer) {
    if (compactAuthorizationContext.getStore())
      throw new HttpError(423, 'PROFILE_LOCKED', 'Batch issuer changed');
    return run();
  }
  if (issuer.db !== batch.db || issuer.profileId !== batch.profileId)
    throw new HttpError(423, 'PROFILE_LOCKED', 'Batch profile changed');
  const client = [...issuer.sessions.values()].find((session) =>
    Reflect.apply(nativeSetHas, session.profiles, [batch.profileId]),
  );
  if (!client) throw new HttpError(423, 'PROFILE_LOCKED', 'Profile access changed');
  const authorization = Object.freeze({}) as VaultCompactAuthorization;
  compactAuthorizations.set(authorization, {
    ...issuer,
    client,
    profiles: client.profiles,
    batch: owner,
  });
  if (!vaultCompactAuthorizationCurrent(authorization, batch.db, batch.profileId))
    throw new HttpError(423, 'PROFILE_LOCKED', 'Profile access changed');
  return compactAuthorizationContext.run(authorization, run);
}
/** A separate background lifetime is issued before the initiating response,
 * only for an actual assistant job already installed in its private active map. */
export function captureVaultAssistantAuthorization(
  owner: AssistantCompactOwner,
  db: DatabaseSync,
  profileId: string,
): void {
  if (!assistantCompactOwnerCurrent(owner, db, profileId) || assistantAuthorizations.has(owner))
    throw new HttpError(423, 'PROFILE_LOCKED', 'Assistant owner changed');
  const original = currentVaultCompactAuthorization(db, profileId);
  if (!original) return;
  const data = compactAuthorizations.get(original)!;
  const authorization = Object.freeze({}) as VaultCompactAuthorization;
  compactAuthorizations.set(authorization, {
    ...data,
    signal: undefined,
    request: undefined,
    batch: undefined,
    job: owner,
  });
  assistantAuthorizations.set(owner, authorization);
}
export function withVaultAssistantAuthorization<T>(owner: AssistantCompactOwner, run: () => T): T {
  const authorization = assistantAuthorizations.get(owner);
  if (!authorization) return compactAuthorizationContext.exit(run);
  const data = compactAuthorizations.get(authorization)!;
  if (!vaultCompactAuthorizationCurrent(authorization, data.db, data.profileId))
    throw new HttpError(423, 'PROFILE_LOCKED', 'Assistant access changed');
  return compactAuthorizationContext.run(authorization, run);
}
const sessionUnlockAuthorizations = new WeakMap<
  object,
  {
    manager: object;
    scope: string;
    sessions: Map<string, Session>;
    client: Session;
    lifecycle: { closed: boolean };
    signal: AbortSignal;
  }
>();

/** Read-only validation of tokens issued by real HTTP session routes. */
export function vaultSessionUnlockAuthorized(
  authorization: object,
  manager: object,
  scope: string,
): boolean {
  const found = sessionUnlockAuthorizations.get(authorization);
  return (
    !!found &&
    found.manager === manager &&
    found.scope === scope &&
    !found.lifecycle.closed &&
    !authorizationSignalAborted(found.signal) &&
    Map.prototype.get.call(found.sessions, found.client.id) === found.client
  );
}
type ProfileCard = ReturnType<ReturnType<typeof createEncryptedProfiles>['card']>;
export function createVaultApp({
  dataDirectory,
  runtimeDirectory,
  allowedOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173'],
  assistantOptions,
  diagnostics = importDiagnostics,
  port = 3001,
  unlockCheckpoint,
}: VaultAppOptions) {
  const manager = createEncryptedProfiles({
      dataDirectory,
      runtimeDirectory,
      diagnostics,
      unlockCheckpoint,
    }),
    passkeys = createProfilePasskeys(manager),
    sessions = new Map<string, Session>();
  let closed = false,
    activation: Promise<unknown> = Promise.resolve();
  const lifecycle = { closed: false };
  const openedProfiles = manager.opened;
  const sessionUnlockAuthorization = (client: Session, scope: string, signal: AbortSignal) => {
    if (closed || sessions.get(client.id) !== client || signal.aborted)
      throw new HttpError(423, 'PROFILE_LOCKED', 'Profile access changed');
    const authorization = Object.freeze({});
    sessionUnlockAuthorizations.set(authorization, {
      manager,
      scope,
      sessions,
      client,
      lifecycle,
      signal,
    });
    return authorization;
  };
  const origins = new Set([
    ...allowedOrigins,
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  function session(req: IncomingMessage, res: ServerResponse) {
    const token = (req.headers.cookie || '')
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('circus-session='))
      ?.slice(15);
    let state = token ? sessions.get(token) : null;
    if (!state) {
      const id = randomBytes(32).toString('base64url');
      state = { id, profiles: new Set() };
      sessions.set(id, state);
      res.setHeader('Set-Cookie', `circus-session=${id}; Path=/; HttpOnly; SameSite=Strict`);
    }
    return state;
  }
  const requireAccess = (id: string, session: Session) => {
    if (!session.profiles.has(id) || !manager.opened.has(id))
      throw new HttpError(423, 'PROFILE_LOCKED', 'Unlock this profile to continue');
  };
  function revokeAndLock(id: string) {
    passkeys.invalidate(id);
    for (const session of sessions.values()) session.profiles.delete(id);
    return manager.lock(id);
  }
  function activate<T extends ProfileCard>(operation: () => T | Promise<T>, client: Session) {
    // Serialize verified switches, not browser prompts. The old profile remains
    // usable until recovery/passkey proof and the new projection have succeeded.
    const next = activation.then(async () => {
      if (closed) throw new HttpError(503, 'STOPPED', 'Application is stopping');
      const previous = new Set(manager.opened.keys());
      let profile: T | undefined;
      try {
        profile = await operation();
        if (closed) throw new HttpError(503, 'STOPPED', 'Application is stopping');
        const errors = [];
        for (const id of [...manager.opened.keys()])
          if (id !== profile.id)
            try {
              revokeAndLock(id);
            } catch (error) {
              errors.push(error);
            }
        if (errors.length)
          throw new HttpError(
            503,
            'PROFILE_SWITCH_FAILED',
            'The previous profile could not finish locking. Profiles were locked; try opening your profile again.',
          );
        if (!manager.opened.has(profile.id))
          throw new HttpError(423, 'PROFILE_LOCKED', 'Unlock this profile to continue');
        client.profiles.add(profile.id);
        profileApp(profile.id);
        return profile;
      } catch (error) {
        // A failed activation must not leave a newly materialized profile or a
        // partially granted session behind. Existing access survives invalid proof.
        for (const id of [...manager.opened.keys()])
          if (id === profile?.id || !previous.has(id))
            try {
              revokeAndLock(id);
            } catch {
              /* lock disposes keys/runtime even if cache persistence fails. */
            }
        throw error;
      }
    });
    activation = next.catch(() => {});
    return next;
  }
  // Only completed enrollments appear in the keyring. This public hint says
  // nothing about whether this browser still has access to the credential.
  function publicCard(p: ProfileCard, session: Session, hostname: string) {
    return {
      ...p,
      locked: !session.profiles.has(p.id) || p.locked,
      hasPasskey: manager.keyring(p.id).passkeys.some((key) => key.rpID === hostname),
    };
  }
  function profileApp(id: string) {
    const state = manager.opened.get(id);
    if (!state) throw new HttpError(423, 'PROFILE_LOCKED', 'Unlock this profile');
    if (!state.app) {
      const app = createApp({
        root: state.root,
        databases: new Map([[id, state.db]]),
        runtimeRoot: state.root,
        port,
        allowedOrigins: [...origins],
        diagnostics,
        assistantOptions: {
          ...assistantOptions,
          journalWriter(root, profileId, chat, reason) {
            if (!manager.opened.has(profileId))
              throw new HttpError(423, 'PROFILE_LOCKED', 'Profile is locked');
            try {
              writeChat(root, profileId, chat, reason);
              manager.flush(profileId, { duringLock: true });
            } catch (error) {
              forgetChatJournal(chat);
              throw error;
            }
          },
        },
        intakeBatchOptions: {
          authorized: (profileId) =>
            manager.opened.has(profileId) &&
            [...sessions.values()].some((session) => session.profiles.has(profileId)),
          journalWriter(root, profileId, batch, reason) {
            if (!manager.opened.has(profileId))
              throw new HttpError(423, 'PROFILE_LOCKED', 'Profile is locked');
            try {
              writeIntakeBatch(root, profileId, batch, reason);
              manager.flush(profileId, { duringLock: true });
            } catch (error) {
              forgetIntakeBatchJournal(batch);
              throw error;
            }
          },
        },
      });
      const descriptor = Object.getOwnPropertyDescriptor(state.db, 'isOpen');
      if (!descriptor?.get || descriptor.configurable)
        throw new HttpError(423, 'PROFILE_LOCKED', 'Profile owner is unavailable');
      state.app = app;
      batchIssuers.set(app.intakeBatches, {
        db: state.db,
        profileId: id,
        sessions,
        opened: openedProfiles,
        state,
        lifecycle,
        isOpen: descriptor.get,
      });
    }
    return state;
  }
  const server = createServer(async (req, res) => {
    try {
      if (closed) throw new HttpError(503, 'STOPPED', 'Application is stopping');
      const host = req.headers.host || '';
      if (
        !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) &&
        ![...origins].some((o) => new URL(o).host === host)
      )
        throw new HttpError(403, 'HOST_REJECTED', 'Local access only');
      if (req.headers.origin && !origins.has(req.headers.origin!))
        throw new HttpError(403, 'ORIGIN_REJECTED', 'Cross-origin requests are not allowed');
      const method = req.method || 'GET',
        mutating = !['GET', 'HEAD'].includes(method);
      const url = new URL(req.url!, `http://${host}`);
      let path;
      try {
        path = '/' + url.pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/');
      } catch {
        throw new HttpError(400, 'INVALID_PATH', 'Invalid request path');
      }
      if (mutating && !origins.has(req.headers.origin!))
        throw new HttpError(403, 'ORIGIN_REQUIRED', 'Writes require the local app origin');
      const client = session(req, res),
        hostname = req.headers.origin ? new URL(req.headers.origin).hostname : url.hostname;
      if (path === '/api/profiles' && method === 'GET') {
        send(res, 200, { data: manager.list().map((p) => publicCard(p, client, hostname)) });
        return;
      }
      if (path === '/api/storage/archive' && method === 'GET') {
        send(res, 200, {
          data: archiveStorageTotals(
            dataDirectory,
            manager.list().map((p) => p.id),
            runtimeDirectory,
          ),
        });
        return;
      }
      if (path === '/api/ai/status' && method === 'GET') {
        send(res, 200, { data: await modelAvailability() });
        return;
      }
      if (path === '/api/ai/test-connection' && method === 'POST') {
        const input = await body(req);
        send(res, 200, {
          data: await testModelConnection({ image: input.image === true, pdf: input.pdf === true }),
        });
        return;
      }
      if (path === '/api/profile-setups/resume' && method === 'POST') {
        const controller = new AbortController(),
          abort = () => {
            if (!res.writableEnded) controller.abort(Error('Setup request was disconnected'));
          };
        res.once('close', abort);
        try {
          send(res, 200, {
            data: await manager.resumeAsync((await body(req)).recovery, {
              signal: controller.signal,
              authorization: sessionUnlockAuthorization(client, 'resume', controller.signal),
              assertAuthorized: () => {
                if (closed || sessions.get(client.id) !== client)
                  throw new HttpError(423, 'PROFILE_LOCKED', 'Profile access changed');
              },
            }),
          });
        } finally {
          res.off('close', abort);
        }
        return;
      }
      if (path === '/api/profile-setups' && method === 'POST') {
        const input = await body(req);
        if (input.copyFrom) requireAccess(input.copyFrom as string, client);
        send(res, 201, { data: manager.begin(input) });
        return;
      }
      const setup = path.match(/^\/api\/profile-setups\/([A-Za-z0-9_-]+)\/verify$/);
      if (setup && method === 'POST') {
        const controller = new AbortController(),
          abort = () => {
            if (!res.writableEnded) controller.abort(Error('Setup request was disconnected'));
          };
        res.once('close', abort);
        try {
          const input = await body(req),
            p = await activate(
              () =>
                manager.verifyAsync(setup[1], input, {
                  authorizeCopySource: (sourceId) => requireAccess(sourceId, client),
                  signal: controller.signal,
                  authorization: sessionUnlockAuthorization(
                    client,
                    'setup:' + setup[1],
                    controller.signal,
                  ),
                  assertAuthorized: () => {
                    if (closed || sessions.get(client.id) !== client)
                      throw new HttpError(423, 'PROFILE_LOCKED', 'Profile access changed');
                  },
                }),
              client,
            );
          send(res, 201, { data: publicCard(p, client, hostname) });
        } finally {
          res.off('close', abort);
        }
        return;
      }
      const match = path.match(/^\/api\/profiles\/(p-[0-9a-f-]+)(?:\/(.*))?$/);
      if (!match) throw new HttpError(404, 'NOT_FOUND', 'Resource not found');
      const [, id, action] = match;
      if (action === 'unlock' && method === 'POST') {
        const input = await body(req);
        const controller = new AbortController();
        const abort = () => {
          if (!res.writableEnded) controller.abort(Error('Unlock request was disconnected'));
        };
        res.once('close', abort);
        try {
          const p = await activate(
            () =>
              manager.unlockAsync(id, input.recovery, {
                signal: controller.signal,
                authorization: sessionUnlockAuthorization(
                  client,
                  'profile:' + id,
                  controller.signal,
                ),
                assertAuthorized: () => {
                  if (closed || sessions.get(client.id) !== client)
                    throw new HttpError(423, 'PROFILE_LOCKED', 'Profile access changed');
                },
              }),
            client,
          );
          send(res, 200, { data: publicCard(p, client, hostname) });
        } finally {
          res.off('close', abort);
        }
        return;
      }
      if (action === 'passkeys/authentication-options' && method === 'POST') {
        await body(req);
        send(res, 200, {
          data: await passkeys.authenticationOptions(id, client.id, req.headers.origin!),
        });
        return;
      }
      if (action === 'passkeys/authenticate' && method === 'POST') {
        const input = await body(req),
          p = await activate(() => passkeys.authenticate(id, client.id, input), client);
        passkeys.recordUse(id, (input.response as { id: string }).id);
        send(res, 200, { data: publicCard(p, client, hostname) });
        return;
      }
      if (action === 'passkeys/cancel' && method === 'POST') {
        send(res, 200, {
          data: passkeys.cancel(id, client.id, (await body(req)) as { challengeId: string }),
        });
        return;
      }
      requireAccess(id, client);
      if (action === 'intakes' && method === 'POST') {
        // File uploads from browsers carry Content-Length. Refuse a known
        // impossible upload before staging its body. Chunked/unknown lengths
        // retain the bounded streaming and storage-failure checks downstream.
        const length = req.headers['content-length'];
        if (typeof length === 'string' && /^(0|[1-9][0-9]*)$/.test(length))
          try {
            assertImportCapacity(importStorageEstimate(length, dataDirectory, runtimeDirectory));
          } catch (error) {
            req.resume();
            throw error;
          }
      }
      if (action === 'passkeys' && method === 'GET') {
        send(res, 200, { data: passkeys.list(id) });
        return;
      }
      if (action === 'passkeys/rename' && method === 'POST') {
        const input = await body(req);
        requireAccess(id, client);
        send(res, 200, { data: passkeys.rename(id, input) });
        return;
      }
      if (action === 'passkeys/remove' && method === 'POST') {
        const input = await body(req);
        requireAccess(id, client);
        send(res, 200, { data: passkeys.remove(id, input) });
        return;
      }
      if (action === 'storage/import-estimate' && method === 'GET') {
        send(res, 200, {
          data: importStorageEstimate(
            url.searchParams.get('bytes'),
            dataDirectory,
            runtimeDirectory,
          ),
        });
        return;
      }
      if (action === 'storage' && method === 'GET') {
        const state = manager.opened.get(id);
        send(res, 200, {
          data: vaultStorageTotals(manager.pathFor(id), state!.vault.metadata(), state!.root),
        });
        return;
      }
      if (action === 'lock' && method === 'POST') {
        await body(req);
        const p = revokeAndLock(id);
        send(res, 200, { data: publicCard(p, client, hostname) });
        return;
      }
      if (action === 'passkeys/options' && method === 'POST') {
        await body(req);
        send(res, 200, {
          data: await passkeys.registrationOptions(id, client.id, req.headers.origin!),
        });
        return;
      }
      if (action === 'passkeys/verify' && method === 'POST') {
        send(res, 200, { data: await passkeys.register(id, client.id, await body(req)) });
        return;
      }
      if (action === 'passkeys/confirm' && method === 'POST') {
        send(res, 200, { data: await passkeys.confirm(id, client.id, await body(req)) });
        return;
      }
      if (!action && method === 'DELETE') {
        const input = await body(req);
        passkeys.invalidate(id);
        const result = manager.remove(id, input);
        for (const s of sessions.values()) s.profiles.delete(id);
        send(res, 200, { data: result });
        return;
      }
      if (!action || action === 'copy' || action === 'backup' || action === 'backups')
        throw new HttpError(
          409,
          'PROFILE_ACTION',
          'Use encrypted profile management for this operation',
        );
      const state = profileApp(id);
      state.requests.add(res);
      const release = () => state.requests.delete(res);
      res.once('close', release);
      res.once('finish', release);
      // Publish private files before any successful application acknowledgment.
      const writeHead = res.writeHead;
      res.writeHead = function (status, ...args) {
        if (status < 400) {
          requireAccess(id, client);
          if (action !== 'import-diagnostics') manager.flush(id);
        }
        return Reflect.apply(writeHead, this, [status, ...args]) as typeof this;
      };
      const controller = new AbortController();
      const requestLifetime = { active: true };
      const abort = () =>
        controller.abort(new HttpError(409, 'REQUEST_CANCELLED', 'The request stopped'));
      req.once('aborted', abort);
      const close = () => {
        requestLifetime.active = false;
        if (!res.writableEnded) abort();
      };
      res.once('close', close);
      res.once('finish', () => {
        requestLifetime.active = false;
        req.off('aborted', abort);
        res.off('close', close);
      });
      const descriptor = Object.getOwnPropertyDescriptor(state.db, 'isOpen');
      if (!descriptor?.get || descriptor.configurable)
        throw new HttpError(423, 'PROFILE_LOCKED', 'Profile owner is unavailable');
      const authorization = Object.freeze({}) as VaultCompactAuthorization;
      compactAuthorizations.set(authorization, {
        db: state.db,
        profileId: id,
        sessions,
        client,
        profiles: client.profiles,
        opened: openedProfiles,
        state,
        lifecycle,
        signal: controller.signal,
        request: requestLifetime,
        isOpen: descriptor.get,
      });
      compactAuthorizationContext.run(authorization, () =>
        state.app!.server.emit('request', req, res),
      );
    } catch (caught) {
      const e = caught as Error & { status?: number; code?: string };
      if (res.headersSent) {
        res.destroy();
        return;
      }
      send(res, e.status || 500, {
        error: {
          code: e.code || 'INTERNAL_ERROR',
          message: e.status ? e.message : 'The encrypted profile operation could not complete.',
        },
      });
    }
  });
  return {
    server,
    manager,
    close() {
      closed = true;
      lifecycle.closed = true;
      server.closeAllConnections();
      for (const p of manager.list()) passkeys.invalidate(p.id);
      try {
        manager.close();
      } finally {
        sessions.clear();
        server.close();
      }
    },
  };
}
