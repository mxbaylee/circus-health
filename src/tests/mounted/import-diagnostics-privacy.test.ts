import { afterEach, expect, it } from 'vitest';
import {
  clearBrowserImportDiagnostics,
  identityReviewDiagnostics,
  recordIdentityReviewDiagnostic,
} from '../../app/data/import-diagnostics';
import type { IntakeIdentityReview } from '../../shared/intake-identity';
afterEach(clearBrowserImportDiagnostics);
it('identity diagnostics expose bounded presence and policy outcomes without names or dates', () => {
  const review = {
    evidencedIdentity: { fullName: 'Cookie Doe', birthDate: '1986-02-14' },
    self: { fullName: 'Fictional Self', birthDate: '1970-01-01' },
    selfBirthDateConflict: true,
    blocking: true,
    status: 'conflict',
  } as IntakeIdentityReview;
  recordIdentityReviewDiagnostic(review);
  const output = identityReviewDiagnostics();
  expect(output[0]).toMatchObject({
    hasEvidencedName: true,
    hasEvidencedDob: true,
    hasSelfDob: true,
    dobConflict: true,
    blocking: true,
    status: 'conflict',
  });
  expect(JSON.stringify(output)).not.toMatch(/Cookie|Doe|Fictional|1986|1970/);
  for (let i = 0; i < 100; i++)
    recordIdentityReviewDiagnostic({ ...review, blocking: i % 2 === 0 });
  expect(identityReviewDiagnostics()).toHaveLength(50);
  clearBrowserImportDiagnostics();
  expect(identityReviewDiagnostics()).toEqual([]);
});
