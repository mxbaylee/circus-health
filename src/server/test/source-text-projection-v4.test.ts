import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase, transaction } from '../database.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage } from '../intake-state-storage.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import {
  clearSourceTextProjectionCache,
  consumeSourceTextProjection,
  reconcileSourceTextProjection,
  sourceTextProjectionCounters,
} from '../source-text-projection.ts';
import {
  createSourceDetailsSearch,
  sourceDetailsSearchCounters,
} from '../source-details-search.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  openIntakeCollectionEnvelope,
  prepareIntakeEnvelopeFieldMutation,
  stageIntakeEnvelopeFieldMutation,
} from '../intake-collection-envelope.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { rebuildRecordDatabase } from '../record-versions.ts';
import { sourceFiles } from '../queries.ts';
import { createApp } from '../index.ts';
import type { AddressInfo } from 'node:net';
import { registerIntakeFile } from '../intake-state-access.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';

function predicateOracle(db: ReturnType<typeof openDatabase>, text: string, query: string) {
  const expected = Number(db.prepare('SELECT ? LIKE ? n').get(text, `%${query}%`)!.n);
  const plan = createSourceDetailsSearch(db, query);
  try {
    const actual = Number(
      db
        .prepare(`SELECT count(*) n FROM source_files f WHERE ${plan.predicate}`)
        .get(...plan.parameters)!.n,
    );
    assert.equal(actual, expected, JSON.stringify(query));
    const page = db
      .prepare(`SELECT id FROM source_files f WHERE ${plan.predicate} ORDER BY id LIMIT 1`)
      .all(...plan.parameters);
    assert.equal(page.length, expected, JSON.stringify(query));
  } finally {
    plan.dispose();
  }
}

test('native v4 source query equals independent raw SQLite text through cold reads, field edits, auxiliary churn and rollback', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-v4-raw-search-'));
  const originalBytes = Buffer.from('Independently fictional retained original.');
  const identity = {
    profileId: 'fictional-search',
    intakeId: 'fictional-source',
    sourceHash: createHash('sha256').update(originalBytes).digest('hex'),
  };
  const db = openDatabase(
    join(root, `data/profiles/${identity.profileId}/db/database.sqlite`),
    identity.profileId,
  );
  let otherDb: ReturnType<typeof openDatabase> | undefined;
  t.after(() => {
    otherDb?.close();
    clearSourceTextProjectionCache(db);
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const authority = memoryRecordAuthority(db);
  let text =
    ' \n{ "unknown":"retained hidden", "unknown":"shown", "escape":"\\u0041\\ud800", "intake": { "version":0, "workflow": { "format":"health-intake-workflow-v1", "marker":"early needle", "unknownLarge":' +
    JSON.stringify('ab'.repeat(7000) + 'Ω😀 boundary ending') +
    ' } }, "tail":"late evidence" }\n';
  const originalPath = `data/profiles/${identity.profileId}/sources/fictional-source.txt`;
  mkdirSync(dirname(join(root, originalPath)), { recursive: true });
  writeFileSync(join(root, originalPath), originalBytes);
  transaction(db, () =>
    registerIntakeFile(db, {
      id: identity.intakeId,
      providerId: null,
      path: originalPath,
      sha256: identity.sourceHash,
      size: originalBytes.length,
      mimeType: 'text/plain',
      kind: 'intake_original',
      coverage: 'unknown',
      details: text,
    }),
  );
  const source = { id: identity.intakeId };
  predicateOracle(db, text, 'retained hidden');
  let checkpointInspected = false;
  const built = await buildIntakeCollectionEnvelope(db, source, {
    onCheckpoint() {
      if (!checkpointInspected) {
        predicateOracle(db, text, 'early needle');
        checkpointInspected = true;
      }
    },
  });
  assert.equal(checkpointInspected, true);
  assert.equal(built.sourceTextHash, createHash('sha256').update(text).digest('hex'));
  const before = structuredClone(intakeWorkCounters(db));
  clearSourceTextProjectionCache(db);
  clearIntakeStateCache(db);
  for (const query of [
    'early needle',
    'retained hidden',
    '\\u0041',
    '\\ud800',
    'shown", "escape',
    'bΩ😀 boundary',
    'late evidence',
    'nonexistent',
    '_%needle',
  ])
    predicateOracle(db, text, query);
  const warm = intakeWorkCounters(db);
  assert.equal(warm.warm.envelopeHydrations, before.warm.envelopeHydrations);
  assert.equal(warm.warm.materializationReads, before.warm.materializationReads);
  assert.equal(warm.warm.evidenceReplayVersions, before.warm.evidenceReplayVersions);
  assert.ok(sourceDetailsSearchCounters(db).peakTextBytes <= 4096);
  assert.equal(sourceDetailsSearchCounters(db).reconstructions, 0);
  const listed = sourceFiles(db, new URLSearchParams({ q: 'retained hidden', limit: '1' }));
  assert.equal(listed.total, 1);
  assert.equal(listed.complete, true);
  assert.equal('detailsIncluded' in listed.data[0]! && listed.data[0]!.detailsIncluded, false);
  assert.equal(Object.hasOwn(listed.data[0]!, 'details'), false);
  assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.warm.envelopeHydrations);
  const projected = structuredClone(sourceTextProjectionCounters(db));
  const prepare = (value: string) => {
    const reader = openIntakeCollectionEnvelope(db, source);
    const intake = reader.child(reader.root(), 'intake')!;
    const workflow = reader.child(intake, 'workflow')!;
    const operationId = randomUUID();
    return prepareIntakeEnvelopeFieldMutation(db, source, {
      reader,
      record: workflow,
      field: 'marker',
      jsonText: JSON.stringify(value),
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: 0,
    });
  };
  transaction(db, () =>
    stageIntakeEnvelopeFieldMutation(db, source, prepare('replacement needle')),
  );
  text = text.replace('"early needle"', '"replacement needle"');
  reconcileSourceTextProjection(db);
  predicateOracle(db, text, 'early needle');
  predicateOracle(db, text, 'replacement needle');
  const store = createIntakeStateStorage(db, identity).collections;
  const operationId = randomUUID();
  store.commitMaintenance(
    store.prepare(store.openView(), {
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: 0,
      changes: [],
    }),
  );
  reconcileSourceTextProjection(db);
  predicateOracle(db, text, 'replacement needle');
  assert.throws(
    () =>
      transaction(db, () => {
        stageIntakeEnvelopeFieldMutation(db, source, prepare('rolled-back needle'));
        predicateOracle(
          db,
          text.replace('"replacement needle"', '"rolled-back needle"'),
          'rolled-back needle',
        );
        throw Error('fictional rollback');
      }),
    /fictional rollback/,
  );
  predicateOracle(db, text, 'replacement needle');
  predicateOracle(db, text, 'rolled-back needle');
  const after = sourceTextProjectionCounters(db);
  for (const key of [
    'contentRowsWritten',
    'occurrenceRowsWritten',
    'linkRowsWritten',
    'authorityHashBytes',
  ] as const)
    assert.equal(after[key], projected[key], key);
  assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.warm.envelopeHydrations);
  assert.throws(
    () =>
      transaction(db, () => {
        const operationId = randomUUID();
        const corrupt = store.prepare(store.openView(), {
          operationId,
          requestDigest: createHash('sha256').update(operationId).digest('hex'),
          domainVersion: 0,
          changes: [{ area: 'logical', collection: 'envelope.data', op: 'delete', key: '$after' }],
        });
        store.stage(corrupt);
        const plan = createSourceDetailsSearch(db, 'replacement needle');
        try {
          // The marker matches near the beginning. Missing trailing lexical proof
          // still makes the whole count unavailable, rather than reporting one.
          assert.throws(
            () =>
              db
                .prepare(`SELECT count(*) n FROM source_files f WHERE ${plan.predicate}`)
                .get(...plan.parameters),
            /lexical cell/,
          );
        } finally {
          plan.dispose();
        }
      }),
    /lexical cell/,
  );
  predicateOracle(db, text, 'replacement needle');
  const changing = prepare('binding-change needle');
  assert.throws(
    () =>
      transaction(db, () => {
        let changed = false;
        consumeSourceTextProjection(db, identity.intakeId, () => {
          if (!changed) {
            changed = true;
            stageIntakeEnvelopeFieldMutation(db, source, changing);
          }
        });
      }),
    /stale|binding/i,
  );
  predicateOracle(db, text, 'replacement needle');
  predicateOracle(db, text, 'binding-change needle');
  otherDb = openDatabase(
    join(root, 'data/profiles/fictional-other/db/database.sqlite'),
    'fictional-other',
  );
  memoryRecordAuthority(otherDb);
  transaction(otherDb, () =>
    otherDb!
      .prepare(
        'INSERT INTO source_files(id,path,sha256,bytes,mime_type,kind,details_json) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        identity.intakeId,
        originalPath,
        identity.sourceHash,
        originalBytes.length,
        'text/plain',
        'derived',
        '{}',
      ),
  );
  const app = createApp({
    root,
    databases: new Map([
      [identity.profileId, db],
      ['fictional-other', otherDb],
    ]),
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => app.server.close(() => resolve())));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/${identity.profileId}/sources`;
  const response = await fetch(
    base + '?' + new URLSearchParams({ q: 'retained hidden', limit: '1' }),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    data: Array<{ detailsIncluded: boolean; detailsUrl: string }>;
    meta: { total: number; complete: boolean };
  };
  assert.equal(body.meta.total, 1);
  assert.equal(body.meta.complete, true);
  assert.equal(body.data[0]!.detailsIncluded, false);
  const reference = await fetch(`${base}/${identity.intakeId}?fileView=reference`);
  assert.equal(reference.status, 200);
  assert.equal(
    ((await reference.json()) as { data: { detailsIncluded: boolean } }).data.detailsIncluded,
    false,
  );
  const defaultDetail = await fetch(`${base}/${identity.intakeId}`);
  assert.equal(defaultDetail.status, 200);
  assert.equal(
    ((await defaultDetail.json()) as { data: { detailsIncluded: boolean } }).data.detailsIncluded,
    false,
  );
  assert.equal((await fetch(`${base}/${identity.intakeId}?fileView=full`)).status, 400);
  const exportResponse = await fetch(new URL(body.data[0]!.detailsUrl, base));
  assert.equal(exportResponse.status, 200);
  assert.equal(await exportResponse.text(), text);
  assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.warm.envelopeHydrations);
  const selectedKey = intakeNamespace(identity) + 'head';
  const selectedHead = db.prepare('SELECT value FROM app_meta WHERE key=?').get(selectedKey)!.value;
  db.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{', selectedKey);
  try {
    const original = await fetch(`${base}/${identity.intakeId}/content`);
    assert.equal(original.status, 200);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), originalBytes);
    assert.ok((await fetch(`${base}/${identity.intakeId}?fileView=reference`)).status >= 400);
    assert.equal(
      (
        await fetch(
          base.replace(identity.profileId, 'fictional-other') + `/${identity.intakeId}/content`,
        )
      ).status,
      403,
    );
  } finally {
    db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(selectedHead!, selectedKey);
  }
  const recoveredPath = join(root, 'recovered.sqlite');
  rebuildRecordDatabase(recoveredPath, {
    profileId: identity.profileId,
    storage: authority.storage,
  });
  const recovered = openDatabase(recoveredPath, identity.profileId);
  try {
    authority.attach(recovered);
    const beforeRecovered = structuredClone(intakeWorkCounters(recovered));
    predicateOracle(recovered, text, 'replacement needle');
    predicateOracle(recovered, text, 'retained hidden');
    predicateOracle(recovered, text, '\\u0041');
    assert.equal(
      intakeWorkCounters(recovered).warm.envelopeHydrations,
      beforeRecovered.warm.envelopeHydrations,
    );
    assert.equal(
      intakeWorkCounters(recovered).warm.materializationReads,
      beforeRecovered.warm.materializationReads,
    );
    assert.ok(sourceDetailsSearchCounters(recovered).peakTextBytes <= 4096);
  } finally {
    clearSourceTextProjectionCache(recovered);
    clearIntakeStateCache(recovered);
    recovered.close();
  }
});

test('v4 selected binding and auxiliary churn do no text reconstruction; unsupported logical export fails the search', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-v4-source-search-'));
  const identity = {
    profileId: 'fictional-search',
    intakeId: 'fictional-source',
    sourceHash: 'b'.repeat(64),
  };
  const db = openDatabase(join(root, 'cache.sqlite'), identity.profileId);
  t.after(() => {
    clearSourceTextProjectionCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  memoryRecordAuthority(db);
  const compact = prepareInitialIntakeEnvelope({
    intake: { version: 0, workflow: { format: 'health-intake-workflow-v1' } },
  });
  const store = createIntakeStateStorage(db, identity).collections;
  const stage = (changes: Parameters<typeof store.prepare>[1]['changes']) => {
    const operationId = randomUUID();
    const prepared = store.prepare(store.openView(), {
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: 0,
      changes,
    });
    store.stage(prepared);
  };
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(
      identity.intakeId,
      'fictional.zip',
      identity.sourceHash,
      0,
      'intake_original',
      compact.detailsJson,
    );
    // Deliberately unsupported app schema: a selected primitive tree is not a
    // complete operational envelope or proof of an absent search term.
    stage([
      {
        area: 'logical',
        collection: 'unsupported-fictional-schema',
        op: 'put',
        key: 'one',
        value: 'needle',
      },
    ]);
  });
  reconcileSourceTextProjection(db);
  const before = structuredClone(sourceTextProjectionCounters(db));
  transaction(db, () => stage([]));
  reconcileSourceTextProjection(db);
  const after = sourceTextProjectionCounters(db);
  assert.equal(after.contentRowsWritten, 0);
  assert.equal(after.occurrenceRowsWritten, 0);
  assert.equal(after.linkRowsWritten, 0);
  assert.equal(
    after.authorityBytes - before.authorityBytes,
    Buffer.byteLength(compact.detailsJson),
  );
  const work = intakeWorkCounters(db);
  assert.equal(work.warm.envelopeHydrations, 0);
  assert.equal(work.warm.materializationReads, 0);
  const search = createSourceDetailsSearch(db, 'needle');
  try {
    assert.throws(
      () =>
        db
          .prepare(`SELECT count(*) n FROM source_files f WHERE ${search.predicate}`)
          .get(...search.parameters),
      /traversal|envelope|schema/i,
    );
  } finally {
    search.dispose();
  }
  assert.equal(sourceDetailsSearchCounters(db).failedRequests, 1);
  assert.equal(sourceDetailsSearchCounters(db).activeRequests, 0);
});

test('normalized native listings count complete selected text with constant query buffers across inventory growth', async () => {
  const peaks: number[] = [];
  for (const count of [12, 24, 48]) {
    const root = mkdtempSync(join(tmpdir(), 'fictional-native-search-growth-'));
    const identity = {
      profileId: 'fictional-growth',
      intakeId: 'fictional-source',
      sourceHash: 'a'.repeat(64),
    };
    const db = openDatabase(join(root, 'cache.sqlite'), identity.profileId);
    try {
      memoryRecordAuthority(db);
      const envelope = {
        z: 'outer',
        intake: {
          version: 0,
          workflow: {
            format: 'health-intake-workflow-v1',
            index: {
              members: Array.from({ length: count }, (_, index) => ({
                id: `member:${index}`,
                filename: `Fictional ${index} Ω😀.txt`,
                ordinal: index,
                unknown: 'retained member evidence',
              })),
            },
          },
        },
        a: 'tail',
      };
      let text = JSON.stringify(envelope);
      transaction(db, () =>
        registerIntakeFile(db, {
          id: identity.intakeId,
          providerId: null,
          path: 'fictional-source.zip',
          sha256: identity.sourceHash,
          size: 0,
          mimeType: 'application/zip',
          kind: 'intake_original',
          coverage: 'unknown',
          details: envelope,
        }),
      );
      await buildIntakeCollectionEnvelope(db, { id: identity.intakeId });
      clearIntakeStateCache(db);
      clearSourceTextProjectionCache(db);
      const before = structuredClone(intakeWorkCounters(db));
      const listing = sourceFiles(
        db,
        new URLSearchParams({ q: 'definitely-absent-needle', limit: '1' }),
      );
      assert.equal(listing.total, 0);
      assert.equal(listing.complete, true);
      assert.equal(sourceDetailsSearchCounters(db).streamedBytes, 2 * Buffer.byteLength(text));
      assert.ok(sourceDetailsSearchCounters(db).peakTextBytes <= 4096);
      peaks.push(sourceDetailsSearchCounters(db).peakMatcherBytes);
      const reader = openIntakeCollectionEnvelope(db, { id: identity.intakeId });
      const intake = reader.child(reader.root(), 'intake')!,
        workflow = reader.child(intake, 'workflow')!,
        index = reader.child(workflow, 'index')!;
      const member = reader.children(index, 'members', { items: 1, bytes: 4096 }).records[0]!;
      const operationId = randomUUID();
      const prepared = prepareIntakeEnvelopeFieldMutation(
        db,
        { id: identity.intakeId },
        {
          reader,
          record: member,
          field: 'filename',
          jsonText: JSON.stringify('Changed fictional filename'),
          operationId,
          requestDigest: createHash('sha256').update(operationId).digest('hex'),
          domainVersion: 0,
        },
      );
      transaction(db, () =>
        stageIntakeEnvelopeFieldMutation(db, { id: identity.intakeId }, prepared),
      );
      text = text.replace(
        JSON.stringify('Fictional 0 Ω😀.txt'),
        JSON.stringify('Changed fictional filename'),
      );
      predicateOracle(db, text, 'Changed fictional filename');
      const found = sourceFiles(
        db,
        new URLSearchParams({ q: 'Changed fictional filename', limit: '1' }),
      );
      assert.equal(found.total, 1);
      assert.equal(Object.hasOwn(found.data[0]!, 'details'), false);
      const work = intakeWorkCounters(db);
      for (const key of [
        'envelopeHydrations',
        'materializationReads',
        'evidenceReplayVersions',
      ] as const)
        assert.equal(work.warm[key], before.warm[key], key);
      assert.equal(sourceTextProjectionCounters(db).contentRowsWritten, 0);
      assert.equal(sourceTextProjectionCounters(db).occurrenceRowsWritten, 0);
      assert.equal(sourceTextProjectionCounters(db).linkRowsWritten, 0);
    } finally {
      clearSourceTextProjectionCache(db);
      clearIntakeStateCache(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.equal(
    new Set(peaks).size,
    1,
    'matcher numeric state depends on the pattern, not inventory size',
  );
});
