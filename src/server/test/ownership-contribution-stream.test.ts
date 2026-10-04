import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../database.ts';
import { ownershipContributions } from '../ownership-contributions.ts';
import {
  iterateOwnershipStreamContributions,
  ownershipContributionWork,
  ownershipContributionSequence,
  contributionMappingsDisagree,
} from '../ownership-contribution-stream.ts';
import { ownershipMappingHash } from '../record-ownership-authority.ts';
import { ownershipClinicalHeader } from '../ownership-clinical-header.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { duplicateRecord } from '../duplicate-review.ts';
import { createOwnershipPreviewStore } from '../ownership-preview-store.ts';
import { prepareOwnershipMatchEvidence } from '../ownership-match-evidence.ts';

test('source fan-in streams exact legacy order, contribution hashes and evidence without retaining complete joins', () => {
  const db = openDatabase(':memory:', 'fictional');
  try {
    db.prepare(
      "INSERT INTO source_files(id,path,sha256,bytes) VALUES('original','fictional.txt',?,1)",
    ).run('1'.repeat(64));
    const ids = ['z', '\ue000', '𐀀', ...Array.from({ length: 2048 }, (_, i) => 'fictional-' + i)];
    for (const [i, id] of ids.entries()) {
      const envelope = {
        format: 'health-record-v1',
        id,
        kind: 'record',
        payload: { literal: 'Fictional ' + i },
        clinical: { kind: 'document', documentTitle: 'Fictional' },
        provenance: {
          sourceSystem: 'Fictional Clinic',
          sourceRecordId: id,
          locator: 'Fictional ' + i,
        },
      };
      db.prepare(
        'INSERT INTO source_records(id,source_file_id,source_key,raw_json) VALUES(?,?,?,?)',
      ).run(id, 'original', id, JSON.stringify(envelope));
      db.prepare(
        "INSERT INTO evidence(id,entity_type,entity_id,source_record_id,role) VALUES(?,'document','saved',?,'source')",
      ).run('evidence-' + i, id);
      db.prepare(
        "INSERT INTO manual_batches(id,title,status,created_at,coverage_json) VALUES(?,'Accepted clinical contribution','verified','2026-01-01',?)",
      ).run(
        'accepted-' + i,
        JSON.stringify({
          sourceRecordId: id,
          intakeId: 'original',
          mapping: { kind: 'document', documentTitle: 'Fictional' },
          revision: i,
        }),
      );
    }
    db.prepare(
      "INSERT INTO documents(id,source_record_id,title,extra_json) VALUES('saved',?,'Fictional',?)",
    ).run(
      ids[0]!,
      JSON.stringify({
        import: { acceptedMapping: { kind: 'document', documentTitle: 'Fictional' } },
      }),
    );
    for (let i = 0; i < 32; i++)
      db.prepare(
        "INSERT INTO evidence(id,entity_type,entity_id,source_record_id,role) VALUES(?,'document','saved','z',?)",
      ).run('additional-' + i, 'additional-' + i);
    db.prepare(
      "INSERT INTO manual_batches(id,title,status,created_at,coverage_json) VALUES('transition','Duplicate evidence decision','verified','2026-01-01',?)",
    ).run(
      JSON.stringify({
        duplicateDecision: { sequence: 1, occurrenceAttachment: { incomingSourceRecordId: 'z' } },
      }),
    );
    const scopes = () => ['original:report-a', 'original:report-b'];
    const oracle = ownershipContributions(db, 'document', 'saved', { scopes });
    const actual = Array.from(
      iterateOwnershipStreamContributions(db, 'document', 'saved', { scopes }),
      (value) => ({
        ...value,
        reportScopes: [...value.reportScopes()],
        evidenceIds: [...value.evidenceIds()],
      }),
    );
    assert.deepEqual(actual, oracle);
    assert.deepEqual(
      actual.map((value) => value.sourceRecordId),
      [...ids].sort(),
    );
    const work = ownershipContributionWork(db);
    assert.equal(work.sourceRows, ids.length);
    assert.equal(work.evidenceRows, ids.length + 32);
    assert.equal(work.transitionRows, 2);
    assert.ok(
      work.maxEncodedRowBytes < 2048,
      'the counted largest hash input is one source/evidence/transition row',
    );
    const sequence = ownershipContributionSequence(db, 'document', 'saved', { scopes });
    assert.equal(sequence.length, ids.length);
    assert.equal(sequence.first()!.sourceRecordId, [...ids].sort()[0]);
    assert.equal(contributionMappingsDisagree(sequence, ownershipMappingHash), false);
    const changed = actual.at(-1)!;
    db.prepare('UPDATE source_records SET label=? WHERE id=?').run(
      'Fictional changed',
      changed.sourceRecordId,
    );
    assert.notEqual(
      sequence.find((value) => value.sourceRecordId === changed.sourceRecordId)!.version,
      changed.version,
    );
    assert.equal('evidence' in ownershipClinicalHeader(db, 'document', 'saved'), false);
    const scratch = new DatabaseSync(':memory:');
    try {
      const store = createOwnershipPreviewStore(scratch, new Set(ids), '/fictional-evidence'),
        before = ownershipContributionWork(db).sourceRows;
      const interrupted = store.sink.contributionSteps('document', 'saved', sequence, () => true);
      assert.equal(interrupted.next().done, false);
      assert.equal(ownershipContributionWork(db).sourceRows - before, 32);
      assert.equal(scratch.prepare('SELECT COUNT(*) n FROM preview_contributions').get()!.n, 32);
      interrupted.return(undefined as never);
      const retry = store.sink.contributionSteps('document', 'saved', sequence, () => true);
      let yields = 0;
      for (;;) {
        const step = retry.next();
        if (step.done) {
          assert.equal(step.value.total, ids.length);
          assert.equal(step.value.selectedTotal, ids.length);
          break;
        }
        yields++;
      }
      assert.ok(yields >= Math.floor(ids.length / 32));
      assert.equal(
        scratch.prepare('SELECT COUNT(*) n FROM preview_contributions').get()!.n,
        ids.length,
      );
    } finally {
      scratch.close();
    }
  } finally {
    db.close();
  }
});

test('native destination evidence pins every carrier and original while storing the exact legacy display rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-ownership-match-')),
    profileId = 'fictional',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId),
    scratch = new DatabaseSync(':memory:');
  try {
    for (const id of ['carrier', 'original']) {
      const bytes = Buffer.from('Fictional ' + id),
        path = paths.relativeRoot + '/sources/' + id + '.txt';
      writeFileSync(join(root, path), bytes);
      db.prepare('INSERT INTO source_files(id,path,sha256,bytes) VALUES(?,?,?,?)').run(
        id,
        path,
        createHash('sha256').update(bytes).digest('hex'),
        bytes.length,
      );
    }
    const envelope = {
      format: 'health-record-v1',
      id: 'literal',
      kind: 'record',
      clinical: { kind: 'document', documentTitle: 'Fictional' },
      provenance: {
        sourceSystem: 'Fictional Clinic',
        sourceRecordId: 'literal',
        locator: 'Source locator',
      },
    };
    db.prepare(
      "INSERT INTO source_records(id,source_file_id,raw_json,locator_json) VALUES('source','carrier',?,?)",
    ).run(
      JSON.stringify(envelope),
      JSON.stringify({ originalSourceFileId: 'original', locator: 'Source locator' }),
    );
    db.prepare(
      "INSERT INTO documents(id,source_record_id,title,extra_json) VALUES('saved','source','Fictional',?)",
    ).run(JSON.stringify({ import: { acceptedMapping: envelope.clinical } }));
    for (let i = 0; i < 257; i++)
      db.prepare(
        "INSERT INTO evidence(id,entity_type,entity_id,source_record_id,role,locator_json) VALUES(?,'document','saved','source',?,?)",
      ).run(
        'evidence-' + i,
        'role-' + i,
        JSON.stringify({ locator: 'Fictional evidence ' + i, originalSourceFileId: 'original' }),
      );
    const store = createOwnershipPreviewStore(scratch, new Set(), '/evidence'),
      result = prepareOwnershipMatchEvidence(db, root, profileId, 'document', 'saved', store.sink);
    assert.equal(result.reference.total, 257);
    const oracle = duplicateRecord(db, 'document', 'saved').evidence.map(
      ({ original, ...value }) => {
        void original;
        return value;
      },
    );
    const rows = scratch
      .prepare('SELECT value FROM preview_contributions WHERE record_key=? ORDER BY ordinal')
      .all(result.reference.key)
      .map((row) => JSON.parse(String(row.value)));
    assert.deepEqual(rows, oracle);
    writeFileSync(join(paths.sources, 'carrier.txt'), 'Changed fictional carrier');
    assert.throws(
      () => prepareOwnershipMatchEvidence(db, root, profileId, 'document', 'saved', store.sink),
      /changed|integrity|match|hash|size/i,
    );
  } finally {
    scratch.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
