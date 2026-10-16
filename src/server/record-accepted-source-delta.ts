import type { DatabaseSync } from 'node:sqlite';

declare const candidateBrand: unique symbol;
export interface RecordAcceptedSourceDeltaCandidate {
  readonly [candidateBrand]: true;
}

export interface RecordAcceptedSourceDeltaRow {
  readonly recordId: string;
  readonly versionId: string;
  readonly previousVersion: string | null;
  readonly deleted: boolean;
  readonly contentsHash: string;
  readonly contentsBytes: number;
  readonly fields: readonly { name: string; hash: string; bytes: number }[];
}

interface CandidateData {
  readonly token: object;
  readonly previousHeadJson: string;
  readonly headJson: string;
  readonly sequence: number;
  readonly sources: readonly RecordAcceptedSourceDeltaRow[];
}

const retained = new WeakMap<DatabaseSync, Map<object, RecordAcceptedSourceDeltaCandidate>>();
const retainedRows = new WeakMap<DatabaseSync, number>();
const data = new WeakMap<RecordAcceptedSourceDeltaCandidate, CandidateData>();
const MAX_PENDING_OUTCOMES = 100;
/** At most this many accepted outcomes wait for their outcome observer. */
export const MAX_SOURCE_DELTA_CANDIDATES = 100;
/** Consumers verify and append retained rows in pages of this many. */
export const SOURCE_DELTA_PAGE_ROWS = 100;
/** Absolute bound on one candidate's rows, and on all rows retained per
 * connection. A commit past it retains nothing; its interval falls back. */
export const MAX_SOURCE_DELTA_ROWS = 100 * SOURCE_DELTA_PAGE_ROWS;

/** This is an inert changed-row locator, not accepted read or original authority. */
export function retainRecordAcceptedSourceDeltaCandidate(
  db: DatabaseSync,
  token: object,
  previousHeadJson: string,
  headJson: string,
  sequence: number,
  sources: readonly RecordAcceptedSourceDeltaRow[],
): boolean {
  if (sources.length > MAX_SOURCE_DELTA_ROWS) return false;
  let pending = retained.get(db);
  if (!pending) retained.set(db, (pending = new Map()));
  if (pending.has(token)) return false;
  // Evict the oldest candidates until both the outcome and row bounds hold.
  let rows = retainedRows.get(db) ?? 0;
  while (
    pending.size &&
    (pending.size >= MAX_PENDING_OUTCOMES || rows + sources.length > MAX_SOURCE_DELTA_ROWS)
  ) {
    const oldest = pending.entries().next().value!;
    pending.delete(oldest[0]);
    rows -= data.get(oldest[1])?.sources.length ?? 0;
    data.delete(oldest[1]);
  }
  const candidate = Object.freeze({}) as RecordAcceptedSourceDeltaCandidate;
  data.set(candidate, {
    token,
    previousHeadJson,
    headJson,
    sequence,
    sources: Object.freeze(
      sources.map((source) =>
        Object.freeze({
          ...source,
          fields: Object.freeze(source.fields.map((field) => Object.freeze({ ...field }))),
        }),
      ),
    ),
  });
  pending.set(token, candidate);
  retainedRows.set(db, rows + sources.length);
  return true;
}

/** One use only. A consumer must separately prove the accepted version, HEAD,
 * current SQL locator, genuine owner and original physical interval. */
export function takeRecordAcceptedSourceDeltaCandidate(
  db: DatabaseSync,
  token: object,
):
  | {
      previousHeadJson: string;
      headJson: string;
      sequence: number;
      sources: readonly RecordAcceptedSourceDeltaRow[];
    }
  | undefined {
  const pending = retained.get(db),
    candidate = pending?.get(token);
  if (!candidate) return undefined;
  pending!.delete(token);
  const fact = data.get(candidate);
  data.delete(candidate);
  retainedRows.set(db, (retainedRows.get(db) ?? 0) - (fact?.sources.length ?? 0));
  return (
    fact && {
      previousHeadJson: fact.previousHeadJson,
      headJson: fact.headJson,
      sequence: fact.sequence,
      sources: fact.sources,
    }
  );
}

/** One-use continuity check only; the selected accepted owner and original
 * physical files must still be verified by the consumer. */
export function takeRecordAcceptedSourceDeltaChain(
  db: DatabaseSync,
  tokens: readonly object[],
  priorHeadJson: string,
  priorSequence: number,
  finalHeadJson: string,
): readonly NonNullable<ReturnType<typeof takeRecordAcceptedSourceDeltaCandidate>>[] | undefined {
  if (!tokens.length || tokens.length > MAX_PENDING_OUTCOMES) return undefined;
  const chain: NonNullable<ReturnType<typeof takeRecordAcceptedSourceDeltaCandidate>>[] = [];
  let head = priorHeadJson;
  let sequence = priorSequence;
  for (const token of tokens) {
    const next = takeRecordAcceptedSourceDeltaCandidate(db, token);
    if (!next || next.previousHeadJson !== head || next.sequence !== sequence + 1) return undefined;
    chain.push(next);
    head = next.headJson;
    sequence = next.sequence;
  }
  return head === finalHeadJson ? Object.freeze(chain) : undefined;
}
