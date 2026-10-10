import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, reviewIntake, importIntake, proposeConversionRead } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { readCollectionReportQueuePage } from '../intake-queue-page-collection.ts';
import { clearCollectionReportQueues } from '../intake-report-group-collection.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { openCollectionReportQueue } from '../intake-report-group-collection.ts';
import { prepareJournalActivity } from '../journal-activity-index.ts';
import { prepareCollectionPeopleIndex } from '../intake-people-collection.ts';
import { prepareCollectionReviewMembership } from '../intake-review-membership-index.ts';
import { buildVerifiedWorkflowSummary } from '../intake-workflow-state.ts';
import { workflowHash } from '../intake-workflow.ts';
import { activeMappingRules } from '../clinical-import.ts';

function record(id: string) {
  return {
    format: 'health-record-v1',
    id,
    kind: 'document',
    payload: { text: `Fictional source ${id}` },
    provenance: {
      capturedVia: 'Fictional export',
      sourceSystem: 'Fictional clinic',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'page 1',
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: { kind: 'document', subject: 'unknown', documentTitle: id, date: '2026-01-01' },
    report: {
      key: `fictional-${id}`,
      title: `Fictional report ${id}`,
      anchor: { locator: 'page 1', text: `Fictional source ${id}` },
      subject: null,
    },
  };
}

test(
  'warm active queue pages read only the selected window despite retained nonmatches',
  { timeout: 300_000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fictional-queue-window-'))),
      profileId = 'fictional-profile',
      db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    attachPersonalDurability(db, { root, profileId });
    t.after(() => {
      clearCollectionReportQueues(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const retained = uploadIntake(db, root, profileId, {
      filename: 'fictional-retained.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(
        Array.from({ length: 12 }, (_, n) => JSON.stringify(record(`retained-${n}`))).join('\n'),
      ),
    });
    const selected = reviewIntake(db, root, profileId, retained.id);
    importIntake(db, root, profileId, retained.id, {
      version: selected.version,
      reviewToken: selected.reviewToken,
      decisions: selected.records.map((item) => ({
        recordId: item.id,
        action: 'accept',
        mapping: {},
      })),
    });
    const active = uploadIntake(db, root, profileId, {
      filename: 'fictional-active.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(JSON.stringify(record('active'))),
    });
    await buildIntakeCollectionEnvelope(db, { id: retained.id, sha256: retained.sha256 });
    await buildIntakeCollectionEnvelope(db, { id: active.id, sha256: active.sha256 });
    await prepareCollectionReviewMembership(db, { id: retained.id });
    await prepareCollectionReviewMembership(db, { id: active.id });
    await prepareCollectionPeopleIndex(db, root, profileId, retained.id);
    await prepareCollectionPeopleIndex(db, root, profileId, active.id);
    for (const source of [retained, active])
      await buildVerifiedWorkflowSummary(
        db,
        { id: source.id },
        {
          mappingVersion: workflowHash(activeMappingRules(db, source.providerId)),
          isSourceContextVersion: () => false,
        },
      );
    await prepareJournalActivity(root, profileId);
    const first = await readCollectionReportQueuePage(db, root, profileId, {
      view: 'active',
      limit: 1,
    });
    assert.equal(first.totalGroups, 1);
    assert.equal(first.groups.length, 1);
    const before = { ...intakeWorkCounters(db).warm };
    const reused = await readCollectionReportQueuePage(db, root, profileId, {
      view: 'active',
      limit: 1,
    });
    const after = intakeWorkCounters(db).warm;
    assert.equal(reused.totalGroups, 1);
    assert.ok(after.collectionQueuePagePointerRows - before.collectionQueuePagePointerRows <= 2);
    assert.ok(
      after.collectionQueuePageMemberDecodes - before.collectionQueuePageMemberDecodes <= 2,
    );
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await readCollectionReportQueuePage(db, root, profileId, {
        view: 'all',
        limit: 7,
        ...(cursor ? { cursor } : {}),
      });
      assert.equal(page.totalGroups, 13);
      for (const item of page.groups) {
        const group = item.kind === 'group' ? item.group : item.reference;
        const key = `${group.intakeId}:${group.groupId}`;
        assert.equal(seen.has(key), false);
        seen.add(key);
      }
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(seen.size, 13);

    const changing = uploadIntake(db, root, profileId, {
      filename: 'fictional-changing.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(
        Array.from({ length: 3 }, (_, n) =>
          JSON.stringify({
            ...record(`changing-${n}`),
            report: record('changing-0').report,
          }),
        ).join('\n'),
      ),
    });
    await buildIntakeCollectionEnvelope(db, { id: changing.id, sha256: changing.sha256 });
    await prepareCollectionReviewMembership(db, { id: changing.id });
    await prepareCollectionPeopleIndex(db, root, profileId, changing.id);
    const baseline = await openCollectionReportQueue(db, root, profileId);
    const beforeAssertions = intakeWorkCounters(db).warm.hashedBytes;
    for (let index = 0; index < 10; index++) baseline.assertCurrent();
    assert.equal(
      intakeWorkCounters(db).warm.hashedBytes,
      beforeAssertions,
      'warm queue assertions do not rebuild complete source bindings',
    );
    const anchored = [...baseline.groups('all', changing.id)];
    assert.equal(anchored.length, 1);
    assert.ok(anchored.every((group) => group.address !== null));
    assert.equal(baseline.groupWindow('active', null, 1).totalGroups, 2);
    baseline.close();
    await proposeConversionRead(db, root, profileId, changing.id, {
      version: changing.version,
      jsonlText: JSON.stringify({ ...record('appended'), report: record('changing-0').report }),
      summary: 'Fictional additional evidence',
    });
    await prepareCollectionReviewMembership(db, { id: changing.id });
    await prepareCollectionPeopleIndex(db, root, profileId, changing.id);
    const beforeChange = { ...intakeWorkCounters(db).warm };
    const refreshed = await openCollectionReportQueue(db, root, profileId);
    assert.equal(refreshed.groupWindow('active', null, 1).totalGroups, 2);
    assert.equal(refreshed.groupWindow('all', null, 1).totalGroups, 14);
    refreshed.close();
    const afterChange = intakeWorkCounters(db).warm;
    assert.equal(afterChange.collectionQueueMemberRows - beforeChange.collectionQueueMemberRows, 4);
    const visibilityRows =
      afterChange.collectionQueueVisibilityRows - beforeChange.collectionQueueVisibilityRows;
    assert.ok(visibilityRows <= 2, `changed source refreshed ${visibilityRows} visibility rows`);
  },
);
