import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createApp, type AppOptions } from './index.ts';
import { vaultStorageTotals } from './vault-storage-totals.ts';
import {
  archiveStorageTotals,
  importStorageEstimate,
  assertImportCapacity,
} from './archive-storage.ts';
import { createEncryptedProfiles } from './encrypted-profiles.ts';
import { importDiagnostics, type ImportDiagnostics } from './import-diagnostics.ts';
import { createProfilePasskeys } from './profile-passkeys.ts';
import { writeChat, forgetChatJournal } from './assistant-journal.ts';
import { writeIntakeBatch } from './intake-batch-journal.ts';
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
}
interface Session {
  id: string;
  profiles: Set<string>;
}
type ProfileCard = ReturnType<ReturnType<typeof createEncryptedProfiles>['card']>;
export function createVaultApp({
  dataDirectory,
  runtimeDirectory,
  allowedOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173'],
  assistantOptions,
  diagnostics = importDiagnostics,
  port = 3001,
}: VaultAppOptions) {
  const manager = createEncryptedProfiles({ dataDirectory, runtimeDirectory, diagnostics }),
    passkeys = createProfilePasskeys(manager),
    sessions = new Map<string, Session>();
  let closed = false,
    activation: Promise<unknown> = Promise.resolve();
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
    if (!state.app)
      state.app = createApp({
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
            writeIntakeBatch(root, profileId, batch, reason);
            manager.flush(profileId, { duringLock: true });
          },
        },
      });
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
        send(res, 200, { data: manager.resume((await body(req)).recovery) });
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
        const input = await body(req),
          p = await activate(
            () =>
              manager.verify(setup[1], input, {
                authorizeCopySource: (sourceId) => requireAccess(sourceId, client),
              }),
            client,
          );
        send(res, 201, { data: publicCard(p, client, hostname) });
        return;
      }
      const match = path.match(/^\/api\/profiles\/(p-[0-9a-f-]+)(?:\/(.*))?$/);
      if (!match) throw new HttpError(404, 'NOT_FOUND', 'Resource not found');
      const [, id, action] = match;
      if (action === 'unlock' && method === 'POST') {
        const input = await body(req),
          p = await activate(() => manager.unlock(id, input.recovery), client);
        send(res, 200, { data: publicCard(p, client, hostname) });
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
      state.app!.server.emit('request', req, res);
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
