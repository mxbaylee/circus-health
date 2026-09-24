import { parseDecimal, divide, type ExactRational } from './exact-decimal.ts';

export const MEASUREMENT_RULE_VERSION = 'circus-measurement-v1-ucum-2.2';
export type MeasurementDimension =
  'mass' | 'length' | 'volume' | 'mass_concentration' | 'amount_concentration';
export interface MeasurementUnit {
  code: string;
  dimension: MeasurementDimension;
  base: string;
  factor: ExactRational;
}
// A fixed, case-sensitive subset, not a general UCUM parser. Sources/limits: docs/measurement-comparison.md.
const groups: [MeasurementDimension, string, [string, string][]][] = [
  [
    'mass',
    'g',
    [
      ['kg', '1000'],
      ['g', '1'],
      ['mg', '0.001'],
      ['ug', '0.000001'],
      ['ng', '0.000000001'],
      ['[lb_av]', '453.59237'],
      ['[oz_av]', '28.349523125'],
    ],
  ],
  [
    'length',
    'm',
    [
      ['m', '1'],
      ['cm', '0.01'],
      ['mm', '0.001'],
    ],
  ],
  [
    'volume',
    'L',
    [
      ['L', '1'],
      ['dL', '0.1'],
      ['mL', '0.001'],
      ['uL', '0.000001'],
    ],
  ],
  [
    'mass_concentration',
    'g/L',
    [
      ['g/L', '1'],
      ['mg/L', '0.001'],
      ['ug/L', '0.000001'],
      ['ng/L', '0.000000001'],
      ['g/dL', '10'],
      ['mg/dL', '0.01'],
      ['ug/dL', '0.00001'],
      ['ng/dL', '0.00000001'],
      ['g/mL', '1000'],
      ['mg/mL', '1'],
      ['ug/mL', '0.001'],
      ['ng/mL', '0.000001'],
    ],
  ],
  [
    'amount_concentration',
    'mol/L',
    [
      ['mol/L', '1'],
      ['mmol/L', '0.001'],
      ['umol/L', '0.000001'],
      ['nmol/L', '0.000000001'],
    ],
  ],
];
const registry = new Map(
  groups.flatMap(([dimension, base, units]) =>
    units.map(
      ([code, factor]) =>
        [code, { code, dimension, base, factor: parseDecimal(factor)!.value }] as const,
    ),
  ),
);
const aliases: Record<string, string> = {
  gram: 'g',
  grams: 'g',
  kilogram: 'kg',
  kilograms: 'kg',
  milligram: 'mg',
  milligrams: 'mg',
  microgram: 'ug',
  micrograms: 'ug',
  µg: 'ug',
  μg: 'ug',
  l: 'L',
  dl: 'dL',
  ml: 'mL',
  ul: 'uL',
  µL: 'uL',
  μL: 'uL',
};
for (const unit of registry.keys()) {
  if (unit.includes('/')) {
    aliases[unit.replace('/L', '/l').replace('/dL', '/dl').replace('/mL', '/ml')] = unit;
    if (unit.startsWith('u')) {
      aliases['µ' + unit.slice(1)] = unit;
      aliases['μ' + unit.slice(1)] = unit;
    }
  }
}
export function resolveMeasurementUnit(
  literal: string | null | undefined,
):
  | { status: 'supported'; unit: MeasurementUnit; alias: boolean }
  | { status: 'missing' | 'ambiguous' | 'unsupported' } {
  if (typeof literal !== 'string' || !literal.trim()) return { status: 'missing' };
  const text = literal.trim();
  if (
    ['lb', 'lbs', 'pound', 'pounds', 'oz', 'ounce', 'ounces', 'U', 'IU', '%', 'mM', 'M'].includes(
      text,
    )
  )
    return { status: 'ambiguous' };
  const direct = registry.get(text),
    canonical = aliases[text],
    unit = direct || registry.get(canonical);
  return unit
    ? { status: 'supported', unit: structuredClone(unit), alias: literal !== unit.code }
    : { status: 'unsupported' };
}
export function measurementConversion(
  from: MeasurementUnit,
  to: MeasurementUnit,
): ExactRational | null {
  return from.dimension === to.dimension ? divide(from.factor, to.factor) : null;
}
export const supportedMeasurementUnits = (): MeasurementUnit[] =>
  [...registry.values()].map((unit) => structuredClone(unit));
