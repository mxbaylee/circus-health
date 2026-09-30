import type { TestEvent } from 'node:test/reporters';

/** Report slow passing tests as well as failures; no reruns or pass-on-retry policy. */
export default async function* timings(source: AsyncIterable<TestEvent>) {
  const slow: { name: string; file?: string; duration: number }[] = [];
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { name, file, details } = event.data;
    if (details.type === 'suite' || details.duration_ms < 1000) continue;
    slow.push({ name, file, duration: details.duration_ms });
    slow.sort((a, b) => b.duration - a.duration);
    if (slow.length > 10) slow.pop();
  }
  if (slow.length) {
    yield '\nSlowest tests (including passes):\n';
    for (const test of slow)
      yield `  ${(test.duration / 1000).toFixed(2)}s ${test.name}${test.file ? ` — ${test.file}` : ''}\n`;
  }
}
