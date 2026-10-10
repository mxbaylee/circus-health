import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReadStream,
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import {
  writeLargeStreamedZip,
  writeLargeFictionalPdf,
} from '../../tests/fixtures/large-streamed-zip.ts';
import { inspectPackageFile, PackageInspectionError } from '../intake-package-worker.ts';
import { openDatabase } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  getIntakeRead,
  getRetainedIntakeOriginalReference,
  uploadIntakeStream,
} from '../intake.ts';
import { inventoryIntakePackagePaged, readIntakePackageMember } from '../intake-package.ts';
import { isIntakeSummary } from '../../shared/intake-summary.ts';
import { readIntakeEvidence } from '../intake-evidence.ts';
import { createIntakeFileWorkCounters, withIntakeFileWork } from '../intake-file-work.ts';
import {
  disposePdfEvidenceSessions,
  pdfEvidenceSessionDiagnostics,
} from '../intake-pdf-session.ts';

const MIB = 1024 * 1024;
const receipt: Record<string, unknown> = {
  fictional: true,
  payload: 'two-page PDFs with unreferenced fixed-block padding; not representative scanned pages',
};
function hashFile(path: string) {
  const fd = openSync(path, 'r'),
    chunk = Buffer.alloc(64 * 1024),
    digest = createHash('sha256');
  try {
    let bytes;
    while ((bytes = readSync(fd, chunk, 0, chunk.length, null)))
      digest.update(chunk.subarray(0, bytes));
  } finally {
    closeSync(fd);
  }
  return digest.digest('hex');
}

test(
  'large stored and deflated ZIP members retain exact bytes with bounded worker chunks and direct PDF read parity',
  { timeout: 240_000 },
  async (t) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'fictional-large-package-'));
    const profileId = 'fictional-large-profile';
    const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    attachPersonalDurability(db, { root, profileId });
    t.after(async () => {
      await disposePdfEvidenceSessions(profileId);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const pdfs = [26, 52].map((size) => {
      const path = join(root, `fictional-${size}.pdf`);
      return {
        path,
        ...writeLargeFictionalPdf(path, size * MIB),
      };
    });
    const zipPath = join(root, 'fictional-large.zip');
    const fixture = await writeLargeStreamedZip(zipPath, [
      { name: 'stored-26.pdf', path: pdfs[0]!.path, store: true },
      { name: 'deflated-52.pdf', path: pdfs[1]!.path },
      { name: 'copy-52.pdf', path: pdfs[1]!.path },
    ]);
    const fd = openSync(zipPath, 'r');
    let inventory;
    try {
      inventory = await inspectPackageFile({ sourceFd: fd });
    } finally {
      closeSync(fd);
    }
    const expanded = fixture.members.reduce((total, member) => total + member.bytes, 0);
    assert.equal(inventory.work.memberReadBytes, expanded);
    assert.equal(inventory.work.hashBytes, expanded);
    assert.equal(inventory.work.crcBytes, expanded);
    assert.equal(inventory.work.writtenBytes, 0);
    assert.ok(inventory.work.peakChunkBytes <= 256 * 1024);
    assert.equal(inventory.work.entries, 3);
    assert.deepEqual(
      inventory.members.map((m) => m.sourceHash),
      fixture.members.map((m) => m.sourceHash),
    );
    const selectedWork = [];
    for (const member of inventory.members.slice(0, 2)) {
      const sourceFd = openSync(zipPath, 'r');
      const output = join(root, `selected-${member.ordinal}.pdf`),
        outputFd = openSync(output, 'wx', 0o600);
      try {
        const selected = await inspectPackageFile({
          sourceFd,
          outputFd,
          selectedOrdinal: member.ordinal,
        });
        assert.equal(selected.work.memberReadBytes, member.bytes);
        assert.equal(selected.work.hashBytes, member.bytes);
        assert.equal(selected.work.crcBytes, member.bytes);
        assert.equal(selected.work.writtenBytes, member.bytes);
        assert.ok(selected.work.peakChunkBytes <= 256 * 1024);
        assert.ok(selected.work.memberChunks > 1);
        selectedWork.push(selected.work);
      } finally {
        closeSync(outputFd);
        closeSync(sourceFd);
      }
      assert.equal(hashFile(output), member.sourceHash);
    }
    const upload = (path: string, filename: string) =>
      uploadIntakeStream(
        db,
        root,
        profileId,
        { filename, newProviderName: 'Fictional clinic' },
        createReadStream(path, { highWaterMark: 64 * 1024 }) as unknown as IncomingMessage,
      );
    const direct = [];
    for (const pdf of pdfs) direct.push(await upload(pdf.path, 'fictional.pdf'));
    const packageIntake = await upload(zipPath, 'fictional-large.zip');
    const context = { db, root, profileId, id: packageIntake.id };
    const index = await inventoryIntakePackagePaged(context);
    assert.equal(index.members.length, 3);
    assert.equal(index.nextOffset, null, 'the fixture reads its complete three-member inventory');
    assert.notEqual(index.members[1]!.memberId, index.members[2]!.memberId);
    const packageHash = hashFile(
      getRetainedIntakeOriginalReference(db, root, profileId, packageIntake.id).path,
    );
    const parentWork = [];
    const childIds: string[] = [];
    for (const [ordinal, member] of index.members.entries()) {
      assert.ok(!('format' in member), 'fictional member metadata fits one inventory entry');
      const counters = createIntakeFileWorkCounters();
      const result = await withIntakeFileWork(counters, () =>
        readIntakePackageMember({ ...context, memberId: member.memberId, page: 2, pdf: true }),
      );
      assert.ok('pdfContent' in result && result.pdfContent);
      assert.ok('metadata' in result && result.metadata.sourceFileId);
      const childId = result.metadata.sourceFileId;
      childIds.push(childId);
      const retained = getRetainedIntakeOriginalReference(db, root, profileId, childId);
      assert.equal(retained.size, member.bytes);
      assert.equal(hashFile(retained.path), member.sourceHash);
      assert.ok(counters.readBytes < MIB, 'member is never read into a whole parent buffer');
      assert.ok(counters.bufferHashBytes < MIB);
      assert.equal(counters.streamHashBytes, counters.streamReadBytes);
      // Stage, publication, native-conversion lease, then evidence verification.
      assert.equal(counters.inspectionBufferBytes, 4 * 256 * 1024);
      assert.equal(counters.streamReadBytes, 4 * member.bytes);
      const original: Awaited<ReturnType<typeof readIntakeEvidence>> = await readIntakeEvidence({
        db,
        root,
        profileId,
        id: direct[ordinal === 0 ? 0 : 1]!.id,
        page: 2,
        pdf: true,
      });
      assert.ok('pdfContent' in original);
      assert.equal(result.pdfContent, original.pdfContent);
      assert.ok(pdfEvidenceSessionDiagnostics().lastRangeBytes < member.bytes / 2);
      parentWork.push(counters);
    }
    assert.equal(
      new Set(childIds).size,
      3,
      'byte-identical occurrences retain separate source identities',
    );
    assert.equal(
      hashFile(getRetainedIntakeOriginalReference(db, root, profileId, packageIntake.id).path),
      packageHash,
    );
    const current = getIntakeRead(db, root, profileId, packageIntake.id);
    assert.equal(
      isIntakeSummary(current) ? current.collections.proposals.total : current.proposals.length,
      0,
    );
    receipt.success = {
      expandedBytes: expanded,
      fixtureGenerationPeakChunkBytes: Math.max(...fixture.members.map((m) => m.peakChunkBytes)),
      inventory: inventory.work,
      selected: selectedWork,
      parent: parentWork,
    };
    writeFileSync('/tmp/crs043-large-qualification.json', JSON.stringify(receipt, null, 2));
  },
);

test(
  'late large-member CRC failure retains original and exposes partial streamed work without publishing a child',
  { timeout: 120_000 },
  async (t) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'fictional-large-corrupt-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const pdfPath = join(root, 'fictional.pdf');
    const failurePdf = writeLargeFictionalPdf(pdfPath, 26 * MIB);
    const path = join(root, 'fictional-corrupt.zip');
    await writeLargeStreamedZip(path, [
      { name: 'fictional.pdf', path: pdfPath, store: true, corruptCRC: true },
    ]);
    const originalHash = hashFile(path);
    const sourceFd = openSync(path, 'r'),
      outputFd = openSync(join(root, 'private-stage'), 'wx', 0o600);
    try {
      await assert.rejects(
        inspectPackageFile({ sourceFd, outputFd, selectedOrdinal: 0 }),
        (error: unknown) => {
          assert.ok(error instanceof PackageInspectionError);
          assert.ok(error.work && error.work.memberReadBytes === failurePdf.bytes);
          assert.ok(error.work.peakChunkBytes <= 256 * 1024);
          receipt.failure = { reasonCode: error.reasonCode, work: error.work };
          return true;
        },
      );
    } finally {
      closeSync(outputFd);
      closeSync(sourceFd);
    }
    const profileId = 'fictional-large-failure';
    const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    attachPersonalDurability(db, { root, profileId });
    try {
      const intake = await uploadIntakeStream(
        db,
        root,
        profileId,
        { filename: 'fictional-corrupt.zip', newProviderName: 'Fictional clinic' },
        createReadStream(path, { highWaterMark: 64 * 1024 }) as unknown as IncomingMessage,
      );
      await assert.rejects(inventoryIntakePackagePaged({ db, root, profileId, id: intake.id }), {
        code: 'PACKAGE_LIMIT',
      });
      assert.equal(db.prepare('SELECT count(*) n FROM source_files').get()!.n, 1);
      assert.equal(
        hashFile(getRetainedIntakeOriginalReference(db, root, profileId, intake.id).path),
        originalHash,
      );
      const current = getIntakeRead(db, root, profileId, intake.id);
      assert.equal(
        isIntakeSummary(current) ? current.collections.proposals.total : current.proposals.length,
        0,
      );
    } finally {
      db.close();
    }
    assert.equal(hashFile(path), originalHash);
    writeFileSync('/tmp/crs043-large-qualification.json', JSON.stringify(receipt, null, 2));
  },
);
