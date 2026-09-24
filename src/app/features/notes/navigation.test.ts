import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRouter } from 'react-router-dom';
import { canonicalizesEditor, leavesNoteEditor } from './navigation.ts';

const location = (url: string) => {
  const parsed = new URL(url, 'http://localhost');
  return { pathname: parsed.pathname, search: parsed.search };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('note navigation distinguishes losing the editor from changing list filters', () => {
  const current = location('/notes?id=note%3A1&kind=historical');
  assert.equal(leavesNoteEditor(current, location('/notes?id=note%3A1&q=visit&offset=40')), false);
  assert.equal(leavesNoteEditor(current, location('/notes?id=note%3A2')), true);
  assert.equal(leavesNoteEditor(current, location('/tests')), true);
  assert.equal(leavesNoteEditor(current, location('/notes?kind=historical')), true);
  assert.equal(
    leavesNoteEditor(location('/notes?new=1&kind=note'), location('/notes?new=1&kind=person')),
    true,
  );
  assert.equal(
    leavesNoteEditor(location('/notes?new=1&kind=note'), location('/notes?new=1&kind=note&q=test')),
    false,
  );
});

test('browser-style Back can be canceled without changing entry, then confirmed', async (t) => {
  const router = createMemoryRouter([{ path: '*', element: null }], {
    initialEntries: ['/', '/notes?id=note%3A1'],
    initialIndex: 1,
  });
  t.after(() => router.dispose());
  router.getBlocker('notes', ({ currentLocation, nextLocation }) =>
    leavesNoteEditor(currentLocation, nextLocation),
  );
  await router.navigate(-1);
  await tick();
  assert.equal(router.state.location.pathname, '/notes');
  assert.equal(router.state.blockers.get('notes')!.state, 'blocked');
  router.state.blockers.get('notes')!.reset!();
  assert.equal(router.state.location.search, '?id=note%3A1');
  await router.navigate(-1);
  await tick();
  router.state.blockers.get('notes')!.proceed!();
  await tick();
  assert.equal(router.state.location.pathname, '/');
});

test('browser-style Forward is protected and same-entry filters do not prompt', async (t) => {
  const router = createMemoryRouter([{ path: '*', element: null }], {
    initialEntries: ['/notes?id=note%3A1', '/tests'],
    initialIndex: 0,
  });
  t.after(() => router.dispose());
  router.getBlocker('notes', ({ currentLocation, nextLocation }) =>
    leavesNoteEditor(currentLocation, nextLocation),
  );
  await router.navigate(1);
  await tick();
  assert.equal(router.state.blockers.get('notes')!.state, 'blocked');
  assert.equal(router.state.location.pathname, '/notes');
  router.state.blockers.get('notes')!.reset!();
  await router.navigate('/notes?id=note%3A1&q=annual');
  assert.equal(router.state.blockers.get('notes')?.state ?? 'unblocked', 'unblocked');
  assert.equal(router.state.location.search, '?id=note%3A1&q=annual');
});

test('successful saves and confirmed profile switches bypass the old draft blocker', async (t) => {
  const router = createMemoryRouter([{ path: '*', element: null }], {
    initialEntries: ['/notes?new=1'],
  });
  t.after(() => router.dispose());
  const editorProfile = 'fictional-a';
  let profile = editorProfile;
  let dirty = true;
  router.getBlocker(
    'notes',
    ({ currentLocation, nextLocation }) =>
      dirty && profile === editorProfile && leavesNoteEditor(currentLocation, nextLocation),
  );
  dirty = false; // accept(savedNote) clears this synchronously before updating the URL.
  await router.navigate('/notes?id=note%3Asaved');
  assert.equal(router.state.location.search, '?id=note%3Asaved');
  assert.equal(router.state.blockers.get('notes')?.state ?? 'unblocked', 'unblocked');
  dirty = true;
  profile = 'fictional-b'; // ProfileSwitcher changes profile after confirmation, before routing.
  await router.navigate('/');
  assert.equal(router.state.location.pathname, '/');
  assert.equal(router.state.blockers.get('notes')?.state ?? 'unblocked', 'unblocked');
});

test('first autosave and a stable person alias preserve the same editor while other navigation remains guarded', () => {
  assert.equal(
    canonicalizesEditor(location('/notes?new=1'), location('/notes?id=note%3Anew'), 'note:new'),
    true,
  );
  assert.equal(
    canonicalizesEditor(
      location('/people?id=person%3Adad'),
      location('/people?id=note%3Adad'),
      'note:dad',
      'person:dad',
    ),
    true,
  );
  assert.equal(
    canonicalizesEditor(location('/notes?new=1'), location('/notes?id=note%3Aother'), 'note:new'),
    false,
  );
  assert.equal(
    canonicalizesEditor(location('/notes?new=1'), location('/people?id=note%3Anew'), 'note:new'),
    false,
  );
  assert.equal(
    canonicalizesEditor(
      location('/notes?new=1'),
      location('/notes?new=1&id=note%3Anew'),
      'note:new',
    ),
    false,
  );
});
