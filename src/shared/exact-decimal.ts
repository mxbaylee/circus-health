/** JSON-safe exact fractions. Values never pass through a binary floating point number. */
export interface ExactRational {
  numerator: string;
  denominator: string;
}
export interface DecimalLiteral {
  value: ExactRational;
  quantum: ExactRational;
  fractionalDigits: number;
  exponent: number;
  negativeZero: boolean;
}
const abs = (n: bigint) => (n < 0n ? -n : n);
export function rational(n: bigint, d = 1n): ExactRational {
  if (d === 0n) throw new RangeError('Zero denominator');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  let a = abs(n),
    b = d;
  while (b) {
    const next = a % b;
    a = b;
    b = next;
  }
  return { numerator: String(n / a), denominator: String(d / a) };
}
export function multiply(a: ExactRational, b: ExactRational): ExactRational {
  return rational(
    BigInt(a.numerator) * BigInt(b.numerator),
    BigInt(a.denominator) * BigInt(b.denominator),
  );
}
export function divide(a: ExactRational, b: ExactRational): ExactRational {
  return rational(
    BigInt(a.numerator) * BigInt(b.denominator),
    BigInt(a.denominator) * BigInt(b.numerator),
  );
}
export function add(a: ExactRational, b: ExactRational): ExactRational {
  return rational(
    BigInt(a.numerator) * BigInt(b.denominator) + BigInt(b.numerator) * BigInt(a.denominator),
    BigInt(a.denominator) * BigInt(b.denominator),
  );
}
export const negate = (a: ExactRational): ExactRational => ({
  ...a,
  numerator: String(-BigInt(a.numerator)),
});
export const subtract = (a: ExactRational, b: ExactRational) => add(a, negate(b));
export function compare(a: ExactRational, b: ExactRational): -1 | 0 | 1 {
  const difference =
    BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
const power = (exponent: number) =>
  exponent >= 0 ? rational(10n ** BigInt(exponent)) : rational(1n, 10n ** BigInt(-exponent));
/** Bounded decimal/scientific syntax; commas, units, ranges and coercions are rejected. */
export function parseDecimal(literal: string): DecimalLiteral | null {
  if (typeof literal !== 'string' || literal.length > 256) return null;
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d{1,3}))?$/.exec(
    literal.trim(),
  );
  if (!match) return null;
  const fraction = match[3] ?? match[4] ?? '',
    digits = (match[2] || '0') + fraction;
  const exponent = Number(match[5] || 0);
  if (digits.length > 120 || Math.abs(exponent) > 100) return null;
  const coefficient = BigInt(digits) * (match[1] === '-' ? -1n : 1n);
  const quantum = power(exponent - fraction.length);
  return {
    value: multiply(rational(coefficient), quantum),
    quantum,
    fractionalDigits: fraction.length,
    exponent,
    negativeZero: coefficient === 0n && match[1] === '-',
  };
}
/** Full terminating decimal when available; null means the exact fraction repeats. */
export function terminatingDecimal(value: ExactRational): string | null {
  let d = BigInt(value.denominator),
    twos = 0,
    fives = 0;
  if (d <= 0n) throw new RangeError('Expected a positive denominator');
  while (d % 2n === 0n) {
    d /= 2n;
    twos++;
  }
  while (d % 5n === 0n) {
    d /= 5n;
    fives++;
  }
  if (d !== 1n) return null;
  const places = Math.max(twos, fives);
  return decimalDigits(
    BigInt(value.numerator) * 2n ** BigInt(places - twos) * 5n ** BigInt(places - fives),
    places,
  )
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}
function decimalDigits(n: bigint, places: number): string {
  const digits = String(abs(n)).padStart(places + 1, '0');
  return (
    (n < 0n ? '-' : '') + (places ? digits.slice(0, -places) + '.' + digits.slice(-places) : digits)
  );
}
export function displayDecimal(value: ExactRational, places = 12) {
  if (!Number.isSafeInteger(places) || places < 0 || places > 30)
    throw new RangeError('Display decimal places must be between 0 and 30');
  const denominator = BigInt(value.denominator),
    numerator = BigInt(value.numerator),
    scale = 10n ** BigInt(places);
  if (denominator <= 0n) throw new RangeError('Expected a positive denominator');
  const scaled = abs(numerator) * scale;
  let quotient = scaled / denominator;
  const remainder = scaled % denominator;
  if (2n * remainder > denominator || (2n * remainder === denominator && quotient % 2n !== 0n))
    quotient++;
  if (numerator < 0n) quotient = -quotient;
  const rounded = rational(quotient, scale);
  return {
    value: decimalDigits(quotient, places),
    decimalPlaces: places,
    mode: 'nearest_ties_even' as const,
    applied: remainder !== 0n,
    error: subtract(rounded, value),
  };
}
