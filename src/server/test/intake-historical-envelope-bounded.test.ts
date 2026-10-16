import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import {
  attachRecordDurability,
  captureRecordAcceptedIntakeHeadRead,
  closeRecordAcceptedIntakeHeadRead,
} from '../record-versions.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
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
import { intakeWorkCounters } from '../intake-work-accounting.ts';

test('accepted historical name streams bounded parts without repeating cold physical replay', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-historical-bounded-'));
  const profileId = 'fictional-historical-bounded';
  const intakeId = 'fictional-historical-bounded-intake';
  const paths = ensureProfileDirectories(root, profileId);
  const key = freshKey();
  const vault = openVault({ directory: paths.root, profileId, key, initialize: true });
  const db = openDatabase(paths.database, profileId);
  t.after(() => {
    if (db.isOpen) db.close();
    vault.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  });
  const original = Buffer.from('Independently fictional bounded history source.');
  const sourceHash = createHash('sha256').update(original).digest('hex');
  const path = profilePaths(root, profileId).relativeRoot + '/sources/fictional.pdf';
  writeFileSync(join(root, path), original);
  vault.storeFile(path, original);
  vault.publish();
  attachRecordDurability(db, { profileId, storage: vault.recordStorage() });
  const name = 'fictional-' + 'named-record-'.repeat(170000) + '.pdf';
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
  const operationId = randomUUID();
  const later = collections.prepare(collections.openView(), {
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
  transaction(db, () => collections.stage(later));
  clearIntakeStateCache(db);
  const identity = { profileId, intakeId, sourceHash };
  const work = createRecordVersionWorkCounters();
  await withRecordVersionWork(work, async () => {
    const witness = captureIntakeLegacyBridgeReadWitness(db, intakeId);
    let accepted: Awaited<ReturnType<typeof captureRecordAcceptedIntakeHeadRead>> | undefined;
    try {
      accepted = await captureRecordAcceptedIntakeHeadRead(db, identity, () =>
        assertIntakeLegacyBridgeReadWitnessForSource(db, witness, intakeId),
      );
      const parts: Buffer[] = [];
      let after: string | undefined;
      let firstPhysical: number | undefined;
      let firstCold: number | undefined;
      const beforeReads = intakeWorkCounters(db).primitive.metadataReads;
      for (;;) {
        const part = collections.historicalEnvelopeCellPart(
          witness,
          accepted,
          before.storageSequence,
          before.logical.root,
          cellKey,
          after,
        );
        assert.ok(part && part.kind === 'bytes');
        assert.ok(part.chunk.length <= 16 * 1024);
        assert.ok(part.chunk.length > 0);
        parts.push(part.chunk);
        if (firstPhysical === undefined) {
          firstPhysical = work.operation.vaultBackingPhysicalMembersVerified;
          firstCold = work.operation.vaultBackingColdReplays;
        }
        if (part.complete) break;
        assert.ok(part.after && part.after !== after);
        after = part.after;
      }
      const raw = Buffer.concat(parts);
      assert.equal(raw.toString('utf8'), JSON.stringify(name));
      assert.ok(parts.length > 100);
      assert.equal(work.operation.vaultBackingPhysicalMembersVerified, firstPhysical);
      assert.equal(work.operation.vaultBackingColdReplays, firstCold);
      t.diagnostic(
        JSON.stringify({
          lexicalBytes: raw.length,
          parts: parts.length,
          metadataReads: intakeWorkCounters(db).primitive.metadataReads - beforeReads,
          coldReplays: work.operation.vaultBackingColdReplays,
          physicalMembers: work.operation.vaultBackingPhysicalMembersVerified,
        }),
      );
    } finally {
      try {
        if (accepted) closeRecordAcceptedIntakeHeadRead(accepted);
      } finally {
        disposeIntakeLegacyBridgeReadWitness(witness);
      }
    }
  });
  const manifest = join(paths.root, 'vault', 'manifest.enc');
  const originalManifest = join(paths.root, 'vault', 'manifest.fictional-original');
  const bytes = readFileSync(manifest);
  const finalWitness = captureIntakeLegacyBridgeReadWitness(db, intakeId);
  const finalAccepted = await captureRecordAcceptedIntakeHeadRead(db, identity, () =>
    assertIntakeLegacyBridgeReadWitnessForSource(db, finalWitness, intakeId),
  );
  try {
    const finalPart = collections.historicalEnvelopeCellPart(
      finalWitness,
      finalAccepted,
      before.storageSequence,
      before.logical.root,
      cellKey,
    );
    assert.ok(finalPart && finalPart.kind === 'bytes');
    renameSync(manifest, originalManifest);
    writeFileSync(manifest, bytes);
    assert.throws(() => closeRecordAcceptedIntakeHeadRead(finalAccepted));
  } finally {
    if (readFileSync(manifest).equals(bytes)) renameSync(originalManifest, manifest);
    disposeIntakeLegacyBridgeReadWitness(finalWitness);
  }
  const witness = captureIntakeLegacyBridgeReadWitness(db, intakeId);
  const accepted = await captureRecordAcceptedIntakeHeadRead(db, identity, () =>
    assertIntakeLegacyBridgeReadWitnessForSource(db, witness, intakeId),
  );
  try {
    const first = collections.historicalEnvelopeCellPart(
      witness,
      accepted,
      before.storageSequence,
      before.logical.root,
      cellKey,
    );
    assert.ok(first && first.kind === 'bytes' && !first.complete);
    renameSync(manifest, originalManifest);
    writeFileSync(manifest, bytes);
    assert.throws(() =>
      collections.historicalEnvelopeCellPart(
        witness,
        accepted,
        before.storageSequence,
        before.logical.root,
        cellKey,
        first.after!,
      ),
    );
    assert.throws(() => closeRecordAcceptedIntakeHeadRead(accepted));
  } finally {
    if (readFileSync(manifest).equals(bytes)) renameSync(originalManifest, manifest);
    disposeIntakeLegacyBridgeReadWitness(witness);
  }
});
