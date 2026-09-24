import { HttpError } from './database.ts';

type JSONValueKind = 'object' | 'array' | 'string' | 'null' | 'boolean' | 'number';
export interface JSONIndexNode {
  start: number;
  end: number;
  type: JSONValueKind;
  children?: Array<{ key: string; node: JSONIndexNode }>;
}
interface JSONStructureEntry {
  key: string;
  keyTruncated: boolean;
  jsonPointer: string | null;
  type: JSONValueKind;
  start: number;
  end: number;
  totalChildren: number | null;
  literal: string;
  literalComplete: boolean;
  offset: number;
  nextOffset: number | null;
  totalCharacters: number;
}

// A structural index over literal UTF-16 offsets. Numbers are never converted to
// IEEE doubles, object keys are checked for duplicates, and payloads stay literal.
export function indexLiteralJSON(text: string) {
  if (Buffer.byteLength(text) > 25 * 1024 * 1024)
    throw new HttpError(413, 'JSON_LIMIT', 'JSON structure exceeds 25 MiB');
  let position = 0,
    count = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(text[position] || '')) position++;
  };
  function string() {
    const start = position++;
    while (position < text.length) {
      const char = text[position++];
      if (char === '\\') position++;
      else if (char === '"') return JSON.parse(text.slice(start, position)) as string;
    }
    throw Error('Unterminated JSON string');
  }
  function value(depth: number): JSONIndexNode {
    if (depth > 100 || ++count > 200000)
      throw Error('JSON structure is too deeply nested or complex');
    whitespace();
    const node: {
      start: number;
      end: number | null;
      type: JSONValueKind | null;
      children?: Array<{ key: string; node: JSONIndexNode }>;
    } = { start: position, end: null, type: null };
    const char = text[position];
    if (char === '{' || char === '[') {
      node.type = char === '{' ? 'object' : 'array';
      node.children = [];
      const keys = new Set(),
        close = char === '{' ? '}' : ']';
      position++;
      whitespace();
      if (text[position] !== close)
        for (;;) {
          whitespace();
          let key = String(node.children.length);
          if (char === '{') {
            if (text[position] !== '"') throw Error('Expected JSON object key');
            key = string();
            if (keys.has(key)) throw Error('Duplicate JSON key');
            keys.add(key);
            whitespace();
            if (text[position++] !== ':') throw Error('Expected JSON colon');
          }
          node.children.push({ key, node: value(depth + 1) });
          whitespace();
          if (text[position] === close) break;
          if (text[position++] !== ',') throw Error('Expected JSON separator');
        }
      position++;
    } else if (char === '"') {
      node.type = 'string';
      string();
    } else {
      const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        text.slice(position),
      );
      if (!token) throw Error('Invalid JSON value');
      node.type =
        token[0] === 'null' ? 'null' : /^(true|false)$/.test(token[0]) ? 'boolean' : 'number';
      position += token[0].length;
    }
    node.end = position;
    return node as JSONIndexNode;
  }
  const root = value(0);
  whitespace();
  if (position !== text.length) throw Error('Unexpected text after JSON value');
  return root;
}

export function readJSONStructure(
  text: string,
  { jsonPointer = '', jsonOffset = 0, offset = 0, limit = 50 } = {},
) {
  if (
    typeof jsonPointer !== 'string' ||
    jsonPointer.length > 4000 ||
    (jsonPointer && !jsonPointer.startsWith('/')) ||
    /~(?![01])/.test(jsonPointer)
  )
    throw new HttpError(400, 'JSON_POINTER', 'Use a valid bounded JSON pointer');
  for (const number of [jsonOffset, offset, limit])
    if (!Number.isSafeInteger(number) || number < 0)
      throw new HttpError(400, 'JSON_WINDOW', 'JSON window positions must be nonnegative integers');
  if (limit < 1 || limit > 50)
    throw new HttpError(400, 'JSON_WINDOW', 'Read 1–50 structure entries');
  let node: JSONIndexNode | undefined = indexLiteralJSON(text);
  for (const key of jsonPointer
    ? jsonPointer
        .slice(1)
        .split('/')
        .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    : []) {
    node = node.children?.find((child) => child.key === key)?.node;
    if (!node)
      throw new HttpError(404, 'JSON_POINTER', 'JSON pointer not present in supplied evidence');
  }
  const children = node.children || [];
  const escape = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
  const totalCharacters = node.end - node.start;
  // Keep the whole structure below 48k serialized characters, leaving room for
  // the package/source envelope within the assistant's 64k tool response limit.
  // The legacy node-relative literal window remains independent of jsonOffset.
  const result = {
    jsonPointer,
    type: node.type,
    start: node.start,
    end: node.end,
    totalChildren: children.length,
    jsonOffset,
    children: [] as JSONStructureEntry[],
    nextJSONOffset: null as number | null,
    literal: text.slice(
      Math.min(node.end, node.start + offset),
      Math.min(node.end, node.start + offset + 12000),
    ),
    literalComplete: offset === 0 && totalCharacters <= 12000,
    offset,
    nextOffset: offset + 12000 < totalCharacters ? offset + 12000 : null,
    totalCharacters,
    complete: false,
    coverage: 'structure_preview_only',
    note: 'Untrusted literal JSON. Each child literal starts at its own offset 0; literalComplete means its entire value was supplied, never extracted. For a partial child, continue at its jsonPointer and nextOffset. nextJSONOffset is the first child with no supplied entry. Structure and read windows do not establish extraction coverage; preserve number spelling and unknown fields.',
  };
  let remaining = 48000 - JSON.stringify(result).length - 32;
  for (const { key, node: child } of children.slice(jsonOffset, jsonOffset + limit)) {
    const pointer = jsonPointer + '/' + escape(key);
    const entry: JSONStructureEntry = {
      key: key.slice(0, 1000),
      keyTruncated: key.length > 1000,
      jsonPointer: pointer.length <= 4000 ? pointer : null,
      type: child.type,
      start: child.start,
      end: child.end,
      totalChildren: child.children?.length ?? null,
      literal: text.slice(child.start, child.end),
      literalComplete: true,
      offset: 0,
      nextOffset: null,
      totalCharacters: child.end - child.start,
    };
    let size = JSON.stringify(entry).length + 1;
    if (size > remaining) {
      if (result.children.length) break;
      // An oversized first child still has all structural metadata and an
      // honest literal prefix. Offsets are relative to this child, not its parent.
      entry.literalComplete = false;
      let low = 0,
        high = entry.totalCharacters;
      while (low < high) {
        const end = Math.ceil((low + high) / 2);
        entry.literal = text.slice(child.start, child.start + end);
        entry.nextOffset = end;
        if (JSON.stringify(entry).length + 1 <= remaining) low = end;
        else high = end - 1;
      }
      entry.literal = text.slice(child.start, child.start + low);
      entry.nextOffset = low;
      size = JSON.stringify(entry).length + 1;
    }
    result.children.push(entry);
    remaining -= size;
    if (!entry.literalComplete) break;
  }
  result.nextJSONOffset =
    jsonOffset + result.children.length < children.length
      ? jsonOffset + result.children.length
      : null;
  return result;
}
