import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction, clinicalReviewRevision } from '../database.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import {
  buildIntakeCollectionEnvelope,
  createEnvelopeBuildWriter,
} from '../intake-envelope-build.ts';
import {
  collectionCellReader,
  openIntakeCollectionEnvelope,
  iterateIntakeEnvelopeText,
  readSchemaOrder,
  readSchemaTextValue,
} from '../intake-collection-envelope.ts';
import { schemaKey, schemaOrdinal } from '../intake-envelope-schema.ts';
import {
  prepareIntakeMetadataHistorySchema,
  prepareIntakeWorkflowPeopleDraftsSchema,
} from '../intake-envelope-upgrade.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';

for (const name of ['metadataHistory', 'peopleDrafts'] as const)
  for (const cancel of [false, true])
    test(`older opaque ${name} upgrades exact raw lexical evidence${cancel ? ' after cancelled checkpoints' : ''}`, async (t) => {
      const upgrade =
        name === 'metadataHistory'
          ? prepareIntakeMetadataHistorySchema
          : prepareIntakeWorkflowPeopleDraftsSchema;
      const directory = mkdtempSync(join(tmpdir(), 'fictional-history-upgrade-')),
        identity = {
          profileId: 'fictional',
          intakeId: 'fictional-intake',
          sourceHash: 'f'.repeat(64),
        },
        db = openDatabase(join(directory, 'cache.sqlite'), identity.profileId);
      memoryRecordAuthority(db);
      t.after(() => {
        clearIntakeStateCache(db);
        db.close();
        rmSync(directory, { recursive: true, force: true });
      });
      const largeName = 'fictional-' + '🌿'.repeat(2500),
        history =
          '[ {"before": {"originalName":"first", "originalName":"last"}, "metadata":{"' +
          largeName +
          '":"' +
          'Fictional🌿'.repeat(1800) +
          '"}, "unknown":[1,2,3]}, {"before":null,"metadata":{"note":"retained"}} ]',
        text =
          ' { "unknown":true, "intake" : { "version":3,"originalName":"fictional.pdf", ' +
          (name === 'peopleDrafts'
            ? '"workflow":{"peopleDrafts":' + history + '}'
            : '"metadataHistory":' + history) +
          ' } }\n',
        initial = prepareInitialIntakeEnvelope(text),
        source = { id: identity.intakeId, sha256: identity.sourceHash };
      transaction(db, () => {
        db.prepare(
          'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
        ).run(
          identity.intakeId,
          'fictional.pdf',
          identity.sourceHash,
          0,
          'intake_original',
          initial.detailsJson,
        );
        createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
      });
      await buildIntakeCollectionEnvelope(db, source);
      const initialCollections = collectionCellReader(db, source).collections;
      const markerId = randomUUID(),
        marker = initialCollections.prepare(initialCollections.openView(), {
          operationId: markerId,
          requestDigest: createHash('sha256').update(markerId).digest('hex'),
          domainVersion: 3,
          changes: [
            {
              area: 'logical',
              collection: 'fictional.unchanged',
              op: 'put',
              key: 'marker',
              value: 'retained',
            },
          ],
        });
      transaction(db, () => initialCollections.stage(marker));
      // Construct the supported previous lexical representation with the same text:
      // metadataHistory was one cell; its old immutable nodes remain retained evidence.
      const { collections, store, head } = collectionCellReader(db, source),
        view = openIntakeCollectionEnvelope(db, source),
        intake = view.child(view.root(), 'intake')!,
        container = name === 'peopleDrafts' ? view.child(intake, 'workflow')! : intake,
        parent = view.address(container),
        field = schemaKey(name),
        ordinal = Number(readSchemaTextValue(store, 'l:' + parent + ':' + field)),
        key = 'o:' + parent + ':' + schemaOrdinal(ordinal),
        order = readSchemaOrder(readSchemaTextValue(store, key)),
        build = 'fictional.older-schema';
      const prepare = (changes: Parameters<typeof collections.prepare>[1]['changes']) => {
        const operationId = randomUUID();
        return collections.prepare(collections.openView(), {
          operationId,
          requestDigest: createHash('sha256').update(operationId).digest('hex'),
          domainVersion: head.logical.domainVersion,
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
        ]),
      );
      const writer = createEnvelopeBuildWriter(db, source, build, head.logical.domainVersion),
        target = { type: 'cell', id: schemaKey('old history') };
      await writer.cellPieces(
        'c:' + target.id,
        (function* () {
          for (let i = 0; i < history.length; i += 37) yield history.slice(i, i + 37);
        })(),
      );
      await writer.put('f:' + parent + ':' + field, JSON.stringify(target));
      await writer.put(key, JSON.stringify({ ...order, target }));
      await writer.flush();
      const bad = prepare([
        {
          area: 'logical',
          collection: 'envelope.data',
          op: 'adoptCollection',
          fromArea: 'builds',
          fromCollection: build,
        },
        {
          area: 'logical',
          collection: 'fictional.unchanged',
          op: 'put',
          key: 'marker',
          value: 'changed',
        },
      ]);
      assert.throws(
        () => collections.certifySchemaAdoption(bad),
        /changed another logical collection/,
      );
      collections.disposePreparation(bad);
      const adoption: Parameters<typeof collections.prepare>[1]['changes'] = [
        {
          area: 'logical',
          collection: 'envelope.data',
          op: 'adoptCollection',
          fromArea: 'builds',
          fromCollection: build,
        },
      ];
      let old = prepare(adoption);
      if (cancel) {
        let cancelled = false;
        setImmediate(() => {
          cancelled = true;
        });
        await assert.rejects(
          collections.certifySchemaAdoptionAsync(old, {
            assertRunning() {
              if (cancelled) throw Error('Fictional certificate cancellation');
            },
          }),
          /Fictional certificate cancellation/,
        );
        assert.throws(
          () => collections.commitMaintenance(old),
          'cancelled verification cannot authorize representation publication',
        );
        old = prepare(adoption);
        let raced = false;
        setImmediate(() => {
          collections.commitMaintenance(
            prepare([
              {
                area: 'builds',
                collection: 'fictional.racing-checkpoint',
                op: 'put',
                key: 'progress',
                value: '1',
              },
            ]),
          );
          raced = true;
        });
        await assert.rejects(
          collections.certifySchemaAdoptionAsync(old),
          /changed during verification/,
        );
        assert.equal(raced, true);
        collections.disposePreparation(old);
        old = prepare(adoption);
      }
      const beforeCertificate = intakeWorkCounters(db);
      await collections.certifySchemaAdoptionAsync(old);
      const afterCertificate = intakeWorkCounters(db);
      assert.equal(
        afterCertificate.reconstruction.schemaCertificationHashedBytes -
          beforeCertificate.reconstruction.schemaCertificationHashedBytes,
        2 * Buffer.byteLength(text),
      );
      assert.equal(
        afterCertificate.warm.schemaCertificationHashedBytes -
          beforeCertificate.warm.schemaCertificationHashedBytes,
        0,
      );
      collections.commitMaintenance(old);
      const revision = clinicalReviewRevision(db),
        before = intakeWorkCounters(db).reconstruction.schemaUpgradeInputUnits;
      if (cancel) {
        await assert.rejects(
          upgrade(db, source, {
            onCheckpoint() {
              throw Error('Fictional checkpoint cancellation');
            },
          }),
          /Fictional checkpoint cancellation/,
        );
        assert.equal([...iterateIntakeEnvelopeText(db, source)].join(''), text);
        assert.equal(clinicalReviewRevision(db), revision);
      }
      assert.deepEqual(await upgrade(db, source), { changed: true });
      assert.equal([...iterateIntakeEnvelopeText(db, source)].join(''), text);
      assert.equal(clinicalReviewRevision(db), revision);
      assert.equal(
        collections.get(collections.openView(), 'logical', 'fictional.unchanged', 'marker'),
        'retained',
      );
      const selected = openIntakeCollectionEnvelope(db, source),
        nextIntake = selected.child(selected.root(), 'intake')!,
        nextContainer =
          name === 'peopleDrafts' ? selected.child(nextIntake, 'workflow')! : nextIntake;
      assert.equal(selected.childCount(nextContainer, name), 2);
      const first = selected.childAt(nextContainer, name, 0)!,
        prior = selected.child(first, 'before')!;
      assert.deepEqual(selected.field(prior, 'originalName'), { kind: 'value', value: 'last' });
      assert.ok(intakeWorkCounters(db).reconstruction.schemaUpgradeInputUnits > before);
      assert.ok(intakeWorkCounters(db).reconstruction.schemaUpgradePeakBufferBytes <= 8192);
      const counted = intakeWorkCounters(db).reconstruction.schemaUpgradeInputUnits,
        certified = intakeWorkCounters(db).reconstruction.schemaCertificationHashedBytes;
      clearIntakeStateCache(db);
      assert.deepEqual(await upgrade(db, source), { changed: false });
      assert.equal(intakeWorkCounters(db).reconstruction.schemaUpgradeInputUnits, counted);
      assert.equal(intakeWorkCounters(db).reconstruction.schemaCertificationHashedBytes, certified);
      const operationId = randomUUID(),
        changed = await prepareIntakeEnvelopeMutation(db, source, {
          reader: selected,
          operationId,
          requestDigest: createHash('sha256').update(operationId).digest('hex'),
          domainVersion: 4,
          changes: [
            {
              op: 'append',
              record: nextContainer,
              field: name,
              jsonText: '{"before":{},"metadata":{}}',
            },
          ],
        });
      const publication = changed.prepared;
      assert.ok(publication);
      transaction(db, () => collections.stage(publication));
      const current = openIntakeCollectionEnvelope(db, source),
        currentIntake = current.child(current.root(), 'intake')!,
        currentContainer =
          name === 'peopleDrafts' ? current.child(currentIntake, 'workflow')! : currentIntake;
      assert.equal(current.childCount(currentContainer, name), 3);
    });
