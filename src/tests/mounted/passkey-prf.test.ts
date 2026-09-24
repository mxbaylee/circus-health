import { describe, expect, it } from 'vitest';
import { prfFrom, withBinaryPrf } from '../../app/components/passkey-prf';
import { runInNewContext } from 'node:vm';

describe('PRF browser serialization', () => {
  it('decodes JSON salts and encodes an authenticator result', () => {
    const options = withBinaryPrf({
      extensions: {
        prf: { eval: { first: 'AQID' }, evalByCredential: { abc: { first: 'BAUG' } } },
      },
    });
    const extension = options.extensions as unknown as {
      prf: { eval: { first: ArrayBuffer }; evalByCredential: { abc: { first: ArrayBuffer } } };
    };
    expect([...new Uint8Array(extension.prf.eval.first)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(extension.prf.evalByCredential.abc.first)]).toEqual([4, 5, 6]);
    expect(
      prfFrom({
        clientExtensionResults: {
          prf: { results: { first: new Uint8Array(32).fill(255).buffer } },
        },
      }),
    ).toBe('__________________________________________8');
  });
  it('decodes authentication salts when only evalByCredential is present, without mutating input', () => {
    const input = {
      extensions: { prf: { evalByCredential: { abc: { first: 'AQID' }, xyz: { first: 'BAUG' } } } },
    };
    const options = withBinaryPrf(input);
    const salts = options.extensions.prf.evalByCredential as unknown as Record<
      string,
      { first: ArrayBuffer }
    >;
    expect([...new Uint8Array(salts.abc.first)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(salts.xyz.first)]).toEqual([4, 5, 6]);
    expect(input.extensions.prf.evalByCredential.abc.first).toBe('AQID');
    expect(options.extensions.prf).not.toHaveProperty('eval');
  });
  it('accepts exact 32-byte native, cross-realm, sliced buffer and JSON results', () => {
    const expected = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const backing = new Uint8Array(40);
    backing.fill(255, 0, 4);
    backing.fill(255, 36);
    for (const first of [
      new Uint8Array(32).buffer,
      runInNewContext('new ArrayBuffer(32)'),
      backing.subarray(4, 36),
      new DataView(backing.buffer, 4, 32),
      expected,
    ]) {
      expect(prfFrom({ clientExtensionResults: { prf: { results: { first } } } })).toBe(expected);
    }
  });
  it('normalizes the reported 1Password plain-array output without changing its bytes', () => {
    const bytes = Array.from({ length: 32 }, (_, index) => index * 8);
    const native = prfFrom({
      clientExtensionResults: { prf: { results: { first: Uint8Array.from(bytes).buffer } } },
    });
    expect(prfFrom({ clientExtensionResults: { prf: { results: { first: bytes } } } })).toBe(
      native,
    );
    expect(native).not.toBeNull();
  });
  it('rejects incomplete, sparse and non-byte arrays without coercion', () => {
    const zeros = new Array(32).fill(0);
    for (const first of [
      zeros.slice(1),
      [...zeros, 0],
      new Array(32),
      ...[-1, 256, 1.5, NaN, Infinity, '0', null, undefined, true].map((value) => [
        value,
        ...zeros.slice(1),
      ]),
    ]) {
      expect(prfFrom({ clientExtensionResults: { prf: { results: { first } } } })).toBeNull();
    }
  });
  it('rejects missing, malformed, noncanonical and wrong-size results', () => {
    for (const first of [
      undefined,
      {},
      [],
      new ArrayBuffer(31),
      new ArrayBuffer(33),
      '',
      'AQID',
      'A'.repeat(42) + 'B',
      'A'.repeat(42) + '=',
    ]) {
      expect(prfFrom({ clientExtensionResults: { prf: { results: { first } } } })).toBeNull();
    }
  });
  it('returns null when an authenticator does not support PRF', () =>
    expect(prfFrom({ clientExtensionResults: {} })).toBeNull());
});
