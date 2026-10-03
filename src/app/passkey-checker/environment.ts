import type { BuildInfo, Environment, RunHeader } from './types.ts';
import { encodePrf } from '../components/passkey-prf.ts';

/** Report hints as browser-reported, never as proof of exact platform/provider identity. */
export function inspectEnvironment(userAgent = navigator.userAgent): Environment {
  const unknown = () => ({ value: '', source: 'unknown' as const });
  const environment: Environment = {
    browser: unknown(),
    browserVersion: unknown(),
    os: unknown(),
    osVersion: unknown(),
    provider: unknown(),
    providerVersion: unknown(),
  };
  const match =
    /(?:Edg|EdgiOS|EdgA)\/([\d.]+)/.exec(userAgent) ??
    /(?:Firefox|FxiOS)\/([\d.]+)/.exec(userAgent) ??
    /(?:Chrome|CriOS)\/([\d.]+)/.exec(userAgent) ??
    /Version\/([\d.]+).*Safari\//.exec(userAgent);
  if (match) {
    environment.browser = {
      value: /Edg/.test(match[0])
        ? 'Edge'
        : /Firefox|FxiOS/.test(match[0])
          ? 'Firefox'
          : /Chrome|CriOS/.test(match[0])
            ? 'Chrome'
            : 'Safari',
      source: 'browser-reported',
    };
    environment.browserVersion = { value: match[1], source: 'browser-reported' };
  }
  const os = /Android/.test(userAgent)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(userAgent)
      ? 'iOS/iPadOS'
      : /Windows/.test(userAgent)
        ? 'Windows'
        : /Macintosh|Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : '';
  if (os) environment.os = { value: os, source: 'browser-reported' };
  // UA OS versions are frequently frozen or ambiguous; provider identity is manual only.
  return environment;
}
export function checkSupport(): { supported: boolean; reason: string | null } {
  if (globalThis.location?.protocol !== 'https:' || !globalThis.isSecureContext)
    return { supported: false, reason: 'Open this checker over valid HTTPS in a secure context.' };
  if (
    !globalThis.navigator?.credentials ||
    typeof navigator.credentials.create !== 'function' ||
    typeof navigator.credentials.get !== 'function' ||
    typeof PublicKeyCredential === 'undefined' ||
    !globalThis.crypto?.subtle
  )
    return {
      supported: false,
      reason: 'This browser does not expose the required native credential and Web Crypto APIs.',
    };
  return { supported: true, reason: null };
}
export function createRun(build: BuildInfo, environment: Environment): RunHeader {
  return {
    schemaVersion: 1,
    id: encodePrf(crypto.getRandomValues(new Uint8Array(16)).buffer),
    origin: location.origin,
    secureContext: Boolean(globalThis.isSecureContext),
    rpId: location.hostname,
    userId: encodePrf(crypto.getRandomValues(new Uint8Array(32)).buffer),
    createdAt: new Date().toISOString(),
    build: structuredClone(build),
    environment: structuredClone(environment),
  };
}
