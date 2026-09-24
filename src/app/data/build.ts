// Vite embeds the identity from the same build that emits dist/build-info.json.
// Contributor tests and unbundled development have no release identity.
declare const __CIRCUS_BUILD_ID__: string | null;
export const CLIENT_BUILD_ID: string | null =
  typeof __CIRCUS_BUILD_ID__ === 'undefined' ? null : __CIRCUS_BUILD_ID__;
