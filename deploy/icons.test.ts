import assert from 'node:assert/strict';
import test from 'node:test';
import { dockerCommands, imageTag } from './icons.ts';
import { ROOT } from './run.ts';

test('icon generation uses the pinned isolated container and explicit writable asset mounts', () => {
  const [build, run] = dockerCommands(true);
  assert.deepEqual(build!.slice(0, 3), ['build', '--target', 'brand-tools']);
  assert.equal(build!.at(-1), ROOT);
  assert.match(imageTag(), /^circus-health-brand-tools:[a-f0-9]{12}$/u);
  assert.deepEqual(run!.slice(0, 2), ['run', '--rm']);
  assert.ok(run!.includes('--read-only'));
  assert.equal(run![run!.indexOf('--network') + 1], 'none');
  assert.equal(run!.at(-1), '--check');
  assert.ok(run!.includes(`${ROOT}/src/assets:/app/src/assets:ro`));
  assert.ok(run!.includes(`${ROOT}/src/public:/app/src/public:rw`));
});
