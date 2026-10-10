import { HttpError } from './database.ts';

export const packetOutputLimit = (provider: boolean) => (provider ? 64_000_000 : 8_000_000);
const exceeded = () => {
  throw new HttpError(
    400,
    'EXPORT_TOO_LARGE',
    'Selected text is too large for a single export. Narrow the selection.',
  );
};

/** Counts JSON text before retaining an output item. No whole payload string or
 * metadata tree is built to discover that the existing transport limit failed. */
export class PacketOutputBudget {
  used = 0;
  readonly limit: number;
  constructor(limit = packetOutputLimit(true)) {
    this.limit = limit;
  }
  add(value: unknown, separator = 0) {
    this.characters(separator);
    const visit = (node: unknown) => {
      if (Array.isArray(node)) {
        this.characters(2);
        for (let index = 0; index < node.length; index++) {
          if (index) this.characters(1);
          visit(node[index] ?? null);
        }
      } else if (node && typeof node === 'object') {
        this.characters(2);
        let first = true;
        for (const key in node) {
          if (!Object.hasOwn(node, key)) continue;
          const child = (node as Record<string, unknown>)[key];
          if (child === undefined || typeof child === 'function' || typeof child === 'symbol')
            continue;
          if (!first) this.characters(1);
          first = false;
          this.characters(JSON.stringify(key).length + 1);
          visit(child);
        }
      } else this.characters((JSON.stringify(node) ?? 'null').length);
    };
    visit(value);
  }
  characters(count: number) {
    if (!Number.isSafeInteger(count) || count < 0 || this.used + count > this.limit) exceeded();
    this.used += count;
  }
}
