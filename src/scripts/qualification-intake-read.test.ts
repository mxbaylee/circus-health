import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readQualificationReview,
  readQualificationIdentity,
  qualificationFeedBlocks,
  readQualificationReading,
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

function readingFixture(units = 1) {
  const intake = {
    format: 'health-intake-summary-v2',
    id: 'fictional-intake',
    version: 7,
    sha256: 'fictional-source-hash',
    mimeType: 'application/pdf',
    activePlan: {
      state: 'exact',
      plan: {
        format: 'health-intake-plan-header-v1',
        id: 'fictional-plan',
        status: 'active',
        pins: { sourceHash: 'fictional-source-hash' },
        unitCount: units,
      },
    },
  } as unknown as import('../shared/intake-summary.ts').IntakeRead;
  const page = {
    sourceHash: intake.sha256,
    readerCoverage: {
      intakeVersion: intake.version,
      summary: { units, pending: 0, partial: 0, unreadable: 0, context: 0, stale: 0 },
      entries: [],
      offset: 0,
      nextOffset: null,
    },
  } as unknown as import('../shared/intake-source-text.ts').SourceTextIssueList;
  return { intake, page };
}

test('qualification inspects pinned reader observations without inventing native extraction completeness', async () => {
  const { intake, page } = readingFixture();
  const paths: string[] = [];
  const result = await readQualificationReading(
    async <T>(path: string) => {
      paths.push(path);
      return page as T;
    },
    '/fictional/intake',
    intake,
    intake.sha256,
    1,
  );
  assert.equal(result.passed, true);
  assert.equal(result.unitCount, 1);
  assert.equal(result.pages.length, 1);
  assert.match(paths[0]!, /readerVersion=7&readerOffset=0&readerLimit=50/);
  assert.equal('extractionComplete' in result, false);
  assert.equal('readingAccounting' in result, false);
  // Complete units need no exception row. Exception length is not the unit count.
  assert.equal(result.pages[0]!.readerCoverage!.entries.length, 0);
});

test('qualification refuses absent, omitted, unread, stale, conflicting or incomplete reader evidence', async () => {
  const { intake, page } = readingFixture();
  for (const mutate of [
    (p: typeof page) => {
      delete p.readerCoverage;
    },
    (p: typeof page) => {
      p.sourceHash = 'different-original';
    },
    (p: typeof page) => {
      p.readerCoverage!.intakeVersion++;
    },
    (p: typeof page) => {
      p.readerCoverage!.summary.units = 0;
    },
    ...(['pending', 'partial', 'unreadable', 'context', 'stale'] as const).map(
      (field) => (p: typeof page) => {
        p.readerCoverage!.summary[field] = 1;
      },
    ),
    (p: typeof page) => {
      delete p.readerCoverage!.summary.stale;
    },
    (p: typeof page) => {
      p.readerCoverage!.nextOffset = 50;
    },
  ]) {
    const changed = structuredClone(page);
    mutate(changed);
    await assert.rejects(
      readQualificationReading(async <T>() => changed as T, '/fictional', intake, intake.sha256, 1),
      /Qualification public evidence/,
    );
  }
  await assert.rejects(
    readQualificationReading(async <T>() => page as T, '/fictional', intake, intake.sha256, 2),
    /active plan/,
  );
});

test('qualification follows every pinned exception page and refuses missing or changed continuation', async () => {
  const { intake, page } = readingFixture(105);
  const paths: string[] = [];
  const read = async <T>(path: string): Promise<T> => {
    paths.push(path);
    const offset = Number(
      new URL(path, 'http://fictional.invalid').searchParams.get('readerOffset'),
    );
    const value = structuredClone(page);
    const coverage = value.readerCoverage!;
    coverage.offset = offset;
    coverage.nextOffset = offset + 50 < 105 ? offset + 50 : null;
    coverage.entries = Array.from({ length: Math.min(50, 105 - offset) }, (_, n) => ({
      planId: 'fictional-plan',
      unitId: 'fictional-unit-' + (offset + n),
      status: 'completed',
      kind: 'pdf',
      locator: 'page 1',
      stale: false,
      coverageKind: 'extracted',
      notes: 'Fictional inspected note',
    }));
    return value as T;
  };
  const result = await readQualificationReading(read, '/fictional', intake, intake.sha256);
  assert.equal(result.pages.length, 3);
  assert.equal(paths.length, 3);
  for (const failure of ['missing', 'missing-final', 'changed', 'duplicate'] as const)
    await assert.rejects(
      readQualificationReading(
        async <T>(path: string) => {
          const value = await read<typeof page>(path);
          if (value.readerCoverage!.offset > 0) {
            if (failure === 'missing') value.readerCoverage!.entries = [];
            if (failure === 'missing-final' && value.readerCoverage!.nextOffset === null)
              value.readerCoverage!.entries = [];
            if (failure === 'changed') value.readerCoverage!.intakeVersion++;
            if (failure === 'duplicate')
              value.readerCoverage!.entries[0]!.unitId = 'fictional-unit-0';
          }
          return value as T;
        },
        '/fictional',
        intake,
        intake.sha256,
      ),
      /Qualification public evidence/,
    );
});
