/** Typed private index operations. Implementations never receive SQL text. */
import type { IntakeJsonCanonicalKind } from './intake-json-canonical.ts';
export interface CanonicalNodeRow {
  id: number;
  kind: IntakeJsonCanonicalKind | 'root';
  parent: number;
  state: string;
  n: number;
  key: number;
  trie: number;
  raw_start: number;
  raw_bytes: number;
  out_start: number;
  cursor: number;
  emitted: number;
  phase: number;
}
export interface CanonicalTrieRow {
  id: number;
  parent: number;
  chunk: Uint8Array | number;
  object: number;
  value: number | null;
  first_order: number;
  key_number: number;
  raw_start: number;
  raw_bytes: number;
}
export interface CanonicalOrdinal {
  cursor: number;
  value: number;
}
export interface CanonicalIndex {
  node(id: number): CanonicalNodeRow | undefined;
  nodes(rows: readonly CanonicalNodeRow[]): void;
  trie(id: number): CanonicalTrieRow | undefined;
  tries(rows: readonly CanonicalTrieRow[]): void;
  terminal(id: number, firstOrder: number, keyNumber: number, start: number, bytes: number): void;
  value(id: number, value: number): void;
  edge(parent: number, chunk: Uint8Array): number | undefined;
  firstEdge(parent: number): number | undefined;
  nextEdge(parent: number, chunk: Uint8Array | number): number | undefined;
  children(rows: readonly { parent: number; ordinal: number; value: number }[]): void;
  childPage(parent: number, after: number, limit: number): CanonicalOrdinal[];
  terminalPage(
    object: number,
    after: number,
    order: 'numeric' | 'insertion',
    limit: number,
  ): CanonicalTrieRow[];
  outs(rows: readonly { id: number; start: number; bytes: number }[]): void;
  out(id: number): { start: number; bytes: number } | undefined;
  members(rows: readonly { object: number; ordinal: number; trie: number }[]): void;
  memberPage(object: number, after: number, limit: number): CanonicalOrdinal[];
}

export interface CanonicalByteSpool {
  length(): number;
  appendBytes(bytes: Uint8Array): void;
  flush(): void;
  read(start: number, bytes: number): Buffer;
  reset(): void;
}
