import { ChatDecodeLimitError } from './chat-journal-codec.ts';
import { recordIntakeWork } from './intake-work-accounting.ts';

export interface IntakeStringAlignmentBudget {
  comparisons: number;
  cells: number;
  steps: number;
}
export const intakeStringAlignmentBudget = (): IntakeStringAlignmentBudget => ({
  comparisons: 100_000_000,
  cells: 4_194_304,
  steps: 8_388_608,
});
export interface IntakeStringMatch {
  old: number;
  next: number;
  length: number;
}

/** Bounded Myers alignment adapted from text-piece-reconcile; UTF-16 is exact here. */
export function alignIntakeString(
  before: string,
  after: string,
  start: number,
  oldEnd: number,
  nextEnd: number,
  budget: IntakeStringAlignmentBudget,
  maxDepth = 256,
): IntakeStringMatch[] | undefined {
  const n = oldEnd - start,
    m = nextEnd - start;
  if (!n || !m) return [];
  const trace: Int32Array[] = [];
  let comparisons = 0,
    steps = 0,
    cells = 0;
  const get = (row: Int32Array | undefined, depth: number, diagonal: number): number =>
    !row || diagonal < -depth || diagonal > depth ? -1 : row[diagonal + depth]!;
  try {
    // This is a bounded *planning* search, independent of decoder work limits.
    // Large changed gaps proceed through fixed anchors; small edits resolve here
    // before repeated anchor occurrences can choose an incorrect period/phase.
    for (let depth = 0; depth <= Math.min(n + m, maxDepth); depth++) {
      cells += 2 * depth + 1;
      budget.cells -= 2 * depth + 1;
      if (budget.cells < 0)
        throw new ChatDecodeLimitError('Intake string alignment trace limit exceeded');
      const row = new Int32Array(2 * depth + 1).fill(-1);
      const prior = trace[depth - 1];
      let complete = false;
      for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
        steps++;
        if (--budget.steps < 0)
          throw new ChatDecodeLimitError('Intake string alignment step limit exceeded');
        let x =
          depth === 0
            ? 0
            : diagonal === -depth ||
                (diagonal !== depth &&
                  get(prior, depth - 1, diagonal - 1) < get(prior, depth - 1, diagonal + 1))
              ? get(prior, depth - 1, diagonal + 1)
              : get(prior, depth - 1, diagonal - 1) + 1;
        let y = x - diagonal;
        while (x < n && y < m) {
          if ((comparisons++, --budget.comparisons < 0))
            throw new ChatDecodeLimitError('Intake string alignment work limit exceeded');
          if (before.charCodeAt(start + x) !== after.charCodeAt(start + y)) break;
          x++;
          y++;
        }
        row[diagonal + depth] = x;
        if (x >= n && y >= m) {
          complete = true;
          break;
        }
      }
      trace.push(row);
      if (!complete) continue;
      const reversed: IntakeStringMatch[] = [];
      let x = n,
        y = m;
      for (let d = depth; d > 0; d--) {
        steps++;
        if (--budget.steps < 0)
          throw new ChatDecodeLimitError('Intake string alignment step limit exceeded');
        const diagonal = x - y,
          preceding = trace[d - 1];
        const previousDiagonal =
          diagonal === -d ||
          (diagonal !== d &&
            get(preceding, d - 1, diagonal - 1) < get(preceding, d - 1, diagonal + 1))
            ? diagonal + 1
            : diagonal - 1;
        const px = get(preceding, d - 1, previousDiagonal),
          py = px - previousDiagonal;
        const fromX = px + (previousDiagonal < diagonal ? 1 : 0);
        const fromY = py + (previousDiagonal > diagonal ? 1 : 0);
        if (x > fromX)
          reversed.push({ old: start + fromX, next: start + fromY, length: x - fromX });
        x = px;
        y = py;
      }
      if (x) reversed.push({ old: start, next: start, length: x });
      return reversed.reverse();
    }
    return undefined;
  } finally {
    recordIntakeWork('diffStringComparedUnits', comparisons);
    recordIntakeWork('diffAlignmentSteps', steps);
    recordIntakeWork('diffTraceCells', cells);
  }
}
