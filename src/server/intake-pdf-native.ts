import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, unlinkSync, writeSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTAKE_PDF_BOUNDS } from './intake-files.ts';

interface NativePdfOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

const nativeError = (code: string, message: string) => Object.assign(new Error(message), { code });

type PdfDictionary = Record<string, unknown>;
const dictionary = (value: unknown): value is PdfDictionary =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const reference = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+ \d+ R$/.test(value);
const unsupported = (): never => {
  throw nativeError('PDF_NATIVE_UNSUPPORTED', 'Native page has unsupported rendering resources');
};

// PDF 32000-1 rendering dictionaries only. Unknown semantics take the raster path;
// metadata, structure, private application data and actions are never traversed.
// qpdf JSON v2 preserves raw stream bytes/filters and resolves name escaping:
// https://qpdf.readthedocs.io/en/stable/json.html
const discardKeys = new Set([
  '/Metadata',
  '/PieceInfo',
  '/AF',
  '/AA',
  '/StructParent',
  '/StructParents',
  '/LastModified',
  '/Thumb',
  '/B',
  '/Dur',
  '/Trans',
  '/PresSteps',
  '/Tabs',
]);
const streamFields = { '/Filter': 'filters', '/DecodeParms': 'decodeParameters' };
const fields: Record<string, Record<string, string>> = {
  page: {
    '/Type': '=Page',
    '/Parent': 'parent',
    '/MediaBox': 'numbers',
    '/CropBox': 'numbers',
    '/BleedBox': 'numbers',
    '/TrimBox': 'numbers',
    '/ArtBox': 'numbers',
    '/Rotate': 'number',
    '/UserUnit': 'number',
    '/Resources': 'resources',
    '/Contents': 'contents',
    '/Group': 'group',
    '/Annots': 'empty',
  },
  resources: {
    '/Font': 'map:font',
    '/XObject': 'map:xobject',
    '/ColorSpace': 'emptyMap',
    '/ExtGState': 'emptyMap',
    '/Pattern': 'emptyMap',
    '/Shading': 'emptyMap',
    '/Properties': 'emptyMap',
    '/ProcSet': 'names',
  },
  group: {
    '/Type': '=Group',
    '/S': '=Transparency',
    '/CS': 'colorSpace',
    '/I': 'boolean',
    '/K': 'boolean',
  },
  font: {
    '/Type': '=Font',
    '/Subtype': 'fontSubtype',
    '/Name': 'name',
    '/BaseFont': 'name',
    '/FirstChar': 'number',
    '/LastChar': 'number',
    '/Widths': 'numbers',
    '/FontDescriptor': 'descriptor',
    '/Encoding': 'encoding',
    '/ToUnicode': 'cmap',
    '/DescendantFonts': 'array:font',
    '/CIDSystemInfo': 'cidSystem',
    '/DW': 'number',
    '/W': 'numbers',
    '/DW2': 'numbers',
    '/W2': 'numbers',
    '/CIDToGIDMap': 'nameOrBytes',
    '/FontBBox': 'numbers',
    '/FontMatrix': 'numbers',
    '/CharProcs': 'map:content',
    '/Resources': 'resources',
  },
  descriptor: {
    '/Type': '=FontDescriptor',
    '/FontName': 'name',
    '/FontFamily': 'string',
    '/FontStretch': 'name',
    '/FontWeight': 'number',
    '/Flags': 'number',
    '/FontBBox': 'numbers',
    '/ItalicAngle': 'number',
    '/Ascent': 'number',
    '/Descent': 'number',
    '/Leading': 'number',
    '/CapHeight': 'number',
    '/XHeight': 'number',
    '/StemV': 'number',
    '/StemH': 'number',
    '/AvgWidth': 'number',
    '/MaxWidth': 'number',
    '/MissingWidth': 'number',
    '/FontFile': 'fontFile',
    '/FontFile2': 'fontFile',
    '/FontFile3': 'fontFile',
    '/CharSet': 'string',
    '/Style': 'fontStyle',
    '/CIDSet': 'bytes',
  },
  fontStyle: { '/Panose': 'string' },
  encoding: { '/Type': '=Encoding', '/BaseEncoding': 'name', '/Differences': 'differences' },
  cidSystem: { '/Registry': 'string', '/Ordering': 'string', '/Supplement': 'number' },
  cmap: {
    ...streamFields,
    '/Type': '=CMap',
    '/CMapName': 'name',
    '/CIDSystemInfo': 'cidSystem',
    '/WMode': 'number',
    '/UseCMap': 'cmap',
  },
  fontFile: {
    ...streamFields,
    '/Length1': 'number',
    '/Length2': 'number',
    '/Length3': 'number',
    '/Subtype': 'name',
  },
  form: {
    ...streamFields,
    '/Type': '=XObject',
    '/Subtype': '=Form',
    '/FormType': 'number',
    '/BBox': 'numbers',
    '/Matrix': 'numbers',
    '/Resources': 'resources',
    '/Group': 'group',
    '/Name': 'name',
  },
  image: {
    ...streamFields,
    '/Type': '=XObject',
    '/Subtype': '=Image',
    '/Width': 'number',
    '/Height': 'number',
    '/ColorSpace': 'colorSpace',
    '/BitsPerComponent': 'number',
    '/Intent': 'name',
    '/ImageMask': 'boolean',
    '/Mask': 'imageMask',
    '/Decode': 'numbers',
    '/Interpolate': 'boolean',
    '/SMask': 'image',
    '/SMaskInData': 'number',
    '/Matte': 'numbers',
    '/Name': 'name',
  },
  icc: { ...streamFields, '/N': 'number', '/Alternate': 'colorSpace', '/Range': 'numbers' },
  colorParameters: {
    '/WhitePoint': 'numbers',
    '/BlackPoint': 'numbers',
    '/Gamma': 'numbers',
    '/Matrix': 'numbers',
    '/Range': 'numbers',
  },
  graphics: {
    '/Type': '=ExtGState',
    '/LW': 'number',
    '/LC': 'number',
    '/LJ': 'number',
    '/ML': 'number',
    '/D': 'numbers',
    '/RI': 'name',
    '/OP': 'boolean',
    '/op': 'boolean',
    '/OPM': 'number',
    '/Font': 'graphicsFont',
    '/BG': 'function',
    '/BG2': 'function',
    '/UCR': 'function',
    '/UCR2': 'function',
    '/TR': 'functions',
    '/TR2': 'functions',
    '/HT': 'name',
    '/FL': 'number',
    '/SM': 'number',
    '/SA': 'boolean',
    '/BM': 'names',
    '/SMask': 'softMask',
    '/CA': 'number',
    '/ca': 'number',
    '/AIS': 'boolean',
    '/TK': 'boolean',
  },
  softMask: { '/Type': '=Mask', '/S': 'name', '/G': 'form', '/BC': 'numbers', '/TR': 'function' },
  pattern: {
    ...streamFields,
    '/Type': '=Pattern',
    '/PatternType': 'number',
    '/PaintType': 'number',
    '/TilingType': 'number',
    '/BBox': 'numbers',
    '/XStep': 'number',
    '/YStep': 'number',
    '/Resources': 'resources',
    '/Matrix': 'numbers',
    '/Shading': 'shading',
    '/ExtGState': 'graphics',
  },
  shading: {
    ...streamFields,
    '/ShadingType': 'number',
    '/ColorSpace': 'colorSpace',
    '/Background': 'numbers',
    '/BBox': 'numbers',
    '/AntiAlias': 'boolean',
    '/Domain': 'numbers',
    '/Matrix': 'numbers',
    '/Function': 'functions',
    '/Coords': 'numbers',
    '/Extend': 'booleans',
    '/BitsPerCoordinate': 'number',
    '/BitsPerComponent': 'number',
    '/BitsPerFlag': 'number',
    '/Decode': 'numbers',
    '/VerticesPerRow': 'number',
  },
  function: {
    ...streamFields,
    '/FunctionType': 'number',
    '/Domain': 'numbers',
    '/Range': 'numbers',
    '/Size': 'numbers',
    '/BitsPerSample': 'number',
    '/Order': 'number',
    '/Encode': 'numbers',
    '/Decode': 'numbers',
    '/C0': 'numbers',
    '/C1': 'numbers',
    '/N': 'number',
    '/Functions': 'array:function',
    '/Bounds': 'numbers',
  },
  properties: {
    '/MCID': 'number',
    '/ActualText': 'string',
    '/Alt': 'string',
    '/Lang': 'string',
    '/E': 'string',
  },
  decodeParameters: {
    '/Predictor': 'number',
    '/Colors': 'number',
    '/BitsPerComponent': 'number',
    '/Columns': 'number',
    '/K': 'number',
    '/EndOfLine': 'boolean',
    '/EncodedByteAlign': 'boolean',
    '/Rows': 'number',
    '/EndOfBlock': 'boolean',
    '/BlackIs1': 'boolean',
    '/DamagedRowsBeforeError': 'number',
    '/EarlyChange': 'number',
    '/ColorTransform': 'number',
  },
  content: streamFields,
  bytes: streamFields,
};
const streamRoles = new Set([
  'content',
  'bytes',
  'cmap',
  'fontFile',
  'form',
  'image',
  'icc',
  'pattern',
  'shading',
  'function',
]);
const requiredStreamRoles = new Set(['content', 'bytes', 'fontFile', 'form', 'image', 'icc']);

/** Project only the selected page's bounded rendering graph, pruning every
 * object made unreachable by removal of non-rendering dictionary branches.
 * Opaque rendering streams remain exact; this is not a content/redaction tool.
 */
export function sanitizeNativePdfJson(
  raw: Buffer,
  maxBytes = INTAKE_PDF_BOUNDS.maxNativePdfBytes,
): Buffer {
  if (raw.byteLength > maxBytes * 2)
    throw nativeError('PDF_NATIVE_PAGE_LIMIT', 'Native PDF graph exceeds its bounded size');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    return unsupported();
  }
  if (
    !dictionary(parsed) ||
    !Array.isArray(parsed.qpdf) ||
    parsed.qpdf.length !== 2 ||
    !dictionary(parsed.qpdf[0]) ||
    parsed.qpdf[0].jsonversion !== 2 ||
    !dictionary(parsed.qpdf[1])
  )
    return unsupported();
  const objects = parsed.qpdf[1];
  if (Object.keys(objects).length > 4096) return unsupported();
  const dereference = (ref: unknown): PdfDictionary => {
    if (!reference(ref)) return unsupported();
    const item = objects[`obj:${ref}`];
    if (!dictionary(item) || !dictionary(item.value)) return unsupported();
    return item.value;
  };
  const trailer = objects.trailer;
  if (!dictionary(trailer) || !dictionary(trailer.value)) return unsupported();
  const rootRef = trailer.value['/Root'];
  const root = dereference(rootRef);
  const pagesRef = root['/Pages'];
  const pages = dereference(pagesRef);
  if (
    root['/Type'] !== '/Catalog' ||
    pages['/Type'] !== '/Pages' ||
    pages['/Count'] !== 1 ||
    !Array.isArray(pages['/Kids']) ||
    pages['/Kids'].length !== 1
  )
    return unsupported();
  const pageRef = pages['/Kids'][0];
  const page = dereference(pageRef);
  if (page['/Type'] !== '/Page' || page['/Parent'] !== pagesRef) return unsupported();
  const output: PdfDictionary = {};
  const visited = new Map<string, string>();
  const active = new Set<string>();
  let steps = 0,
    dictionaryBytes = 0,
    streamBytes = 0;
  function project(value: unknown, role: string, depth: number): unknown {
    if (++steps > 100_000 || depth > 48) return unsupported();
    if (reference(value)) {
      if (role === 'parent') return value === pagesRef ? value : unsupported();
      if (active.has(value)) return unsupported();
      const entry = objects[`obj:${value}`];
      if (!dictionary(entry)) return unsupported();
      if (role === 'functions' && !Array.isArray(entry.value)) role = 'function';
      if (dictionary(entry.stream)) {
        if (role === 'contents') role = 'content';
        if (role === 'nameOrBytes' || role === 'lookup') role = 'bytes';
        if (role === 'imageMask') role = 'image';
        if (role === 'encoding') role = 'cmap';
        const stream = entry.stream;
        if (
          !dictionary(stream.dict) ||
          typeof stream.data !== 'string' ||
          stream.data.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(stream.data)
        )
          return unsupported();
        if (role === 'xobject')
          role =
            stream.dict['/Subtype'] === '/Form'
              ? 'form'
              : stream.dict['/Subtype'] === '/Image'
                ? 'image'
                : unsupported();
        if (!streamRoles.has(role)) return unsupported();
      }
      const prior = visited.get(value);
      if (prior) return prior === role ? value : unsupported();
      active.add(value);
      visited.set(value, role);
      if (dictionary(entry.stream)) {
        const stream = entry.stream as { dict: PdfDictionary; data: string };
        streamBytes +=
          (stream.data.length / 4) * 3 -
          (stream.data.endsWith('==') ? 2 : stream.data.endsWith('=') ? 1 : 0);
        if (streamBytes > maxBytes)
          throw nativeError(
            'PDF_NATIVE_PAGE_LIMIT',
            'Native rendering streams exceed their bounded size',
          );
        output[`obj:${value}`] = {
          stream: { dict: projectDictionary(stream.dict, role, depth + 1), data: stream.data },
        };
      } else {
        if (
          !('value' in entry) ||
          requiredStreamRoles.has(role) ||
          role === 'xobject' ||
          (role === 'contents' && !Array.isArray(entry.value))
        )
          return unsupported();
        output[`obj:${value}`] = { value: project(entry.value, role, depth + 1) };
      }
      active.delete(value);
      return value;
    }
    if (role === 'functions' && !Array.isArray(value)) role = 'function';
    if (value === null && ['decodeParameters', 'empty'].includes(role)) return null;
    if (role === 'filters') {
      const filters = Array.isArray(value) ? value : [value];
      if (
        !filters.every(
          (filter) =>
            typeof filter === 'string' &&
            [
              '/ASCIIHexDecode',
              '/AHx',
              '/ASCII85Decode',
              '/A85',
              '/LZWDecode',
              '/LZW',
              '/FlateDecode',
              '/Fl',
              '/RunLengthDecode',
              '/RL',
              '/CCITTFaxDecode',
              '/CCF',
              '/JBIG2Decode',
              '/DCTDecode',
              '/DCT',
              '/JPXDecode',
            ].includes(filter),
        )
      )
        return unsupported();
      return project(value, 'names', depth + 1);
    }
    // qpdf proves usage pruning for Font/XObject maps only. Other shared
    // maps can retain another page's rendering streams even when unused here.
    if (role === 'emptyMap')
      return dictionary(value) && Object.keys(value).length === 0 ? {} : unsupported();
    if (role === 'parent') return unsupported();
    if (role.startsWith('=')) return value === '/' + role.slice(1) ? value : unsupported();
    if (role === 'number')
      return typeof value === 'number' && Number.isFinite(value) ? value : unsupported();
    if (role === 'boolean') return typeof value === 'boolean' ? value : unsupported();
    if (role === 'name' || role === 'fontSubtype') {
      if (typeof value !== 'string' || !value.startsWith('/')) return unsupported();
      if (
        role === 'fontSubtype' &&
        !['/Type0', '/Type1', '/MMType1', '/TrueType', '/CIDFontType0', '/CIDFontType2'].includes(
          value,
        )
      )
        return unsupported();
      dictionaryBytes += value.length;
      return value;
    }
    if (role === 'string' || role === 'lookup') {
      if (typeof value !== 'string' || !/^(?:u:|b:[a-fA-F0-9]*$)/.test(value)) return unsupported();
      dictionaryBytes += value.length;
      return value;
    }
    if (
      role === 'nameOrBytes' ||
      (['encoding', 'cmap', 'function', 'functions', 'softMask'].includes(role) &&
        typeof value === 'string')
    )
      return project(value, 'name', depth + 1);
    if (role === 'colorSpace') {
      if (typeof value === 'string') return project(value, 'name', depth + 1);
      if (!Array.isArray(value)) return unsupported();
      const [kind, ...rest] = value;
      const roles =
        kind === '/ICCBased'
          ? ['icc']
          : ['/CalRGB', '/CalGray', '/Lab'].includes(String(kind))
            ? ['colorParameters']
            : ['/Indexed', '/I'].includes(String(kind))
              ? ['colorSpace', 'number', 'lookup']
              : kind === '/Separation'
                ? ['name', 'colorSpace', 'function']
                : kind === '/DeviceN'
                  ? ['names', 'colorSpace', 'function']
                  : kind === '/Pattern'
                    ? rest.length
                      ? ['colorSpace']
                      : []
                    : null;
      if (!roles || rest.length !== roles.length) return unsupported();
      return [kind, ...rest.map((item, index) => project(item, roles[index]!, depth + 1))];
    }
    if (role === 'graphicsFont') {
      if (!Array.isArray(value) || value.length !== 2) return unsupported();
      return [project(value[0], 'font', depth + 1), project(value[1], 'number', depth + 1)];
    }
    if (role === 'empty') return Array.isArray(value) && value.length === 0 ? [] : unsupported();
    if (role === 'numbers' && typeof value === 'number') return project(value, 'number', depth + 1);
    if (role === 'names' && typeof value === 'string') return project(value, 'name', depth + 1);
    if (Array.isArray(value)) {
      const childRole = role.startsWith('array:')
        ? role.slice(6)
        : role === 'contents'
          ? 'content'
          : role === 'imageMask'
            ? 'number'
            : role === 'numbers'
              ? 'numbers'
              : role === 'names'
                ? 'name'
                : role === 'booleans'
                  ? 'boolean'
                  : role === 'functions'
                    ? 'function'
                    : role === 'decodeParameters'
                      ? 'decodeParameters'
                      : null;
      if (role === 'differences')
        return value.map((item) =>
          project(item, typeof item === 'number' ? 'number' : 'name', depth + 1),
        );
      if (!childRole) return unsupported();
      return value.map((item) => project(item, childRole, depth + 1));
    }
    if (
      !dictionary(value) ||
      requiredStreamRoles.has(role) ||
      role === 'xobject' ||
      role === 'contents'
    )
      return unsupported();
    if (role.startsWith('map:')) {
      const mapped: PdfDictionary = {};
      for (const [key, item] of Object.entries(value)) {
        if (!key.startsWith('/')) return unsupported();
        dictionaryBytes += key.length;
        mapped[key] = project(item, role.slice(4), depth + 1);
      }
      return mapped;
    }
    return projectDictionary(value, role, depth + 1);
  }
  function projectDictionary(value: PdfDictionary, role: string, depth: number): PdfDictionary {
    if (role === 'group' && value['/S'] !== '/Transparency') return unsupported();
    if (role === 'font') {
      const subtype = value['/Subtype'];
      const allowed = new Set([
        '/Type',
        '/Subtype',
        '/BaseFont',
        ...(subtype === '/Type0'
          ? ['/Encoding', '/DescendantFonts', '/ToUnicode']
          : subtype === '/CIDFontType0' || subtype === '/CIDFontType2'
            ? [
                '/CIDSystemInfo',
                '/FontDescriptor',
                '/DW',
                '/W',
                '/DW2',
                '/W2',
                ...(subtype === '/CIDFontType2' ? ['/CIDToGIDMap'] : []),
              ]
            : ['/Type1', '/MMType1', '/TrueType'].includes(String(subtype))
              ? [
                  '/Name',
                  '/FirstChar',
                  '/LastChar',
                  '/Widths',
                  '/FontDescriptor',
                  '/Encoding',
                  '/ToUnicode',
                ]
              : unsupported()),
      ]);
      for (const key of Object.keys(value))
        if (!discardKeys.has(key) && !allowed.has(key)) return unsupported();
    }
    if (
      role === 'descriptor' &&
      ['/FontFile', '/FontFile2', '/FontFile3'].filter((key) => key in value).length > 1
    )
      return unsupported();
    if (role === 'image') {
      // These alternatives override or prohibit one another in PDF rendering;
      // retaining an ignored branch would copy bytes outside the visible image.
      if (
        value['/ImageMask'] === true &&
        ['/ColorSpace', '/Mask', '/SMask', '/SMaskInData'].some((key) => key in value)
      )
        return unsupported();
      if (
        value['/ImageMask'] === true &&
        value['/BitsPerComponent'] !== undefined &&
        value['/BitsPerComponent'] !== 1
      )
        return unsupported();
      if (
        '/SMask' in value &&
        ('/Mask' in value ||
          (typeof value['/SMaskInData'] === 'number' && value['/SMaskInData'] !== 0))
      )
        return unsupported();
    }
    const schema = fields[role];
    if (!schema || depth > 48) return unsupported();
    const projected: PdfDictionary = {};
    for (const [key, item] of Object.entries(value)) {
      if (discardKeys.has(key)) continue;
      const childRole = schema[key];
      if (!childRole) return unsupported();
      dictionaryBytes += key.length + 8;
      if (dictionaryBytes > INTAKE_PDF_BOUNDS.maxNativePdfDictionaryBytes) return unsupported();
      const child = project(item, childRole, depth + 1);
      if (key !== '/Annots') projected[key] = child;
    }
    return projected;
  }
  project(pageRef, 'page', 0);
  if (dictionaryBytes > INTAKE_PDF_BOUNDS.maxNativePdfDictionaryBytes) return unsupported();
  output[`obj:${rootRef}`] = { value: { '/Type': '/Catalog', '/Pages': pagesRef } };
  output[`obj:${pagesRef}`] = { value: { '/Type': '/Pages', '/Count': 1, '/Kids': [pageRef] } };
  const maxObjectId = Math.max(
    ...Object.keys(output).map((key) => Number(key.slice(4).split(' ')[0])),
  );
  output.trailer = { value: { '/Root': rootRef, '/Size': maxObjectId + 1 } };
  if (
    Buffer.byteLength(JSON.stringify(output, (key, value) => (key === 'data' ? '' : value))) >
    INTAKE_PDF_BOUNDS.maxNativePdfDictionaryBytes
  )
    return unsupported();
  const result = Buffer.from(
    JSON.stringify({ qpdf: [{ jsonversion: 2, pdfversion: '1.7' }, output] }),
  );
  if (result.length > maxBytes * 2)
    throw nativeError('PDF_NATIVE_PAGE_LIMIT', 'Native PDF graph exceeds its bounded size');
  return result;
}

/** Copy only one page through bounded qpdf JSON, project its rendering graph,
 * and serialize the sanitized graph through an immediately unlinked descriptor.
 * Linux requires tmpfs backing before any plaintext is written. No original
 * pathname reopening or whole-original Node buffer is involved.
 */
export async function extractNativePdfPage(
  fd: number,
  page: number,
  options: NativePdfOptions = {},
): Promise<Buffer> {
  if (!Number.isSafeInteger(page) || page < 1 || page > INTAKE_PDF_BOUNDS.maxPages)
    throw nativeError('PDF_PAGE', 'PDF page outside document');
  const maxBytes = options.maxBytes ?? INTAKE_PDF_BOUNDS.maxNativePdfBytes;
  const deadline = performance.now() + (options.timeoutMs ?? INTAKE_PDF_BOUNDS.nativePdfTimeoutMs);
  const remaining = () => {
    const time = deadline - performance.now();
    if (time <= 0)
      throw nativeError(
        'PDF_NATIVE_UNSUPPORTED',
        'Native PDF extraction exceeded its wall-time bound',
      );
    return time;
  };
  const raw = await runBoundedQpdf(
    fd,
    [
      '--empty',
      '--suppress-recovery',
      '--remove-unreferenced-resources=yes',
      '--pages',
      '/dev/fd/3',
      String(page),
      '--',
      '--json-output=2',
      '--decode-level=none',
      '-',
    ],
    { ...options, maxBytes: maxBytes * 2, timeoutMs: remaining() },
  );
  const input = sanitizeNativePdfJson(raw, maxBytes);
  const pdf = await runBoundedQpdf(
    fd,
    [
      '--json-input',
      '/dev/fd/4',
      '--stream-data=preserve',
      '--object-streams=disable',
      '--deterministic-id',
      '--remove-unreferenced-resources=yes',
      '-',
    ],
    { ...options, maxBytes, timeoutMs: remaining(), input },
  );
  if (pdf.subarray(0, 5).toString() !== '%PDF-')
    throw nativeError('PDF_NATIVE_UNSUPPORTED', 'Native page output was not a PDF');
  return pdf;
}

function runBoundedQpdf(
  fd: number,
  args: string[],
  {
    signal,
    maxBytes = INTAKE_PDF_BOUNDS.maxNativePdfBytes,
    timeoutMs = INTAKE_PDF_BOUNDS.nativePdfTimeoutMs,
    spawnProcess = spawn,
    input,
  }: NativePdfOptions & { input?: Buffer },
): Promise<Buffer> {
  if (signal?.aborted)
    return Promise.reject(nativeError('PDF_EVIDENCE_CANCELLED', 'PDF page extraction cancelled'));
  if (process.platform === 'win32')
    return Promise.reject(
      nativeError(
        'PDF_NATIVE_UNSUPPORTED',
        'Native PDF extraction requires a seekable inherited descriptor',
      ),
    );
  // Linux is the supported runtime. Limit the native parser's address space,
  // not just Node's heap. macOS contributor checks retain byte/time bounds.
  const command = process.platform === 'linux' ? '/bin/sh' : 'qpdf';
  const commandArgs =
    process.platform === 'linux'
      ? [
          '-c',
          'ulimit -v "$1" || exit 126; shift; exec qpdf "$@"',
          'qpdf-bounded',
          String(INTAKE_PDF_BOUNDS.nativePdfAddressSpaceMiB * 1024),
          ...args,
        ]
      : args;
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let inputFd: number | undefined;
    let child: ChildProcess;
    try {
      if (input) {
        // Prefer the runtime's explicitly sized tmpfs; contributor Linux hosts
        // may use /dev/shm. Verify the opened descriptor before writing any data.
        for (const directory of process.platform === 'linux'
          ? [tmpdir(), '/dev/shm']
          : [tmpdir()]) {
          const path = join(directory, `circus-pdf-${randomUUID()}`);
          let candidate: number | undefined;
          try {
            candidate = openSync(path, 'wx+', 0o600);
            // Unlink while still empty. A crash cannot leave named plaintext behind.
            unlinkSync(path);
            if (
              process.platform === 'linux' &&
              statfsSync(`/proc/self/fd/${candidate}`).type !== 0x01021994
            )
              continue;
            inputFd = candidate;
            candidate = undefined;
            break;
          } catch {
            // A missing/unavailable temporary filesystem can try the next choice.
          } finally {
            if (candidate !== undefined) closeSync(candidate);
          }
        }
        if (inputFd === undefined)
          throw nativeError(
            'PDF_NATIVE_UNSUPPORTED',
            'Native PDF graph requires temporary memory-backed storage',
          );
        // Positional writes leave the inherited descriptor at offset zero.
        for (let offset = 0; offset < input.length;) {
          const written = writeSync(inputFd, input, offset, input.length - offset, offset);
          if (written <= 0) throw new Error('Native graph input write made no progress');
          offset += written;
        }
      }
      child = spawnProcess(command, commandArgs, {
        stdio: ['ignore', 'pipe', 'ignore', fd, ...(inputFd === undefined ? [] : [inputFd])],
        env: { PATH: process.env.PATH || '' },
      });
    } catch {
      reject(nativeError('PDF_NATIVE_UNSUPPORTED', 'Native PDF extraction is unavailable'));
      return;
    } finally {
      // The child inherited the descriptor; it owns the last reference until exit.
      if (inputFd !== undefined) closeSync(inputFd);
    }
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        child.kill('SIGKILL');
        chunks.length = 0;
        reject(error);
      } else resolve(Buffer.concat(chunks, bytes));
    };
    const abort = () =>
      finish(nativeError('PDF_EVIDENCE_CANCELLED', 'PDF page extraction cancelled'));
    const timer = setTimeout(
      () =>
        finish(
          nativeError(
            'PDF_NATIVE_UNSUPPORTED',
            'Native PDF extraction exceeded its wall-time bound',
          ),
        ),
      timeoutMs,
    );
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', () =>
      finish(nativeError('PDF_NATIVE_UNSUPPORTED', 'Native PDF extraction is unavailable')),
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        finish(
          nativeError(
            'PDF_NATIVE_PAGE_LIMIT',
            'The native PDF page exceeds the bounded model-input size',
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0 || !bytes)
        finish(
          nativeError(
            'PDF_NATIVE_UNSUPPORTED',
            'The selected page could not be copied safely as native PDF',
          ),
        );
      else finish();
    });
  });
}
