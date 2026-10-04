import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import type { IntakeReviewIssue, IntakeReviewRecord } from '../shared/intake.ts';
import type { IntakeReviewIssuesReference } from '../shared/intake-review-issues.ts';
import { canonicalLiteral, parseLiteralJSON } from './intake-format.ts';
import { selectedSequence } from './intake-selected-sequence.ts';
import { canonicalReviewValueChunks } from './intake-review-question-state.ts';
import { registerReviewRecordField } from './intake-review-selected-record.ts';
import { recordIntakeWork, recordIntakePeak, withIntakeWork } from './intake-work-accounting.ts';

export interface ReviewIssueCollection extends Iterable<IntakeReviewIssue> {
  readonly length: number;
  at(ordinal: number): IntakeReviewIssue | undefined;
  find(predicate: (issue: IntakeReviewIssue) => unknown): IntakeReviewIssue | undefined;
  some(predicate: (issue: IntakeReviewIssue) => unknown): boolean;
  push(issue: IntakeReviewIssue): number;
  findId?(id: string): IntakeReviewIssue | undefined;
  markQuestionReset?(id: string): void;
  questionWasReset?(id: string): boolean;
}
const providers = new WeakMap<IntakeReviewIssuesReference, ReviewIssueCollection>();
const references = new WeakMap<ReviewIssueCollection, IntakeReviewIssuesReference>();

const encodeIssue = (issue: IntakeReviewIssue, reset = false) =>
  JSON.stringify({
    json: JSON.stringify(issue),
    reset,
    undefined: Object.keys(issue).filter(
      (key) => (issue as unknown as Record<string, unknown>)[key] === undefined,
    ),
  });

/** Connection-local derived policy. No journal or recovery authority is written. */
export function reviewIssueFactory(
  db: Database,
  input: { sourceId: string; generation: string; assertCurrent(): void },
) {
  const retainedTable = !!db
    .prepare(
      "SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name='intake_review_issue_policy_v2'",
    )
    .get();
  db.exec(
    `CREATE TEMP TABLE IF NOT EXISTS intake_review_issue_policy_v2(scope TEXT NOT NULL,run TEXT NOT NULL,source TEXT NOT NULL,generation TEXT NOT NULL,ordinal INTEGER NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,ordinal),UNIQUE(scope,id)) WITHOUT ROWID`,
  );
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS intake_review_issue_scope(scope TEXT PRIMARY KEY,run TEXT NOT NULL,source TEXT NOT NULL,generation TEXT NOT NULL,count INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TEMP TRIGGER IF NOT EXISTS intake_review_issue_insert AFTER INSERT ON intake_review_issue_policy_v2 BEGIN UPDATE intake_review_issue_scope SET count=count+1 WHERE scope=NEW.scope; END;
    CREATE TEMP TRIGGER IF NOT EXISTS intake_review_issue_delete AFTER DELETE ON intake_review_issue_policy_v2 BEGIN UPDATE intake_review_issue_scope SET count=count-1 WHERE scope=OLD.scope; END;`);
  if (!retainedTable) db.exec('DELETE FROM intake_review_issue_scope');
  input.assertCurrent();
  // Source generations are made from the same authority/dependency pins used by assertCurrent.
  db.prepare('DELETE FROM intake_review_issue_policy_v2 WHERE source=? AND generation<>?').run(
    input.sourceId,
    input.generation,
  );
  db.prepare('DELETE FROM intake_review_issue_scope WHERE source=? AND generation<>?').run(
    input.sourceId,
    input.generation,
  );
  const run = randomUUID();
  let active = true;
  const originalCheck = input.assertCurrent;
  input = {
    ...input,
    assertCurrent() {
      if (!active) throw Error('Closed issue policy scope');
      originalCheck();
    },
  };
  const create = (
    record: Pick<IntakeReviewRecord, 'id' | 'candidateVersionId'>,
  ): ReviewIssueCollection => {
    input.assertCurrent();
    const scope = createHash('sha256')
      .update(
        JSON.stringify([
          run,
          randomUUID(),
          input.sourceId,
          input.generation,
          record.id,
          record.candidateVersionId,
        ]),
      )
      .digest('hex');
    const ref: IntakeReviewIssuesReference = {
      format: 'health-intake-review-issues-v1',
      count: 0,
      token: '',
    };
    db.prepare('INSERT INTO intake_review_issue_scope VALUES(?,?,?,?,0)').run(
      scope,
      run,
      input.sourceId,
      input.generation,
    );
    const check = () => {
      input.assertCurrent();
      const count = db
        .prepare('SELECT count FROM intake_review_issue_scope WHERE scope=?')
        .get(scope)?.count;
      if (count !== ref.count)
        throw Error('Issue policy scratch lost; prepare the current review again');
    };
    const read = (row: { ordinal: number; value: string } | undefined) => {
      if (!row) return undefined;
      withIntakeWork(db, 'warm', () => {
        recordIntakeWork('reviewIssuePolicyReadBytes', Buffer.byteLength(row.value));
        recordIntakePeak('reviewIssuePolicyPeakValueBytes', Buffer.byteLength(row.value));
      });
      const stored = JSON.parse(row.value) as {
        json: string;
        undefined: string[];
        reset?: boolean;
      };
      const value = parseLiteralJSON(stored.json) as unknown as IntakeReviewIssue;
      for (const key of stored.undefined)
        Object.defineProperty(value, key, {
          value: undefined,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      return new Proxy(value, {
        set(target, key, item) {
          check();
          Reflect.set(target, key, item);
          const text = encodeIssue(target, stored.reset);
          db.prepare(
            'UPDATE intake_review_issue_policy_v2 SET value=? WHERE scope=? AND ordinal=?',
          ).run(text, scope, row.ordinal);
          withIntakeWork(db, 'warm', () =>
            recordIntakeWork('reviewIssuePolicyWrittenBytes', Buffer.byteLength(text)),
          );
          return true;
        },
        deleteProperty(target, key) {
          check();
          Reflect.deleteProperty(target, key);
          db.prepare(
            'UPDATE intake_review_issue_policy_v2 SET value=? WHERE scope=? AND ordinal=?',
          ).run(encodeIssue(target, stored.reset), scope, row.ordinal);
          return true;
        },
      });
    };
    const values = function* () {
      check();
      const statement = db.prepare(
        'SELECT ordinal,value FROM intake_review_issue_policy_v2 WHERE scope=? ORDER BY ordinal',
      );
      let count = 0;
      for (const row of statement.iterate(scope) as Iterable<{ ordinal: number; value: string }>) {
        check();
        count++;
        yield read(row)!;
      }
      if (count !== ref.count)
        throw Error('Issue policy scratch lost; prepare the current review again');
    };
    const seq = selectedSequence(values);
    const sink: ReviewIssueCollection = {
      [Symbol.iterator]: values,
      get length() {
        check();
        return ref.count;
      },
      at(ordinal) {
        check();
        if (ordinal < 0) ordinal += ref.count;
        return read(
          db
            .prepare(
              'SELECT ordinal,value FROM intake_review_issue_policy_v2 WHERE scope=? AND ordinal=?',
            )
            .get(scope, ordinal) as { ordinal: number; value: string } | undefined,
        );
      },
      find: (predicate) => seq.find(predicate),
      some: (predicate) => seq.some(predicate),
      markQuestionReset(id) {
        check();
        db.prepare(
          "UPDATE intake_review_issue_policy_v2 SET value=json_set(value,'$.reset',1) WHERE scope=? AND id=?",
        ).run(scope, id);
      },
      questionWasReset(id) {
        check();
        return !!db
          .prepare(
            "SELECT json_extract(value,'$.reset') AS reset FROM intake_review_issue_policy_v2 WHERE scope=? AND id=?",
          )
          .get(scope, id)?.reset;
      },
      findId(id) {
        check();
        return read(
          db
            .prepare(
              'SELECT ordinal,value FROM intake_review_issue_policy_v2 WHERE scope=? AND id=?',
            )
            .get(scope, id) as { ordinal: number; value: string } | undefined,
        );
      },
      push(issue) {
        check();
        const value = encodeIssue(issue),
          ordinal = ref.count;
        db.prepare('INSERT INTO intake_review_issue_policy_v2 VALUES(?,?,?,?,?,?,?)').run(
          scope,
          run,
          input.sourceId,
          input.generation,
          ordinal,
          issue.id,
          value,
        );
        withIntakeWork(db, 'warm', () => {
          recordIntakeWork('reviewIssuePolicyRows', 1);
          recordIntakeWork('reviewIssuePolicyWrittenBytes', Buffer.byteLength(value));
        });
        ref.count++;
        return ref.count;
      },
    };
    providers.set(ref, sink);
    references.set(sink, ref);
    return sink;
  };
  return Object.assign(create, {
    dispose() {
      if (active) {
        active = false;
        if (
          db.isOpen &&
          db
            .prepare(
              "SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name='intake_review_issue_policy_v2'",
            )
            .get()
        )
          db.prepare('DELETE FROM intake_review_issue_policy_v2 WHERE run=?').run(run);
        if (
          db.isOpen &&
          db
            .prepare(
              "SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name='intake_review_issue_scope'",
            )
            .get()
        )
          db.prepare('DELETE FROM intake_review_issue_scope WHERE run=?').run(run);
      }
    },
  });
}
export function bindReviewRecordIssues(record: IntakeReviewRecord, issues: ReviewIssueCollection) {
  if (Array.isArray(issues)) {
    record.issues = issues;
    delete record.issuesReference;
    return;
  }
  const ref = references.get(issues);
  if (!ref) throw Error('Foreign complete issue policy');
  delete record.issues;
  record.issuesReference = ref;
  registerReviewRecordField(record, 'issues', 'issuesReference', function* () {
    yield '[';
    let first = true;
    for (const issue of reviewRecordIssues(record)) {
      if (!first) yield ',';
      first = false;
      yield* canonicalReviewValueChunks(issue);
    }
    yield ']';
  });
}
export function reviewIssueCollection(
  record: Pick<IntakeReviewRecord, 'issues' | 'issuesReference'>,
): ReviewIssueCollection {
  if (!record.issuesReference) return record.issues || [];
  const result = providers.get(record.issuesReference);
  if (!result) throw Error('Unprepared complete issue policy');
  return result;
}
export function reviewRecordIssues(record: Pick<IntakeReviewRecord, 'issues' | 'issuesReference'>) {
  return selectedSequence(reviewIssueCollection(record));
}
export function reviewIssueForQuestion(
  record: Pick<IntakeReviewRecord, 'issues' | 'issuesReference'>,
  id: string,
) {
  const issues = reviewIssueCollection(record);
  return issues.findId ? issues.findId(id) : issues.find((issue) => issue.questionId === id);
}
export function inlineReviewRecordIssues(record: IntakeReviewRecord, bytes: number) {
  if (!record.issuesReference) return Buffer.byteLength(canonicalLiteral(record.issues || []));
  const values: IntakeReviewIssue[] = [],
    hash = createHash('sha256').update('[');
  let used = 2,
    first = true;
  for (const issue of reviewRecordIssues(record)) {
    const text = canonicalLiteral(issue);
    if (!first) hash.update(',');
    first = false;
    hash.update(text);
    used += Buffer.byteLength(text) + 1;
    if (used <= bytes) values.push(issue);
    else values.length = 0;
  }
  record.issuesReference.token = hash.update(']').digest('hex');
  if (used <= bytes) {
    record.issues = values;
    delete record.issuesReference;
    return used;
  }
  return 0;
}
