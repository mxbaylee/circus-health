import { reviewIssueScratchCounts } from '../intake-review-issue-state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import type { IntakeIdentityConfirmation } from '../../shared/intake-identity.ts';
import { fixture, envelope } from './intake-identity-native-fixture.ts';

test(
  'native common identity preserves a complete giant competing-subject question through confirmation',
  { timeout: 1200000 },
  async (t) => {
    const otherSubjects = Array.from(
      { length: 70 },
      (_, n) => `Patient: Fictional alternative ${n} ` + 'z'.repeat(3900),
    );
    const f = await fixture(
      t,
      true,
      otherSubjects.length + 1,
      false,
      (n) => {
        const record = envelope('fictional-competing-' + n);
        if (n)
          record.report = {
            ...record.report!,
            key: 'claim-' + n,
            subject: { locator: 'page 1 patient', text: otherSubjects[n - 1]! },
          };
        return record;
      },
      undefined,
      true,
    );
    // This fixture opens only identity/snapshot endpoints; no public clinical
    // read session is intentionally retained. These counts track identity-owned cleanup.
    const beforeWork = intakeWorkCounters(f.db).warm,
      beforeScratch = reviewIssueScratchCounts(f.db);
    const review = await f.review(),
      scope = review.scopeReference!;
    assert.deepEqual(reviewIssueScratchCounts(f.db), beforeScratch);
    assert.equal(review.confirmationCount, 0);
    assert.ok(scope);
    assert.equal(scope.collection.assignmentTargets, 1);
    assert.equal(scope.collection.competingSubjects, otherSubjects.length);
    const page = await f.request(
      `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${scope.scopeToken}&section=questions&limit=2`,
    );
    assert.equal(page.total, 2);
    assert.equal(page.items.length, 2);
    assert.deepEqual(page.items[0], {
      kind: 'value',
      value: {
        prompt:
          'This report boundary has conflicting subject claims; resolve identity individually',
      },
    });
    const completeQuestion = page.items[1];
    assert.equal(completeQuestion.kind, 'reference');
    assert.equal(completeQuestion.reference.format, 'health-intake-identity-item-v2');
    assert.equal(completeQuestion.reference.section, 'questions');
    assert.equal(completeQuestion.reference.ordinal, 1);
    assert.ok(completeQuestion.reference.bytes > 256 * 1024);
    const parts: Buffer[] = [];
    let offset = 0,
      fragmentCursor = 'start';
    for (;;) {
      const fragment = await f.request(
        `identity-scope-fragment?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${scope.scopeToken}&section=questions&ordinal=${completeQuestion.reference.ordinal}&offset=${offset}&cursor=${encodeURIComponent(fragmentCursor)}`,
      );
      const bytes = Buffer.from(fragment.data, 'base64');
      assert.ok(bytes.length <= 32768);
      parts.push(bytes);
      if (fragment.complete) {
        assert.equal(fragment.nextCursor, null);
        break;
      }
      assert.ok(fragment.nextOffset > offset);
      assert.ok(typeof fragment.nextCursor === 'string' && fragment.nextCursor.length > 0);
      fragmentCursor = fragment.nextCursor;
      offset = fragment.nextOffset;
    }
    assert.equal(Buffer.concat(parts).byteLength, completeQuestion.reference.bytes);
    const question = JSON.parse(Buffer.concat(parts).toString());
    assert.equal(
      question.prompt,
      'Other extraction claims name a different subject at this same report boundary. Review the original and confirm the displayed subject and person for only the listed records.',
    );
    const claims: { subject: { text: string } }[] = [];
    let cursor: string | null = null;
    do {
      const page = await f.request(
        `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${scope.scopeToken}&section=competingSubjects&limit=10${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
      );
      claims.push(
        ...page.items.map((item: { kind: string; value: { subject: { text: string } } }) => {
          assert.equal(item.kind, 'value');
          return item.value;
        }),
      );
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(claims.length, otherSubjects.length);
    assert.deepEqual(claims.map((claim) => claim.subject.text).sort(), [...otherSubjects].sort());
    assert.equal(question.textAnchor, claims.map((claim) => claim.subject.text).join(' / '));
    const input: IntakeIdentityConfirmation = {
      version: scope.intakeVersion,
      operationId: 'fictional-complete-competing-confirm',
      scope,
      outcome: 'this_is_me',
      attestation: 'confirmed_displayed_identity_questions',
    };
    await f.request('identity-scope', input);
    const after = await f.review();
    assert.equal(after.status, 'prior_confirmation');
    assert.equal(after.blocking, false);
    assert.equal(after.confirmationCount, 1);
    await f.request('identity-scope', input);
    const afterWork = intakeWorkCounters(f.db).warm;
    assert.equal(afterWork.sourceDTOHydrations, beforeWork.sourceDTOHydrations);
    assert.equal(afterWork.envelopeHydrations, beforeWork.envelopeHydrations);
    assert.equal(afterWork.envelopeTextReads, beforeWork.envelopeTextReads);
    assert.deepEqual(reviewIssueScratchCounts(f.db), beforeScratch);
  },
);

// This durable fixture confirms >256 KiB of independent witnesses, reconstructs
// current policy and retries the exact durable operation. The hang guard covers
// those host writes; complete counts and zero whole hydrations qualify behavior.
