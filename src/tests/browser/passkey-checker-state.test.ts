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
      // Seed the original v1 layout directly, before opening it with the new
      // code. Adding diagnostics must preserve old rows and their provenance.
      const legacyName = name + '-legacy';
      const legacyDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(legacyName, 1);
        req.onupgradeneeded = () => {
          for (const table of ['header', 'credentials', 'attempts', 'observations'])
            req.result.createObjectStore(table);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const legacyBuild = { version: '1', revision: 'fictional-original-build', worktree: 'clean' };
      const legacyEnvironment = {
        ...run.environment,
        provider: { value: 'Fictional original provider', source: 'operator' as const },
        providerVersion: { value: 'unknown', source: 'unknown' as const },
      };
      const legacyRun = { ...run, build: legacyBuild, environment: legacyEnvironment };
      const legacyFailure = {
        ...attempt,
        id: 'legacy-prf-failure',
        step: 'confirm' as const,
        status: 'failed' as const,
        error: 'missing-prf' as const,
        finishedAt: new Date().toISOString(),
        build: legacyBuild,
        environment: legacyEnvironment,
      };
      const legacyObservation = {
        ...observation,
        build: legacyBuild,
        environment: legacyEnvironment,
      };
      await new Promise<void>((resolve, reject) => {
        const tx = legacyDb.transaction(
          ['header', 'credentials', 'attempts', 'observations'],
          'readwrite',
        );
        tx.objectStore('header').put({ run: legacyRun, revision: 7 }, 'current');
        tx.objectStore('credentials').put({ alias: 'A', id: 'YQ', salt: 'A'.repeat(43) }, 'A');
        tx.objectStore('attempts').put(legacyFailure, legacyFailure.id);
        tx.objectStore('observations').put(legacyObservation, legacyObservation.id);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      const legacyDatabaseVersion = legacyDb.version;
      legacyDb.close();
      const legacyStore = await openCheckerStore(indexedDB, legacyName);
      const legacySnapshot = (await legacyStore.load())!;
      const diagnostics = {
        requestMode: 'eval' as const,
        inputShape: 'array-buffer' as const,
        inputLength: 32,
        extensionPresent: true,
        resultsPresent: true,
        outputShape: 'array' as const,
        outputLength: 31,
        credentialMatched: true,
      };
      const diagnosticAttempt = {
        ...legacyFailure,
        id: 'fresh-diagnostic-failure',
        error: 'prf-invalid' as const,
        build,
        environment: run.environment,
        diagnostics,
      };
      await legacyStore.commit(legacySnapshot.token, { attempt: diagnosticAttempt });
      legacyStore.close();
      const reopened = await openCheckerStore(indexedDB, legacyName);
      const extended = (await reopened.load())!;
      const legacyRowsPreserved =
        JSON.stringify(extended.state.run) === JSON.stringify(legacyRun) &&
        JSON.stringify(extended.state.attempts.find((row) => row.id === legacyFailure.id)) ===
          JSON.stringify(legacyFailure) &&
        JSON.stringify(extended.state.observations[0]) === JSON.stringify(legacyObservation) &&
        extended.state.attempts.find((row) => row.id === legacyFailure.id)!.diagnostics ===
          undefined;
      const diagnosticsRoundTrip =
        JSON.stringify(
          extended.state.attempts.find((row) => row.id === diagnosticAttempt.id)?.diagnostics,
        ) === JSON.stringify(diagnostics);
      const badDiagnostics = [
        Object.assign(new Date('2026-10-03T00:00:00.000Z'), diagnostics),
        Object.assign(new ArrayBuffer(32), diagnostics),
        Object.assign(new Uint8Array(32), diagnostics),
        { ...diagnostics, credentialId: 'fictional-unknown-secret' },
        { ...diagnostics, raw: new Uint8Array([1, 2, 3]) },
        { ...diagnostics, outputShape: new ArrayBuffer(32) },
        { ...diagnostics, outputLength: -1 },
        { ...diagnostics, outputLength: 1.5 },
        { ...diagnostics, outputLength: 65537 },
        { ...diagnostics, outputLength: Infinity },
        { ...diagnostics, credentialMatched: 'true' },
        { ...diagnostics, requestMode: 'unsupported' },
        { ...diagnostics, inputShape: 'unknown-native-shape' },
      ];
      let invalidDiagnosticsRejected = 0;
      for (const invalid of badDiagnostics) {
        try {
          await reopened.commit(extended.token, {
            attempt: { ...diagnosticAttempt, diagnostics: invalid } as typeof diagnosticAttempt,
          });
        } catch (error) {
          if ((error as { reason: string }).reason === 'incompatible') invalidDiagnosticsRejected++;
        }
      }
      let bReturnRowsRejected = 0;
      for (const change of [
        { attempt: { ...diagnosticAttempt, alias: 'B' as const, step: 'use-after-b' as const } },
        {
          observation: { ...legacyObservation, alias: 'B' as const, step: 'use-after-b' as const },
        },
      ]) {
        try {
          await reopened.commit(extended.token, change);
        } catch (error) {
          if ((error as { reason: string }).reason === 'incompatible') bReturnRowsRejected++;
        }
      }
      const rejectedRowsPreservedRevision =
        (await reopened.load())!.token.revision === extended.token.revision;
      reopened.close();
      const corruptDb = await new Promise<IDBDatabase>((resolve) => {
        const req = indexedDB.open(legacyName, 1);
        req.onsuccess = () => resolve(req.result);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = corruptDb.transaction('attempts', 'readwrite');
        tx.objectStore('attempts').put(
          {
            ...diagnosticAttempt,
            diagnostics: { ...diagnostics, rawResponse: { secret: 'fictional-private' } },
          },
          diagnosticAttempt.id,
        );
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      const incompatibleLegacy = await openCheckerStore(indexedDB, legacyName);
      let corruptDiagnosticsRejected = '';
      try {
        await incompatibleLegacy.load();
      } catch (error) {
        corruptDiagnosticsRejected = (error as { reason: string }).reason;
      }
      incompatibleLegacy.close();
      const corruptRowsRetained = await new Promise<number>((resolve) => {
        const req = corruptDb.transaction('attempts').objectStore('attempts').count();
        req.onsuccess = () => resolve(req.result);
      });
      corruptDb.close();
      await deleteCheckerStore(indexedDB, legacyName);
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
        legacyDatabaseVersion,
        legacyRowsPreserved,
        diagnosticsRoundTrip,
        invalidDiagnosticsRejected,
        bReturnRowsRejected,
        rejectedRowsPreservedRevision,
        corruptDiagnosticsRejected,
        corruptRowsRetained,
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
      legacyDatabaseVersion: 1,
      legacyRowsPreserved: true,
      diagnosticsRoundTrip: true,
      invalidDiagnosticsRejected: 13,
      bReturnRowsRejected: 2,
      rejectedRowsPreservedRevision: true,
      corruptDiagnosticsRejected: 'incompatible',
      corruptRowsRetained: 2,
    });
  },
);
