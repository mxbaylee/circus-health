import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync,
  fstatSync,
  statfsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { extractNativePdfPage, sanitizeNativePdfJson } from '../intake-pdf-native.ts';
import { disposePdfEvidenceSessions, readPdfEvidencePage } from '../intake-pdf-session.ts';
import { INTAKE_PDF_BOUNDS } from '../intake-files.ts';

type Dictionary = Record<string, unknown>;
type Entry = { value: unknown } | { stream: { dict: Dictionary; data: string } };
function graph(
  resources: Dictionary = {},
  extra: Record<string, Entry> = {},
): { qpdf: [Dictionary, Record<string, Entry>] } {
  return {
    qpdf: [
      { jsonversion: 2, pdfversion: '1.7' },
      {
        'obj:1 0 R': { value: { '/Type': '/Catalog', '/Pages': '2 0 R' } },
        'obj:2 0 R': { value: { '/Type': '/Pages', '/Kids': ['3 0 R'], '/Count': 1 } },
        'obj:3 0 R': {
          value: {
            '/Type': '/Page',
            '/Parent': '2 0 R',
            '/MediaBox': [0, 0, 300, 300],
            '/Resources': resources,
            '/Contents': '4 0 R',
          },
        },
        'obj:4 0 R': stream('0 0 1 rg 10 10 100 100 re f'),
        ...extra,
        trailer: {
          value: {
            '/Root': '1 0 R',
            '/Size':
              Math.max(4, ...Object.keys(extra).map((key) => Number(key.slice(4).split(' ')[0]))) +
              1,
          },
        },
      },
    ],
  };
}
function stream(bytes: string | Buffer, dict: Dictionary = {}): Entry {
  return {
    stream: {
      dict: { '/Filter': '/FlateDecode', ...dict },
      data: deflateSync(bytes).toString('base64'),
    },
  };
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const rejectGraph = (value: unknown, code = 'PDF_NATIVE_UNSUPPORTED') =>
  assert.throws(() => sanitizeNativePdfJson(encode(value)), { code });

function temporary(t: TestContext) {
  const directory = mkdtempSync(resolve(tmpdir(), 'circus-fictional-graph-test-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  return directory;
}
function sourcePdf(t: TestContext, value = graph()) {
  const directory = temporary(t);
  const jsonPath = resolve(directory, 'fictional-source.json');
  const path = resolve(directory, 'fictional-source.pdf');
  writeFileSync(jsonPath, encode(value));
  const result = spawnSync('qpdf', ['--json-input', jsonPath, '--stream-data=preserve', path], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const check = spawnSync(
    'qpdf',
    [
      '--empty',
      '--suppress-recovery',
      '--remove-unreferenced-resources=yes',
      '--pages',
      path,
      '1',
      '--',
      '--json-output=2',
      '--decode-level=none',
      '-',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(check.status, 0, check.stderr);
  const bytes = readFileSync(path);
  const source = {
    id: directory,
    profileId: 'fictional-graph-profile',
    path,
    filename: 'fictional-source.pdf',
    size: bytes.length,
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
  };
  t.after(() => disposePdfEvidenceSessions(source.profileId));
  return { source, directory };
}

test('graph projection prunes nested forbidden branches and unreachable objects while keeping exact raw rendering streams', () => {
  const hidden = 'FICTIONAL_HIDDEN_GRAPH_BRANCH';
  const value = graph(
    { '/XObject': { '/Form': '5 0 R' } },
    {
      'obj:5 0 R': stream('/Child Do', {
        '/Type': '/XObject',
        '/Subtype': '/Form',
        '/BBox': [0, 0, 20, 20],
        '/Metadata': '7 0 R',
        '/Resources': { '/XObject': { '/Child': '6 0 R' } },
      }),
      'obj:6 0 R': stream('0 0 1 rg 1 1 5 5 re f', {
        '/Type': '/XObject',
        '/Subtype': '/Form',
        '/BBox': [0, 0, 10, 10],
        '/PieceInfo': { '/Vendor': { '/Private': '7 0 R' } },
        '/AF': ['7 0 R'],
        '/AA': { '/Open': '7 0 R' },
        '/Resources': {},
      }),
      'obj:7 0 R': stream(hidden),
    },
  );
  const sanitized = JSON.parse(sanitizeNativePdfJson(encode(value)).toString());
  assert.equal(sanitized.qpdf[1]['obj:7 0 R'], undefined);
  assert.equal(
    sanitized.qpdf[1]['obj:5 0 R'].stream.data,
    (value.qpdf[1] as Record<string, { stream: { data: string } }>)['obj:5 0 R']!.stream.data,
  );
  assert.equal(
    sanitized.qpdf[1]['obj:6 0 R'].stream.data,
    (value.qpdf[1] as Record<string, { stream: { data: string } }>)['obj:6 0 R']!.stream.data,
  );
  assert.doesNotMatch(JSON.stringify(sanitized), /Metadata|PieceInfo|Private|\/AF|\/AA/);
});

test('graph projection rejects cycles and unknown nested rendering semantics', () => {
  const form = (resources: Dictionary) =>
    stream('/Again Do', {
      '/Type': '/XObject',
      '/Subtype': '/Form',
      '/BBox': [0, 0, 20, 20],
      '/Resources': resources,
    });
  rejectGraph(
    graph(
      { '/XObject': { '/Again': '5 0 R' } },
      { 'obj:5 0 R': form({ '/XObject': { '/Again': '5 0 R' } }) },
    ),
  );
  rejectGraph(
    graph(
      {},
      { 'obj:4 0 R': stream('FICTIONAL_UNKNOWN_FILTER', { '/Filter': '/UnknownDecoder' }) },
    ),
  );
  rejectGraph(
    graph(
      { '/XObject': { '/Again': '5 0 R' } },
      {
        'obj:5 0 R': stream('', {
          '/Type': '/XObject',
          '/Subtype': '/Form',
          '/BBox': [0, 0, 20, 20],
          '/UnknownRenderingExtension': '6 0 R',
        }),
        'obj:6 0 R': stream('FICTIONAL_UNREVIEWED_EXTENSION'),
      },
    ),
  );
});

for (const [kind, value] of Object.entries({
  '/Pattern': { '/Type': '/Pattern', '/PatternType': 1 },
  '/Shading': { '/ShadingType': 2, '/ColorSpace': '/DeviceRGB' },
  '/ExtGState': { '/Type': '/ExtGState', '/CA': 0.5 },
  '/ColorSpace': '/DeviceRGB',
  '/Properties': { '/ActualText': 'u:FICTIONAL_UNSELECTED_PROPERTY' },
}))
  test(`unproven shared resource map ${kind} rejects native copying`, () =>
    rejectGraph(graph({ [kind]: { '/Unused': value } })));

test('Type3 glyph procedure maps require raster fallback instead of copying unselected glyph streams', () => {
  rejectGraph(
    graph(
      {
        '/Font': {
          '/F1': { '/Type': '/Font', '/Subtype': '/Type3', '/CharProcs': { '/Unused': '5 0 R' } },
        },
      },
      { 'obj:5 0 R': stream('FICTIONAL_UNSELECTED_GLYPH') },
    ),
  );
});

test('font subtype-inapplicable graph fields and competing image masks reject native copying', () => {
  for (const key of [
    '/CharProcs',
    '/Resources',
    '/DescendantFonts',
    '/CIDToGIDMap',
    '/FontBBox',
    '/FontMatrix',
  ])
    rejectGraph(
      graph(
        {
          '/Font': {
            '/F1': {
              '/Type': '/Font',
              '/Subtype': '/Type1',
              [key]:
                key === '/DescendantFonts'
                  ? []
                  : key === '/FontBBox' || key === '/FontMatrix'
                    ? [0, 0, 1, 1]
                    : key === '/CIDToGIDMap'
                      ? '5 0 R'
                      : {},
            },
          },
        },
        { 'obj:5 0 R': stream('FICTIONAL_UNUSED_FONT_BRANCH') },
      ),
    );
  rejectGraph(
    graph(
      {
        '/Font': {
          '/F1': {
            '/Type': '/Font',
            '/Subtype': '/TrueType',
            '/FontDescriptor': { '/FontFile2': '5 0 R', '/FontFile3': '5 0 R' },
          },
        },
      },
      { 'obj:5 0 R': stream('FICTIONAL_SECOND_FONT_PROGRAM') },
    ),
  );
  for (const extra of [
    { '/ImageMask': true, '/ColorSpace': '/DeviceRGB' },
    { '/Mask': [0, 0], '/SMask': '6 0 R' },
    { '/SMaskInData': 1, '/SMask': '6 0 R' },
  ])
    rejectGraph(
      graph(
        { '/XObject': { '/Im': '5 0 R' } },
        {
          'obj:5 0 R': stream('x', {
            '/Type': '/XObject',
            '/Subtype': '/Image',
            '/Width': 1,
            '/Height': 1,
            ...extra,
          }),
          'obj:6 0 R': stream('x', {
            '/Type': '/XObject',
            '/Subtype': '/Image',
            '/Width': 1,
            '/Height': 1,
            '/ColorSpace': '/DeviceGray',
            '/BitsPerComponent': 8,
          }),
        },
      ),
    );
});

test('filter-inapplicable JBIG2Globals cannot retain an unrelated stream on a Flate image', () => {
  rejectGraph(
    graph(
      { '/XObject': { '/Im': '5 0 R' } },
      {
        'obj:4 0 R': stream('/Im Do'),
        'obj:5 0 R': stream(Buffer.from([255, 0, 0]), {
          '/Type': '/XObject',
          '/Subtype': '/Image',
          '/Width': 1,
          '/Height': 1,
          '/ColorSpace': '/DeviceRGB',
          '/BitsPerComponent': 8,
          '/DecodeParms': { '/JBIG2Globals': '6 0 R' },
        }),
        'obj:6 0 R': stream('FICTIONAL_UNRELATED_GLOBAL_STREAM'),
      },
    ),
  );
});

test('transparency group selector is required before traversing its color profile', () => {
  const value = graph({}, { 'obj:5 0 R': stream('FICTIONAL_UNRELATED_PROFILE', { '/N': 3 }) });
  (value.qpdf[1]['obj:3 0 R'] as { value: Dictionary }).value['/Group'] = {
    '/CS': ['/ICCBased', '5 0 R'],
  };
  rejectGraph(value);
});

test('unused shared Pattern stream from another original page cannot enter native selected-page evidence', async (t) => {
  const resources = { '/Pattern': { '/OtherPageOnly': '5 0 R' } };
  const value = graph(resources, {
    'obj:5 0 R': stream('0 0 1 rg 0 0 10 10 re f % FICTIONAL_UNSELECTED_PATTERN_MARKER', {
      '/Type': '/Pattern',
      '/PatternType': 1,
      '/PaintType': 1,
      '/TilingType': 1,
      '/BBox': [0, 0, 10, 10],
      '/XStep': 10,
      '/YStep': 10,
      '/Resources': {},
    }),
    'obj:6 0 R': {
      value: {
        '/Type': '/Page',
        '/Parent': '2 0 R',
        '/MediaBox': [0, 0, 300, 300],
        '/Resources': resources,
        '/Contents': '7 0 R',
      },
    },
    'obj:7 0 R': stream('/Pattern cs /OtherPageOnly scn 0 0 300 300 re f'),
  });
  value.qpdf[1]['obj:2 0 R'] = {
    value: { '/Type': '/Pages', '/Count': 2, '/Kids': ['3 0 R', '6 0 R'] },
  };
  const { source } = sourcePdf(t, value);
  await assert.rejects(readPdfEvidencePage(source, 1, 0, undefined, { format: 'pdf' }), {
    code: 'PDF_NATIVE_UNSUPPORTED',
  });
  const fallback = await readPdfEvidencePage(source, 1, 0);
  assert.equal(fallback.mimeType, 'image/png');
  assert.equal(fallback.totalPages, 2);
});

test('graph projection bounds object count, recursion, dictionary bytes, raw stream bytes and transport bytes', () => {
  const extras: Record<string, Entry> = {};
  for (let id = 10; id < 4110; id++) extras[`obj:${id} 0 R`] = { value: null };
  rejectGraph(graph({}, extras));
  let widths: unknown = 1;
  for (let index = 0; index < 55; index++) widths = [widths];
  rejectGraph(
    graph({ '/Font': { '/F1': { '/Type': '/Font', '/Subtype': '/Type1', '/Widths': widths } } }),
  );
  rejectGraph(
    graph({
      '/Font': {
        '/F1': {
          '/Type': '/Font',
          '/Subtype': '/Type1',
          '/BaseFont': '/' + 'x'.repeat(INTAKE_PDF_BOUNDS.maxNativePdfDictionaryBytes),
        },
      },
    }),
  );
  rejectGraph(
    graph(
      {},
      {
        'obj:4 0 R': {
          stream: {
            dict: {},
            data: Buffer.alloc(INTAKE_PDF_BOUNDS.maxNativePdfBytes + 1).toString('base64'),
          },
        },
      },
    ),
    'PDF_NATIVE_PAGE_LIMIT',
  );
  rejectGraph(
    graph({
      '/Font': {
        '/F1': {
          '/Type': '/Font',
          '/Subtype': '/Type1',
          '/BaseFont':
            '/' + '名'.repeat(Math.ceil(INTAKE_PDF_BOUNDS.maxNativePdfDictionaryBytes / 3)),
        },
      },
    }),
  );
  assert.throws(
    () => sanitizeNativePdfJson(Buffer.alloc(INTAKE_PDF_BOUNDS.maxNativePdfBytes * 2 + 1)),
    { code: 'PDF_NATIVE_PAGE_LIMIT' },
  );
});

for (const directResources of [true, false])
  test(
    directResources
      ? 'native projection preserves embedded font, direct image ICC and soft mask, and inherited geometry pixel for pixel'
      : 'complex shared resource maps use pixel-identical raster fallback',
    async (t) => {
      const font = readFileSync(
        fileURLToPath(
          new URL(
            '../../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf',
            import.meta.url,
          ),
        ),
      );
      const icc = readFileSync(
        fileURLToPath(
          new URL(
            '../../../node_modules/pdfjs-dist/iccs/CGATS001Compat-v2-micro.icc',
            import.meta.url,
          ),
        ),
      );
      const content =
        'q /CS1 cs 0 0.8 0.4 0 scn 20 20 80 50 re f Q\nq 70 0 0 70 120 20 cm /Im Do Q\nq /Pattern cs /P1 scn 20 100 80 50 re f Q\nq 80 0 0 50 120 100 cm /Sh sh Q\nq /GS gs 1 0 0 rg 20 180 180 40 re f Q\nBT /F1 16 Tf 20 250 Td (FICTIONAL FONT 0123) Tj ET';
      const resources = {
        '/Font': { '/F1': '5 0 R' },
        '/ColorSpace': { '/CS1': ['/ICCBased', '8 0 R'] },
        '/XObject': { '/Im': '9 0 R' },
        '/Pattern': { '/P1': '11 0 R' },
        '/Shading': { '/Sh': '12 0 R' },
        '/ExtGState': { '/GS': '14 0 R' },
      };
      const value = graph(resources, {
        'obj:4 0 R': stream(content),
        'obj:5 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/TrueType',
            '/BaseFont': '/LiberationSans',
            '/Encoding': '/WinAnsiEncoding',
            '/FirstChar': 32,
            '/LastChar': 126,
            '/Widths': Array(95).fill(600),
            '/FontDescriptor': '6 0 R',
          },
        },
        'obj:6 0 R': {
          value: {
            '/Type': '/FontDescriptor',
            '/FontName': '/LiberationSans',
            '/Flags': 32,
            '/FontBBox': [-543, -303, 1301, 981],
            '/ItalicAngle': 0,
            '/Ascent': 905,
            '/Descent': -211,
            '/CapHeight': 688,
            '/StemV': 80,
            '/FontFile2': '7 0 R',
          },
        },
        'obj:7 0 R': stream(font, { '/Length1': font.length }),
        'obj:8 0 R': stream(icc, { '/N': 4, '/Alternate': '/DeviceCMYK' }),
        'obj:9 0 R': stream(Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]), {
          '/Type': '/XObject',
          '/Subtype': '/Image',
          '/Width': 2,
          '/Height': 2,
          '/ColorSpace': '/DeviceRGB',
          '/BitsPerComponent': 8,
          '/SMask': '10 0 R',
        }),
        'obj:10 0 R': stream(Buffer.from([40, 100, 180, 255]), {
          '/Type': '/XObject',
          '/Subtype': '/Image',
          '/Width': 2,
          '/Height': 2,
          '/ColorSpace': '/DeviceGray',
          '/BitsPerComponent': 8,
        }),
        'obj:11 0 R': stream('0 0 1 rg 0 0 5 5 re f', {
          '/Type': '/Pattern',
          '/PatternType': 1,
          '/PaintType': 1,
          '/TilingType': 1,
          '/BBox': [0, 0, 10, 10],
          '/XStep': 10,
          '/YStep': 10,
          '/Resources': {},
        }),
        'obj:12 0 R': {
          value: {
            '/ShadingType': 2,
            '/ColorSpace': '/DeviceRGB',
            '/Coords': [0, 0, 1, 0],
            '/Function': '13 0 R',
            '/Extend': [true, true],
          },
        },
        'obj:13 0 R': {
          value: {
            '/FunctionType': 2,
            '/Domain': [0, 1],
            '/C0': [1, 0, 0],
            '/C1': [0, 0, 1],
            '/N': 1,
          },
        },
        'obj:14 0 R': {
          value: { '/Type': '/ExtGState', '/SMask': { '/S': '/Luminosity', '/G': '15 0 R' } },
        },
        'obj:15 0 R': stream('0.5 g 0 0 300 300 re f', {
          '/Type': '/XObject',
          '/Subtype': '/Form',
          '/BBox': [0, 0, 300, 300],
          '/Resources': {},
          '/Group': { '/S': '/Transparency', '/CS': '/DeviceGray' },
        }),
      });
      if (directResources) {
        for (const key of ['/ColorSpace', '/ExtGState', '/Pattern', '/Shading'])
          delete (resources as Dictionary)[key];
        value.qpdf[1]['obj:4 0 R'] = stream(
          'q 70 0 0 70 120 20 cm /Im Do Q\nBT /F1 16 Tf 20 250 Td (FICTIONAL FONT 0123) Tj ET',
        );
        value.qpdf[1]['obj:9 0 R'] = stream(
          Buffer.from([0, 255, 255, 0, 255, 0, 255, 0, 255, 255, 0, 0, 0, 0, 255, 0]),
          {
            '/Type': '/XObject',
            '/Subtype': '/Image',
            '/Width': 2,
            '/Height': 2,
            '/ColorSpace': ['/ICCBased', '8 0 R'],
            '/BitsPerComponent': 8,
            '/SMask': '10 0 R',
          },
        );
      }
      // Geometry and resources inherit from the page tree in ordinary PDFs.
      const entries = value.qpdf[1] as Record<string, { value: Dictionary }>;
      const page = entries['obj:3 0 R']!.value;
      const pages = entries['obj:2 0 R']!.value;
      for (const key of ['/MediaBox', '/Resources']) {
        pages[key] = page[key];
        delete page[key];
      }
      pages['/Rotate'] = 90;
      const { source, directory } = sourcePdf(t, value);
      const original = await readPdfEvidencePage(source, 1, 0);
      if (!directResources) {
        await assert.rejects(readPdfEvidencePage(source, 1, 0, undefined, { format: 'pdf' }), {
          code: 'PDF_NATIVE_UNSUPPORTED',
        });
        const fallback = await readPdfEvidencePage(source, 1, 0);
        assert.deepEqual(fallback.image, original.image);
        assert.match(fallback.text, /FICTIONAL FONT 0123/);
        return;
      }
      const native = await readPdfEvidencePage(source, 1, 0, undefined, { format: 'pdf' });
      const path = resolve(directory, 'fictional-native.pdf');
      writeFileSync(path, native.pdf);
      const check = spawnSync('qpdf', ['--check', path], { encoding: 'utf8' });
      assert.equal(check.status, 0, check.stderr);
      const derivative = {
        ...source,
        id: `${source.id}-derived`,
        path,
        size: native.pdf.length,
        sourceHash: createHash('sha256').update(native.pdf).digest('hex'),
      };
      const rendered = await readPdfEvidencePage(derivative, 1, 0);
      assert.match(rendered.text, /FICTIONAL FONT 0123/);
      assert.equal(rendered.width, original.width);
      assert.equal(rendered.height, original.height);
      assert.deepEqual(rendered.image, original.image);
    },
  );

const namedInputs = () =>
  [tmpdir(), ...(process.platform === 'linux' ? ['/dev/shm'] : [])]
    .flatMap((directory) =>
      readdirSync(directory)
        .filter((name) => name.startsWith('circus-pdf-'))
        .map((name) => resolve(directory, name)),
    )
    .sort();
for (const outcome of ['success', 'cancel', 'spawn-error', 'size', 'timeout'] as const)
  test(`native graph descriptor is private, already unlinked, and closed after concurrent ${outcome}`, async (t) => {
    const { source } = sourcePdf(t);
    const fds = [openSync(source.path, 'r'), openSync(source.path, 'r')];
    t.after(() => fds.forEach(closeSync));
    const before = namedInputs();
    const inputFds: number[] = [];
    const children: ChildProcess[] = [];
    const controllers = [new AbortController(), new AbortController()];
    const jobs = controllers.map((controller, index) =>
      extractNativePdfPage(fds[index]!, 1, {
        signal: controller.signal,
        maxBytes: outcome === 'size' ? 1024 : INTAKE_PDF_BOUNDS.maxNativePdfBytes,
        timeoutMs: outcome === 'timeout' ? 1000 : 10_000,
        spawnProcess: (command, args, options) => {
          if (!args.includes('--json-input')) return spawn(command, args, options);
          const inputFd = (options.stdio as number[])[4]!;
          inputFds.push(inputFd);
          const stat = fstatSync(inputFd);
          assert.equal(stat.nlink, 0);
          if (process.platform === 'linux')
            assert.equal(statfsSync(`/proc/self/fd/${inputFd}`).type, 0x01021994);
          assert.equal(stat.mode & 0o777, 0o600);
          const prefix = Buffer.alloc(7);
          assert.equal(readSync(inputFd, prefix, 0, prefix.length, 0), prefix.length);
          assert.equal(prefix.toString(), '{"qpdf"');
          assert.deepEqual(namedInputs(), before);
          if (outcome === 'spawn-error') throw new Error('Fictional spawn failure');
          const child = ['cancel', 'timeout', 'size'].includes(outcome)
            ? spawn(
                process.execPath,
                [
                  '-e',
                  (outcome === 'size' ? 'process.stdout.write(Buffer.alloc(2048));' : '') +
                    'setInterval(()=>{},1000)',
                ],
                options,
              )
            : spawn(command, args, options);
          children.push(child);
          if (outcome === 'cancel') queueMicrotask(() => controller.abort());
          return child;
        },
      }),
    );
    const results = await Promise.allSettled(jobs);
    assert.equal(inputFds.length, 2, JSON.stringify(results));
    for (const result of results) {
      if (outcome === 'success') assert.equal(result.status, 'fulfilled');
      else {
        assert.equal(result.status, 'rejected');
        if (result.status === 'rejected')
          assert.equal(
            result.reason.code,
            outcome === 'cancel'
              ? 'PDF_EVIDENCE_CANCELLED'
              : outcome === 'size'
                ? 'PDF_NATIVE_PAGE_LIMIT'
                : 'PDF_NATIVE_UNSUPPORTED',
          );
      }
    }
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode === null && child.signalCode === null) await once(child, 'close');
      }),
    );
    for (const inputFd of inputFds) assert.throws(() => fstatSync(inputFd), { code: 'EBADF' });
    assert.deepEqual(namedInputs(), before);
  });
