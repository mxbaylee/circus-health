import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDatabase, transaction } from '../database.ts';
import { sourceFiles } from '../queries.ts';
import { setVisibility } from '../visibility.ts';
import { createHash } from 'node:crypto';
import { createVaultApp } from '../vault-app.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  type RecordStorage,
} from '../record-versions.ts';
import { updateStoredIntakeDetails, registerIntakeFile } from '../intake-state-access.ts';
import { uploadIntake } from '../intake.ts';
import { newProfile, vaultFixture } from './helpers/vault-fixture.ts';
import { createApp } from '../index.ts';
import {
  sourceTextProjectionCounters,
  clearSourceTextProjectionCache,
} from '../source-text-projection.ts';
import {
  createSourceDetailsSearch,
  clearSourceDetailsSearchCache,
  sourceDetailsSearchCounters,
} from '../source-details-search.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-search-'));
  const path = join(root, 'cache.sqlite');
  let db = openDatabase(path, 'fictional-search');
  t.after(() => {
    if (db.isOpen) {
      clearSourceDetailsSearchCache(db);
      clearSourceTextProjectionCache(db);
      db.close();
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    get db() {
      return db;
    },
    reopen() {
      clearSourceDetailsSearchCache(db);
      clearSourceTextProjectionCache(db);
      db.close();
      db = openDatabase(path, 'fictional-search');
    },
    insert(id: string, raw: string, kind = 'derived', provider: string | null = null) {
      db.prepare(
        'INSERT INTO source_files(id,path,sha256,bytes,mime_type,kind,coverage_status,provider_id,details_json) VALUES(?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        `fictional/${id}.txt`,
        'a'.repeat(64),
        13,
        'text/plain',
        kind,
        'unknown',
        provider,
        raw,
      );
    },
  };
}

/** Frozen prechange query and DTO contract: never uses the new search or details adapters. */
export function sqlOracle(db: ReturnType<typeof openDatabase>, params: URLSearchParams) {
  const archived =
    "COALESCE((SELECT archived FROM visibility_events WHERE target_type='source_file' AND target_id=f.id ORDER BY version DESC LIMIT 1),0)";
  const visibility =
    params.get('visibility') || (params.get('archived') === '1' ? 'archived' : 'visible');
  const where = [visibility === 'all' ? '1=1' : `${archived}=${visibility === 'archived' ? 1 : 0}`];
  const args: string[] = [];
  for (const [key, column] of [
    [
      'providerId',
      "COALESCE(json_extract(f.details_json,'$.intake.metadata.sourceProviderId'),f.provider_id)",
    ],
    ['acquisitionProviderId', 'f.provider_id'],
    [
      'reviewedSourceProviderId',
      "json_extract(f.details_json,'$.intake.metadata.sourceProviderId')",
    ],
    ['kind', 'f.kind'],
  ]) {
    const value = params.get(key!);
    if (value) {
      where.push(`${column}=?`);
      args.push(value);
    }
  }
  const q = params.get('q');
  if (q) {
    where.push('(f.path LIKE ? OR f.details_json LIKE ?)');
    args.push(`%${q}%`, `%${q}%`);
  }
  const from = ` FROM source_files f LEFT JOIN providers p ON p.id=f.provider_id WHERE ${where.join(' AND ')}`;
  const total = Number(db.prepare('SELECT count(*) n' + from).get(...args)!.n);
  const limit = Math.min(200, Math.max(1, Number(params.get('limit')) || 50));
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const data = db
    .prepare(
      `SELECT f.*,p.name provider_name,${archived} archived` +
        from +
        ' ORDER BY f.path LIMIT ? OFFSET ?',
    )
    .all(...args, limit, offset)
    .map((row) => {
      const details = row.details_json === null ? null : JSON.parse(String(row.details_json));
      const metadata = details?.intake?.metadata;
      return {
        id: row.id,
        providerId: row.provider_id,
        provider: row.provider_name,
        reviewedSourceProviderId:
          typeof metadata?.sourceProviderId === 'string' ? metadata.sourceProviderId : null,
        reviewedSource: typeof metadata?.source === 'string' ? metadata.source : null,
        path: row.path,
        sha256: row.sha256,
        bytes: row.bytes,
        mimeType: row.mime_type,
        kind: row.kind,
        coverageStatus: row.coverage_status,
        details,
        contentUrl: '/api/sources/' + encodeURIComponent(String(row.id)),
        archived: !!row.archived,
      };
    });
  for (const row of data) row.contentUrl += '/content';
  return { data, total, limit, offset, complete: offset === 0 && data.length === total };
}
function parity(db: ReturnType<typeof openDatabase>, options: Record<string, string> = {}) {
  const params = new URLSearchParams(options);
  assert.deepEqual(sourceFiles(db, params), sqlOracle(db, params), JSON.stringify(options));
  assert.equal(sourceDetailsSearchCounters(db).activeRequests, 0);
  assert.equal(sourceDetailsSearchCounters(db).retainedEntries, 0);
  assert.equal(sourceDetailsSearchCounters(db).peakRetainedEntries, 0);
}

test('source count/pages and complete DTOs equal independent SQL LIKE for exact raw and normalized envelopes', (t) => {
  const f = fixture(t);
  f.db.exec(
    "INSERT INTO providers VALUES('acquired','Fictional acquisition'),('reviewed','Fictional review')",
  );
  const raw =
    '{ "first": "Alpha Ω Ä 😀", "dup":"retained hidden", "dup":"visible", "escape":"\\u0041\\ud800", "last": "tail" }';
  f.insert('a-raw', raw, 'derived', 'acquired');
  for (const [index, kind] of [
    'intake_original',
    'intake_proposal',
    'source',
    'intake_record',
    'intake_draft_repair',
    'upload',
    'uploaded',
    'synthetic',
    'derived',
  ].entries())
    f.insert(
      `kind-${index}`,
      JSON.stringify({
        before: 'left',
        intake: {
          version: 0,
          metadata: { sourceProviderId: 'reviewed', source: 'Fictional review' },
          workflow: {
            format: 'health-intake-workflow-v1',
            fictional: 'ab'.repeat(5000) + 'Ω😀boundary',
          },
        },
        after: 'right',
      }),
      kind,
      'acquired',
    );
  for (const [id, text] of [
    ['null', 'null'],
    ['array', '[1,"fictional scalar Ω",null]'],
    ['scalar', '"fictional scalar Alpha"'],
    ['empty', '{}'],
    ['null-metadata', '{"intake":{"metadata":null}}'],
    ['empty-metadata', '{"intake":{"metadata":{}}}'],
    ['integer-order', JSON.stringify({ z: 1, 12: 'twelve', 2: 'two', a: 'last' })],
  ] as const)
    f.insert(id, text);
  setVisibility(f.db, 'source_file', 'kind-1', { archived: true, version: 0 });
  const queries = [
    '',
    '%',
    '_',
    'ALPHA',
    'Alpha\u0000ignored',
    'alpha',
    'Ω',
    'ω',
    'Ä',
    'ä',
    '😀',
    'retained hidden',
    '\\u0041',
    '\\ud800',
    '"first": "',
    'visible", "escape',
    'left","intake',
    'right"}',
    '2":"two","12',
    'bΩ😀boundary',
    'fictional/a-raw',
    'never-found',
  ];
  const filters: Array<Record<string, string>> = [
    {},
    { providerId: 'reviewed' },
    { providerId: 'acquired' },
    { acquisitionProviderId: 'acquired' },
    { reviewedSourceProviderId: 'reviewed' },
    { visibility: 'archived' },
    { visibility: 'all' },
    { archived: '1' },
    { kind: 'intake_original' },
    { kind: 'intake_proposal' },
  ];
  for (const q of queries)
    for (const filter of filters)
      for (const offset of ['0', '2', '99']) parity(f.db, { q, ...filter, limit: '2', offset });
  const before = sourceTextProjectionCounters(f.db).authorityReads;
  parity(f.db, { q: '%' });
  parity(f.db, { q: 'ALPHA' });
  assert.equal(
    sourceTextProjectionCounters(f.db).authorityReads,
    before,
    'warm requests do not hydrate any authority views',
  );
});

test('a unique LIKE match spanning selected text-piece boundaries equals raw SQL', (t) => {
  const f = fixture(t);
  const text = Array.from(
    { length: 1200 },
    (_, index) => `Fictional marker ${String(index).padStart(4, '0')} Ω 😀. `,
  ).join('');
  f.insert('boundary', JSON.stringify({ before: 'outer', text, after: 'tail' }));
  parity(f.db, { q: 'Fictional marker' });
  const boundary = f.db
    .prepare(
      `SELECT c.text left_text,o.start left_start,o.end left_end,d.text right_text,n.start right_start,n.end right_end
    FROM __record_source_text_links l
    JOIN __record_source_text_occurrences o ON o.source_id=l.source_id AND o.id=l.id
    JOIN __record_source_text_contents c ON c.id=o.content_id
    JOIN __record_source_text_occurrences n ON n.source_id=l.source_id AND n.id=l.next
    JOIN __record_source_text_contents d ON d.id=n.content_id
    WHERE l.source_id=? AND o.end-o.start>32 AND n.end-n.start>32 LIMIT 1`,
    )
    .get('boundary')!;
  assert.ok(boundary);
  const left = String(boundary.left_text).slice(
    Number(boundary.left_start),
    Number(boundary.left_end),
  );
  const right = String(boundary.right_text).slice(
    Number(boundary.right_start),
    Number(boundary.right_end),
  );
  const q = left.slice(-24) + right.slice(0, 24);
  const raw = String(
    f.db.prepare('SELECT details_json FROM source_files WHERE id=?').get('boundary')!.details_json,
  );
  assert.equal(
    raw.split(q).length - 1,
    1,
    'fixture boundary term occurs exactly once in the authoritative envelope',
  );
  parity(f.db, { q });
  assert.equal(sourceFiles(f.db, new URLSearchParams({ q })).total, 1);
});

test('actual requests see inserts/deletes/distant/periodic/reordered/escaped mutations, rename, rollback and reopen', (t) => {
  const f = fixture(t);
  const left = 'Fictional left Ω 😀 '.repeat(300),
    middle = 'ab'.repeat(5000),
    right = ' Fictional right '.repeat(300);
  f.insert('changing', JSON.stringify({ before: left, middle, after: right }));
  f.insert('untouched', JSON.stringify({ fictional: 'untouched '.repeat(11000) }));
  parity(f.db, { q: 'left' });
  for (const details of [
    { before: 'early' + left, middle, after: right + 'late' },
    { after: right + 'late', middle, before: 'early' + left },
    { after: right, middle: middle + middle, before: left + '\\"😀Ω' },
  ]) {
    const before = sourceTextProjectionCounters(f.db).authorityReads;
    transaction(f.db, () => {
      f.db
        .prepare('UPDATE source_files SET details_json=? WHERE id=?')
        .run(JSON.stringify(details), 'changing');
      parity(f.db, { q: '%' });
    });
    assert.equal(sourceTextProjectionCounters(f.db).authorityReads - before, 1);
    for (const q of ['early', 'late', 'middle":"ab', '\\\\', '😀Ω', '%'])
      parity(f.db, { q, limit: '1' });
  }
  transaction(f.db, () => {
    f.insert('inserted', '{ "fictional": "new hidden term" }');
    parity(f.db, { q: 'new hidden' });
  });
  transaction(f.db, () => {
    f.db.prepare('DELETE FROM source_files WHERE id=?').run('inserted');
    f.db
      .prepare('UPDATE source_files SET path=? WHERE id=?')
      .run('fictional/renamed-evidence.txt', 'changing');
    parity(f.db, { q: 'renamed-evidence' });
  });
  const expected = sqlOracle(f.db, new URLSearchParams({ q: '%' }));
  assert.throws(
    () =>
      transaction(f.db, () => {
        f.db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
          JSON.stringify({
            ...JSON.parse(
              String(
                f.db.prepare('SELECT details_json FROM source_files WHERE id=?').get('changing')!
                  .details_json,
              ),
            ),
            fictional: 'rollback marker',
          }),
          'changing',
        );
        parity(f.db, { q: 'rollback marker' });
        throw Error('fictional rollback');
      }),
    /fictional rollback/,
  );
  assert.deepEqual(sourceFiles(f.db, new URLSearchParams({ q: '%' })), expected);
  f.reopen();
  parity(f.db, { q: '%' });
  parity(f.db, { q: 'renamed-evidence' });
  f.db.exec('DROP TABLE __record_source_text_contents');
  parity(f.db, { q: '%' });
});

test('failed requests clear scoped state, refuse corrupt authority and repair disposable damage', (t) => {
  const f = fixture(t);
  f.insert('a', '{"fictional":"valid"}');
  parity(f.db, { q: 'valid' });
  f.db.exec("UPDATE __record_source_text_contents SET text='fictional disposable corruption'");
  parity(f.db, { q: 'valid' });
  f.db.exec('PRAGMA ignore_check_constraints=ON');
  f.db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run('{', 'a');
  assert.throws(
    () => sourceFiles(f.db, new URLSearchParams({ q: '%' })),
    /authority|corrupt|JSON/i,
  );
  assert.equal(sourceDetailsSearchCounters(f.db).activeRequests, 0);
  f.db
    .prepare('UPDATE source_files SET details_json=? WHERE id=?')
    .run('{"fictional":"repaired authorized authority"}', 'a');
  parity(f.db, { q: 'authorized' });
});

test('source HTTP count/page response equals frozen SQL DTO oracle', async (t) => {
  const f = fixture(t);
  f.insert('a', '{ "fictional": "Alpha Ω", "dup":"hidden", "dup":"shown" }');
  f.insert('b', '{"fictional":"Alpha second"}');
  const app = createApp({ root: f.root, databases: new Map([['fictional-search', f.db]]) });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => app.server.close(() => resolve())));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/fictional-search/sources`;
  for (const q of ['ALPHA', 'hidden', 'Ω', '%', '_']) {
    const params = new URLSearchParams({ q, limit: '1', offset: '1' });
    const response = await fetch(base + '?' + params);
    assert.equal(response.status, 200);
    const actual = (await response.json()) as { data: unknown; meta: Record<string, unknown> };
    const expected = sqlOracle(f.db, params);
    for (const row of expected.data)
      row.contentUrl = row.contentUrl.replace('/api/', '/api/profiles/fictional-search/');
    assert.deepEqual(actual.data, expected.data);
    for (const key of ['total', 'limit', 'offset', 'complete'] as const)
      assert.equal(actual.meta[key], expected[key]);
  }
});

test('scope tokens, lowered budgets, transaction invalidation and close cannot retain request text', (t) => {
  const f = fixture(t);
  f.insert('a', '{"fictional":"text-only needle"}');
  const run = (plan: ReturnType<typeof createSourceDetailsSearch>) =>
    f.db.prepare(`SELECT f.id FROM source_files f WHERE ${plan.predicate}`).all(...plan.parameters);
  const plan = createSourceDetailsSearch(f.db, 'needle');
  assert.equal(run(plan).length, 1);
  assert.throws(() => createSourceDetailsSearch(f.db, 'needle'), /active request/);
  assert.throws(
    () =>
      f.db
        .prepare(`SELECT f.id FROM source_files f WHERE ${plan.predicate}`)
        .all(plan.parameters[0]!, 'wrong-token', plan.parameters[2]!),
    /active/,
  );
  plan.dispose();
  assert.throws(() => run(plan), /active/);
  const limited = createSourceDetailsSearch(f.db, 'needle', { limits: { maxEvaluations: 0 } });
  assert.throws(() => run(limited), /limit/);
  limited.dispose();
  for (const key of ['maxReconstructedBytes', 'maxReconstructedUtf16Units'] as const) {
    const bounded = createSourceDetailsSearch(f.db, 'needle', { limits: { [key]: 0 } });
    assert.throws(() => run(bounded), /reconstruction limit/);
    bounded.dispose();
    assert.equal(sourceDetailsSearchCounters(f.db).activeRequests, 0);
  }
  assert.equal(sourceDetailsSearchCounters(f.db).activeRequests, 0);
  const invalidated = createSourceDetailsSearch(f.db, 'needle');
  clearSourceDetailsSearchCache(f.db);
  assert.throws(() => run(invalidated), /active/);
  invalidated.dispose();
  transaction(f.db, () => {
    const transactional = createSourceDetailsSearch(f.db, 'needle');
    assert.equal(run(transactional).length, 1);
  });
  assert.equal(sourceDetailsSearchCounters(f.db).activeRequests, 0);
  parity(f.db, { q: 'needle' });
  const scoped = createSourceDetailsSearch(f.db, 'needle');
  f.db
    .prepare('UPDATE app_meta SET value=? WHERE key=?')
    .run('fictional-other-profile', 'owner_profile_id');
  assert.throws(() => run(scoped), /profile|binding/i);
  f.db
    .prepare('UPDATE app_meta SET value=? WHERE key=?')
    .run('fictional-search', 'owner_profile_id');
  scoped.dispose();
  const old = f.db;
  const closing = createSourceDetailsSearch(old, 'needle');
  f.reopen();
  closing.dispose();
  assert.equal(sourceDetailsSearchCounters(old).activeRequests, 0);
  parity(f.db, { q: 'needle' });
});

test('actual source lists survive real encrypted private copy, lock, target rebinding and total cache loss', async (t) => {
  const { manager } = vaultFixture(t),
    created = await newProfile(manager, 'Fictional search owner');
  const id = created.profile.id,
    state = manager.opened.get(id)!;
  const intake = uploadIntake(state.db, state.root, id, {
    filename: 'fictional.txt',
    bytes: Buffer.from('Fictional search evidence Ω.'),
    newProviderName: 'Fictional clinic',
  });
  transaction(state.db, () => {
    const details = JSON.parse(
      String(
        state.db.prepare('SELECT details_json FROM source_files WHERE id=?').get(intake.id)!
          .details_json,
      ),
    );
    details.intake.workflow = {
      format: 'health-intake-workflow-v1',
      fictional: 'Fictional searchable Ω 😀 '.repeat(300),
    };
    state.db
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run(JSON.stringify(details), intake.id);
  });
  parity(state.db, { q: 'searchable Ω' });
  const head = state.recordStorage.read('head');
  const copy = manager.begin({ name: 'Fictional search copy', copyFrom: id });
  await manager.verify(copy.setupId, { acknowledged: true, recovery: copy.recoveryKit });
  assert.deepEqual(state.recordStorage.read('head'), head);
  for (const [profileId, recovery] of [
    [id, created.recoveryKit],
    [copy.profileId, copy.recoveryKit],
  ] as const) {
    const before = manager.opened.get(profileId)!;
    parity(before.db, { q: 'searchable Ω' });
    assert.ok(
      sourceFiles(before.db, new URLSearchParams({ q: 'searchable Ω' })).data[0]!.path.includes(
        profileId,
      ),
    );
    const plan = createSourceDetailsSearch(before.db, 'searchable Ω');
    manager.lock(profileId);
    assert.equal(sourceDetailsSearchCounters(before.db).activeRequests, 0);
    plan.dispose();
    rmSync(join(manager.pathFor(profileId), 'cache'), { recursive: true, force: true });
    manager.unlock(profileId, recovery);
    parity(manager.opened.get(profileId)!.db, { q: 'searchable Ω' });
  }
});

test('warmed ordinary intake writes stage changed projection atomically and a caught refusal aborts the caller', (t) => {
  const f = fixture(t);
  f.insert(
    'original',
    JSON.stringify({
      intake: {
        version: 0,
        workflow: {
          format: 'health-intake-workflow-v1',
          fictional: 'distinct fictional anchor '.repeat(500),
        },
      },
    }),
    'intake_original',
  );
  parity(f.db, { q: 'distinct fictional' });
  const head = () =>
    f.db
      .prepare('SELECT details_digest FROM __record_source_text_heads WHERE source_id=?')
      .get('original')!.details_digest;
  const initial = head();
  const registration = {
    id: 'registered',
    providerId: 'fictional-provider',
    path: 'fictional/registered.txt',
    sha256: 'a'.repeat(64),
    size: 0,
    mimeType: 'text/plain',
    kind: 'derived',
    coverage: 'unknown',
    batchId: 'fictional-batch',
    details: { fictional: 'registered searchable evidence' },
  };
  f.db.exec(
    "INSERT INTO providers VALUES('fictional-provider','Fictional provider'); INSERT INTO manual_batches(id,title,status,created_at) VALUES('fictional-batch','Fictional batch','in_progress','2026-01-01')",
  );
  assert.throws(
    () =>
      transaction(f.db, () => {
        registerIntakeFile(f.db, registration);
        assert.ok(
          f.db
            .prepare('SELECT source_id FROM __record_source_text_heads WHERE source_id=?')
            .get('registered'),
          'registration stages head before search',
        );
        throw Error('fictional registration rollback');
      }),
    /registration rollback/,
  );
  assert.equal(f.db.prepare('SELECT id FROM source_files WHERE id=?').get('registered'), undefined);
  assert.equal(
    f.db
      .prepare('SELECT source_id FROM __record_source_text_heads WHERE source_id=?')
      .get('registered'),
    undefined,
  );
  parity(f.db, { q: 'distinct fictional' });
  transaction(f.db, () => {
    updateStoredIntakeDetails(f.db, 'original', (details) => {
      details.version++;
      details.workflow = {
        ...details.workflow!,
        fictional: 'prefix ' + 'distinct fictional anchor '.repeat(500),
      } as unknown as typeof details.workflow;
    });
    assert.notEqual(head(), initial, 'supported writer stages projection before any query');
  });
  parity(f.db, { q: 'prefix' });
  const selected = head();
  assert.throws(
    () =>
      transaction(f.db, () => {
        updateStoredIntakeDetails(f.db, 'original', (details) => {
          details.version++;
        });
        assert.notEqual(head(), selected);
        throw Error('fictional supported writer rollback');
      }),
    /supported writer rollback/,
  );
  assert.equal(head(), selected);
  assert.throws(
    () =>
      transaction(f.db, () => {
        try {
          updateStoredIntakeDetails(f.db, 'original', (details) => {
            details.workflow = {
              format: 'unsupported-fictional-v999',
            } as unknown as typeof details.workflow;
          });
        } catch {}
      }),
    /unsupported|transaction|rejected/i,
  );
  assert.equal(head(), selected);
  parity(f.db, { q: 'prefix' });
});

test('source requests refuse missing/malformed selected durable heads; actual recovery refuses selected evidence corruption', (t) => {
  const f = fixture(t),
    objects = new Map<string, Buffer>();
  const storage: RecordStorage = {
    read: (name) => (objects.has(name) ? Buffer.from(objects.get(name)!) : null),
    writeImmutable: (name, bytes) => {
      objects.set(name, Buffer.from(bytes));
    },
    publishHead: (bytes) => {
      objects.set('head', Buffer.from(bytes));
    },
  };
  f.insert('a', '{ "fictional": "durable searchable evidence" }');
  attachRecordDurability(f.db, { profileId: 'fictional-search', storage });
  parity(f.db, { q: 'durable searchable' });
  const acceptedHead = Buffer.from(objects.get('head')!);
  for (const fault of [null, Buffer.from('fictional malformed head')]) {
    if (fault) objects.set('head', fault);
    else objects.delete('head');
    assert.throws(
      () => sourceFiles(f.db, new URLSearchParams({ q: 'durable searchable' })),
      /recovery|corrupt|head|JSON|format/i,
    );
    assert.equal(sourceDetailsSearchCounters(f.db).activeRequests, 0);
    objects.set('head', acceptedHead);
    parity(f.db, { q: 'durable searchable' });
  }
  const ref = JSON.parse(acceptedHead.toString()) as {
    name: string;
    sha256: string;
    bytes: number;
  };
  const selected = Buffer.from(objects.get(ref.name)!);
  for (const fault of ['missing', 'corrupt', 'unsupported'] as const) {
    if (fault === 'missing') objects.delete(ref.name);
    if (fault === 'corrupt')
      objects.set(ref.name, Buffer.from('fictional corrupt selected object'));
    if (fault === 'unsupported') {
      const value = JSON.parse(selected.toString());
      value.format = 'unsupported-fictional-v999';
      const bytes = Buffer.from(JSON.stringify(value));
      objects.set(ref.name, bytes);
      objects.set(
        'head',
        Buffer.from(
          JSON.stringify({
            ...ref,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            bytes: bytes.length,
          }),
        ),
      );
    }
    assert.throws(
      () =>
        rebuildRecordDatabase(join(f.root, `${fault}.sqlite`), {
          profileId: 'fictional-search',
          storage,
        }),
      /missing|hash|corrupt|unsupported|format|commit/i,
    );
    objects.set(ref.name, selected);
    objects.set('head', acceptedHead);
  }
  const recovered = rebuildRecordDatabase(join(f.root, 'recovered.sqlite'), {
    profileId: 'fictional-search',
    storage,
  });
  assert.equal(recovered.dirty, false);
  const reopened = openDatabase(join(f.root, 'recovered.sqlite'), 'fictional-search');
  try {
    attachRecordDurability(reopened, { profileId: 'fictional-search', storage });
    parity(reopened, { q: 'durable searchable' });
  } finally {
    reopened.close();
  }
});

test('globally warm source search grants no access to another HTTP session and revocation clears scopes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-source-search-sessions-'));
  const dataDirectory = join(root, 'data');
  mkdirSync(dataDirectory);
  const app = createVaultApp({
    dataDirectory,
    runtimeDirectory: join(root, 'runtime'),
    assistantOptions: { availability: async () => ({ available: false }) },
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  t.after(() => {
    app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  function client() {
    let cookie = '';
    return async (path: string, method = 'GET', input?: unknown) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          Origin: 'http://127.0.0.1:5173',
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      if (response.headers.has('set-cookie'))
        cookie = response.headers.get('set-cookie')!.split(';')[0]!;
      return { status: response.status, body: await response.json() };
    };
  }
  const owner = client(),
    stranger = client();
  const setup = await owner('/api/profile-setups', 'POST', {
    fullName: 'Fictional search session owner',
    name: 'Fictional search session owner',
    birthDate: '1982-04-17',
    placebo: false,
  });
  assert.equal(setup.status, 201);
  const kit = setup.body.data;
  const verified = await owner(`/api/profile-setups/${kit.setupId}/verify`, 'POST', {
    acknowledged: true,
    recovery: kit.recoveryKit,
  });
  assert.equal(verified.status, 201);
  const id = verified.body.data.id,
    state = app.manager.opened.get(id)!;
  const original = uploadIntake(state.db, state.root, id, {
    filename: 'fictional.txt',
    bytes: Buffer.from('Fictional private search session evidence.'),
    newProviderName: 'Fictional clinic',
  });
  transaction(state.db, () =>
    updateStoredIntakeDetails(state.db, original.id, (details) => {
      details.metadata!.source = 'private searchable needle';
    }),
  );
  const path = `/api/profiles/${id}/sources?q=searchable%20needle`;
  const allowed = await owner(path);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.meta.total, 1);
  const requests = sourceDetailsSearchCounters(state.db).requests;
  assert.equal((await stranger(path)).status, 423);
  assert.equal(
    sourceDetailsSearchCounters(state.db).requests,
    requests,
    'denied session never invokes source query',
  );
  const pending = createSourceDetailsSearch(state.db, 'needle');
  const other = await stranger('/api/profile-setups', 'POST', {
    name: 'Fictional other session owner',
    fullName: 'Fictional other session owner',
    birthDate: '1982-04-17',
    placebo: false,
  });
  assert.equal(other.status, 201);
  assert.equal(
    (
      await stranger(`/api/profile-setups/${other.body.data.setupId}/verify`, 'POST', {
        acknowledged: true,
        recovery: other.body.data.recoveryKit,
      })
    ).status,
    201,
  );
  assert.equal(sourceDetailsSearchCounters(state.db).activeRequests, 0);
  pending.dispose();
  assert.equal((await owner(path)).status, 423);
  assert.equal((await stranger(path)).status, 423);
  const unlocked = await stranger(`/api/profiles/${id}/unlock`, 'POST', {
    recovery: kit.recoveryKit,
  });
  assert.equal(unlocked.status, 200, JSON.stringify(unlocked.body));
  assert.equal((await stranger(path)).status, 200);
  assert.equal((await owner(path)).status, 423);
  assert.equal((await stranger(`/api/profiles/${id}/lock`, 'POST', {})).status, 200);
  assert.equal((await stranger(path)).status, 423);
});
