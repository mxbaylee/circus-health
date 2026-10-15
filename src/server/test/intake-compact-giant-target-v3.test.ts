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
import { parseIntakeReferencedEnvelope } from '../intake-referenced-envelope-codec.ts';
import { projectIntakeReferencedTargetCandidateAsync } from '../intake-state-migration.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { clearIntakeStateCache, createIntakeStateStorage } from '../intake-state-storage.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';

test(
  'fictional 2 MiB changed metadata publishes a bounded V3 target and paired HEAD',
  { timeout: 120000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-referenced-target-'));
    const profileId = 'fictional-referenced-target';
    const id = 'fictional-original';
    const paths = ensureProfileDirectories(root, profileId);
    const db = openDatabase(paths.database, profileId);
    t.after(() => {
      clearIntakeStateCache(db);
      if (db.isOpen) db.close();
      rmSync(root, { recursive: true, force: true });
    });
    attachPersonalDurability(db, { root, profileId });
    const original = Buffer.from('Independently fictional referenced target evidence.');
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
    const ordinaryValue = 'Fictional Clinic ' + 'm'.repeat(2 * 1024 * 1024);
    const operationId = randomUUID();
    const changed = await prepareIntakeEnvelopeMutation(db, source, {
      reader: view,
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: 2,
      changes: [
        { op: 'set', record: metadata, field: 'source', jsonText: JSON.stringify(ordinaryValue) },
      ],
    });
    assert.ok(changed.projectDetailsJson);
    const oldMetadata = changed.projectDetailsJson({
      bytes: Buffer.byteLength(ordinaryValue) + 65536,
    });
    assert.ok(Buffer.byteLength(oldMetadata) > 2 * 1024 * 1024);
    transaction(db, () => {
      selectedEnvelopeStore(db, source).collections.stage(changed.prepared!);
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(oldMetadata, id);
    });
    const identity = { profileId, intakeId: id, sourceHash: source.sha256 };
    const headKey = intakeNamespace(identity) + 'head';
    const beforeHead = String(
      db.prepare('SELECT value FROM app_meta WHERE key=?').get(headKey)!.value,
    );
    const candidate = await projectIntakeReferencedTargetCandidateAsync(
      db,
      { identity, afterHead: beforeHead, writes: [] },
      () => {},
    );
    const priorProjectionBytes =
      intakeWorkCounters(db).reconstruction.compactMetadataProjectionBytes;
    assert.deepEqual(
      await prepareIntakeCompactMetadata(db, source, { referencedTargetCandidate: candidate }),
      { changed: true },
    );
    const projectionBytes =
      intakeWorkCounters(db).reconstruction.compactMetadataProjectionBytes - priorProjectionBytes;
    const target = String(
      db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!.details_json,
    );
    const parsed = parseIntakeReferencedEnvelope(target);
    assert.equal(parsed.intakeAuthority.identity.intakeId, id);
    assert.equal(parsed.intakeAuthority.sourceLabel.kind, 'string');
    if (parsed.intakeAuthority.sourceLabel.kind === 'string') {
      assert.equal(parsed.intakeAuthority.sourceLabel.truncated, true);
      assert.ok(parsed.intakeAuthority.sourceLabel.preview.startsWith('Fictional Clinic'));
    }
    assert.ok(projectionBytes < 8192);
    assert.ok(Buffer.byteLength(target) < 8192);
    const sourceVersion = db
      .prepare(
        "SELECT v.sequence,v.contents_json FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity='source_files' AND c.record_id=?",
      )
      .get(JSON.stringify([id]))!;
    const headVersion = db
      .prepare(
        "SELECT v.sequence FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity='app_meta' AND c.record_id=?",
      )
      .get(JSON.stringify([headKey]))!;
    assert.equal(sourceVersion.sequence, headVersion.sequence);
    assert.ok(Buffer.byteLength(String(sourceVersion.contents_json)) < 16 * 1024);
    assert.notEqual(
      db.prepare('SELECT value FROM app_meta WHERE key=?').get(headKey)!.value,
      beforeHead,
    );
    t.diagnostic(JSON.stringify({ oldBytes: Buffer.byteLength(oldMetadata), projectionBytes }));
  },
);
