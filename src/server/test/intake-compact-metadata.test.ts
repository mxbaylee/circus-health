import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction } from '../database.ts';
import { constants } from 'node:sqlite';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { createIntakeStateStorage } from '../intake-state-storage.ts';
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
import { iterateIntakeEnvelopeText } from '../intake-collection-envelope.ts';
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
  for (const originalName of [17, null, { fictional: 'ordinary retained metadata' }]) {
    const value = { intake: { originalName, locator: JSON.parse(locator), version: 1 } };
    const projected = compactIntakeMetadata(value, INTAKE_COMPACT_ENVELOPE_FORMAT);
    assert.deepEqual(projected.originalName, originalName);
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
    memoryRecordAuthority(db);
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
    const initial = prepareInitialIntakeEnvelope({
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
    assert.throws(() => intakeSourceMetadata(db, id), /Prepare the selected source metadata/);
    let turns = 0;
    const result = await prepareIntakeFilenameSummary(db, source, {
      assertRunning() {
        turns++;
      },
    });
    assert.equal(result.changed, true);
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
    assert.equal(intakeFirstLocatorMatches(db, id, locator), true);
    assert.equal(intakeFirstLocatorMatches(db, id, locator + 'changed'), false);

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
