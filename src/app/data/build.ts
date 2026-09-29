import { sanitizeBuildIdentity, type BuildSourceIdentity } from '../../shared/build-identity.ts';
// Vite embeds the identity from the same build that emits dist/build-info.json.
// Contributor tests and unbundled development have no release identity.
declare const __CIRCUS_BUILD_ID__: string | null;
export const CLIENT_BUILD_ID: string | null =
  typeof __CIRCUS_BUILD_ID__ === 'undefined' ? null : __CIRCUS_BUILD_ID__;

declare const __CIRCUS_BUILD_SOURCE__: BuildSourceIdentity | null;
export const CLIENT_BUILD_IDENTITY = sanitizeBuildIdentity({
  ...(typeof __CIRCUS_BUILD_SOURCE__ === 'undefined' ? {} : __CIRCUS_BUILD_SOURCE__),
  buildId: CLIENT_BUILD_ID,
});
