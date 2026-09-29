import test from 'node:test';
import type { Intake } from '../../shared/intake.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachRecordDurability } from '../record-versions.ts';
import * as intake from '../intake.ts';
import { intakeSourceRoute } from '../intake-source-routes.ts';
import { getIntakeSourceText, reviewIntakeSourceText } from '../intake-source-text.ts';
import { fictionalModel } from './fictional-model.ts';

test('source corrections stale original/proposal review; identical fresh payload needs a new candidate review', async (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-source-integration-'));
  const profileId = 'fictional-source-integration';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const objects = new Map<string, Buffer>();
  attachRecordDurability(db, {
    profileId,
    storage: {
      read: (name) => objects.get(name) || null,
      writeImmutable: (name, bytes) => {
        assert.ok(!objects.has(name));
        objects.set(name, Buffer.from(bytes));
      },
      publishHead: (bytes) => {
        objects.set('head', Buffer.from(bytes));
      },
    },
  });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const jsonlText = JSON.stringify({
    format: 'health-record-v1',
    id: 'fictional-value',
    kind: 'record',
    payload: { literal: '12.00', administrative: 'Keep this too '.repeat(25) },
    provenance: {
      capturedVia: 'Fictional delivery',
      sourceSystem: 'Fictional clinic',
      sourceRecordId: 'fictional-value',
      evidenceClass: 'provider_export',
      locator: 'page 1',
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: {
      kind: 'observation',
      subject: 'self',
      testLabel: 'Fictional example',
      valueText: '12.00',
      unit: 'mg',
      date: '2026-09',
    },
  });
  let original: Intake = intake.uploadIntake(db, root, profileId, {
    filename: 'fictional.jsonl',
    bytes: Buffer.from(jsonlText),
    newProviderName: 'Fictional clinic',
  });
  const route = (action: string, input?: Record<string, unknown>, params = new URLSearchParams()) =>
    intakeSourceRoute({ db, root, profileId, id: original.id, action, input, params });
  await route('source-extract', { operationId: randomUUID(), expectedRevisionId: null });
  const text = getIntakeSourceText(db, root, profileId, original.id);
  assert.equal(text.status, 'available');
  const preview = (await route(
    'source-preview',
    undefined,
    new URLSearchParams({ page: '1', revisionId: text.revision!.id }),
  )) as { text: string };
  assert.equal(preview.text, jsonlText);
  const search = (await route(
    'source-search',
    undefined,
    new URLSearchParams({ query: 'Keep this too', revisionId: text.revision!.id }),
  )) as { matches: unknown[]; nextOffset: number; nextCharacter: number };
  assert.equal(search.matches.length, 20);
  const remainder = (await route(
    'source-search',
    undefined,
    new URLSearchParams({
      query: 'Keep this too',
      revisionId: text.revision!.id,
      offset: String(search.nextOffset),
      character: String(search.nextCharacter),
    }),
  )) as { matches: unknown[]; nextOffset: null };
  assert.equal(remainder.matches.length, 5);
  assert.equal(remainder.nextOffset, null);
  original = intake.getIntake(db, root, profileId, original.id);
  const proposed = intake.proposeConversion(db, root, profileId, original.id, {
    version: original.version,
    jsonlText,
    summary: 'Fictional interpretation',
  });
  const proposalId = proposed.proposals[0]!.id;
  const before = intake.reviewIntake(db, root, profileId, original.id, proposalId);
  assert.equal(before.sourceTextStale, false);
  const prepared = intake.prepareIntakeImport(db, root, profileId, original.id, {
    version: before.version,
    proposalId,
    reviewToken: before.reviewToken,
    decisions: [],
  });
  const corrected = reviewIntakeSourceText(
    db,
    root,
    profileId,
    original.id,
    {
      operationId: randomUUID(),
      expectedRevisionId: text.revision!.id,
      sourceHash: original.sha256,
      action: 'correct',
      scope: { page: 1 },
      spans: [
        {
          id: 'corrected',
          text: 'Fictional example 21.00 mg. Administrative text retained.',
          region: { page: 1 },
          provenance: 'human',
        },
      ],
      relations: [],
    },
    'profile-owner',
  );
  assert.throws(() => prepared.apply(before.version), /version|changed|reload/i);
  for (const selected of [null, proposalId]) {
    const stale = intake.reviewIntake(db, root, profileId, original.id, selected);
    assert.equal(stale.sourceTextStale, true);
    assert.throws(
      () =>
        intake.prepareIntakeImport(db, root, profileId, original.id, {
          version: stale.version,
          proposalId: selected,
          reviewToken: stale.reviewToken,
          decisions: [],
        }),
      { code: 'SOURCE_TEXT_CHANGED' },
    );
  }
  original = intake.getIntake(db, root, profileId, original.id);
  const fresh = intake.proposeConversion(db, root, profileId, original.id, {
    version: original.version,
    jsonlText,
    summary: 'Fresh fictional review required',
  });
  const freshId = fresh.proposals.at(-1)!.id;
  assert.notEqual(freshId, proposalId);
  const after = intake.reviewIntake(db, root, profileId, original.id, freshId);
  assert.equal(after.sourceTextStale, false);
  assert.notEqual(after.records[0]!.candidateVersionId, before.records[0]!.candidateVersionId);
  assert.equal(after.records[0]!.reviewState, 'pending');
  assert.equal(after.records[0]!.draft, null);
  assert.equal(
    intake.getIntakeOriginal(db, root, profileId, original.id).bytes.toString(),
    jsonlText,
  );
  assert.equal(corrected.revision!.parentRevisionId, text.revision!.id);
  await assert.rejects(
    route('source-extract', { operationId: randomUUID(), expectedRevisionId: text.revision!.id }),
    { code: 'SOURCE_TEXT_CHANGED' },
  );
  // A confirmation gets its own exact source revision, chained to its parent, but a
  // confirmation-only revision does not move the material source pin: new proposals
  // still pin to the last revision that actually changed the text.
  const confirm = () => {
    const latest = getIntakeSourceText(db, root, profileId, original.id);
    return reviewIntakeSourceText(
      db,
      root,
      profileId,
      original.id,
      {
        operationId: randomUUID(),
        expectedRevisionId: latest.revision!.id,
        sourceHash: original.sha256,
        action: 'confirm',
        scope: { page: 1 },
      },
      'profile-owner',
    );
  };
  const firstConfirm = confirm();
  const noOp = confirm();
  assert.notEqual(firstConfirm.revision!.id, corrected.revision!.id);
  assert.notEqual(noOp.revision!.id, firstConfirm.revision!.id);
  assert.equal(firstConfirm.revision!.parentRevisionId, corrected.revision!.id);
  assert.equal(noOp.revision!.parentRevisionId, firstConfirm.revision!.id);
  const latestOriginal = intake.getIntake(db, root, profileId, original.id);
  const pinned = intake.proposeConversion(db, root, profileId, original.id, {
    version: latestOriginal.version,
    jsonlText,
    summary: 'Fictional exact revision provenance',
  });
  assert.equal(pinned.proposals.at(-1)!.sourceTextRevisionId, corrected.revision!.id);
  assert.equal(
    intake.reviewIntake(db, root, profileId, original.id, pinned.proposals.at(-1)!.id)
      .sourceTextStale,
    false,
  );
});
