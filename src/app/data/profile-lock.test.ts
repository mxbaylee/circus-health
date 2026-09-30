import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

test('server profile revocation clears selected private UI state while ordinary errors preserve it', async (t) => {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
  });
  t.after(() => server.close());
  const store = await server.ssrLoadModule('/app/data/profile.ts');
  const { api } = await server.ssrLoadModule('/app/data/api.ts');
  const profile = { id: 'fictional-one', name: 'Fictional Robin', placebo: false, locked: false };
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  store.replaceProfiles([profile]);
  store.selectProfile(profile);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Try again' } }), {
      status: 503,
    });
  await assert.rejects(api('/notes'), { status: 503 });
  assert.equal(store.currentProfile()?.id, profile.id);
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ error: { code: 'PROFILE_LOCKED', message: 'Unlock this profile' } }),
      { status: 423 },
    );
  await assert.rejects(api('/notes'), { name: 'ApiError', code: 'PROFILE_LOCKED', status: 423 });
  assert.equal(store.currentProfile(), null);
  assert.equal(store.currentProfiles()[0].locked, true);
});
