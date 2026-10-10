import { attachPersonalDurability } from '../portable.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { HttpError, openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { getIntakeOriginal, getRetainedIntakeOriginalReference, uploadIntake } from '../intake.ts';
import {
  readIntakeEvidence,
  navigateIntakeEvidence,
  indexIntakeEvidence,
} from '../intake-evidence.ts';
import { readIntakePackageMember } from '../intake-package.ts';
import { INTAKE_PDF_BOUNDS } from '../intake-files.ts';
import { createImportDiagnostics } from '../import-diagnostics.ts';
import {
  disposePdfEvidenceSessions,
  pdfEvidenceSessionDiagnostics,
  readPdfIdentityPageText,
  readPdfEvidencePage,
  indexPdfEvidence,
  pdfPageCountEvidence,
  searchPdfEvidence,
  searchPdfEvidencePage,
} from '../intake-pdf-session.ts';

test('PDF inventory spans bounded worker chunks without losing later pages', async (t) => {
  const f = fixture(t);
  t.after(() => disposePdfEvidenceSessions(f.profileId));
  const bytes = syntheticPdf(Array.from({ length: 65 }, (_, i) => `Fictional page ${i + 1}`));
  const item = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-65-pages.pdf',
    bytes,
  });
  const source = {
    ...getRetainedIntakeOriginalReference(f.db, f.root, f.profileId, item.id),
    profileId: f.profileId,
  };
  assert.equal(await pdfPageCountEvidence(source), 65);
  const index = await indexPdfEvidence(source);
  assert.equal(index.pages, 65);
  assert.equal(index.sections.length, 65);
  assert.equal(index.sections.at(-1)?.locator, 'page 65');
});

test('addressed PDF page search preserves literal search semantics without an offset replay', async (t) => {
  const f = fixture(t);
  t.after(() => disposePdfEvidenceSessions(f.profileId));
  const item = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-search.pdf',
    bytes: syntheticPdf(['Fictional first', 'Fictional middle', 'Fictional MATCH last']),
  });
  const source = {
    ...getRetainedIntakeOriginalReference(f.db, f.root, f.profileId, item.id),
    profileId: f.profileId,
  };
  const selected = await searchPdfEvidencePage(source, 3, 'match');
  const legacy = await searchPdfEvidence(source, 'match', 0);
  assert.deepEqual({ page: selected.page, snippet: selected.snippet }, legacy.results[0]);
  assert.equal(selected.totalPages, 3);
  assert.equal((await searchPdfEvidencePage(source, 1, 'match')).snippet, null);
  await assert.rejects(searchPdfEvidencePage(source, 4, 'match'), { code: 'PDF_PAGE' });
});

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-intake-evidence-'));
  const profileId = 'cookie-dough',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId);
  attachPersonalDurability(db, { root, profileId: profileId });
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, paths, db };
}
function syntheticPdf(
  pages: string[],
  links = false,
  paddingBytes = 0,
  largeLinks?: { count: number; target: string; destination?: boolean },
) {
  const objects = [
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  ];
  for (let i = 0; i < pages.length; i++) {
    const escaped = pages[i]!.replaceAll('\\', '\\\\')
      .replaceAll('(', '\\(')
      .replaceAll(')', '\\)');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${4 + i * 2} 0 R ${
        largeLinks && i === 0
          ? '/Annots [' +
            Array(largeLinks.count)
              .fill(`${3 + pages.length * 2} 0 R`)
              .join(' ') +
            ']'
          : links && i === 0
            ? '/Annots [<< /Type /Annot /Subtype /Link /Rect [0 0 100 100] /Dest [5 0 R /Fit] >> << /Type /Annot /Subtype /Link /Rect [0 0 100 100] /A << /S /URI /URI (https://never.example/file) >> >>]'
            : ''
      } >>`,
    );
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  if (largeLinks) {
    const encoded = Buffer.from(largeLinks.target, 'utf16le').swap16().toString('hex');
    objects.push(
      `<< /Type /Annot /Subtype /Link /Rect [0 0 100 100] ${largeLinks.destination ? `/Dest <feff${encoded}>` : `/A << /S /URI /URI <feff${encoded}> >>`} >>`,
    );
  }
  if (paddingBytes) {
    const stream = '0'.repeat(paddingBytes);
    objects.push(`<< /Length ${paddingBytes} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = '%PDF-1.4\n',
    offsets = [0];
  for (const [index, object] of objects.entries()) {
    if (!index) continue;
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('PDF reference output capacity is located without discarding readable pages', async (t) => {
  const f = fixture(t);
  t.after(() => disposePdfEvidenceSessions(f.profileId));
  const bytes = syntheticPdf(['Fictional reference-heavy page', 'Fictional later page'], false, 0, {
    count: 4000,
    target: 'Fictional ' + '界'.repeat(1800),
    destination: true,
  });
  const item = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-reference-capacity.pdf',
    bytes,
  });
  const source = {
    ...getRetainedIntakeOriginalReference(f.db, f.root, f.profileId, item.id),
    profileId: f.profileId,
  };
  const index = await indexPdfEvidence(source);
  assert.equal(index.pages, 2);
  assert.equal(index.sections.length, 2);
  assert.ok(
    index.references.some(
      (reference) =>
        reference.status === 'capacity_exception' &&
        reference.locator === 'page 1, remaining references',
    ),
    `References: ${index.references.length}; bytes: ${Buffer.byteLength(JSON.stringify(index))}`,
  );
  assert.match((await readPdfEvidencePage(source, 2, 0)).text, /Fictional later page/);
});

// A password-protected PDF, built the smallest honest way: a /Standard security
// handler whose /O and /U hashes cannot match the empty user password, so pdf.js
// raises `PasswordException` with `PasswordResponses.NEED_PASSWORD` — the *number*
// 1 — in `.code`. That number survives the worker's `errorResponse` (it is truthy)
// and `publicWorkerError` passes it verbatim into `new HttpError(422, code, …)`,
// which is how a numeric `HttpError.code` reaches a catch block that expects a
// string. No real credential is present; the bytes below are fixed filler.
function passwordProtectedPdf() {
  const objects = [
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    `<< /Filter /Standard /V 1 /R 2 /O <${'ab'.repeat(16)}> /U <${'cd'.repeat(16)}> /P -1 >>`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    if (!index) continue;
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  const identifier = `<${'01'.repeat(16)}>`;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join(
      '',
    )}trailer\n<< /Size ${objects.length} /Root 1 0 R /Encrypt 5 0 R /ID [${identifier} ${identifier}] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

test('native PDF model evidence carries one selected page while UI and lazy fallback retain raster previews', async (t) => {
  const f = fixture(t);
  t.after(() => disposePdfEvidenceSessions(f.profileId));
  const bytes = syntheticPdf(['Fictional unread first page', 'Fictional selected second page']);
  const item = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-native-pages.pdf',
    newProviderName: 'Fictional clinic',
    bytes,
  });
  const sourcesBefore = f.db.prepare('SELECT count(*) n FROM source_files').get()!.n;
  const result = await readIntakeEvidence({
    ...f,
    id: item.id,
    page: 2,
    modelContext: true,
    pdf: true,
  });
  assert.ok('pdfContent' in result && typeof result.pdfContent === 'string');
  assert.equal('imageContent' in result, false);
  assert.equal(result.metadata.original.page, 2);
  assert.equal(result.metadata.original.totalPages, 2);
  assert.equal(result.metadata.original.nextPage, null);
  assert.equal(result.metadata.original.complete, false);
  assert.match(result.metadata.original.text, /selected second page/);
  assert.equal('render' in result.metadata.original, false);
  assert.ok('document' in result.metadata.original);
  assert.deepEqual(result.metadata.original.document, {
    mimeType: 'application/pdf',
    pages: 1,
    originalPage: 2,
    derivative: true,
  });
  const nativeBytes = Buffer.from(result.pdfContent.split(',')[1]!, 'base64');
  assert.equal(nativeBytes.subarray(0, 5).toString(), '%PDF-');
  const path = resolve(f.root, 'fictional-selected-page.pdf');
  writeFileSync(path, nativeBytes);
  const source = {
    profileId: f.profileId,
    id: 'fictional-native-derived',
    path,
    size: nativeBytes.length,
    sourceHash: createHash('sha256').update(nativeBytes).digest('hex'),
    filename: 'fictional-selected-page.pdf',
  };
  assert.equal((await indexPdfEvidence(source)).pages, 1);
  const text = (await readPdfIdentityPageText(source, 1)).text;
  assert.match(text, /selected second page/);
  assert.doesNotMatch(text, /unread first page/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM source_files').get()!.n, sourcesBefore);
  const fallback = await result.pdfFallback();
  assert.match(fallback.imageContent, /^data:image\/png;base64,/);
  assert.equal(fallback.metadata.original.page, 2);
  assert.equal(fallback.metadata.original.text, result.metadata.original.text);
  assert.equal(fallback.hostTimings.nativePdfFallback, true);
  const ui = await readIntakeEvidence({ ...f, id: item.id, page: 2 });
  assert.ok('imageContent' in ui);
  assert.equal('pdfContent' in ui, false);
  assert.deepEqual(getIntakeOriginal(f.db, f.root, f.profileId, item.id).bytes, bytes);
});

test('unsupported native PDF page extraction explicitly falls back to the same page raster', async (t) => {
  const f = fixture(t);
  t.after(() => disposePdfEvidenceSessions(f.profileId));
  const item = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-native-annotation.pdf',
    newProviderName: 'Fictional clinic',
    bytes: syntheticPdf(['Fictional annotated first page', 'Fictional second page'], true),
  });
  const result = await readIntakeEvidence({
    ...f,
    id: item.id,
    page: 1,
    modelContext: true,
    pdf: true,
  });
  assert.ok('imageContent' in result);
  assert.equal('pdfContent' in result, false);
  assert.ok(result.metadata && 'page' in result.metadata.original);
  assert.equal(result.metadata.original.page, 1);
  assert.equal(result.metadata.original.nextPage, 2);
  assert.match(result.metadata.caution!, /Native PDF input was unavailable/);
  assert.ok('hostTimings' in result && result.hostTimings?.nativePdfFallback);
  assert.ok(
    typeof result.hostTimings.failedNativeReadMs === 'number' &&
      result.hostTimings.failedNativeReadMs >= 0,
  );
  assert.equal('failedNativeReadMs' in result.metadata, false);
});

test('native PDF package evidence and fallback preserve the exact member and selected page', async (t) => {
  const f = fixture(t);
  t.after(() => disposePdfEvidenceSessions(f.profileId));
  const pdf = syntheticPdf(['Fictional unselected member page', 'Fictional selected member page']);
  const bytes = zipFixture([{ name: 'fictional-pages.pdf', data: pdf }]);
  const item = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-native-package.zip',
    newProviderName: 'Fictional clinic',
    bytes,
  });
  const index = await indexIntakeEvidence({ ...f, id: item.id });
  assert.ok('members' in index && index.members?.length === 1);
  const memberId = index.members[0]!.memberId;
  const result = await readIntakePackageMember({
    ...f,
    id: item.id,
    memberId,
    page: 2,
    modelContext: true,
    pdf: true,
  });
  assert.ok('pdfContent' in result && result.pdfContent && result.pdfFallback);
  assert.equal(result.metadata.member.memberId, memberId);
  assert.ok('page' in result.metadata.original);
  assert.equal(result.metadata.original.page, 2);
  assert.equal(result.metadata.original.complete, false);
  assert.ok(typeof result.metadata.original.text === 'string');
  assert.match(result.metadata.original.text, /selected member page/);
  assert.ok('pdfBytes' in result.hostTimings && result.hostTimings.pdfBytes);
  const fallback = await result.pdfFallback();
  assert.match(fallback.imageContent, /^data:image\/png;base64,/);
  assert.equal(fallback.metadata.member.memberId, memberId);
  assert.equal(fallback.metadata.sourceFileId, result.metadata.sourceFileId);
  assert.equal(fallback.metadata.original.page, 2);
  assert.match(fallback.metadata.caution!, /Native PDF input was unavailable/);
});

test('PDF range session reads retained files above the whole-document extraction gate without whole-file buffers', async (t) => {
  const f = fixture(t);
  const previousLimit = process.env.CRS_INTAKE_EXTRACTION_MIB;
  process.env.CRS_INTAKE_EXTRACTION_MIB = '1';
  t.after(async () => {
    if (previousLimit === undefined) delete process.env.CRS_INTAKE_EXTRACTION_MIB;
    else process.env.CRS_INTAKE_EXTRACTION_MIB = previousLimit;
    await disposePdfEvidenceSessions(f.profileId);
  });
  const bytes = syntheticPdf(
    ['Fictional bounded evidence page one', 'Fictional bounded evidence page two'],
    false,
    2 * 1024 * 1024,
  );
  const intake = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-large-range.pdf',
    newProviderName: 'Example clinic',
    bytes,
  });
  assert.throws(
    () => getIntakeOriginal(f.db, f.root, f.profileId, intake.id),
    (error: Error & { code?: string }) => error.code === 'EXTRACTION_LIMIT',
  );
  const before = pdfEvidenceSessionDiagnostics();
  const index = await indexIntakeEvidence({ ...f, id: intake.id });
  const first = await readIntakeEvidence({ ...f, id: intake.id, page: 1 });
  const second = await readIntakeEvidence({ ...f, id: intake.id, page: 2 });
  const firstAgain = await readIntakeEvidence({ ...f, id: intake.id, page: 1 });
  const retained = getRetainedIntakeOriginalReference(f.db, f.root, f.profileId, intake.id);
  const identityText = await readPdfIdentityPageText({ ...retained, profileId: f.profileId }, 1);
  const search = await navigateIntakeEvidence({
    ...f,
    id: intake.id,
    action: 'search',
    query: 'page two',
  });
  const after = pdfEvidenceSessionDiagnostics();
  assert.equal(index.kind, 'pdf');
  assert.equal(index.pages, 2);
  assert.ok('metadata' in first && first.metadata);
  assert.ok('metadata' in second && second.metadata);
  assert.ok('metadata' in firstAgain && firstAgain.metadata);
  assert.ok(first.metadata.original.text);
  assert.ok(second.metadata.original.text);
  assert.match(first.metadata.original.text, /page one/);
  assert.match(second.metadata.original.text, /page two/);
  assert.equal(
    firstAgain.imageContent,
    first.imageContent,
    'reused page evidence retains identical rendering',
  );
  assert.match(identityText.text, /page one/);
  assert.ok('results' in search);
  assert.equal(search.results[0]?.page, 2);
  assert.equal(typeof first.imageContent, 'string');
  assert.ok(first.imageContent);
  assert.ok(
    Buffer.from(first.imageContent.slice('data:image/png;base64,'.length), 'base64').byteLength <=
      INTAKE_PDF_BOUNDS.maxImageBytes,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(index)) <= INTAKE_PDF_BOUNDS.maxIndexOutputBytes);
  assert.ok(INTAKE_PDF_BOUNDS.maxPageOutputBytes <= 112 * 1024 * 1024);
  assert.ok(INTAKE_PDF_BOUNDS.workerOldGenerationMiB <= 384);
  assert.ok(INTAKE_PDF_BOUNDS.openTimeoutMs <= 120_000);
  assert.ok(INTAKE_PDF_BOUNDS.indexTimeoutMs <= 180_000);
  assert.ok(INTAKE_PDF_BOUNDS.pageTimeoutMs <= 90_000);
  assert.equal(after.sessionsCreated - before.sessionsCreated, 1);
  assert.ok(after.sessionsReused - before.sessionsReused >= 4);
  assert.ok(after.lastRangeBytes > 0);
  assert.ok(
    INTAKE_PDF_BOUNDS.maxRangeRequestBytes <= 32 * 1024 * 1024,
    'each parser range allocation stays independently bounded',
  );
  assert.deepEqual(
    readFileSync(retained.path),
    bytes,
    'the complete retained original is unchanged',
  );
});

test('PDF render cache recycling preserves page bytes and original verification across sessions', async (t) => {
  const f = fixture(t);
  t.after(() => disposePdfEvidenceSessions(f.profileId));
  const bytes = syntheticPdf(['Fictional reusable font and page evidence']);
  const intake = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-cache-recycle.pdf',
    newProviderName: 'Example clinic',
    bytes,
  });
  const retained = getRetainedIntakeOriginalReference(f.db, f.root, f.profileId, intake.id);
  const source = { ...retained, profileId: f.profileId };
  const before = pdfEvidenceSessionDiagnostics();
  let first: Uint8Array | null = null;
  for (let read = 0; read <= INTAKE_PDF_BOUNDS.maxRenderedPagesPerSession; read++) {
    const page = await readPdfEvidencePage(source, 1, 0);
    first ||= page.image;
    assert.deepEqual(page.image, first);
    assert.match(page.text, /Fictional reusable font/);
  }
  const after = pdfEvidenceSessionDiagnostics();
  assert.equal(after.sessionsCreated - before.sessionsCreated, 2);
  assert.equal(after.sessionsRecycled - before.sessionsRecycled, 1);
  assert.deepEqual(readFileSync(retained.path), bytes);
});

test('PDF range session detects a changed retained file and disposes parser state', async (t) => {
  const f = fixture(t);
  t.after(() => disposePdfEvidenceSessions(f.profileId));
  const bytes = syntheticPdf(['Fictional immutable evidence']);
  const intake = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-integrity.pdf',
    newProviderName: 'Example clinic',
    bytes,
  });
  await indexIntakeEvidence({ ...f, id: intake.id });
  const retained = getRetainedIntakeOriginalReference(f.db, f.root, f.profileId, intake.id);
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] ^= 1;
  writeFileSync(retained.path, changed);
  await assert.rejects(
    () => readIntakeEvidence({ ...f, id: intake.id }),
    (error: Error & { code?: string }) => error.code === 'SOURCE_CHANGED',
  );
  assert.equal(pdfEvidenceSessionDiagnostics().activeSessions, 0);
});

test('PDF range session releases its worker when reading is cancelled', async (t) => {
  const f = fixture(t);
  t.after(() => disposePdfEvidenceSessions(f.profileId));
  const intake = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-cancelled.pdf',
    newProviderName: 'Example clinic',
    bytes: syntheticPdf(['Fictional cancellation evidence'], false, 2 * 1024 * 1024),
  });
  await assert.rejects(
    () =>
      indexIntakeEvidence({
        ...f,
        id: intake.id,
        assertRunning() {
          throw new Error('fictional read cancelled');
        },
      }),
    /fictional read cancelled/,
  );
  assert.equal(pdfEvidenceSessionDiagnostics().activeSessions, 0);
});

test('profile disposal cancels active and queued PDF work without waiting for the parser', async (t) => {
  const f = fixture(t);
  const intake = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-profile-close.pdf',
    bytes: syntheticPdf(['Fictional profile close evidence'], false, 2 * 1024 * 1024),
  });
  const retained = {
    ...getRetainedIntakeOriginalReference(f.db, f.root, f.profileId, intake.id),
    profileId: f.profileId,
  };
  const running = indexPdfEvidence(retained);
  const queued = indexPdfEvidence(retained);
  const results = Promise.allSettled([running, queued]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await disposePdfEvidenceSessions(f.profileId);
  const settled = await results;
  assert.ok(settled.every((result) => result.status === 'rejected'));
  assert.equal(pdfEvidenceSessionDiagnostics().activeSessions, 0);
  assert.equal(
    (await indexPdfEvidence(retained)).pages,
    1,
    'a newly authorized read starts a new generation',
  );
  await disposePdfEvidenceSessions(f.profileId);
});
function zip(path: string, mode: 'safe' | 'unsafe' | 'many' | 'large' | 'nested') {
  const nested = (depth: number): Buffer =>
    zipFixture([
      {
        name: depth ? 'level-' + depth + '.zip' : 'leaf.txt',
        data: depth ? nested(depth - 1) : 'leaf',
      },
    ]);
  const entries =
    mode === 'safe'
      ? [
          { name: 'folder/report.txt', data: 'Exact ZIP member text' },
          { name: 'image-note.txt', data: 'Second member' },
        ]
      : mode === 'unsafe'
        ? [{ name: '../escape.txt', data: 'must not escape' }]
        : mode === 'many'
          ? Array.from({ length: 301 }, (_, i) => ({
              name: 'f' + String(i).padStart(3, '0') + '.txt',
              data: 'x',
            }))
          : mode === 'large'
            ? [{ name: 'large.bin', data: Buffer.alloc(26 * 1024 * 1024, 'x') }]
            : [{ name: 'level-3.zip', data: nested(2) }];
  writeFileSync(path, zipFixture(entries));
}

test('PDF evidence returns a transient page preview while retaining only the original PDF and embedded files', async (t) => {
  const f = fixture(t),
    bytes = syntheticPdf(['Visible synthetic page', 'Second page'], true);
  const intake = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'synthetic.pdf',
    newProviderName: 'Example clinic',
    bytes,
  });
  const search = await navigateIntakeEvidence({
    ...f,
    id: intake.id,
    action: 'search',
    query: 'Second page',
  });
  assert.ok('results' in search);
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].page, 2);
  assert.equal(typeof search.results[0].snippet, 'string');
  assert.ok(typeof search.results[0].snippet === 'string');
  assert.match(search.results[0].snippet, /Second page/);
  const index = await indexIntakeEvidence({ ...f, id: intake.id });
  assert.ok(index.references);
  const internal = index.references.find((reference) => reference.fragment === 'page=2');
  assert.ok(internal);
  const followed = await navigateIntakeEvidence({
    ...f,
    id: intake.id,
    action: 'follow',
    referenceId: internal.id,
  });
  assert.ok('page' in followed && 'sourceFileId' in followed);
  assert.equal(followed.page, 2);
  assert.equal(followed.sourceFileId, intake.id);
  assert.equal(
    index.references.find((reference) => reference.source.startsWith('https:'))!.status,
    'not_supplied',
  );
  let checkpoints = 0;
  const first = await readIntakeEvidence({
    db: f.db,
    root: f.root,
    profileId: f.profileId,
    id: intake.id,
    page: 1,
    assertRunning() {
      checkpoints++;
    },
  });
  assert.ok(
    'metadata' in first &&
      first.metadata &&
      'assets' in first.metadata.original &&
      'nextPage' in first.metadata.original,
  );
  assert.ok(typeof first.metadata.original.text === 'string');
  assert.ok(typeof first.imageContent === 'string');
  assert.match(first.imageContent, /^data:image\/png;base64,/);
  assert.match(first.metadata.original.text, /Visible synthetic page/);
  assert.equal(first.metadata.original.nextPage, 2);
  assert.equal(first.metadata.original.complete, false);
  assert.equal(first.metadata.original.assets.length, 1);
  const source = first.metadata.original.assets[0]!;
  assert.equal(source.id, intake.id);
  assert.equal(source.derivative, false);
  assert.equal(source.locator, 'page 1');
  assert.equal(source.mimeType, 'application/pdf');
  assert.deepEqual(getIntakeOriginal(f.db, f.root, f.profileId, intake.id).bytes, bytes);
  const modelResult = await readIntakeEvidence({
    db: f.db,
    root: f.root,
    profileId: f.profileId,
    id: intake.id,
    modelContext: true,
  });
  if (!('metadata' in modelResult) || !modelResult.metadata)
    assert.fail('Expected model PDF metadata');
  assert.equal((modelResult.metadata.mappingRules as { section: string }).section, 'mapping_rules');
  assert.ok(Buffer.byteLength(JSON.stringify(modelResult)) < 64 * 1024);
  const repeated = await readIntakeEvidence({
    db: f.db,
    root: f.root,
    profileId: f.profileId,
    id: intake.id,
    page: 1,
  });
  assert.ok('metadata' in repeated && repeated.metadata && 'assets' in repeated.metadata.original);
  assert.equal(repeated.metadata.original.assets[0].id, intake.id);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM source_files WHERE kind='intake_original'").get()!.n,
    1,
    'page previews never become durable source rows',
  );
  assert.ok(checkpoints >= 5, 'long-running decode/render steps remain cancellation-aware');
});

test('ZIP evidence bounds recursive archive expansion to three source levels', async (t) => {
  const f = fixture(t),
    file = resolve(f.root, 'nested.zip');
  zip(file, 'nested');
  const intake = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'nested.zip',
    newProviderName: 'Example clinic',
    bytes: readFileSync(file),
  });
  let current = intake.id;
  for (let level = 1; level <= 3; level++) {
    const result = await readIntakeEvidence({
      db: f.db,
      root: f.root,
      profileId: f.profileId,
      id: current,
    });
    assert.ok('original' in result && result.original && 'members' in result.original);
    assert.equal(result.original.members.length, 1);
    const child = await readIntakePackageMember({
      ...f,
      id: current,
      memberId: result.original.members[0]!.memberId,
    });
    assert.ok(child.sourceFileId);
    current = child.sourceFileId;
  }
  await assert.rejects(
    () => readIntakeEvidence({ db: f.db, root: f.root, profileId: f.profileId, id: current }),
    /Nested archive limit/,
  );
});

test('ZIP evidence retains safe members as scoped child sources without changing the parent original', async (t) => {
  const f = fixture(t),
    file = resolve(f.root, 'safe.zip');
  zip(file, 'safe');
  const bytes = readFileSync(file);
  const intake = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'safe.zip',
    newProviderName: 'Example clinic',
    bytes,
  });
  const result = await readIntakeEvidence({
    db: f.db,
    root: f.root,
    profileId: f.profileId,
    id: intake.id,
  });
  assert.ok('original' in result && result.original && 'members' in result.original);
  assert.equal(result.original.complete, false);
  assert.equal(result.original.members.length, 2);
  const member = result.original.members.find(
    (item) => 'filename' in item && item.filename === 'folder/report.txt',
  );
  assert.ok(member && 'locator' in member);
  assert.equal(member.locator, 'ZIP member folder/report.txt');
  const child = await readIntakePackageMember({ ...f, id: intake.id, memberId: member.memberId });
  assert.ok(child.sourceFileId);
  assert.equal(
    getIntakeOriginal(f.db, f.root, f.profileId, child.sourceFileId).bytes.toString(),
    'Exact ZIP member text',
  );
  assert.deepEqual(getIntakeOriginal(f.db, f.root, f.profileId, intake.id).bytes, bytes);
  const modelResult = await readIntakeEvidence({
    db: f.db,
    root: f.root,
    profileId: f.profileId,
    id: intake.id,
    modelContext: true,
  });
  assert.ok('mappingRules' in modelResult && !Array.isArray(modelResult.mappingRules));
  assert.equal((modelResult.mappingRules as { section: string }).section, 'mapping_rules');
  assert.ok(Buffer.byteLength(JSON.stringify(modelResult)) < 64 * 1024);
  const repeated = await readIntakeEvidence({
    db: f.db,
    root: f.root,
    profileId: f.profileId,
    id: intake.id,
  });
  assert.ok('original' in repeated && repeated.original && 'members' in repeated.original);
  assert.deepEqual(
    repeated.original.members.map((item) => item.memberId),
    result.original.members.map((item) => item.memberId),
  );
});

test('ZIP evidence rejects traversal while retaining the original before creating children', async (t) => {
  const f = fixture(t);
  for (const mode of ['unsafe'] as const) {
    const file = resolve(f.root, `${mode}.zip`);
    zip(file, mode);
    const bytes = readFileSync(file);
    const intake = uploadIntake(f.db, f.root, f.profileId, {
      filename: `${mode}.zip`,
      newProviderName: 'Example clinic',
      bytes,
    });
    const before = f.db
      .prepare("SELECT count(*) n FROM source_files WHERE kind='intake_original'")
      .get()!.n;
    await assert.rejects(
      () => readIntakeEvidence({ db: f.db, root: f.root, profileId: f.profileId, id: intake.id }),
      { code: 'PACKAGE_LIMIT' },
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM source_files WHERE kind='intake_original'").get()!.n,
      before,
      'rejected archives retain no child rows',
    );
    assert.deepEqual(
      getIntakeOriginal(f.db, f.root, f.profileId, intake.id).bytes,
      bytes,
      'the rejected archive itself remains intact',
    );
  }
});

for (const mimeType of ['image/png', 'image/jpeg', 'image/webp'] as const) {
  for (const width of [80, 2000]) {
    test(`${mimeType} intake preserves its visual format and bounds (${width}px)`, async (t) => {
      const { createCanvas, loadImage } = await import('@napi-rs/canvas');
      const f = fixture(t);
      const canvas = createCanvas(width, width / 2);
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#000000';
      context.fillRect(10, 10, 20, 20);
      const bytes =
        mimeType === 'image/png' ? canvas.toBuffer(mimeType) : canvas.toBuffer(mimeType, 100);
      const intake = uploadIntake(f.db, f.root, f.profileId, {
        filename: `fictional-scan.${mimeType.split('/')[1]}`,
        newProviderName: 'Fictional clinic',
        bytes,
      });
      const index = await indexIntakeEvidence({ ...f, id: intake.id });
      assert.equal(index.kind, 'image');
      const evidence = await readIntakeEvidence({ ...f, id: intake.id });
      assert.ok('imageContent' in evidence && typeof evidence.imageContent === 'string');
      assert.ok('metadata' in evidence);
      assert.ok('intake' in evidence.metadata.original);
      assert.equal((evidence.metadata.original.intake as { id: string }).id, intake.id);
      const modelEvidence = await readIntakeEvidence({ ...f, id: intake.id, modelContext: true });
      if (!('metadata' in modelEvidence) || !modelEvidence.metadata)
        assert.fail('Expected model image metadata');
      assert.equal('intake' in modelEvidence.metadata.original, false);
      assert.equal('workflow' in modelEvidence.metadata.intake, false);
      assert.ok(evidence.imageContent.startsWith(`data:${mimeType};base64,`));
      const previewBytes = Buffer.from(evidence.imageContent.split(',')[1], 'base64');
      const preview = await loadImage(previewBytes);
      assert.equal(preview.width, Math.min(width, 1800));
      assert.equal(preview.height, Math.min(width, 1800) / 2);
      if (mimeType === 'image/jpeg')
        assert.equal(previewBytes.subarray(0, 3).toString('hex'), 'ffd8ff');
      if (mimeType === 'image/webp') assert.equal(previewBytes.subarray(8, 12).toString(), 'WEBP');
      assert.deepEqual(getIntakeOriginal(f.db, f.root, f.profileId, intake.id).bytes, bytes);
    });
  }
}

test('image previews strip uploaded ancillary metadata while retaining original bytes', async (t) => {
  const { createCanvas } = await import('@napi-rs/canvas');
  const f = fixture(t);
  const canvas = createCanvas(80, 40);
  canvas.getContext('2d').fillRect(10, 10, 20, 20);
  const original = canvas.toBuffer('image/png');
  const privateMarker = 'Independently fictional private camera metadata';
  const content = Buffer.from(`Comment\0${privateMarker}`);
  const chunk = Buffer.alloc(content.length + 12);
  chunk.writeUInt32BE(content.length);
  chunk.write('tEXt', 4);
  content.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const bytes = Buffer.concat([original.subarray(0, 33), chunk, original.subarray(33)]);
  const intake = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-camera-metadata.png',
    bytes,
  });
  const evidence = await readIntakeEvidence({ ...f, id: intake.id });
  assert.ok('imageContent' in evidence && typeof evidence.imageContent === 'string');
  const preview = Buffer.from(evidence.imageContent.split(',')[1], 'base64');
  assert.equal(preview.includes(Buffer.from(privateMarker)), false);
  assert.deepEqual(getIntakeOriginal(f.db, f.root, f.profileId, intake.id).bytes, bytes);
});

test('indexing a PDF emits bounded index_pdf phase events with no filename or page content', async (t) => {
  const f = fixture(t);
  const bytes = syntheticPdf(['Fictional evidence page one', 'Fictional evidence page two']);
  const intake = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-phase-index.pdf',
    newProviderName: 'Fictional clinic',
    bytes,
  });
  const diagnostics = createImportDiagnostics({ enabled: true });
  t.after(() => diagnostics.close());

  const index = await diagnostics.run({ profileId: f.profileId }, () =>
    indexIntakeEvidence({ ...f, id: intake.id, diagnostics }),
  );

  const events = diagnostics.snapshot(f.profileId);
  const started = events.find((event) => event.event === 'import.phase.started');
  const completed = events.find((event) => event.event === 'import.phase.completed');
  assert.equal(started?.fields.phase, 'index_pdf');
  assert.equal(completed?.fields.phase, 'index_pdf');
  assert.equal(completed?.fields.pages, index.pages);
  assert.equal(typeof completed?.fields.durationMs, 'number');
  assert.doesNotMatch(JSON.stringify(events), /fictional-phase-index|Fictional evidence page/);
});

test('a cancelled PDF index emits a bounded index_pdf phase.failed event instead of completed', async (t) => {
  const f = fixture(t);
  const bytes = syntheticPdf(['Fictional cancelled page one']);
  const intake = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-phase-index-cancel.pdf',
    newProviderName: 'Fictional clinic',
    bytes,
  });
  const diagnostics = createImportDiagnostics({ enabled: true });
  t.after(() => diagnostics.close());
  const assertRunning = () => {
    throw new HttpError(409, 'RUN_CANCELLED', 'This import run was cancelled');
  };

  await assert.rejects(
    diagnostics.run({ profileId: f.profileId }, () =>
      indexIntakeEvidence({ ...f, id: intake.id, diagnostics, assertRunning }),
    ),
    (error: Error & { code?: string }) => error.code === 'RUN_CANCELLED',
  );

  const events = diagnostics.snapshot(f.profileId);
  assert.equal(
    events.some((event) => event.event === 'import.phase.completed'),
    false,
  );
  const failed = events.find((event) => event.event === 'import.phase.failed');
  assert.equal(failed?.fields.phase, 'index_pdf');
  assert.equal(failed?.fields.reasonCode, 'run_cancelled');
  assert.equal(typeof failed?.fields.durationMs, 'number');
  assert.doesNotMatch(JSON.stringify(events), /This import run was cancelled/);
});

test('a password-protected PDF still fails as a clean 422 and records a reasonCode, despite its numeric error code', async (t) => {
  const f = fixture(t);
  t.after(() => disposePdfEvidenceSessions(f.profileId));
  const bytes = passwordProtectedPdf();
  const intake = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-password-protected.pdf',
    newProviderName: 'Fictional clinic',
    bytes,
  });
  const diagnostics = createImportDiagnostics({ enabled: true });
  t.after(() => diagnostics.close());

  // The regression: `HttpError.code` is the number 1 here, so an uncoerced
  // `error.code.toLowerCase()` inside the catch block throws a TypeError and replaces
  // this 422 — and loses the phase event with it.
  await assert.rejects(
    diagnostics.run({ profileId: f.profileId }, () =>
      indexIntakeEvidence({ ...f, id: intake.id, diagnostics }),
    ),
    (error: Error) => {
      assert.equal(
        error instanceof TypeError,
        false,
        'the failure path must not throw a TypeError of its own',
      );
      assert.ok(error instanceof HttpError, 'the caller still sees an HttpError');
      assert.equal(error.status, 422);
      assert.equal(
        error.message,
        'The retained PDF could not be read safely; the unchanged original remains available',
      );
      return true;
    },
  );

  const events = diagnostics.snapshot(f.profileId);
  assert.equal(
    events.some((event) => event.event === 'import.phase.completed'),
    false,
  );
  const failed = events.find((event) => event.event === 'import.phase.failed');
  assert.equal(failed?.fields.phase, 'index_pdf');
  // A non-string code cannot be lowercased and would not survive safeFields() anyway,
  // so it resolves to the shared fallback rather than to nothing at all.
  assert.equal(failed?.fields.reasonCode, 'unexpected_error');
  assert.equal(typeof failed?.fields.durationMs, 'number');
  assert.doesNotMatch(JSON.stringify(events), /fictional-password-protected/);
});
