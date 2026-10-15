import { attachPersonalDurability } from '../portable.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { createApp } from '../index.ts';
import { createVaultApp } from '../vault-app.ts';
import { prepareIntakeCompactMetadata } from '../intake-compact-metadata.ts';
import { projectIntakeReferencedTargetCandidateAsync } from '../intake-state-migration.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import { listIntakePublicReads } from '../intake.ts';

/* The listed GET readers accept a referenced V3 row through its accepted
 * selected-source proof, on contributor and vault storage. This fixture gives
 * the compact writer a referenced target candidate for a fictional text
 * original whose metadata exceeds the compact threshold. The production upload
 * path does not yet select V3; remaining consumers and enablement are CRS-238. */
const origin = 'http://127.0.0.1:5173';
const V3 = '{"intakeAuthority":{"format":"health-intake-envelope-v3"';
type Send = (
  path: string,
  body?: string | Blob,
  headers?: Record<string, string>,
) => Promise<Response>;
type Storage = { send: Send; prefix: string; db: DatabaseSync; profileId: string };

async function listen(server: import('node:http').Server) {
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function contributor(t: TestContext): Promise<Storage> {
  const root = mkdtempSync(join(tmpdir(), 'fictional-v3-readers-'));
  const profileId = 'fictional-maple';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  const app = createApp({
    root,
    databases: new Map([[profileId, db]]),
    assistantOptions: { availability: () => ({ available: false }) },
  });
  const url = await listen(app.server);
  t.after(() => {
    app.close();
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const send: Send = (path, body, headers = {}) =>
    fetch(url + path, {
      ...(body === undefined ? {} : { method: 'POST', body }),
      headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    });
  return { send, prefix: `/api/profiles/${profileId}`, db, profileId };
}

async function vault(t: TestContext): Promise<Storage> {
  const base = mkdtempSync(join(tmpdir(), 'fictional-v3-readers-vault-'));
  const dataDirectory = join(base, 'data');
  mkdirSync(dataDirectory);
  const app = createVaultApp({
    dataDirectory,
    runtimeDirectory: join(base, 'runtime'),
    assistantOptions: { availability: async () => ({ available: false }) },
  });
  const url = await listen(app.server);
  t.after(() => {
    app.close();
    rmSync(base, { recursive: true, force: true });
  });
  let cookie = '';
  const send: Send = async (path, body, headers = {}) => {
    const response = await fetch(url + path, {
      ...(body === undefined ? {} : { method: 'POST', body }),
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...headers,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    return response;
  };
  const setup = await send(
    '/api/profile-setups',
    JSON.stringify({
      fullName: 'Fictional Maple Doe',
      birthDate: '1979-11-03',
      name: 'Fictional Maple Doe',
      placebo: false,
    }),
  );
  assert.equal(setup.status, 201);
  const kit = (await setup.json()) as { data: { setupId: string; recoveryKit: unknown } };
  const verified = await send(
    `/api/profile-setups/${kit.data.setupId}/verify`,
    JSON.stringify({ acknowledged: true, recovery: kit.data.recoveryKit }),
  );
  assert.equal(verified.status, 201);
  const profileId = ((await verified.json()) as { data: { id: string } }).data.id;
  const db = app.manager.opened.get(profileId)?.db;
  assert.ok(db);
  return { send, prefix: `/api/profiles/${profileId}`, db, profileId };
}

async function json(response: Response) {
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as any, text };
}

async function upload({ send, prefix }: Storage, name: string) {
  const response = await json(
    await send(
      prefix + '/intakes',
      new Blob([`Fictional ${name} original.\nSecond fictional line.\n`], { type: 'text/plain' }),
      { 'Content-Type': 'text/plain', 'X-Filename': name },
    ),
  );
  assert.equal(response.status, 201, response.text);
  return response.body.data as { id: string; sha256: string; version: number };
}

/** The production compact writer, given a referenced target candidate,
 * replaces a giant legacy header with a V3 descriptor. */
async function referenceOriginal(storage: Storage, target: { id: string; sha256: string }) {
  const { send, prefix, db, profileId } = storage;
  const current = await json(await send(`${prefix}/intakes/${target.id}`));
  assert.equal(current.status, 200, current.text);
  const metadata = await send(
    `${prefix}/intakes/${target.id}/metadata`,
    JSON.stringify({
      version: current.body.data.version,
      operationId: randomUUID(),
      metadata: { topics: Array.from({ length: 20 }, (_, i) => String(i).padEnd(200, '\u0001')) },
    }),
  );
  assert.equal(metadata.status, 200, await metadata.text());
  const identity = { profileId, intakeId: target.id, sourceHash: target.sha256 };
  const head = db
    .prepare('SELECT value FROM app_meta WHERE key=?')
    .get(intakeNamespace(identity) + 'head');
  assert.ok(head);
  const candidate = await projectIntakeReferencedTargetCandidateAsync(
    db,
    { identity, afterHead: String(head.value), writes: [] },
    () => {},
  );
  const source = db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(target.id) as { id: string; kind: string; sha256: string; details_json: string };
  assert.deepEqual(
    await prepareIntakeCompactMetadata(db, source, { referencedTargetCandidate: candidate }),
    { changed: true },
  );
  const details = String(
    db.prepare('SELECT details_json FROM source_files WHERE id=?').get(target.id)!.details_json,
  );
  assert.ok(details.startsWith(V3), details.slice(0, 80));
}

function stopBatches({ send, prefix }: Storage) {
  return (async () => {
    for (const batch of (await json(await send(prefix + '/intake-batches'))).body.data)
      await send(`${prefix}/intake-batches/${batch.id}/stop`, '{}');
  })();
}

async function exercise(t: TestContext, storage: Storage) {
  const { send, prefix } = storage;
  const legacy: { id: string; sha256: string; version: number }[] = [];
  for (const name of ['fictional-alder.txt', 'fictional-birch.txt'])
    legacy.push(await upload(storage, name));
  const target = await upload(storage, 'fictional-cedar.txt');
  legacy.push(await upload(storage, 'fictional-dogwood.txt'));
  await stopBatches(storage);
  await referenceOriginal(storage, target);
  const base = `${prefix}/intakes/${target.id}`;

  const summary = await json(await send(base));
  assert.equal(summary.status, 200, summary.text);
  assert.equal(summary.body.data.format, 'health-intake-summary-v3');
  assert.equal(summary.body.data.sha256, target.sha256);

  await t.test('plan presents the accepted V3 summary', async () => {
    const plan = await json(await send(base + '/plan'));
    assert.equal(plan.status, 200, plan.text);
    assert.deepEqual(plan.body.data, summary.body.data);
  });
  await t.test('read binds the literal window to the accepted original', async () => {
    const read = await json(await send(base + '/read?offset=0&limit=12'));
    assert.equal(read.status, 200, read.text);
    assert.deepEqual(read.body.data.intake, summary.body.data);
    assert.equal(read.body.data.text, 'Fictional fi');
    assert.equal(read.body.data.offset, 0);
    assert.equal(read.body.data.nextOffset, 12);
  });
  await t.test('package failures page under the accepted pins', async () => {
    const page = await json(await send(base + '/package-failures?limit=5'));
    assert.equal(page.status, 200, page.text);
    assert.equal(page.body.data.format, 'health-intake-package-failure-page-v1');
    assert.equal(page.body.data.intakeId, target.id);
    assert.deepEqual(page.body.data.pins, summary.body.data.pins);
    assert.equal(page.body.data.total, 0);
  });
  await t.test('source text and issues name the accepted source hash', async () => {
    const legacyText = await json(await send(`${prefix}/intakes/${legacy[0].id}/source-text`));
    assert.equal(legacyText.status, 200, legacyText.text);
    const text = await json(await send(base + '/source-text'));
    assert.equal(text.status, 200, text.text);
    assert.deepEqual(Object.keys(text.body.data).sort(), Object.keys(legacyText.body.data).sort());
    const issues = await json(await send(base + '/source-issues'));
    assert.equal(issues.status, 200, issues.text);
    assert.equal(issues.body.data.sourceHash, target.sha256);
    assert.equal('readerCoverage' in issues.body.data, false);
  });
  await t.test('review refuses explicitly rather than reading unproven state', async () => {
    const review = await json(await send(base + '/review'));
    assert.equal(review.status, 409, review.text);
    assert.equal(review.body.error.code, 'INTAKE_REVIEW_UNAVAILABLE');
  });
  await t.test('the list merges legacy and V3 rows in the SQL order', async () => {
    const reads = [];
    for (const { id } of [...legacy, target]) {
      const read = await json(await send(`${prefix}/intakes/${id}`));
      assert.equal(read.status, 200, read.text);
      reads.push(read.body.data as { id: string; createdAt: string });
    }
    const expected = reads
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? Buffer.compare(Buffer.from(a.id), Buffer.from(b.id))
          : Buffer.compare(Buffer.from(b.createdAt), Buffer.from(a.createdAt)),
      )
      .map(({ id }) => id);
    for (const query of ['', '?rootOnly=true']) {
      const listed = await json(await send(`${prefix}/intakes${query}`));
      assert.equal(listed.status, 200, listed.text);
      assert.equal(listed.body.meta.total, 4);
      assert.deepEqual(
        listed.body.data.map(({ id }: { id: string }) => id),
        expected,
      );
      const v3 = listed.body.data.find(({ id }: { id: string }) => id === target.id);
      assert.deepEqual(v3, summary.body.data);
      for (const entry of listed.body.data)
        if (entry.id !== target.id) assert.notEqual(entry.format, 'health-intake-summary-v3');
      const paged = [];
      for (let offset = 0; offset < 4; offset++) {
        const page = await json(
          await send(`${prefix}/intakes?limit=1&offset=${offset}${query ? '&rootOnly=true' : ''}`),
        );
        assert.equal(page.status, 200, page.text);
        assert.equal(page.body.meta.total, 4);
        assert.equal(page.body.meta.complete, offset === 3);
        paged.push(page.body.data[0].id);
      }
      assert.deepEqual(paged, expected);
    }
  });
  await t.test('one accepted proof per V3 row; only page legacy rows prepared', async () => {
    const work: { referencedProofs: number; preparedLegacyRows: number }[] = [];
    const page = await listIntakePublicReads(
      storage.db,
      storage.profileId,
      { limit: 2 },
      null,
      () => {},
      (observed) => work.push(observed),
    );
    assert.equal(page.data.length, 2);
    assert.equal(work.length, 1);
    assert.equal(work[0].referencedProofs, 1);
    assert.ok(work[0].preparedLegacyRows <= 2);
  });
}

test('V3 readers on contributor storage', { timeout: 300_000 }, async (t) => {
  await exercise(t, await contributor(t));
});

test('V3 readers on vault storage', { timeout: 300_000 }, async (t) => {
  await exercise(t, await vault(t));
});
