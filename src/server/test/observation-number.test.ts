import test from 'node:test';
import assert from 'node:assert/strict';
import { projectObservationNumber } from '../observation-number.ts';

test('observation query projection accepts strict grouped fixed decimals and existing ungrouped syntax', () => {
  const accepted: [string, number | null, string | null][] = [
    ['1,234', 1234, null],
    ['+12,345.670', 12345.67, null],
    ['-987,654.321', -987654.321, null],
    ['<= 7,654.320', 7654.32, '<='],
    ['~ -1,000', -1000, '~'],
    ['12', 12, null],
    ['-.75', -0.75, null],
    ['1.', 1, null],
    ['> +4.20e2', 420, '>'],
    ['<1e999', null, '<'],
  ];
  for (const [literal, numeric, comparator] of accepted)
    assert.deepEqual(projectObservationNumber(literal), { numeric, comparator }, literal);
});

test('observation query projection rejects ambiguous or malformed grouping and new coercions', () => {
  for (const literal of [
    '1,23',
    '12,34',
    '12,34,567',
    '1234,567',
    '1,234,56',
    '1.234,56',
    '1 234.50',
    '1,,234',
    ',123',
    '123,',
    '$1,234.50',
    '1,234 mg',
    '1,234e2',
  ])
    assert.equal(projectObservationNumber(literal), null, literal);
  assert.equal(projectObservationNumber('1'.repeat(257)), null);
});

test('observation query projection separates only an exact structured unit from a strict literal', () => {
  const accepted: [string, string, number | null, string | null][] = [
    ['1,234.500 fictional-unit/mL', 'fictional-unit/mL', 1234.5, null],
    ['+12.50 kg', 'kg', 12.5, null],
    ['5mg', 'mg', 5, null],
    ['-.75%', '%', -0.75, null],
    ['<= 7.20 mg', 'mg', 7.2, '<='],
    ['~ -1.00e2 mg', 'mg', -100, '~'],
    ['12.00', 'mg', 12, null],
    ['<1e999 mg', 'mg', null, '<'],
  ];
  for (const [literal, unit, numeric, comparator] of accepted)
    assert.deepEqual(projectObservationNumber(literal, unit), { numeric, comparator }, literal);

  for (const [literal, unit] of [
    ['1.00 MG', 'mg'],
    ['1.00 mg', 'g'],
    ['prefix 1.00 mg', 'mg'],
    ['1-2 mg', 'mg'],
    ['1.00 mg extra', 'mg'],
    ['1,23 mg', 'mg'],
    ['Infinity mg', 'mg'],
    ['1e', 'e'],
    ['1e+', 'e+'],
    ['1e-', 'e-'],
    ['1e2e2', 'e2'],
    ['1.00 mg', ''],
    ['1.00 mg', 'mg '],
  ] as const)
    assert.equal(projectObservationNumber(literal, unit), null, `${literal} / ${unit}`);
  assert.equal(projectObservationNumber('1.00 mg'), null);
});
