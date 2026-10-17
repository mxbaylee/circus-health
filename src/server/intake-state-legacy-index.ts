/** Invocation-local legacy work. Typed operations never receive SQL text. */
export interface LegacyNode {
  id: number;
  kind: string;
  value: string | null;
  start: number;
  units: number;
}
export interface LegacyEntry {
  ordinal: number;
  key: string | null;
  numeric: number | null;
  child: number;
}
export interface LegacyFrameRow {
  raw: string;
  sha: string;
}
export interface LegacyIndex {
  frameSeen(id: string): boolean;
  putFrame(sequence: number, id: string, raw: string, sha: string): void;
  frame(sequence: number): LegacyFrameRow | undefined;
  frames(): Iterable<LegacyFrameRow>;
  consume(key: string): void;
  consumed(): Iterable<string>;
  receipt(id: string, raw: string): void;
  receipts(): Iterable<{ id: string; raw: string }>;
  clearCopies(): void;
  copy(id: string, target: string): void;
  copied(id: string): string | undefined;
  node(id: number): LegacyNode | undefined;
  insertNode(node: Omit<LegacyNode, 'id'>): number;
  count(parent: number): number;
  nextOrdinal(parent: number): number;
  entry(parent: number, ordinal: number): LegacyEntry | undefined;
  named(parent: number, key: string): LegacyEntry | undefined;
  entries(parent: number, array: boolean): Iterable<LegacyEntry>;
  add(parent: number, entry: LegacyEntry): void;
  replace(parent: number, entry: LegacyEntry, child: number): void;
  remove(parent: number, entry: LegacyEntry): void;
  truncateSteps(parent: number, length: number): Generator<void>;
  reorder(entry: LegacyEntry): void;
  finishOrderSteps(parent: number): Generator<void>;
  insert(child: number): void;
  inserted(): Iterable<number>;
  clearInserted(): void;
}
