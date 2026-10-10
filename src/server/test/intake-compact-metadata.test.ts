import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPACT_SCALAR_FORMAT,
  compactIntakeScalarSteps,
  isIntakeCompactScalar,
  intakeMetadataLabel,
  intakeMetadataScalarMatches,
} from '../intake-compact-scalar.ts';
import {
  compactIntakeMetadata,
  INTAKE_COMPACT_ENVELOPE_FORMAT,
  validateIntakeEnvelopeRepresentation,
} from '../intake-authority.ts';

function descriptor(field: 'originalName' | 'locator', raw: string) {
  const steps = compactIntakeScalarSteps(field, [raw]);
  let yields = 0;
  for (;;) {
    const next = steps.next();
    if (next.done) return { value: next.value, yields };
    yields++;
  }
}
test('compact metadata scalar descriptors are bounded, exact-bound and explicitly shortened', () => {
  const exact = 'Fictional-' + 'quoted-"-line-\n'.repeat(40000) + '.pdf';
  const prepared = descriptor('originalName', JSON.stringify(exact));
  assert.ok(prepared.yields > 66);
  assert.ok(Buffer.byteLength(JSON.stringify(prepared.value)) < 1024);
  assert.equal(prepared.value.format, COMPACT_SCALAR_FORMAT);
  assert.equal(prepared.value.bytes, Buffer.byteLength(JSON.stringify(exact)));
  assert.equal(prepared.value.preview.length, 120);
  assert.equal(prepared.value.truncated, true);
  assert.equal(isIntakeCompactScalar(prepared.value), true);
  assert.match(intakeMetadataLabel(prepared.value), /\[shortened\]$/);
  assert.equal(intakeMetadataScalarMatches(prepared.value, exact), true);
  assert.equal(intakeMetadataScalarMatches(prepared.value, exact + 'changed'), false);
  assert.equal(isIntakeCompactScalar({ ...prepared.value, preview: 'x'.repeat(121) }), false);
});

test('v2 compact projection preserves raw duplicates, spelling and ordinary nonstring neighbors', () => {
  const first = JSON.stringify('first-' + 'fictional-first-'.repeat(2000) + '.txt');
  const last = JSON.stringify('last-' + 'fictional-last-'.repeat(2000) + '.pdf');
  const locator = JSON.stringify('PDF embedded file ' + 'fictional-key-'.repeat(2000));
  const state =
    '{"i\\u006etake":{"originalName":' +
    first +
    ',"originalName":' +
    last +
    ',"locator":' +
    locator +
    ',"version":1}}';
  const details =
    '{"intakeAuthority":{"format":"' +
    INTAKE_COMPACT_ENVELOPE_FORMAT +
    '","mode":"raw"},"i\\u006etake":{"originalName":' +
    JSON.stringify(descriptor('originalName', first).value) +
    ',"originalName":' +
    JSON.stringify(descriptor('originalName', last).value) +
    ',"locator":' +
    JSON.stringify(descriptor('locator', locator).value) +
    '}}';
  assert.equal(validateIntakeEnvelopeRepresentation(details, { raw: state }).text, state);
  assert.throws(
    () =>
      validateIntakeEnvelopeRepresentation(details.replace('fictional-first', 'changed-first'), {
        raw: state,
      }),
    /compact metadata conflicts/,
  );
  for (const originalName of [17, null, { fictional: 'ordinary retained metadata' }]) {
    const value = { intake: { originalName, locator: JSON.parse(locator), version: 1 } };
    const projected = compactIntakeMetadata(value, INTAKE_COMPACT_ENVELOPE_FORMAT);
    assert.deepEqual(projected.originalName, originalName);
    const normalized = JSON.stringify({
      intakeAuthority: { format: INTAKE_COMPACT_ENVELOPE_FORMAT, mode: 'normalized' },
      intake: projected,
    });
    assert.deepEqual(validateIntakeEnvelopeRepresentation(normalized, value).value, value);
  }
});
