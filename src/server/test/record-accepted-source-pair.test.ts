import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import {
  attachRecordDurability,
  captureRecordAcceptedIntakeHeadRead,
  assertRecordAcceptedIntakeHeadRead,
  closeRecordAcceptedIntakeHeadRead,
  borrowRecordAcceptedIntakeHeadRead,
  captureRecordAcceptedSourceRead,
  assertRecordAcceptedSourcePreimage,
  assertRecordAcceptedSourceRead,
  closeRecordAcceptedSourceRead,
  recordAcceptedSourcePair,
  recordAcceptedIntakeCurrentSourceDescriptor,
  recordAcceptedIntakeCurrentSourceSummaryFacts,
  recordAcceptedIntakeCurrentSourceVisibility,
  recordAcceptedIntakeCurrentSourcePinVersion,
  recordAcceptedIntakeSourcePair,
} from '../record-versions.ts';
import {
  encodeIntakeReferencedEnvelope,
  INTAKE_REFERENCED_ENVELOPE_FORMAT,
} from '../intake-compact-envelope.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import { openVault } from '../vault-store.ts';
import { unlockPhysicalEntries } from '../encrypted-unlock-physical.ts';
import { freshKey } from '../vault-crypto.ts';
import { attachPersonalDurability } from '../portable.ts';
import { contributorAuthorityPath } from '../contributor-record-storage.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import { createIntakeStateStorage } from '../intake-state-storage.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import {
  consumeIntakeReferencedTargetIntent,
  projectIntakeReferencedTargetCandidateAsync,
} from '../intake-state-migration.ts';
import { prepareIntakeCompactMetadata } from '../intake-compact-metadata.ts';
import {
  observeRecordReplayVersion,
  withRecordReplaySourcePair,
} from '../record-replay-source-pair.ts';

test('accepted visibility replay refuses a deleted event with no target fields', () => {
  const identity = {
    profileId: 'fictional-visibility-deletion',
    intakeId: 'fictional-visibility-original',
    sourceHash: 'a'.repeat(64),
  };
  assert.throws(
    () =>
      withRecordReplaySourcePair({ identity, sourceVersionId: randomUUID() }, () =>
        observeRecordReplayVersion({
          format: 'health-record-versions-v1',
          profileId: identity.profileId,
          schemaVersion: 6,
          sequence: 1,
          recordedAt: '2026-01-02T03:04:05.000Z',
          operationId: randomUUID(),
          versionId: randomUUID(),
          actor: 'Fictional profile owner',
          origin: 'test',
          references: [],
          entity: 'visibility_events',
          recordId: JSON.stringify(['visibility:fictional-deleted']),
          contents: {},
          deleted: true,
          previousVersion: randomUUID(),
        }),
      ),
    /visibility history deleted/,
  );
});

for (const backend of ['vault', 'contributor'] as const)
  test(`${backend} accepted V3 source and V4 HEAD pair survives later HEAD but not original replacement`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), `fictional-${backend}-source-pair-`)),
      profileId = `fictional-${backend}-source-pair`,
      intakeId = `fictional-${backend}-source-pair-intake`,
      paths = ensureProfileDirectories(root, profileId),
      db = openDatabase(paths.database, profileId),
      key = backend === 'vault' ? freshKey() : undefined,
      vault =
        backend === 'vault'
          ? openVault({ directory: paths.root, profileId, key: key!, initialize: true })
          : undefined,
      scratchRoot = backend === 'vault' ? join(root, 'fictional-proof-scratch') : undefined,
      priorTmp = process.env.TMPDIR;
    if (scratchRoot) {
      mkdirSync(scratchRoot);
      process.env.TMPDIR = scratchRoot;
      assert.equal(tmpdir(), scratchRoot);
    }
    t.after(() => {
      if (scratchRoot) {
        if (priorTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = priorTmp;
      }
      if (db.isOpen) db.close();
      vault?.close();
      key?.fill(0);
      rmSync(root, { recursive: true, force: true });
    });
    if (vault) attachRecordDurability(db, { profileId, storage: vault.recordStorage() });
    else attachPersonalDurability(db, { root, profileId });
    const original = Buffer.from('Independently fictional accepted pair original.'),
      sourceHash = createHash('sha256').update(original).digest('hex'),
      path = profilePaths(root, profileId).relativeRoot + '/sources/pair.pdf';
    writeFileSync(join(root, path), original);
    if (vault) {
      vault.storeFile(path, original);
      vault.publish();
    }
    const initial = prepareInitialIntakeEnvelope({
      intake: {
        version: 1,
        originalName: 'fictional-pair.pdf',
        state: 'ready',
        metadata: { source: 'Fictional referral ' + 'x'.repeat(64 * 1024) },
      },
    });
    assert.ok(Buffer.byteLength(initial.detailsJson) > 64 * 1024);
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
    await buildIntakeCollectionEnvelope(db, { id: intakeId, sha256: sourceHash });
    const collections = selectedEnvelopeStore(db, { id: intakeId, sha256: sourceHash }).collections,
      before = collections.binding(collections.openView())!,
      identity = { profileId, intakeId, sourceHash },
      headKey = intakeNamespace(identity) + 'head',
      headValue = db.prepare('SELECT value FROM app_meta WHERE key=?').get(headKey)!.value;
    assert.ok(before.logical.root);
    const candidate = await projectIntakeReferencedTargetCandidateAsync(
      db,
      { identity, afterHead: String(headValue), writes: [] },
      () => {},
    );
    assert.equal(candidate.headKey, headKey);
    assert.equal(candidate.headValue, headValue);
    assert.ok(Buffer.byteLength(candidate.target) < 8192);
    const current = db.prepare(
      'SELECT version_id FROM __record_current WHERE entity=? AND record_id=?',
    );
    const firstSourceVersion = current.get('source_files', JSON.stringify([intakeId]))!.version_id;
    const firstHeadVersion = current.get('app_meta', JSON.stringify([headKey]))!.version_id;
    if (backend === 'vault') {
      await assert.rejects(
        prepareIntakeCompactMetadata(
          db,
          { id: intakeId, sha256: sourceHash },
          { referencedTargetCandidate: Object.freeze({ ...candidate }) as typeof candidate },
        ),
        /foreign referenced target intent/,
      );
      assert.equal(
        current.get('source_files', JSON.stringify([intakeId]))!.version_id,
        firstSourceVersion,
      );
      assert.equal(
        db.prepare('SELECT value FROM app_meta WHERE key=?').get(headKey)!.value,
        headValue,
      );
    }
    assert.deepEqual(
      await prepareIntakeCompactMetadata(
        db,
        { id: intakeId, sha256: sourceHash },
        { referencedTargetCandidate: candidate },
      ),
      { changed: true },
    );
    assert.throws(
      () => consumeIntakeReferencedTargetIntent(db, candidate, identity, String(headValue)),
      /foreign referenced target intent/,
    );
    const descriptor = String(
      db.prepare('SELECT details_json FROM source_files WHERE id=?').get(intakeId)!.details_json,
    );
    assert.ok(Buffer.byteLength(descriptor) < 8192);
    const pairedHeadValue = String(
      db.prepare('SELECT value FROM app_meta WHERE key=?').get(headKey)!.value,
    );
    assert.notEqual(pairedHeadValue, headValue);
    const sourceVersionId = String(
        current.get('source_files', JSON.stringify([intakeId]))!.version_id,
      ),
      headVersionId = String(current.get('app_meta', JSON.stringify([headKey]))!.version_id);
    assert.notEqual(sourceVersionId, firstSourceVersion);
    assert.notEqual(headVersionId, firstHeadVersion);
    const sourceStored = db
      .prepare('SELECT sequence,contents_json FROM __record_versions WHERE version_id=?')
      .get(sourceVersionId)!;
    const headStored = db
      .prepare('SELECT sequence FROM __record_versions WHERE version_id=?')
      .get(headVersionId)!;
    assert.equal(sourceStored.sequence, headStored.sequence);
    assert.ok(Buffer.byteLength(String(sourceStored.contents_json)) < 16 * 1024);
    const operationId = randomUUID();
    const later = collections.prepare(collections.openView(), {
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: before.logical.domainVersion + 1,
      changes: [
        {
          area: 'logical',
          collection: 'fictional.pair.marker',
          op: 'put',
          key: 'later',
          value: 'accepted',
        },
      ],
    });
    transaction(db, () => collections.stage(later));
    assert.notEqual(
      db.prepare('SELECT value FROM app_meta WHERE key=?').get(headKey)!.value,
      pairedHeadValue,
    );
    const request = { identity, sourceVersionId },
      work = createRecordVersionWorkCounters();
    await withRecordVersionWork(work, async () => {
      const cap = await captureRecordAcceptedIntakeHeadRead(db, identity, () => {}, request);
      let pair: ReturnType<typeof recordAcceptedIntakeSourcePair>;
      try {
        if (backend === 'contributor') {
          const before = work.operation.contributorBackingRetainedChecks;
          const ownerBefore = work.operation.contributorReadOwnerCurrentChecks;
          assertRecordAcceptedIntakeHeadRead(
            db,
            cap,
            identity,
            String(db.prepare('SELECT value FROM app_meta WHERE key=?').get(headKey)!.value),
          );
          const checks = work.operation.contributorBackingRetainedChecks - before;
          assert.ok(checks >= 4);
          assert.equal(checks % 2, 0, 'certificate page checks occur in pairs');
          assert.equal(
            work.operation.contributorReadOwnerCurrentChecks - ownerBefore - checks,
            4,
            'two backend head-current calls each bracket the genuine HEAD read',
          );
        }
        pair = recordAcceptedIntakeSourcePair(db, cap, identity, request);
        assert.deepEqual(pair, {
          sourceVersionId,
          sourceDetails: descriptor,
          sourceFacts: {
            sourceBytes: original.length,
            path: {
              bytes: Buffer.byteLength(path),
              hash: createHash('sha256').update(path).digest('hex'),
            },
            mimeType: {
              bytes: Buffer.byteLength('application/pdf'),
              hash: createHash('sha256').update('application/pdf').digest('hex'),
            },
            mimePredicates: {
              pdf: true,
              image: false,
              previewableImage: false,
              packageMime: false,
              retainOnlyMime: 'readable',
            },
            providerId: null,
          },
          headVersionId,
          headValue: pairedHeadValue,
          recordSequence: pair.recordSequence,
          latestSourceVersionId: sourceVersionId,
          currentVisibility: null,
          currentSourcePin: null,
        });
        assert.ok(Object.isFrozen(pair.sourceFacts));
        assert.ok(Object.isFrozen(pair.sourceFacts.path));
        assert.ok(Object.isFrozen(pair.sourceFacts.mimeType));
        assert.ok(Object.isFrozen(pair.sourceFacts.mimePredicates));
        assert.ok(pair.recordSequence > 0);
        assert.equal(
          recordAcceptedIntakeCurrentSourceDescriptor(db, cap, identity, request),
          descriptor,
        );
        assert.deepEqual(
          await recordAcceptedIntakeCurrentSourceSummaryFacts(db, cap, identity, request),
          {
            bytes: original.length,
            path: { kind: 'value', value: path },
            mimeType: { kind: 'value', value: 'application/pdf' },
            mimePredicates: {
              pdf: true,
              image: false,
              previewableImage: false,
              packageMime: false,
              retainOnlyMime: 'readable',
            },
            providerId: null,
          },
        );
        const cold = work.operation.vaultBackingColdReplays;
        assert.deepEqual(recordAcceptedIntakeSourcePair(db, cap, identity, request), pair);
        assert.equal(work.operation.vaultBackingColdReplays, cold);
      } finally {
        closeRecordAcceptedIntakeHeadRead(cap);
      }
      if (backend === 'contributor') {
        let borrowed: ReturnType<typeof borrowRecordAcceptedIntakeHeadRead> | undefined;
        let revokeOnCurrent = false,
          revocations = 0;
        const source = await captureRecordAcceptedSourceRead(
          db,
          profileId,
          () => {
            if (revokeOnCurrent && borrowed) {
              revocations++;
              revokeOnCurrent = false;
              closeRecordAcceptedIntakeHeadRead(borrowed);
            }
          },
          request,
        );
        try {
          const sourceContents = String(sourceStored.contents_json);
          assertRecordAcceptedSourcePreimage(
            db,
            source,
            profileId,
            JSON.stringify([intakeId]),
            sourceVersionId,
            {
              hash: createHash('sha256').update(sourceContents).digest('hex'),
              bytes: Buffer.byteLength(sourceContents),
            },
          );
          borrowed = borrowRecordAcceptedIntakeHeadRead(db, source, identity, request);
          const currentHead = String(
              db.prepare('SELECT value FROM app_meta WHERE key=?').get(headKey)!.value,
            ),
            retainedBefore = work.operation.contributorBackingRetainedChecks,
            ownerBefore = work.operation.contributorReadOwnerCurrentChecks;
          assertRecordAcceptedIntakeHeadRead(db, borrowed, identity, currentHead);
          const checks = work.operation.contributorBackingRetainedChecks - retainedBefore;
          assert.ok(checks >= 4, 'borrowed backend still checks its retained certificate');
          assert.equal(
            work.operation.contributorReadOwnerCurrentChecks - ownerBefore - checks,
            4,
            'borrowed backend alone checks the original source owner twice',
          );
          revokeOnCurrent = true;
          assert.throws(
            () => assertRecordAcceptedIntakeHeadRead(db, borrowed!, identity, currentHead),
            /expired/,
          );
          assert.equal(revocations, 1, 'revocation happened inside the backend current check');
        } finally {
          if (borrowed) closeRecordAcceptedIntakeHeadRead(borrowed);
          closeRecordAcceptedSourceRead(source);
        }
      }
      if (backend === 'contributor') {
        const source = await captureRecordAcceptedSourceRead(db, profileId, () => {});
        try {
          const before = work.operation.contributorReadOwnerCurrentChecks;
          assertRecordAcceptedSourceRead(db, source, profileId);
          assert.equal(
            work.operation.contributorReadOwnerCurrentChecks - before,
            2,
            'one source-current call brackets the genuine HEAD read with two owner checks',
          );
        } finally {
          closeRecordAcceptedSourceRead(source);
        }
      }
      if (backend === 'vault') {
        const before = { ...work.operation },
          members = [...unlockPhysicalEntries(join(paths.root, 'vault'))].length,
          hot = await captureRecordAcceptedIntakeHeadRead(db, identity, () => {}, request);
        try {
          assert.deepEqual(recordAcceptedIntakeSourcePair(db, hot, identity, request), pair);
        } finally {
          closeRecordAcceptedIntakeHeadRead(hot);
        }
        assert.equal(work.operation.vaultBackingColdReplays - before.vaultBackingColdReplays, 0);
        assert.equal(
          work.operation.vaultBackingIncrementalAdvances - before.vaultBackingIncrementalAdvances,
          0,
        );
        assert.equal(work.operation.vaultBackingReuses - before.vaultBackingReuses, 1);
        assert.equal(
          work.operation.vaultBackingPhysicalMembersVerified -
            before.vaultBackingPhysicalMembersVerified,
          members,
        );
        const scratch = readdirSync(scratchRoot!)
          .filter((name) => name.startsWith('circus-vault-record-backing-'))
          .map((name) => join(scratchRoot!, name))
          .filter((directory) => existsSync(join(directory, 'accepted.sqlite')));
        assert.equal(scratch.length, 1, 'one retained replay is live');
        const replayFile = join(scratch[0]!, 'accepted.sqlite'),
          replayBytes = readFileSync(replayFile);
        renameSync(replayFile, replayFile + '.fictional-aside');
        writeFileSync(replayFile, replayBytes);
        rmSync(replayFile + '.fictional-aside');
        const beforeReplaced = { ...work.operation },
          replaced = await captureRecordAcceptedIntakeHeadRead(db, identity, () => {}, request);
        try {
          assert.deepEqual(recordAcceptedIntakeSourcePair(db, replaced, identity, request), pair);
        } finally {
          closeRecordAcceptedIntakeHeadRead(replaced);
        }
        assert.equal(
          work.operation.vaultBackingColdReplays - beforeReplaced.vaultBackingColdReplays,
          1,
        );
        assert.equal(work.operation.vaultBackingReuses - beforeReplaced.vaultBackingReuses, 0);
        const resealedScratch = readdirSync(scratchRoot!)
          .filter((name) => name.startsWith('circus-vault-record-backing-'))
          .map((name) => join(scratchRoot!, name))
          .filter((directory) => existsSync(join(directory, 'accepted.sqlite')));
        assert.equal(resealedScratch.length, 1, 'one replacement replay is live');
        writeFileSync(join(resealedScratch[0]!, 'accepted.sqlite-wal'), 'fictional residue');
        const beforeResidue = { ...work.operation },
          residue = await captureRecordAcceptedIntakeHeadRead(db, identity, () => {}, request);
        try {
          assert.deepEqual(recordAcceptedIntakeSourcePair(db, residue, identity, request), pair);
        } finally {
          closeRecordAcceptedIntakeHeadRead(residue);
        }
        assert.equal(
          work.operation.vaultBackingColdReplays - beforeResidue.vaultBackingColdReplays,
          1,
        );
        assert.equal(work.operation.vaultBackingReuses - beforeResidue.vaultBackingReuses, 0);
        const unpaired = await captureRecordAcceptedIntakeHeadRead(db, identity, () => {});
        try {
          assert.throws(() => recordAcceptedIntakeSourcePair(db, unpaired, identity, request));
        } finally {
          closeRecordAcceptedIntakeHeadRead(unpaired);
        }
        const afterUnpaired = { ...work.operation },
          reselected = await captureRecordAcceptedIntakeHeadRead(db, identity, () => {}, request);
        try {
          assert.deepEqual(recordAcceptedIntakeSourcePair(db, reselected, identity, request), pair);
        } finally {
          closeRecordAcceptedIntakeHeadRead(reselected);
        }
        assert.equal(
          work.operation.vaultBackingIncrementalAdvances -
            afterUnpaired.vaultBackingIncrementalAdvances,
          1,
        );
        assert.equal(work.operation.vaultBackingReuses - afterUnpaired.vaultBackingReuses, 0);
        transaction(db, () => {
          db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)').run(
            'fictional-pair-later-person',
            'Fictional Later Person',
          );
        });
        const beforeOwn = { ...work.operation },
          advanced = await captureRecordAcceptedIntakeHeadRead(db, identity, () => {}, request);
        try {
          assert.deepEqual(recordAcceptedIntakeSourcePair(db, advanced, identity, request), pair);
        } finally {
          closeRecordAcceptedIntakeHeadRead(advanced);
        }
        assert.equal(work.operation.vaultBackingColdReplays - beforeOwn.vaultBackingColdReplays, 0);
        assert.equal(
          work.operation.vaultBackingIncrementalAdvances -
            beforeOwn.vaultBackingIncrementalAdvances,
          1,
        );
        assert.equal(work.operation.vaultBackingReuses - beforeOwn.vaultBackingReuses, 0);
        const changedVersion = { identity, sourceVersionId: randomUUID() },
          beforeChanged = work.operation.vaultBackingReuses;
        await assert.rejects(
          captureRecordAcceptedIntakeHeadRead(db, identity, () => {}, changedVersion),
        );
        assert.equal(work.operation.vaultBackingReuses, beforeChanged);
        const absentRequest = { identity, sourceVersionId: randomUUID() },
          absent = await captureRecordAcceptedSourceRead(db, profileId, () => {}, absentRequest);
        try {
          assert.throws(() => recordAcceptedSourcePair(db, absent, profileId, absentRequest));
        } finally {
          closeRecordAcceptedSourceRead(absent);
        }
        const beforeAbsentAgain = { ...work.operation },
          absentAgain = await captureRecordAcceptedSourceRead(
            db,
            profileId,
            () => {},
            absentRequest,
          );
        try {
          assert.throws(() => recordAcceptedSourcePair(db, absentAgain, profileId, absentRequest));
        } finally {
          closeRecordAcceptedSourceRead(absentAgain);
        }
        assert.equal(
          work.operation.vaultBackingIncrementalAdvances -
            beforeAbsentAgain.vaultBackingIncrementalAdvances,
          1,
        );
        assert.equal(work.operation.vaultBackingReuses - beforeAbsentAgain.vaultBackingReuses, 0);
        for (let index = 0; index < 40; index++)
          transaction(db, () => {
            db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)').run(
              `fictional-pair-checkpoint-${index}`,
              `Fictional Checkpoint ${index}`,
            );
          });
        assert.ok([...unlockPhysicalEntries(join(paths.root, 'vault'))].length >= 64);
        const restored = await captureRecordAcceptedIntakeHeadRead(db, identity, () => {}, request);
        try {
          assert.deepEqual(recordAcceptedIntakeSourcePair(db, restored, identity, request), pair);
        } finally {
          closeRecordAcceptedIntakeHeadRead(restored);
        }
        const originalEmit = Worker.prototype.emit,
          cancellation = Object.assign(new Error('fictional hot pair canceled'), {
            name: 'AbortError',
          });
        let checkpointSeen = false,
          canceled = false;
        Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
          const message = args[0] as { checkpoint?: unknown; mode?: unknown } | undefined;
          if (event === 'message' && message?.checkpoint === true && message.mode === 'verify') {
            checkpointSeen = true;
            canceled = true;
          }
          return Reflect.apply(originalEmit, this, [event, ...args]);
        };
        const beforeCancellation = { ...work.operation };
        try {
          await assert.rejects(
            captureRecordAcceptedIntakeHeadRead(
              db,
              identity,
              () => {
                if (canceled) throw cancellation;
              },
              request,
            ),
            (error) => error === cancellation,
          );
        } finally {
          Worker.prototype.emit = originalEmit;
        }
        assert.equal(checkpointSeen, true);
        assert.equal(work.operation.vaultBackingReuses - beforeCancellation.vaultBackingReuses, 0);
        assert.equal(
          work.operation.vaultBackingColdReplays - beforeCancellation.vaultBackingColdReplays,
          0,
        );
        const beforeRecovery = { ...work.operation },
          recovered = await captureRecordAcceptedIntakeHeadRead(db, identity, () => {}, request);
        try {
          assert.deepEqual(recordAcceptedIntakeSourcePair(db, recovered, identity, request), pair);
        } finally {
          closeRecordAcceptedIntakeHeadRead(recovered);
        }
        assert.equal(
          work.operation.vaultBackingColdReplays - beforeRecovery.vaultBackingColdReplays,
          1,
        );
        transaction(db, () => {
          db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)').run(
            'fictional-pair-signature-person',
            'Fictional Signature Person',
          );
        });
        let corruptedSignature = false;
        Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
          const message = args[0] as { sourcePairSignature?: string } | undefined;
          if (event === 'message' && !corruptedSignature && message?.sourcePairSignature) {
            message.sourcePairSignature = '0'.repeat(64);
            corruptedSignature = true;
          }
          return Reflect.apply(originalEmit, this, [event, ...args]);
        };
        const beforeSignature = { ...work.operation };
        try {
          const signed = await captureRecordAcceptedIntakeHeadRead(db, identity, () => {}, request);
          try {
            assert.deepEqual(recordAcceptedIntakeSourcePair(db, signed, identity, request), pair);
          } finally {
            closeRecordAcceptedIntakeHeadRead(signed);
          }
        } finally {
          Worker.prototype.emit = originalEmit;
        }
        assert.equal(corruptedSignature, true);
        assert.equal(
          work.operation.vaultBackingColdReplays - beforeSignature.vaultBackingColdReplays,
          1,
        );
        assert.equal(work.operation.vaultBackingReuses - beforeSignature.vaultBackingReuses, 0);
        const currentScratch = readdirSync(scratchRoot!)
          .filter((name) => name.startsWith('circus-vault-record-backing-'))
          .map((name) => join(scratchRoot!, name))
          .filter((directory) => existsSync(join(directory, 'accepted.sqlite')));
        assert.equal(currentScratch.length, 1, 'one signed replay is live');
        const currentReplay = join(currentScratch[0]!, 'accepted.sqlite');
        let mutatedAtCheckpoint = false;
        Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
          const message = args[0] as { checkpoint?: unknown; mode?: unknown } | undefined;
          if (
            event === 'message' &&
            !mutatedAtCheckpoint &&
            message?.checkpoint === true &&
            message.mode === 'verify'
          ) {
            const bytes = readFileSync(currentReplay);
            renameSync(currentReplay, currentReplay + '.fictional-aside');
            writeFileSync(currentReplay, bytes);
            rmSync(currentReplay + '.fictional-aside');
            mutatedAtCheckpoint = true;
          }
          return Reflect.apply(originalEmit, this, [event, ...args]);
        };
        const beforeMutation = { ...work.operation };
        try {
          await assert.rejects(
            captureRecordAcceptedIntakeHeadRead(db, identity, () => {}, request),
          );
        } finally {
          Worker.prototype.emit = originalEmit;
        }
        assert.equal(mutatedAtCheckpoint, true);
        assert.equal(work.operation.vaultBackingReuses - beforeMutation.vaultBackingReuses, 0);
        assert.equal(
          work.operation.vaultBackingColdReplays - beforeMutation.vaultBackingColdReplays,
          0,
        );
        const beforeMutationRecovery = { ...work.operation },
          mutationRecovery = await captureRecordAcceptedIntakeHeadRead(
            db,
            identity,
            () => {},
            request,
          );
        try {
          assert.deepEqual(
            recordAcceptedIntakeSourcePair(db, mutationRecovery, identity, request),
            pair,
          );
        } finally {
          closeRecordAcceptedIntakeHeadRead(mutationRecovery);
        }
        assert.equal(
          work.operation.vaultBackingColdReplays - beforeMutationRecovery.vaultBackingColdReplays,
          1,
        );
      }
    });
    const eventId = `visibility:${randomUUID()}`;
    transaction(db, () => {
      db.prepare('INSERT INTO visibility_events VALUES(?,?,?,?,?,?,?)').run(
        eventId,
        'source_file',
        intakeId,
        1,
        1,
        '2026-01-02T03:04:05.000Z',
        'Fictional profile owner',
      );
    });
    const visibilityCap = await captureRecordAcceptedIntakeHeadRead(
      db,
      identity,
      () => {},
      request,
    );
    try {
      const visibility = recordAcceptedIntakeSourcePair(
        db,
        visibilityCap,
        identity,
        request,
      ).currentVisibility;
      assert.ok(visibility);
      assert.equal(visibility.version, 1);
      assert.equal(visibility.archived, true);
      assert.ok(Object.isFrozen(visibility));
      assert.deepEqual(
        await recordAcceptedIntakeCurrentSourceVisibility(db, visibilityCap, identity, request),
        { archived: true, version: 1 },
      );
    } finally {
      closeRecordAcceptedIntakeHeadRead(visibilityCap);
    }
    const forgedVisibility = new DatabaseSync(paths.database);
    try {
      forgedVisibility.exec('DROP TRIGGER visibility_events_no_update');
      forgedVisibility
        .prepare('UPDATE visibility_events SET actor=? WHERE id=?')
        .run('Fictional forged owner', eventId);
      forgedVisibility.exec(
        "CREATE TRIGGER visibility_events_no_update BEFORE UPDATE ON visibility_events BEGIN SELECT RAISE(ABORT,'Visibility history is append-only'); END",
      );
      const forgedCap = await captureRecordAcceptedIntakeHeadRead(db, identity, () => {}, request);
      try {
        await assert.rejects(() =>
          recordAcceptedIntakeCurrentSourceVisibility(db, forgedCap, identity, request),
        );
      } finally {
        closeRecordAcceptedIntakeHeadRead(forgedCap);
      }
    } finally {
      forgedVisibility.exec('DROP TRIGGER visibility_events_no_update');
      forgedVisibility
        .prepare('UPDATE visibility_events SET actor=? WHERE id=?')
        .run('Fictional profile owner', eventId);
      forgedVisibility.exec(
        "CREATE TRIGGER visibility_events_no_update BEFORE UPDATE ON visibility_events BEGIN SELECT RAISE(ABORT,'Visibility history is append-only'); END",
      );
      forgedVisibility.close();
    }
    const pinKey = `intake_source_pin:v1:${intakeId}`;
    transaction(db, () => {
      db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
        pinKey,
        JSON.stringify({
          revisionId: null,
          dependencyToken: null,
          requiresInterpretation: false,
          version: 3,
        }),
      );
    });
    const pinCap = await captureRecordAcceptedIntakeHeadRead(db, identity, () => {}, request);
    try {
      const pin = recordAcceptedIntakeSourcePair(db, pinCap, identity, request).currentSourcePin;
      assert.equal(pin?.kind, 'value');
      if (!pin || pin.kind !== 'value') throw Error('Fictional accepted source pin unavailable');
      assert.equal(pin.version, 3);
      assert.equal(
        await recordAcceptedIntakeCurrentSourcePinVersion(db, pinCap, identity, request),
        3,
      );
    } finally {
      closeRecordAcceptedIntakeHeadRead(pinCap);
    }
    transaction(db, () => {
      db.prepare('DELETE FROM app_meta WHERE key=?').run(pinKey);
    });
    const deletedPinCap = await captureRecordAcceptedIntakeHeadRead(
      db,
      identity,
      () => {},
      request,
    );
    try {
      assert.equal(
        recordAcceptedIntakeSourcePair(db, deletedPinCap, identity, request).currentSourcePin?.kind,
        'deleted',
      );
      assert.equal(
        await recordAcceptedIntakeCurrentSourcePinVersion(db, deletedPinCap, identity, request),
        0,
      );
    } finally {
      closeRecordAcceptedIntakeHeadRead(deletedPinCap);
    }
    const mutableRequest = { identity, sourceVersionId },
      otherVersion = randomUUID();
    let changeRequest = false;
    const mutableCap = await captureRecordAcceptedIntakeHeadRead(
      db,
      identity,
      () => {
        if (changeRequest) mutableRequest.sourceVersionId = otherVersion;
      },
      mutableRequest,
    );
    try {
      changeRequest = true;
      assert.throws(() => recordAcceptedIntakeSourcePair(db, mutableCap, identity, mutableRequest));
      assert.equal(mutableRequest.sourceVersionId, otherVersion);
    } finally {
      changeRequest = false;
      closeRecordAcceptedIntakeHeadRead(mutableCap);
    }
    const raw = new DatabaseSync(paths.database);
    try {
      raw
        .prepare('UPDATE __record_current SET version_id=? WHERE entity=? AND record_id=?')
        .run(firstSourceVersion, 'source_files', JSON.stringify([intakeId]));
      const forgedCap = await captureRecordAcceptedIntakeHeadRead(db, identity, () => {}, request);
      try {
        assert.equal(
          recordAcceptedIntakeSourcePair(db, forgedCap, identity, request).sourceDetails,
          descriptor,
        );
        assert.throws(() =>
          recordAcceptedIntakeCurrentSourceDescriptor(db, forgedCap, identity, request),
        );
      } finally {
        closeRecordAcceptedIntakeHeadRead(forgedCap);
      }
    } finally {
      raw
        .prepare('UPDATE __record_current SET version_id=? WHERE entity=? AND record_id=?')
        .run(sourceVersionId, 'source_files', JSON.stringify([intakeId]));
      raw.close();
    }
    const selected = collections.binding(collections.openView())!;
    assert.ok(selected.logical.root);
    const selectedDescriptor = encodeIntakeReferencedEnvelope({
      intakeAuthority: {
        format: INTAKE_REFERENCED_ENVELOPE_FORMAT,
        identity,
        mode: 'raw',
        storageSequence: selected.storageSequence,
        logicalRoot: selected.logical.root,
        sourceLabel: { kind: 'missing' },
      },
    });
    const giantMime =
        'application/fictional-' +
        'm'.repeat(4096 - Buffer.byteLength('application/fictional-') - 1) +
        '🌿\0' +
        'm'.repeat(20 * 1024) +
        'ZIP',
      giantProvider = 'fictional-' + 'p'.repeat(20 * 1024);
    transaction(db, () => {
      db.prepare('INSERT INTO providers(id,name) VALUES(?,?)').run(
        giantProvider,
        'Independently fictional provider',
      );
      db.prepare('UPDATE source_files SET details_json=?,mime_type=?,provider_id=? WHERE id=?').run(
        selectedDescriptor,
        giantMime,
        giantProvider,
        intakeId,
      );
      db.prepare('UPDATE app_meta SET value=value WHERE key=?').run(headKey);
    });
    const giantRequest = {
      identity,
      sourceVersionId: String(current.get('source_files', JSON.stringify([intakeId]))!.version_id),
    };
    const giantCap = await captureRecordAcceptedIntakeHeadRead(
      db,
      identity,
      () => {},
      giantRequest,
    );
    try {
      assert.deepEqual(
        await recordAcceptedIntakeCurrentSourceSummaryFacts(db, giantCap, identity, giantRequest),
        {
          bytes: original.length,
          path: { kind: 'value', value: path },
          mimeType: {
            kind: 'reference',
            bytes: Buffer.byteLength(giantMime),
            hash: createHash('sha256').update(giantMime).digest('hex'),
          },
          mimePredicates: {
            pdf: false,
            image: false,
            previewableImage: false,
            packageMime: true,
            retainOnlyMime: 'filename',
          },
          providerId: {
            kind: 'reference',
            bytes: Buffer.byteLength(giantProvider),
            hash: createHash('sha256').update(giantProvider).digest('hex'),
          },
        },
      );
    } finally {
      closeRecordAcceptedIntakeHeadRead(giantCap);
    }
    const prefixedMime = '\uFEFFapplication/fictional\0';
    transaction(db, () => {
      db.prepare(
        'UPDATE source_files SET details_json=?,mime_type=?,provider_id=NULL WHERE id=?',
      ).run(selectedDescriptor, prefixedMime, intakeId);
      db.prepare('UPDATE app_meta SET value=value WHERE key=?').run(headKey);
    });
    const prefixedRequest = {
      identity,
      sourceVersionId: String(current.get('source_files', JSON.stringify([intakeId]))!.version_id),
    };
    const prefixedCap = await captureRecordAcceptedIntakeHeadRead(
      db,
      identity,
      () => {},
      prefixedRequest,
    );
    try {
      assert.deepEqual(
        await recordAcceptedIntakeCurrentSourceSummaryFacts(
          db,
          prefixedCap,
          identity,
          prefixedRequest,
        ),
        {
          bytes: original.length,
          path: { kind: 'value', value: path },
          mimeType: { kind: 'value', value: prefixedMime },
          mimePredicates: {
            pdf: false,
            image: false,
            previewableImage: false,
            packageMime: false,
            retainOnlyMime: 'filename',
          },
          providerId: null,
        },
      );
    } finally {
      closeRecordAcceptedIntakeHeadRead(prefixedCap);
    }
    transaction(db, () => {
      db.prepare('UPDATE source_files SET mime_type=? WHERE id=?').run(
        'AuDiO/MpEg;fictional',
        intakeId,
      );
      db.prepare('UPDATE app_meta SET value=value WHERE key=?').run(headKey);
    });
    const audioRequest = {
      identity,
      sourceVersionId: String(current.get('source_files', JSON.stringify([intakeId]))!.version_id),
    };
    const audioCap = await captureRecordAcceptedIntakeHeadRead(
      db,
      identity,
      () => {},
      audioRequest,
    );
    try {
      const facts = await recordAcceptedIntakeCurrentSourceSummaryFacts(
        db,
        audioCap,
        identity,
        audioRequest,
      );
      assert.equal(facts.mimePredicates.retainOnlyMime, 'retain');
    } finally {
      closeRecordAcceptedIntakeHeadRead(audioCap);
    }
    const physical = vault
        ? join(paths.root, 'vault', 'manifest.enc')
        : join(contributorAuthorityPath(root, profileId), 'head'),
      originalPhysical = readFileSync(physical),
      saved = physical + '.fictional-original';
    const cap = await captureRecordAcceptedIntakeHeadRead(db, identity, () => {}, request);
    try {
      assert.equal(
        recordAcceptedIntakeSourcePair(db, cap, identity, request).sourceDetails,
        descriptor,
      );
      renameSync(physical, saved);
      writeFileSync(physical, originalPhysical);
      assert.throws(() => recordAcceptedIntakeSourcePair(db, cap, identity, request));
    } finally {
      if (existsSync(saved)) renameSync(saved, physical);
      try {
        closeRecordAcceptedIntakeHeadRead(cap);
      } catch (error) {
        assert.match(String(error), /original|interval|accepted|physical/i);
      }
    }
    transaction(db, () =>
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(descriptor, intakeId),
    );
    const mixedSourceVersionId = String(
      current.get('source_files', JSON.stringify([intakeId]))!.version_id,
    );
    assert.notEqual(mixedSourceVersionId, sourceVersionId);
    const acceptedHeadBeforeRefusal = readFileSync(physical);
    await assert.rejects(
      captureRecordAcceptedIntakeHeadRead(db, identity, () => {}, {
        identity,
        sourceVersionId: mixedSourceVersionId,
      }),
    );
    const oldCap = await captureRecordAcceptedIntakeHeadRead(db, identity, () => {}, request);
    try {
      assert.equal(
        recordAcceptedIntakeSourcePair(db, oldCap, identity, request).latestSourceVersionId,
        mixedSourceVersionId,
      );
      assert.throws(() =>
        recordAcceptedIntakeCurrentSourceDescriptor(db, oldCap, identity, request),
      );
    } finally {
      closeRecordAcceptedIntakeHeadRead(oldCap);
    }
    assert.deepEqual(readFileSync(physical), acceptedHeadBeforeRefusal);
  });
