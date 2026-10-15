import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { intakeWorkCounters } from '../server/intake-work-accounting.ts';
import {
  qualificationOperation,
  qualificationWorkDelta,
} from './provider-qualification-work-diagnostic.ts';

test('qualification request labels expose the fixed feed route without request data', () => {
  assert.equal(
    qualificationOperation('/api/p/intakes/import-feed?view=all&cursor=secret'),
    'import-feed',
  );
  assert.equal(qualificationOperation('/api/p/intakes/report-acceptance'), 'report-acceptance');
  assert.equal(qualificationOperation('/api/p/tests/secret'), 'other');
});

test('qualification work deltas report only fixed counters in each phase', () => {
  const db = new DatabaseSync(':memory:');
  const before = intakeWorkCounters(db);
  const after = intakeWorkCounters(db);
  db.close();
  before.warm.collectionProjectionPhysicalSweeps = 2;
  before.warm.collectionFeedWindowReviews = 1;
  before.reconstruction.collectionProjectionPhysicalSweeps = 4;
  before.reconstruction.collectionFeedWindowReviews = 3;
  after.warm.collectionProjectionPhysicalSweeps = 5;
  after.warm.collectionFeedWindowReviews = 7;
  after.warm.identityPolicyMembershipComparisons = 1;
  after.warm.identityPolicyMembershipResultHits = 63;
  after.reconstruction.collectionProjectionPhysicalSweeps = 6;
  after.reconstruction.collectionFeedWindowReviews = 9;
  const delta = qualificationWorkDelta(before, after);
  assert.equal(delta.warm.collectionProjectionPhysicalSweeps, 3);
  assert.equal(delta.reconstruction.collectionProjectionPhysicalSweeps, 2);
  assert.equal(delta.warm.collectionFeedWindowReviews, 6);
  assert.equal(delta.warm.identityPolicyMembershipComparisons, 1);
  assert.equal(delta.warm.identityPolicyMembershipResultHits, 63);
  assert.deepEqual(Object.keys(delta.warm).sort(), [
    'clinicalReviewMembershipRecords',
    'collectionByteChunkReadBytes',
    'collectionFeedRebuiltSources',
    'collectionFeedReviewedRecords',
    'collectionFeedRowCertificateBytes',
    'collectionFeedRowCertificateHashes',
    'collectionFeedWindowReviews',
    'collectionProjectionPhysicalItems',
    'collectionProjectionPhysicalRepeatSweeps',
    'collectionProjectionPhysicalSweeps',
    'collectionPublicClinicalReviews',
    'identityPolicyMembershipComparisons',
    'identityPolicyMembershipResultHits',
    'reportSourceScopeMembers',
    'reportSourceScopeRoutingBuilds',
    'schemaBuildReplayedOperations',
  ]);
});
