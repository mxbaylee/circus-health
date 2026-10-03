import {
  TEXT_PIECE_LIMITS,
  TextPieceError,
  planTextPieceEdits,
  reconstructTextPieces,
  type TextPieceEdit,
  type TextPieceHead,
  type TextPieceLimits,
  type TextPieceMetrics,
  type TextPiecePlan,
  type TextPieceSnapshot,
} from './text-piece-edits.ts';

/** Automatic matching budgets are cumulative per call; callers may only lower them. */
export const TEXT_PIECE_RECONCILE_LIMITS = Object.freeze({
  maxScanUtf16Units: 268435456,
  maxComparisonUtf16Units: 134217728,
  maxAlignmentSteps: 8388608,
  maxTraceCells: 4194304,
  maxAnchorCandidates: 2000000,
  maxReuseCandidates: 2000000,
  maxCopiedUtf16Units: 33554432,
  maxCopiedBytes: 67108864,
  maxHashUtf16Units: 268435456,
});
export type TextPieceReconcileLimits = {
  -readonly [K in keyof typeof TEXT_PIECE_RECONCILE_LIMITS]: number;
};
export interface TextPieceReconcileMetrics {
  scanUtf16Units: number;
  comparisonUtf16Units: number;
  alignmentSteps: number;
  traceCells: number;
  anchorCandidates: number;
  reuseCandidates: number;
  copiedUtf16Units: number;
  copiedBytes: number;
  hashUtf16Units: number;
  anchors: number;
  matchedUtf16Units: number;
  reusedUtf16Units: number;
  derivedOperations: number;
}
export interface TextPieceReconcilePlan extends TextPiecePlan {
  readonly matchingMetrics: Readonly<TextPieceReconcileMetrics>;
}
interface Range {
  start: number;
  end: number;
}
interface Match {
  old: number;
  next: number;
  length: number;
}
class MatchingWork {
  unresolved = false;
  readonly limits: TextPieceReconcileLimits;
  readonly metrics: TextPieceReconcileMetrics = {
    scanUtf16Units: 0,
    comparisonUtf16Units: 0,
    alignmentSteps: 0,
    traceCells: 0,
    anchorCandidates: 0,
    reuseCandidates: 0,
    copiedUtf16Units: 0,
    copiedBytes: 0,
    hashUtf16Units: 0,
    anchors: 0,
    matchedUtf16Units: 0,
    reusedUtf16Units: 0,
    derivedOperations: 0,
  };
  constructor(input?: Partial<TextPieceReconcileLimits>) {
    this.limits = { ...TEXT_PIECE_RECONCILE_LIMITS };
    if (input === undefined) return;
    if (
      !input ||
      typeof input !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      throw new TextPieceError('invalid', 'matching limits object');
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || !Object.hasOwn(this.limits, key))
        throw new TextPieceError('invalid', 'unknown matching limit');
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      const value: unknown = descriptor.value;
      const name = key as keyof TextPieceReconcileLimits;
      if (
        !Object.hasOwn(descriptor, 'value') ||
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > this.limits[name]
      )
        throw new TextPieceError('invalid', `matching limit ${key} may only be lowered`);
      this.limits[name] = value;
    }
  }
  count(name: keyof typeof TEXT_PIECE_RECONCILE_LIMITS, amount = 1): void {
    const metric = (name[3].toLowerCase() + name.slice(4)) as keyof TextPieceReconcileMetrics;
    const value = this.metrics[metric] + amount;
    if (!Number.isSafeInteger(value) || value > this.limits[name])
      throw new TextPieceError('limit', `automatic matching ${metric}`);
    this.metrics[metric] = value;
  }
  equal(a: string, x: number, b: string, y: number): boolean {
    this.count('maxComparisonUtf16Units');
    return a.charCodeAt(x) === b.charCodeAt(y);
  }
  slice(text: string, start: number, end: number): string {
    this.count('maxCopiedUtf16Units', end - start);
    const result = text.slice(start, end);
    this.count('maxCopiedBytes', Buffer.byteLength(result));
    return result;
  }
}
function boundary(text: string, at: number): boolean {
  const code = text.charCodeAt(at);
  return !(code >= 0xdc00 && code <= 0xdfff);
}
function append(matches: Match[], match: Match): void {
  if (!match.length) return;
  const last = matches.at(-1);
  if (last && last.old + last.length === match.old && last.next + last.length === match.next)
    last.length += match.length;
  else matches.push(match);
}
function hashSeed(text: string, start: number, length: number, work: MatchingWork): number {
  work.count('maxHashUtf16Units', length);
  let hash = 0;
  for (let i = 0; i < length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(start + i)) | 0;
  return hash;
}
/** Hashes only index candidates; exact equality and unique placement establish anchors. */
function anchors(
  snapshot: TextPieceSnapshot,
  old: string,
  next: string,
  work: MatchingWork,
): { fixed: Match[]; retained: Match[] } {
  interface Pattern {
    text: string;
    old: number;
    count: number;
    hits: number;
    oldHits: number;
    next: number;
  }
  const patterns = new Map<string, Pattern>();
  let id = snapshot.head.first;
  let offset = 0;
  while (id !== null) {
    work.count('maxAlignmentSteps');
    const row = snapshot.occurrences.get(id)!;
    const length = row.end - row.start;
    const text = work.slice(old, offset, offset + length);
    // Include native string-key hashing/comparison work conservatively.
    work.count('maxHashUtf16Units', length);
    work.count('maxComparisonUtf16Units', length);
    const prior = patterns.get(text);
    if (prior) prior.count++;
    else patterns.set(text, { text, old: offset, count: 1, hits: 0, oldHits: 0, next: 0 });
    offset += length;
    id = snapshot.links.get(id)!.next;
  }
  const seeds = new Map<number, Map<number, Pattern[]>>();
  for (const pattern of patterns.values()) {
    work.count('maxAlignmentSteps');
    if (pattern.count !== 1) continue;
    const size = Math.min(16, pattern.text.length);
    let byHash = seeds.get(size);
    if (!byHash) seeds.set(size, (byHash = new Map()));
    const hash = hashSeed(pattern.text, pattern.text.length - size, size, work);
    const bucket = byHash.get(hash);
    if (bucket) bucket.push(pattern);
    else byHash.set(hash, [pattern]);
  }
  // An occurrence payload may also occur inside another payload or across an
  // old row boundary. Inventory uniqueness alone does not identify its position.
  for (const retained of [true, false]) {
    const text = retained ? old : next;
    for (const [size, byHash] of seeds) {
      if (text.length < size) continue;
      let power = 1;
      for (let i = 1; i < size; i++) power = Math.imul(power, 31);
      let hash = hashSeed(text, 0, size, work);
      for (let at = 0; at <= text.length - size; at++) {
        work.count('maxScanUtf16Units');
        if (at) work.count('maxHashUtf16Units', 2);
        if (at)
          hash =
            (Math.imul(hash - Math.imul(text.charCodeAt(at - 1), power), 31) +
              text.charCodeAt(at + size - 1)) |
            0;
        // The suffix seed itself may start inside a scalar; only the full
        // candidate endpoints determine whether an occurrence can be retained.
        const bucket = byHash.get(hash);
        if (!bucket) continue;
        for (const pattern of bucket) {
          work.count('maxAnchorCandidates');
          const start = at + size - pattern.text.length;
          if (
            start < 0 ||
            !boundary(text, start) ||
            (retained ? pattern.oldHits > 1 : pattern.oldHits !== 1 || pattern.hits > 1)
          )
            continue;
          let length = 0;
          while (
            length < pattern.text.length &&
            work.equal(pattern.text, length, text, start + length)
          )
            length++;
          if (length === pattern.text.length) {
            if (retained) pattern.oldHits++;
            else {
              pattern.hits++;
              pattern.next = start;
            }
          }
        }
      }
    }
  }
  let candidates: Match[] = [];
  for (const pattern of patterns.values()) {
    work.count('maxAlignmentSteps');
    if (pattern.count === 1 && pattern.oldHits === 1 && pattern.hits === 1)
      candidates.push({ old: pattern.old, next: pattern.next, length: pattern.text.length });
  }
  // First establish intact retained rows. Context windows can only refine their
  // corresponding gaps in BOTH coordinate spaces; they cannot displace a row
  // with a duplicate prefix or suffix from a different historical occurrence.
  const fixedRows = orderedAnchors(candidates, work);
  // Globally unique complete rows outside the monotone chain still identify
  // exact moves. Reserve them before any scalar-level alignment/reuse can consume
  // a matching prefix from the wrong row. Selected monotone rows win conflicts.
  const fixedSet = new Set(fixedRows);
  const byNext = candidates.slice().sort((a, b) => {
    work.count('maxAlignmentSteps');
    return a.next - b.next || b.length - a.length || a.old - b.old;
  });
  const retained: Match[] = [];
  let retainedEnd = 0;
  for (const candidate of byNext) {
    work.count('maxAlignmentSteps');
    if (!fixedSet.has(candidate)) {
      let lo = 0,
        hi = fixedRows.length;
      while (lo < hi) {
        work.count('maxAlignmentSteps');
        const mid = (lo + hi) >>> 1;
        if (fixedRows[mid].next + fixedRows[mid].length <= candidate.next) lo = mid + 1;
        else hi = mid;
      }
      if (lo < fixedRows.length && fixedRows[lo].next < candidate.next + candidate.length) continue;
    }
    if (candidate.next < retainedEnd) continue;
    retained.push(candidate);
    retainedEnd = candidate.next + candidate.length;
  }
  work.count('maxAlignmentSteps', candidates.length + fixedRows.length);
  candidates = fixedRows.slice();
  // Unique sliding windows find context inside retained pieces, including moved blocks
  // whose old chunk boundaries straddled a changed neighbour. Repeated windows never
  // establish an occurrence position. Hash collisions only remove possible anchors.
  if (old.length >= 16 && next.length >= 16) {
    const windows = new Map<
      number,
      { old: number; oldCount: number; next: number; nextCount: number }
    >();
    let power = 1;
    for (let i = 1; i < 16; i++) power = Math.imul(power, 31);
    const visit = (text: string, retained: boolean) => {
      let hash = hashSeed(text, 0, 16, work);
      for (let at = 0; at <= text.length - 16; at++) {
        work.count('maxScanUtf16Units');
        if (at) work.count('maxHashUtf16Units', 2);
        if (at)
          hash =
            (Math.imul(hash - Math.imul(text.charCodeAt(at - 1), power), 31) +
              text.charCodeAt(at + 15)) |
            0;
        if (!boundary(text, at) || !boundary(text, at + 16)) continue;
        const window = windows.get(hash);
        if (retained) {
          if (window) window.oldCount++;
          else {
            work.count('maxAnchorCandidates');
            windows.set(hash, { old: at, oldCount: 1, next: 0, nextCount: 0 });
          }
        } else if (window) {
          window.next = at;
          window.nextCount++;
        }
      }
    };
    visit(old, true);
    visit(next, false);
    for (const window of windows.values()) {
      work.count('maxAlignmentSteps');
      if (window.oldCount !== 1 || window.nextCount !== 1) continue;
      let lo = 0,
        hi = fixedRows.length;
      while (lo < hi) {
        work.count('maxAlignmentSteps');
        const mid = (lo + hi) >>> 1;
        const anchor = fixedRows[mid];
        if (anchor.old + anchor.length <= window.old) lo = mid + 1;
        else hi = mid;
      }
      const left = fixedRows[lo - 1],
        right = fixedRows[lo];
      if (
        (right && window.old + 16 > right.old) ||
        window.next < (left ? left.next + left.length : 0) ||
        window.next + 16 > (right ? right.next : next.length)
      )
        continue;
      let i = 0;
      while (i < 16 && work.equal(old, window.old + i, next, window.next + i)) i++;
      if (i === 16) candidates.push({ old: window.old, next: window.next, length: 16 });
    }
  }
  candidates.sort((a, b) => {
    work.count('maxAlignmentSteps');
    return a.old - b.old || b.length - a.length;
  });
  // Within each unanchored gap, overlapping old windows are redundant.
  let end = -1;
  let write = 0;
  for (const candidate of candidates) {
    work.count('maxAlignmentSteps');
    if (candidate.old < end) continue;
    candidates[write++] = candidate;
    end = candidate.old + candidate.length;
  }
  candidates.length = write;
  const result = orderedAnchors(candidates, work);
  work.metrics.anchors = result.length;
  return { fixed: result, retained };
}
function orderedAnchors(candidates: Match[], work: MatchingWork): Match[] {
  // Patience alignment uses nonoverlapping next intervals.
  const tails: number[] = [];
  const previous: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const match = candidates[i];
    let lo = 0,
      hi = tails.length;
    while (lo < hi) {
      work.count('maxAlignmentSteps');
      const mid = (lo + hi) >>> 1;
      const prior = candidates[tails[mid]];
      if (prior.next + prior.length <= match.next) lo = mid + 1;
      else hi = mid;
    }
    previous[i] = lo ? tails[lo - 1] : -1;
    const prior = tails[lo] === undefined ? undefined : candidates[tails[lo]];
    if (!prior || match.next + match.length < prior.next + prior.length) tails[lo] = i;
  }
  const result: Match[] = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]) result.push(candidates[i]);
  result.reverse();
  return result;
}
/** First reserved interval whose end lies after the requested position. */
function afterPosition(
  position: number,
  rows: Match[],
  coordinate: 'old' | 'next',
  work: MatchingWork,
): number {
  let lo = 0,
    hi = rows.length;
  while (lo < hi) {
    work.count('maxAlignmentSteps');
    const mid = (lo + hi) >>> 1;
    if (rows[mid][coordinate] + rows[mid].length <= position) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function covered(
  start: number,
  end: number,
  rows: Match[],
  coordinate: 'old' | 'next',
  work: MatchingWork,
): boolean {
  if (start === end) return true;
  for (let i = afterPosition(start, rows, coordinate, work); i < rows.length && start < end; i++) {
    work.count('maxAlignmentSteps');
    const row = rows[i];
    if (row[coordinate] > start) return false;
    start = row[coordinate] + row.length;
  }
  return start >= end;
}
/** Trim competing equal ranges in both coordinates, then install intact row moves. */
function reserveRows(
  matches: Match[],
  oldRows: Match[],
  nextRows: Match[],
  work: MatchingWork,
): Match[] {
  const result: Match[] = [];
  for (const match of matches) {
    work.count('maxAlignmentSteps');
    const cuts: Range[] = [];
    for (const coordinate of ['old', 'next'] as const) {
      const rows = coordinate === 'old' ? oldRows : nextRows;
      const start = match[coordinate],
        end = start + match.length;
      for (
        let i = afterPosition(start, rows, coordinate, work);
        i < rows.length && rows[i][coordinate] < end;
        i++
      ) {
        work.count('maxAlignmentSteps');
        const row = rows[i];
        cuts.push({
          start: Math.max(0, row[coordinate] - start),
          end: Math.min(match.length, row[coordinate] + row.length - start),
        });
      }
    }
    cuts.sort((a, b) => {
      work.count('maxAlignmentSteps');
      return a.start - b.start;
    });
    let from = 0;
    for (const cut of cuts) {
      work.count('maxAlignmentSteps');
      if (cut.start > from)
        result.push({ old: match.old + from, next: match.next + from, length: cut.start - from });
      from = Math.max(from, cut.end);
    }
    if (from < match.length)
      result.push({ old: match.old + from, next: match.next + from, length: match.length - from });
  }
  for (const row of nextRows) {
    work.count('maxAlignmentSteps');
    result.push({ ...row });
  }
  result.sort((a, b) => {
    work.count('maxAlignmentSteps');
    return a.next - b.next;
  });
  const merged: Match[] = [];
  for (const match of result) {
    work.count('maxAlignmentSteps');
    append(merged, match);
  }
  return merged;
}
/** Bounded Myers shortest edit alignment. Equal-cost paths prefer deletion before insertion. */
function align(old: string, next: string, a: Range, b: Range, work: MatchingWork): Match[] {
  // A surviving right context anchors repeated prefix runs before left trimming.
  let suffix = 0;
  while (a.end > a.start && b.end > b.start && work.equal(old, a.end - 1, next, b.end - 1)) {
    a.end--;
    b.end--;
    suffix++;
  }
  const prefix = { old: a.start, next: b.start, length: 0 };
  while (a.start < a.end && b.start < b.end && work.equal(old, a.start, next, b.start)) {
    a.start++;
    b.start++;
    prefix.length++;
  }
  const result: Match[] = [];
  append(result, prefix);
  const n = a.end - a.start,
    m = b.end - b.start;
  if (n && m) {
    const trace: Int32Array[] = [];
    let complete = false;
    const get = (row: Int32Array | undefined, d: number, k: number): number =>
      !row || k < -d || k > d ? -1 : row[k + d];
    for (let d = 0; d <= n + m; d++) {
      // After a bounded local search, try exact unmatched-range move reuse. This
      // is not a replacement fallback: any novel text with unresolved alignment
      // refuses below. The hard cumulative work limits always refuse immediately.
      if (d > 256) {
        work.unresolved = true;
        break;
      }
      work.count('maxTraceCells', 2 * d + 1);
      const row = new Int32Array(2 * d + 1).fill(-1);
      const prior = trace[d - 1];
      for (let k = -d; k <= d; k += 2) {
        work.count('maxAlignmentSteps');
        let x =
          d === 0
            ? 0
            : k === -d || (k !== d && get(prior, d - 1, k - 1) < get(prior, d - 1, k + 1))
              ? get(prior, d - 1, k + 1)
              : get(prior, d - 1, k - 1) + 1;
        let y = x - k;
        while (x < n && y < m && work.equal(old, a.start + x, next, b.start + y)) {
          x++;
          y++;
        }
        row[k + d] = x;
        if (x >= n && y >= m) {
          complete = true;
          break;
        }
      }
      trace.push(row);
      if (!complete) continue;
      let x = n,
        y = m;
      const reversed: Match[] = [];
      for (let depth = d; depth > 0; depth--) {
        work.count('maxAlignmentSteps');
        const diagonal = x - y;
        const preceding = trace[depth - 1];
        const before =
          diagonal === -depth ||
          (diagonal !== depth &&
            get(preceding, depth - 1, diagonal - 1) < get(preceding, depth - 1, diagonal + 1))
            ? diagonal + 1
            : diagonal - 1;
        const px = get(preceding, depth - 1, before),
          py = px - before;
        const startX = px + (before < diagonal ? 1 : 0);
        const startY = py + (before > diagonal ? 1 : 0);
        if (x > startX)
          reversed.push({ old: a.start + startX, next: b.start + startY, length: x - startX });
        x = px;
        y = py;
      }
      if (x) reversed.push({ old: a.start, next: b.start, length: x });
      for (let i = reversed.length - 1; i >= 0; i--) append(result, reversed[i]);
      break;
    }
  }
  append(result, { old: a.end, next: b.end, length: suffix });
  return result;
}
interface Desired {
  old?: number;
  next: number;
  length: number;
}
function desiredRanges(old: string, next: string, matches: Match[], work: MatchingWork): Desired[] {
  const available: Range[] = [];
  let end = 0;
  const oldOrder = matches.slice().sort((a, b) => {
    work.count('maxAlignmentSteps');
    return a.old - b.old;
  });
  for (const match of oldOrder) {
    work.count('maxAlignmentSteps');
    if (end < match.old) available.push({ start: end, end: match.old });
    end = match.old + match.length;
  }
  if (end < old.length) available.push({ start: end, end: old.length });
  const index = new Map<number, { offsets: number[]; cursor: number }>();
  for (const range of available) {
    for (let at = range.start; at < range.end; at++) {
      work.count('maxScanUtf16Units');
      if (!boundary(old, at)) continue;
      work.count('maxReuseCandidates');
      const code = old.charCodeAt(at);
      let entry = index.get(code);
      if (!entry) index.set(code, (entry = { offsets: [], cursor: 0 }));
      entry.offsets.push(at);
    }
  }
  const locate = (offset: number): number => {
    let lo = 0,
      hi = available.length;
    while (lo < hi) {
      work.count('maxAlignmentSteps');
      const mid = (lo + hi) >>> 1;
      if (available[mid].end <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo < available.length && available[lo].start <= offset ? lo : -1;
  };
  const desired: Desired[] = [];
  const add = (part: Desired) => {
    if (!part.length) return;
    const last = desired.at(-1);
    if (
      last &&
      last.next + last.length === part.next &&
      ((last.old === undefined && part.old === undefined) ||
        (last.old !== undefined && part.old === last.old + last.length))
    )
      last.length += part.length;
    else desired.push(part);
  };
  const gap = (from: number, through: number) => {
    for (let at = from; at < through;) {
      work.count('maxAlignmentSteps');
      const entry = index.get(next.charCodeAt(at));
      let reused = false;
      if (entry) {
        for (let i = entry.cursor; i < entry.offsets.length; i++) {
          work.count('maxReuseCandidates');
          const source = entry.offsets[i];
          const ri = locate(source);
          if (ri < 0) {
            if (i === entry.cursor) entry.cursor++;
            continue;
          }
          const range = available[ri];
          let length = 0;
          while (
            source + length < range.end &&
            at + length < through &&
            work.equal(old, source + length, next, at + length)
          )
            length++;
          while (length && (!boundary(old, source + length) || !boundary(next, at + length)))
            length--;
          if (!length) continue;
          add({ old: source, next: at, length });
          work.metrics.reusedUtf16Units += length;
          const replacement: Range[] = [];
          if (range.start < source) replacement.push({ start: range.start, end: source });
          if (source + length < range.end)
            replacement.push({ start: source + length, end: range.end });
          work.count('maxAlignmentSteps', available.length - ri + replacement.length);
          available.splice(ri, 1, ...replacement);
          at += length;
          reused = true;
          break;
        }
      }
      if (!reused) {
        if (work.unresolved)
          throw new TextPieceError(
            'limit',
            'automatic alignment could not establish exact move reuse',
          );
        const length = next.codePointAt(at)! > 0xffff ? 2 : 1;
        add({ next: at, length });
        at += length;
      }
    }
  };
  end = 0;
  for (const match of matches) {
    gap(end, match.next);
    add({ old: match.old, next: match.next, length: match.length });
    end = match.next + match.length;
  }
  gap(end, next.length);
  return desired;
}
/** Translate disjoint original-text ranges to sequential scalar-safe engine edits. */
function editsFor(
  old: string,
  next: string,
  desired: Desired[],
  work: MatchingWork,
  maximum: number,
): TextPieceEdit[] {
  interface Segment {
    old?: number;
    length: number;
  }
  let current: Segment[] = old.length ? [{ old: 0, length: old.length }] : [];
  const edits: TextPieceEdit[] = [];
  const emit = (edit: TextPieceEdit) => {
    if (edits.length >= maximum)
      throw new TextPieceError('limit', 'automatic derived edit operations');
    edits.push(edit);
  };
  const split = (offset: number): number => {
    let position = 0;
    for (let i = 0; i < current.length; i++) {
      work.count('maxAlignmentSteps');
      const part = current[i];
      if (offset === position) return i;
      if (offset < position + part.length) {
        const left = offset - position;
        work.count('maxAlignmentSteps', current.length - i + 2);
        current.splice(
          i,
          1,
          { old: part.old, length: left },
          { old: part.old === undefined ? undefined : part.old + left, length: part.length - left },
        );
        return i + 1;
      }
      position += part.length;
    }
    return current.length;
  };
  // Remove unselected old ranges first so equal-size replacements remain valid
  // at the text-size ceiling instead of temporarily retaining both versions.
  const retained = desired
    .filter((part) => part.old !== undefined)
    .map((part) => ({
      start: part.old!,
      end: part.old! + part.length,
    }))
    .sort((a, b) => {
      work.count('maxAlignmentSteps');
      return a.start - b.start;
    });
  const deleted: Range[] = [];
  let selectedEnd = 0;
  for (const range of retained) {
    work.count('maxAlignmentSteps');
    if (range.start > selectedEnd) deleted.push({ start: selectedEnd, end: range.start });
    selectedEnd = range.end;
  }
  if (selectedEnd < old.length) deleted.push({ start: selectedEnd, end: old.length });
  let length = old.length;
  for (let i = deleted.length - 1; i >= 0; i--) {
    const range = deleted[i];
    emit({ kind: 'splice', at: range.start, deleteCount: range.end - range.start, insert: '' });
    const from = split(range.start),
      through = split(range.end);
    work.count('maxAlignmentSteps', current.length - from);
    current.splice(from, through - from);
    length -= range.end - range.start;
  }
  let cursor = 0;
  for (const part of desired) {
    work.count('maxAlignmentSteps');
    if (part.old === undefined) {
      emit({
        kind: 'splice',
        at: cursor,
        deleteCount: 0,
        insert: work.slice(next, part.next, part.next + part.length),
      });
      const at = split(cursor);
      work.count('maxAlignmentSteps', current.length - at + 1);
      current.splice(at, 0, { length: part.length });
      length += part.length;
    } else {
      let from = 0,
        found = false;
      for (const segment of current) {
        work.count('maxAlignmentSteps');
        if (
          segment.old !== undefined &&
          part.old >= segment.old &&
          part.old < segment.old + segment.length
        ) {
          from += part.old - segment.old;
          found = true;
          break;
        }
        from += segment.length;
      }
      if (!found || from < cursor)
        throw new TextPieceError('mismatch', 'automatic source range assignment');
      if (from !== cursor) {
        emit({ kind: 'move', from, length: part.length, to: cursor });
        const to = split(cursor),
          start = split(from),
          end = split(from + part.length);
        work.count('maxAlignmentSteps', current.length * 3);
        const moved = current.slice(start, end);
        const rest = current.slice(0, start).concat(current.slice(end));
        current = rest.slice(0, to).concat(moved, rest.slice(to));
      }
    }
    cursor += part.length;
  }
  if (cursor < length)
    emit({ kind: 'splice', at: cursor, deleteCount: length - cursor, insert: '' });
  work.metrics.derivedOperations = edits.length;
  return edits;
}
function remainingLimits(
  limits: Partial<TextPieceLimits> | undefined,
  used: Readonly<TextPieceMetrics>,
): Partial<TextPieceLimits> {
  const result = { ...limits };
  const budgets = {
    maxScanSteps: 'scanSteps',
    maxValidationUtf16Units: 'validationUtf16Units',
    maxReconstructionUtf16Units: 'reconstructionUtf16Units',
    maxHashBytes: 'hashBytes',
    maxCopiedUtf16Units: 'copiedUtf16Units',
    maxCopiedBytes: 'copiedBytes',
    maxExistingContentReadBytes: 'existingContentReadBytes',
  } as const;
  for (const [limit, metric] of Object.entries(budgets)) {
    const name = limit as keyof typeof budgets;
    result[name] = (limits?.[name] ?? TEXT_PIECE_LIMITS[name]) - used[metric];
  }
  return result;
}
/**
 * Pure automatic reconciliation. Contextually unique exact anchors precede bounded
 * character alignment; only unmatched ranges can supply moves. Ambiguous residual
 * matches use earliest remaining old scalar offset. No edits or snapshots are retained
 * in the returned individual-row plan. Engine metrics include both validation passes.
 */
export function reconcileTextPieces(
  snapshot: TextPieceSnapshot,
  nextExactText: string,
  options: {
    expectedHead?: TextPieceHead;
    limits?: Partial<TextPieceLimits>;
    matchingLimits?: Partial<TextPieceReconcileLimits>;
  } = {},
): TextPieceReconcilePlan {
  const work = new MatchingWork(options.matchingLimits);
  const before = reconstructTextPieces(snapshot, { limits: options.limits });
  if (typeof nextExactText !== 'string')
    throw new TextPieceError('invalid', 'next text must be a string');
  if (
    nextExactText.length >
      (options.limits?.maxTextUtf16Units ?? TEXT_PIECE_LIMITS.maxTextUtf16Units) ||
    Buffer.byteLength(nextExactText) >
      (options.limits?.maxTextBytes ?? TEXT_PIECE_LIMITS.maxTextBytes)
  )
    throw new TextPieceError('limit', 'automatic next text size');
  work.count('maxScanUtf16Units', nextExactText.length);
  for (let i = 0; i < nextExactText.length; i++) {
    const code = nextExactText.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = nextExactText.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff))
        throw new TextPieceError('invalid', 'raw unpaired surrogate');
    } else if (code >= 0xdc00 && code <= 0xdfff)
      throw new TextPieceError('invalid', 'raw unpaired surrogate');
  }
  const old = before.text,
    next = nextExactText;
  work.count('maxComparisonUtf16Units', Math.max(old.length, next.length));
  let edits: TextPieceEdit[] = [];
  if (old !== next) {
    const { fixed, retained } = anchors(snapshot, old, next, work);
    const retainedOld = retained.slice().sort((a, b) => {
      work.count('maxAlignmentSteps');
      return a.old - b.old;
    });
    const matches: Match[] = [];
    let oldEnd = 0,
      nextEnd = 0;
    for (const anchor of [...fixed, { old: old.length, next: next.length, length: 0 }]) {
      if (
        !covered(oldEnd, anchor.old, retainedOld, 'old', work) &&
        !covered(nextEnd, anchor.next, retained, 'next', work)
      ) {
        for (const match of align(
          old,
          next,
          { start: oldEnd, end: anchor.old },
          { start: nextEnd, end: anchor.next },
          work,
        ))
          append(matches, match);
      }
      append(matches, { ...anchor });
      oldEnd = anchor.old + anchor.length;
      nextEnd = anchor.next + anchor.length;
    }
    // UTF-16 matching is exact, but a shared surrogate half is not an engine boundary.
    const safe: Match[] = [];
    for (const original of matches) {
      const match = { ...original };
      while (match.length && (!boundary(old, match.old) || !boundary(next, match.next))) {
        match.old++;
        match.next++;
        match.length--;
      }
      while (
        match.length &&
        (!boundary(old, match.old + match.length) || !boundary(next, match.next + match.length))
      )
        match.length--;
      append(safe, match);
    }
    const reserved = reserveRows(safe, retainedOld, retained, work);
    for (const match of reserved) work.metrics.matchedUtf16Units += match.length;
    edits = editsFor(
      old,
      next,
      desiredRanges(old, next, reserved, work),
      work,
      options.limits?.maxOperations ?? TEXT_PIECE_LIMITS.maxOperations,
    );
  }
  const plan = planTextPieceEdits(snapshot, {
    expectedHead: options.expectedHead ?? snapshot.head,
    expectedText: next,
    edits,
    limits: remainingLimits(options.limits, before.metrics),
  });
  const metrics = { ...plan.metrics };
  for (const key of Object.keys(metrics) as (keyof TextPieceMetrics)[])
    metrics[key] += before.metrics[key];
  return Object.freeze({
    ...plan,
    metrics: Object.freeze(metrics),
    matchingMetrics: Object.freeze({ ...work.metrics }),
  });
}
