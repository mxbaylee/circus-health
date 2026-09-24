// Node 24 provides these literal-preserving JSON APIs; the pinned TypeScript 7
// standard library does not declare them yet. Remove when its library catches up.
// https://tc39.es/ecma262/multipage/structured-data.html#sec-json.rawjson
// https://tc39.es/ecma262/multipage/structured-data.html#sec-json.parse
interface JSON {
  rawJSON(text: unknown): Readonly<{ rawJSON: string }>;
  isRawJSON(value: unknown): value is Readonly<{ rawJSON: string }>;
  parse(
    text: string,
    reviver: (this: unknown, key: string, value: unknown, context: { source?: string }) => unknown,
  ): unknown;
}
