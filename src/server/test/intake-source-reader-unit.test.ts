import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  memoryRecordAuthority,
  writeIntakeFixtureEnvelope,
} from './helpers/intake-authority-fixture.ts';
import { uploadIntake, createIntakePlan, submitIntakeBatch } from '../intake.ts';
import { fictionalModel } from './fictional-model.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { openIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import { prepareRetainedPlanAccess } from '../intake-retained-plan.ts';
import {
  openCollectionReaderPlan,
  collectionReaderProposalCurrent,
} from '../intake-source-reader-unit.ts';

test('reader unit projection preserves actual duplicate ordinals, last-attempt currency and bounded notes/pages', async (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-reader-unit-')),
    profileId = 'fictional-reader';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const intake = uploadIntake(db, root, profileId, {
    filename: 'fictional.txt',
    bytes: Buffer.from('Fictional evidence. '.repeat(1200)),
    newProviderName: 'Fictional clinic',
  });
  const planned = await createIntakePlan(db, root, profileId, intake.id, {
    version: intake.version,
    operationId: 'fictional-plan',
  });
  const plan = planned.workflow!.plans[0],
    unit = plan.units[0];
  const proposed = submitIntakeBatch(db, root, profileId, intake.id, {
    version: planned.version,
    planId: plan.id,
    operationId: 'fictional-unit-read',
    jsonlText: JSON.stringify({
      format: 'health-record-v1',
      id: 'fictional-context',
      kind: 'context',
      payload: { text: 'Fictional note' },
      provenance: {
        capturedVia: null,
        sourceSystem: null,
        sourceRecordId: null,
        evidenceClass: 'transcription',
        locator: 'Fictional source',
      },
      coverage: { status: 'partial', notes: [] },
    }),
    summary: 'Fictional context',
    coverage: [{ unitId: unit.id, kind: 'unreadable', notes: 'Fictional note. '.repeat(200) }],
  });
  const raw = JSON.parse(readIntakeEnvelopeText(db, { id: intake.id }));
  const saved = raw.intake.workflow.plans[0];
  saved.units[0].pages = Array.from({ length: 25 }, (_, n) => n + 1);
  saved.units.push({
    ...saved.units[0],
    status: 'partial',
    attempts: ['missing-fictional-batch'],
    coverage: { unitId: unit.id, kind: 'context', notes: 'Separate duplicate occurrence' },
  });
  writeIntakeFixtureEnvelope(db, intake.id, raw);
  await buildIntakeCollectionEnvelope(db, { id: intake.id });
  await prepareRetainedPlanAccess(db, profileId, intake.id);
  const view = openIntakeCollectionEnvelope(db, { id: intake.id }),
    flow = view.child(view.child(view.root(), 'intake')!, 'workflow')!;
  const selected = openCollectionReaderPlan(
    db,
    root,
    profileId,
    intake.id,
    view.address(view.childAt(flow, 'plans', 0)!),
  );
  assert.equal(selected.ordinalOf(unit.id), 0);
  assert.equal(selected.facts(0).proposalId, proposed.proposals[0].id);
  assert.equal(
    collectionReaderProposalCurrent(db, intake.id, view, proposed.proposals[0].id),
    true,
  );
  assert.equal(collectionReaderProposalCurrent(db, intake.id, view, 'missing-proposal'), false);
  const first = selected.entry(0, false);
  assert.equal(first.notes.length, 1200);
  assert.equal(first.notesTruncated, true);
  assert.equal(first.pages?.length, 20);
  assert.equal(first.pagesTruncated, true);
  const last = selected.entry(selected.unitCount - 1, true),
    facts = selected.facts(selected.unitCount - 1);
  assert.equal(facts.lastAttemptId, 'missing-fictional-batch');
  assert.equal(facts.proposalId, undefined);
  assert.equal(last.coverageKind, 'context');
  assert.equal(last.notes, 'Separate duplicate occurrence');
  assert.equal(last.stale, true);
});
