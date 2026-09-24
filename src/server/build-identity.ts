import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Deployment metadata only. A missing/unbuilt artifact is unknown, not a new build. */
export function readBuildId(codeRoot: string): string | null {
  try {
    const { buildId } = JSON.parse(
      readFileSync(resolve(codeRoot, 'src/dist/build-info.json'), 'utf8'),
    );
    return typeof buildId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(buildId)
      ? buildId
      : null;
  } catch {
    return null;
  }
}
