import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractNativePdfPage } from '../intake-pdf-native.ts';
import { INTAKE_PDF_BOUNDS } from '../intake-files.ts';
import {
  disposePdfEvidenceSessions,
  pdfEvidenceSessionDiagnostics,
  readPdfEvidencePage,
} from '../intake-pdf-session.ts';

function fixture(
  t: TestContext,
  {
    padding = 0,
    oversizedPage = false,
    linked = false,
    attachment = false,
    sharedResources = false,
    pageAttributes = '',
    nestedResourceData = false,
  } = {},
) {
  const directory = mkdtempSync(resolve(tmpdir(), 'circus-fictional-native-pdf-'));
  const path = resolve(directory, 'fictional-original.pdf');
  const fd = openSync(path, 'wx');
  const digest = createHash('sha256');
  let size = 0;
  const offsets = [0];
  const write = (text: string | Buffer) => {
    const bytes = typeof text === 'string' ? Buffer.from(text) : text;
    writeSync(fd, bytes);
    digest.update(bytes);
    size += bytes.byteLength;
  };
  const object = (id: number, content: string | (() => void)) => {
    offsets[id] = size;
    write(`${id} 0 obj\n`);
    if (typeof content === 'string') write(content);
    else content();
    write('\nendobj\n');
  };
  const fill = (count: number) => {
    const chunk = Buffer.alloc(256 * 1024, 'x');
    while (count) {
      const part = chunk.subarray(0, Math.min(count, chunk.length));
      write(part);
      count -= part.byteLength;
    }
  };
  write('%PDF-1.4\n');
  object(
    1,
    `<< /Type /Catalog /Pages 2 0 R ${attachment ? '/Names << /EmbeddedFiles << /Names [(fictional-note.txt) 9 0 R] >> >>' : ''} >>`,
  );
  object(2, '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>');
  for (let page = 1; page <= 2; page++) {
    const id = page === 1 ? 3 : 5;
    object(
      id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> ${sharedResources || nestedResourceData ? '/XObject << /OtherPageOnly 10 0 R >>' : ''} >> /Contents ${id + 1} 0 R ${page === 1 && linked ? '/Annots [<< /Type /Annot /Subtype /Link /Rect [0 0 100 100] /Dest [5 0 R /Fit] >>]' : ''} ${page === 1 ? pageAttributes : ''} >>`,
    );
    const text = `q 0.1 0.5 0.8 rg 30 540 250 90 re f Q\nBT /F1 12 Tf 30 720 Td (Fictional ${page === 1 ? 'FIRST' : 'SECOND'} page marker) Tj ET\n${(sharedResources || nestedResourceData) && page === 1 ? '/OtherPageOnly Do\n' : ''}`;
    const commentBytes =
      page === 1 && oversizedPage ? INTAKE_PDF_BOUNDS.maxNativePdfBytes + 1024 : 0;
    object(id + 1, () => {
      write(
        `<< /Length ${Buffer.byteLength(text) + (commentBytes ? commentBytes + 2 : 0)} >>\nstream\n${text}`,
      );
      if (commentBytes) {
        write('%');
        fill(commentBytes);
        write('\n');
      }
      write('endstream');
    });
  }
  object(7, () => {
    write(`<< /Length ${padding} >>\nstream\n`);
    fill(padding);
    write('\nendstream');
  });
  const secret = 'Fictional attachment-only marker absent from selected native PDF';
  object(8, `<< /Type /EmbeddedFile /Length ${secret.length} >>\nstream\n${secret}\nendstream`);
  object(9, '<< /Type /Filespec /F (fictional-note.txt) /EF << /F 8 0 R >> >>');
  if (sharedResources || nestedResourceData) {
    const content =
      'BT /F1 12 Tf 30 500 Td (FICTIONAL_OTHER_PAGE_SHARED_RESOURCE_SENTINEL) Tj ET\n';
    object(
      10,
      `<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica ${nestedResourceData ? '/Metadata 8 0 R /PieceInfo << /Fictional << /LastModified (D:20260101000000Z) /Private 6 0 R >> >>' : ''} >> >> >> ${nestedResourceData ? '/Metadata 8 0 R /AF [9 0 R] /PieceInfo << /Fictional << /LastModified (D:20260101000000Z) /Private 6 0 R >> >> /AA << /O << /S /JavaScript /JS (FICTIONAL_RESOURCE_ACTION) >> >>' : ''} /Length ${content.length} >>\nstream\n${content}endstream`,
    );
  }
  const xref = size;
  write(
    `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
  closeSync(fd);
  const source = {
    profileId: 'fictional-native-profile',
    id: directory,
    path,
    size,
    sourceHash: digest.digest('hex'),
    filename: 'fictional-original.pdf',
  };
  t.after(async () => {
    await disposePdfEvidenceSessions(source.profileId);
    rmSync(directory, { recursive: true, force: true });
  });
  return { source, directory, secret };
}

async function inspect(pdf: Uint8Array) {
  const task = getDocument({
    data: Uint8Array.from(pdf),
    useSystemFonts: false,
    standardFontDataUrl: fileURLToPath(
      new URL('../../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url),
    ),
  });
  const document = await task.promise;
  try {
    const page = await document.getPage(1);
    const text = (await page.getTextContent()).items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    return {
      pages: document.numPages,
      text,
      attachments: await document.getAttachments(),
      annotations: await page.getAnnotations(),
    };
  } finally {
    await task.destroy();
  }
}

test('native PDF evidence contains exactly the selected original page with native text and separate attachments', async (t) => {
  const { source, secret } = fixture(t, { attachment: true });
  const result = await readPdfEvidencePage(source, 2, 0, undefined, { format: 'pdf' });
  assert.equal(result.mimeType, 'application/pdf');
  assert.equal(result.totalPages, 2);
  assert.equal(result.nextPage, null);
  assert.match(result.text, /SECOND/);
  assert.equal('image' in result, false);
  assert.equal('renderMs' in result.timings, false);
  assert.ok(result.timings.nativePdfMs >= 0);
  assert.ok(result.pdf.byteLength <= INTAKE_PDF_BOUNDS.maxNativePdfBytes);
  const extracted = await inspect(result.pdf);
  assert.equal(extracted.pages, 1);
  assert.match(extracted.text, /SECOND/);
  assert.doesNotMatch(extracted.text, /FIRST/);
  assert.equal(extracted.attachments, null);
  assert.deepEqual(extracted.annotations, []);
  assert.equal(Buffer.from(result.pdf).includes(Buffer.from(secret)), false);
  assert.equal(result.embedded.length, 1);
  assert.equal(Buffer.from(result.embedded[0]!.bytes).toString(), secret);
  assert.equal(
    createHash('sha256').update(readFileSync(source.path)).digest('hex'),
    source.sourceHash,
  );
});

test('native rendering graph removes nested resource metadata, private data, associated files and actions', async (t) => {
  const { source, secret } = fixture(t, { nestedResourceData: true });
  const native = await readPdfEvidencePage(source, 1, 0, undefined, { format: 'pdf' });
  const serialized = Buffer.from(native.pdf).toString('latin1');
  assert.equal(serialized.includes(secret), false);
  assert.doesNotMatch(
    serialized,
    /Fictional SECOND page marker|FICTIONAL_RESOURCE_ACTION|\/Metadata|\/PieceInfo|\/AF\b|\/AA\b/,
  );
  assert.match((await inspect(native.pdf)).text, /FIRST/);
});

for (const pageAttributes of [
  '/Group << /S /Transparency /CS /DeviceRGB >>',
  '/StructParents 0',
  '/Annots []',
])
  test(`ordinary page attribute ${pageAttributes.split(' ')[0]} remains native`, async (t) => {
    const { source } = fixture(t, { pageAttributes });
    const native = await readPdfEvidencePage(source, 1, 0, undefined, { format: 'pdf' });
    assert.equal(native.mimeType, 'application/pdf');
    assert.match((await inspect(native.pdf)).text, /FIRST/);
  });

test('native incompatibility keeps a verified session available for same-page raster fallback and later reads', async (t) => {
  const { source } = fixture(t, { linked: true });
  const before = pdfEvidenceSessionDiagnostics().sessionsCreated;
  await assert.rejects(readPdfEvidencePage(source, 1, 0, undefined, { format: 'pdf' }), {
    code: 'PDF_NATIVE_UNSUPPORTED',
  });
  await readPdfEvidencePage(source, 1, 0);
  await readPdfEvidencePage(source, 2, 0, undefined, { format: 'pdf' });
  assert.equal(pdfEvidenceSessionDiagnostics().sessionsCreated - before, 1);
});

test('source mutation after native incompatibility remains fatal and retires the session', async (t) => {
  const { source } = fixture(t, { linked: true });
  await assert.rejects(readPdfEvidencePage(source, 1, 0, undefined, { format: 'pdf' }), {
    code: 'PDF_NATIVE_UNSUPPORTED',
  });
  writeFileSync(source.path, Buffer.alloc(source.size, 'x'));
  await assert.rejects(readPdfEvidencePage(source, 1, 0), { code: 'SOURCE_CHANGED' });
  assert.equal(pdfEvidenceSessionDiagnostics().activeSessions, 0);
});

test('native extraction reads a large retained source through the verified descriptor without whole-file Node reads', async (t) => {
  const { source } = fixture(t, { padding: 72 * 1024 * 1024 });
  const result = await readPdfEvidencePage(source, 2, 0, undefined, { format: 'pdf' });
  assert.ok(source.size > 64 * 1024 * 1024);
  assert.ok(result.pdf.byteLength < 10_000);
  assert.ok(pdfEvidenceSessionDiagnostics().lastRangeBytes < source.size / 2);
  assert.match((await inspect(result.pdf)).text, /SECOND/);
});

test('native selected page preserves text and vector pixels with the same rendering settings', async (t) => {
  const { source, directory } = fixture(t);
  const native = await readPdfEvidencePage(source, 2, 0, undefined, { format: 'pdf' });
  const originalRender = await readPdfEvidencePage(source, 2, 0);
  const path = resolve(directory, 'fictional-selected-page.pdf');
  writeFileSync(path, native.pdf);
  const derivative = {
    ...source,
    id: `${source.id}-selected-page`,
    path,
    size: native.pdf.byteLength,
    sourceHash: createHash('sha256').update(native.pdf).digest('hex'),
  };
  const nativeRender = await readPdfEvidencePage(derivative, 1, 0);
  assert.equal(nativeRender.width, originalRender.width);
  assert.equal(nativeRender.height, originalRender.height);
  assert.deepEqual(nativeRender.image, originalRender.image);
});

test('native isolation prunes unused shared resources belonging to an unselected page', async (t) => {
  const { source } = fixture(t, { sharedResources: true });
  const native = await readPdfEvidencePage(source, 2, 0, undefined, { format: 'pdf' });
  assert.equal(
    Buffer.from(native.pdf).includes(Buffer.from('FICTIONAL_OTHER_PAGE_SHARED_RESOURCE_SENTINEL')),
    false,
  );
  assert.match((await inspect(native.pdf)).text, /SECOND/);
});

for (const pageAttributes of [
  '/AA << /O << /S /JavaScript /JS (FICTIONAL_PAGE_ACTION) >> >>',
  '/Metadata 8 0 R',
  '/PieceInfo << /Fictional << /Private 5 0 R >> >>',
  '/B [5 0 R]',
])
  test(`native isolation strips non-rendering page graph ${pageAttributes.split(' ')[0]}`, async (t) => {
    const { source } = fixture(t, { pageAttributes });
    const native = await readPdfEvidencePage(source, 1, 0, undefined, { format: 'pdf' });
    assert.match((await inspect(native.pdf)).text, /FIRST/);
    assert.doesNotMatch(
      Buffer.from(native.pdf).toString('latin1'),
      /FICTIONAL_PAGE_ACTION|Fictional SECOND page marker|\/Metadata|\/PieceInfo|\/AA\b|\/B\b/,
    );
  });

test('native extraction uses the inherited open file even if its pathname is replaced', async (t) => {
  const { source, directory } = fixture(t);
  const fd = openSync(source.path, 'r');
  t.after(() => closeSync(fd));
  renameSync(source.path, resolve(directory, 'retained-open.pdf'));
  writeFileSync(source.path, 'Fictional replacement is not the verified original');
  const pdf = await extractNativePdfPage(fd, 2);
  assert.match((await inspect(pdf)).text, /SECOND/);
});

test('native page isolation rejects annotation links to another page, leaving explicit image fallback available', async (t) => {
  const { source } = fixture(t, { linked: true });
  await assert.rejects(readPdfEvidencePage(source, 1, 0, undefined, { format: 'pdf' }), {
    code: 'PDF_NATIVE_UNSUPPORTED',
  });
  const image = await readPdfEvidencePage(source, 1, 0);
  assert.equal(image.mimeType, 'image/png');
  assert.match(image.text, /FIRST/);
});

test('native page output is capped before IPC and an oversized page remains available as an image', async (t) => {
  const { source } = fixture(t, { oversizedPage: true });
  await assert.rejects(readPdfEvidencePage(source, 1, 0, undefined, { format: 'pdf' }), {
    code: 'PDF_NATIVE_PAGE_LIMIT',
  });
  const image = await readPdfEvidencePage(source, 1, 0);
  assert.equal(image.mimeType, 'image/png');
  assert.match(image.text, /FIRST/);
});

test(
  'disposing a PDF session terminates its running native subprocess group',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { source, directory } = fixture(t);
    const pidPath = resolve(directory, 'fictional-qpdf.pid');
    const fixtureDirectory = fileURLToPath(
      new URL('./fixtures/native-cancellation/', import.meta.url),
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${fixtureDirectory}:${directory}:${previousPath || ''}`;
    let nativePids: number[] = [];
    t.after(() => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      for (const nativePid of nativePids) {
        try {
          process.kill(nativePid, 'SIGKILL');
        } catch {
          /* Already disposed. */
        }
      }
    });
    const read = readPdfEvidencePage(source, 1, 0, undefined, { format: 'pdf' });
    const rejection = assert.rejects(read, { code: 'PDF_EVIDENCE_CANCELLED' });
    const started = Date.now();
    while (Date.now() - started < 10_000) {
      const candidates = existsSync(pidPath)
        ? readFileSync(pidPath, 'utf8').trim().split(' ').map(Number)
        : [];
      if (
        candidates.length === 2 &&
        candidates.every((pid) => Number.isSafeInteger(pid) && pid > 1)
      ) {
        nativePids = candidates;
        break;
      }
      await delay(10);
    }
    assert.equal(nativePids.length, 2, 'native subprocess published its own and its child PID');
    await disposePdfEvidenceSessions(source.profileId);
    await rejection;
    const alive = (nativePid: number) => {
      if (process.platform === 'linux') {
        // The slim runtime intentionally has no `ps`. Read the kernel's process
        // state directly and treat a killed, not-yet-reaped zombie as stopped.
        try {
          const stat = readFileSync(`/proc/${nativePid}/stat`, 'utf8');
          const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
          assert.match(state, /^[A-Z]$/, 'kernel process state is present');
          return state !== 'Z' && state !== 'X';
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
            return false;
          throw error;
        }
      }
      const status = spawnSync('ps', ['-p', String(nativePid), '-o', 'stat='], {
        encoding: 'utf8',
      });
      assert.ifError(status.error);
      assert.ok(status.status === 0 || status.status === 1, 'process status lookup succeeded');
      const state = status.stdout.trim();
      // SIGKILL terminates execution immediately, but init may reap an orphan
      // later under load. kill(pid, 0) incorrectly calls that zombie "alive".
      return !!state && !state.startsWith('Z');
    };
    const disposed = Date.now();
    while (nativePids.some(alive) && Date.now() - disposed < 2_000) await delay(10);
    assert.equal(
      nativePids.some(alive),
      false,
      'worker disposal must terminate the native process group',
    );
  },
);

for (const reason of ['cancel', 'timeout', 'size'] as const)
  test(`native extraction terminates its process on ${reason} without returning partial bytes`, async (t) => {
    const { source } = fixture(t);
    const fd = openSync(source.path, 'r');
    t.after(() => closeSync(fd));
    const controller = new AbortController();
    let child: ChildProcess | undefined;
    const promise = extractNativePdfPage(fd, 1, {
      signal: controller.signal,
      timeoutMs: reason === 'timeout' ? 20 : 10_000,
      maxBytes: reason === 'size' ? 32 : INTAKE_PDF_BOUNDS.maxNativePdfBytes,
      spawnProcess: (_command, _args, options) => {
        child = spawn(
          process.execPath,
          [
            '-e',
            reason === 'size'
              ? 'process.stdout.write(Buffer.alloc(1024)); setInterval(()=>{},1000)'
              : 'setInterval(()=>{},1000)',
          ],
          options,
        );
        return child;
      },
    });
    const closed = once(child!, 'close');
    if (reason === 'cancel') controller.abort();
    await assert.rejects(promise, {
      code:
        reason === 'cancel'
          ? 'PDF_EVIDENCE_CANCELLED'
          : reason === 'size'
            ? 'PDF_NATIVE_PAGE_LIMIT'
            : 'PDF_NATIVE_UNSUPPORTED',
    });
    await closed;
    assert.equal(child!.signalCode, 'SIGKILL');
  });
