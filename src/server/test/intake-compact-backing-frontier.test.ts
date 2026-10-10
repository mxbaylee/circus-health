import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { attachRecordDurability, rebuildRecordDatabase } from '../record-versions.ts';
import { openVault } from '../vault-store.ts';
import { freshKey } from '../vault-crypto.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage } from '../intake-state-storage.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareIntakeCompactMetadata } from '../intake-compact-metadata.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';

test(
  'actual compact backing replays once and advances only exact accepted source certificates',
  { timeout: 30000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-compact-frontier-')),
      profileId = 'fictional-compact-frontier',
      paths = ensureProfileDirectories(root, profileId),
      key = freshKey(),
      vault = openVault({ directory: paths.root, profileId, key, initialize: true }),
      storage = vault.recordStorage();
    let db = openDatabase(paths.database, profileId);
    t.after(() => {
      vault.close();
      db.close();
      key.fill(0);
      rmSync(root, { recursive: true, force: true });
    });
    const original = Buffer.from('Independently fictional compact frontier original.'),
      sourceHash = createHash('sha256').update(original).digest('hex');
    const originals = Array.from(
      { length: 8 },
      (_, i) => profilePaths(root, profileId).relativeRoot + '/sources/fictional-' + i + '.pdf',
    );
    for (const path of originals) {
      writeFileSync(join(root, path), original);
      vault.storeFile(path, original);
    }
    vault.publish();
    const verifyReferences: NonNullable<
      NonNullable<Parameters<typeof attachRecordDurability>[1]>['verifyReferences']
    > = (versions) => {
      for (const version of versions)
        if (version.entity === 'source_files' && !version.deleted)
          assert.equal(
            vault.verifyFile(
              String(version.contents.path),
              Number(version.contents.bytes),
              String(version.contents.sha256),
            ),
            true,
          );
    };
    // Construction uses independently fictional accepted immutable objects.
    // Qualification starts only after actual encrypted reconstruction, never
    // by trusting/copied SQL state or skipping production preparation.
    const fixture = memoryRecordAuthority(db);
    const sources: { id: string; sha256: string; raw: string }[] = [];
    for (let i = 0; i < 8; i++) {
      const id = 'fictional-frontier-' + i,
        path = originals[i]!,
        initial = prepareInitialIntakeEnvelope({
          intake: {
            version: 1,
            originalName: 'fictional-' + i + '-retained-'.repeat(3000) + '.pdf',
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
          sourceHash,
          original.length,
          'intake_original',
          'application/pdf',
          initial.detailsJson,
        );
        createIntakeStateStorage(db, { profileId, intakeId: id, sourceHash }).stage(
          initial.state,
          randomUUID(),
        );
      });
      await buildIntakeCollectionEnvelope(db, { id, sha256: sourceHash });
      transaction(db, () =>
        db
          .prepare('UPDATE source_files SET details_json=? WHERE id=?')
          .run(initial.detailsJson, id),
      );
      sources.push({ id, sha256: sourceHash, raw: initial.detailsJson });
    }
    for (const [name, bytes] of fixture.objects)
      if (name !== 'head') storage.writeImmutable(name, bytes);
    storage.publishHead(fixture.objects.get('head')!);
    db.close();
    const recovered = join(root, 'actual-accepted.sqlite');
    rebuildRecordDatabase(recovered, { profileId, storage, verifyReferences });
    db = openDatabase(recovered, profileId);
    attachRecordDurability(db, { profileId, storage, verifyReferences });
    const startSequence = Number(
      db.prepare('SELECT sequence FROM __record_state WHERE singleton=1').get()!.sequence,
    );
    let changedPathBound = 0;
    for (const source of sources) {
      const collections = createIntakeStateStorage(db, {
        profileId,
        intakeId: source.id,
        sourceHash,
      }).collections;
      const selected = collections.binding(collections.openView())!;
      // Empty logical changes still insert the operation's receipt/history.
      // Persistent AVL paths, not a guessed number of metadata rows, bound them.
      changedPathBound +=
        4 * ((selected.receipts?.height ?? 0) + (selected.history?.height ?? 0) + 2) + 3;
    }
    const work = createRecordVersionWorkCounters();
    await withRecordVersionWork(work, async () => {
      for (const source of sources)
        assert.equal((await prepareIntakeCompactMetadata(db, source)).changed, true);
    });
    assert.equal(work.operation.vaultBackingColdReplays, 1);
    assert.equal(work.operation.vaultBackingReuses, 7);
    assert.ok(work.operation.vaultBackingCertificateWrites >= 8);
    const actualChanged = db
      .prepare('SELECT count(*) AS n FROM __record_versions WHERE sequence>?')
      .get(startSequence)!.n;
    assert.equal(work.operation.vaultBackingChangedVersions, actualChanged);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM __record_versions WHERE sequence>? AND entity='source_files'",
        )
        .get(startSequence)!.n,
      8,
    );
    assert.ok(work.operation.vaultBackingChangedVersions <= changedPathBound);
    t.diagnostic(
      JSON.stringify({
        coldReplays: work.operation.vaultBackingColdReplays,
        warmReuses: work.operation.vaultBackingReuses,
        coldDecodedVersions: work.operation.vaultBackingColdDecodedVersions,
        changedVersions: actualChanged,
        changedPathBound,
        physicalMembers: work.operation.vaultBackingPhysicalMembersVerified,
      }),
    );
    assert.ok(
      work.operation.vaultBackingPhysicalMembersVerified > 0,
      'full namespace remains explicitly counted',
    );
    const source = sources[0]!;
    transaction(db, () =>
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(source.raw, source.id),
    );
    const fresh = createRecordVersionWorkCounters();
    await withRecordVersionWork(fresh, () => prepareIntakeCompactMetadata(db, source));
    assert.equal(
      fresh.operation.vaultBackingColdReplays,
      1,
      'ordinary accepted mutation requires authenticated rebuild, never a refreshed old certificate',
    );
    assert.equal(fresh.operation.vaultBackingReuses, 0);
    const head = storage.read('head')!.toString('utf8');
    // A later source-details rederivation attempt must not inherit a forged SQL
    // preimage even when both disposable views agree and capture is concealed.
    const prior = db
      .prepare(
        'SELECT c.version_id,v.contents_json FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=?',
      )
      .get('source_files', JSON.stringify([source.id]))!;
    const contents = JSON.parse(String(prior.contents_json));
    contents.details_json = source.raw;
    contents.mime_type = 'fictional/forged';
    db.prepare('UPDATE source_files SET details_json=?,mime_type=? WHERE id=?').run(
      source.raw,
      contents.mime_type,
      source.id,
    );
    db.prepare('UPDATE __record_versions SET contents_json=? WHERE version_id=?').run(
      JSON.stringify(contents),
      prior.version_id,
    );
    db.exec('DELETE FROM __record_changed');
    await assert.rejects(
      prepareIntakeCompactMetadata(db, source),
      /accepted source certificate differs|backing verification refused/,
    );
    assert.equal(storage.read('head')!.toString('utf8'), head);
  },
);
