import { statSync } from 'node:fs';

/** Keep physical proof workers independent of the application module graph. */
export function regularFileIdentity(path: string): string | undefined {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile()) return undefined;
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
