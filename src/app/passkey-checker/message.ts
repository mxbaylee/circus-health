/** A bounded native message excerpt, not serialization of an exception or native payload. */
export interface NativeMessage {
  state: 'text' | 'absent' | 'non-text' | 'unavailable';
  length?: number;
  text?: string;
  truncated?: boolean;
  redacted?: boolean;
}
const LIMIT = 1024;

export function messageEvidence(error: unknown, references: readonly string[] = []): NativeMessage {
  try {
    const value =
      typeof error === 'string'
        ? error
        : error !== null && typeof error === 'object'
          ? Reflect.get(error, 'message')
          : undefined;
    if (value === undefined) return { state: 'absent' };
    if (typeof value !== 'string') return { state: 'non-text' };
    // Only retain a bounded prefix. Never traverse cause/credential/request objects or serializers.
    let text = value.slice(0, LIMIT);
    const initial = text;
    const forms = new Set(references.filter(Boolean));
    for (const reference of references) {
      try {
        const raw = atob(reference.replace(/-/g, '+').replace(/_/g, '/'));
        const bytes = Array.from(raw, (char) => char.charCodeAt(0));
        const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
        for (const form of [
          raw,
          btoa(raw),
          hex,
          hex.toUpperCase(),
          bytes.join(','),
          bytes.join(', '),
        ])
          if (form) forms.add(form);
      } catch {
        /* A non-encoded known reference is still redacted verbatim. */
      }
    }
    for (const reference of [...forms].sort((a, b) => b.length - a.length))
      text = text.split(reference).join('[reference omitted]');
    text = text
      .replace(/https?:\/\/[^\s]+/g, '[URL omitted]')
      .replace(/\[(?:\s*\d{1,3}\s*,)*\s*\d{1,3}\s*\]/g, '[byte array omitted]')
      .replace(/[A-Za-z0-9+/_=-]{24,}/g, '[opaque value omitted]')
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
    return {
      state: 'text',
      length: value.length,
      text: text.slice(0, LIMIT),
      truncated: value.length > LIMIT || text.length > LIMIT,
      redacted: text !== initial,
    };
  } catch {
    return { state: 'unavailable' };
  }
}

export function validNativeMessage(value: unknown): value is NativeMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some(
      (key) => !['state', 'length', 'text', 'truncated', 'redacted'].includes(key),
    )
  )
    return false;
  if (item.state === 'text')
    return (
      typeof item.text === 'string' &&
      item.text.length <= LIMIT &&
      Number.isSafeInteger(item.length) &&
      Number(item.length) >= 0 &&
      typeof item.truncated === 'boolean' &&
      typeof item.redacted === 'boolean'
    );
  return (
    ['absent', 'non-text', 'unavailable'].includes(String(item.state)) &&
    Object.keys(item).length === 1
  );
}
