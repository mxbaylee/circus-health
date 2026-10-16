/** Test-only response diagnostic. Never emit a stack, path, request identity, or error text. */
const modules = new Map([
  ['intake-report-group-collection', 'group'],
  ['intake-report-queue-collection', 'queue'],
  ['intake-queue-native', 'native'],
  ['intake-queue-page-collection', 'page'],
  ['intake-queue-activity-collection', 'activity'],
  ['intake-import-feed-collection', 'feed'],
]);
const frame = /[/\\]src[/\\]server[/\\]([a-z-]+)\.ts:([1-9]\d{0,4}):\d+/;
const label = '(?:group|queue|native|page|activity|feed):[1-9]\\d{0,4}';
const header = new RegExp(`^${label}(?:>${label}){0,2}$`);

export const REPORT_QUEUE_GUARD_HEADER = 'X-Crs-Test-Queue-Guard';

export function reportQueueGuardLocation(error: unknown): string | undefined {
  try {
    if (!(error instanceof Error)) return undefined;
    const stack = error.stack;
    if (typeof stack !== 'string') return undefined;
    const found: string[] = [];
    for (const line of stack.slice(0, 8192).split('\n').slice(1, 24)) {
      const match = frame.exec(line);
      const name = match && modules.get(match[1]!);
      if (!name) continue;
      found.push(`${name}:${match![2]}`);
      if (found.length === 3) break;
    }
    return found.length ? found.join('>') : undefined;
  } catch {
    return undefined;
  }
}

/** Browser fixtures accept only the exact compact grammar, not arbitrary headers. */
export function reportQueueGuardHeader(value: string | null): string | undefined {
  return value && value.length <= 80 && header.test(value) ? value : undefined;
}
