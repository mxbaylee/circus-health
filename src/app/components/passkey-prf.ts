const decode = (value: string) => {
  const text = value.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  return bytes.buffer;
};
export const encodePrf = (value: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
/** Convert the server's JSON PRF salts to WebAuthn BufferSources. */
export function withBinaryPrf<T extends Record<string, unknown>>(options: T): T {
  const extensions = options.extensions as Record<string, unknown> | undefined;
  const prf = extensions?.prf as Record<string, unknown> | undefined;
  const evalValue = prf?.eval as Record<string, unknown> | undefined;
  if (!prf) return options;
  const converted = evalValue && { ...evalValue };
  for (const key of ['first', 'second'])
    if (converted && typeof converted[key] === 'string')
      converted[key] = decode(converted[key] as string);
  const byCredential = prf?.evalByCredential as Record<string, Record<string, unknown>> | undefined;
  const evalByCredential =
    byCredential &&
    Object.fromEntries(
      Object.entries(byCredential).map(([id, salts]) => [
        id,
        Object.fromEntries(
          Object.entries(salts).map(([key, value]) => [
            key,
            (key === 'first' || key === 'second') && typeof value === 'string'
              ? decode(value)
              : value,
          ]),
        ),
      ]),
    );
  return {
    ...options,
    extensions: {
      ...extensions,
      prf: {
        ...prf,
        ...(converted ? { eval: converted } : {}),
        ...(evalByCredential ? { evalByCredential } : {}),
      },
    },
  };
}
export function prfFrom(response: { clientExtensionResults?: unknown }): string | null {
  const result = (
    response.clientExtensionResults as { prf?: { results?: { first?: unknown } } } | undefined
  )?.prf?.results?.first;
  // 1Password FS-5593 reports plain byte arrays in Firefox/Chrome. Accept only
  // a complete 32-byte array, without coercing strings, fractions or holes.
  if (Array.isArray(result)) {
    if (
      result.length !== 32 ||
      !Array.from(result).every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    )
      return null;
    return encodePrf(Uint8Array.from(result).buffer);
  }
  // Native WebAuthn returns BufferSources; WebAuthn JSON uses base64url. A
  // password-manager extension may return a buffer from another JS realm.
  if (typeof result === 'string') {
    if (!/^[A-Za-z0-9_-]{43}$/.test(result)) return null;
    try {
      return encodePrf(decode(result)) === result ? result : null;
    } catch {
      return null;
    }
  }
  const bytes = ArrayBuffer.isView(result)
    ? new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
    : Object.prototype.toString.call(result) === '[object ArrayBuffer]'
      ? new Uint8Array(result as ArrayBuffer)
      : null;
  return bytes?.byteLength === 32 ? encodePrf(bytes.slice().buffer) : null;
}
