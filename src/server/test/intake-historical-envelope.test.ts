import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import {
  attachRecordDurability,
  captureRecordAcceptedIntakeHeadRead,
  closeRecordAcceptedIntakeHeadRead,
} from '../record-versions.ts';
import { openVault } from '../vault-store.ts';
import { freshKey } from '../vault-crypto.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  intakeEnvelopeFilenameCell,
} from '../intake-collection-envelope.ts';
import {
  captureIntakeLegacyBridgeReadWitness,
  disposeIntakeLegacyBridgeReadWitness,
  assertIntakeLegacyBridgeReadWitnessForSource,
} from '../intake-state-migration.ts';
import { intakeNamespace, LOG_COLLECTION_FORMAT } from '../intake-state-evidence.ts';
import { ensureIntakeFrontierObserver } from '../intake-lookup-frontier-observer.ts';
import { attachPersonalDurability } from '../portable.ts';
import { contributorAuthorityPath } from '../contributor-record-storage.ts';

test('historical V4 cell parts retain signed membership across later heads and cache loss', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-historical-envelope-'));
  const profileId = 'fictional-historical-envelope';
  const intakeId = 'fictional-historical-intake';
  const paths = ensureProfileDirectories(root, profileId);
  const key = freshKey();
  const vault = openVault({ directory: paths.root, profileId, key, initialize: true });
  const db = openDatabase(paths.database, profileId);
  t.after(() => {
    db.close();
    vault.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  });
  const original = Buffer.from('Fictional historical V4 source.');
  const sourceHash = createHash('sha256').update(original).digest('hex');
  const path = profilePaths(root, profileId).relativeRoot + '/sources/fictional.pdf';
  writeFileSync(join(root, path), original);
  vault.storeFile(path, original);
  vault.publish();
  attachRecordDurability(db, { profileId, storage: vault.recordStorage() });
  const name = 'fictional-' + 'selected-name-'.repeat(900) + '.pdf';
  const initial = prepareInitialIntakeEnvelope({
    intake: { version: 1, originalName: name, state: 'ready' },
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,mime_type,details_json) VALUES(?,?,?,?,?,?,?)',
    ).run(
      intakeId,
      path,
      sourceHash,
      original.length,
      'intake_original',
      'application/pdf',
      initial.detailsJson,
    );
    createIntakeStateStorage(db, { profileId, intakeId, sourceHash }).stage(
      initial.state,
      randomUUID(),
    );
  });
  const source = { id: intakeId, sha256: sourceHash };
  await buildIntakeCollectionEnvelope(db, source);
  const selected = openIntakeCollectionEnvelope(db, source);
  const intake = selected.child(selected.root(), 'intake')!;
  const cellKey = 'c:' + intakeEnvelopeFilenameCell(selected, intake, 'originalName').id;
  const collections = selectedEnvelopeStore(db, source).collections;
  const before = collections.binding(collections.openView())!;
  const identity = { profileId, intakeId, sourceHash };
  const headKey = intakeNamespace(identity) + 'head';
  const beforeRaw = db.prepare('SELECT value FROM app_meta WHERE key=?').get(headKey)!.value;
  const read = async (sequence: number, logicalRoot: typeof before.logical.root, key: string) => {
    ensureIntakeFrontierObserver(db);
    const witness = captureIntakeLegacyBridgeReadWitness(db, intakeId);
    let accepted: Awaited<ReturnType<typeof captureRecordAcceptedIntakeHeadRead>> | undefined;
    try {
      accepted = await captureRecordAcceptedIntakeHeadRead(db, identity, () =>
        assertIntakeLegacyBridgeReadWitnessForSource(db, witness, intakeId),
      );
      const parts: Buffer[] = [];
      let after: string | undefined;
      for (;;) {
        const part = collections.historicalEnvelopeCellPart(
          witness,
          accepted,
          sequence,
          logicalRoot,
          key,
          after,
        );
        assert.ok(part);
        if (part.kind === 'inline') return part.text;
        parts.push(part.chunk);
        if (part.complete) {
          assert.equal(Buffer.concat(parts).length, part.bytes);
          return Buffer.concat(parts).toString('utf8');
        }
        after = part.after!;
      }
    } finally {
      try {
        if (accepted) closeRecordAcceptedIntakeHeadRead(accepted);
      } finally {
        disposeIntakeLegacyBridgeReadWitness(witness);
      }
    }
  };
  assert.equal(
    await read(before.storageSequence, before.logical.root, cellKey),
    JSON.stringify(name),
  );
  const otherId = 'fictional-other-intake';
  const otherPath = profilePaths(root, profileId).relativeRoot + '/sources/other.pdf';
  writeFileSync(join(root, otherPath), original);
  vault.storeFile(otherPath, original);
  vault.publish();
  const otherInitial = prepareInitialIntakeEnvelope({
    intake: { version: 1, originalName: 'fictional-other.pdf', state: 'ready' },
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,mime_type,details_json) VALUES(?,?,?,?,?,?,?)',
    ).run(
      otherId,
      otherPath,
      sourceHash,
      original.length,
      'intake_original',
      'application/pdf',
      otherInitial.detailsJson,
    );
    createIntakeStateStorage(db, { profileId, intakeId: otherId, sourceHash }).stage(
      otherInitial.state,
      randomUUID(),
    );
  });
  await buildIntakeCollectionEnvelope(db, { id: otherId, sha256: sourceHash });
  const otherCollections = selectedEnvelopeStore(db, {
    id: otherId,
    sha256: sourceHash,
  }).collections;
  const other = otherCollections.binding(otherCollections.openView())!;
  assert.notDeepEqual(other.logical.root, before.logical.root);
  const operationId = randomUUID();
  await collections.admitCurrentLogAsync();
  const prepared = collections.prepare(collections.openView(), {
    operationId,
    requestDigest: createHash('sha256').update(operationId).digest('hex'),
    domainVersion: before.logical.domainVersion + 1,
    changes: [
      {
        area: 'logical',
        collection: 'fictional.history.marker',
        op: 'put',
        key: 'marker',
        value: 'later',
      },
    ],
  });
  collections.releaseLogAdmission();
  transaction(db, () => collections.stage(prepared));
  const afterHead = collections.binding(collections.openView())!;
  assert.ok(afterHead.storageSequence > before.storageSequence);
  clearIntakeStateCache(db);
  assert.equal(
    await read(before.storageSequence, before.logical.root, cellKey),
    JSON.stringify(name),
  );

  ensureIntakeFrontierObserver(db);
  const witness = captureIntakeLegacyBridgeReadWitness(db, intakeId);
  const accepted = await captureRecordAcceptedIntakeHeadRead(db, identity, () =>
    assertIntakeLegacyBridgeReadWitnessForSource(db, witness, intakeId),
  );
  try {
    const trueRoot = before.logical.root;
    assert.ok(trueRoot);
    assert.throws(
      () =>
        collections.historicalEnvelopeCellPart(
          witness,
          accepted,
          before.storageSequence + 1,
          before.logical.root,
          cellKey,
        ),
      /historical envelope root differs|historical envelope selected head differs/,
    );
    assert.throws(
      () =>
        collections.historicalEnvelopeCellPart(
          witness,
          accepted,
          before.storageSequence,
          other.logical.root,
          cellKey,
        ),
      /historical envelope root differs/,
    );
    assert.throws(
      () =>
        otherCollections.historicalEnvelopeCellPart(
          witness,
          accepted,
          other.storageSequence,
          other.logical.root,
          cellKey,
        ),
      /legacy bridge original read source changed/,
    );
    assert.throws(
      () =>
        collections.historicalEnvelopeCellPart(
          witness,
          accepted,
          before.storageSequence,
          { ...trueRoot, hash: '0'.repeat(64) },
          cellKey,
        ),
      /historical envelope root differs/,
    );
    assert.throws(
      () =>
        collections.historicalEnvelopeCellPart(
          witness,
          accepted,
          afterHead.storageSequence + 1,
          before.logical.root,
          cellKey,
        ),
      /historical envelope sequence/,
    );
  } finally {
    try {
      closeRecordAcceptedIntakeHeadRead(accepted);
    } finally {
      disposeIntakeLegacyBridgeReadWitness(witness);
    }
  }

  const peer = new DatabaseSync(paths.database);
  try {
    const prefix = intakeNamespace({ profileId, intakeId, sourceHash }) + 'node:';
    const nodeKey =
      prefix +
      (afterHead.format === LOG_COLLECTION_FORMAT ? afterHead.peaks! : afterHead.history!.hash);
    const saved = db.prepare('SELECT value FROM app_meta WHERE key=?').get(nodeKey)!
      .value as string;
    ensureIntakeFrontierObserver(db);
    const pinned = captureIntakeLegacyBridgeReadWitness(db, intakeId);
    const pinnedAccepted = await captureRecordAcceptedIntakeHeadRead(db, identity, () =>
      assertIntakeLegacyBridgeReadWitnessForSource(db, pinned, intakeId),
    );
    try {
      peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{}', nodeKey);
      assert.throws(() =>
        collections.historicalEnvelopeCellPart(
          pinned,
          pinnedAccepted,
          before.storageSequence,
          before.logical.root,
          cellKey,
        ),
      );
    } finally {
      try {
        assert.throws(
          () => closeRecordAcceptedIntakeHeadRead(pinnedAccepted),
          /legacy bridge original read authority changed/,
        );
      } finally {
        disposeIntakeLegacyBridgeReadWitness(pinned);
        peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(saved, nodeKey);
      }
    }
    const selectedHead = db.prepare('SELECT value FROM app_meta WHERE key=?').get(headKey)!.value;
    assert.equal(typeof beforeRaw, 'string');
    assert.equal(typeof selectedHead, 'string');
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(beforeRaw, headKey);
    ensureIntakeFrontierObserver(db);
    let admitted = false;
    try {
      await assert.rejects(async () => {
        const rewound = captureIntakeLegacyBridgeReadWitness(db, intakeId);
        try {
          const cap = await captureRecordAcceptedIntakeHeadRead(db, identity, () =>
            assertIntakeLegacyBridgeReadWitnessForSource(db, rewound, intakeId),
          );
          admitted = true;
          closeRecordAcceptedIntakeHeadRead(cap);
        } finally {
          disposeIntakeLegacyBridgeReadWitness(rewound);
        }
      }, /Vault original backing verification refused/);
      assert.equal(admitted, false);
    } finally {
      peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(selectedHead, headKey);
    }
  } finally {
    peer.close();
  }
});

test('contributor historical V4 read binds selected HEAD to accepted backing before entry', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-contributor-history-'));
  const profileId = 'fictional-contributor-history';
  const intakeId = 'fictional-contributor-intake';
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  attachPersonalDurability(db, { root, profileId });
  const original = Buffer.from('Fictional contributor historical source.');
  const sourceHash = createHash('sha256').update(original).digest('hex');
  const path = paths.relativeRoot + '/sources/contributor.pdf';
  writeFileSync(join(root, path), original);
  const name = 'fictional-' + 'contributor-name-'.repeat(900) + '.pdf';
  const initial = prepareInitialIntakeEnvelope({
    intake: { version: 1, originalName: name, state: 'ready' },
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,mime_type,details_json) VALUES(?,?,?,?,?,?,?)',
    ).run(
      intakeId,
      path,
      sourceHash,
      original.length,
      'intake_original',
      'application/pdf',
      initial.detailsJson,
    );
    createIntakeStateStorage(db, { profileId, intakeId, sourceHash }).stage(
      initial.state,
      randomUUID(),
    );
  });
  const source = { id: intakeId, sha256: sourceHash };
  await buildIntakeCollectionEnvelope(db, source);
  const selected = openIntakeCollectionEnvelope(db, source);
  const intake = selected.child(selected.root(), 'intake')!;
  const cellKey = 'c:' + intakeEnvelopeFilenameCell(selected, intake, 'originalName').id;
  const collections = selectedEnvelopeStore(db, source).collections;
  const before = collections.binding(collections.openView())!;
  const identity = { profileId, intakeId, sourceHash };
  const headKey = intakeNamespace(identity) + 'head';
  const beforeRaw = db.prepare('SELECT value FROM app_meta WHERE key=?').get(headKey)!.value;
  const operationId = randomUUID();
  await collections.admitCurrentLogAsync();
  const prepared = collections.prepare(collections.openView(), {
    operationId,
    requestDigest: createHash('sha256').update(operationId).digest('hex'),
    domainVersion: before.logical.domainVersion + 1,
    changes: [
      {
        area: 'logical',
        collection: 'fictional.history.marker',
        op: 'put',
        key: 'marker',
        value: 'later',
      },
    ],
  });
  collections.releaseLogAdmission();
  transaction(db, () => collections.stage(prepared));
  const after = collections.binding(collections.openView())!;
  assert.ok(after.storageSequence > before.storageSequence);
  ensureIntakeFrontierObserver(db);
  const witness = captureIntakeLegacyBridgeReadWitness(db, intakeId);
  let accepted: Awaited<ReturnType<typeof captureRecordAcceptedIntakeHeadRead>> | undefined;
  try {
    accepted = await captureRecordAcceptedIntakeHeadRead(db, identity, () =>
      assertIntakeLegacyBridgeReadWitnessForSource(db, witness, intakeId),
    );
    const first = collections.historicalEnvelopeCellPart(
      witness,
      accepted,
      before.storageSequence,
      before.logical.root,
      cellKey,
    );
    if (first?.kind !== 'bytes') throw Error('Expected bounded contributor historical bytes');
    assert.ok(first.chunk.length <= 16 * 1024);
  } finally {
    try {
      if (accepted) closeRecordAcceptedIntakeHeadRead(accepted);
    } finally {
      disposeIntakeLegacyBridgeReadWitness(witness);
    }
  }
  const peer = new DatabaseSync(paths.database);
  try {
    const selectedHead = db.prepare('SELECT value FROM app_meta WHERE key=?').get(headKey)!.value;
    assert.equal(typeof beforeRaw, 'string');
    const assertCleanAdmission = async () => {
      ensureIntakeFrontierObserver(db);
      const observed = captureIntakeLegacyBridgeReadWitness(db, intakeId);
      try {
        const cap = await captureRecordAcceptedIntakeHeadRead(db, identity, () =>
          assertIntakeLegacyBridgeReadWitnessForSource(db, observed, intakeId),
        );
        try {
          assert.ok(
            collections.historicalEnvelopeCellPart(
              observed,
              cap,
              before.storageSequence,
              before.logical.root,
              cellKey,
            ),
          );
        } finally {
          closeRecordAcceptedIntakeHeadRead(cap);
        }
      } finally {
        disposeIntakeLegacyBridgeReadWitness(observed);
      }
    };
    await assertCleanAdmission();
    const recordId = JSON.stringify([headKey]);
    const savedVersion = db
      .prepare(
        "SELECT c.version_id,v.contents_json FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity='app_meta' AND c.record_id=?",
      )
      .get(recordId)!;
    assert.equal(typeof savedVersion.version_id, 'string');
    assert.equal(typeof savedVersion.contents_json, 'string');
    const physicalHead = readFileSync(join(contributorAuthorityPath(root, profileId), 'head'));
    const expectRefusal = async () => {
      ensureIntakeFrontierObserver(db);
      let admitted = false;
      await assert.rejects(async () => {
        const observed = captureIntakeLegacyBridgeReadWitness(db, intakeId);
        try {
          const cap = await captureRecordAcceptedIntakeHeadRead(db, identity, () =>
            assertIntakeLegacyBridgeReadWitnessForSource(db, observed, intakeId),
          );
          admitted = true;
          closeRecordAcceptedIntakeHeadRead(cap);
        } finally {
          disposeIntakeLegacyBridgeReadWitness(observed);
        }
      });
      assert.equal(admitted, false);
      assert.deepEqual(
        readFileSync(join(contributorAuthorityPath(root, profileId), 'head')),
        physicalHead,
      );
    };
    const forgedVersion = randomUUID();
    peer.exec('BEGIN');
    try {
      peer
        .prepare(
          'INSERT INTO __record_versions(version_id,profile_id,entity,record_id,sequence,recorded_at,previous_version,operation_id,deleted,contents_json,metadata_json) SELECT ?,profile_id,entity,record_id,sequence,recorded_at,previous_version,operation_id,deleted,?,metadata_json FROM __record_versions WHERE version_id=?',
        )
        .run(
          forgedVersion,
          JSON.stringify({ key: headKey, value: beforeRaw }),
          savedVersion.version_id,
        );
      peer
        .prepare("UPDATE __record_current SET version_id=? WHERE entity='app_meta' AND record_id=?")
        .run(forgedVersion, recordId);
      peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(beforeRaw, headKey);
      peer.exec('COMMIT');
    } catch (error) {
      peer.exec('ROLLBACK');
      throw error;
    }
    try {
      await expectRefusal();
    } finally {
      peer.exec('BEGIN');
      try {
        peer
          .prepare(
            "UPDATE __record_current SET version_id=? WHERE entity='app_meta' AND record_id=?",
          )
          .run(savedVersion.version_id, recordId);
        peer.prepare('DELETE FROM __record_versions WHERE version_id=?').run(forgedVersion);
        peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(selectedHead, headKey);
        peer.exec('COMMIT');
      } catch (error) {
        peer.exec('ROLLBACK');
        throw error;
      }
    }
    await assertCleanAdmission();
    peer
      .prepare('UPDATE __record_versions SET contents_json=? WHERE version_id=?')
      .run(savedVersion.contents_json + '\0fictional-hidden-tail', savedVersion.version_id);
    try {
      await expectRefusal();
    } finally {
      peer
        .prepare('UPDATE __record_versions SET contents_json=? WHERE version_id=?')
        .run(savedVersion.contents_json, savedVersion.version_id);
    }
    await assertCleanAdmission();
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(beforeRaw, headKey);
    ensureIntakeFrontierObserver(db);
    let admitted = false;
    try {
      await assert.rejects(async () => {
        const rewound = captureIntakeLegacyBridgeReadWitness(db, intakeId);
        try {
          const cap = await captureRecordAcceptedIntakeHeadRead(db, identity, () =>
            assertIntakeLegacyBridgeReadWitnessForSource(db, rewound, intakeId),
          );
          admitted = true;
          closeRecordAcceptedIntakeHeadRead(cap);
        } finally {
          disposeIntakeLegacyBridgeReadWitness(rewound);
        }
      }, /accepted|head|binding|immutable|authority|changed/i);
      assert.equal(admitted, false);
    } finally {
      peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(selectedHead, headKey);
    }
  } finally {
    peer.close();
  }
});
