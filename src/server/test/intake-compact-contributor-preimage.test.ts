import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import {
  contributorAuthorityMarker,
  contributorAuthorityPath,
} from '../contributor-record-storage.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { iterateIntakeEnvelopeText } from '../intake-collection-envelope.ts';
import { prepareIntakeCompactMetadata } from '../intake-compact-metadata.ts';
import { intakeMetadataScalarMatches } from '../intake-compact-scalar.ts';
import { intakeSourceMetadata } from '../intake-state-access.ts';
import { clearIntakeStateCache, createIntakeStateStorage } from '../intake-state-storage.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { recordDurabilityStatus } from '../record-versions.ts';

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
  assert.equal(
    (await prepareIntakeCompactMetadata(db, source)).changed,
    true,
    'the genuine filesystem-backed positive control publishes',
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
    /source preimage differs from accepted immutable history/,
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
