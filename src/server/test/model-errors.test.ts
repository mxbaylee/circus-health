import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const first of ['model-config.ts', 'proxy-model-bridge.ts', 'model-bridge.ts'])
  test(`model error identities survive an isolated ${first} import first`, () => {
    const module = (name: string) => new URL('../' + name, import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      await import(${JSON.stringify(module(first))});
      const leaf = await import(${JSON.stringify(module('model-errors.ts'))});
      const config = await import(${JSON.stringify(module('model-config.ts'))});
      if (leaf.ModelError !== config.ModelError || leaf.ModelContextLimitError !== config.ModelContextLimitError)
        throw Error('Model error constructor identity changed');
      if (!(new config.ModelContextLimitError('fictional', 'slice') instanceof leaf.ModelError))
        throw Error('Model context error inheritance changed');
    `,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
  });
