import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRouter } from 'react-router-dom';
import { resetTestComparisons } from './test-navigation.ts';

test('switching selected tests removes comparisons without changing search, dates or the selected test', () => {
  const next = new URLSearchParams(
    'view=by-test&q=Chol&type=hdl&compare=weight,ldl&compareUnit=g&from=2025-01-01&provider=clinic&detail=1',
  );
  const reset = resetTestComparisons('total-cholesterol', 'hdl', next);
  assert.equal(reset!.get('compare'), null);
  assert.equal(reset!.get('compareUnit'), null);
  assert.equal(reset!.get('type'), 'hdl');
  assert.equal(reset!.get('q'), 'Chol');
  assert.equal(reset!.get('from'), '2025-01-01');
  assert.equal(reset!.get('provider'), 'clinic');
  assert.equal(reset!.get('detail'), '1');
  assert.equal(next.get('compare'), 'weight,ldl');
  assert.equal(
    resetTestComparisons('mass', 'length', new URLSearchParams('compareUnit=g'))!.get(
      'compareUnit',
    ),
    null,
  );
});

test('initial comparison links, loading gaps, and other results of the same test retain comparisons', () => {
  const params = new URLSearchParams('result=cholesterol-june&compare=weight');
  assert.equal(resetTestComparisons(undefined, 'total-cholesterol', params), null);
  assert.equal(resetTestComparisons('total-cholesterol', undefined, params), null);
  assert.equal(resetTestComparisons('total-cholesterol', 'total-cholesterol', params), null);
  // Loading a different result eventually resolves its real test ID, which is
  // what resets the comparison; the result ID itself is not the boundary.
  assert.equal(
    resetTestComparisons('total-cholesterol', 'body-weight', params)!.get('compare'),
    null,
  );
});

test('back and forward between different primary tests clear URL comparisons using replacement navigation', async (t) => {
  const router = createMemoryRouter([{ path: '/tests', element: null }], {
    initialEntries: [
      '/tests?view=by-test&type=total-cholesterol&compare=weight&q=Chol',
      '/tests?view=by-test&type=hdl&compare=weight,ldl&q=Chol',
    ],
    initialIndex: 1,
  });
  t.after(() => router.dispose());
  let previous = 'hdl';
  async function reconcileResolvedPrimary() {
    const params = new URLSearchParams(router.state.location.search);
    const primary = params.get('type')!;
    const next = resetTestComparisons(previous, primary, params);
    previous = primary;
    if (next) await router.navigate(`/tests?${next}`, { replace: true });
  }
  await router.navigate(-1);
  await reconcileResolvedPrimary();
  assert.equal(new URLSearchParams(router.state.location.search).get('type'), 'total-cholesterol');
  assert.equal(new URLSearchParams(router.state.location.search).get('compare'), null);
  await router.navigate(1);
  await reconcileResolvedPrimary();
  assert.equal(new URLSearchParams(router.state.location.search).get('type'), 'hdl');
  assert.equal(new URLSearchParams(router.state.location.search).get('compare'), null);
  // Cleanup did not push another history entry or break the original Back path.
  await router.navigate(-1);
  assert.equal(new URLSearchParams(router.state.location.search).get('type'), 'total-cholesterol');
});
