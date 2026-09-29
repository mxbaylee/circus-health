import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sanitizeBuildIdentity, type BuildIdentity } from '../shared/build-identity.ts';

/** Deployment metadata only. A missing/unbuilt artifact is unknown, not a new build. */
export function readBuildIdentity(codeRoot: string): BuildIdentity {
  try {
    return sanitizeBuildIdentity(
      JSON.parse(readFileSync(resolve(codeRoot, 'src/dist/build-info.json'), 'utf8')),
    );
  } catch {
    return sanitizeBuildIdentity(null);
  }
}
export function readBuildId(codeRoot: string): string | null {
  return readBuildIdentity(codeRoot).buildId;
}
