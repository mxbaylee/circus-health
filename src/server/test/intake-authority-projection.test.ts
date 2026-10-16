import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTAKE_COMPACT_ENVELOPE_FORMAT,
  INTAKE_ENVELOPE_FORMAT,
  intakeEnvelopeProjection,
  prepareInitialIntakeEnvelope,
  prepareIntakeEnvelopeProjection,
  prepareNormalizedIntakeEnvelopeRepresentation,
  prepareRawIntakeEnvelopeRepresentation,
} from '../intake-authority.ts';
import { compactIntakeScalarSteps } from '../intake-compact-scalar.ts';

test('cooperative authority projection matches selected JSON semantics without decoding a large metadata scalar', async () => {
  const cases = [
    `{"intakeAuthority":{"format":"${INTAKE_ENVELOPE_FORMAT}","mode":"raw"},"intake":{"originalName":"fictional"}}`,
    `{"intake":{"locator":"${'fictional-'.repeat(9000)}"},"intakeAuthority":{"mode":"normalized","format":"${INTAKE_COMPACT_ENVELOPE_FORMAT}"}}`,
    `{"intakeAuthority":{"format":"${INTAKE_ENVELOPE_FORMAT}","mode":"raw","mode":"normalized"},"intake":{"originalName":"fictional"}}`,
    `{"intakeAuthority":{"format":"${INTAKE_ENVELOPE_FORMAT}","mode":"raw"},"intake":{"unknown":"fictional"}}`,
    `{"intakeAuthority":{"format":"${INTAKE_ENVELOPE_FORMAT}","mode":"raw"},"intake":{},"unexpected":0}`,
  ];
  for (const source of cases) {
    let turns = 0;
    let actual: unknown;
    let expected: unknown;
    try {
      expected = intakeEnvelopeProjection(source);
    } catch (error) {
      expected = (error as Error).message;
    }
    try {
      actual = await prepareIntakeEnvelopeProjection(source, {
        assertRunning() {
          turns++;
        },
      });
    } catch (error) {
      actual = (error as Error).message;
    }
    assert.deepEqual(actual, expected);
    assert.ok(turns > 0);
  }
});

test('cooperative authority projection refuses cancellation and a malformed tail', async () => {
  const source = `{"intakeAuthority":{"format":"${INTAKE_ENVELOPE_FORMAT}","mode":"raw"},"intake":{"locator":"${'fictional-'.repeat(9000)}"}}`;
  let turns = 0;
  await assert.rejects(
    prepareIntakeEnvelopeProjection(source, {
      assertRunning() {
        if (++turns === 12) throw Error('fictional cancellation');
      },
    }),
    /fictional cancellation/,
  );
  assert.ok(turns >= 12);
  await assert.rejects(prepareIntakeEnvelopeProjection(source + 'false'));
});

test('raw representation compares original duplicate and escape spelling exactly', async () => {
  const cases = [
    '{"intake":{"version":1,"workflow":{"format":"health-intake-workflow-v1"},"originalName":"fictional"}}',
    '{"intake":false,"in\\u0074ake":{"version":2,"originalName":"first","originalName":"last"}}',
    '{"intake":{"version":3,"locator":[0,1,2],"loc\\u0061tor":"fictional"}}',
    '{"intake":{"version":4,"locator":"fictional"},"ignored":{"nested":[true,null,7]}}',
  ];
  for (const raw of cases) {
    const prepared = prepareInitialIntakeEnvelope(raw);
    let turns = 0;
    const result = await prepareRawIntakeEnvelopeRepresentation(prepared.detailsJson, raw, {
      assertRunning() {
        turns++;
      },
    });
    assert.equal(result.version, JSON.parse(raw).intake.version);
    assert.equal(result.text, raw);
    assert.ok(turns > 0);
    await assert.rejects(
      prepareRawIntakeEnvelopeRepresentation(prepared.detailsJson + ' ', raw),
      /compact metadata conflicts/,
    );
  }
});

test('raw compact scalar comparison distinguishes decoded and raw token lengths', async () => {
  const large = 'fictional'.repeat(3000),
    token = JSON.stringify(large),
    descriptorSteps = compactIntakeScalarSteps('originalName', [token]);
  let descriptor: unknown;
  for (;;) {
    const next = descriptorSteps.next();
    if (next.done) {
      descriptor = next.value;
      break;
    }
  }
  const details =
    '{"intakeAuthority":' +
    JSON.stringify({ format: INTAKE_COMPACT_ENVELOPE_FORMAT, mode: 'raw' }) +
    ',"intake":{"originalName":' +
    JSON.stringify(descriptor) +
    '}}';
  const raw = '{"intake":{"version":5,"originalName":' + token + '}}';
  assert.equal((await prepareRawIntakeEnvelopeRepresentation(details, raw)).version, 5);
  const escaped = '"' + '\\u0061'.repeat(4000) + '"';
  const escapedSteps = compactIntakeScalarSteps('locator', [escaped]);
  let escapedDescriptor: unknown;
  for (;;) {
    const next = escapedSteps.next();
    if (next.done) {
      escapedDescriptor = next.value;
      break;
    }
  }
  const escapedRaw = '{"intake":{"version":6,"locator":' + escaped + '}}',
    escapedDetails =
      '{"intakeAuthority":' +
      JSON.stringify({ format: INTAKE_COMPACT_ENVELOPE_FORMAT, mode: 'raw' }) +
      ',"intake":{"locator":' +
      JSON.stringify(escapedDescriptor) +
      '}}';
  assert.equal(
    (await prepareRawIntakeEnvelopeRepresentation(escapedDetails, escapedRaw)).version,
    6,
  );
});

test('normalized representation compares selected metadata without decoding a giant name', async () => {
  const value = {
    intake: {
      version: 7,
      originalName: 'fictional-' + 'x'.repeat(8 * 1024 * 1024 + 17),
      workflow: { format: 'health-intake-workflow-v1' },
      metadata: { note: 'Independently fictional.' },
    },
  };
  const serialized = JSON.stringify(value);
  const descriptorSteps = compactIntakeScalarSteps('originalName', [
    JSON.stringify(value.intake.originalName),
  ]);
  let descriptor: unknown;
  for (;;) {
    const next = descriptorSteps.next();
    if (next.done) {
      descriptor = next.value;
      break;
    }
  }
  const details = JSON.stringify({
    intakeAuthority: { format: INTAKE_COMPACT_ENVELOPE_FORMAT, mode: 'normalized' },
    intake: {
      originalName: descriptor,
      metadata: value.intake.metadata,
    },
  });
  let turns = 0;
  const selected = await prepareNormalizedIntakeEnvelopeRepresentation(details, serialized, {
    assertRunning() {
      turns++;
    },
  });
  assert.equal(selected.version, 7);
  assert.equal(selected.text, serialized);
  assert.ok(turns > 1);
  await assert.rejects(
    prepareNormalizedIntakeEnvelopeRepresentation(details + ' ', serialized),
    /compact metadata conflicts/,
  );
  await assert.rejects(prepareNormalizedIntakeEnvelopeRepresentation(details, serialized + 'null'));
});
