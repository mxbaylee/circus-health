import { isDebugReport } from './debug.ts';

/** Keep exception text and stacks verbatim; binary and cryptographic values stay local. */
function reportValue(value: unknown, path: string[] = []): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => reportValue(entry, path));
  const input = value as Record<string, unknown>;
  if (Object.hasOwn(input, '$binary')) {
    const { $binary: _bytes, ...metadata } = input;
    return { ...metadata, $omitted: 'Binary material retained locally; not exported.' };
  }
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(input)) {
    const cryptoValue =
      ['salt', 'cipher', 'userId'].includes(key) ||
      (path.includes('prf') && ['first', 'second'].includes(key));
    output[key] = cryptoValue
      ? { $omitted: 'Cryptographic test input/output retained locally; not exported.' }
      : reportValue(entry, [...path, key]);
  }
  return output;
}

/** JSON inside a fixed fence is data, not report instructions or executable markup. */
export function debugMarkdown(value: unknown): string[] {
  if (!isDebugReport(value))
    return ['', 'Full error trace unavailable for this attempt (older or interrupted capture).', ''];
  const json = JSON.stringify(reportValue(JSON.parse(value)), null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return [
    '',
    '#### Browser error and operation trace',
    '',
    'Original error messages, available stacks and causes are included without text truncation ' +
      'except explicitly marked resource limits. The invocation stack is separately labelled. ' +
      'Binary and cryptographic values remain local; each omitted value is marked. ' +
      'This is not an unrestricted raw-data export. Provider internals are not accessible.',
    '',
    '```json',
    json,
    '```',
    '',
  ];
}
