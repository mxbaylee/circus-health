import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  prepareIntakeMappingSection,
  clearIntakeMappingSections,
} from '../intake-model-mapping.ts';

test('mapping sections retain giant escaped rules and exact addressed UTF8 fragments', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => {
    clearIntakeMappingSections(db);
    db.close();
  });
  const rules = [
    {
      id: 'fictional',
      match: { label: 'x'.repeat(100000) + '\u0000🦊\ud800' },
      mapping: { '2': 'second', '1': 'first', unknown: ['yes', null] },
    },
    { id: 'next' },
  ];
  const version = createHash('sha256').update(JSON.stringify(rules)).digest('hex');
  let current = true;
  const provider = await prepareIntakeMappingSection(db, rules, version, {
    assertCurrent: () => {
      assert.ok(current);
    },
  });
  const page = provider.sectionPage('mapping_rules', { items: 1, bytes: 2048 });
  assert.equal(page.entries.length, 1);
  assert.equal(page.after, '1');
  const ref = page.entries[0]!.externalValue!;
  let after: string | undefined,
    text = '';
  let pages = 0;
  do {
    const fragment = provider.externalFragment!('mapping_rules', ref.key, { after, bytes: 257 });
    assert.ok(Buffer.byteLength(fragment.jsonText) <= 257);
    text += fragment.jsonText;
    after = fragment.after ?? undefined;
    pages++;
  } while (after);
  assert.ok(pages > 100);
  assert.equal(text, JSON.stringify(rules[0]));
  assert.equal(createHash('sha256').update(text).digest('hex'), ref.root);
  assert.equal(
    provider.sectionPage('mapping_rules', { after: '1', items: 1, bytes: 2048 }).complete,
    true,
  );
  current = false;
  assert.throws(() => provider.section('mapping_rules'));
});

test('mapping scratch reuse avoids traversing rules and lock invalidates old providers', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => {
    clearIntakeMappingSections(db);
    db.close();
  });
  const provider = await prepareIntakeMappingSection(db, [{ id: 'fictional' }], 'selected');
  const poison = new Proxy([], {
    get() {
      throw Error('Repeated policy traversal');
    },
  });
  const reused = await prepareIntakeMappingSection(db, poison, 'selected');
  assert.equal(reused.section('mapping_rules').state, 'complete');
  clearIntakeMappingSections(db);
  assert.throws(() => provider.section('mapping_rules'), /preparation required/);
});
