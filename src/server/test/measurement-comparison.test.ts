import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDecimal,
  displayDecimal,
  rational,
  terminatingDecimal,
} from '../../shared/exact-decimal.ts';
import {
  MEASUREMENT_RULE_VERSION,
  resolveMeasurementUnit,
  supportedMeasurementUnits,
} from '../../shared/measurement-units.ts';
import {
  compareMeasurements,
  deriveMeasurement,
  parseMeasurementLiteral,
  type MeasurementInput,
  type MeasurementSemantics,
} from '../../shared/measurement.ts';
const semantics: MeasurementSemantics = {
  quantity: 'fictional:body-mass',
  dimension: 'mass',
  region: 'whole_body',
  specimen: 'not_applicable',
  method: 'fictional:scale-method',
  meaning: 'measured_mass',
};
function input(
  id: string,
  valueText: string,
  unit: string | null,
  changed: Partial<MeasurementSemantics> = {},
): MeasurementInput {
  const reference = {
    profileId: 'fictional:cookie',
    kind: 'observation' as const,
    recordId: id,
    sourceRecordId: 'source:' + id,
    identity: 'assertion:' + id,
    version: 'v1',
    stateHash: 'state:' + id,
    evidenceHash: 'evidence:' + id,
  };
  return {
    reference,
    source: { valueText, unit, date: '2026-02-10' },
    binding: {
      decisionId: 'review:' + id,
      rulesVersion: MEASUREMENT_RULE_VERSION,
      reference: structuredClone(reference),
      subject: 'self',
      semantics: { ...semantics, ...changed },
      precision: null,
    },
  };
}
function precision(value: MeasurementInput, increment: string) {
  value.binding!.precision = {
    increment,
    basis: 'explicit_review',
    evidence: 'The fictional source specifies rounding to this increment.',
  };
  return value;
}

test('verified UCUM subset gives exact mass and concentration values without binary arithmetic', () => {
  const lb = deriveMeasurement(input('lb', '1.00', '[lb_av]'), 'kg');
  assert.equal(lb.conversion!.exactDecimal, '0.45359237');
  assert.equal(
    deriveMeasurement(input('oz', '16', '[oz_av]'), '[lb_av]').conversion!.exactDecimal,
    '1',
  );
  assert.equal(
    deriveMeasurement(input('micro', '123456789123456789.000001', 'ug'), 'g').conversion!
      .exactDecimal,
    '123456789123.456789000001',
  );
  const concentration = {
    dimension: 'mass_concentration' as const,
    quantity: 'fictional:analyte-mass-concentration',
    specimen: 'fictional:serum',
  };
  assert.equal(
    compareMeasurements(
      input('a', '1.20', 'mg/dL', concentration),
      input('b', '12.0', 'mg/L', concentration),
      'g/L',
    ).status,
    'exact',
  );
  assert.equal(
    compareMeasurements(
      input('c', '12', 'ug/mL', concentration),
      input('d', '12', 'mg/L', concentration),
      'g/L',
    ).status,
    'exact',
  );
  const amount = {
    ...concentration,
    dimension: 'amount_concentration' as const,
    quantity: 'fictional:analyte-amount-concentration',
  };
  assert.equal(
    compareMeasurements(
      input('e', '0.012', 'mmol/L', amount),
      input('f', '12', 'umol/L', amount),
      'mol/L',
    ).status,
    'exact',
  );
});

test('unit catalog callers cannot mutate the deterministic conversion registry', () => {
  const catalog = supportedMeasurementUnits();
  catalog.find((unit) => unit.code === 'kg')!.factor.numerator = '7';
  assert.equal(
    deriveMeasurement(input('catalog', '1', 'kg'), 'g').conversion!.exactDecimal,
    '1000',
  );
  assert.equal(
    deriveMeasurement(
      input('length', '1.25', 'm', { dimension: 'length', quantity: 'fictional:length' }),
      'cm',
    ).conversion!.exactDecimal,
    '125',
  );
  assert.equal(
    deriveMeasurement(
      input('volume', '1.25', 'L', { dimension: 'volume', quantity: 'fictional:volume' }),
      'mL',
    ).conversion!.exactDecimal,
    '1250',
  );
});

test('source literals, sign, zeros, exponent and written precision survive independently of display rounding', () => {
  const source = input('large', ' +001.2300e+2 ', 'kg');
  const before = structuredClone(source),
    projection = deriveMeasurement(source, 'g', 2);
  assert.deepEqual(source, before);
  assert.deepEqual(projection.source, before.source);
  assert.equal(projection.conversion!.exactDecimal, '123000');
  assert.deepEqual(projection.parsed!.literalQuantum, rational(1n, 100n));
  assert.deepEqual(projection.conversion!.literalQuantum, rational(10n));
  assert.equal(projection.parsed!.decimal.fractionalDigits, 4);
  assert.equal(parseDecimal('-0.00')!.negativeZero, true);
  assert.equal(deriveMeasurement(input('zero', '-0.00', 'kg'), 'g').conversion!.exactDecimal, '0');
  assert.equal(
    deriveMeasurement(input('sign', '-1.25', 'kg'), 'g').conversion!.exactDecimal,
    '-1250',
  );
  assert.equal(parseDecimal('9007199254740993')!.value.numerator, '9007199254740993');
  const repeated = deriveMeasurement(input('repeating', '1', 'kg'), '[lb_av]', 3);
  assert.equal(repeated.conversion!.exactDecimal, null);
  assert.equal(repeated.conversion!.display.value, '2.205');
  assert.equal(repeated.conversion!.display.applied, true);
  assert.notEqual(repeated.conversion!.display.error.numerator, '0');
  assert.equal(repeated.conversion!.roundingIncrement, null);
});

test('exact inline structured units are separated only for derived measurement parsing', () => {
  const spaced = input('spaced', '<= +001.2500e1 kg', 'kg'),
    before = structuredClone(spaced),
    projected = deriveMeasurement(spaced, 'g');
  assert.deepEqual(spaced, before);
  assert.deepEqual(projected.source, before.source);
  assert.equal(projected.conversion!.exactDecimal, '12500');
  assert.equal(projected.conversion!.comparator, '<=');
  assert.equal(projected.parsed!.decimal.fractionalDigits, 4);

  const symbol = deriveMeasurement(input('symbol', '-.75%', '%'), '%');
  assert.equal(symbol.status, 'ambiguous_unit');
  assert.equal(symbol.parsed!.decimal.value.numerator, '-3');
  assert.equal(symbol.source.valueText, '-.75%');

  const attached = deriveMeasurement(input('attached', '5kg', 'kg'), 'g');
  assert.equal(attached.conversion!.exactDecimal, '5000');
  assert.equal(attached.source.valueText, '5kg');

  for (const literal of [
    '1.00 KG',
    '1.00 kg extra',
    'prefix 1.00 kg',
    '1-2 kg',
    '1,000 kg',
    'Infinity kg',
    '1e101 kg',
  ]) {
    const result = deriveMeasurement(input('invalid-inline', literal, 'kg'), 'g');
    assert.equal(result.status, 'invalid_literal', literal);
    assert.equal(result.source.valueText, literal);
  }
  assert.equal(
    deriveMeasurement(input('exponent-unit', '1e2e2', 'e2'), 'g').status,
    'invalid_literal',
  );
});

test('display uses decimal ties-to-even symmetrically and never changes an exact comparison', () => {
  for (const [literal, expected] of [
    ['1.25', '1.2'],
    ['1.35', '1.4'],
    ['-1.25', '-1.2'],
    ['-1.35', '-1.4'],
  ])
    assert.equal(displayDecimal(parseDecimal(literal!)!.value, 1).value, expected);
  const a = input('a', '1.21', 'kg'),
    b = input('b', '1.24', 'kg');
  const compared = compareMeasurements(a, b, 'kg', 1);
  assert.equal(compared.left.conversion!.display.value, compared.right.conversion!.display.value);
  assert.equal(compared.status, 'different');
  assert.throws(() => displayDecimal(rational(1n), 31), RangeError);
  assert.throws(() => terminatingDecimal({ numerator: '0', denominator: '0' }), RangeError);
});

test('rounding consistency requires explicitly known source increments, not digits or arbitrary percentage tolerance', () => {
  const a = input('lb', '100.0', '[lb_av]'),
    b = input('kg', '45.36', 'kg');
  assert.equal(compareMeasurements(a, b, 'kg').status, 'different');
  precision(a, '0.1');
  precision(b, '0.01');
  const consistent = compareMeasurements(a, b, 'kg');
  assert.equal(consistent.status, 'consistent_with_rounding');
  assert.equal(consistent.mergeAuthorized, false);
  assert.equal(consistent.warningSuppressionAuthorized, false);
  assert.equal(consistent.clinicalEquivalence, 'not_determined');
  assert.equal(
    compareMeasurements(
      precision(input('a', '1.0', 'kg'), '0.1'),
      precision(input('b', '1.1', 'kg'), '0.1'),
      'kg',
    ).status,
    'different',
    'intervals touching only at a tie do not imply agreement',
  );
  assert.equal(
    compareMeasurements(precision(input('c', '-1.0', 'kg'), '0.1'), input('d', '-1.01', 'kg'), 'kg')
      .status,
    'consistent_with_rounding',
  );
  assert.equal(
    deriveMeasurement(precision(input('grid', '1.21', 'kg'), '0.1'), 'kg').status,
    'invalid_precision',
  );
  assert.equal(
    deriveMeasurement(precision(input('negative', '1.0', 'kg'), '-0.1'), 'kg').status,
    'invalid_precision',
  );
});

for (const [literal, status] of [
  [null, 'missing_unit'],
  ['', 'missing_unit'],
  ['lb', 'ambiguous_unit'],
  ['oz', 'ambiguous_unit'],
  ['IU', 'ambiguous_unit'],
  ['%', 'ambiguous_unit'],
  ['mM', 'ambiguous_unit'],
  ['MG/DL', 'unsupported_unit'],
  ['kg{wet}', 'unsupported_unit'],
  ['[diop]', 'unsupported_unit'],
  ['mg / dL', 'unsupported_unit'],
] as const)
  test(`missing, ambiguous and excluded source unit ${String(literal)} stays explicit`, () => {
    const source = input('a', '1.20', literal);
    const result = deriveMeasurement(source, 'kg');
    assert.equal(result.status, status);
    assert.equal(result.conversion, null);
    assert.equal(result.source.unit, literal);
  });

test('only listed unambiguous aliases resolve, with original notation preserved', () => {
  for (const unit of ['ug', 'µg', 'μg', 'micrograms']) {
    const projected = deriveMeasurement(input(unit, '1.00', unit), 'g');
    assert.equal(projected.conversion!.exactDecimal, '0.000001');
    assert.equal(projected.conversion!.usedAlias, unit !== 'ug');
    assert.equal(projected.source.unit, unit);
  }
  const concentration = {
    dimension: 'mass_concentration' as const,
    quantity: 'fictional:concentration',
  };
  assert.equal(
    deriveMeasurement(input('lower', '1.0', 'mg/dl', concentration), 'mg/dL').conversion!
      .exactDecimal,
    '1',
  );
  assert.equal(resolveMeasurementUnit('Mg').status, 'unsupported');
});

test('dimension and reviewed quantity/region/specimen/method/meaning each constrain comparison', () => {
  assert.equal(deriveMeasurement(input('mass', '1', 'g'), 'L').status, 'incompatible_dimension');
  const concentration = input('mass-concentration', '1', 'mg/L', {
    dimension: 'mass_concentration',
    quantity: 'fictional:concentration',
  });
  assert.equal(deriveMeasurement(concentration, 'mmol/L').status, 'incompatible_dimension');
  const a = input('a', '1', 'kg');
  for (const field of ['quantity', 'region', 'specimen', 'method', 'meaning'] as const) {
    const b = input('b', '1', 'kg', { [field]: 'different:' + field });
    assert.equal(compareMeasurements(a, b, 'kg').status, 'unavailable');
    b.binding!.semantics[field] = 'unknown';
    assert.equal(deriveMeasurement(b, 'kg').status, 'semantic_review_required');
  }
  assert.equal(
    deriveMeasurement(input('wrong', '1', 'kg', { dimension: 'volume' }), 'g').status,
    'incompatible_dimension',
  );
});

test('bound and approximate literals retain qualifiers after conversion and never imply exact equality', () => {
  for (const literal of ['< 1.00', '<=1.00', '≤1.00', '>1.00', '>=1.00', '≥1.00']) {
    const source = input(literal, literal, 'kg'),
      converted = deriveMeasurement(source, 'g');
    assert.equal(converted.conversion!.exactDecimal, '1000');
    assert.equal(converted.conversion!.valueRole, 'bound');
    assert.equal(compareMeasurements(source, input('point', '1000', 'g'), 'g').status, 'bounded');
  }
  for (const literal of ['~1.00', '≈1.00'])
    assert.equal(
      compareMeasurements(input('approx', literal, 'kg'), input('point', '1', 'kg'), 'kg').status,
      'approximate',
    );
  const separate = input('separate', '1.00', 'kg');
  separate.source.comparator = '<';
  assert.equal(deriveMeasurement(separate, 'g').conversion!.comparator, '<');
  assert.equal(parseMeasurementLiteral('<1', '>'), null);
  assert.equal(parseMeasurementLiteral('1', 'constructor'), null);
});

test('invalid numeric syntax and processing bounds fail without losing source text', () => {
  for (const literal of [
    '1,000',
    '1,2',
    '1-2',
    'NaN',
    'Infinity',
    '1 ± 0.2',
    '1 mg',
    'approximately 1',
    '1e101',
    '1e999999',
    '1'.repeat(257),
  ]) {
    const result = deriveMeasurement(input('bad', literal, 'kg'), 'g');
    assert.equal(result.status, 'invalid_literal');
    assert.equal(result.source.valueText, literal);
  }
});

test('same-day and same-value separate occurrences never merge, and stale semantic versions or profile/subject mismatch block comparisons', () => {
  const a = input('first', '1.000', 'kg'),
    b = input('second', '1000', 'g');
  const result = compareMeasurements(a, b, 'g');
  assert.equal(result.status, 'exact');
  assert.notEqual(result.left.reference.recordId, result.right.reference.recordId);
  assert.equal(result.mergeAuthorized, false);
  assert.equal(result.warningSuppressionAuthorized, false);
  const stale = structuredClone(b);
  stale.reference.stateHash = 'new-state';
  assert.equal(deriveMeasurement(stale, 'g').status, 'stale_semantics');
  const changedEvidence = structuredClone(b);
  changedEvidence.reference.evidenceHash = 'new-original';
  assert.equal(deriveMeasurement(changedEvidence, 'g').status, 'stale_semantics');
  const noSemantics = structuredClone(b);
  noSemantics.binding = null;
  assert.equal(deriveMeasurement(noSemantics, 'g').status, 'semantic_review_required');
  b.reference.profileId = b.binding!.reference.profileId = 'another-profile';
  assert.equal(compareMeasurements(a, b, 'g').status, 'unavailable');
  b.reference.profileId = b.binding!.reference.profileId = a.reference.profileId;
  b.binding!.subject = 'another-person';
  assert.equal(compareMeasurements(a, b, 'g').status, 'unavailable');
});
