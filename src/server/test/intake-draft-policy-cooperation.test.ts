import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import type { IntakeCollectionEnvelopeReader } from '../intake-collection-envelope.ts';
import { legacyDraftPolicyContributions } from '../intake-draft-policy-index.ts';
import { schemaKey } from '../intake-envelope-schema.ts';

interface Record {
  address: string;
  fields: { [key: string]: string };
  children?: { [key: string]: Record[] };
}

function reader(drafts: Record[]) {
  const flow: Record = { address: 'flow', fields: {}, children: { reviewDrafts: drafts } };
  const intake: Record = { address: 'intake', fields: {}, children: { workflow: [flow] } };
  const root: Record = { address: 'root', fields: {}, children: { intake: [intake] } };
  let inspected = 0;
  const view = {
    root: () => root,
    child: (record: Record, field: string) => record.children?.[field]?.[0],
    childCount: (record: Record, field: string) => record.children?.[field]?.length ?? 0,
    childAt: (record: Record, field: string, ordinal: number) =>
      record.children?.[field]?.[ordinal],
    address: (record: Record) => record.address,
    field: (record: Record, field: string) => {
      if (field === 'format') inspected++;
      const value = record.fields[field];
      return value === undefined ? { kind: 'missing' } : { kind: 'value', value };
    },
  } as unknown as IntakeCollectionEnvelopeReader;
  return { view, inspected: () => inspected };
}

test('legacy policy cold scan checkpoints skipped modern drafts before draining history', async () => {
  const f = reader(
    Array.from({ length: 65 }, (_, ordinal) => ({
      address: `draft:${ordinal}`,
      fields: { format: 'health-intake-review-draft-v2' },
    })),
  );
  const work = legacyDraftPolicyContributions(f.view);
  try {
    const first = work.next();
    assert.equal(first.done, false);
    assert.deepEqual(first.value, { checkpoint: true });
    assert.equal(f.inspected(), 64);
    let hostTurn = false;
    const turn = setImmediate().then(() => {
      hostTurn = true;
    });
    await turn;
    assert.equal(hostTurn, true);
    assert.equal(f.inspected(), 64, 'no unowned work advances while the consumer yields');
    assert.deepEqual(work.next(), { value: undefined, done: true });
    assert.equal(f.inspected(), 65);
  } finally {
    work.return(undefined);
  }
});

test('legacy policy skipped-draft checkpoints preserve exact legacy witness winners', () => {
  const resolutions: Record[] = [
    { address: 'resolution:0', fields: { issueId: 'identity', outcome: 'this_is_me' } },
    { address: 'resolution:1', fields: { issueId: 'identity', outcome: 'unknown' } },
    { address: 'resolution:2', fields: { issueId: 'measurement', outcome: 'different_person' } },
  ];
  const f = reader([
    ...Array.from({ length: 65 }, (_, ordinal) => ({
      address: `draft:${ordinal}`,
      fields: { format: 'health-intake-review-draft-v2' },
    })),
    { address: 'legacy', fields: {}, children: { resolutions } },
  ]);
  const contributions = [...legacyDraftPolicyContributions(f.view)];
  assert.equal(contributions.filter((row) => 'checkpoint' in row).length, 1);
  assert.deepEqual(
    contributions.filter((row) => 'key' in row),
    [
      ['known', schemaKey('identity'), 0],
      ['known', schemaKey('measurement'), 2],
      ['latest', schemaKey('identity'), 1],
      ['latest', schemaKey('measurement'), 2],
      ['self', '', 0],
    ]
      .map(([kind, issue, ordinal]) => ({
        key: `draft.policy:legacy:${kind}:${issue}`,
        value: JSON.stringify({ ordinal, address: `resolution:${ordinal}` }),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  );
  assert.equal(f.inspected(), 66);
});
