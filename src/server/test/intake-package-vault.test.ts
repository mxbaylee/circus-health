import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { createReadStream, existsSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import {
  writeLargeFictionalPdf,
  writeLargeStreamedZip,
} from '../../tests/fixtures/large-streamed-zip.ts';
import {
  createIntakePlanRead,
  getIntakeRead,
  uploadIntakeStream,
  verifyIntakeOriginal,
} from '../intake.ts';
import { inventoryIntakePackagePaged, readIntakePackageMember } from '../intake-package.ts';
import { createIntakeFileWorkCounters, withIntakeFileWork } from '../intake-file-work.ts';
import { disposePdfEvidenceSessions } from '../intake-pdf-session.ts';
import { newProfile, vaultFixture } from './helpers/vault-fixture.ts';
import { fictionalModel } from './fictional-model.ts';
import { intakeSourceMetadata } from '../intake-state-access.ts';
import { isIntakeSummary } from '../../shared/intake-summary.ts';
import {
  selectedFixtureHash,
  selectedFixtureValue,
  selectedFixtureOptionalValue,
} from './helpers/selected-intake.ts';
import type { IntakePackageFailure } from '../../shared/intake.ts';

// This exercises encrypted authority and disposable-cache recovery using a
// padded fictional PDF. It does not represent scanned-page/provider quality.
test('streamed large ZIP children and located failures recover from encrypted authority after cache loss', async (t) => {
  fictionalModel(t);
  const f = vaultFixture(t);
  const created = await newProfile(f.manager, 'Fictional encrypted package owner');
  const profileId = created.profile.id;
  let state = f.manager.opened.get(profileId)!;
  t.after(() => disposePdfEvidenceSessions(profileId));
  const pdfPath = join(f.base, 'fictional-large.pdf');
  const pdf = writeLargeFictionalPdf(pdfPath, 26 * 1024 * 1024);
  const zipPath = join(f.base, 'fictional-large.zip');
  const fixture = await writeLargeStreamedZip(zipPath, [
    { name: 'reports/first.pdf', path: pdfPath, store: true },
    { name: 'reports/same-bytes.pdf', path: pdfPath },
    { name: 'reports/waiting.pdf', path: pdfPath },
  ]);
  const intake = await uploadIntakeStream(
    state.db,
    state.root,
    profileId,
    { filename: 'fictional-large.zip', newProviderName: 'Fictional clinic' },
    createReadStream(zipPath, { highWaterMark: 64 * 1024 }) as unknown as IncomingMessage,
  );
  const context = () => ({ db: state.db, root: state.root, profileId, id: intake.id });
  const inventory = await inventoryIntakePackagePaged({ ...context(), offset: 0, limit: 3 });
  assert.equal(inventory.nextOffset, null, 'the three retained occurrences fit one native page');
  const index = {
    ...inventory,
    members: inventory.members.map((member) => {
      assert.ok('filename' in member, 'the short fictional member metadata is fully inline');
      return member;
    }),
  };
  assert.deepEqual(
    index.members.map((m) => m.sourceHash),
    fixture.members.map((m) => m.sourceHash),
  );
  assert.ok(index.members.every((m) => m.bytes > 25 * 1024 * 1024));
  await createIntakePlanRead(state.db, state.root, profileId, intake.id, {
    version: inventory.version,
  });
  const childIds: string[] = [];
  for (const member of index.members.slice(0, 2)) {
    const result = await readIntakePackageMember({
      ...context(),
      memberId: member.memberId,
      page: 2,
    });
    assert.ok('metadata' in result && result.metadata?.sourceFileId);
    childIds.push(result.metadata.sourceFileId);
    const original = verifyIntakeOriginal(
      state.db,
      state.root,
      profileId,
      result.metadata.sourceFileId,
    );
    assert.equal(original.sourceHash, pdf.sourceHash);
    assert.equal(original.size, pdf.bytes);
  }
  assert.equal(new Set(childIds).size, 2, 'identical bytes retain distinct delivery occurrences');
  const waiting = index.members[2]!;
  const open = fs.openSync;
  const injected = t.mock.method(fs, 'openSync', (...args: Parameters<typeof open>) => {
    const fd = open(...args);
    if (
      String(args[0]).includes('.intake-child-staging/') &&
      String(args[0]).endsWith('/original')
    ) {
      fs.closeSync(fd);
      return open(args[0], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    }
    return fd;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      readIntakePackageMember({ ...context(), memberId: waiting.memberId, page: 2 }),
      { status: 503, code: 'PACKAGE_STORAGE' },
    );
  } finally {
    injected.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(
    fs.readdirSync(join(state.root, '.intake-child-staging')),
    [],
    'failed worker writes leave no extraction scratch',
  );
  const snapshot = (id: string) => {
    const header = getIntakeRead(state.db, state.root, profileId, id);
    const path = (field: string) => ['intake', field];
    return {
      id: header.id,
      filename: header.filename,
      parentSourceFileId: header.parentSourceFileId,
      workflow: isIntakeSummary(header)
        ? selectedFixtureHash(state.db, id, path('workflow'))
        : JSON.stringify(header.workflow),
      proposals: isIntakeSummary(header)
        ? selectedFixtureValue(state.db, id, path('proposals'))
        : header.proposals,
      packageFailures: isIntakeSummary(header)
        ? selectedFixtureOptionalValue<Record<string, IntakePackageFailure>>(
            state.db,
            id,
            path('packageFailures'),
          )
        : header.packageFailures,
      acceptedProposalId: isIntakeSummary(header)
        ? selectedFixtureValue(state.db, id, path('acceptedProposalId'))
        : header.acceptedProposalId,
      imported: isIntakeSummary(header)
        ? selectedFixtureValue(state.db, id, path('imported'))
        : header.imported,
    };
  };
  const parentBefore = snapshot(intake.id);
  const childrenBefore = childIds.map(snapshot);
  const failures = Object.values(parentBefore.packageFailures || {});
  assert.equal(failures.length, 1);
  assert.equal(failures[0].operationKey, 'extract:' + waiting.memberId);
  assert.equal(failures[0].filename, waiting.filename);
  assert.equal(failures[0].locator, waiting.locator);
  assert.equal(failures[0].reasonCode, 'PACKAGE_STORAGE');
  assert.equal(failures[0].status, 'pending');
  assert.equal(parentBefore.acceptedProposalId, null);
  assert.equal(parentBefore.imported, null);
  assert.equal(state.db.prepare('SELECT count(*) n FROM source_files').get()!.n, 3);
  f.manager.flush(profileId);
  await disposePdfEvidenceSessions(profileId);
  const plaintextWorkspace = state.workspace;
  assert.equal(existsSync(plaintextWorkspace), true);
  f.manager.lock(profileId);
  assert.equal(f.manager.opened.has(profileId), false);
  assert.equal(
    existsSync(plaintextWorkspace),
    false,
    'lock removes the unlocked plaintext workspace',
  );
  // Remove both all fixture plaintext and the disposable encrypted SQLite cache.
  // Only the profile's committed encrypted originals and journal remain authority.
  rmSync(pdfPath);
  rmSync(zipPath);
  for (let i = 0; i < 3; i++) rmSync(`${zipPath}.${i}.compressed`);
  assert.equal(existsSync(pdfPath), false);
  assert.equal(existsSync(zipPath), false);
  const cache = join(f.manager.pathFor(profileId), 'cache');
  assert.equal(existsSync(cache), true);
  rmSync(cache, { recursive: true, force: true });
  f.manager.unlock(profileId, created.recoveryKit);
  state = f.manager.opened.get(profileId)!;
  assert.equal(state.metrics.cacheHit, false);
  const parentAfter = snapshot(intake.id);
  assert.deepEqual(parentAfter.workflow, parentBefore.workflow);
  assert.deepEqual(parentAfter.packageFailures, parentBefore.packageFailures);
  assert.deepEqual(parentAfter.proposals, parentBefore.proposals);
  assert.equal(parentAfter.acceptedProposalId, parentBefore.acceptedProposalId);
  assert.deepEqual(parentAfter.imported, parentBefore.imported);
  assert.equal(
    verifyIntakeOriginal(state.db, state.root, profileId, intake.id).sourceHash,
    intake.sha256,
  );
  for (const [ordinal, id] of childIds.entries()) {
    const child = snapshot(id);
    assert.equal(child.id, childrenBefore[ordinal]!.id);
    assert.equal(child.filename, index.members[ordinal]!.filename);
    assert.equal(intakeSourceMetadata(state.db, id)?.locator, index.members[ordinal]!.locator);
    assert.equal(child.parentSourceFileId, intake.id);
    assert.deepEqual(child.workflow, childrenBefore[ordinal]!.workflow);
    assert.deepEqual(child.proposals, childrenBefore[ordinal]!.proposals);
    assert.equal(child.acceptedProposalId, null);
    assert.equal(child.imported, null);
    assert.equal(
      verifyIntakeOriginal(state.db, state.root, profileId, id).sourceHash,
      pdf.sourceHash,
    );
  }
  const counters = createIntakeFileWorkCounters();
  const retry = await withIntakeFileWork(counters, () =>
    readIntakePackageMember({ ...context(), memberId: index.members[0]!.memberId, page: 2 }),
  );
  assert.ok('metadata' in retry && retry.metadata?.sourceFileId);
  assert.equal(retry.metadata.sourceFileId, childIds[0]);
  assert.equal(
    counters.writeBytes,
    0,
    'an existing occurrence is verified and reused without staging publication',
  );
  assert.equal(counters.renames, 0);
  assert.equal(state.db.prepare('SELECT count(*) n FROM source_files').get()!.n, 3);
  assert.deepEqual(
    snapshot(intake.id).packageFailures,
    parentBefore.packageFailures,
    'successful unrelated occurrence does not clear the pending failure',
  );
  const resumed = await readIntakePackageMember({
    ...context(),
    memberId: waiting.memberId,
    page: 2,
  });
  assert.ok('metadata' in resumed && resumed.metadata?.sourceFileId);
  assert.ok(!childIds.includes(resumed.metadata.sourceFileId));
  assert.equal(
    verifyIntakeOriginal(state.db, state.root, profileId, resumed.metadata.sourceFileId).sourceHash,
    pdf.sourceHash,
  );
  const completed = snapshot(intake.id);
  assert.equal(Object.values(completed.packageFailures || {}).length, 0);
  assert.deepEqual(completed.workflow, parentBefore.workflow);
  assert.equal(completed.acceptedProposalId, null);
  assert.equal(completed.imported, null);
  assert.equal(state.db.prepare('SELECT count(*) n FROM source_files').get()!.n, 4);
  assert.deepEqual(
    fs.readdirSync(join(state.root, '.intake-child-staging')),
    [],
    'successful publication leaves no extraction scratch',
  );
});
