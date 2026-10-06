import { createCheckerController } from '../app/passkey-checker/controller.ts';
import type { ControllerOptions } from '../app/passkey-checker/controller.ts';
import * as core from '../app/passkey-checker/core.ts';
import { inspectEnvironment } from '../app/passkey-checker/environment.ts';
import type { CredentialAlias, RunHeader } from '../app/passkey-checker/types.ts';

/** Controlled fictional port, never a physical/provider observation or shipped adapter. */
export async function guidedFixture(input: {
  mode?: 'eval' | 'enable-only';
  openStore?: ControllerOptions['openStore'];
  failCreate?: Set<CredentialAlias>;
  wrongCredential?: Set<CredentialAlias>;
  badPrfLength?: number;
  synchronousFailure?: boolean;
} = {}) {
  const calls: { alias: CredentialAlias; options: CredentialCreationOptions }[] = [];
  const gets: CredentialRequestOptions[] = [];
  let creating: CredentialAlias = 'A';
  let extensionReads = 0;
  const bytesFor = (alias: CredentialAlias) => new Uint8Array(32).fill({ A: 1, B: 2, C: 3 }[alias]);
  const credential = (id: Uint8Array<ArrayBuffer>) => ({
    type: 'public-key',
    id: btoa(String.fromCharCode(...id)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''),
    rawId: id.buffer,
    getClientExtensionResults() {
      extensionReads++;
      return { prf: { enabled: true, results: { first: new Uint8Array(input.badPrfLength ?? 32).fill(id[0]).buffer } } };
    },
  }) as unknown as Credential;
  const port: core.CredentialPort = {
    create(options) {
      calls.push({ alias: creating, options });
      if (input.failCreate?.has(creating)) {
        const error = new DOMException('Fictional native refusal for this attempt.', 'UnknownError');
        if (input.synchronousFailure) throw error;
        return Promise.reject(error);
      }
      return Promise.resolve(credential(bytesFor(creating)));
    },
    get(options) {
      gets.push(options);
      let id = new Uint8Array(options.publicKey!.allowCredentials![0].id as ArrayBuffer);
      const alias = (['A', 'B', 'C'] as const)[id[0] - 1];
      if (input.wrongCredential?.has(alias)) id = bytesFor(alias === 'A' ? 'B' : 'A');
      return Promise.resolve(credential(id));
    },
  };
  const options: ControllerOptions = {
    guidedMode: input.mode ?? 'eval',
    build: { version: '3', revision: 'a'.repeat(40), worktree: 'clean' },
    environment: inspectEnvironment('Fictional browser'),
    newRun: (build, environment): RunHeader => ({
      schemaVersion: 1, id: `fictional-${crypto.randomUUID()}`, origin: 'https://example.test',
      rpId: 'example.test', userId: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''), secureContext: true,
      createdAt: new Date().toISOString(), build, environment,
    }),
    openStore: input.openStore ?? (async () => { throw new Error('Fictional unavailable storage'); }),
    core: {
      createCredential: (run, alias, existing, _port, observer) => {
        creating = alias;
        return core.createCredential(run, alias, existing, port, observer, input.mode ?? 'eval');
      },
      confirmCredential: (run, item, _port, observer) => core.confirmCredential(run, item, port, observer),
      verifyCredential: (run, item, _port, observer) => core.verifyCredential(run, item, port, observer),
    },
  };
  const controller = await createCheckerController(options);
  if (!input.openStore) controller.continueInMemory();
  return { controller, calls, gets, options, extensionReads: () => extensionReads };
}
