/** Authenticated, disposable lexical recipes owned by one clinical review scratch.
 * Every returned question is parsed afresh; no mutable policy object is cached. */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database } from './database.ts';
import { reviewReadStamp } from './intake-clinical-review-read-cache.ts';
import { recordIntakeWork, withIntakeWork } from './intake-work-accounting.ts';

export type QuestionHydrationRecipe =
  | { kind: 'full'; count: number; cost: number; text: string }
  | { kind: 'latest'; count: number; cost: number; header: string; latest: string };
const MAX = 256 * 1024;
const MAX_ENCODED = 2 * MAX + 4096;
const TABLE = 'review_question_hydration_v1';
const FORMAT = 'health-intake-question-hydration-v1';
function fail(reason: string): never {
  throw Error('Question hydration scratch: ' + reason);
}
export function reviewQuestionHydrationWork(
  db: Database,
  metric:
    | 'reviewQuestionHydrations'
    | 'reviewQuestionHydrationBytes'
    | 'reviewQuestionHydrationHits'
    | 'reviewQuestionParseBytes'
    | 'reviewQuestionScratchWrittenBytes'
    | 'reviewQuestionScratchReadBytes'
    | 'reviewQuestionScratchDiscardedRows'
    | 'reviewQuestionRecipeMacCalls'
    | 'reviewQuestionRecipeMacBytes',
  amount = 1,
) {
  withIntakeWork(db, 'warm', () => recordIntakeWork(metric, amount));
}
function validate(value: unknown, count: number): QuestionHydrationRecipe {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid recipe');
  const recipe = value as Record<string, unknown>;
  if (
    recipe.count !== count ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !Number.isSafeInteger(recipe.cost) ||
    Number(recipe.cost) < 0 ||
    Number(recipe.cost) > MAX
  )
    fail('invalid recipe counts');
  if (recipe.kind === 'full') {
    if (
      count > 1 ||
      Object.keys(recipe).sort().join(',') !== 'cost,count,kind,text' ||
      typeof recipe.text !== 'string' ||
      Buffer.byteLength(recipe.text) !== recipe.cost
    )
      fail('invalid full recipe');
  } else if (recipe.kind === 'latest') {
    if (
      count <= 1 ||
      Object.keys(recipe).sort().join(',') !== 'cost,count,header,kind,latest' ||
      typeof recipe.header !== 'string' ||
      typeof recipe.latest !== 'string' ||
      Buffer.byteLength(recipe.header) + Buffer.byteLength(recipe.latest) !== recipe.cost
    )
      fail('invalid selected recipe');
  } else fail('invalid recipe kind');
  return value as QuestionHydrationRecipe;
}
export function createReviewQuestionHydrationCache(db: Database, scratch: Database) {
  if (db === scratch) fail('private scratch required');
  scratch.exec(
    `CREATE TABLE ${TABLE}(binding TEXT NOT NULL,address TEXT NOT NULL,recipe TEXT NOT NULL,mac TEXT NOT NULL,PRIMARY KEY(binding,address)) WITHOUT ROWID`,
  );
  const lookup =
    scratch.prepare(`SELECT CASE WHEN typeof(recipe)='text' AND length(CAST(recipe AS BLOB)) BETWEEN 2 AND ${MAX_ENCODED} THEN recipe END recipe,
    CASE WHEN typeof(mac)='text' AND length(CAST(mac AS BLOB))=64 THEN mac END mac
    FROM ${TABLE} WHERE binding=? AND address=?`);
  const insert = scratch.prepare(`INSERT INTO ${TABLE} VALUES(?,?,?,?)`);
  const erase = scratch.prepare(`DELETE FROM ${TABLE}`);
  const key = randomBytes(32),
    nonce = randomUUID();
  let active = true,
    reading = false,
    epoch: string | undefined;
  const assertOpen = () => {
    if (!active || !scratch.isOpen) fail('closed owner');
  };
  const discard = () => {
    const result = erase.run();
    reviewQuestionHydrationWork(db, 'reviewQuestionScratchDiscardedRows', Number(result.changes));
  };
  const sign = (binding: string, address: string, recipe: string) => {
    const input = JSON.stringify([FORMAT, nonce, epoch, binding, address, recipe]);
    reviewQuestionHydrationWork(db, 'reviewQuestionRecipeMacCalls');
    reviewQuestionHydrationWork(db, 'reviewQuestionRecipeMacBytes', Buffer.byteLength(input));
    return createHmac('sha256', key).update(input).digest();
  };
  const guard = (assertCurrent: () => void) => {
    assertOpen();
    const result: unknown = assertCurrent();
    if (result && typeof (result as PromiseLike<unknown>).then === 'function')
      fail('asynchronous guard');
    return reviewReadStamp(db);
  };
  return {
    assertOpen,
    close() {
      if (!active) return;
      active = false;
      key.fill(0);
      // The existing scratch owner closes/unlinks the file. Do not synchronously
      // delete the corpus immediately before discarding that entire database.
    },
    read<T>(input: {
      binding: string;
      expectedBefore: string | undefined;
      address: string;
      count: number;
      bytes: number;
      assertCurrent(): void;
      overBudget(): never;
      hydrate(): { value: T; recipe: QuestionHydrationRecipe };
      materialize(recipe: QuestionHydrationRecipe): T;
    }): T {
      if (reading) fail('nested hydration');
      if (
        typeof input.binding !== 'string' ||
        Buffer.byteLength(input.binding) > 16384 ||
        typeof input.address !== 'string' ||
        !/^[a-f0-9]{64}$/.test(input.address)
      )
        fail('invalid recipe binding');
      reading = true;
      try {
        const before = input.expectedBefore;
        if (guard(input.assertCurrent) !== before) fail('authority changed before hydration');
        // Prospective transaction values never enter or borrow this cache.
        if (before === undefined) return input.hydrate().value;
        if (epoch !== before) {
          discard();
          epoch = before;
        }
        const row = lookup.get(input.binding, input.address);
        let value: T;
        if (row) {
          if (
            typeof row.recipe !== 'string' ||
            typeof row.mac !== 'string' ||
            !/^[a-f0-9]{64}$/.test(row.mac)
          )
            fail('corrupt present recipe');
          reviewQuestionHydrationWork(
            db,
            'reviewQuestionScratchReadBytes',
            Buffer.byteLength(row.recipe) + 64,
          );
          if (
            !timingSafeEqual(
              sign(input.binding, input.address, row.recipe),
              Buffer.from(row.mac, 'hex'),
            )
          )
            fail('recipe authentication');
          const recipe = validate(JSON.parse(row.recipe), input.count);
          if (recipe.cost > input.bytes) {
            if (guard(input.assertCurrent) !== before) fail('authority changed during hydration');
            input.overBudget();
          }
          value = input.materialize(recipe);
          reviewQuestionHydrationWork(db, 'reviewQuestionHydrationHits');
        } else {
          const hydrated = input.hydrate();
          value = hydrated.value;
          // Larger valid values preserve the original read path and limits.
          if (hydrated.recipe.cost <= MAX) {
            const recipe = validate(hydrated.recipe, input.count);
            const encoded = JSON.stringify(recipe);
            if (Buffer.byteLength(encoded) > MAX_ENCODED) fail('recipe encoding bound');
            const mac = sign(input.binding, input.address, encoded).toString('hex');
            if (guard(input.assertCurrent) !== before) fail('authority changed during hydration');
            insert.run(input.binding, input.address, encoded, mac);
            reviewQuestionHydrationWork(
              db,
              'reviewQuestionScratchWrittenBytes',
              Buffer.byteLength(encoded) + 64,
            );
          }
        }
        if (guard(input.assertCurrent) !== before) {
          discard();
          epoch = undefined;
          fail('authority changed during hydration');
        }
        return value;
      } finally {
        reading = false;
      }
    },
  };
}
export type ReviewQuestionHydrationCache = ReturnType<typeof createReviewQuestionHydrationCache>;
