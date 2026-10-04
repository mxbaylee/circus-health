import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';
import { checkIntakeSourceAncestry } from '../intake-source-ancestry.ts';
import {
  uploadIntake,
  retainIntakeChildren,
  ensureNativeIntakeSchema,
  getIntakeRead,
  getIntakeOriginal,
} from '../intake.ts';
import { isIntakeSummary } from '../../shared/intake-summary.ts';
import { inventoryIntakePackagePaged, readIntakePackageMember } from '../intake-package.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import { readIntakeEvidence } from '../intake-evidence.ts';
import { disposePdfEvidenceSessions } from '../intake-pdf-session.ts';
import { clearPackageSourceSession } from '../intake-package-session.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-children-')),
    profileId = 'cookie-dough',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  t.after(async () => {
    clearPackageSourceSession(db);
    await disposePdfEvidenceSessions(profileId);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, db };
}

test('checked ancestry traverses deep chains cooperatively and refuses cycles, missing sources and foreign profiles', async (t) => {
  const f = fixture(t);
  const register = (id: string, parent?: string) =>
    registerRawIntakeFixture(
      f.db,
      id,
      JSON.stringify({ intake: { version: 1, originalName: id, parentSourceFileId: parent } }),
    );
  transaction(f.db, () => {
    for (let i = 0; i < 140; i++)
      register('fictional-' + i, i ? 'fictional-' + (i - 1) : undefined);
    register('cycle-a', 'cycle-b');
    register('cycle-b', 'cycle-c');
    register('cycle-c', 'cycle-b');
    register('missing-parent', 'missing');
  });
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  assert.equal(await checkIntakeSourceAncestry(f.db, f.profileId, 'fictional-139'), true);
  assert.equal(yielded, true);
  assert.equal(
    await checkIntakeSourceAncestry(f.db, f.profileId, 'fictional-139', { stopAt: 'fictional-50' }),
    true,
  );
  assert.equal(
    await checkIntakeSourceAncestry(f.db, f.profileId, 'fictional-139', { stopAt: 'other' }),
    false,
  );
  await assert.rejects(checkIntakeSourceAncestry(f.db, f.profileId, 'cycle-a'), {
    code: 'SOURCE_ANCESTRY',
  });
  await assert.rejects(
    checkIntakeSourceAncestry(f.db, f.profileId, 'missing-parent'),
    /Source intake not found/,
  );
  await assert.rejects(
    checkIntakeSourceAncestry(f.db, f.profileId, 'missing', { stopAt: 'missing' }),
    /Source intake not found/,
  );
  await assert.rejects(checkIntakeSourceAncestry(f.db, 'foreign', 'fictional-139'), {
    code: 'PROFILE_BOUNDARY',
  });
  let cancelled = false;
  setImmediate(() => {
    cancelled = true;
  });
  await assert.rejects(
    checkIntakeSourceAncestry(f.db, f.profileId, 'fictional-139', {
      assertRunning() {
        if (cancelled) throw Error('fictional cancellation');
      },
    }),
    /fictional cancellation/,
  );
});

test('native nested inventory beyond three source levels retains selected child native authority', async (t) => {
  const f = fixture(t),
    bytes = zipFixture([{ name: 'fictional.txt', data: 'Exact fictional nested evidence' }]);
  const original = uploadIntake(f.db, f.root, f.profileId, { filename: 'fictional.zip', bytes });
  let id = original.id;
  for (let depth = 0; depth < 6; depth++)
    id = retainIntakeChildren(f.db, f.root, f.profileId, id, [
      { filename: 'fictional.zip', locator: 'embedded fictional ZIP', bytes },
    ])[0]!.id;
  await ensureNativeIntakeSchema(f.db, f.profileId, id);
  const page = await inventoryIntakePackagePaged({ ...f, id });
  assert.equal(page.totalMembers, 1);
  const read = await readIntakePackageMember({
    ...f,
    id,
    memberId: page.members[0]!.memberId,
  });
  assert.ok('sourceFileId' in read && read.sourceFileId);
  assert.equal(isIntakeSummary(getIntakeRead(f.db, f.root, f.profileId, read.sourceFileId)), true);
  assert.equal(
    getIntakeOriginal(f.db, f.root, f.profileId, read.sourceFileId).bytes.toString(),
    'Exact fictional nested evidence',
  );
});

function attachedPdf() {
  const attachment = 'Exact fictional embedded original';
  const content = 'BT /F1 12 Tf 30 100 Td (Fictional page) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(fictional.txt) 6 0 R] >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    `<< /Type /EmbeddedFile /Length ${attachment.length} >>\nstream\n${attachment}\nendstream`,
    '<< /Type /Filespec /F (fictional.txt) /EF << /F 5 0 R >> >>',
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { bytes: Buffer.from(text), attachment };
}

test('native PDF and raster evidence return already native embedded originals, including reused attachments', async (t) => {
  const f = fixture(t),
    pdf = attachedPdf();
  const original = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional.pdf',
    bytes: pdf.bytes,
  });
  await ensureNativeIntakeSchema(f.db, f.profileId, original.id);
  let childId: string | undefined;
  for (const native of [true, false, true]) {
    const read = await readIntakeEvidence({
      ...f,
      id: original.id,
      page: 1,
      pdf: native,
    });
    assert.ok('metadata' in read && read.metadata && 'assets' in read.metadata.original);
    const assets = read.metadata.original.assets;
    assert.equal(assets.length, 2);
    const child = assets.find((asset) => asset.id !== original.id)!;
    if (childId) assert.equal(child.id, childId);
    childId = child.id;
    assert.equal(isIntakeSummary(getIntakeRead(f.db, f.root, f.profileId, child.id)), true);
    assert.equal(
      getIntakeOriginal(f.db, f.root, f.profileId, child.id).bytes.toString(),
      pdf.attachment,
    );
  }
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM source_files WHERE kind='intake_original'").get()!.n,
    2,
  );
});
