import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { libraryCounts } from './processing-library-counts.ts';

test('counts observed zero separately from missing/conflicting counts and excludes source-wide scopes', () => {
  const result = libraryCounts({
    format: 'circus-import-diagnostics-v1',
    server: {
      attribution: {
        schemaVersion: 1,
        exportBounds: { partial: false },
        omittedImports: 0,
        imports: [
          {
            importId: 'fictional-private-marker',
            truncated: false,
            historicalReadsUnknown: false,
            requestTotals: {
              attempts: 6,
              measuredInputTokens: 400,
              measuredOutputTokens: 80,
              usageComplete: true,
            },
            pages: [
              { page: 1, textLayerCountStatus: 'observed', textLayerCharacters: 0 },
              { page: 2, textLayerCountStatus: 'observed', textLayerCharacters: 49 },
              { page: 3, textLayerCountStatus: 'unknown', textLayerCharacters: null },
              { page: 4, textLayerCountStatus: 'conflicting', textLayerCharacters: null },
              { page: null, textLayerCountStatus: 'observed', textLayerCharacters: 0 },
            ],
          },
        ],
      },
    },
  });
  assert.equal(JSON.stringify(result).includes('fictional-private-marker'), false);
  assert.equal(result.measurements.retainedNumberedPageScopes, 4);
  assert.equal(result.measurements.sourceWideScopes, 1);
  assert.equal(result.measurements.zeroTextShareOfObserved, 0.5);
  assert.equal(result.measurements.under50TextShareOfObserved, 1);
  assert.equal(result.measurements.requestsPerRetainedPageScope, 1.5);
  assert.equal(result.measurements.inputTokensPerRetainedPageScope, 100);
  assert.equal(result.measurements.outputTokensPerRetainedPageScope, 20);
  assert.equal(result.measurements.unknownTextPages, 1);
  assert.equal(result.measurements.conflictingTextPages, 1);
});

test('missing usage and incomplete history remain unknown rather than zero', () => {
  const result = libraryCounts({
    format: 'circus-import-diagnostics-v1',
    server: {
      attribution: {
        schemaVersion: 1,
        imports: [
          {
            truncated: true,
            historicalReadsUnknown: true,
            requestTotals: { attempts: 3, measuredInputTokens: 50, usageComplete: false },
            pages: [{ page: 1, textLayerCountStatus: 'unknown', textLayerCharacters: null }],
          },
        ],
      },
    },
  });
  assert.equal(result.measurements.inputTokensPerRetainedPageScope, null);
  assert.equal(result.measurements.requestsPerRetainedPageScope, null);
  assert.equal(result.measurements.zeroTextShareOfObserved, null);
  assert.equal(result.measurements.canonicalTrackedRequests, 3);
  assert.equal(result.measurements.incompleteImports, 1);
});

test('CLI errors disclose neither malformed contents nor the path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fictional-counts-'));
  const path = join(dir, 'fictional-secret-marker.json');
  try {
    writeFileSync(path, '{"fictional-private-text": bad}');
    for (const input of [path, path + '-missing']) {
      const result = spawnSync(
        process.execPath,
        ['src/scripts/processing-library-counts.ts', input],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr.includes(dir), false);
      assert.equal(result.stderr.includes('fictional-private-text'), false);
      assert.match(result.stderr, /^Counts unavailable:/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
