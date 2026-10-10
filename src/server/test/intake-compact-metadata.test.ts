import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction, observeTransactionBeforePublication } from '../database.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  type RecordStorage,
  type DurableRecordVersion,
} from '../record-versions.ts';
import { constants } from 'node:sqlite';
import { openVault } from '../vault-store.ts';
import { freshKey } from '../vault-crypto.ts';
import { withManagedPhysicalMutation } from '../clinical-review-physical-epoch.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { createIntakeStateStorage } from '../intake-state-storage.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareIntakeFilenameSummary } from '../intake-summary-name.ts';
import { getIntakeEvidenceHeader } from '../intake.ts';
import {
  intakeSourceMetadata,
  intakeMetadataScalarReference,
  intakeFirstLocatorMatches,
} from '../intake-state-access.ts';
import { prepareIntakeCompactMetadata } from '../intake-compact-metadata.ts';
import { intakeCompactSourceRowsEqual } from '../intake-state-migration.ts';
import { collectionIntakeMetadataScalarFragment } from '../intake-summary.ts';
import {
  iterateIntakeEnvelopeText,
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  intakeEnvelopeFilenameCell,
} from '../intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import {
  COMPACT_SCALAR_FORMAT,
  compactIntakeScalarSteps,
  isIntakeCompactScalar,
  intakeMetadataLabel,
  intakeMetadataScalarMatches,
} from '../intake-compact-scalar.ts';
import {
  compactIntakeMetadata,
  INTAKE_COMPACT_ENVELOPE_FORMAT,
  validateIntakeEnvelopeRepresentation,
} from '../intake-authority.ts';

function descriptor(field: 'originalName' | 'locator', raw: string) {
  const steps = compactIntakeScalarSteps(field, [raw]);
  let yields = 0;
  for (;;) {
    const next = steps.next();
    if (next.done) return { value: next.value, yields };
    yields++;
  }
}
test('compact metadata scalar descriptors are bounded, exact-bound and explicitly shortened', () => {
  const exact = 'Fictional-' + 'quoted-"-line-\n'.repeat(40000) + '.pdf';
  const prepared = descriptor('originalName', JSON.stringify(exact));
  assert.ok(prepared.yields > 66);
  assert.ok(Buffer.byteLength(JSON.stringify(prepared.value)) < 1024);
  assert.equal(prepared.value.format, COMPACT_SCALAR_FORMAT);
  assert.equal(prepared.value.bytes, Buffer.byteLength(JSON.stringify(exact)));
  assert.equal(prepared.value.preview.length, 120);
  assert.equal(prepared.value.truncated, true);
  assert.equal(isIntakeCompactScalar(prepared.value), true);
  assert.match(intakeMetadataLabel(prepared.value), /\[shortened\]$/);
  assert.equal(intakeMetadataScalarMatches(prepared.value, exact), true);
  assert.equal(intakeMetadataScalarMatches(prepared.value, exact + 'changed'), false);
  assert.equal(isIntakeCompactScalar({ ...prepared.value, preview: 'x'.repeat(121) }), false);
});

test('v2 compact projection preserves raw duplicates, spelling and ordinary nonstring neighbors', () => {
  const first = JSON.stringify('first-' + 'fictional-first-'.repeat(2000) + '.txt');
  const last = JSON.stringify('last-' + 'fictional-last-'.repeat(2000) + '.pdf');
  const locator = JSON.stringify('PDF embedded file ' + 'fictional-key-'.repeat(2000));
  const state =
    '{"i\\u006etake":{"originalName":' +
    first +
    ',"originalName":' +
    last +
    ',"locator":' +
    locator +
    ',"version":1}}';
  const details =
    '{"intakeAuthority":{"format":"' +
    INTAKE_COMPACT_ENVELOPE_FORMAT +
    '","mode":"raw"},"i\\u006etake":{"originalName":' +
    JSON.stringify(descriptor('originalName', first).value) +
    ',"originalName":' +
    JSON.stringify(descriptor('originalName', last).value) +
    ',"locator":' +
    JSON.stringify(descriptor('locator', locator).value) +
    '}}';
  assert.equal(validateIntakeEnvelopeRepresentation(details, { raw: state }).text, state);
  assert.throws(
    () =>
      validateIntakeEnvelopeRepresentation(details.replace('fictional-first', 'changed-first'), {
        raw: state,
      }),
    /compact metadata conflicts/,
  );
  const taggedObject = JSON.parse(JSON.stringify(descriptor('originalName', first).value));
  for (const originalName of [
    17,
    null,
    { fictional: 'ordinary retained metadata' },
    taggedObject,
    { format: COMPACT_SCALAR_FORMAT, preview: 'ordinary malformed tag' },
  ]) {
    const value = { intake: { originalName, locator: JSON.parse(locator), version: 1 } };
    const projected = compactIntakeMetadata(value, INTAKE_COMPACT_ENVELOPE_FORMAT);
    assert.deepEqual(projected.originalName, originalName);
    assert.equal(intakeMetadataLabel(originalName as never), originalName);
    assert.equal(intakeMetadataScalarMatches(originalName as never, JSON.parse(first)), false);
    const normalized = JSON.stringify({
      intakeAuthority: { format: INTAKE_COMPACT_ENVELOPE_FORMAT, mode: 'normalized' },
      intake: projected,
    });
    assert.deepEqual(validateIntakeEnvelopeRepresentation(normalized, value).value, value);
  }
});

test(
  'native giant metadata cold upgrade preserves exact evidence and bounds warm headers',
  { timeout: 30000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-compact-metadata-'));
    const profileId = 'fictional-compact',
      id = 'fictional-intake';
    const paths = ensureProfileDirectories(root, profileId);
    const db = openDatabase(paths.database, profileId);
    const authority = memoryRecordAuthority(db);
    t.after(() => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const original = Buffer.from('Independently fictional compact metadata evidence.');
    const sourceHash = createHash('sha256').update(original).digest('hex');
    const path = profilePaths(root, profileId).relativeRoot + '/sources/fictional.pdf';
    writeFileSync(join(root, path), original);
    const originalName = 'fictional-' + 'long-original-'.repeat(22000) + '.pdf';
    const locator = 'PDF embedded file ' + 'fictional-locator-'.repeat(18000);
    const firstOriginalName = 'first-' + 'fictional-original-'.repeat(18000) + '.txt';
    const firstLocator = 'first PDF embedded file ' + 'fictional-key-'.repeat(20000);
    const retained = {
      intake: {
        version: 3,
        originalName,
        locator,
        createdAt: '2026-01-01T00:00:00Z',
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
    };
    const raw = JSON.stringify(retained)
      .replace(
        '"originalName":',
        '"originalName":' + JSON.stringify(firstOriginalName) + ',"originalName":',
      )
      .replace('"locator":', '"locator":' + JSON.stringify(firstLocator) + ',"locator":');
    const initial = prepareInitialIntakeEnvelope(raw);
    transaction(db, () => {
      db.prepare('INSERT INTO providers(id,name) VALUES(?,?)').run(
        'fictional-provider',
        'Fictional Clinic',
      );
      db.prepare(
        'INSERT INTO source_files(id,provider_id,path,sha256,bytes,kind,mime_type,details_json) VALUES(?,?,?,?,?,?,?,?)',
      ).run(
        id,
        'fictional-provider',
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
    const source = { id, sha256: sourceHash };
    await buildIntakeCollectionEnvelope(db, source);
    const exact = [...iterateIntakeEnvelopeText(db, source)].join('');
    const first = db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!
      .details_json as string;
    assert.ok(Buffer.byteLength(first) < 2048);
    assert.equal(JSON.parse(first).intakeAuthority.format, INTAKE_COMPACT_ENVELOPE_FORMAT);
    transaction(db, () =>
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(initial.detailsJson, id),
    );
    const collections = selectedEnvelopeStore(db, source).collections;
    const cells = new Set<string>();
    for (const fieldSelection of ['first', 'last'] as const) {
      const selected = openIntakeCollectionEnvelope(db, source, { fieldSelection });
      const intake = selected.child(selected.root(), 'intake')!;
      for (const field of ['originalName', 'locator'] as const)
        cells.add(intakeEnvelopeFilenameCell(selected, intake, field).id);
    }
    assert.equal(cells.size, 4);
    const build = 'fictional.old-metadata.' + randomUUID();
    const prepare = (changes: Parameters<typeof collections.prepare>[1]['changes']) => {
      const operationId = randomUUID();
      return collections.prepare(collections.openView(), {
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: 3,
        changes,
      });
    };
    collections.commitMaintenance(
      prepare([
        {
          area: 'builds',
          collection: build,
          op: 'adoptCollection',
          fromArea: 'logical',
          fromCollection: 'envelope.data',
        },
        ...[...cells].map((cell) => ({
          area: 'builds' as const,
          collection: build,
          op: 'delete' as const,
          key: 'q:' + cell,
        })),
      ]),
    );
    const old = prepare([
      {
        area: 'logical',
        collection: 'envelope.data',
        op: 'adoptCollection',
        fromArea: 'builds',
        fromCollection: build,
      },
    ]);
    await collections.certifySchemaAdoptionAsync(old);
    collections.commitMaintenance(old);
    assert.throws(() => intakeSourceMetadata(db, id), /Prepare the selected source metadata/);
    let turns = 0;
    const result = await prepareIntakeFilenameSummary(db, source, {
      assertRunning() {
        turns++;
      },
    });
    assert.equal(result.changed, true);
    const preparedView = collections.openView();
    for (const cell of cells)
      assert.notEqual(
        collections.get(preparedView, 'logical', 'envelope.data', 'q:' + cell),
        undefined,
        'every first and last scalar fact is restored',
      );
    assert.ok(turns > 66);
    assert.equal([...iterateIntakeEnvelopeText(db, source)].join(''), exact);
    const header = getIntakeEvidenceHeader(db, root, profileId, id);
    assert.ok(Buffer.byteLength(JSON.stringify(header)) < 2048);
    assert.match(header.filename, /\[shortened\]$/);
    assert.equal(
      header.filenameReference?.scalarHash,
      descriptor('originalName', JSON.stringify(originalName)).value.scalarHash,
    );
    const metadata = intakeSourceMetadata(db, id);
    assert.equal(intakeMetadataScalarMatches(metadata.locator, locator), true);
    const before = intakeWorkCounters(db);
    const bytes =
      before.warm.collectionByteChunkReadBytes + before.reconstruction.collectionByteChunkReadBytes;
    assert.equal((await prepareIntakeFilenameSummary(db, source)).changed, false);
    getIntakeEvidenceHeader(db, root, profileId, id);
    const after = intakeWorkCounters(db);
    assert.equal(
      after.warm.collectionByteChunkReadBytes + after.reconstruction.collectionByteChunkReadBytes,
      bytes,
    );
    for (const [field, expected] of [
      ['originalName', originalName],
      ['locator', locator],
    ] as const) {
      const reference = intakeMetadataScalarReference(db, id, field, metadata)!;
      let cursor: string | undefined,
        text = '';
      for (;;) {
        const fragment = collectionIntakeMetadataScalarFragment(db, source, {
          reference,
          cursor,
          limit: 32768,
        });
        assert.ok(Buffer.byteLength(fragment.text) <= 32768);
        text += fragment.text;
        if (fragment.complete) break;
        assert.ok(fragment.nextCursor && fragment.nextCursor !== cursor);
        cursor = fragment.nextCursor!;
      }
      assert.equal(JSON.parse(text), expected);
      assert.throws(
        () =>
          collectionIntakeMetadataScalarFragment(db, source, {
            reference: { ...reference, bytes: reference.bytes + 1 },
          }),
        /selected source metadata changed/,
      );
    }
    assert.equal(intakeFirstLocatorMatches(db, id, firstLocator), true);
    assert.equal(
      intakeFirstLocatorMatches(db, id, locator),
      false,
      'SQL first occurrence is not JSON.parse last occurrence',
    );

    const contracted = String(
      db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!.details_json,
    );
    const forged = JSON.parse(contracted);
    forged.intake.originalName.preview = 'forged filename';
    transaction(db, () =>
      db
        .prepare('UPDATE source_files SET details_json=? WHERE id=?')
        .run(JSON.stringify(forged), id),
    );
    assert.throws(() => intakeSourceMetadata(db, id), /conflicts with exact evidence/);

    for (const mutation of ['cancel', 'function', 'authorizer', 'rowid'] as const) {
      transaction(db, () =>
        db
          .prepare('UPDATE source_files SET details_json=? WHERE id=?')
          .run(initial.detailsJson, id),
      );
      const collections = createIntakeStateStorage(db, {
        profileId,
        intakeId: id,
        sourceHash,
      }).collections;
      const headBefore = JSON.stringify(collections.binding(collections.openView()));
      let advances = 0,
        changed = false;
      await assert.rejects(
        prepareIntakeCompactMetadata(db, source, {
          assertRunning() {
            if (++advances !== 20 || changed) return;
            changed = true;
            if (mutation === 'cancel') throw Error('fictional metadata cancelled');
            if (mutation === 'function') db.function('fictional_metadata_policy', () => 1);
            if (mutation === 'authorizer') db.setAuthorizer(() => constants.SQLITE_OK);
            if (mutation === 'rowid')
              transaction(db, () =>
                db.prepare('UPDATE source_files SET rowid=9007199254740993 WHERE id=?').run(id),
              );
          },
        }),
        /cancelled|authority changed/,
      );
      assert.equal(changed, true);
      assert.equal(
        db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!.details_json,
        initial.detailsJson,
      );
      assert.equal(JSON.stringify(collections.binding(collections.openView())), headBefore);
    }
    transaction(db, () =>
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(initial.detailsJson, id),
    );
    const acceptedMime = db
      .prepare('SELECT mime_type FROM source_files WHERE id=?')
      .get(id)!.mime_type;
    db.prepare('UPDATE source_files SET mime_type=? WHERE id=?').run('fictional/unaccepted', id);
    try {
      await assert.rejects(
        prepareIntakeCompactMetadata(db, source),
        /differs from its accepted prior version/,
      );
      assert.equal(
        db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!.details_json,
        initial.detailsJson,
      );
    } finally {
      db.prepare('UPDATE source_files SET mime_type=? WHERE id=?').run(acceptedMime, id);
    }
    for (const mutation of ['sourceABA', 'extraRow'] as const) {
      transaction(db, () =>
        db
          .prepare('UPDATE source_files SET details_json=? WHERE id=?')
          .run(initial.detailsJson, id),
      );
      let called = false;
      const remove = observeTransactionBeforePublication(db, () => {
        if (called) return;
        called = true;
        if (mutation === 'sourceABA') {
          db.prepare('UPDATE source_files SET mime_type=? WHERE id=?').run('fictional/changed', id);
          db.prepare('UPDATE source_files SET mime_type=? WHERE id=?').run('application/pdf', id);
        } else
          db.prepare('INSERT INTO providers(id,name) VALUES(?,?)').run(
            'fictional-late-provider',
            'Fictional Late Clinic',
          );
      });
      try {
        await assert.rejects(
          prepareIntakeCompactMetadata(db, source),
          /late mutation|unexpected accepted row/,
        );
      } finally {
        remove();
      }
      assert.equal(called, true);
      assert.equal(
        db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!.details_json,
        initial.detailsJson,
      );
      assert.equal(
        db.prepare('SELECT 1 FROM providers WHERE id=?').get('fictional-late-provider'),
        undefined,
      );
    }
    transaction(db, () =>
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(initial.detailsJson, id),
    );
    const readObject = authority.storage.read,
      writeObject = authority.storage.writeImmutable,
      originalSequence = db.prepare('SELECT sequence FROM __record_state WHERE singleton=1').get()!
        .sequence;
    let immutableStaged = false,
      lateReadMutation = false;
    authority.storage.writeImmutable = (name, bytes) => {
      writeObject(name, bytes);
      immutableStaged = true;
    };
    authority.storage.read = (name) => {
      const bytes = readObject(name);
      if (
        name === 'head' &&
        immutableStaged &&
        db.isTransaction &&
        !lateReadMutation &&
        Number(
          db.prepare('SELECT sequence FROM __record_state WHERE singleton=1').get()!.sequence,
        ) > Number(originalSequence)
      ) {
        // This original-HEAD read follows private indexing and its initial
        // count check, but precedes the final complete source/SQL seal.
        lateReadMutation = true;
        db.prepare('UPDATE source_files SET mime_type=? WHERE id=?').run('fictional/late-read', id);
        db.prepare('UPDATE source_files SET mime_type=? WHERE id=?').run('application/pdf', id);
      }
      return bytes;
    };
    try {
      await assert.rejects(
        prepareIntakeCompactMetadata(db, source),
        /closing SQL\/method\/physical seal/,
      );
    } finally {
      authority.storage.read = readObject;
      authority.storage.writeImmutable = writeObject;
    }
    assert.equal(lateReadMutation, true, 'the final callback-capable HEAD read was exercised');
    assert.equal(
      db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!.details_json,
      initial.detailsJson,
    );
    transaction(db, () =>
      db.prepare('UPDATE source_files SET rowid=9007199254740992 WHERE id=?').run(id),
    );
    const unsafeA = db
      .prepare('SELECT CAST(rowid AS TEXT) AS __rowid,* FROM source_files WHERE id=?')
      .get(id)!;
    transaction(db, () =>
      db.prepare('UPDATE source_files SET rowid=9007199254740993 WHERE id=?').run(id),
    );
    const unsafeB = db
      .prepare('SELECT CAST(rowid AS TEXT) AS __rowid,* FROM source_files WHERE id=?')
      .get(id)!;
    assert.equal(Number(unsafeA.__rowid), Number(unsafeB.__rowid));
    assert.equal(intakeCompactSourceRowsEqual(unsafeA, unsafeB), false);
    await prepareIntakeFilenameSummary(db, source);
    assert.ok(
      Buffer.byteLength(JSON.stringify(getIntakeEvidenceHeader(db, root, profileId, id))) < 2048,
    );
  },
);

test(
  'native descriptor-shaped ordinary metadata stays ordinary beside a giant scalar',
  { timeout: 30000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-tagged-metadata-'));
    const profileId = 'fictional-tagged-metadata';
    const paths = ensureProfileDirectories(root, profileId);
    const db = openDatabase(paths.database, profileId);
    memoryRecordAuthority(db);
    t.after(() => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const giant = 'fictional-retained-'.repeat(1500);
    for (const field of ['originalName', 'locator'] as const) {
      for (const validShape of [true, false]) {
        const id = `${field}-${validShape}`;
        const ordinary = validShape
          ? JSON.parse(JSON.stringify(descriptor(field, JSON.stringify(giant)).value))
          : { format: COMPACT_SCALAR_FORMAT, field, preview: 'ordinary retained tagged object' };
        const giantField = field === 'originalName' ? 'locator' : 'originalName';
        const value = { intake: { version: 1, [field]: ordinary, [giantField]: giant } };
        const initial = prepareInitialIntakeEnvelope(value);
        const sourceHash = createHash('sha256').update(id).digest('hex');
        transaction(db, () => {
          db.prepare(
            'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
          ).run(id, `fictional/${id}`, sourceHash, 0, 'intake_original', initial.detailsJson);
          createIntakeStateStorage(db, { profileId, intakeId: id, sourceHash }).stage(
            initial.state,
            randomUUID(),
          );
        });
        const source = { id, sha256: sourceHash };
        await buildIntakeCollectionEnvelope(db, source);
        transaction(db, () =>
          db
            .prepare('UPDATE source_files SET details_json=? WHERE id=?')
            .run(initial.detailsJson, id),
        );
        await prepareIntakeFilenameSummary(db, source);
        const metadata = intakeSourceMetadata(db, id);
        assert.deepEqual(metadata[field], ordinary);
        assert.deepEqual(intakeMetadataLabel(metadata[field]!), ordinary);
        assert.equal(intakeMetadataScalarReference(db, id, field, metadata), undefined);
        assert.equal(intakeMetadataScalarMatches(metadata[field], giant), false);
        assert.equal(intakeMetadataScalarMatches(metadata[giantField], giant), true);
        assert.ok(intakeMetadataScalarReference(db, id, giantField, metadata));
        if (field === 'locator') assert.equal(intakeFirstLocatorMatches(db, id, giant), false);
        const projected = db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!
          .details_json as string;
        const forged = JSON.parse(projected);
        forged.intake[giantField] = { format: COMPACT_SCALAR_FORMAT, field: giantField };
        transaction(db, () =>
          db
            .prepare('UPDATE source_files SET details_json=? WHERE id=?')
            .run(JSON.stringify(forged), id),
        );
        assert.throws(
          () => intakeSourceMetadata(db, id),
          /requires native evidence|conflicts|source/,
        );
        transaction(db, () =>
          db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(projected, id),
        );
      }
    }
  },
);

test(
  'actual encrypted compact publication retains the original authority through owned staging and late HEAD callbacks',
  { timeout: 30000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-encrypted-compact-'));
    const profileId = 'fictional-encrypted-compact',
      id = 'fictional-encrypted-intake';
    const paths = ensureProfileDirectories(root, profileId);
    let db = openDatabase(paths.database, profileId);
    const key = freshKey(),
      vault = openVault({ directory: paths.root, profileId, key, initialize: true });
    t.after(() => {
      vault.close();
      key.fill(0);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const original = Buffer.from('Independently fictional encrypted original evidence.');
    const sourceHash = createHash('sha256').update(original).digest('hex');
    const path = profilePaths(root, profileId).relativeRoot + '/sources/fictional.pdf';
    writeFileSync(join(root, path), original);
    vault.storeFile(path, original);
    vault.publish();
    let mutateHead = false,
      headMutation = false,
      mutateIndexed = false,
      indexedMutation = false;
    let mutateIndexedPhysical = false,
      indexedPhysicalMutation = false,
      consumedRecordPath = '';
    let cancelHead = false,
      ownerClosed = false;
    const installAuthorizer = () =>
      db.setAuthorizer((action, table) => {
        if (
          mutateIndexedPhysical &&
          action === constants.SQLITE_INSERT &&
          table === '__record_transactions'
        ) {
          mutateIndexedPhysical = false;
          indexedPhysicalMutation = true;
          const original = readFileSync(consumedRecordPath),
            changed = Buffer.from(original);
          changed[0] = changed[0]! ^ 1;
          withManagedPhysicalMutation(() => {
            writeFileSync(consumedRecordPath, changed);
            writeFileSync(consumedRecordPath, original);
          });
        }
        if (
          mutateIndexed &&
          action === constants.SQLITE_INSERT &&
          table === '__record_transactions'
        ) {
          mutateIndexed = false;
          indexedMutation = true;
          db.prepare('UPDATE source_files SET mime_type=? WHERE id=?').run(
            'fictional/late-index',
            id,
          );
          db.prepare('UPDATE source_files SET mime_type=? WHERE id=?').run('application/pdf', id);
        }
        return constants.SQLITE_OK;
      });
    installAuthorizer();
    const storage = vault.recordStorage(() => {
      if (cancelHead) ownerClosed = true;
      if (!mutateHead) return;
      headMutation = true;
      db.prepare('UPDATE source_files SET mime_type=? WHERE id=?').run('fictional/late-head', id);
      db.prepare('UPDATE source_files SET mime_type=? WHERE id=?').run('application/pdf', id);
    });
    const verifyReferences = (versions: DurableRecordVersion[]) => {
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
    attachRecordDurability(db, { profileId, storage, verifyReferences });
    const restoreAcceptedProjection = () => {
      db.close();
      const database = join(root, 'accepted-' + randomUUID() + '.sqlite');
      rebuildRecordDatabase(database, { profileId, storage, verifyReferences });
      db = openDatabase(database, profileId);
      attachRecordDurability(db, { profileId, storage, verifyReferences });
      installAuthorizer();
    };
    const originalName = 'fictional-encrypted-' + 'retained-long-name-'.repeat(3000) + '.pdf';
    const initial = prepareInitialIntakeEnvelope({
      intake: { version: 1, originalName, state: 'ready', proposals: [], importHistory: [] },
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
    const source = { id, sha256: sourceHash };
    await buildIntakeCollectionEnvelope(db, source);
    transaction(db, () =>
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(initial.detailsJson, id),
    );
    const previous = db
      .prepare('SELECT version_id FROM __record_current WHERE entity=? AND record_id=?')
      .get('source_files', JSON.stringify([id]))!.version_id;
    const head = storage.read('head')!.toString('utf8');
    assert.equal((await prepareIntakeCompactMetadata(db, source)).changed, true);
    assert.notEqual(storage.read('head')!.toString('utf8'), head);
    const current = db
      .prepare(
        'SELECT v.* FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=?',
      )
      .get('source_files', JSON.stringify([id]))!;
    assert.equal(current.previous_version, previous);
    assert.equal(
      intakeMetadataScalarMatches(intakeSourceMetadata(db, id).originalName, originalName),
      true,
    );
    assert.deepEqual(vault.recordStorage().read('head'), storage.read('head'));
    assert.equal(vault.verifyFile(path, original.length, sourceHash), true);

    transaction(db, () =>
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(initial.detailsJson, id),
    );
    const beforeRefusal = storage.read('head')!.toString('utf8');
    consumedRecordPath = join(
      paths.root,
      'vault/versions',
      JSON.parse(beforeRefusal).name.slice(8) + '.enc',
    );
    for (const forged of [
      'source-preimage',
      'source-predecessor',
      'metadata-predecessor',
      'metadata-preimage',
    ]) {
      const recordId = JSON.stringify([id]),
        sourceVersion = db
          .prepare('SELECT version_id FROM __record_current WHERE entity=? AND record_id=?')
          .get('source_files', recordId)!.version_id;
      if (forged === 'source-preimage') {
        const raw = db
            .prepare('SELECT contents_json FROM __record_versions WHERE version_id=?')
            .get(sourceVersion)!.contents_json,
          contents = JSON.parse(String(raw));
        contents.mime_type = 'fictional/forged-preimage';
        db.prepare('UPDATE source_files SET mime_type=? WHERE id=?').run(contents.mime_type, id);
        db.prepare('UPDATE __record_versions SET contents_json=? WHERE version_id=?').run(
          JSON.stringify(contents),
          sourceVersion,
        );
      } else {
        const entity = forged === 'source-predecessor' ? 'source_files' : 'app_meta',
          selected =
            forged === 'source-predecessor'
              ? recordId
              : JSON.stringify([intakeNamespace({ profileId, intakeId: id, sourceHash }) + 'head']),
          version = db
            .prepare('SELECT version_id FROM __record_current WHERE entity=? AND record_id=?')
            .get(entity, selected)!.version_id,
          fake = randomUUID();
        if (forged === 'metadata-preimage') {
          const contents = JSON.parse(
            String(
              db
                .prepare('SELECT contents_json FROM __record_versions WHERE version_id=?')
                .get(version)!.contents_json,
            ),
          );
          contents.value = 'fictional-forged-prior-value';
          db.prepare('UPDATE __record_versions SET contents_json=? WHERE version_id=?').run(
            JSON.stringify(contents),
            version,
          );
        } else {
          db.prepare(
            'INSERT INTO __record_versions SELECT ?,profile_id,entity,record_id,sequence,recorded_at,previous_version,operation_id,deleted,contents_json,metadata_json FROM __record_versions WHERE version_id=?',
          ).run(fake, version);
          db.prepare('UPDATE __record_current SET version_id=? WHERE entity=? AND record_id=?').run(
            fake,
            entity,
            selected,
          );
        }
      }
      // A malicious cache can conceal its disposable capture too. Neither that
      // marker nor matching raw prior/source SQL is accepted backing evidence.
      db.exec('DELETE FROM __record_changed');
      await assert.rejects(
        prepareIntakeCompactMetadata(db, source),
        forged.startsWith('metadata-')
          ? /Vault accepted metadata predecessor differs/
          : /Vault original backing verification refused/,
      );
      assert.equal(storage.read('head')!.toString('utf8'), beforeRefusal);
      assert.equal(
        db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!.details_json,
        initial.detailsJson,
      );
      restoreAcceptedProjection();
      assert.equal(
        db.prepare('SELECT mime_type FROM source_files WHERE id=?').get(id)!.mime_type,
        'application/pdf',
      );
    }
    mutateHead = true;
    await assert.rejects(
      prepareIntakeCompactMetadata(db, source),
      /compact metadata source\/head\/physical authority changed/,
    );
    assert.equal(headMutation, true, 'actual registered beforeHead callback was exercised');
    assert.equal(
      storage.read('head')!.toString('utf8'),
      beforeRefusal,
      'no accepted HEAD after callback drift',
    );
    assert.equal(
      db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!.details_json,
      initial.detailsJson,
    );
    assert.equal(vault.verifyFile(path, original.length, sourceHash), true);
    mutateHead = false;
    // The malicious preparation callback left a dirty capture outside SQL's
    // rollback boundary. Reconstruct from accepted evidence for the next trial.
    restoreAcceptedProjection();
    mutateIndexed = true;
    await assert.rejects(prepareIntakeCompactMetadata(db, source), /late mutation|closing SQL/);
    assert.equal(
      indexedMutation,
      true,
      'a supported policy callback during private indexing was exercised',
    );
    assert.equal(storage.read('head')!.toString('utf8'), beforeRefusal);
    assert.equal(
      db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!.details_json,
      initial.detailsJson,
    );
    assert.equal(vault.verifyFile(path, original.length, sourceHash), true);
    restoreAcceptedProjection();
    mutateIndexedPhysical = true;
    await assert.rejects(
      prepareIntakeCompactMetadata(db, source),
      /Immutable record head preparation expired/,
    );
    assert.equal(indexedPhysicalMutation, true);
    assert.equal(storage.read('head')!.toString('utf8'), beforeRefusal);
    assert.equal(
      db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!.details_json,
      initial.detailsJson,
    );
    assert.equal(vault.verifyFile(path, original.length, sourceHash), true);
    restoreAcceptedProjection();
    cancelHead = true;
    await assert.rejects(
      prepareIntakeCompactMetadata(db, source, {
        assertRunning() {
          if (ownerClosed) throw Error('fictional owner cancelled before HEAD');
        },
      }),
      /owner cancelled/,
    );
    assert.equal(ownerClosed, true);
    assert.equal(storage.read('head')!.toString('utf8'), beforeRefusal);
    assert.equal(
      db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!.details_json,
      initial.detailsJson,
    );
  },
);

test(
  'formerly valid native metadata over the ordinary write budget upgrades without duplicating old metadata',
  { timeout: 180000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-large-compact-'));
    const profileId = 'fictional-large-compact',
      id = 'fictional-original';
    const paths = ensureProfileDirectories(root, profileId);
    const db = openDatabase(paths.database, profileId);
    const authority = memoryRecordAuthority(db);
    t.after(() => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const bytes = Buffer.from('Independently fictional large retained metadata.');
    const sourceHash = createHash('sha256').update(bytes).digest('hex');
    const path = paths.relativeRoot + '/sources/fictional.txt';
    writeFileSync(join(root, path), bytes);
    const initial = prepareInitialIntakeEnvelope({
      intake: {
        version: 1,
        originalName: 'fictional.txt',
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
      db.prepare('INSERT INTO providers(id,name) VALUES(?,?)').run(
        'fictional-provider',
        'Fictional Clinic',
      );
      db.prepare(
        'INSERT INTO source_files(id,provider_id,path,sha256,bytes,kind,mime_type,details_json) VALUES(?,?,?,?,?,?,?,?)',
      ).run(
        id,
        'fictional-provider',
        path,
        sourceHash,
        bytes.length,
        'intake_original',
        'text/plain',
        initial.detailsJson,
      );
      createIntakeStateStorage(db, { profileId, intakeId: id, sourceHash }).stage(
        initial.state,
        randomUUID(),
      );
    });
    const source = { id, sha256: sourceHash };
    await buildIntakeCollectionEnvelope(db, source);
    const view = openIntakeCollectionEnvelope(db, source);
    const originalName = 'fictional-' + 'x'.repeat(8 * 1024 * 1024 + 4096) + '.txt';
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
          jsonText: JSON.stringify(originalName),
        },
      ],
    });
    assert.ok(changed.projectDetailsJson);
    const oldMetadata = changed.projectDetailsJson({
      bytes: Buffer.byteLength(originalName) + 16384,
    });
    assert.ok(Buffer.byteLength(oldMetadata) > 8 * 1024 * 1024);
    transaction(db, () => {
      selectedEnvelopeStore(db, source).collections.stage(changed.prepared!);
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(oldMetadata, id);
    });
    const oldHead = authority.objects.get('head')!;
    const logical = JSON.stringify(openIntakeCollectionEnvelope(db, source).logical);
    const before = intakeWorkCounters(db).reconstruction;
    let oldSourceParses = 0;
    let giantMetadataParses = 0;
    const oldSourceParseStacks: string[] = [];
    const parse = JSON.parse;
    JSON.parse = ((
      text: string,
      ...args: Parameters<typeof JSON.parse> extends [string, ...infer Rest] ? Rest : never
    ) => {
      if (Buffer.byteLength(String(text)) > 8 * 1024 * 1024) giantMetadataParses++;
      if (text === oldMetadata) {
        oldSourceParses++;
        oldSourceParseStacks.push(new Error('giant source parse').stack!);
      }
      return parse(text, ...args);
    }) as typeof JSON.parse;
    try {
      assert.equal((await prepareIntakeFilenameSummary(db, source)).changed, true);
    } finally {
      JSON.parse = parse;
    }
    assert.equal(
      oldSourceParses,
      0,
      'cold preparation never parses the giant old source header\n' +
        oldSourceParseStacks.join('\n'),
    );
    assert.equal(
      giantMetadataParses,
      0,
      'cold publication also avoids parsing the complete giant accepted source preimage',
    );
    assert.equal(JSON.stringify(openIntakeCollectionEnvelope(db, source).logical), logical);
    const after = intakeWorkCounters(db).reconstruction;
    assert.equal(
      after.compactMetadataSourceReadBytes - before.compactMetadataSourceReadBytes,
      2 * Buffer.byteLength(oldMetadata),
    );
    assert.ok(
      Buffer.byteLength(
        String(
          db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!.details_json,
        ),
      ) < 2048,
    );
    assert.equal(
      intakeMetadataScalarMatches(intakeSourceMetadata(db, id).originalName, originalName),
      true,
    );
    // Rebuild an actually accepted old-v1 checkpoint, not a restored projection row.
    let recoveredHead = oldHead;
    const recoveredStorage: RecordStorage = {
      read(name) {
        return name === 'head' ? recoveredHead : authority.storage.read(name);
      },
      writeImmutable: authority.storage.writeImmutable,
      publishHead(bytes) {
        recoveredHead = Buffer.from(bytes);
      },
    };
    const recoveredPath = join(paths.root, 'fictional-recovered.sqlite');
    rebuildRecordDatabase(recoveredPath, { profileId, storage: recoveredStorage });
    const recovered = openDatabase(recoveredPath, profileId);
    try {
      attachRecordDurability(recovered, { profileId, storage: recoveredStorage });
      assert.equal(
        recovered.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!.details_json,
        oldMetadata,
      );
      assert.equal((await prepareIntakeFilenameSummary(recovered, source)).changed, true);
      assert.equal(
        intakeMetadataScalarMatches(intakeSourceMetadata(recovered, id).originalName, originalName),
        true,
      );
      const compact = recovered
        .prepare('SELECT details_json FROM source_files WHERE id=?')
        .get(id)!.details_json;
      let giantParses = 0;
      JSON.parse = ((
        text: string,
        ...args: Parameters<typeof JSON.parse> extends [string, ...infer Rest] ? Rest : never
      ) => {
        if (typeof text === 'string' && Buffer.byteLength(text) > 8 * 1024 * 1024) giantParses++;
        return parse(text, ...args);
      }) as typeof JSON.parse;
      try {
        transaction(recovered, () =>
          recovered
            .prepare('UPDATE source_files SET coverage_status=? WHERE id=?')
            .run('fictional-reviewed', id),
        );
      } finally {
        JSON.parse = parse;
      }
      assert.equal(
        giantParses,
        0,
        'the next ordinary accepted write compares the bounded accepted v2 preimage',
      );
      assert.equal(
        recovered.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!.details_json,
        compact,
      );
      const secondPath = join(paths.root, 'fictional-recovered-again.sqlite');
      rebuildRecordDatabase(secondPath, { profileId, storage: recoveredStorage });
      const again = openDatabase(secondPath, profileId);
      try {
        attachRecordDurability(again, { profileId, storage: recoveredStorage });
        assert.equal((await prepareIntakeFilenameSummary(again, source)).changed, false);
        assert.equal(
          again.prepare('SELECT details_json,coverage_status FROM source_files WHERE id=?').get(id)!
            .details_json,
          compact,
        );
        assert.equal(
          again.prepare('SELECT coverage_status FROM source_files WHERE id=?').get(id)!
            .coverage_status,
          'fictional-reviewed',
        );
        assert.equal(
          intakeMetadataScalarMatches(intakeSourceMetadata(again, id).originalName, originalName),
          true,
        );
        assert.deepEqual(
          again.prepare('SELECT * FROM __record_fields ORDER BY version_id,field').all(),
          recovered.prepare('SELECT * FROM __record_fields ORDER BY version_id,field').all(),
          'recovery independently reproduces every field reference and presence flag',
        );
      } finally {
        again.close();
      }
    } finally {
      recovered.close();
    }
  },
);
