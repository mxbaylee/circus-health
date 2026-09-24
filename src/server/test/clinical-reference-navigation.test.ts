import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { vaultFixture, newProfile } from './helpers/vault-fixture.ts';
import { uploadIntake, reviewIntake, importIntake } from '../intake.ts';
import { previewRecordCorrection } from '../record-corrections.ts';
import { applyClinicalDecision } from '../mapping-actions.ts';
import { createNote, finishNote, getNote, saveNote, relatedNotes, linkTarget } from '../notes.ts';
import { getObservation, clinicalList, evidenceFor } from '../queries.ts';
import { clinicalRedirect } from '../clinical-references.ts';
import { clinicalRecordHistory } from '../clinical-history.ts';
import { HttpError } from '../database.ts';

async function fixture(t: TestContext) {
  const vault = vaultFixture(t),
    { profile, recoveryKit } = await newProfile(vault.manager, 'Fictional reference review'),
    state = vault.manager.opened.get(profile.id);
  assert.ok(state);
  const f = {
    ...vault,
    profile,
    recoveryKit,
    root: state.root,
    db: state.db,
    profileId: profile.id,
  };
  const envelope = {
    format: 'health-record-v1',
    id: 'creatinine',
    kind: 'record',
    payload: { verbatim: 'Creatinine result 1.20 mg/dL' },
    clinical: {
      kind: 'procedure',
      subject: 'self',
      procedureLabel: 'Creatinine',
      procedureCategory: 'laboratory',
      date: '2025-01',
      valueText: '1.20',
      unit: 'mg/dL',
    },
    provenance: {
      capturedVia: 'Fictional export',
      sourceSystem: 'Fictional hospital',
      sourceRecordId: 'creatinine',
      evidenceClass: 'provider_export',
      locator: 'page 1 row 1',
    },
    coverage: { status: 'complete_response', notes: [] },
  };
  const intake = uploadIntake(f.db, f.root, f.profileId, {
      filename: 'fictional.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(JSON.stringify(envelope)),
    }),
    review = reviewIntake(f.db, f.root, f.profileId, intake.id);
  importIntake(f.db, f.root, f.profileId, intake.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: review.records.map((record) => ({
      recordId: record.id,
      action: 'accept',
      mapping: {},
    })),
  });
  const record = f.db.prepare('SELECT * FROM procedures').get() as { id: string } | undefined;
  assert.ok(record);
  return { ...f, record };
}
function correct(
  f: Awaited<ReturnType<typeof fixture>>,
  kind: 'observation' | 'medication' | 'procedure' | 'document',
  set: Record<string, unknown>,
  operationId: string,
) {
  const input = {
      kind,
      recordId: f.record.id,
      set,
      reason: 'Review of the retained fictional original',
    },
    preview = previewRecordCorrection(f.db, input);
  return applyClinicalDecision(f.db, f.root, f.profileId, 'clinical_correction', {
    ...input,
    previewToken: preview.token,
    version: preview.version,
    operationId,
  });
}

test('finished links and editable drafts retain tuples while current detail, navigation, evidence and backlinks follow accepted kind', async (t) => {
  const f = await fixture(t),
    link = { targetType: 'procedure', targetId: f.record.id, relation: 'references' };
  let finished = createNote(f.db, {
    kind: 'historical',
    title: 'Fictional completed visit',
    content: 'Discuss retained result.',
    links: [link],
  });
  finished = finishNote(f.db, finished.id, finished);
  const editable = createNote(f.db, {
    title: 'Fictional follow-up',
    content: 'Questions',
    links: [link],
  });
  const stored = f.db.prepare('SELECT * FROM note_links ORDER BY id').all(),
    original = f.db.prepare('SELECT * FROM source_records').all();
  correct(
    f,
    'procedure',
    { kind: 'observation', testLabel: 'Creatinine', valueText: '1.20', unit: 'mg/dL' },
    'reference-to-lab',
  );
  const redirect = clinicalList(f.db, 'procedures', new URLSearchParams(), f.record.id) as {
    reclassifiedTo: { kind: string; appUrl: string; apiUrl: string; recordId: string };
  };
  assert.equal(redirect.reclassifiedTo.kind, 'observation');
  assert.equal(
    redirect.reclassifiedTo.appUrl,
    `/tests?result=${encodeURIComponent(f.record.id)}&detail=1`,
  );
  assert.equal(
    Object.hasOwn(redirect, 'category'),
    false,
    'never returns an observation through a procedure DTO',
  );
  const observation = getObservation(f.db, f.record.id);
  assert.ok('valueText' in observation);
  assert.equal(observation.valueText, '1.20');
  assert.deepEqual(
    evidenceFor(f.db, 'procedure', f.record.id),
    evidenceFor(f.db, 'observation', f.record.id),
  );
  const hydrated = getNote(f.db, finished.id).links[0];
  assert.equal(hydrated.targetType, 'procedure');
  assert.equal(hydrated.targetId, f.record.id);
  assert.equal(hydrated.resolvedTargetType, 'observation');
  assert.equal(hydrated.appUrl, redirect.reclassifiedTo.appUrl);
  assert.equal(hydrated.missing, false);
  assert.equal(hydrated.title, 'Creatinine');
  const related = relatedNotes(f.db, 'observation', f.record.id);
  assert.equal(related.length, 2);
  assert.ok(related.some((note) => note.id === finished.id && note.status === 'finished'));
  assert.deepEqual(relatedNotes(f.db, 'procedure', f.record.id), related);
  const current = getNote(f.db, editable.id);
  saveNote(f.db, current.id, {
    ...current,
    content: 'Updated questions',
    links: current.links.map(({ targetType, targetId, relation }) => ({
      targetType,
      targetId,
      relation,
    })),
  });
  assert.deepEqual(
    f.db.prepare('SELECT * FROM note_links ORDER BY id').all(),
    stored,
    'draft save does not silently retarget the durable tuple',
  );
  assert.deepEqual(f.db.prepare('SELECT * FROM source_records').all(), original);
  assert.throws(
    () => linkTarget(f.db, 'document', f.record.id),
    (error: unknown) => error instanceof HttpError && error.status === 404,
    'a kind never in this history cannot impersonate a reference',
  );
  const { createApp } = await import('../index.ts');
  const app = createApp({ root: f.root, databases: new Map([[f.profileId, f.db]]) });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  try {
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/${f.profileId}`;
    const oldResponse = await fetch(base + '/procedures/' + encodeURIComponent(f.record.id));
    assert.equal(oldResponse.status, 200);
    const oldData = (await oldResponse.json()).data;
    assert.deepEqual(oldData.reclassifiedTo, redirect.reclassifiedTo);
    assert.equal(Object.hasOwn(oldData, 'category'), false);
    const currentResponse = await fetch(base + '/tests/' + encodeURIComponent(f.record.id));
    assert.equal(currentResponse.status, 200);
    assert.equal((await currentResponse.json()).data.valueText, '1.20');
    const notesResponse = await fetch(
      base +
        '/related-notes?' +
        new URLSearchParams({ targetType: 'observation', targetId: f.record.id }),
    );
    assert.equal(notesResponse.status, 200);
    assert.equal((await notesResponse.json()).data.length, 2);
    const noteResponse = await fetch(base + '/notes/' + encodeURIComponent(finished.id));
    assert.equal(noteResponse.status, 200);
    assert.equal((await noteResponse.json()).data.links[0].targetType, 'procedure');
  } finally {
    await new Promise<void>((done) => app.server.close(() => done()));
  }
  f.manager.lock(f.profileId);
  rmSync(resolve(f.dataDirectory, 'profiles', f.profileId, 'cache'), {
    recursive: true,
    force: true,
  });
  f.manager.unlock(f.profileId, f.recoveryKit);
  const rebuilt = f.manager.opened.get(f.profileId);
  assert.ok(rebuilt);
  assert.equal(rebuilt.metrics.cacheHit, false);
  assert.deepEqual(getNote(rebuilt.db, finished.id).links, [hydrated]);
  assert.equal(relatedNotes(rebuilt.db, 'observation', f.record.id).length, 2);
  assert.deepEqual(clinicalRedirect(rebuilt.db, 'procedure', f.record.id), redirect);
});

test('cross-kind indexed history includes A to B to A and paginates whole transitions with field and profile boundaries', async (t) => {
  const f = await fixture(t);
  const initial = clinicalRecordHistory(f.db, {
    profileId: f.profileId,
    kind: 'procedure',
    recordId: f.record.id,
  });
  assert.deepEqual(initial.kinds, ['procedure']);
  assert.equal(initial.entries.length, 1);
  correct(
    f,
    'procedure',
    { kind: 'observation', testLabel: 'Creatinine', valueText: '1.20', unit: 'mg/dL' },
    'history-b',
  );
  correct(f, 'observation', { valueText: '2.30' }, 'history-b-value');
  correct(
    f,
    'observation',
    { kind: 'procedure', procedureLabel: 'Creatinine order', procedureCategory: 'laboratory' },
    'history-a',
  );
  const params = { profileId: f.profileId, kind: 'observation', recordId: f.record.id };
  const history = clinicalRecordHistory(f.db, params);
  assert.equal(history.currentKind, 'procedure');
  assert.deepEqual(new Set(history.kinds), new Set(['procedure', 'observation']));
  assert.ok(
    history.entries.some(
      (entry) =>
        entry.entity === 'observations' && !entry.deleted && entry.contents.value_text === '2.30',
    ),
  );
  assert.ok(
    history.entries.some(
      (entry) =>
        entry.entity === 'procedures' && !entry.deleted && entry.contents.label === 'Creatinine',
    ),
  );
  assert.equal(history.entries.filter((entry) => entry.deleted).length, 2);
  const ids: string[] = [];
  let cursor: number | null | undefined;
  do {
    const page = clinicalRecordHistory(f.db, {
      ...params,
      limit: 1,
      ...(cursor ? { beforeSequence: cursor } : {}),
    });
    assert.ok(page.entries.length >= 1);
    ids.push(...page.entries.map((entry) => entry.versionId));
    cursor = page.nextSequence;
  } while (cursor);
  assert.deepEqual(
    ids,
    history.entries.map((entry) => entry.versionId),
    'no dropped twin version at a sequence boundary',
  );
  assert.equal(new Set(ids).size, ids.length);
  const fields = clinicalRecordHistory(f.db, { ...params, field: 'value_text' });
  assert.ok(
    fields.entries.some((entry) =>
      entry.changes.some(
        (change) =>
          change.field === 'value_text' && change.after.present && change.after.value === '2.30',
      ),
    ),
  );
  assert.throws(
    () => clinicalRecordHistory(f.db, { ...params, profileId: 'another-profile' }),
    (error: unknown) => error instanceof HttpError && error.code === 'PROFILE_BOUNDARY',
  );
  assert.throws(
    () => clinicalRecordHistory(f.db, { ...params, limit: 0 }),
    (error: unknown) => error instanceof HttpError && error.code === 'INVALID_HISTORY',
  );
  assert.throws(
    () => clinicalRecordHistory(f.db, { ...params, kind: 'document' }),
    (error: unknown) => error instanceof HttpError && error.code === 'RECORD_NOT_FOUND',
  );
  assert.deepEqual(
    getObservation(f.db, f.record.id),
    clinicalRedirect(f.db, 'observation', f.record.id),
  );
  f.manager.lock(f.profileId);
  rmSync(resolve(f.dataDirectory, 'profiles', f.profileId, 'cache'), {
    recursive: true,
    force: true,
  });
  f.manager.unlock(f.profileId, f.recoveryKit);
  const rebuilt = f.manager.opened.get(f.profileId);
  assert.ok(rebuilt);
  assert.deepEqual(clinicalRecordHistory(rebuilt.db, params), history);
});
