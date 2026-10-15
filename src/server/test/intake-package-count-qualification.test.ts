import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { newProfile, vaultFixture } from './helpers/vault-fixture.ts';
import { fictionalModel } from './fictional-model.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import { createIntakePlanRead, uploadIntakeStream } from '../intake.ts';
import { isIntakeSummary } from '../../shared/intake-summary.ts';
import {
  buildDurablePackageInventory,
  readDurablePackageInventory,
} from '../intake-package-state.ts';
import {
  createPagedPackagePlan,
  readPackagePlanScope,
  readPackageUnitPage,
  savePagedPackageRoles,
} from '../intake-package-plan.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { clearPackageSourceSession, packageSourceSessionWork } from '../intake-package-session.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';

// The extended harness budget allows counted host work and encrypted recovery;
// it is not a performance target. Counts and exact recovered evidence are the
// qualification criteria, with cache reconstruction measured separately.
test(
  'native encrypted package crosses all legacy count safeguards, resumes exact occurrences and recovers without SQLite',
  { timeout: 1_800_000 },
  async (t) => {
    fictionalModel(t);
    const f = vaultFixture(t),
      created = await newProfile(f.manager, 'Fictional collection qualification'),
      profileId = created.profile.id,
      fileCount = 5001,
      name = (ordinal: number) => `fictional/${ordinal}-` + 'x'.repeat(450) + '.txt';
    let state = f.manager.opened.get(profileId)!;
    const entries = Array.from({ length: fileCount }, (_, ordinal) => ({
      name: name(ordinal),
      data: ordinal < 2 ? 'same fictional occurrence bytes' : `fictional ${ordinal}`,
    }));
    for (let ordinal = 0; ordinal < fileCount; ordinal++)
      entries.push({ name: `fictional-directories/${ordinal}/`, data: '' });
    assert.ok(entries.length > 10000);
    assert.ok(
      entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.name), 0) > 2 * 1024 * 1024,
    );
    const archive = zipFixture(entries);
    const intake = await uploadIntakeStream(
      state.db,
      state.root,
      profileId,
      {
        filename: 'fictional-complete-collection.zip',
        newProviderName: 'Fictional collection clinic',
      },
      Object.assign(Readable.from([archive]), {
        headers: { 'content-length': String(archive.length) },
      }) as unknown as IncomingMessage,
    );
    assert.ok(isIntakeSummary(intake));
    assert.equal('workflow' in intake, false);
    const context = () => ({
      db: state.db,
      root: state.root,
      profileId,
      id: intake.id,
      rawDomainVersion: intakeSourceVersion(state.db, intake.id).rawVersion,
    });
    let retainedAtCancellation = 0;
    await assert.rejects(
      buildDurablePackageInventory(context(), {
        onProgress(work) {
          if (work.verifiedRecords >= 24) {
            retainedAtCancellation = work.verifiedRecords;
            throw Error('Fictional inventory interruption');
          }
        },
      }),
      /Fictional inventory interruption/,
    );
    assert.ok(retainedAtCancellation >= 24);
    assert.equal(readDurablePackageInventory(context()), undefined);
    const coldWork = createRecordVersionWorkCounters();
    const built = await withRecordVersionWork(coldWork, () =>
      buildDurablePackageInventory(context(), {
        onProgress(work) {
          if (work.checkpoints % 100 === 0)
            t.diagnostic(
              `Count qualification: ${work.verifiedRecords} verified, ${work.checkpoints} bounded checkpoints`,
            );
        },
      }),
    );
    assert.equal(built.inventory.summary.entries, 10002);
    assert.equal(built.inventory.summary.members, fileCount);
    assert.ok(built.work.reusedRecords >= retainedAtCancellation);
    assert.equal(built.work.verifiedRecords + built.work.reusedRecords, fileCount);
    assert.ok(built.work.peakCheckpointEdits <= 60);
    assert.ok(built.work.peakCheckpointEncodedBytes <= 32768);
    assert.ok(built.spoolWork!.peakBatchBytes <= 32768);
    const first = built.inventory.member(0)!,
      second = built.inventory.member(1)!,
      last = built.inventory.member(fileCount - 1)!;
    assert.notEqual(first.filename, second.filename);
    assert.equal(first.sourceHash, second.sourceHash);
    assert.notEqual(first.memberId, second.memberId);
    assert.equal(last.filename, name(fileCount - 1));
    const planInput = { version: intake.version, operationId: 'fictional-count-plan' };
    const publicPlan = await createIntakePlanRead(
      state.db,
      state.root,
      profileId,
      intake.id,
      planInput,
    );
    assert.ok(isIntakeSummary(publicPlan));
    assert.equal(publicPlan.activePlan.state, 'exact');
    assert.equal(publicPlan.activePlan.plan?.unitCount, fileCount);
    const planned = await createPagedPackagePlan(
      state.db,
      state.root,
      profileId,
      intake.id,
      planInput,
    );
    assert.equal(planned.plan.unitCount, fileCount);
    const before = intakeWorkCounters(state.db),
      hashed = packageSourceSessionWork(state.db)!.coldHashBytes;
    const lastPage = readPackageUnitPage(state.db, state.root, profileId, intake.id, {
      offset: fileCount - 2,
      limit: 2,
    });
    assert.equal(lastPage.units.length, 2);
    assert.equal(lastPage.nextOffset, null);
    const replay = await createPagedPackagePlan(
      state.db,
      state.root,
      profileId,
      intake.id,
      planInput,
    );
    assert.equal(replay.plan.id, planned.plan.id);
    assert.equal(replay.replayed, true);
    const after = intakeWorkCounters(state.db);
    assert.equal(after.warm.packagePlanUnitIds, before.warm.packagePlanUnitIds);
    assert.equal(after.warm.envelopeHydrations, before.warm.envelopeHydrations);
    assert.equal(after.warm.sourceDTOHydrations, before.warm.sourceDTOHydrations);
    assert.equal(packageSourceSessionWork(state.db)!.coldHashBytes, hashed);
    const roles = [
      {
        memberId: last.memberId,
        role: 'clinical' as const,
        reason: 'Fictional selected report',
        coverage: 'pending' as const,
        references: [],
      },
    ];
    await savePagedPackageRoles(state.db, state.root, profileId, intake.id, {
      version: planned.version,
      planId: planned.plan.id,
      roles,
      operationId: 'fictional-count-role',
    });
    const beforeRecovery = readPackagePlanScope(state.db, state.root, profileId, intake.id)!;
    const recoveredExpected = {
      planId: beforeRecovery.planId,
      first: beforeRecovery.unit(first.memberId),
      second: beforeRecovery.unit(second.memberId),
      last: beforeRecovery.unit(last.memberId),
    };
    f.manager.flush(profileId);
    const plaintext = state.workspace;
    clearPackageSourceSession(state.db);
    clearIntakeStateCache(state.db);
    f.manager.lock(profileId);
    assert.equal(existsSync(plaintext), false);
    rmSync(join(f.manager.pathFor(profileId), 'cache'), { recursive: true, force: true });
    f.manager.unlock(profileId, created.recoveryKit);
    state = f.manager.opened.get(profileId)!;
    assert.equal(state.metrics.cacheHit, false);
    const recovered = readPackagePlanScope(state.db, state.root, profileId, intake.id)!;
    assert.deepEqual(
      {
        planId: recovered.planId,
        first: recovered.unit(first.memberId),
        second: recovered.unit(second.memberId),
        last: recovered.unit(last.memberId),
      },
      recoveredExpected,
    );
    assert.equal(readDurablePackageInventory(context())!.summary.members, fileCount);
    const afterRecoveryReplay = await createPagedPackagePlan(
      state.db,
      state.root,
      profileId,
      intake.id,
      planInput,
    );
    assert.equal(afterRecoveryReplay.plan.id, planned.plan.id);
    assert.equal(afterRecoveryReplay.replayed, true);
    t.diagnostic(
      JSON.stringify({
        files: fileCount,
        entries: entries.length,
        inventory: built.work,
        traversal: built.traversalWork,
        spool: built.spoolWork,
        coldRecordWork: coldWork,
      }),
    );
  },
);
