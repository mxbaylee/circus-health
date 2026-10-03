import {
  alignIntakeString,
  intakeStringAlignmentBudget,
  type IntakeStringMatch,
} from './intake-string-alignment.ts';
import { ChatDecodeLimitError, type ChatChange } from './chat-journal-codec.ts';
import { recordIntakeWork } from './intake-work-accounting.ts';

// Fixed-size exact anchors and patience alignment follow the text-piece
// reconciler's approach. UTF-16 offsets also support JSON's lone surrogates.
const WIDTH = 32;
export function intakeStringChanges(before: string, after: string, path: string[]): ChatChange[] {
  const changes: ChatChange[] = [];
  let compared = 0;
  const budget = intakeStringAlignmentBudget();
  const scan = (units: number) => {
    compared += units;
    budget.comparisons -= units;
    if (budget.comparisons < 0)
      throw new ChatDecodeLimitError('Intake string alignment work limit exceeded');
  };
  const equal = (a: number, b: number) => {
    scan(1);
    return before.charCodeAt(a) === after.charCodeAt(b);
  };
  try {
    let start = 0,
      oldEnd = before.length,
      nextEnd = after.length;
    while (start < oldEnd && start < nextEnd && equal(start, start)) start++;
    while (oldEnd > start && nextEnd > start && equal(oldEnd - 1, nextEnd - 1)) {
      oldEnd--;
      nextEnd--;
    }
    const aligned = alignIntakeString(before, after, start, oldEnd, nextEnd, budget);
    const blocks = new Map<string, { positions: number[]; cursor: number }>();
    for (let offset = start; !aligned && offset + WIDTH <= oldEnd; offset += WIDTH) {
      scan(WIDTH);
      const text = before.slice(offset, offset + WIDTH);
      let entry = blocks.get(text);
      if (!entry) {
        entry = { positions: [], cursor: 0 };
        blocks.set(text, entry);
      }
      entry.positions.push(offset);
    }
    const matches: { old: number; next: number }[] = [];
    for (let offset = start; !aligned && offset + WIDTH <= nextEnd;) {
      // Map equality is exact UTF-16, including unpaired surrogates. Each old
      // occurrence can anchor once; duplicate occurrences pair left to right.
      scan(WIDTH);
      const entry = blocks.get(after.slice(offset, offset + WIDTH));
      const old = entry?.positions[entry.cursor];
      if (old === undefined) {
        offset++;
        continue;
      }
      entry!.cursor++;
      matches.push({ old, next: offset });
      offset += WIDTH;
    }
    // A globally monotone longest chain prevents an early decoy matching a late
    // old block from displacing an arbitrarily long unchanged middle.
    const tails: number[] = [],
      predecessors: number[] = [];
    for (let index = 0; index < matches.length; index++) {
      let low = 0,
        high = tails.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        recordIntakeWork('diffAlignmentSteps');
        if (--budget.steps < 0)
          throw new ChatDecodeLimitError('Intake string alignment step limit exceeded');
        if (matches[tails[middle]!]!.old < matches[index]!.old) low = middle + 1;
        else high = middle;
      }
      predecessors[index] = low ? tails[low - 1]! : -1;
      tails[low] = index;
    }
    const retained: IntakeStringMatch[] = [];
    for (let index = tails.at(-1) ?? -1; index >= 0; index = predecessors[index]!)
      retained.push({ ...matches[index]!, length: WIDTH });
    retained.reverse();
    if (aligned) retained.push(...aligned);
    let oldCursor = start,
      nextCursor = start;
    const gap = (oldTo: number, nextTo: number) => {
      let oldFrom = oldCursor,
        nextFrom = nextCursor;
      while (oldFrom < oldTo && nextFrom < nextTo && equal(oldFrom, nextFrom)) {
        oldFrom++;
        nextFrom++;
      }
      while (oldTo > oldFrom && nextTo > nextFrom && equal(oldTo - 1, nextTo - 1)) {
        oldTo--;
        nextTo--;
      }
      if (oldFrom !== oldTo || nextFrom !== nextTo)
        changes.push({
          op: 'splice',
          path,
          offset: oldFrom,
          remove: oldTo - oldFrom,
          text: after.slice(nextFrom, nextTo),
        });
    };
    for (const match of retained) {
      gap(match.old, match.next);
      oldCursor = match.old + match.length;
      nextCursor = match.next + match.length;
    }
    gap(oldEnd, nextEnd);
    if (!aligned) {
      // A fallback must not publish unresolved growing retained content. Character
      // inventory proves a lower bound on newly introduced UTF-16 units, independent
      // of alignment. Large novel input is legitimate; otherwise resolve the exact
      // alignment within the same cumulative work ceilings or refuse before writes.
      const inventory = new Map<number, number>();
      for (let i = start; i < oldEnd; i++) {
        scan(1);
        const code = before.charCodeAt(i);
        inventory.set(code, (inventory.get(code) ?? 0) + 1);
      }
      let novel = 0;
      for (let i = start; i < nextEnd; i++) {
        scan(1);
        const code = after.charCodeAt(i),
          remaining = inventory.get(code) ?? 0;
        if (remaining) inventory.set(code, remaining - 1);
        else novel++;
      }
      const emitted = changes.reduce(
        (sum, change) => sum + (change.op === 'splice' ? change.text.length : 0),
        0,
      );
      let justified = Math.max(256, 2 * novel);
      if (emitted > justified) {
        // Same-alphabet replacements can be genuinely large too. Every disjoint
        // next window absent at *all* old offsets requires at least one edit.
        // This proves a fixed 32-unit evidence granularity without guessing that
        // unmatched repeated anchors mean new content.
        const oldWindows = new Set<string>();
        for (let index = start; index + WIDTH <= oldEnd; index++) {
          scan(WIDTH);
          oldWindows.add(before.slice(index, index + WIDTH));
        }
        let novelWindows = 0;
        for (let index = start; index + WIDTH <= nextEnd; index += WIDTH) {
          scan(WIDTH);
          if (!oldWindows.has(after.slice(index, index + WIDTH))) novelWindows++;
        }
        justified = Math.max(justified, WIDTH * novelWindows + 2 * WIDTH);
      }
      if (emitted > justified) {
        const exact = alignIntakeString(before, after, start, oldEnd, nextEnd, budget, 2047);
        if (!exact) throw new ChatDecodeLimitError('Intake string alignment work limit exceeded');
        changes.length = 0;
        oldCursor = start;
        nextCursor = start;
        for (const match of exact) {
          gap(match.old, match.next);
          oldCursor = match.old + match.length;
          nextCursor = match.next + match.length;
        }
        gap(oldEnd, nextEnd);
      }
    }
    // Descending original offsets retain coordinates without a durable reference list.
    return changes.reverse();
  } finally {
    recordIntakeWork('diffStringComparedUnits', compared);
  }
}
