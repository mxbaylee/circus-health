import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

// Exercise the actual browser modules without opening a server or patient DB.
test('profile display-name refresh preserves identity, async requests and latest names', async (t) => {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  t.after(() => server.close());
  const store = await server.ssrLoadModule('/app/data/profile.ts');
  const { api } = await server.ssrLoadModule('/app/data/api.ts');
  const first = { id: 'profile-a', name: 'Original name', placebo: false, nameVersion: 2 };
  const other = { id: 'profile-b', name: 'Other name', placebo: true, nameVersion: 1 };
  store.replaceProfiles([first, other]);
  store.selectProfile(first);
  let switches = 0;
  const unsub = store.subscribeProfileIdentity(() => switches++);
  t.after(unsub);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let resolveRequest!: (value: Response) => void, requestSignal!: AbortSignal;
  globalThis.fetch = async (_url, options) => {
    requestSignal = options!.signal!;
    return new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
  };
  const pending = api('/notes');
  store.recordProfile(first.id, { ...first, name: 'New display name', nameVersion: 3 });
  assert.equal(store.currentProfile().name, 'New display name');
  assert.equal(store.currentProfiles()[0].name, 'New display name');
  assert.equal(switches, 0, 'renaming must not be treated as an identity switch');
  assert.equal(requestSignal.aborted, false, 'in-flight saves, loads and PDF previews stay active');
  resolveRequest(
    new Response(JSON.stringify({ data: [], meta: { profile: first } }), { status: 200 }),
  );
  await pending;
  assert.equal(
    store.currentProfile().name,
    'New display name',
    'late older GET metadata cannot revert the committed name',
  );
  store.replaceProfiles([first, other]);
  assert.equal(
    store.currentProfiles()[0].name,
    'New display name',
    'late registry load cannot revert it either',
  );
  const updated = { ...first, name: 'Newest display name', nameVersion: 4 };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: {}, meta: { profile: updated } }), { status: 200 });
  await api('/notes/example', { method: 'PUT', body: '{}' });
  assert.equal(
    store.currentProfile().name,
    updated.name,
    'successful API response refreshes the name immediately',
  );
  store.recordProfile(first.id, { ...other, name: 'Wrong profile', nameVersion: 100 });
  assert.equal(store.currentProfile().name, updated.name);
  store.selectProfile(other);
  assert.equal(switches, 1);
  store.selectProfile(first); // A stale option object still selects the current stored name.
  assert.equal(store.currentProfile().name, updated.name);
  globalThis.fetch = async (_url, options) =>
    new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    });
  const interrupted = api('/notes');
  store.selectProfile(other);
  await assert.rejects(interrupted, { name: 'AbortError' });
});

test('profile switcher and sidebar render the same name with a separate Self tag', async (t) => {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  t.after(() => server.close());
  const store = await server.ssrLoadModule('/app/data/profile.ts');
  const placebo = { id: 'example-profile', name: 'Moon Crumble', placebo: true, nameVersion: 12 };
  store.replaceProfiles([placebo]);
  store.selectProfile(placebo);
  const { Shell } = await server.ssrLoadModule('/app/components/Shell.tsx');
  const { ThemeProvider } = await server.ssrLoadModule('/app/components/ThemeProvider.tsx');
  const html = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      null,
      createElement(
        MemoryRouter,
        { initialEntries: ['/people?id=person-note%3Aself'] },
        createElement(Shell),
      ),
    ),
  );
  assert.match(html, /class="nav-label">Moon Crumble<\/span><span class="self-tag">Self<\/span>/);
  assert.match(
    html,
    /<button class="profile-current"[^>]*>[\s\S]*?<span>Moon Crumble<\/span><\/button>/,
  );
  assert.match(html, /<span>Circus Health<\/span>/);
  assert.doesNotMatch(
    html,
    />Moon Crumble[^<]*(?:Placebo|Self)</,
    'identity and placebo context are not appended to the actual name',
  );
  assert.match(html, /Moon Crumble · Entirely fictional placebo data/);
});

test('Self identity updates preserve card totals and cannot override a later lock', async (t) => {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  t.after(() => server.close());
  const store = await server.ssrLoadModule('/app/data/profile.ts');
  const card = {
    id: 'fictional',
    name: 'Robin',
    placebo: false,
    nameVersion: 1,
    version: 1,
    locked: false,
    hasPasskey: true,
    storageBytes: 1_200_000,
  };
  store.replaceProfiles([card]);
  store.selectProfile(card);
  store.recordProfile(card.id, {
    id: card.id,
    name: 'Robin Example',
    placebo: false,
    nameVersion: 2,
    version: 2,
  });
  assert.equal(store.currentProfile().storageBytes, 1_200_000);
  assert.equal(store.currentProfiles()[0].hasPasskey, true);
  assert.equal(store.currentProfiles()[0].locked, false);
  store.replaceProfiles([{ ...card, storageBytes: 1_500_000 }]);
  assert.equal(store.currentProfile().name, 'Robin Example');
  assert.equal(
    store.currentProfile().storageBytes,
    1_500_000,
    'new totals apply even with an older identity projection',
  );
  store.replaceProfiles([{ ...card, locked: true, storageBytes: 1_600_000 }]);
  assert.equal(
    store.currentProfile(),
    null,
    'older names must never suppress an authoritative lock',
  );
  store.recordProfile(card.id, { ...card, name: 'Late response', nameVersion: 3 });
  assert.equal(store.currentProfiles()[0].locked, true);
  assert.equal(store.currentProfiles()[0].storageBytes, 1_600_000);
  assert.equal(store.currentProfile(), null);
});
