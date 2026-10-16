/** Repeatable traversal of a complete selected scope; no retained result arrays. */
export interface SelectedSequence<T> extends Iterable<T> {
  readonly length: number;
  at(ordinal: number): T | undefined;
  map<U>(project: (item: T, index: number) => U): SelectedSequence<U>;
  find(predicate: (item: T, index: number) => unknown): T | undefined;
  findLast(predicate: (item: T, index: number) => unknown): T | undefined;
  findLastIndex(predicate: (item: T, index: number) => unknown): number;
  every(predicate: (item: T, index: number) => unknown): boolean;
  some(predicate: (item: T, index: number) => unknown): boolean;
  filter(predicate: (item: T, index: number) => unknown): SelectedSequence<T>;
}
export function selectedSequence<T>(
  source: Iterable<T> | (() => Iterable<T>) | undefined,
): SelectedSequence<T> {
  const values = () => (typeof source === 'function' ? source() : source) || [];
  let selectedCount: number | undefined;
  return {
    get length() {
      if (selectedCount !== undefined) return selectedCount;
      let count = 0;
      for (const _ of values()) {
        void _;
        count++;
      }
      return count;
    },
    set length(value: number) {
      if (!Number.isSafeInteger(value) || value < 0) throw Error('Invalid selected sequence count');
      selectedCount = value;
    },
    at(ordinal) {
      if (ordinal < 0) {
        let count = 0;
        for (const _ of values()) {
          void _;
          count++;
        }
        ordinal += count;
      }
      let index = 0;
      for (const item of values()) if (index++ === ordinal) return item;
      return undefined;
    },
    map(project) {
      return selectedSequence(function* () {
        let index = 0;
        for (const item of values()) yield project(item, index++);
      });
    },
    [Symbol.iterator]: () => values()[Symbol.iterator](),
    find(predicate) {
      let index = 0;
      for (const item of values()) if (predicate(item, index++)) return item;
      return undefined;
    },
    findLast(predicate) {
      let index = 0;
      let result: T | undefined;
      for (const item of values()) if (predicate(item, index++)) result = item;
      return result;
    },
    findLastIndex(predicate) {
      let index = 0;
      let result = -1;
      for (const item of values()) {
        if (predicate(item, index)) result = index;
        index++;
      }
      return result;
    },
    every(predicate) {
      let index = 0;
      for (const item of values()) if (!predicate(item, index++)) return false;
      return true;
    },
    some(predicate) {
      let index = 0;
      for (const item of values()) if (predicate(item, index++)) return true;
      return false;
    },
    filter(predicate) {
      return selectedSequence(function* () {
        let index = 0;
        for (const item of values()) if (predicate(item, index++)) yield item;
      });
    },
  };
}
