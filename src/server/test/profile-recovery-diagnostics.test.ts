import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEncryptedProfiles } from '../encrypted-profiles.ts';
import { createImportDiagnostics } from '../import-diagnostics.ts';
import { newProfile } from './helpers/vault-fixture.ts';

for (const observerThrows of [false, true])
  test(`encrypted cache-loss recovery emits distinct stages with observerThrows=${observerThrows}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-recovery-phases-'));
    const dataDirectory = join(root, 'data');
    mkdirSync(dataDirectory);
    const events: Array<{ event: string; phase: string }> = [];
    const diagnostics = createImportDiagnostics({ enabled: true });
    const record = diagnostics.record;
    diagnostics.record = (event, fields, context) => {
      if (typeof fields?.phase === 'string' && fields.phase.startsWith('profile_')) {
        events.push({ event, phase: fields.phase });
        if (observerThrows) throw Error('fictional optional observer failure');
      }
      record(event, fields, context);
    };
    const manager = createEncryptedProfiles({
      dataDirectory,
      runtimeDirectory: join(root, 'runtime'),
      diagnostics,
    });
    t.after(() => {
      try {
        manager.close();
      } finally {
        diagnostics.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    const setup = await newProfile(manager, 'Fictional recovery-stage person');
    const profileId = setup.profile.id;
    const before = manager.opened
      .get(profileId)!
      .db.prepare('SELECT * FROM people ORDER BY id')
      .all();
    manager.lock(profileId);
    rmSync(join(dataDirectory, 'profiles', profileId, 'cache'), { recursive: true });
    events.length = 0;
    manager.unlock(profileId, setup.recoveryKit);
    assert.equal(manager.opened.get(profileId)!.metrics.cacheHit, false);
    assert.deepEqual(
      manager.opened.get(profileId)!.db.prepare('SELECT * FROM people ORDER BY id').all(),
      before,
    );
    assert.deepEqual(
      events,
      [
        'profile_vault_open',
        'profile_workspace_materialize',
        'profile_record_replay',
        'profile_intake_validation',
        'profile_durability_attach',
        'profile_runtime_install',
      ].flatMap((phase) => [
        { event: 'import.phase.started', phase },
        { event: 'import.phase.completed', phase },
      ]),
    );
  });
