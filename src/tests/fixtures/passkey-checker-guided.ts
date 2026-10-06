import * as operations from '../../app/passkey-checker/core.ts';
import type { CredentialPort } from '../../app/passkey-checker/core.ts';
import { encodePrf } from '../../app/components/passkey-prf.ts';
import { inspectEnvironment } from '../../app/passkey-checker/environment.ts';
import type { CredentialAlias, RunHeader } from '../../app/passkey-checker/types.ts';

/** Controlled ports are test-only. Crypto, request construction and strict decoding remain real. */
export function guidedRun(mode: 'eval' | 'enable-only' = 'eval'): RunHeader {
  return {
    schemaVersion: 1,
    flow: 'abc-username-v1',
    registrationMode: mode,
    id: 'fictional-guided-run',
    origin: globalThis.location?.origin ?? 'https://example.test',
    rpId: globalThis.location?.hostname ?? 'example.test',
    secureContext: true,
    userId: encodePrf(new Uint8Array(32).fill(9).buffer),
    createdAt: '2026-10-05T00:00:00.000Z',
    build: { version: '3', revision: 'fictional-guided-build', worktree: 'clean' },
    environment: inspectEnvironment(''),
  };
}
export function guidedCore() {
  const creations: CredentialCreationOptions[] = [];
  const assertions: CredentialRequestOptions[] = [];
  const refuseCreate = new Set<CredentialAlias>();
  const refuseGet = new Set<CredentialAlias>();
  const wrongGet = new Set<CredentialAlias>();
  const changedOutput = new Set<CredentialAlias>();
  const noOutput = new Set<CredentialAlias>();
  const nativeError = new DOMException('Fictional native refusal', 'UnknownError');
  let extensionReads = 0;
  const aliases = ['A', 'B', 'C'] as const;
  const raw = (alias: CredentialAlias) =>
    new Uint8Array(16).fill(aliases.indexOf(alias) + 1).buffer;
  function credential(alias: CredentialAlias, creation: boolean): Credential {
    return {
      type: 'public-key',
      id: encodePrf(raw(alias)),
      rawId: raw(alias),
      getClientExtensionResults() {
        extensionReads++;
        return creation
          ? { prf: { enabled: true }, credProps: { rk: true } }
          : noOutput.has(alias)
            ? { prf: {} }
            : {
                prf: {
                  results: {
                    first: Array(32).fill(
                      changedOutput.has(alias) ? 99 : aliases.indexOf(alias) + 7,
                    ),
                  },
                },
              };
      },
    } as unknown as Credential;
  }
  function port(alias: CredentialAlias): CredentialPort {
    return {
      create(options) {
        creations.push(structuredClone(options));
        return refuseCreate.has(alias)
          ? Promise.reject(nativeError)
          : Promise.resolve(credential(alias, true));
      },
      get(options) {
        assertions.push(structuredClone(options));
        return refuseGet.has(alias)
          ? Promise.reject(nativeError)
          : Promise.resolve(
              credential(wrongGet.has(alias) ? (alias === 'A' ? 'B' : 'A') : alias, false),
            );
      },
    };
  }
  const core: Pick<
    typeof operations,
    'createCredential' | 'confirmCredential' | 'verifyCredential'
  > = {
    createCredential: (run, alias, existing, _port, observer) =>
      operations.createCredential(run, alias, existing, port(alias), observer),
    confirmCredential: (run, value, _port, observer) =>
      operations.confirmCredential(run, value, port(value.alias), observer),
    verifyCredential: (run, value, _port, observer) =>
      operations.verifyCredential(run, value, port(value.alias), observer),
  };
  return {
    core,
    creations,
    assertions,
    refuseCreate,
    refuseGet,
    wrongGet,
    changedOutput,
    noOutput,
    nativeError,
    extensionReads: () => extensionReads,
  };
}
