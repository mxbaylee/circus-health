import { beforeEach, expect, it, vi } from 'vitest';
import {
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from '@simplewebauthn/browser';
import { enrollProfilePasskey } from '../../app/components/passkey-enrollment';

vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
}));
const controller = () => new AbortController();
const result = (data: unknown) =>
  new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });
const registration = { id: 'fictional-key', clientExtensionResults: { prf: { enabled: true } } };
const auth = {
  id: 'fictional-key',
  clientExtensionResults: { prf: { results: { first: new Uint8Array(32).buffer } } },
};
let calls: string[], fetchMock: ReturnType<typeof vi.fn>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  calls = [];
  vi.mocked(startRegistration)
    .mockReset()
    .mockResolvedValue(registration as never);
  vi.mocked(startAuthentication)
    .mockReset()
    .mockResolvedValue(auth as never);
  fetchMock = vi.fn(async (url: string) => {
    const action = url.split('/').at(-1)!;
    calls.push(action);
    if (action === 'options')
      return result({
        challengeId: 'pending',
        options: { extensions: { prf: { eval: { first: 'AQID' } } } },
      });
    if (action === 'verify')
      return result({
        challengeId: 'pending',
        options: {
          allowCredentials: [{ id: 'fictional-key' }],
          extensions: { prf: { evalByCredential: { 'fictional-key': { first: 'AQID' } } } },
        },
      });
    if (action === 'confirm') return result({ registered: true });
    if (action === 'cancel') return result({ cancelled: true });
    throw Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetchMock);
});

it.each(['buffer', 'array'])(
  'confirms a saved passkey when creation returns only PRF capability and assertion uses %s output',
  async (shape) => {
    if (shape === 'array')
      vi.mocked(startAuthentication).mockResolvedValue({
        ...auth,
        clientExtensionResults: { prf: { results: { first: new Array(32).fill(0) } } },
      } as never);
    const phases: string[] = [];
    await enrollProfilePasskey('p-fictional', {
      signal: controller().signal,
      onPhase: (phase) => phases.push(phase),
    });
    expect(phases).toEqual(['creating', 'confirming', 'saving']);
    expect(calls).toEqual(['options', 'verify', 'confirm']);
    const input = vi.mocked(startAuthentication).mock.calls[0][0].optionsJSON;
    expect([
      ...new Uint8Array((input.extensions as any).prf.evalByCredential['fictional-key'].first),
    ]).toEqual([1, 2, 3]);
    const sent = JSON.parse(
      fetchMock.mock.calls.find(([url]) => url.endsWith('/confirm'))![1].body,
    );
    expect(sent.prf).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(sent.response.clientExtensionResults.prf).not.toHaveProperty('results');
  },
);

it('does not publish an unusable passkey when authentication returns no PRF', async () => {
  vi.mocked(startAuthentication).mockResolvedValue({
    ...auth,
    clientExtensionResults: {},
  } as never);
  await expect(
    enrollProfilePasskey('p-fictional', { signal: controller().signal }),
  ).rejects.toThrow('encrypted profile');
  expect(calls).toEqual(['options', 'verify', 'cancel']);
});

it('cancels browser creation and ignores a credential returned after Skip', async () => {
  const pending = deferred<any>(),
    abort = controller();
  vi.mocked(startRegistration).mockReturnValue(pending.promise);
  const operation = enrollProfilePasskey('p-fictional', { signal: abort.signal });
  await vi.waitFor(() => expect(startRegistration).toHaveBeenCalledOnce());
  abort.abort();
  pending.resolve(registration);
  await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  expect(WebAuthnAbortService.cancelCeremony).toHaveBeenCalledOnce();
  expect(calls).toEqual(['options', 'cancel']);
  expect(startAuthentication).not.toHaveBeenCalled();
});

it('cancels a pending confirmation and never saves a late assertion', async () => {
  const pending = deferred<any>(),
    abort = controller();
  vi.mocked(startAuthentication).mockReturnValue(pending.promise);
  const operation = enrollProfilePasskey('p-fictional', { signal: abort.signal });
  await vi.waitFor(() => expect(startAuthentication).toHaveBeenCalledOnce());
  abort.abort();
  pending.resolve(auth);
  await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls).toEqual(['options', 'verify', 'cancel']);
});

it('cleans up options that arrive after Skip without opening a browser prompt', async () => {
  const pending = deferred<Response>(),
    abort = controller();
  fetchMock.mockImplementationOnce(() => pending.promise);
  const operation = enrollProfilePasskey('p-fictional', { signal: abort.signal });
  abort.abort();
  pending.resolve(result({ challengeId: 'pending', options: {} }));
  await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  expect(startRegistration).not.toHaveBeenCalled();
  expect(calls).toEqual(['cancel']);
});

it('treats a rejected server confirmation as failure and clears staged metadata', async () => {
  fetchMock.mockImplementation(async (url: string) => {
    const action = url.split('/').at(-1)!;
    calls.push(action);
    if (action === 'confirm')
      return new Response(
        JSON.stringify({
          error: { code: 'PASSKEY_CANCELLED', message: 'Profile locked during setup.' },
        }),
        { status: 409 },
      );
    return result(action === 'cancel' ? {} : { challengeId: 'pending', options: {} });
  });
  await expect(
    enrollProfilePasskey('p-fictional', { signal: controller().signal }),
  ).rejects.toThrow('Profile locked');
  expect(calls).toEqual(['options', 'verify', 'confirm', 'cancel']);
});
