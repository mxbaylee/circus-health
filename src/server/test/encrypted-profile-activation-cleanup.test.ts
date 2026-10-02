import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEncryptedProfiles, type OpenedProfile } from '../encrypted-profiles.ts';
import { createImportDiagnostics } from '../import-diagnostics.ts';
import type { PerformanceSummaryStore } from '../import-performance.ts';
import type { DiagnosticChunkStore } from '../diagnostic-chunk-store.ts';
import { createNote, getNote } from '../notes.ts';
import { newProfile } from './helpers/vault-fixture.ts';

function vaultFiles(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  function visit(relative: string) {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) visit(path);
      else
        files[path] = createHash('sha256')
          .update(readFileSync(join(directory, path)))
          .digest('hex');
    }
  }
  visit('');
  return files;
}

for (const phase of ['activation', 'unlock'] as const)
  for (const cleanupThrows of [false, true])
    test(`${phase} disposes partially installed diagnostic stores even when cleanup ${cleanupThrows ? 'throws' : 'succeeds'}`, async (t) => {
      const base = mkdtempSync(join(tmpdir(), 'fictional-activation-cleanup-'));
      const dataDirectory = join(base, 'data'),
        runtimeDirectory = join(base, 'runtime');
      mkdirSync(dataDirectory);
      const diagnostics = createImportDiagnostics({ enabled: false });
      const summaries = new Map<string, PerformanceSummaryStore>();
      const events = new Map<string, DiagnosticChunkStore>();
      const attachSummary = diagnostics.attachSummaryStore.bind(diagnostics),
        attachEvents = diagnostics.attachEventStore.bind(diagnostics),
        detach = diagnostics.detachSummaryStore.bind(diagnostics);
      let faultProfile: string | undefined,
        failedState: OpenedProfile | undefined,
        failedSummary: PerformanceSummaryStore | undefined,
        failedEvents: DiagnosticChunkStore | undefined,
        acceptedHead: Buffer | null = null,
        acceptedFiles: Record<string, string> | undefined;
      const manager = createEncryptedProfiles({ dataDirectory, runtimeDirectory, diagnostics });
      t.after(() => {
        faultProfile = undefined;
        manager.close();
        diagnostics.close();
        rmSync(base, { recursive: true, force: true });
      });
      diagnostics.attachSummaryStore = (id, store) => {
        summaries.set(id, store);
        attachSummary(id, store);
      };
      diagnostics.attachEventStore = (id, store) => {
        events.set(id, store);
        attachEvents(id, store);
        if (id === faultProfile) {
          failedState = manager.opened.get(id)!;
          failedSummary = summaries.get(id)!;
          failedEvents = store;
          acceptedHead = failedState.recordStorage.read('head');
          acceptedFiles = vaultFiles(join(manager.pathFor(id), 'vault'));
          throw Error('Fictional diagnostics installation failure');
        }
      };
      diagnostics.detachSummaryStore = (id) => {
        detach(id);
        summaries.delete(id);
        events.delete(id);
        if (cleanupThrows && id === faultProfile)
          throw Error('Fictional diagnostics cleanup failure');
      };
      const source = await newProfile(manager, 'Fictional cleanup source');
      const note = createNote(manager.opened.get(source.profile.id)!.db, {
        kind: 'note',
        title: 'Fictional retained copy note',
        content: 'Fictional authority retained after activation failure.',
      });
      const copy = manager.begin({ name: 'Fictional cleanup target', copyFrom: source.profile.id });
      const verification = { acknowledged: true, recovery: copy.recoveryKit };
      if (phase === 'unlock') {
        await manager.verify(copy.setupId, verification);
        manager.lock(copy.profileId);
      }
      faultProfile = copy.profileId;
      await assert.rejects(
        async () => {
          if (phase === 'activation') await manager.verify(copy.setupId, verification);
          else manager.unlock(copy.profileId, copy.recoveryKit);
        },
        (error: unknown) => {
          if (cleanupThrows) {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(
              error.errors.map((item: Error) => item.message),
              [
                'Fictional diagnostics installation failure',
                'Fictional diagnostics cleanup failure',
              ],
            );
          } else assert.match(String(error), /Fictional diagnostics installation failure/);
          return true;
        },
      );
      assert.ok(failedState && failedSummary && failedEvents && acceptedHead && acceptedFiles);
      assert.equal(manager.opened.has(copy.profileId), false);
      assert.equal(failedState.db.isOpen, false);
      assert.ok(failedState.key.every((byte) => byte === 0));
      assert.equal(existsSync(join(runtimeDirectory, copy.profileId)), false);
      assert.equal(summaries.has(copy.profileId), false);
      assert.equal(events.has(copy.profileId), false);
      assert.throws(() => failedSummary!.read(), /locked/i);
      assert.throws(() => failedEvents!.inventory(), /locked|closed/i);
      assert.equal(diagnostics.recordClientOperation(copy.profileId, {}), false);
      assert.deepEqual(vaultFiles(join(manager.pathFor(copy.profileId), 'vault')), acceptedFiles);
      assert.equal(manager.card(copy.profileId).locked, true);

      faultProfile = undefined;
      manager.lock(source.profile.id);
      const resumed = await manager.verify(copy.setupId, verification, {
        authorizeCopySource() {
          assert.fail('Published target recovery must not request source authorization');
        },
      });
      assert.equal(resumed.id, copy.profileId);
      const recovered = manager.opened.get(copy.profileId)!;
      assert.deepEqual(recovered.recordStorage.read('head'), acceptedHead);
      assert.equal(getNote(recovered.db, note.id).content, note.content);
    });
