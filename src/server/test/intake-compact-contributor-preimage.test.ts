import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import {
  contributorAuthorityMarker,
  contributorAuthorityPath,
} from '../contributor-record-storage.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  iterateIntakeEnvelopeText,
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { prepareIntakeCompactMetadata } from '../intake-compact-metadata.ts';
import { intakeMetadataScalarMatches } from '../intake-compact-scalar.ts';
import { intakeSourceMetadata } from '../intake-state-access.ts';
import { clearIntakeStateCache, createIntakeStateStorage } from '../intake-state-storage.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { recordDurabilityStatus } from '../record-versions.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';

test('default portable durability uses genuine contributor authority for compact publication and rejects matching forged SQL preimages', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-contributor-compact-'));
  const profileId = 'fictional-contributor-preimage',
    id = 'fictional-original';
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  t.after(() => {
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  attachPersonalDurability(db, { root, profileId });
  const directory = contributorAuthorityPath(root, profileId);
  const head = () => readFileSync(join(directory, 'head'));
  const selected = () =>
    db
      .prepare(
        "SELECT v.* FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity='source_files' AND c.record_id=?",
      )
      .get(JSON.stringify([id]))!;
  const sourceRow = () => db.prepare('SELECT * FROM source_files WHERE id=?').get(id)!;
  const immutableObjects = () =>
    readdirSync(join(directory, 'objects'))
      .sort()
      .map((name) => [
        name,
        createHash('sha256')
          .update(readFileSync(join(directory, 'objects', name)))
          .digest('hex'),
      ]);
  assert.equal(
    JSON.parse(readFileSync(contributorAuthorityMarker(root, profileId), 'utf8')).format,
    'health-contributor-record-authority-v1',
  );
  assert.equal(existsSync(join(paths.personal, 'current.json')), false);
  assert.equal(existsSync(join(paths.curation, 'current.json')), false);
  assert.throws(
    () => attachPersonalDurability(db, { root, profileId, portableSnapshots: true }),
    /second portable publisher/,
  );

  const original = Buffer.from('Independently fictional contributor compact preimage evidence.');
  const source = { id, sha256: createHash('sha256').update(original).digest('hex') };
  const path = paths.relativeRoot + '/sources/fictional.txt';
  writeFileSync(join(root, path), original);
  const filename = 'fictional-' + 'x'.repeat(20000) + '.txt';
  const initial = prepareInitialIntakeEnvelope({
    intake: {
      version: 1,
      originalName: filename,
      state: 'ready',
      proposals: [],
      importHistory: [],
      metadata: { source: 'Fictional Clinic', careArea: null, documentType: null, topics: [] },
      workflow: {
        format: 'health-intake-workflow-v1',
        candidates: [],
        questions: [],
        plans: [],
        reportGroups: [],
      },
    },
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,mime_type,details_json) VALUES(?,?,?,?,?,?,?)',
    ).run(
      id,
      path,
      source.sha256,
      original.length,
      'intake_original',
      'text/plain',
      initial.detailsJson,
    );
    createIntakeStateStorage(db, { profileId, intakeId: id, sourceHash: source.sha256 }).stage(
      initial.state,
      randomUUID(),
    );
  });
  await buildIntakeCollectionEnvelope(db, source);
  const exact = [...iterateIntakeEnvelopeText(db, source)].join('');
  const restoreLegacyMetadata = () =>
    transaction(db, () =>
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(initial.detailsJson, id),
    );
  restoreLegacyMetadata();
  assert.ok(
    Buffer.byteLength(initial.detailsJson) > 16384,
    'the accepted source requires compact publication',
  );
  const positiveHead = head(),
    previousVersion = selected().version_id;
  const compactWork = createRecordVersionWorkCounters();
  assert.equal(
    (await withRecordVersionWork(compactWork, () => prepareIntakeCompactMetadata(db, source)))
      .changed,
    true,
    'the genuine filesystem-backed positive control publishes',
  );
  assert.equal(compactWork.operation.compactPriorFullNativeRowsRead, 0);
  assert.equal(compactWork.reconstruction.compactPriorFullNativeRowsRead, 0);
  assert.equal(
    compactWork.operation.compactPriorExactSourceMatches +
      compactWork.reconstruction.compactPriorExactSourceMatches,
    1,
  );
  assert.notDeepEqual(head(), positiveHead);
  const compactVersion = selected();
  assert.notEqual(compactVersion.version_id, previousVersion);
  assert.equal(compactVersion.previous_version, previousVersion);
  assert.equal(
    intakeMetadataScalarMatches(intakeSourceMetadata(db, id).originalName, filename),
    true,
  );
  assert.equal([...iterateIntakeEnvelopeText(db, source)].join(''), exact);
  const status = recordDurabilityStatus(db);
  assert.ok(status?.configured && !status.dirty && !status.conflicted && !status.lastError);

  // Select another genuine accepted legacy preimage before corrupting only disposable SQL.
  restoreLegacyMetadata();
  const accepted = selected();
  const forged = JSON.parse(accepted.contents_json as string);
  assert.equal(forged.mime_type, sourceRow().mime_type);
  forged.mime_type = 'application/fictional-forged';
  db.prepare('UPDATE source_files SET mime_type=? WHERE id=?').run(forged.mime_type, id);
  db.prepare('UPDATE __record_versions SET contents_json=? WHERE version_id=?').run(
    JSON.stringify(forged),
    accepted.version_id,
  );
  db.prepare('DELETE FROM __record_changed').run();
  assert.deepEqual(
    JSON.parse(selected().contents_json as string),
    { ...sourceRow() },
    'the two disposable preimages deliberately agree',
  );
  const beforeHead = head(),
    beforeMarker = readFileSync(contributorAuthorityMarker(root, profileId));
  const beforeObjects = immutableObjects(),
    beforeSource = sourceRow(),
    beforeSelected = selected();
  const beforeCurrent = db
    .prepare("SELECT * FROM __record_current WHERE entity='source_files' AND record_id=?")
    .get(JSON.stringify([id]));
  const beforeVersions = db.prepare('SELECT count(*) AS n FROM __record_versions').get()?.n;
  await assert.rejects(
    prepareIntakeCompactMetadata(db, source),
    /Contributor accepted record predecessor differs/,
  );
  assert.deepEqual(
    head(),
    beforeHead,
    'a matching forged SQL pair cannot advance accepted filesystem HEAD',
  );
  assert.deepEqual(readFileSync(contributorAuthorityMarker(root, profileId)), beforeMarker);
  assert.deepEqual(
    immutableObjects(),
    beforeObjects,
    'refusal neither rewrites nor adds immutable accepted objects',
  );
  assert.deepEqual(
    sourceRow(),
    beforeSource,
    'refusal does not replace, compact or silently repair the forged disposable source',
  );
  assert.deepEqual(
    selected(),
    beforeSelected,
    'refusal preserves the selected version and its exact disposable preimage',
  );
  assert.deepEqual(
    db
      .prepare("SELECT * FROM __record_current WHERE entity='source_files' AND record_id=?")
      .get(JSON.stringify([id])),
    beforeCurrent,
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM __record_versions').get()?.n, beforeVersions);
  assert.deepEqual(
    readFileSync(join(root, path)),
    original,
    'the initial original remains unchanged',
  );
});

test(
  'contributor compact publication streams an accepted predecessor above the old size cap',
  { timeout: 180000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-contributor-large-compact-'));
    const profileId = 'fictional-contributor-large-compact',
      id = 'fictional-large-original';
    const paths = ensureProfileDirectories(root, profileId);
    const db = openDatabase(paths.database, profileId);
    t.after(() => {
      clearIntakeStateCache(db);
      if (db.isOpen) db.close();
      rmSync(root, { recursive: true, force: true });
    });
    attachPersonalDurability(db, { root, profileId });
    const original = Buffer.from('Independently fictional large contributor predecessor.');
    const source = { id, sha256: createHash('sha256').update(original).digest('hex') };
    const path = paths.relativeRoot + '/sources/fictional-large.txt';
    writeFileSync(join(root, path), original);
    const initial = prepareInitialIntakeEnvelope({
      intake: { version: 1, originalName: 'fictional-large.txt', state: 'ready' },
    });
    transaction(db, () => {
      db.prepare(
        'INSERT INTO source_files(id,path,sha256,bytes,kind,mime_type,details_json) VALUES(?,?,?,?,?,?,?)',
      ).run(
        id,
        path,
        source.sha256,
        original.length,
        'intake_original',
        'text/plain',
        initial.detailsJson,
      );
      createIntakeStateStorage(db, { profileId, intakeId: id, sourceHash: source.sha256 }).stage(
        initial.state,
        randomUUID(),
      );
    });
    await buildIntakeCollectionEnvelope(db, source);
    const view = openIntakeCollectionEnvelope(db, source);
    const filename = 'fictional-contributor-' + 'x'.repeat(8 * 1024 * 1024 + 4096) + '.txt';
    const operationId = randomUUID();
    const changed = await prepareIntakeEnvelopeMutation(db, source, {
      reader: view,
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: 2,
      changes: [
        {
          op: 'set',
          record: view.child(view.root(), 'intake')!,
          field: 'originalName',
          jsonText: JSON.stringify(filename),
        },
      ],
    });
    assert.ok(changed.projectDetailsJson);
    const oldMetadata = changed.projectDetailsJson({ bytes: Buffer.byteLength(filename) + 16384 });
    assert.ok(Buffer.byteLength(oldMetadata) > 8 * 1024 * 1024);
    transaction(db, () => {
      selectedEnvelopeStore(db, source).collections.stage(changed.prepared!);
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(oldMetadata, id);
    });
    const headPath = join(contributorAuthorityPath(root, profileId), 'head');
    const beforeHead = readFileSync(headPath);
    const work = createRecordVersionWorkCounters();
    assert.equal(
      (await withRecordVersionWork(work, () => prepareIntakeCompactMetadata(db, source))).changed,
      true,
    );
    assert.notDeepEqual(readFileSync(headPath), beforeHead);
    assert.equal(
      work.operation.compactPriorFullNativeRowsRead +
        work.reconstruction.compactPriorFullNativeRowsRead,
      0,
    );
    assert.equal(
      work.operation.compactPriorExactSourceMatches +
        work.reconstruction.compactPriorExactSourceMatches,
      1,
    );
    assert.equal(
      intakeMetadataScalarMatches(intakeSourceMetadata(db, id).originalName, filename),
      true,
    );
    assert.deepEqual(readFileSync(join(root, path)), original);
    const status = recordDurabilityStatus(db);
    assert.ok(status?.configured && !status.dirty && !status.conflicted && !status.lastError);
  },
);

async function contributorRefusalFixture(t: TestContext, name: string) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-contributor-' + name + '-'));
  const profileId = 'fictional-contributor-' + name.toLowerCase(),
    id = 'fictional-original';
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  t.after(() => {
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  attachPersonalDurability(db, { root, profileId });
  const original = Buffer.from('Independently fictional contributor refusal evidence.');
  const source = { id, sha256: createHash('sha256').update(original).digest('hex') };
  const path = paths.relativeRoot + '/sources/fictional.txt';
  writeFileSync(join(root, path), original);
  const initial = prepareInitialIntakeEnvelope({
    intake: {
      version: 1,
      originalName: 'fictional-' + 'x'.repeat(20000) + '.txt',
      state: 'ready',
      proposals: [],
      importHistory: [],
    },
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,mime_type,details_json) VALUES(?,?,?,?,?,?,?)',
    ).run(
      id,
      path,
      source.sha256,
      original.length,
      'intake_original',
      'text/plain',
      initial.detailsJson,
    );
    createIntakeStateStorage(db, { profileId, intakeId: id, sourceHash: source.sha256 }).stage(
      initial.state,
      randomUUID(),
    );
  });
  await buildIntakeCollectionEnvelope(db, source);
  transaction(db, () =>
    db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(initial.detailsJson, id),
  );
  const headPath = join(contributorAuthorityPath(root, profileId), 'head');
  return { db, source, id, databasePath: paths.database, headPath, head: readFileSync(headPath) };
}

for (const mutation of [
  'cancel',
  'rolled-back-ABA',
  'peer-commit',
  'late-head-physical',
] as const) {
  test(
    `contributor compact publication refuses ${mutation} without advancing accepted HEAD`,
    { timeout: 60000 },
    async (t) => {
      const { db, source, id, databasePath, headPath, head } = await contributorRefusalFixture(
        t,
        mutation,
      );
      const work = createRecordVersionWorkCounters();
      let fired = false;
      if (mutation === 'late-head-physical') {
        db.setAuthorizer((action, table) => {
          if (!fired && action === constants.SQLITE_INSERT && table === '__record_transactions') {
            fired = true;
            writeFileSync(headPath, readFileSync(headPath));
          }
          return constants.SQLITE_OK;
        });
      }
      await assert.rejects(
        withRecordVersionWork(work, () =>
          mutation === 'late-head-physical'
            ? prepareIntakeCompactMetadata(db, source)
            : prepareIntakeCompactMetadata(db, source, {
                assertRunning() {
                  if (
                    fired ||
                    work.operation.compactPriorExactSourceMatches +
                      work.reconstruction.compactPriorExactSourceMatches !==
                      1
                  )
                    return;
                  fired = true;
                  if (mutation === 'cancel') throw Error('fictional contributor cancellation');
                  if (mutation === 'peer-commit') {
                    const peer = new DatabaseSync(databasePath);
                    try {
                      peer
                        .prepare('UPDATE source_files SET mime_type=? WHERE id=?')
                        .run('fictional/peer-commit', id);
                    } finally {
                      peer.close();
                    }
                    return;
                  }
                  db.exec('SAVEPOINT fictional_contributor_aba');
                  try {
                    db.prepare('UPDATE source_files SET mime_type=? WHERE id=?').run(
                      'fictional/temporary',
                      id,
                    );
                    db.prepare('UPDATE source_files SET mime_type=? WHERE id=?').run(
                      'text/plain',
                      id,
                    );
                  } finally {
                    db.exec('ROLLBACK TO fictional_contributor_aba');
                    db.exec('RELEASE fictional_contributor_aba');
                  }
                },
              }),
        ),
        /cancel|authority|physical|changed|expired|backing/i,
      );
      assert.equal(fired, true, 'the named refusal boundary was exercised');
      assert.deepEqual(readFileSync(headPath), head);
      assert.equal(recordDurabilityStatus(db)?.configured, true);
    },
  );
}
