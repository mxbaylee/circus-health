import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  getIntakeOriginal,
  importIntake,
  proposeConversion,
  updateIntakeMetadata,
  uploadIntake,
} from '../intake.ts';
import { getSourceRecord, getSourceFile, sourceFiles } from '../queries.ts';
import { sourceFileAttribution } from '../../app/data/sourceStatus.ts';

test('retained extraction exposes its original separately and keeps absent evidence explicit', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'circus-original-links-'));
  const profileId = 'orchid';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const originalBytes = Buffer.from('Fictional retained source text');
  const original = uploadIntake(db, root, profileId, {
    filename: 'fictional-source.txt',
    newProviderName: 'Example clinic',
    bytes: originalBytes,
  });
  const proposal = proposeConversion(db, root, profileId, original.id, {
    version: original.version,
    jsonlText: JSON.stringify({
      format: 'health-record-v1',
      id: 'fictional-context',
      kind: 'context',
      payload: { text: 'Fictional retained source text' },
      provenance: {
        capturedVia: 'Example clinic',
        sourceSystem: null,
        sourceRecordId: 'fictional-context',
        evidenceClass: 'transcription',
        locator: 'line 1',
      },
      coverage: { status: 'complete_response', notes: [] },
    }),
    summary: 'Fictional context extraction',
  });
  const imported = importIntake(db, root, profileId, original.id, {
    version: proposal.version,
    proposalId: proposal.proposals[0].id,
  });
  const row = db.prepare('SELECT id FROM source_records').get();
  assert.ok(row);
  const id = String(row.id);
  const record = getSourceRecord(db, id);
  assert.ok(record.originalFile);
  assert.ok(record.extractionFile);
  assert.ok(record.file);
  assert.equal(record.originalFile.id, original.id);
  assert.equal(record.extractionFile.id, record.file.id);
  assert.notEqual(record.originalFile.id, record.extractionFile.id);
  assert.match(record.originalFile.contentUrl, /\/content$/);
  assert.equal(record.originalMissing, false);
  db.prepare('UPDATE source_records SET locator_json=? WHERE id=?').run(
    JSON.stringify({ originalSourceFileId: 'missing-fictional-member' }),
    id,
  );
  const missing = getSourceRecord(db, id);
  assert.equal(missing.originalMissing, true);
  assert.equal(missing.originalFile, null);
  assert.equal(missing.extractionFile?.id, record.extractionFile.id);
  db.prepare('UPDATE source_records SET locator_json=? WHERE id=?').run(
    JSON.stringify({ originalSourceFileId: original.id }),
    id,
  );

  // A real metadata edit remains separate from immutable acquisition attribution.
  const before = getSourceFile(db, original.id);
  const frozenFile = db
    .prepare('SELECT provider_id,path,sha256,bytes FROM source_files WHERE id=?')
    .get(original.id);
  const updated = updateIntakeMetadata(db, root, profileId, original.id, {
    version: imported.version,
    operationId: 'fictional-reviewed-source-label',
    metadata: { source: 'Reviewed clinic' },
  });
  assert.ok(updated.metadata);
  const file = getSourceFile(db, original.id);
  assert.equal(file.providerId, before.providerId);
  assert.equal(file.provider, 'Example clinic');
  assert.equal(file.reviewedSourceProviderId, updated.metadata.sourceProviderId);
  assert.equal(file.reviewedSource, 'Reviewed clinic');
  assert.deepEqual(sourceFileAttribution(file), {
    acquisition: 'Example clinic',
    reviewedSource: 'Reviewed clinic',
  });
  const updatedRecord = getSourceRecord(db, id);
  assert.equal(updatedRecord.provider, 'Example clinic');
  assert.equal(updatedRecord.originalFile?.provider, 'Example clinic');
  assert.equal(updatedRecord.originalFile?.reviewedSource, 'Reviewed clinic');
  assert.equal(updatedRecord.extractionFile?.provider, 'Example clinic');
  assert.equal(updatedRecord.extractionFile?.reviewedSource, null);
  assert.deepEqual(
    db
      .prepare('SELECT provider_id,path,sha256,bytes FROM source_files WHERE id=?')
      .get(original.id),
    frozenFile,
  );
  assert.deepEqual(getIntakeOriginal(db, root, profileId, original.id).bytes, originalBytes);
  const acquisitionFiles = sourceFiles(
    db,
    new URLSearchParams({ acquisitionProviderId: before.providerId! }),
  );
  assert.equal(acquisitionFiles.total, 2);
  assert.ok(acquisitionFiles.data.some((item) => item.id === original.id));
  assert.ok(acquisitionFiles.data.every((item) => item.providerId === before.providerId));
  const reviewedFiles = sourceFiles(
    db,
    new URLSearchParams({ reviewedSourceProviderId: updated.metadata.sourceProviderId! }),
  );
  assert.equal(reviewedFiles.total, 1);
  assert.equal(reviewedFiles.data[0]!.id, original.id);
  assert.equal(
    sourceFiles(db, new URLSearchParams({ providerId: updated.metadata.sourceProviderId! }))
      .data[0]!.id,
    original.id,
  );
  const compatibilityAcquisition = sourceFiles(
    db,
    new URLSearchParams({ providerId: before.providerId! }),
  );
  assert.equal(compatibilityAcquisition.total, 1);
  assert.equal(compatibilityAcquisition.data[0]!.id, proposal.proposals[0]!.id);
  assert.equal(
    sourceFiles(db, new URLSearchParams({ q: 'Reviewed clinic' })).data[0]!.id,
    original.id,
  );
  assert.equal(
    sourceFiles(db, new URLSearchParams({ kind: 'intake_original' })).data[0]!.id,
    original.id,
  );
});
