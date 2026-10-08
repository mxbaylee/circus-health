import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { ownershipIntakeScopes } from '../ownership-intake-scopes.ts';
import { fixture } from './intake-identity-native-fixture.ts';

test('native ownership scopes preserve legacy subject and version option combinations', async (t) => {
  const f = await fixture(t, false, 1);
  const options = [{}, { version: true }, { subject: false }, { subject: false, version: true }];
  const read = () =>
    options.map((option) => [
      ...ownershipIntakeScopes(f.db, f.original.id, 'fictional-0', {
        ...option,
        exactGroups: new Set([f.groupId]),
      }),
    ]);
  const legacy = read();
  assert.equal(legacy[1]!.length, 1);
  assert.ok(legacy[1]![0]!.subjectText);
  assert.ok(legacy[1]![0]!.versionId);
  await buildIntakeCollectionEnvelope(f.db, { id: f.original.id });
  assert.deepEqual(read(), legacy);
});
