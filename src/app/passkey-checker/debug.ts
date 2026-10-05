/** Error-only diagnostics for the fictional hosted checker, not production authentication. */
export const ERROR_EVIDENCE_SCHEMA = 'checker-error-v1';
export const ERROR_EVIDENCE_LIMITS = {
  text: 32_768,
  totalText: 65_536,
  nodes: 8,
  depth: 4,
  json: 512 * 1024,
} as const;
const TEXT_FIELDS = ['name', 'message', 'stack', 'fileName'] as const;
const NUMBER_FIELDS = ['code', 'lineNumber', 'columnNumber'] as const;
const MARKERS = ['unavailable', 'absent', 'nonText', 'truncated'] as const;
const READABLE_FIELDS: readonly string[] = [...TEXT_FIELDS, ...NUMBER_FIELDS, 'cause', 'errors'];
interface ErrorNode {
  name?: string;
  message?: string;
  stack?: string;
  fileName?: string;
  code?: number;
  lineNumber?: number;
  columnNumber?: number;
  cause?: ErrorNode;
  errors?: ErrorNode[];
  unavailable: string[];
  absent: string[];
  nonText: string[];
  truncated: string[];
  omitted?: 'cycle' | 'depth' | 'nodes' | 'non-error value';
}
const empty = (): ErrorNode => ({ unavailable: [], absent: [], nonText: [], truncated: [] });

/** Only named error fields are read. Never enumerate a thrown object or stringify its payload. */
export function captureErrorEvidence(error: unknown): string {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let remainingText: number = ERROR_EVIDENCE_LIMITS.totalText;
  const visit = (value: unknown, depth: number): ErrorNode => {
    const node = empty();
    if (nodes >= ERROR_EVIDENCE_LIMITS.nodes) return { ...node, omitted: 'nodes' };
    nodes++;
    if (depth > ERROR_EVIDENCE_LIMITS.depth) return { ...node, omitted: 'depth' };
    const text = (key: (typeof TEXT_FIELDS)[number], input: unknown) => {
      if (input === undefined) node.absent.push(key);
      else if (typeof input !== 'string') node.nonText.push(key);
      else {
        const count = Math.min(input.length, ERROR_EVIDENCE_LIMITS.text, remainingText);
        node[key] = input.slice(0, count);
        remainingText -= count;
        if (count < input.length) node.truncated.push(key);
      }
    };
    if (typeof value === 'string') {
      text('message', value);
      node.absent.push('name', 'stack');
      return node;
    }
    if (!value || typeof value !== 'object') return { ...node, omitted: 'non-error value' };
    if (seen.has(value)) return { ...node, omitted: 'cycle' };
    seen.add(value);
    const read = (key: string): unknown => {
      try {
        return Reflect.get(value, key);
      } catch {
        node.unavailable.push(key);
        return undefined;
      }
    };
    for (const key of TEXT_FIELDS) {
      const field = read(key);
      if (!node.unavailable.includes(key)) text(key, field);
    }
    for (const key of NUMBER_FIELDS) {
      const field = read(key);
      if (typeof field === 'number' && Number.isSafeInteger(field)) node[key] = field;
    }
    const cause = read('cause');
    if (cause !== undefined) node.cause = visit(cause, depth + 1);
    const errors = read('errors');
    try {
      if (Array.isArray(errors)) {
        node.errors = [];
        const length = errors.length;
        for (let index = 0; index < length && nodes < ERROR_EVIDENCE_LIMITS.nodes; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(errors, String(index));
          if (!descriptor || !('value' in descriptor)) {
            node.unavailable.push('errors');
            break;
          }
          node.errors.push(visit(descriptor.value, depth + 1));
        }
        if (node.errors.length < length) node.truncated.push('errors');
      }
    } catch {
      node.unavailable.push('errors');
    }
    return node;
  };
  try {
    return JSON.stringify({ schema: ERROR_EVIDENCE_SCHEMA, error: visit(error, 0) });
  } catch {
    return JSON.stringify({
      schema: ERROR_EVIDENCE_SCHEMA,
      error: { ...empty(), unavailable: ['message', 'stack'] },
    });
  }
}

/** Persisted evidence accepts only the error schema, not arbitrary credential/request objects. */
export function isErrorEvidence(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > ERROR_EVIDENCE_LIMITS.json) return false;
  let nodes = 0;
  let text = 0;
  const record = (input: unknown): input is Record<string, unknown> =>
    !!input && typeof input === 'object' && !Array.isArray(input);
  const valid = (input: unknown, depth: number): boolean => {
    if (!record(input) || ++nodes > 32 || depth > ERROR_EVIDENCE_LIMITS.depth + 1) return false;
    if (
      !Object.keys(input).every((key) => [...READABLE_FIELDS, ...MARKERS, 'omitted'].includes(key))
    )
      return false;
    for (const key of MARKERS) {
      const entries = input[key];
      if (
        !Array.isArray(entries) ||
        entries.length > 12 ||
        !entries.every((item) => typeof item === 'string' && READABLE_FIELDS.includes(item))
      )
        return false;
    }
    for (const key of TEXT_FIELDS) {
      const field = input[key];
      if (field !== undefined) {
        if (typeof field !== 'string' || field.length > ERROR_EVIDENCE_LIMITS.text) return false;
        text += field.length;
      }
    }
    if (text > ERROR_EVIDENCE_LIMITS.totalText) return false;
    for (const key of NUMBER_FIELDS)
      if (input[key] !== undefined && !Number.isSafeInteger(input[key])) return false;
    if (
      input.omitted !== undefined &&
      !['cycle', 'depth', 'nodes', 'non-error value'].includes(String(input.omitted))
    )
      return false;
    if (input.cause !== undefined && !valid(input.cause, depth + 1)) return false;
    if (
      input.errors !== undefined &&
      (!Array.isArray(input.errors) ||
        input.errors.length > ERROR_EVIDENCE_LIMITS.nodes ||
        !input.errors.every((item) => valid(item, depth + 1)))
    )
      return false;
    return true;
  };
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      record(parsed) &&
      Object.keys(parsed).sort().join(',') === 'error,schema' &&
      parsed.schema === ERROR_EVIDENCE_SCHEMA &&
      valid(parsed.error, 0)
    );
  } catch {
    return false;
  }
}

/** Escape Markdown/HTML delimiters reversibly; parsed JSON keeps the original error text. */
export function errorEvidenceMarkdown(value: unknown, invocation = false): string[] {
  if (!isErrorEvidence(value)) return [];
  const json = JSON.stringify(JSON.parse(value), null, 2).replace(
    /[<>&`\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return [
    '',
    invocation
      ? '#### Checker invocation call site (not a provider stack)'
      : '#### Original exception details',
    '',
    '```json',
    json,
    '```',
    '',
  ];
}
