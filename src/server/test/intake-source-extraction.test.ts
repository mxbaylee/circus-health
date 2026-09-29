import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachRecordDurability, type RecordStorage } from '../record-versions.ts';
import {
  uploadIntake,
  getIntakeOriginal,
  getRetainedIntakeOriginalReference,
  retainIntakeChildren,
} from '../intake.ts';
import { readIntakeEvidence } from '../intake-evidence.ts';
import { isRetainOnlyIntake } from '../intake-source-policy.ts';
import { inventoryIntakePackage, readIntakePackageMember } from '../intake-package.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import { extractIntakeSourceText, runSourceRasterWorker } from '../intake-source-extraction.ts';
import {
  composeSourceReadings,
  parseSourceOcrTsv,
  sourceRasterDimensions,
} from '../intake-source-ocr.ts';
import { disposePdfEvidenceSessions, readPdfEvidencePage } from '../intake-pdf-session.ts';
import { reviewIntakeSourceText, getIntakeSourceText } from '../intake-source-text.ts';

const tsv =
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n';

test('model reads capture retained child text in bounded steps before metadata and preserve human corrections', async (t) => {
  const f = fixture(t);
  const parent = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-container.txt',
    bytes: Buffer.from('Fictional container'),
  });
  const original = 'Fictional literal child 1.00 mg. '.repeat(1800);
  const [child] = retainIntakeChildren(f.db, f.root, f.profileId, parent.id, [
    {
      filename: 'member.txt',
      locator: 'Fictional member',
      bytes: Buffer.from(original),
    },
  ]);
  await readIntakeEvidence({ ...f, id: child.id });
  assert.equal(getIntakeSourceText(f.db, f.root, f.profileId, child.id).status, 'unavailable');
  await readIntakeEvidence({ ...f, id: child.id, modelContext: true, captureSourceText: false });
  assert.equal(getIntakeSourceText(f.db, f.root, f.profileId, child.id).status, 'unavailable');
  const first = await readIntakeEvidence({ ...f, id: child.id, modelContext: true });
  const firstRevision = getIntakeSourceText(f.db, f.root, f.profileId, child.id).revision!;
  assert.equal(firstRevision.pages.length, 3);
  assert.ok(firstRevision.issues.some((i) => i.id === 'p3-pending'));
  assert.ok('sourceText' in first);
  assert.equal(first.sourceText.revisionId, firstRevision.id);
  const reviewed = reviewIntakeSourceText(
    f.db,
    f.root,
    f.profileId,
    child.id,
    {
      operationId: randomUUID(),
      expectedRevisionId: firstRevision.id,
      sourceHash: firstRevision.sourceHash,
      action: 'correct',
      scope: { page: 1 },
      spans: [
        {
          id: 'human-child-correction',
          text: 'Fictional corrected dose 1.01 mg.',
          region: { page: 1 },
          provenance: 'human',
        },
      ],
    },
    'fictional-owner',
  );
  await readIntakeEvidence({ ...f, id: child.id, modelContext: true });
  const completed = getIntakeSourceText(f.db, f.root, f.profileId, child.id).revision!;
  assert.ok(!completed.issues.some((i) => i.id === 'p3-pending'));
  assert.deepEqual(
    completed.spans.filter((s) => s.region.page === 1),
    reviewed.revision!.spans.filter((s) => s.region.page === 1),
  );
  await readIntakeEvidence({ ...f, id: child.id, modelContext: true });
  assert.equal(getIntakeSourceText(f.db, f.root, f.profileId, child.id).revision!.id, completed.id);
  assert.equal(getIntakeOriginal(f.db, f.root, f.profileId, child.id).bytes.toString(), original);
});
function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'source-extract-test-')),
    profileId = 'fictional-iris';
  const paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId);
  const objects = new Map<string, Buffer>();
  const storage: RecordStorage = {
    read: (name) => objects.get(name) || null,
    writeImmutable: (name, value) => {
      assert.ok(!objects.has(name));
      objects.set(name, Buffer.from(value));
    },
    publishHead: (value) => objects.set('head', Buffer.from(value)),
  };
  attachRecordDurability(db, { profileId, storage });
  t.after(async () => {
    await disposePdfEvidenceSessions();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, db, profileId };
}
function pdf(rotate = 0) {
  const body = 'BT /F1 12 Tf 72 720 Td (Fictional Rowan: no fever. Dose 1.00 mg.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate ${rotate} /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let text = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(text.length);
    text += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const start = text.length;
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(text, 'latin1');
}
test('native/OCR composition preserves repeated literal occurrences, disagreements and explicit structural uncertainty', () => {
  const words = parseSourceOcrTsv(
    tsv + '5\t1\t1\t1\t1\t1\t10\t10\t20\t10\t95\t1.00\n5\t1\t1\t1\t1\t2\t10\t60\t20\t10\t25\tno\n',
    1,
    100,
    100,
  );
  const result = composeSourceReadings(
    1,
    [
      { text: '1.0', x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
      { text: '1.0', x: 0.5, y: 0.1, width: 0.2, height: 0.1 },
    ],
    words,
  );
  assert.equal(result.spans.filter((s) => s.text === '1.0').length, 2);
  assert.equal(result.spans.find((s) => s.text === '1.0')?.alternatives?.[0].text, '1.00');
  assert.equal(result.spans.find((s) => s.text === 'no')?.confidence, 0.25);
  for (const kind of ['confidence', 'disagreement', 'structure', 'coverage'])
    assert.ok(result.issues.some((i) => i.kind === kind));
  assert.throws(
    () => parseSourceOcrTsv(tsv + '5\t1\t1\t1\t1\t1\t-1\t10\t20\t10\t95\tword', 1, 100, 100),
    /INVALID/,
  );
});
test('bounded local raster worker records supplied OCR, uncovered ink and no automatic reviewed state', async (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), 'source-ocr-command-'));
  const old = process.env.PATH;
  t.after(() => {
    process.env.PATH = old;
    rmSync(dir, { recursive: true, force: true });
  });
  const executable = resolve(dir, 'tesseract');
  writeFileSync(
    executable,
    `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${tsv}5\t1\t1\t1\t1\t1\t5\t5\t20\t10\t95\tFictional\n'\n`,
  );
  chmodSync(executable, 0o700);
  process.env.PATH = dir + ':' + old;
  const canvas = createCanvas(100, 100),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 100, 100);
  ctx.fillStyle = 'black';
  ctx.fillRect(60, 60, 25, 25);
  const result = await runSourceRasterWorker(canvas.toBuffer('image/png'), 1, []);
  assert.equal(result.ocrAvailable, true);
  assert.equal(result.spans[0].text, 'Fictional');
  assert.ok(result.issues.some((i) => i.id.startsWith('p1-ink-')));
  assert.ok(result.issues.every((i) => i.status === 'open'));
});
test('text extraction resumes bounded windows and preserves exact punctuation, unknown fields and source bytes', async (t) => {
  const f = fixture(t),
    text = '{"unknown":"' + 'Fictional 1.00 no fever; '.repeat(2200) + '"}';
  const intake = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'source.json',
    bytes: Buffer.from(text),
    newProviderName: 'Fictional Source',
  });
  const first = await extractIntakeSourceText({ ...f, id: intake.id, maxPages: 1 });
  assert.equal(first.processedPages, 1);
  assert.equal(first.morePending, true);
  const saved = first.sourceText.revision!.spans[0].text;
  let final = first;
  while (final.morePending)
    final = await extractIntakeSourceText({ ...f, id: intake.id, maxPages: 1 });
  assert.equal(final.sourceText.revision!.spans.map((s) => s.text).join(''), text);
  assert.equal(final.sourceText.revision!.spans[0].text, saved);
  assert.equal(final.sourceText.summary!.inspectedPages, 0);
  assert.deepEqual(
    getIntakeOriginal(f.db, f.root, f.profileId, intake.id).bytes,
    Buffer.from(text),
  );
  const repeated = await extractIntakeSourceText({ ...f, id: intake.id });
  assert.equal(repeated.processedPages, 0);
  assert.equal(repeated.sourceText.revision!.id, final.sourceText.revision!.id);
});
test('PDF native geometry is durable before unavailable OCR, and no text completeness is claimed', async (t) => {
  const f = fixture(t),
    original = pdf();
  const intake = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional.pdf',
    bytes: original,
    newProviderName: 'Fictional Source',
  });
  const old = process.env.PATH;
  process.env.PATH = '/nonexistent';
  t.after(() => {
    process.env.PATH = old;
  });
  const result = await extractIntakeSourceText({ ...f, id: intake.id });
  assert.equal(result.morePending, false);
  const revision = result.sourceText.revision!;
  assert.ok(revision.spans.some((s) => s.text.includes('Dose 1.00 mg.')));
  const box = revision.spans[0].region.box!;
  assert.ok(box[0] > 0 && box[1] > 0 && box[2] > 0 && box[3] > 0);
  assert.ok(revision.issues.some((i) => i.kind === 'unsupported'));
  assert.equal(revision.pages[0].disposition, 'partial');
  assert.equal(revision.pages[0].inspected, false);
  assert.deepEqual(getIntakeOriginal(f.db, f.root, f.profileId, intake.id).bytes, original);
});
test('retain-only and unsupported inputs never enter an OCR or clinical fallback', async (t) => {
  const f = fixture(t);
  for (const [filename, bytes] of [
    ['scan.dcm', Buffer.from('pretend text')],
    ['unsupported.bin', Buffer.from([255, 0, 254])],
  ] as const) {
    const intake = uploadIntake(f.db, f.root, f.profileId, {
      filename,
      bytes,
      newProviderName: 'Fictional Source',
    });
    const result = await extractIntakeSourceText({ ...f, id: intake.id });
    assert.equal(result.morePending, false);
    assert.equal(result.sourceText.revision!.spans.length, 0);
    assert.equal(result.sourceText.revision!.pages[0].disposition, 'unsupported');
    if (filename === 'scan.dcm') {
      await assert.rejects(readIntakeEvidence({ ...f, id: intake.id, modelContext: true }), {
        code: 'INTAKE_RETAIN_ONLY',
      });
      assert.deepEqual(getIntakeOriginal(f.db, f.root, f.profileId, intake.id).bytes, bytes);
    }
  }
});

test('retain-only routing uses recognized media types and conservative unknown-format filename hints', () => {
  for (const mimeType of ['audio/wav', 'video/mp4', 'application/dicom'])
    assert.equal(isRetainOnlyIntake({ filename: 'fictional.txt', mimeType }), true);
  for (const filename of ['fictional.DCM', 'fictional.mp3', 'fictional.webm'])
    assert.equal(isRetainOnlyIntake({ filename, mimeType: 'application/octet-stream' }), true);
  for (const mimeType of ['application/pdf', 'image/png', 'application/json', 'application/zip'])
    assert.equal(isRetainOnlyIntake({ filename: 'misleading.dcm', mimeType }), false);
  assert.equal(isRetainOnlyIntake({ filename: 'fictional.txt', mimeType: 'text/plain' }), false);
});

test('JSON-looking retain-only members cannot bypass the host policy through structural navigation', async (t) => {
  const f = fixture(t),
    literal = '{"fictional":"retained audio-sidecar-like bytes"}';
  const parent = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-media-package.zip',
    bytes: zipFixture([{ name: 'fictional.wav', data: literal }]),
  });
  const inventory = await inventoryIntakePackage({ ...f, id: parent.id });
  await assert.rejects(
    readIntakePackageMember({
      ...f,
      id: parent.id,
      memberId: inventory.members[0]!.memberId,
      jsonPointer: '',
      modelContext: true,
    }),
    { code: 'INTAKE_RETAIN_ONLY' },
  );
  const childId = String(
    f.db
      .prepare("SELECT id FROM source_files WHERE kind='intake_original' AND id<>?")
      .get(parent.id)!.id,
  );
  const source = getIntakeSourceText(f.db, f.root, f.profileId, childId);
  assert.equal(source.revision!.pages[0].disposition, 'unsupported');
  assert.equal(source.revision!.spans.length, 0);
  assert.equal(getIntakeOriginal(f.db, f.root, f.profileId, childId).bytes.toString(), literal);
});

test('renamed DICOM and media uploads stay retain-only before JSON extension hints', async (t) => {
  const f = fixture(t);
  const cases: [Buffer, string][] = [
    [Buffer.concat([Buffer.alloc(128), Buffer.from('DICMfictional')]), 'application/dicom'],
    [Buffer.from('RIFF0000WAVEfictional'), 'audio/wav'],
    [Buffer.from('RIFF0000AVI fictional'), 'video/x-msvideo'],
    [Buffer.from('ID3fictional'), 'audio/mpeg'],
    [Buffer.from('fLaCfictional'), 'audio/flac'],
    [Buffer.from('OggSfictional'), 'audio/ogg'],
    [Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x01, 0x3f, 0xfc, 0, 0]), 'audio/aac'],
    [Buffer.from([0xff, 0xfb, 0x90, 0x00]), 'audio/mpeg'],
    [Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0]), 'video/x-matroska'],
    [Buffer.from('0000ftypM4A fictional'), 'audio/mp4'],
    [Buffer.from('0000ftypisomfictional'), 'video/mp4'],
  ];
  for (const [index, [bytes, mimeType]] of cases.entries()) {
    const intake = uploadIntake(f.db, f.root, f.profileId, {
      filename: `fictional-renamed-${index}.json`,
      bytes,
    });
    assert.equal(intake.mimeType, mimeType);
    await assert.rejects(readIntakeEvidence({ ...f, id: intake.id, modelContext: true }), {
      code: 'INTAKE_RETAIN_ONLY',
    });
    const source = getIntakeSourceText(f.db, f.root, f.profileId, intake.id);
    assert.equal(source.revision!.pages[0].disposition, 'unsupported');
    assert.equal(source.revision!.spans.length, 0);
    assert.deepEqual(getIntakeOriginal(f.db, f.root, f.profileId, intake.id).bytes, bytes);
  }
  const readable = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-readable.mp3',
    bytes: pdf(),
  });
  assert.equal(readable.mimeType, 'application/pdf');
  assert.equal(isRetainOnlyIntake(readable), false);
  const unknownImage = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional.avif',
    bytes: Buffer.from('0000ftypavifFictional'),
  });
  assert.equal(unknownImage.mimeType, 'application/octet-stream');
  assert.equal(isRetainOnlyIntake(unknownImage), false);
});

test('invalid and truncated audio sync headers remain unknown binary', (t) => {
  const f = fixture(t);
  const invalid = [
    [0xff, 0xfe, 0xfd, 0xfc], // The original arbitrary-binary regression.
    [0xff, 0xfb, 0x90], // Truncated MPEG header.
    [0xff, 0xeb, 0x90, 0], // Reserved MPEG version.
    [0xff, 0xf9, 0x90, 0], // Reserved MPEG layer.
    [0xff, 0xfb, 0xf0, 0], // Reserved MPEG bitrate.
    [0xff, 0xfb, 0x9c, 0], // Reserved MPEG sample rate.
    [0xff, 0xfb, 0x90, 2], // Reserved MPEG emphasis.
    [0xff, 0xf1, 0x50, 0x80], // Truncated ADTS header.
    [0xff, 0xf1, 0x74, 0x80, 0, 0xff, 0xfc], // Undefined ADTS sample rate.
    [0xff, 0xf1, 0x50, 0x80, 0, 0x1f, 0xfc], // Impossible ADTS frame size.
    [0xff, 0xf1, 0x50, 0x80, 0x01, 0x3f, 0xfc], // Incomplete ADTS frame.
    [0xff, 0xf0, 0x50, 0x80, 0, 0xff, 0xfc], // Missing required ADTS CRC bytes.
  ];
  for (const [index, value] of invalid.entries()) {
    const intake = uploadIntake(f.db, f.root, f.profileId, {
      filename: `fictional-invalid-${index}.bin`,
      bytes: Buffer.from(value),
    });
    assert.equal(intake.mimeType, 'application/octet-stream', `header case ${index}`);
    assert.equal(isRetainOnlyIntake(intake), false);
  }
});
test('human review prevents a later extraction step from replacing corrections', async (t) => {
  const f = fixture(t),
    intake = uploadIntake(f.db, f.root, f.profileId, {
      filename: 'note.txt',
      bytes: Buffer.from('Fictional original'),
      newProviderName: 'Fictional Source',
    });
  const first = await extractIntakeSourceText({ ...f, id: intake.id }),
    revision = first.sourceText.revision!;
  reviewIntakeSourceText(
    f.db,
    f.root,
    f.profileId,
    intake.id,
    {
      operationId: randomUUID(),
      expectedRevisionId: revision.id,
      sourceHash: revision.sourceHash,
      action: 'correct',
      scope: { page: 1 },
      spans: [
        {
          id: 'human-note',
          text: 'Fictional correction',
          region: { page: 1 },
          provenance: 'human',
        },
      ],
    },
    'fictional-owner',
  );
  const after = await extractIntakeSourceText({ ...f, id: intake.id });
  assert.equal(after.processedPages, 0);
  assert.equal(after.sourceText.revision!.spans[0].text, 'Fictional correction');
});

test('image dimensions are bounded before decoding and cancellation terminates the local worker', async (t) => {
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.writeUInt32BE(100000, 16);
  header.writeUInt32BE(100000, 20);
  assert.throws(() => sourceRasterDimensions(header), /PIXEL_LIMIT/);
  const animated = Buffer.alloc(30);
  animated.write('RIFF', 0);
  animated.write('WEBP', 8);
  animated.write('VP8X', 12);
  animated[20] = 2;
  assert.throws(() => sourceRasterDimensions(animated), /MULTIFRAME_UNSUPPORTED/);
  const dir = mkdtempSync(resolve(tmpdir(), 'source-ocr-cancel-')),
    old = process.env.PATH;
  t.after(() => {
    process.env.PATH = old;
    rmSync(dir, { recursive: true, force: true });
  });
  const executable = resolve(dir, 'tesseract');
  writeFileSync(executable, '#!/bin/sh\nsleep 30\n');
  chmodSync(executable, 0o700);
  process.env.PATH = dir + ':' + old;
  const canvas = createCanvas(20, 20);
  let cancelled = false;
  const timer = setTimeout(() => {
    cancelled = true;
  }, 200);
  t.after(() => clearTimeout(timer));
  const started = Date.now();
  await assert.rejects(
    runSourceRasterWorker(canvas.toBuffer('image/png'), 1, [], () => {
      if (cancelled) throw Error('SESSION_LOCKED');
    }),
    /SESSION_LOCKED/,
  );
  assert.ok(Date.now() - started < 5000);
});

test('remaining logical pages can extract after an earlier page was corrected, preserving the human revision', async (t) => {
  const f = fixture(t),
    text = 'Fictional remainder 1.00. '.repeat(1500);
  const intake = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'long.txt',
    bytes: Buffer.from(text),
    newProviderName: 'Fictional Source',
  });
  const first = await extractIntakeSourceText({ ...f, id: intake.id, maxPages: 1 }),
    revision = first.sourceText.revision!;
  assert.equal(first.morePending, true);
  const reviewed = reviewIntakeSourceText(
    f.db,
    f.root,
    f.profileId,
    intake.id,
    {
      operationId: randomUUID(),
      expectedRevisionId: revision.id,
      sourceHash: revision.sourceHash,
      action: 'correct',
      scope: { page: 1 },
      spans: [
        {
          id: 'corrected-first-page',
          text: 'Fictional corrected first section',
          region: { page: 1 },
          provenance: 'human',
        },
      ],
    },
    'fictional-owner',
  );
  const final = await extractIntakeSourceText({ ...f, id: intake.id, maxPages: 2 });
  assert.equal(final.morePending, false);
  assert.equal(final.processedPages, 1);
  assert.deepEqual(
    final.sourceText.revision!.spans.filter((s) => s.region.page === 1),
    JSON.parse(JSON.stringify(reviewed.revision!.spans.filter((s) => s.region.page === 1))),
  );
  assert.equal(
    final.sourceText.revision!.spans.find((s) => s.region.page === 2)?.text,
    text.slice(24000),
  );
  assert.ok(final.sourceText.revision!.protectedPages.includes(1));
});

test('manually resolving a pending source page ends pending extraction without erasing human text', async (t) => {
  for (const action of ['correct', 'confirm'] as const) {
    const f = fixture(t),
      intake = uploadIntake(f.db, f.root, f.profileId, {
        filename: 'pending.txt',
        bytes: Buffer.from('Fictional page content. '.repeat(1500)),
        newProviderName: 'Fictional Source',
      });
    const first = await extractIntakeSourceText({ ...f, id: intake.id, maxPages: 1 }),
      revision = first.sourceText.revision!;
    reviewIntakeSourceText(
      f.db,
      f.root,
      f.profileId,
      intake.id,
      {
        operationId: randomUUID(),
        expectedRevisionId: revision.id,
        sourceHash: revision.sourceHash,
        action,
        scope: { page: 2 },
        ...(action === 'correct'
          ? {
              spans: [
                {
                  id: 'manual-pending',
                  text: 'Manually read fictional remaining section',
                  region: { page: 2 },
                  provenance: 'human' as const,
                },
              ],
            }
          : {}),
      },
      'fictional-owner',
    );
    const after = await extractIntakeSourceText({ ...f, id: intake.id });
    assert.equal(after.morePending, false);
    assert.equal(after.processedPages, 0);
    assert.equal(after.blockedByReview, false);
  }
});

test('raster admission bounds queued payloads instead of retaining an unbounded upload burst', async (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), 'source-ocr-admit-')),
    old = process.env.PATH;
  t.after(() => {
    process.env.PATH = old;
    rmSync(dir, { recursive: true, force: true });
  });
  const executable = resolve(dir, 'tesseract');
  writeFileSync(executable, `#!/bin/sh\ncat >/dev/null\nsleep 0.1\nprintf '%s' '${tsv}'\n`);
  chmodSync(executable, 0o700);
  process.env.PATH = dir + ':' + old;
  const image = createCanvas(20, 20).toBuffer('image/png');
  const first = runSourceRasterWorker(image, 1, []),
    second = runSourceRasterWorker(image, 2, []);
  await assert.rejects(runSourceRasterWorker(image, 3, []), { code: 'SOURCE_EXTRACTION_BUSY' });
  await Promise.all([first, second]);
});

test('native PDF locations share the rotation-aware non-square original preview coordinates', async (t) => {
  const f = fixture(t),
    intake = uploadIntake(f.db, f.root, f.profileId, {
      filename: 'rotated.pdf',
      bytes: pdf(90),
      newProviderName: 'Fictional Source',
    });
  const source = getRetainedIntakeOriginalReference(f.db, f.root, f.profileId, intake.id);
  const page = await readPdfEvidencePage({ ...source, profileId: f.profileId }, 1, 0);
  assert.ok(page.width > page.height);
  const box = page.locatedText![0];
  assert.ok(box.x > 0.9 && box.x < 0.94);
  assert.ok(box.y > 0.1 && box.y < 0.13);
  assert.ok(box.width < box.height);
  assert.ok(box.x + box.width <= 1 && box.y + box.height <= 1);
  assert.match(box.text, /Fictional Rowan/);
});
