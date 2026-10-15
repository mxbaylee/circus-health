import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  encodeIntakeReferencedEnvelope,
  INTAKE_REFERENCED_ENVELOPE_FORMAT,
  parseIntakeReferencedEnvelope,
  projectIntakeReferencedEnvelopeSteps,
  schemaCompactMetadataPiecesSteps,
  selectedIntakeFieldPiecesSteps,
  type IntakeReferencedEnvelope,
} from '../intake-compact-envelope.ts';
import { INTAKE_ENVELOPE_FORMAT } from '../intake-authority.ts';
import {
  prepareIntakeFilenameFactsSteps,
  type IntakeFilenameFacts,
} from '../intake-filename-facts.ts';
import { ENVELOPE_SCHEMA, schemaOrdinal, type SchemaControl } from '../intake-envelope-schema.ts';
import type { EnvelopeCellReader } from '../intake-collection-envelope.ts';
import { hashIntakeJsonScalar } from '../intake-json-scalar.ts';

const address = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture(source: string | undefined, metadataScalar?: string, metadataShape = 'object') {
  const cells = new Map<string, string>();
  const root = address('root'),
    intake = address('intake'),
    metadata = address('metadata');
  const addRecord = (id: string, count: number, shape = 'object') =>
    cells.set(
      'r:' + id,
      JSON.stringify({ kind: shape === 'array' ? 'array' : 'object', shape, count }),
    );
  const addField = (
    parent: string,
    ordinal: number,
    name: string,
    target: { type: 'cell' | 'record'; id: string },
    spelling = JSON.stringify(name),
  ) => {
    const prefix = address(parent + ':prefix:' + ordinal),
      nameId = address(parent + ':name:' + ordinal);
    cells.set(
      'o:' + parent + ':' + schemaOrdinal(ordinal),
      JSON.stringify({ prefix, name: nameId, target }),
    );
    cells.set('n:' + nameId, spelling);
    cells.set('c:' + prefix, (ordinal === 0 ? '{' : ',') + spelling + ':');
  };
  addRecord(root, 1);
  addRecord(intake, 1);
  if (metadataScalar === undefined)
    addRecord(metadata, source === undefined ? 0 : 2, metadataShape);
  addField(root, 0, 'intake', { type: 'record', id: intake });
  addField(
    intake,
    0,
    'metadata',
    { type: metadataScalar === undefined ? 'record' : 'cell', id: metadata },
    '"meta\\u0064ata"',
  );
  if (metadataScalar !== undefined) cells.set('c:' + metadata, metadataScalar);
  if (source !== undefined && metadataScalar === undefined) {
    const first = address('first-source'),
      last = address('last-source');
    addField(metadata, 0, 'source', { type: 'cell', id: first });
    addField(metadata, 1, 'source', { type: 'cell', id: last });
    cells.set('c:' + first, '"shadowed"');
    cells.set('c:' + last, ' \n' + source + '\t ');
  }
  cells.set('s:' + metadata, '}');
  cells.set('s:' + intake, '}');
  cells.set('s:' + root, '}');
  let checks = 0;
  const store: EnvelopeCellReader = {
    get: (key) => cells.get(key),
    range: (after, items, _bytes, prefix) => {
      const selected = [...cells]
        .filter(([key]) => key > after && (!prefix || key.startsWith(prefix)))
        .sort(([left], [right]) => left.localeCompare(right));
      return {
        items: selected.slice(0, items).map(([key, value]) => ({ key, value })),
        complete: selected.length <= items,
      };
    },
    chunks: () => {
      throw Error('fixture has no byte cells');
    },
    check: () => {
      checks++;
    },
  };
  const control: SchemaControl = { format: ENVELOPE_SCHEMA, mode: 'raw', root };
  return { store, control, checks: () => checks };
}

function read(store: EnvelopeCellReader, control: SchemaControl, path: readonly string[]) {
  const parts: string[] = [];
  const steps = selectedIntakeFieldPiecesSteps(store, control, path);
  for (;;) {
    const next = steps.next();
    if (next.done) return { present: next.value, parts, text: parts.join('') };
    if (typeof next.value === 'string') parts.push(next.value);
  }
}

test('selected compact field streams the last escaped-name source in bounded pieces', () => {
  const source = '"Fictional Clinic ' + 'x'.repeat(2 * 1024 * 1024) + '"';
  const { store, control, checks } = fixture(source);
  const result = read(store, control, ['intake', 'metadata', 'source']);
  assert.equal(result.present, true);
  assert.equal(result.text, source);
  assert.ok(result.parts.length > 128);
  assert.ok(result.parts.every((piece) => Buffer.byteLength(piece) <= 16 * 1024));
  assert.ok(checks() >= result.parts.length);
  let projectionBytes = 0,
    projectionPieces = 0;
  for (const piece of schemaCompactMetadataPiecesSteps(store, control, INTAKE_ENVELOPE_FORMAT)) {
    if (typeof piece !== 'string') continue;
    assert.ok(Buffer.byteLength(piece) <= 16 * 1024);
    projectionBytes += Buffer.byteLength(piece);
    projectionPieces++;
  }
  assert.ok(projectionBytes > 2 * 1024 * 1024);
  assert.ok(projectionPieces > 128);
});

test('referenced target projector retains bounded facts for a giant selected source label', () => {
  const source = JSON.stringify('Fictional Clinic 🌿 ' + 'x'.repeat(2 * 1024 * 1024));
  const { store, control, checks } = fixture(source);
  const identity = {
    profileId: 'fictional-profile',
    intakeId: 'fictional-original',
    sourceHash: address('fictional original bytes'),
  };
  const logicalRoot = {
    hash: address('selected logical root'),
    count: 1,
    height: 1,
    first: 'a',
    last: 'a',
  };
  const steps = projectIntakeReferencedEnvelopeSteps(store, control, identity, 3, logicalRoot);
  let ticks = 0;
  let raw = '';
  for (;;) {
    const next = steps.next();
    if (next.done) {
      raw = next.value;
      break;
    }
    ticks++;
  }
  const label = parseIntakeReferencedEnvelope(raw).intakeAuthority.sourceLabel;
  assert.equal(label.kind, 'string');
  if (label.kind !== 'string') return;
  const facts = prepareIntakeFilenameFactsSteps([' \n' + source + '\t '], '');
  let expected: IntakeFilenameFacts | undefined;
  for (;;) {
    const next = facts.next();
    if (next.done) {
      expected = next.value;
      break;
    }
  }
  assert.ok(expected);
  assert.equal(label.scalarHash, expected.scalarHash);
  assert.equal(label.bytes, expected.bytes);
  assert.equal(label.truncated, true);
  assert.ok(label.preview.startsWith('Fictional Clinic 🌿'));
  assert.ok(Buffer.byteLength(raw) < 8192);
  assert.ok(ticks > 128);
  assert.ok(checks() > 128);
});

test('referenced target projector distinguishes missing, null, and invalid source labels', () => {
  const identity = {
    profileId: 'fictional-profile',
    intakeId: 'fictional-original',
    sourceHash: address('fictional original bytes'),
  };
  const logicalRoot = {
    hash: address('selected logical root'),
    count: 1,
    height: 1,
    first: 'a',
    last: 'a',
  };
  const project = (source: string | undefined) => {
    const { store, control } = fixture(source);
    const steps = projectIntakeReferencedEnvelopeSteps(store, control, identity, 3, logicalRoot);
    for (;;) {
      const next = steps.next();
      if (next.done) return parseIntakeReferencedEnvelope(next.value).intakeAuthority.sourceLabel;
    }
  };
  assert.deepEqual(project(undefined), { kind: 'missing' });
  assert.deepEqual(project('null'), { kind: 'null' });
  assert.throws(() => project('7'), /referenced source label/);
  for (const scalar of ['null', '7', '"unstructured"', 'false']) {
    const { store, control } = fixture(undefined, scalar);
    const steps = projectIntakeReferencedEnvelopeSteps(store, control, identity, 3, logicalRoot);
    let result: string | undefined;
    for (;;) {
      const next = steps.next();
      if (next.done) {
        result = next.value;
        break;
      }
    }
    assert.deepEqual(parseIntakeReferencedEnvelope(result).intakeAuthority.sourceLabel, {
      kind: 'missing',
    });
  }
  const array = fixture(undefined, undefined, 'array');
  const arraySteps = projectIntakeReferencedEnvelopeSteps(
    array.store,
    array.control,
    identity,
    3,
    logicalRoot,
  );
  for (;;) {
    const next = arraySteps.next();
    if (next.done) {
      assert.deepEqual(parseIntakeReferencedEnvelope(next.value).intakeAuthority.sourceLabel, {
        kind: 'missing',
      });
      break;
    }
  }
});

test('referenced source preview keeps BOM and NUL and does not split a surrogate pair', () => {
  const identity = {
    profileId: 'fictional-profile',
    intakeId: 'fictional-original',
    sourceHash: address('fictional original bytes'),
  };
  const logicalRoot = {
    hash: address('selected logical root'),
    count: 1,
    height: 1,
    first: 'a',
    last: 'a',
  };
  const name = '\uFEFF' + 'a'.repeat(118) + '🌿' + '\u0000tail';
  const { store, control } = fixture(JSON.stringify(name));
  const steps = projectIntakeReferencedEnvelopeSteps(store, control, identity, 3, logicalRoot);
  let raw = '';
  for (;;) {
    const next = steps.next();
    if (next.done) {
      raw = next.value;
      break;
    }
  }
  const label = parseIntakeReferencedEnvelope(raw).intakeAuthority.sourceLabel;
  assert.equal(label.kind, 'string');
  if (label.kind !== 'string') return;
  assert.equal(label.preview, '\uFEFF' + 'a'.repeat(118));
  assert.equal(label.truncated, true);
  assert.equal(label.preview.includes('\uFFFD'), false);
  const expected = hashIntakeJsonScalar([JSON.stringify(name)]);
  assert.equal(label.bytes, Buffer.byteLength(' \n' + JSON.stringify(name) + '\t '));
  assert.equal(label.scalarHash, expected.hash);
  const nulFirst = fixture(JSON.stringify('\uFEFF\u0000visible'));
  const nulSteps = projectIntakeReferencedEnvelopeSteps(
    nulFirst.store,
    nulFirst.control,
    identity,
    3,
    logicalRoot,
  );
  for (;;) {
    const next = nulSteps.next();
    if (next.done) {
      const nulLabel = parseIntakeReferencedEnvelope(next.value).intakeAuthority.sourceLabel;
      assert.equal(nulLabel.kind, 'string');
      if (nulLabel.kind === 'string') assert.equal(nulLabel.preview, '\uFEFF\u0000visible');
      break;
    }
  }
});

test('selected compact field keeps missing, null, and nonobject paths distinct', () => {
  const { store, control } = fixture('null');
  assert.deepEqual(read(store, control, ['intake', 'metadata', 'source']), {
    present: true,
    parts: ['null'],
    text: 'null',
  });
  assert.equal(read(store, control, ['intake', 'metadata', 'absent']).present, false);
  assert.throws(
    () => read(store, control, ['intake', 'metadata', 'source', 'nested']),
    /selected field parent/,
  );
  assert.throws(
    () => read(store, { ...control, root: 'untrusted' }, ['intake']),
    /selected field path/,
  );
});

test('piece projection preserves raw spelling and normalized last-member semantics', () => {
  const { store, control } = fixture('"Fictional Clinic"');
  const projection = (mode: SchemaControl['mode']) => {
    const parts: string[] = [];
    for (const piece of schemaCompactMetadataPiecesSteps(
      store,
      { ...control, mode },
      INTAKE_ENVELOPE_FORMAT,
    ))
      if (typeof piece === 'string') parts.push(piece);
    return parts.join('');
  };
  assert.equal(
    projection('raw'),
    '{"intakeAuthority":{"format":"health-intake-envelope-v1","mode":"raw"},"intake":{"meta\\u0064ata":{"source":"shadowed","source": \n"Fictional Clinic"\t }}}',
  );
  assert.deepEqual(JSON.parse(projection('normalized')), {
    intakeAuthority: { format: INTAKE_ENVELOPE_FORMAT, mode: 'normalized' },
    intake: { metadata: { source: 'Fictional Clinic' } },
  });
});

test('V3 descriptor codec retains only bounded selected-root and source-label facts', () => {
  const steps = prepareIntakeFilenameFactsSteps([JSON.stringify('Fictional Clinic')], '');
  let facts: ReturnType<typeof steps.next>['value'];
  for (;;) {
    const next = steps.next();
    if (next.done) {
      facts = next.value;
      break;
    }
  }
  const descriptor: IntakeReferencedEnvelope = {
    intakeAuthority: {
      format: INTAKE_REFERENCED_ENVELOPE_FORMAT,
      identity: {
        profileId: 'fictional-profile',
        intakeId: 'fictional-original',
        sourceHash: address('fictional original bytes'),
      },
      mode: 'raw',
      storageSequence: 3,
      logicalRoot: {
        hash: address('selected logical root'),
        count: 1,
        height: 1,
        first: 'a',
        last: 'a',
      },
      sourceLabel: {
        kind: 'string',
        scalarHash: facts!.scalarHash,
        bytes: facts!.bytes,
        preview: facts!.preview,
        truncated: facts!.truncated,
      },
    },
  };
  const raw = encodeIntakeReferencedEnvelope(descriptor);
  assert.ok(Buffer.byteLength(raw) < 8192);
  assert.deepEqual(parseIntakeReferencedEnvelope(raw), descriptor);
  assert.deepEqual(
    parseIntakeReferencedEnvelope(
      encodeIntakeReferencedEnvelope({
        ...descriptor,
        intakeAuthority: { ...descriptor.intakeAuthority, sourceLabel: { kind: 'missing' } },
      }),
    ).intakeAuthority.sourceLabel,
    { kind: 'missing' },
  );
  assert.deepEqual(
    parseIntakeReferencedEnvelope(
      encodeIntakeReferencedEnvelope({
        ...descriptor,
        intakeAuthority: { ...descriptor.intakeAuthority, sourceLabel: { kind: 'null' } },
      }),
    ).intakeAuthority.sourceLabel,
    { kind: 'null' },
  );
  assert.throws(
    () =>
      parseIntakeReferencedEnvelope(
        raw.replace('"mode":"raw"', '"mode":"raw","mode":"normalized"'),
      ),
    /canonical form/,
  );
  assert.throws(
    () =>
      parseIntakeReferencedEnvelope(
        JSON.stringify({
          intakeAuthority: {
            identity: descriptor.intakeAuthority.identity,
            format: descriptor.intakeAuthority.format,
            mode: descriptor.intakeAuthority.mode,
            storageSequence: descriptor.intakeAuthority.storageSequence,
            logicalRoot: descriptor.intakeAuthority.logicalRoot,
            sourceLabel: descriptor.intakeAuthority.sourceLabel,
          },
        }),
      ),
    /canonical order/,
  );
  for (const surrogate of ['\\ud800', '\\udc00'])
    assert.throws(
      () =>
        parseIntakeReferencedEnvelope(
          raw.replace('"preview":"Fictional Clinic"', `"preview":"${surrogate}"`),
        ),
      /source label facts/,
    );
  assert.throws(
    () => parseIntakeReferencedEnvelope(raw.replace('"storageSequence":3', '"storageSequence":0')),
    /integer/,
  );
  assert.throws(
    () => parseIntakeReferencedEnvelope(raw.replace('"first":"a"', '"first":"z"')),
    /tree range/,
  );
  assert.throws(() => parseIntakeReferencedEnvelope(' '.repeat(8193)), /descriptor budget/);
});
