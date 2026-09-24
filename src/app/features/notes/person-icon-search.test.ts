import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICON_CATALOG, searchPersonIcons } from '../../../shared/person-icon-search.ts';
import { validPersonIcon, lucidePersonIcon } from '../../../shared/person-icon.ts';
import { dynamicIconImports } from 'lucide-react/dynamic.js';
import { ICON_EXTRA_TAGS, ICON_SEARCH_ALIASES } from '../../../shared/person-icon-vocabulary.ts';
test('catalog exactly matches installed Lucide pack and every choice validates', () => {
  assert.deepEqual(ICON_CATALOG.map((i) => i.name).sort(), Object.keys(dynamicIconImports).sort());
  assert.ok(ICON_CATALOG.every((i) => validPersonIcon(i.value)));
  assert.equal(validPersonIcon('lucide:not-a-real-icon'), false);
});
test('names, semantic synonyms, typos and category search', () => {
  assert.equal(searchPersonIcons('flower')[0].name, 'flower');
  assert.ok(searchPersonIcons('lotus').some((i) => i.name === 'flower-2'));
  assert.ok(searchPersonIcons('flowre').some((i) => i.name === 'flower'));
  assert.ok(searchPersonIcons('doctor').some((i) => i.name === 'stethoscope'));
  assert.ok(searchPersonIcons('flower', 'nature').every((i) => i.categories.includes('nature')));
  assert.deepEqual(searchPersonIcons('🦄'), []);
  assert.deepEqual(searchPersonIcons('zzzzzzzzzzzz'), []);
});
test('legacy symbols and emoji remain recoverable without changing their appearance', () => {
  assert.equal(lucidePersonIcon('flower'), 'flower-2');
  assert.equal(lucidePersonIcon('lucide:flower'), 'flower');
  assert.ok(validPersonIcon('🃏'));
});

test('curated synonyms improve discovery without displacing direct matches', () => {
  const heartbeat = searchPersonIcons('heartbeat').map((icon) => icon.name);
  assert.equal(heartbeat[0], 'heart-pulse');
  assert.ok(heartbeat.includes('activity'));
  assert.ok(searchPersonIcons('cardiogram').some((icon) => icon.name === 'activity'));
  assert.ok(searchPersonIcons('hvac').some((icon) => icon.name === 'air-vent'));
  assert.ok(searchPersonIcons('wake').some((icon) => icon.name === 'alarm-clock'));
  assert.equal(searchPersonIcons('activity')[0].name, 'activity');
  assert.equal(searchPersonIcons('heart pul')[0].name, 'heart-pulse');
  assert.ok(searchPersonIcons('cardigoram').some((icon) => icon.name === 'activity'));
  assert.equal(searchPersonIcons('dashboard')[0].name, 'layout-dashboard');
  assert.ok(!searchPersonIcons('dashboard').some((icon) => icon.name === 'activity'));
  assert.ok(!searchPersonIcons('breathe').some((icon) => icon.name === 'air-vent'));
  assert.ok(!searchPersonIcons('minify').some((icon) => icon.name === 'a-arrow-down'));
  assert.ok(searchPersonIcons('cardiogram', 'medical').some((icon) => icon.name === 'activity'));
  assert.deepEqual(searchPersonIcons('cardiogram', 'home'), []);
});

test('curated alarm aliases share metadata and results without changing saved identifiers', async () => {
  for (const [alias, canonical] of Object.entries(ICON_SEARCH_ALIASES)) {
    const original = ICON_CATALOG.find((icon) => icon.name === alias);
    const target = ICON_CATALOG.find((icon) => icon.name === canonical);
    assert.ok(original && target);
    assert.deepEqual(original.tags, target.tags);
    assert.deepEqual(original.categories, target.categories);
    // Validate the alias against actual installed components, not a similar name.
    const imports = dynamicIconImports as Record<string, () => Promise<unknown>>;
    assert.equal(await imports[alias](), await imports[canonical]());
    assert.equal(validPersonIcon(`lucide:${alias}`), true);
    assert.equal(lucidePersonIcon(`lucide:${alias}`), alias);
    assert.equal(searchPersonIcons(alias)[0].name, alias);
    assert.equal(searchPersonIcons(canonical)[0].name, canonical);
    assert.ok(!searchPersonIcons('').some((icon) => icon.name === alias));
  }
  const alarmMatches = searchPersonIcons('alarm', 'time');
  assert.equal(new Set(alarmMatches.map((icon) => icon.canonicalName)).size, alarmMatches.length);
  assert.ok(alarmMatches.some((icon) => icon.name === 'alarm-clock-check'));
  assert.ok(!alarmMatches.some((icon) => icon.name === 'alarm-check'));
  for (const name of Object.keys(ICON_EXTRA_TAGS)) {
    assert.ok(ICON_CATALOG.some((icon) => icon.name === name));
    assert.ok(!ICON_SEARCH_ALIASES[name], 'local vocabulary belongs to the canonical icon');
  }
});
