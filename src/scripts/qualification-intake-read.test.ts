import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readQualificationReview,
  readQualificationIdentity,
  qualificationFeedBlocks,
} from './qualification-intake-read.ts';
import type { IntakeClinicalReviewPage } from '../shared/intake-clinical-review.ts';
import type {
  IntakeIdentityReview,
  IntakeIdentityScopeReference,
} from '../shared/intake-identity.ts';
import type { CollectionImportFeed } from '../shared/intake-clinical-pages.ts';

const context = {
  intakeId: 'fictional-intake',
  proposalId: null,
  version: 1,
  reviewToken: 'fictional-token',
  summary: { additions: 0, duplicates: 0, uncertain: 0, unsupported: 0 },
  sourceTextStale: false,
};
function section(path: string): IntakeClinicalReviewPage {
  const params = new URL(path, 'http://fictional.invalid').searchParams;
  return {
    ...context,
    format: 'health-intake-clinical-review-page-v2',
    section: params.get('section') as IntakeClinicalReviewPage['section'],
    total: 0,
    items: [],
    nextCursor: null,
  };
}

test('qualification collects complete public review sections and refuses changed or unfinished pages', async () => {
  const paths: string[] = [];
  const read = async <T>(path: string): Promise<T> => {
    paths.push(path);
    return section(path) as T;
  };
  const value = await readQualificationReview(read, '/fictional/review');
  assert.equal(paths.length, 3);
  assert.deepEqual(value, { ...context, records: [], sourceContext: [], coverageGaps: [] });
  await assert.rejects(
    readQualificationReview(async <T>(path: string) => {
      const page = section(path);
      if (page.section === 'coverageGaps') page.reviewToken = 'changed';
      return page as T;
    }, '/fictional/review'),
    /changed/,
  );
  await assert.rejects(
    readQualificationReview(
      async <T>(path: string) => ({ ...section(path), total: 1 }) as T,
      '/fictional/review',
    ),
    /incomplete/,
  );
  await assert.rejects(
    readQualificationReview(
      async <T>(path: string) =>
        ({
          ...section(path),
          total: 1,
          items: [
            {
              kind: 'reference',
              reference: {
                format: 'health-intake-clinical-review-reference-v2',
                reviewToken: 'fictional-token',
                section: 'records',
                ordinal: 0,
                bytes: 999999,
              },
            },
          ],
        }) as T,
      '/fictional/review',
    ),
    /referenced review value/,
  );
});

test('qualification identity inspects every scope collection while retaining original reference for commands', async () => {
  const reference: IntakeIdentityScopeReference = {
    format: 'health-intake-identity-scope-v2',
    profileId: 'fictional-profile',
    intakeId: 'fictional-intake',
    intakeVersion: 1,
    groupId: 'fictional-group',
    groupVersionId: 'fictional-version',
    sourceHash: 'fictional-hash',
    memberId: null,
    original: { filename: 'fictional.txt', contentUrl: '/fictional/content', page: null },
    report: { text: 'Fictional', locator: 'line 1' },
    subject: { text: 'Fictional Person', locator: 'line 2' },
    verificationMode: 'literal_text_match',
    scopeToken: 'fictional-token',
    collection: {
      snapshotId: 'fictional-snapshot',
      membership: 0,
      targets: 0,
      assignmentTargets: 0,
      questions: 1,
      competingSubjects: 0,
    },
  };
  const review: IntakeIdentityReview = {
    status: 'confirmation_required',
    blocking: true,
    message: 'Fictional',
    scope: null,
    scopeReference: reference,
    evidencedIdentity: {},
    self: { noteId: 'person-note:self', version: 1, fullName: 'Fictional Person', birthDate: '' },
    offeredSelfFields: {},
    conflicts: [],
  };
  const paths: string[] = [];
  const read = async <T>(path: string): Promise<T> => {
    paths.push(path);
    if (path.includes('identity-review')) return review as T;
    const name = new URL(path, 'http://fictional.invalid').searchParams.get('section')!;
    return {
      format: 'health-intake-identity-scope-page-v2',
      scopeToken: reference.scopeToken,
      section: name,
      total: name === 'questions' ? 1 : 0,
      items:
        name === 'questions'
          ? [{ kind: 'value', value: { prompt: 'Confirm fictional person' } }]
          : [],
      nextCursor: null,
    } as T;
  };
  const inspected = await readQualificationIdentity(
    read,
    '/fictional/identity-review?groupId=fictional-group',
  );
  assert.equal(paths.length, 6);
  assert.equal(inspected.confirmationScope, reference);
  assert.equal(inspected.review.scope, null);
  assert.deepEqual(inspected.inspectedScope.questions, [{ prompt: 'Confirm fictional person' }]);
  assert.equal('collection' in inspected.inspectedScope, false);
  await assert.rejects(
    readQualificationIdentity(async <T>(path: string): Promise<T> => {
      const value = await read<unknown>(path);
      return (
        path.includes('identity-scope-page')
          ? { ...(value as object), scopeToken: 'changed' }
          : value
      ) as T;
    }, '/fictional/identity-review'),
    /identity scope changed/,
  );
});

test('qualification refuses native unloaded feed records without fabricating empty blocks', () => {
  const page = {
    format: 'health-intake-import-feed-v2',
    records: [{ detail: { kind: 'reference' } }],
  } as CollectionImportFeed;
  assert.throws(() => qualificationFeedBlocks(page), /referenced record/);
});
