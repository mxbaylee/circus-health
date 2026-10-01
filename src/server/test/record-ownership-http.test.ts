import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createVaultApp } from '../vault-app.ts';
import { createNote } from '../notes.ts';
import { uploadIntake, reviewIntake, importIntake } from '../intake.ts';
import type {
  OwnershipPreview,
  OwnershipRequest,
  OwnershipReceipt,
} from '../../shared/record-ownership.ts';
import type { HealthRecordEnvelope } from '../../shared/intake.ts';

// Real encrypted sessions enforce the same boundary as the in-process policy;
// a known record ID is never authority. See docs/security/model.md.
test('ownership preview and commit require the owning unlocked HTTP session, including after a profile switch', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-ownership-http-'));
  mkdirSync(join(root, 'data'));
  const app = createVaultApp({
    dataDirectory: join(root, 'data'),
    runtimeDirectory: join(root, 'runtime'),
    assistantOptions: { availability: () => ({ available: false, readiness: 'unavailable' }) },
  });
  t.after(() => {
    app.close();
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  let cookie = '';
  async function send<T>(path: string, input?: unknown, authorized = true) {
    const response = await fetch(base + path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        Cookie: authorized ? cookie : '',
        'Content-Type': 'application/json',
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    if (authorized && response.headers.get('set-cookie'))
      cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const payload = (await response.json()) as { data?: T; error?: { code: string } };
    return { status: response.status, ...payload };
  }
  async function create(name: string) {
    const result = await send<{ setupId: string; profileId: string; recoveryKit: unknown }>(
      '/api/profile-setups',
      {
        name,
        fullName: name,
        birthDate: '1982-04-17',
      },
    );
    assert.equal(result.status, 201);
    const setup = result.data!;
    assert.equal(
      (
        await send(`/api/profile-setups/${setup.setupId}/verify`, {
          acknowledged: true,
          recovery: setup.recoveryKit,
        })
      ).status,
      201,
    );
    return setup;
  }
  const first = await create('Fictional Cedar');
  const state = app.manager.opened.get(first.profileId)!;
  const person = createNote(state.db, {
    kind: 'person',
    title: 'Robin Lane',
    person: { fullName: 'Robin Lane' },
  });
  const envelope: HealthRecordEnvelope = {
    format: 'health-record-v1',
    id: 'fictional-owner-row',
    kind: 'record',
    payload: { literal: '12.00' },
    provenance: {
      capturedVia: null,
      sourceSystem: 'Fictional Clinic',
      sourceRecordId: 'fictional-owner-row',
      evidenceClass: 'provider_export',
      locator: 'Fictional row 1',
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: {
      kind: 'observation',
      subject: 'self',
      testLabel: 'Fictional reach',
      valueText: '12.00',
      unit: 'cm',
      date: '2026-01-12',
    },
  };
  const original = uploadIntake(state.db, state.root, first.profileId, {
    filename: 'fictional.jsonl',
    bytes: Buffer.from(JSON.stringify(envelope)),
    newProviderName: 'Fictional Clinic',
  });
  const review = reviewIntake(state.db, state.root, first.profileId, original.id);
  importIntake(state.db, state.root, first.profileId, original.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
  });
  const recordId = String(state.db.prepare('SELECT id FROM observations').get()!.id);
  const sourceRecordId = String(
    state.db.prepare('SELECT source_record_id FROM observations WHERE id=?').get(recordId)!
      .source_record_id,
  );
  const assessmentPath = (profileId: string) =>
    `/api/profiles/${profileId}/source-records/${encodeURIComponent(sourceRecordId)}/ownership`;
  const assessment = await send<{
    sourceRecordId: string;
    packetRole: string;
    assignmentAuthority: string;
  }>(assessmentPath(first.profileId));
  assert.equal(assessment.status, 200);
  assert.equal(assessment.data!.sourceRecordId, sourceRecordId);
  assert.equal(assessment.data!.packetRole, 'outside_scope');
  assert.equal(assessment.data!.assignmentAuthority, 'read_only');
  assert.equal((await send(assessmentPath(first.profileId), undefined, false)).status, 423);
  assert.equal(
    (
      await send(
        `/api/profiles/${first.profileId}/source-records?ownership=unresolved`,
        undefined,
        false,
      )
    ).status,
    423,
  );
  assert.equal(
    (await send(`/api/profiles/${first.profileId}/source-records?ownership=invalid`)).status,
    400,
  );
  const request: OwnershipRequest = {
    selection: { type: 'records', records: [{ kind: 'observation', recordId }] },
    destination: { noteId: person.id, expectedVersion: person.version },
  };
  const path = (profileId: string) => `/api/profiles/${profileId}/record-ownership`;
  const preview = await send<OwnershipPreview>(path(first.profileId) + '/preview', request);
  assert.equal(preview.status, 200);
  const commit = {
    operationId: randomUUID(),
    request: preview.data!.request,
    version: preview.data!.version,
    scopeToken: preview.data!.scopeToken,
  };
  const unsigned = await send(path(first.profileId), commit, false);
  assert.equal(unsigned.status, 423);
  assert.equal(unsigned.error?.code, 'PROFILE_LOCKED');
  const second = await create('Fictional Willow');
  assert.equal((await send(assessmentPath(first.profileId))).status, 423);
  assert.equal((await send(assessmentPath(second.profileId))).status, 404);
  const secondState = app.manager.opened.get(second.profileId)!;
  const secondPerson = createNote(secondState.db, {
    kind: 'person',
    title: 'Ash River',
    person: { fullName: 'Ash River' },
  });
  const foreign = await send(path(second.profileId) + '/preview', {
    ...request,
    destination: { noteId: secondPerson.id, expectedVersion: secondPerson.version },
  });
  assert.equal(foreign.status, 404);
  assert.equal((await send(path(second.profileId), commit)).status, 404);
  assert.equal(secondState.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
  assert.equal((await send(path(first.profileId), commit)).status, 423);
  assert.equal((await send(path(first.profileId) + '/preview', request)).status, 423);
  assert.equal(
    (await send(`/api/profiles/${first.profileId}/unlock`, { recovery: first.recoveryKit })).status,
    200,
  );
  const reopened = app.manager.opened.get(first.profileId)!;
  assert.equal(
    reopened.db.prepare('SELECT person_id FROM observations WHERE id=?').get(recordId)!.person_id,
    'patient',
  );
  assert.equal(
    reopened.db
      .prepare("SELECT count(*) n FROM manual_batches WHERE title='Record ownership event'")
      .get()!.n,
    0,
  );
  assert.equal((await send(`/api/profiles/${first.profileId}/lock`, {})).status, 200);
  assert.equal((await send(assessmentPath(first.profileId))).status, 423);
  assert.equal((await send(path(first.profileId), commit)).status, 423);
  assert.equal(
    (await send(`/api/profiles/${first.profileId}/unlock`, { recovery: first.recoveryKit })).status,
    200,
  );
  const fresh = (await send<OwnershipPreview>(path(first.profileId) + '/preview', request)).data!;
  const saved = await send<OwnershipReceipt>(path(first.profileId), {
    operationId: commit.operationId,
    request: fresh.request,
    version: fresh.version,
    scopeToken: fresh.scopeToken,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data!.moved, 1);
  assert.equal(saved.data!.destinationPersonId, person.personId);
});
