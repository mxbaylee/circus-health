import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAssistantContext, resolveAssistantPage } from '../assistant-context.ts';
import type { Database } from '../database.ts';

interface FilterCondition {
  applied: boolean;
  values: string[];
  issue?: string;
  clientBody?: unknown;
}
interface FilterContext {
  view?: string | null;
  status?: string;
  conditions: FilterCondition[];
}
interface ResolvedPage {
  route: string;
  collectionFilters: FilterContext;
}
const unreachableDatabase = null as unknown as Database;
const resolve = (route: string): ResolvedPage =>
  resolveAssistantPage(
    unreachableDatabase,
    normalizeAssistantContext({ context: { route } }),
    () => {
      throw new Error('No selected record should be read');
    },
  ) as unknown as ResolvedPage;
test('assistant context keeps structured collection filters and identifies incomplete conditions', () => {
  const rows = [
    { field: 'source', operator: 'any', values: ['personal', 'clinic'] },
    { field: 'type', operator: 'none', values: ['Dermatology'] },
    { field: 'status', operator: 'any', values: [] },
  ];
  const page = resolve(
    '/notes?kind=historical&filters=' + encodeURIComponent(JSON.stringify(rows)),
  );
  assert.equal(page.collectionFilters.view, 'historical');
  assert.deepEqual(
    page.collectionFilters.conditions.map(({ applied }) => applied),
    [true, true, false],
  );
  assert.deepEqual(page.collectionFilters.conditions[0].values, ['personal', 'clinic']);
  assert.match(page.collectionFilters.conditions[2]?.issue ?? '', /Incomplete/);
});
test('assistant preserves valid long filter routes without truncating or accepting extra condition fields', () => {
  const values = Array.from({ length: 60 }, (_, n) => `Fictional role ${n} ${'x'.repeat(30)}`);
  const rows = [
    {
      field: 'tags',
      operator: 'any',
      values,
      clientBody: 'Do not include arbitrary client fields',
    },
  ];
  const route = '/people?filters=' + encodeURIComponent(JSON.stringify(rows));
  assert.ok(route.length > 2000);
  const page = resolve(route);
  assert.equal(page.route, '#' + route);
  assert.equal(page.collectionFilters.conditions[0].values.length, 60);
  assert.equal(page.collectionFilters.conditions[0].clientBody, undefined);
  assert.throws(
    () => normalizeAssistantContext({ context: { route: '/people?q=' + 'x'.repeat(32000) } }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'ASSISTANT_CONTEXT',
  );
});
test('invalid and inapplicable filters are disclosed rather than silently treated as all records', () => {
  assert.equal(resolve('/people?filters=%7B').collectionFilters.status, 'invalid');
  const page = resolve(
    '/people?filters=' +
      encodeURIComponent(
        JSON.stringify([{ field: 'rawSQL', operator: 'any', values: ['SELECT 1'] }]),
      ),
  );
  assert.equal(page.collectionFilters.conditions[0].applied, false);
  assert.match(page.collectionFilters.conditions[0]?.issue ?? '', /Unsupported/);
  const plain = resolve(
    '/notes?kind=note&filters=' +
      encodeURIComponent(JSON.stringify([{ field: 'tags', operator: 'any', values: ['Family'] }])),
  );
  assert.equal(plain.collectionFilters.conditions[0].applied, false);
});
