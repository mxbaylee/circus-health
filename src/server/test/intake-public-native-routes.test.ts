import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { fictionalModel } from './fictional-model.ts';
import {
  memoryRecordAuthority,
  writeIntakeFixtureEnvelope,
} from './helpers/intake-authority-fixture.ts';
import { uploadIntake, createIntakePlan } from '../intake.ts';
import { createPagedPackagePlan } from '../intake-package-plan.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { readIntakeEnvelopeMaterialized } from '../intake-authority.ts';
import { buildVerifiedWorkflowSummary } from '../intake-workflow-state.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import { createApp } from '../index.ts';

async function fixture(t: test.TestContext) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-public-routes-')),
    profileId = 'fictional-routes',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  const app = createApp({
    root,
    databases: new Map([[profileId, db]]),
    intakeBatchOptions: { authorized: () => false },
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/profiles/${profileId}/intakes/`;
  t.after(() => {
    app.close();
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    profileId,
    db,
    async request(id: string, action: string, input?: unknown, status = 200) {
      const response = await fetch(base + encodeURIComponent(id) + '/' + action, {
        ...(input === undefined
          ? {}
          : {
              method: 'POST',
              headers: {
                origin: 'http://127.0.0.1:5173',
                'content-type': 'application/json',
              },
              body: JSON.stringify(input),
            }),
      });
      const result = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      return result;
    },
  };
}

for (const native of [false, true])
  test(`public plan, package, member and literal endpoints retain ${native ? 'native bounded' : 'legacy'} contracts`, async (t) => {
    const f = await fixture(t),
      original = uploadIntake(f.db, f.root, f.profileId, {
        filename: 'fictional.zip',
        newProviderName: 'Fictional clinic',
        bytes: zipFixture([
          { name: 'fictional-a.txt', data: 'Fictional literal A' },
          { name: 'fictional-b.txt', data: 'Fictional literal B' },
          { name: 'fictional-c.txt', data: 'Fictional literal C' },
        ]),
      });
    const planned = await (native ? createPagedPackagePlan : createIntakePlan)(
      f.db,
      f.root,
      f.profileId,
      original.id,
      { version: original.version, operationId: 'fictional-public-plan' },
    );
    const before = { ...intakeWorkCounters(f.db).warm };
    const plan = (await f.request(original.id, 'plan')).data;
    if (native) {
      assert.equal(plan.format, 'health-intake-summary-v2');
      assert.equal(plan.activePlan.state, 'exact');
      assert.equal(plan.activePlan.plan.unitCount, 3);
      assert.equal(plan.workflow, undefined);
    } else {
      assert.equal(plan.intakeId, original.id);
      assert.equal(plan.plans.length, 1);
      assert.equal(plan.plans[0].units.length, 3);
    }
    assert.equal(plan.version, planned.version);
    const first = (await f.request(original.id, 'package?limit=2')).data;
    assert.equal(first.totalMembers, 3);
    assert.equal(first.members.length, 2);
    assert.equal(first.nextOffset, 2);
    if (native) assert.equal(first.format, 'health-intake-package-inventory-v2');
    const next = (await f.request(original.id, 'package?offset=2&limit=2')).data;
    assert.equal(next.members.length, 1);
    assert.equal(next.nextOffset, null);
    const selected = (
      await f.request(original.id, 'package-member', {
        memberId: first.members[0].memberId,
      })
    ).data;
    assert.ok(selected.sourceFileId);
    if (native) assert.equal(selected.member.unitId, first.members[0].unitId);
    else assert.equal(selected.member.filename, first.members[0].filename);
    const literal = (await f.request(selected.sourceFileId, 'read?offset=2&limit=5')).data;
    assert.equal(literal.text, 'ction');
    assert.equal(literal.offset, 2);
    assert.equal(literal.nextOffset, 7);
    assert.equal(literal.intake.id, selected.sourceFileId);
    if (native) {
      assert.equal(literal.intake.format, 'health-intake-summary-v2');
      assert.equal(intakeWorkCounters(f.db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
      assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
    }
    await f.request(original.id, 'package?limit=51', undefined, 400);
  });

test('public native navigation follows bounded cursors and preserves incomplete and ambiguous evidence', async (t) => {
  const f = await fixture(t),
    original = uploadIntake(f.db, f.root, f.profileId, {
      filename: 'fictional.html',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from('<h1>Fictional literal</h1>'),
    }),
    source = { id: original.id },
    previous = readIntakeEnvelopeMaterialized(f.db, source).value;
  writeIntakeFixtureEnvelope(f.db, original.id, {
    ...previous,
    intake: {
      ...(previous.intake as object),
      workflow: {
        format: 'health-intake-workflow-v1',
        candidates: [],
        questions: [],
        decisions: [],
        plans: [
          {
            id: 'fictional-plan',
            createdAt: '2026-10-03T00:00:00Z',
            status: 'active',
            pins: {
              sourceHash: original.sha256,
              backend: 'fictional',
              model: null,
              reasoningEffort: null,
              instructionVersion: 'fictional',
              mappingVersion: 'fictional',
            },
            units: [],
            batches: [],
            index: {
              kind: 'html',
              sections: Array.from({ length: 17 }, (_, i) => ({
                id: 'fictional-section-' + i,
                locator: 'fictional section ' + i,
                start: 0,
                end: 25,
              })),
              references: [{ id: 'self-reference', sourceFileId: original.id, fragment: 'same' }],
              anchors: [
                { name: 'same', start: 0, locator: 'first anchor' },
                { name: 'same', start: 10, locator: 'second anchor' },
              ],
            },
          },
        ],
      },
    },
  });
  await buildIntakeCollectionEnvelope(f.db, source);
  const pending = (await f.request(original.id, 'navigate?action=search&query=fictional')).data;
  assert.equal(pending.format, 'health-intake-navigation-v2');
  assert.equal(pending.state, 'pending');
  assert.equal(pending.searched, false);
  await buildVerifiedWorkflowSummary(f.db, source, {
    mappingVersion: 'fictional',
    isSourceContextVersion: () => false,
  });
  const before = { ...intakeWorkCounters(f.db).warm };
  let cursor: string | null = null,
    matches = 0,
    pages = 0;
  do {
    const result: {
      format: string;
      scannedSections: number;
      results: unknown[];
      complete: boolean;
      nextCursor: string | null;
    } = (
      await f.request(
        original.id,
        'navigate?action=search&query=fictional' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      )
    ).data;
    assert.equal(result.format, 'health-intake-navigation-v2');
    assert.ok(result.scannedSections <= 8);
    matches += result.results.length;
    pages++;
    if (pages === 1) {
      assert.equal(result.complete, false);
      assert.ok(result.nextCursor);
      await f.request(
        original.id,
        'navigate?action=search&query=other&cursor=' + encodeURIComponent(result.nextCursor),
        undefined,
        409,
      );
    }
    cursor = result.nextCursor;
  } while (cursor);
  assert.equal(matches, 17);
  assert.equal(pages, 3);
  const followed = (
    await f.request(original.id, 'navigate?action=follow&referenceId=self-reference')
  ).data;
  assert.equal(followed.followed, false);
  assert.equal(followed.reason, 'Ambiguous duplicate anchor');
  await f.request(original.id, 'navigate?action=search&query=fictional&offset=1', undefined, 400);
  assert.equal(intakeWorkCounters(f.db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
});
