import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sourceFileCoverageStatus,
  sourceFileAttribution,
  sourceFileStatus,
  sourceRecordHistoricalStatus,
  sourceRecordStatus,
} from './sourceStatus.ts';

test('labels only canonically missing acquisition separately from a reviewed source', () => {
  assert.deepEqual(
    sourceFileAttribution({ provider: 'Unknown source', reviewedSource: 'Fictional Eye Center' }),
    { acquisition: 'Acquisition source not recorded', reviewedSource: 'Fictional Eye Center' },
  );
  assert.deepEqual(sourceFileAttribution({ provider: null, reviewedSource: null }), {
    acquisition: 'Acquisition source not recorded',
    reviewedSource: null,
  });
  assert.deepEqual(
    sourceFileAttribution({ provider: 'Fictional Upload Service', reviewedSource: null }),
    { acquisition: 'Fictional Upload Service', reviewedSource: null },
  );
  assert.equal(
    sourceFileAttribution({ provider: 'unknown source', reviewedSource: null }).acquisition,
    'unknown source',
  );
});

test('keeps retained source-file state separate from historical coverage', () => {
  assert.equal(
    sourceFileStatus('original_retained; clinical_coverage_unknown'),
    'Original retained',
  );
  assert.equal(sourceFileStatus('derived_proposal; unreviewed'), 'Proposal snapshot retained');
  assert.equal(sourceFileStatus('original_retained; partial'), 'Original retained');
  assert.equal(sourceFileStatus('mapped'), 'Linked to saved health records');
  assert.equal(sourceFileStatus('unexpected_internal_state'), 'Retained-file state unavailable');

  assert.equal(
    sourceFileCoverageStatus('original_retained; clinical_coverage_unknown'),
    'Full-file coverage was not recorded when this snapshot was created',
  );
  assert.equal(
    sourceFileCoverageStatus('derived_proposal; unreviewed'),
    'Unreviewed when this snapshot was created',
  );
  assert.equal(
    sourceFileCoverageStatus('original_retained; partial'),
    'Partial extraction recorded in this snapshot',
  );
  assert.equal(
    sourceFileCoverageStatus('original_retained; clinical_coverage_unknown; partial'),
    'Partial extraction recorded in this snapshot',
  );
  assert.equal(
    sourceFileCoverageStatus('mapped'),
    'Saved-record mapping recorded in this snapshot',
  );
  assert.equal(
    sourceFileCoverageStatus('unexpected_internal_state'),
    'Historical coverage state unavailable',
  );
});

test('keeps current retained-record linkage separate from historical extraction state', () => {
  assert.equal(sourceRecordStatus('projected_reviewed'), 'Linked to a saved health record');
  assert.equal(sourceRecordStatus('retained_projected'), 'Linked to a saved health record');
  assert.equal(
    sourceRecordStatus('retained_unprojected'),
    'Evidence retained · no saved health record linked',
  );
  assert.equal(sourceRecordStatus('partial'), 'Evidence retained');
  assert.equal(sourceRecordStatus('unreviewed'), 'Evidence retained');
  assert.equal(sourceRecordStatus('unexpected_internal_state'), 'Saved-link state unavailable');

  assert.equal(sourceRecordHistoricalStatus('projected_reviewed'), null);
  assert.equal(sourceRecordHistoricalStatus('retained_projected'), null);
  assert.equal(sourceRecordHistoricalStatus('mapped'), null);
  assert.equal(
    sourceRecordHistoricalStatus('partial'),
    'Partial extraction recorded in this snapshot',
  );
  assert.equal(
    sourceRecordHistoricalStatus('unreviewed'),
    'Unreviewed when this snapshot was created',
  );
});
