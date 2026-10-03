import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';

test(
  'checker IndexedDB retains row evidence, rejects stale writes and corruption without resetting',
  { timeout: 60000 },
  async (t) => {
    const vite = await createViteServer({
      configFile: false,
      root: process.cwd(),
      publicDir: false,
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: 'custom',
    });
    const server = createHttpServer((req, res) => {
      if (req.url === '/fixture') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><title>Fictional checker storage fixture</title>');
      } else
        vite.middlewares(req, res, () => {
          res.statusCode = 404;
          res.end();
        });
    });
    t.after(async () => {
      await vite.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true, timeout: 15000 });
    t.after(() => browser.close());
    t.signal.addEventListener(
      'abort',
      () => {
        void browser.close();
      },
      { once: true },
    );
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/fixture`);
    const evidence = await page.evaluate(async () => {
      const moduleRoot = '/src/app/passkey-checker/';
      const { openCheckerStore, deleteCheckerStore } = (await import(
        moduleRoot + 'store.ts'
      )) as typeof import('../../app/passkey-checker/store.ts');
      const { createCheckerController } = (await import(
        moduleRoot + 'controller.ts'
      )) as typeof import('../../app/passkey-checker/controller.ts');
      const { createRun, inspectEnvironment } = (await import(
        moduleRoot + 'environment.ts'
      )) as typeof import('../../app/passkey-checker/environment.ts');
      const build = { version: 'fixture', revision: 'fictional-build', worktree: 'clean' };
      const name = 'fictional-checker-state-test';
      const open = () => openCheckerStore(indexedDB, name);
      const store = await open();
      const empty = await store.load();
      const run = createRun(build, inspectEnvironment());
      const token = await store.commit(null, { run });
      const attempt = {
        id: 'fictional-attempt',
        alias: 'A' as const,
        step: 'create' as const,
        status: 'pending' as const,
        startedAt: new Date().toISOString(),
        build,
        environment: run.environment,
      };
      await store.commit(token, { attempt });
      store.close();
      const controller = await createCheckerController({ build, openStore: open });
      const interrupted = controller.exportModel().attempts[0].status;
      const first = await open();
      const second = await open();
      const firstSnapshot = (await first.load())!;
      const secondSnapshot = (await second.load())!;
      const observation = {
        id: 'fictional-observation',
        alias: 'A' as const,
        step: 'general' as const,
        outcome: 'could-not-test' as const,
        note: 'Fictional controlled-development observation',
        createdAt: new Date().toISOString(),
        build,
        environment: run.environment,
      };
      await first.commit(firstSnapshot.token, { observation });
      let conflict = '';
      try {
        await second.commit(secondSnapshot.token, { observation: { ...observation, id: 'stale' } });
      } catch (error) {
        conflict = (error as { reason: string }).reason;
      }
      const retained = (await first.load())!;
      let malformedSalt = '';
      try {
        await first.commit(retained.token, {
          credential: { alias: 'A', id: 'YQ', salt: 'A'.repeat(42) + 'B' },
        });
      } catch (error) {
        malformedSalt = (error as { reason: string }).reason;
      }
      const untouchedRevision = (await first.load())!.token.revision === retained.token.revision;
      first.close();
      second.close();
      controller.close();
      // Mutate one raw row to simulate an incompatible stored schema; opening it must not erase anything.
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('header', 'readwrite');
        tx.objectStore('header').put(
          { run: { ...retained.state.run, schemaVersion: 99 }, revision: retained.token.revision },
          'current',
        );
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
      const blocked = await createCheckerController({
        build,
        openStore: open,
        deleteStore: () => deleteCheckerStore(indexedDB, name),
      });
      const incompatible = blocked.getSnapshot().storage;
      const raw = await new Promise<IDBDatabase>((resolve) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
      });
      const untouched = await new Promise<number>((resolve) => {
        const req = raw.transaction('observations').objectStore('observations').count();
        req.onsuccess = () => resolve(req.result);
      });
      raw.close();
      await blocked.reset();
      const reset = blocked.getSnapshot().storage;
      const resetAttempts = blocked.exportModel().attempts.length;
      blocked.close();
      const held = await new Promise<IDBDatabase>((resolve) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
      });
      let deletionBlocked = false;
      await deleteCheckerStore(indexedDB, name, () => {
        deletionBlocked = true;
        held.close();
      });
      const futureName = name + '-future';
      const future = await new Promise<IDBDatabase>((resolve) => {
        const req = indexedDB.open(futureName, 2);
        req.onsuccess = () => resolve(req.result);
      });
      future.close();
      let futureSchema = '';
      try {
        await openCheckerStore(indexedDB, futureName);
      } catch (error) {
        futureSchema = (error as { reason: string }).reason;
      }
      await deleteCheckerStore(indexedDB, futureName);
      return {
        empty,
        interrupted,
        conflict,
        retainedObservations: retained.state.observations.length,
        retainedAttempts: retained.state.attempts.length,
        incompatible,
        untouched,
        reset,
        resetAttempts,
        deletionBlocked,
        futureSchema,
        malformedSalt,
        untouchedRevision,
      };
    });
    assert.deepEqual(evidence, {
      empty: null,
      interrupted: 'interrupted',
      conflict: 'conflict',
      retainedObservations: 1,
      retainedAttempts: 1,
      incompatible: 'incompatible',
      untouched: 1,
      reset: 'saved',
      resetAttempts: 0,
      deletionBlocked: true,
      futureSchema: 'incompatible',
      malformedSalt: 'incompatible',
      untouchedRevision: true,
    });
  },
);
