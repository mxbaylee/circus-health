import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createApp } from '../index.ts';
import { createVaultApp } from '../vault-app.ts';
import { HttpError, openDatabase, revision, type Database } from '../database.ts';
import { sourceRecordClinicalEvidence } from '../queries.ts';
import type { ApiResponse, SourceRecordClinicalEvidence } from '../../shared/api.ts';

const sourceId = 'source:fictional-encounter';

function fixture(t: TestContext, profileId = 'cookie-dough') {
  const root = mkdtempSync(resolve(tmpdir(), 'health-source-record-evidence-'));
  const db = openDatabase(resolve(root, `${profileId}.sqlite`), profileId);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.prepare('INSERT INTO source_files(id,path,sha256,bytes,mime_type) VALUES(?,?,?,?,?)').run(
    'file:fictional-encounter',
    'originals/fictional-encounter.jsonl',
    'a'.repeat(64),
    321,
    'application/x-ndjson',
  );
  db.prepare(
    `INSERT INTO source_records
      (id,source_file_id,source_key,kind,label,raw_json,locator_json,extraction_status)
      VALUES(?, 'file:fictional-encounter', 'encounter-1', 'record',
        'Fictional encounter', '{}', '{}', 'retained')`,
  ).run(sourceId);
  return { root, db, profileId };
}

function addEvidence(
  db: Database,
  id: string,
  entityType: string,
  entityId: string,
  role: string,
  locator: unknown,
) {
  db.prepare(
    `INSERT INTO evidence
      (id,entity_type,entity_id,source_record_id,role,locator_json)
      VALUES(?,?,?,?,?,?)`,
  ).run(id, entityType, entityId, sourceId, role, JSON.stringify(locator));
}

test('returns every raw clinical role and locator in stable, bounded ID order', (t) => {
  const { db } = fixture(t);
  addEvidence(db, 'evidence:06', 'report', 'report:excluded', 'source', { page: 6 });
  addEvidence(db, 'evidence:07', 'person', 'person:excluded', 'source', { page: 7 });
  addEvidence(db, 'evidence:08', 'note', 'note:excluded', 'source', { page: 8 });
  addEvidence(db, 'evidence:05', 'document', 'document:missing', 'excerpt', { page: 5 });
  addEvidence(db, 'evidence:04', 'procedure', 'procedure:archived', 'source', { page: 4 });
  addEvidence(db, 'evidence:03', 'medication', 'medication:1', 'mention', { page: 3 });
  addEvidence(db, 'evidence:02', 'observation', 'observation:1', 'excerpt', {
    page: 2,
    line: 8,
  });
  addEvidence(db, 'evidence:01', 'observation', 'observation:1', 'source', { page: 1 });
  db.prepare('INSERT INTO visibility_events VALUES(?,?,?,?,?,?,?)').run(
    'visibility:procedure',
    'procedure',
    'procedure:archived',
    1,
    1,
    '2032-03-04T05:06:07Z',
    'Profile owner',
  );

  const before = revision(db);
  const first = sourceRecordClinicalEvidence(
    db,
    sourceId,
    new URLSearchParams({ scope: 'clinical', limit: '2' }),
  );
  const rest = sourceRecordClinicalEvidence(
    db,
    sourceId,
    new URLSearchParams({ scope: 'clinical', limit: '200', offset: '2' }),
  );
  assert.equal(revision(db), before);
  assert.deepEqual(
    first.data.map((row) => row.id),
    ['evidence:01', 'evidence:02'],
  );
  assert.equal(first.total, 5);
  assert.equal(first.complete, false);
  assert.equal(rest.offset, 2);
  assert.equal(rest.total, 5);
  assert.equal(rest.complete, false);
  assert.deepEqual(
    rest.data.map((row) => row.id),
    ['evidence:03', 'evidence:04', 'evidence:05'],
  );
  assert.deepEqual(first.data[1], {
    id: 'evidence:02',
    entityType: 'observation',
    entityId: 'observation:1',
    sourceRecordId: sourceId,
    role: 'excerpt',
    locator: { page: 2, line: 8 },
  });
  assert.deepEqual(
    [...new Set([...first.data, ...rest.data].map((row) => row.entityType))].sort(),
    ['document', 'medication', 'observation', 'procedure'],
  );
});

test('requires an existing source and rejects malformed or ambiguous windows', (t) => {
  const { db } = fixture(t);
  assert.throws(
    () =>
      sourceRecordClinicalEvidence(
        db,
        'source:missing',
        new URLSearchParams({ scope: 'clinical' }),
      ),
    (error) => error instanceof HttpError && error.status === 404 && error.code === 'NOT_FOUND',
  );
  for (const query of [
    '',
    'scope=all',
    'scope=clinical&scope=clinical',
    'scope=clinical&limit=0',
    'scope=clinical&limit=2.5',
    'scope=clinical&limit=words',
    'scope=clinical&offset=-1',
    'scope=clinical&offset=1.5',
    'scope=clinical&offset=9007199254740992',
  ])
    assert.throws(
      () => sourceRecordClinicalEvidence(db, sourceId, new URLSearchParams(query)),
      (error) =>
        error instanceof HttpError && error.status === 400 && error.code === 'INVALID_INPUT',
      query,
    );
  const capped = sourceRecordClinicalEvidence(
    db,
    sourceId,
    new URLSearchParams({ scope: 'clinical', limit: '201' }),
  );
  assert.equal(capped.limit, 200);
  assert.equal(capped.total, 0);
  assert.equal(capped.complete, true);
});

test('profile route is isolated, revision-bound, and read-only', async (t) => {
  const first = fixture(t, 'cookie-dough');
  const second = fixture(t, 'cedar');
  addEvidence(first.db, 'evidence:first', 'document', 'document:first', 'source', { page: 1 });
  addEvidence(second.db, 'evidence:second', 'document', 'document:second', 'source', { page: 2 });
  const app = createApp({
    root: first.root,
    databases: new Map([
      ['cookie-dough', first.db],
      ['cedar', second.db],
    ]),
  });
  await new Promise<void>((ready) => app.server.listen(0, '127.0.0.1', ready));
  t.after(() => new Promise<void>((done) => app.server.close(() => done())));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles`;
  const read = async (profileId: string) => {
    const response = await fetch(
      `${base}/${profileId}/source-records/${encodeURIComponent(sourceId)}/evidence?scope=clinical`,
    );
    assert.equal(response.status, 200);
    return (await response.json()) as ApiResponse<SourceRecordClinicalEvidence[]>;
  };
  const firstResult = await read('cookie-dough');
  const secondResult = await read('cedar');
  assert.deepEqual(
    firstResult.data.map((row) => row.id),
    ['evidence:first'],
  );
  assert.deepEqual(
    secondResult.data.map((row) => row.id),
    ['evidence:second'],
  );
  assert.equal(firstResult.meta.revision, revision(first.db));
  assert.equal(firstResult.meta.total, 1);
  assert.equal(firstResult.meta.complete, true);
  assert.equal(firstResult.meta.limit, 50);
  assert.equal(firstResult.meta.offset, 0);

  const missing = await fetch(
    `${base}/cookie-dough/source-records/source%3Amissing/evidence?scope=clinical`,
  );
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'NOT_FOUND');
  const malformed = await fetch(
    `${base}/cookie-dough/source-records/${encodeURIComponent(sourceId)}/evidence?scope=clinical&limit=nope`,
  );
  assert.equal(malformed.status, 400);
  assert.equal(
    ((await malformed.json()) as { error: { code: string } }).error.code,
    'INVALID_INPUT',
  );
  const rejected = await fetch(
    `${base}/cookie-dough/source-records/${encodeURIComponent(sourceId)}/evidence?scope=clinical`,
    {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  assert.equal(rejected.status, 405);
  assert.equal(
    ((await rejected.json()) as { error: { code: string } }).error.code,
    'READ_ONLY_RESOURCE',
  );
});

test('encrypted profile wrapper rejects a different session before route dispatch', async (t) => {
  const base = mkdtempSync(resolve(tmpdir(), 'health-source-evidence-session-'));
  const dataDirectory = resolve(base, 'data');
  mkdirSync(dataDirectory);
  const app = createVaultApp({
    dataDirectory,
    runtimeDirectory: resolve(base, 'runtime'),
    assistantOptions: { availability: async () => ({ available: false }) },
  });
  await new Promise<void>((ready) => app.server.listen(0, '127.0.0.1', ready));
  t.after(() => {
    app.close();
    rmSync(base, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:5173';
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  let cookie = '';
  const send = async (path: string, method = 'GET', input?: unknown, owned = true) => {
    const response = await fetch(baseUrl + path, {
      method,
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(owned && cookie ? { Cookie: cookie } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    if (owned && response.headers.get('set-cookie'))
      cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return response;
  };
  const setupResponse = await send('/api/profile-setups', 'POST', {
    fullName: 'Fictional Juniper Vale',
    birthDate: '1982-04-17',
    name: 'Fictional Juniper Vale',
    placebo: false,
  });
  assert.equal(setupResponse.status, 201);
  const setup = (await setupResponse.json()) as {
    data: { setupId: string; recoveryKit: unknown };
  };
  const verified = await send(`/api/profile-setups/${setup.data.setupId}/verify`, 'POST', {
    acknowledged: true,
    recovery: setup.data.recoveryKit,
  });
  assert.equal(verified.status, 201);
  const profileId = ((await verified.json()) as { data: { id: string } }).data.id;
  const route = `/api/profiles/${profileId}/source-records/source%3Amissing/evidence?scope=clinical`;
  assert.equal((await send(route)).status, 404, 'authorized request reaches the profile route');
  const denied = await send(route, 'GET', undefined, false);
  assert.equal(denied.status, 423);
  assert.equal(((await denied.json()) as { error: { code: string } }).error.code, 'PROFILE_LOCKED');
});
