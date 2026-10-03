import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { registerIntakeFile } from '../intake-state-access.ts';
import { transaction } from '../database.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createApp } from '../index.ts';
import { HttpError, openDatabase } from '../database.ts';
import {
  getSourceRecord,
  sourceRecordFileView,
  type SourceRecordReferenceDTO,
} from '../queries.ts';
import { setVisibility } from '../visibility.ts';

const sentinel = 'fictional-workflow-sentinel-'.repeat(800);

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-source-record-reference-'));
  const db = openDatabase(resolve(root, 'cookie-dough.sqlite'), 'cookie-dough');
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  transaction(db, () => {
    db.exec(
      "INSERT INTO providers VALUES('acquisition','Fictional Acquisition'),('reviewed','Fictional Reviewed Source')",
    );
    const insertFile = db.prepare(
      `INSERT INTO source_files
      (id,provider_id,path,sha256,bytes,mime_type,kind,coverage_status,details_json)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    );
    const details = (source: string, parentSourceFileId?: string) =>
      JSON.stringify({
        intake: {
          metadata: { sourceProviderId: 'reviewed', source },
          ...(parentSourceFileId ? { parentSourceFileId } : {}),
        },
        workflow: sentinel,
      });
    insertFile.run(
      'extraction',
      'acquisition',
      'fictional/proposal.jsonl',
      'e'.repeat(64),
      111,
      'application/x-ndjson',
      'intake_proposal',
      'derived_proposal; mapped',
      details('Fictional Extraction Label'),
    );
    registerIntakeFile(db, {
      id: 'original',
      providerId: 'acquisition',
      path: 'fictional/original.txt',
      sha256: 'a'.repeat(64),
      size: 222,
      mimeType: 'text/plain',
      kind: 'intake_original',
      coverage: 'original_retained; clinical_coverage_unknown',
      details: details('Fictional Original Label', 'ancestor-1'),
    });
    for (let index = 1; index <= 9; index += 1)
      insertFile.run(
        `ancestor-${index}`,
        'acquisition',
        `fictional/ancestor-${index}.zip`,
        String(index).repeat(64),
        300 + index,
        'application/zip',
        'archive',
        'retained',
        details(
          `Fictional Ancestor ${index}`,
          index === 9 ? 'ancestor-1' : `ancestor-${index + 1}`,
        ),
      );
    const insertRecord = db.prepare(
      `INSERT INTO source_records
      (id,source_file_id,provider_id,source_key,kind,label,raw_json,locator_json,extraction_status)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    );
    insertRecord.run(
      'source:fictional',
      'extraction',
      'reviewed',
      'fictional-key',
      'source_capture',
      'Fictional retained source',
      '{"content":{"literal":"01.00"}}',
      JSON.stringify({ originalSourceFileId: 'original', page: 2 }),
      'projected_reviewed',
    );
    insertRecord.run(
      'source:related',
      'extraction',
      'reviewed',
      'related-key',
      'context',
      'Fictional related source',
      '{"data":{}}',
      '{}',
      'retained',
    );
    db.prepare(
      `INSERT INTO record_relationships
      (id,from_record_id,to_record_id,relation,status,rationale)
     VALUES(?,?,?,?,?,?)`,
    ).run(
      'relationship-1',
      'source:fictional',
      'source:related',
      'fictional-context',
      'accepted',
      'Fictional reviewed relationship',
    );
  });
  setVisibility(db, 'source_file', 'ancestor-2', { archived: true, version: 0 });
  return { root, db };
}

function assertReferenceShape(record: SourceRecordReferenceDTO) {
  assert.equal(record.fileView, 'reference');
  assert.equal(record.file?.detailsIncluded, false);
  assert.equal(record.extractionFile?.detailsIncluded, false);
  if (record.originalFile) assert.equal(record.originalFile.detailsIncluded, false);
  assert.ok(record.ancestorFiles?.every((file) => file.detailsIncluded === false));
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /fictional-workflow-sentinel/);
  assert.doesNotMatch(serialized, /parentSourceFileId/);
  assert.doesNotMatch(serialized, /parent_source_file_id/);
  assert.doesNotMatch(serialized, /"details"/);
}

test('reference view preserves evidence and file roles without serializing workflow details', (t) => {
  const { db } = fixture(t);
  const legacy = getSourceRecord(db, 'source:fictional');
  assert.deepEqual(getSourceRecord(db, 'source:fictional', { fileView: 'full' }), legacy);
  assert.ok(!Object.hasOwn(legacy, 'fileView'));
  assert.equal((legacy.file?.details as { workflow: string }).workflow, sentinel);
  assert.equal(legacy.extractionFile, legacy.file);
  assert.equal(legacy.originalFile?.id, 'original');

  const reference = getSourceRecord(db, 'source:fictional', { fileView: 'reference' });
  assertReferenceShape(reference);
  assert.deepEqual(reference.raw, legacy.raw);
  assert.equal(reference.rawText, legacy.rawText);
  assert.deepEqual(reference.locator, legacy.locator);
  assert.deepEqual(reference.relationships, legacy.relationships);
  assert.equal(reference.provider, 'Fictional Reviewed Source');
  assert.equal(reference.file?.provider, 'Fictional Acquisition');
  assert.equal(reference.file?.reviewedSource, 'Fictional Extraction Label');
  assert.equal(reference.extractionFile?.id, 'extraction');
  assert.equal(reference.originalFile?.id, 'original');
  assert.equal(reference.originalFile?.reviewedSource, 'Fictional Original Label');
  assert.equal(reference.originalMissing, false);
  assert.equal(reference.file?.contentUrl, '/api/sources/extraction/content');
  assert.equal(reference.file?.detailsUrl, '/api/sources/extraction');
  assert.deepEqual(
    reference.ancestorFiles?.map((file) => file.id),
    Array.from({ length: 8 }, (_, index) => `ancestor-${index + 1}`),
  );
  assert.equal(reference.ancestorFiles?.[1]?.archived, true);

  const fullBytes = Buffer.byteLength(JSON.stringify(Array(10).fill(legacy)));
  const referenceBytes = Buffer.byteLength(JSON.stringify(Array(200).fill(reference)));
  assert.ok(
    referenceBytes < fullBytes,
    `${referenceBytes} compact bytes < ${fullBytes} full bytes`,
  );

  db.prepare('UPDATE source_records SET locator_json=? WHERE id=?').run(
    JSON.stringify({ originalSourceFileId: 'missing-original' }),
    'source:fictional',
  );
  const missing = getSourceRecord(db, 'source:fictional', { fileView: 'reference' });
  assert.equal(missing.originalFile, null);
  assert.equal(missing.originalMissing, true);
  assert.deepEqual(missing.ancestorFiles, []);
  assertReferenceShape(missing);
});

test('file-view parser rejects ambiguous and unsupported projections', () => {
  assert.equal(sourceRecordFileView(new URLSearchParams()), 'full');
  assert.equal(sourceRecordFileView(new URLSearchParams('fileView=full')), 'full');
  assert.equal(sourceRecordFileView(new URLSearchParams('fileView=reference')), 'reference');
  for (const query of [
    'fileView=',
    'fileView=compact',
    'fileView=reference&fileView=reference',
    'fileView=reference&fileView=full',
  ])
    assert.throws(
      () => sourceRecordFileView(new URLSearchParams(query)),
      (error) =>
        error instanceof HttpError && error.status === 400 && error.code === 'INVALID_INPUT',
      query,
    );
});

test('profile routes keep full defaults and expose only explicit profile-scoped references', async (t) => {
  const { root, db } = fixture(t);
  const app = createApp({ root, databases: new Map([['cookie-dough', db]]) });
  await new Promise<void>((ready) => app.server.listen(0, '127.0.0.1', ready));
  t.after(() => new Promise<void>((done) => app.server.close(() => done())));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/cookie-dough`;
  const read = async (path: string) => {
    const response = await fetch(base + path);
    const body = (await response.json()) as {
      data?: Record<string, unknown>;
      error?: { code: string };
    };
    return { response, body };
  };

  const legacy = await read('/source-records/source%3Afictional');
  assert.equal(legacy.response.status, 200);
  assert.match(JSON.stringify(legacy.body.data), /fictional-workflow-sentinel/);
  assert.equal(legacy.body.data?.fileView, undefined);
  const explicitFull = await read('/source-records/source%3Afictional?fileView=full');
  assert.deepEqual(explicitFull.body.data, legacy.body.data);

  const compact = await read('/source-records/source%3Afictional?fileView=reference');
  assert.equal(compact.response.status, 200);
  assert.equal(compact.body.data?.fileView, 'reference');
  assertReferenceShape(compact.body.data as unknown as SourceRecordReferenceDTO);
  const compactFile = compact.body.data?.file as Record<string, unknown>;
  assert.equal(compactFile.contentUrl, '/api/profiles/cookie-dough/sources/extraction/content');
  assert.equal(compactFile.detailsUrl, '/api/profiles/cookie-dough/sources/extraction');

  const fullFile = await read('/sources/extraction');
  assert.equal(fullFile.response.status, 200);
  assert.match(JSON.stringify(fullFile.body.data), /fictional-workflow-sentinel/);

  const resolvedLegacy = await read('/source-records/source%3Afictional/resolved');
  assert.equal(resolvedLegacy.response.status, 200);
  assert.match(
    JSON.stringify((resolvedLegacy.body.data?.source as Record<string, unknown>).file),
    /fictional-workflow-sentinel/,
  );
  const resolvedCompact = await read(
    '/source-records/source%3Afictional/resolved?fileView=reference',
  );
  assert.equal(resolvedCompact.response.status, 200);
  assert.equal(resolvedCompact.body.data?.resolvedText, resolvedLegacy.body.data?.resolvedText);
  assert.equal(resolvedCompact.body.data?.referenceCount, resolvedLegacy.body.data?.referenceCount);
  assertReferenceShape(resolvedCompact.body.data?.source as unknown as SourceRecordReferenceDTO);

  for (const query of ['?fileView=compact', '?fileView=reference&fileView=full']) {
    const rejected = await read(`/source-records/source%3Afictional${query}`);
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.body.error?.code, 'INVALID_INPUT');
    const rejectedResolved = await read(`/source-records/source%3Afictional/resolved${query}`);
    assert.equal(rejectedResolved.response.status, 400);
    assert.equal(rejectedResolved.body.error?.code, 'INVALID_INPUT');
  }
  const foreign = await fetch(
    base.replace('/cookie-dough', '/foreign-profile') +
      '/source-records/source%3Afictional?fileView=reference',
  );
  assert.equal(foreign.status, 404);
});
