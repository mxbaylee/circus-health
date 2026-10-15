import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { prepareIntakeCompactMetadata } from '../intake-compact-metadata.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { clearIntakeStateCache, createIntakeStateStorage } from '../intake-state-storage.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';

test(
  'fictional non-shortened metadata exposes the current whole compact target',
  { timeout: 120000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-compact-target-gap-'));
    const profileId = 'fictional-compact-target-gap',
      id = 'fictional-original';
    const paths = ensureProfileDirectories(root, profileId);
    const db = openDatabase(paths.database, profileId);
    t.after(() => {
      clearIntakeStateCache(db);
      if (db.isOpen) db.close();
      rmSync(root, { recursive: true, force: true });
    });
    attachPersonalDurability(db, { root, profileId });
    const original = Buffer.from('Independently fictional giant target evidence.');
    const source = { id, sha256: createHash('sha256').update(original).digest('hex') };
    const path = paths.relativeRoot + '/sources/fictional.txt';
    writeFileSync(join(root, path), original);
    const initial = prepareInitialIntakeEnvelope({
      intake: {
        version: 1,
        originalName: 'fictional.txt',
        state: 'ready',
        metadata: { source: 'Fictional Clinic', careArea: null, documentType: null, topics: [] },
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
    const view = openIntakeCollectionEnvelope(db, source);
    const intake = view.child(view.root(), 'intake')!;
    const metadata = view.child(intake, 'metadata')!;
    const filename = 'fictional-' + 'n'.repeat(20000) + '.txt';
    const ordinaryValue = 'Fictional Clinic ' + 'm'.repeat(2 * 1024 * 1024);
    const operationId = randomUUID();
    const changed = await prepareIntakeEnvelopeMutation(db, source, {
      reader: view,
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: 2,
      changes: [
        { op: 'set', record: intake, field: 'originalName', jsonText: JSON.stringify(filename) },
        { op: 'set', record: metadata, field: 'source', jsonText: JSON.stringify(ordinaryValue) },
      ],
    });
    assert.ok(changed.projectDetailsJson);
    const oldMetadata = changed.projectDetailsJson({
      bytes: Buffer.byteLength(ordinaryValue) + 65536,
    });
    transaction(db, () => {
      selectedEnvelopeStore(db, source).collections.stage(changed.prepared!);
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(oldMetadata, id);
    });
    const before = intakeWorkCounters(db).reconstruction.compactMetadataProjectionBytes;
    assert.equal((await prepareIntakeCompactMetadata(db, source)).changed, true);
    const projectionBytes =
      intakeWorkCounters(db).reconstruction.compactMetadataProjectionBytes - before;
    const target = String(
      db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!.details_json,
    );
    assert.equal(JSON.parse(target).intake.metadata.source, ordinaryValue);
    assert.ok(projectionBytes > 2 * 1024 * 1024);
    assert.ok(Buffer.byteLength(target) > 2 * 1024 * 1024);
    t.diagnostic(
      JSON.stringify({ ordinaryFieldBytes: Buffer.byteLength(ordinaryValue), projectionBytes }),
    );
  },
);
