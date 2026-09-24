import { beforeEach, expect, it, vi } from 'vitest';
import { startAuthentication, WebAuthnAbortService } from '@simplewebauthn/browser';
import { unlockProfilePasskey } from '../../app/components/passkey-unlock';
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
}));
const result = (data: unknown) => new Response(JSON.stringify({ data }));
const auth = {
  id: 'fictional-key',
  clientExtensionResults: { prf: { results: { first: new Array(32).fill(0) } } },
};
const profile = { id: 'fictional-profile', name: 'Robin', placebo: false, locked: false };
let fetchMock: ReturnType<typeof vi.fn>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.mocked(startAuthentication)
    .mockReset()
    .mockResolvedValue(auth as never);
  vi.mocked(WebAuthnAbortService.cancelCeremony).mockClear();
  fetchMock = vi.fn(async (url: string) =>
    result(
      url.endsWith('/authentication-options') ? { challengeId: 'pending', options: {} } : profile,
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
});
it('unlocks with 1Password byte-array PRF and reports saving before the POST', async () => {
  const phases: string[] = [];
  expect(
    await unlockProfilePasskey(profile.id, {
      signal: new AbortController().signal,
      onPhase: (phase) => phases.push(phase),
    }),
  ).toEqual(profile);
  expect(phases).toEqual(['waiting', 'saving']);
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).prf).toBe(
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  );
  expect(
    JSON.parse(fetchMock.mock.calls[1][1].body).response.clientExtensionResults.prf,
  ).not.toHaveProperty('results');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('cancels a pending browser request and rejects a late assertion without authenticating', async () => {
  const pending = deferred<any>(),
    controller = new AbortController();
  vi.mocked(startAuthentication).mockReturnValue(pending.promise);
  const operation = unlockProfilePasskey(profile.id, { signal: controller.signal });
  await vi.waitFor(() => expect(startAuthentication).toHaveBeenCalledOnce());
  controller.abort();
  pending.resolve(auth);
  await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  expect(WebAuthnAbortService.cancelCeremony).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls.map(([url]) => url.split('/').at(-1))).toEqual([
    'authentication-options',
    'cancel',
  ]);
});
it('cancels options arriving after abandonment without a browser prompt', async () => {
  const pending = deferred<Response>(),
    controller = new AbortController();
  fetchMock.mockImplementationOnce(() => pending.promise);
  const operation = unlockProfilePasskey(profile.id, { signal: controller.signal });
  controller.abort();
  pending.resolve(result({ challengeId: 'late', options: {} }));
  await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  expect(startAuthentication).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls[1][0]).toMatch(/cancel$/);
});
it('sanitizes browser errors and invalidates the challenge', async () => {
  vi.mocked(startAuthentication).mockRejectedValue(new Error('sensitive browser details'));
  await expect(
    unlockProfilePasskey(profile.id, { signal: new AbortController().signal }),
  ).rejects.toThrow('Try again or use your recovery key');
  expect(fetchMock.mock.calls.at(-1)![0]).toMatch(/cancel$/);
});
it('does not authenticate an assertion without PRF', async () => {
  vi.mocked(startAuthentication).mockResolvedValue({
    ...auth,
    clientExtensionResults: {},
  } as never);
  await expect(
    unlockProfilePasskey(profile.id, { signal: new AbortController().signal }),
  ).rejects.toThrow('encrypted profile');
  expect(fetchMock.mock.calls.map(([url]) => url.split('/').at(-1))).toEqual([
    'authentication-options',
    'cancel',
  ]);
});
