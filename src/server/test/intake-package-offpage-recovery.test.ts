import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { attachPersonalDurability, rebuildProfile } from '../portable.ts';
import { createBackup } from '../recovery.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import {
  getIntakeRead,
  getIntakeReportSourceReviewRead,
  importIntakeRead,
  reviewIntakeRead,
  submitPagedIntakeBatch,
  uploadIntake,
} from '../intake.ts';
import { confirmIntakeIdentityScope, getIntakeIdentityReview } from '../intake-identity.ts';
import { inventoryIntakePackagePaged, readIntakePackageMemberPaged } from '../intake-package.ts';
import {
  createPagedPackagePlan,
  readPackagePlanScope,
  readPackageUnitPage,
  saveIntakePackageRolesRead,
} from '../intake-package-plan.ts';
import { openImplicitPackageModelUnits } from '../intake-model-package-units.ts';
import { openIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { clearPackageSourceSession } from '../intake-package-session.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import { isIntakeSummary } from '../../shared/intake-summary.ts';
import type { IntakeReviewRecord } from '../../shared/intake.ts';
import { fictionalModel } from './fictional-model.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';

test(
  'off-page package evidence survives clinical review, backup rebuild and exact retries',
  { timeout: 300_000 },
  async (t) => {
    fictionalModel(t);
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-package-offpage-')));
    const profileId = 'fictional-offpage';
    const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    attachPersonalDurability(db, { root, profileId });
    t.after(() => {
      clearPackageSourceSession(db);
      clearIntakeStateCache(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const archive = zipFixture(
      Array.from({ length: 61 }, (_, ordinal) => ({
        name: `fictional/${ordinal}.txt`,
        data:
          ordinal === 0 || ordinal === 60
            ? 'Report F27 12.00\nPatient: Fictional Example'
            : `Fictional ${ordinal}`,
      })),
    );
    const intake = uploadIntake(db, root, profileId, {
      filename: 'fictional-offpage.zip',
      newProviderName: 'Fictional clinic',
      bytes: archive,
    });
    const planInput = { version: intake.version, operationId: 'fictional-offpage-plan' };
    const plan = await createPagedPackagePlan(db, root, profileId, intake.id, planInput);
    let inventoryOffset = 0;
    let inventoryPages = 0;
    let inventoryMembers = 0;
    let lateListed = false;
    for (;;) {
      const page = await inventoryIntakePackagePaged({
        db,
        root,
        profileId,
        id: intake.id,
        offset: inventoryOffset,
        limit: 50,
      });
      inventoryPages++;
      inventoryMembers += page.members.length;
      if (inventoryPages === 1) assert.ok(!page.members.some((member) => member.ordinal === 60));
      lateListed ||= page.members.some((member) => member.ordinal === 60);
      if (page.nextOffset === null) break;
      assert.ok(page.nextOffset > inventoryOffset);
      inventoryOffset = page.nextOffset;
    }
    assert.ok(inventoryPages > 1);
    assert.equal(inventoryMembers, 61);
    assert.equal(lateListed, true);
    const firstPage = readPackageUnitPage(db, root, profileId, intake.id, { limit: 50 });
    assert.equal(firstPage.total, 61);
    assert.equal(firstPage.units.length, 50);
    assert.equal(firstPage.nextOffset, 50);
    const lastPage = readPackageUnitPage(db, root, profileId, intake.id, {
      offset: firstPage.nextOffset!,
      limit: 50,
    });
    assert.equal(lastPage.units.length, 11);
    assert.equal(lastPage.nextOffset, null);
    const scope = readPackagePlanScope(db, root, profileId, intake.id)!;
    const first = scope.inventory.member(0)!;
    const late = scope.inventory.member(60)!;
    assert.equal(late.ordinal, 60);
    assert.equal(late.filename, 'fictional/60.txt');
    assert.equal(first.sourceHash, late.sourceHash);
    assert.notEqual(first.memberId, late.memberId);
    const lateUnit = scope.unit(late.memberId)!;
    assert.equal(lastPage.units.at(-1)!.id, lateUnit.id);

    const model = openImplicitPackageModelUnits(db, root, profileId, intake.id)!;
    const provider = model.sectionProvider('units')!;
    const modelSection = provider.section('units');
    assert.equal(modelSection.state, 'complete');
    if (modelSection.state !== 'complete') throw Error('Expected complete selected model scope');
    assert.equal(modelSection.count, 61);
    let after: string | undefined;
    let seen = 0;
    do {
      const page = provider.sectionPage('units', { after, items: 8, bytes: 10000 });
      assert.ok(page.entries.length <= 8);
      seen += page.entries.length;
      after = page.after ?? undefined;
      if (page.complete) break;
    } while (after);
    assert.equal(seen, 61);
    assert.equal(model.currentUnits().total, 61);

    const roleInput = {
      version: plan.version,
      planId: plan.plan.id,
      operationId: 'fictional-offpage-role',
      roles: [
        {
          memberId: late.memberId,
          role: 'clinical' as const,
          reason: 'Fictional selected report',
          coverage: 'pending' as const,
          references: [],
        },
      ],
    };
    const role = await saveIntakePackageRolesRead(db, root, profileId, intake.id, roleInput);
    assert.equal(
      readPackagePlanScope(db, root, profileId, intake.id)!.memberState(late.memberId)!.role?.role,
      'clinical',
    );
    const batchInput = {
      version: role.version,
      planId: plan.plan.id,
      operationId: 'fictional-offpage-batch',
      summary: 'Fictional off-page report',
      jsonlText: JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-offpage-record',
        kind: 'record',
        payload: { literal: 'Report F27 12.00' },
        provenance: {
          capturedVia: 'Fictional delivery',
          sourceSystem: 'Fictional clinic',
          sourceRecordId: 'fictional-offpage-record',
          evidenceClass: 'provider_export',
          locator: 'ZIP member fictional/60.txt',
        },
        coverage: { status: 'complete_response', notes: [] },
        clinical: {
          kind: 'observation',
          subject: 'self',
          testLabel: 'Example',
          valueText: '12.00',
          unit: 'mg',
          date: '2026-09',
        },
        report: {
          key: 'fictional-offpage-report',
          title: 'Fictional off-page report',
          memberId: late.memberId,
          anchor: { locator: 'ZIP member fictional/60.txt', text: 'Report F27' },
          subject: {
            locator: 'ZIP member fictional/60.txt',
            text: 'Patient: Fictional Example',
          },
        },
      }),
      coverage: [
        { unitId: lateUnit.id, kind: 'extracted' as const, notes: 'Fictional evidence read' },
      ],
    };
    const before = intakeWorkCounters(db).warm;
    const batched = await submitPagedIntakeBatch(db, root, profileId, intake.id, batchInput);
    assert.ok(isIntakeSummary(batched));
    if (!isIntakeSummary(batched)) throw Error('Expected native summary');
    assert.equal(batched.collections.reportGroups.total, 1);
    assert.equal(
      readPackagePlanScope(db, root, profileId, intake.id)!.unitById(lateUnit.id)!.attemptCount,
      1,
    );
    const source = db
      .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
      .get(intake.id)!;
    const view = openIntakeCollectionEnvelope(db, source as never);
    const workflow = view.child(view.child(view.root(), 'intake')!, 'workflow')!;
    const proposal = view.childAt(view.child(view.root(), 'intake')!, 'proposals', 0)!;
    const proposalIdField = view.field(proposal, 'id');
    const group = view.childAt(workflow, 'reportGroups', 0)!;
    const groupIdField = view.field(group, 'id');
    if (
      proposalIdField.kind !== 'value' ||
      typeof proposalIdField.value !== 'string' ||
      groupIdField.kind !== 'value' ||
      typeof groupIdField.value !== 'string'
    ) {
      throw Error('Expected selected proposal and report group IDs');
    }
    const proposalId = proposalIdField.value;
    const groupId = groupIdField.value;
    const reportReview = await getIntakeReportSourceReviewRead(
      db,
      root,
      profileId,
      intake.id,
      groupId,
      'all',
      { limit: 1 },
    );
    assert.ok(
      'format' in reportReview && reportReview.format === 'health-intake-report-source-review-v2',
    );
    if (!('format' in reportReview)) throw Error('Expected bounded report source review');
    assert.equal(reportReview.targets.total, 1);
    const retainedMember = await readIntakePackageMemberPaged({
      db,
      root,
      profileId,
      id: intake.id,
      memberId: late.memberId,
    });
    assert.ok(retainedMember.sourceFileId);
    const identity = await getIntakeIdentityReview(db, root, profileId, intake.id, groupId);
    assert.equal(identity.scopeReference?.groupId, groupId);
    const identityInput = {
      version: identity.scopeReference!.intakeVersion,
      operationId: 'fictional-offpage-identity',
      scope: identity.scopeReference!,
      outcome: 'this_is_me' as const,
      attestation: 'confirmed_displayed_report_subject' as const,
      selfUpdate: {
        expectedVersion: identity.self.version,
        fields: identity.offeredSelfFields,
      },
    };
    await confirmIntakeIdentityScope(db, root, profileId, intake.id, identityInput);
    assert.equal(
      (await getIntakeIdentityReview(db, root, profileId, intake.id, groupId)).status,
      'prior_confirmation',
    );
    const page = await reviewIntakeRead(db, root, profileId, intake.id, proposalId);
    if (
      !('format' in page) ||
      page.format !== 'health-intake-clinical-review-page-v2' ||
      page.items[0]?.kind !== 'value'
    )
      throw Error('Expected selected clinical review');
    const record = page.items[0].value as IntakeReviewRecord;
    const acceptance = {
      version: page.version,
      proposalId,
      reviewToken: page.reviewToken,
      decisions: [{ recordId: record.id, action: 'accept' as const, mapping: record.mapping }],
    };
    const accepted = await importIntakeRead(db, root, profileId, intake.id, acceptance);
    assert.equal(accepted.version, acceptance.version + 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observations').get()!.n, 1);
    assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.envelopeHydrations);

    const backup = await createBackup(db, root, profileId);
    const recoveredRoot = join(root, 'recovered');
    const recovered = rebuildProfile(join(backup.path, 'files'), profileId, recoveredRoot);
    const recoveredDb = openDatabase(recovered.database, profileId);
    attachPersonalDurability(recoveredDb, { root: recoveredRoot, profileId });
    try {
      const recoveredScope = readPackagePlanScope(
        recoveredDb,
        recoveredRoot,
        profileId,
        intake.id,
      )!;
      assert.equal(recoveredScope.inventory.summary.members, 61);
      assert.equal(recoveredScope.inventory.member(60)!.memberId, late.memberId);
      assert.equal(recoveredScope.memberState(late.memberId)!.role?.role, 'clinical');
      assert.equal(recoveredScope.unitById(lateUnit.id)!.attemptCount, 1);
      assert.equal(recoveredScope.accountedKind(lateUnit.id), 'extracted');
      assert.equal(recoveredDb.prepare('SELECT COUNT(*) AS n FROM observations').get()!.n, 1);
      const recoveredRead = getIntakeRead(recoveredDb, recoveredRoot, profileId, intake.id);
      assert.ok(isIntakeSummary(recoveredRead));
      if (!isIntakeSummary(recoveredRead)) throw Error('Expected recovered native summary');
      assert.equal(recoveredRead.collections.reportGroups.total, 1);
      const recoveredView = openIntakeCollectionEnvelope(recoveredDb, { id: intake.id });
      const recoveredWorkflow = recoveredView.child(
        recoveredView.child(recoveredView.root(), 'intake')!,
        'workflow',
      )!;
      const recoveredGroup = recoveredView.childAt(recoveredWorkflow, 'reportGroups', 0)!;
      assert.deepEqual(recoveredView.field(recoveredGroup, 'memberId'), {
        kind: 'value',
        value: late.memberId,
      });
      assert.deepEqual(recoveredView.field(recoveredGroup, 'sourceHash'), {
        kind: 'value',
        value: scope.inventory.binding.sourceHash,
      });
      const recoveredReport = await getIntakeReportSourceReviewRead(
        recoveredDb,
        recoveredRoot,
        profileId,
        intake.id,
        groupId,
        'all',
        { limit: 1 },
      );
      assert.ok('format' in recoveredReport);
      if (!('format' in recoveredReport)) throw Error('Expected recovered report source page');
      assert.equal(recoveredReport.groupId, groupId);
      // Accepted versions leave the selected report group intact but no longer appear as pending targets.
      assert.equal(recoveredReport.targets.total, 0);
      assert.equal(
        (await getIntakeIdentityReview(recoveredDb, recoveredRoot, profileId, intake.id, groupId))
          .status,
        'prior_confirmation',
      );
      const proposalSource = recoveredDb
        .prepare("SELECT path FROM source_files WHERE kind='intake_proposal'")
        .get()!;
      assert.equal(
        readFileSync(
          profileOriginal(recoveredRoot, String(proposalSource.path), profileId),
          'utf8',
        ),
        batchInput.jsonlText,
      );
      const beforeReplay = intakeWorkCounters(recoveredDb).warm;
      const beforeAcceptedBatches = Number(
        recoveredDb
          .prepare(
            "SELECT COUNT(*) AS n FROM manual_batches WHERE title='Accepted clinical contribution'",
          )
          .get()!.n,
      );
      const replayWork = createRecordVersionWorkCounters();
      await withRecordVersionWork(replayWork, async () => {
        assert.equal(
          (
            await createPagedPackagePlan(
              recoveredDb,
              recoveredRoot,
              profileId,
              intake.id,
              planInput,
            )
          ).replayed,
          true,
        );
        assert.equal(
          (
            await saveIntakePackageRolesRead(
              recoveredDb,
              recoveredRoot,
              profileId,
              intake.id,
              roleInput,
            )
          ).version,
          accepted.version,
        );
        assert.equal(
          (
            await submitPagedIntakeBatch(
              recoveredDb,
              recoveredRoot,
              profileId,
              intake.id,
              batchInput,
            )
          ).version,
          accepted.version,
        );
        assert.equal(
          (await importIntakeRead(recoveredDb, recoveredRoot, profileId, intake.id, acceptance))
            .version,
          accepted.version,
        );
      });
      assert.equal(replayWork.operation.encodeCalls, 0);
      assert.equal(replayWork.operation.segmentIndexPagesWritten, 0);
      assert.equal(
        recoveredDb
          .prepare(
            "SELECT COUNT(*) AS n FROM manual_batches WHERE title='Accepted clinical contribution'",
          )
          .get()!.n,
        beforeAcceptedBatches,
      );
      assert.equal(
        getIntakeRead(recoveredDb, recoveredRoot, profileId, intake.id).version,
        accepted.version,
      );
      assert.equal(recoveredDb.prepare('SELECT COUNT(*) AS n FROM observations').get()!.n, 1);
      assert.equal(
        intakeWorkCounters(recoveredDb).warm.collectionNodesWritten,
        beforeReplay.collectionNodesWritten,
      );
    } finally {
      clearPackageSourceSession(recoveredDb);
      clearIntakeStateCache(recoveredDb);
      recoveredDb.close();
    }
  },
);
