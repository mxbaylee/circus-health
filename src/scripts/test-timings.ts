import type { TestEvent } from 'node:test/reporters';

const ANNOTATION_LIMIT = 50;
const bounded = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
const escapeCommand = (value: string) =>
  value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

function failureMessage(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  for (let depth = 0; error && depth < 4 && !seen.has(error); depth++) {
    seen.add(error);
    if (typeof error === 'string') {
      messages.push(bounded(error, 512));
      break;
    }
    if (typeof error !== 'object') break;
    const detail = error as { message?: unknown; cause?: unknown };
    if (typeof detail.message === 'string' && detail.message)
      messages.push(bounded(detail.message, 512));
    error = detail.cause;
  }
  return bounded(messages.join(' — caused by: ') || 'Test failed without an error message', 2048);
}

/** Report slow passing tests as well as failures; no reruns or pass-on-retry policy. */
export default async function* timings(source: AsyncIterable<TestEvent>) {
  const slow: { name: string; file?: string; duration: number }[] = [];
  const annotate = process.env.GITHUB_ACTIONS === 'true';
  let failures = 0;
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { name, file, details } = event.data;
    if (annotate && event.type === 'test:fail') {
      failures++;
      if (failures <= ANNOTATION_LIMIT)
        yield `\n::error::${escapeCommand(`${bounded(name, 300)}: ${failureMessage(event.data.details.error)}`)}\n`;
    }
    if (details.type === 'suite' || details.duration_ms < 1000) continue;
    slow.push({ name, file, duration: details.duration_ms });
    slow.sort((a, b) => b.duration - a.duration);
    if (slow.length > 10) slow.pop();
  }
  if (failures > ANNOTATION_LIMIT)
    yield `\n::notice::${failures - ANNOTATION_LIMIT} additional test failure annotations omitted (limit ${ANNOTATION_LIMIT}); see test output.\n`;
  if (slow.length) {
    yield '\nSlowest tests (including passes):\n';
    for (const test of slow)
      yield `  ${(test.duration / 1000).toFixed(2)}s ${test.name}${test.file ? ` — ${test.file}` : ''}\n`;
  }
}
