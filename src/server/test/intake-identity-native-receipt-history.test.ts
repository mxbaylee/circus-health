import test from 'node:test';
import assert from 'node:assert/strict';
import { intakeTransaction } from '../intake.ts';
import { openIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { prepareIntakeWorkflowCommand } from '../intake-workflow-command.ts';
import { readIntakeReviewValue } from '../intake-review-collection.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { clearNativeIdentityPreviews } from '../intake-identity-preview-cache.ts';
import type { IntakeIdentityConfirmation } from '../../shared/intake-identity.ts';
import { fixture } from './intake-identity-native-fixture.ts';

test(
  'actual native identity handles superseded-only receipt history before fresh confirmation',
  { timeout: 300000 },
  async (t) => {
    const f = await fixture(t, true, 1, false, undefined, undefined, true);
    const hydrationBaseline = intakeWorkCounters(f.db).warm.envelopeHydrations;
    const initial = await f.review();
    const reference = initial.scopeReference!;
    assert.ok(reference);
    // A receipt must reference accepted logical authority, rather than the
    // disposable preview snapshot created by GET.
    const accepted = await f.request('identity-scope', {
      version: reference.intakeVersion,
      operationId: 'fictional-before-superseded',
      scope: reference,
      outcome: 'this_is_me',
      attestation: 'confirmed_displayed_identity_questions',
    } satisfies IntakeIdentityConfirmation);
    const current = openIntakeCollectionEnvelope(f.db, { id: f.original.id });
    const workflow = current.child(current.child(current.root(), 'intake')!, 'workflow')!;
    const receipt = readIntakeReviewValue<Record<string, unknown>>(
      current,
      current.childAt(workflow, 'identityConfirmations', 0)!,
      256 * 1024,
    );
    const operationIds = Array.from({ length: 70 }, (_, n) => 'fictional-superseded-' + n);
    const prepared = await prepareIntakeWorkflowCommand(
      f.db,
      { id: f.original.id },
      {
        version: accepted.version,
        operationId: 'fictional-superseded-receipt-history',
        request: { operationIds },
        createdAt: '2026-01-01T00:00:00Z',
        *changes({ workflow }) {
          for (const operationId of operationIds)
            yield {
              op: 'append' as const,
              record: workflow,
              field: 'identityConfirmations',
              jsonText: JSON.stringify({ ...receipt, operationId }),
            };
        },
      },
    );
    if (prepared.replayed) throw Error('Unexpected fixture replay');
    intakeTransaction(
      f.db,
      () => {
        selectedEnvelopeStore(f.db, { id: f.original.id }).collections.stage(prepared.prepared);
        for (const supportOperationId of ['fictional-before-superseded', ...operationIds])
          f.db
            .prepare(
              "INSERT INTO manual_batches(id,title,status,created_at,coverage_json) VALUES(?,'Identity receipt supersession','verified',?,?)",
            )
            .run(
              'supersession:' + supportOperationId,
              '2026-01-01T00:00:00Z',
              JSON.stringify({ supportOperationId }),
            );
      },
      {
        operationId: prepared.publicationId,
        fingerprint: prepared.fingerprint,
      },
    );
    clearNativeIdentityPreviews(f.db);
    const fresh = await f.review();
    assert.equal(fresh.confirmationCount, 0);
    assert.ok(fresh.scopeReference);
    const scope = fresh.scopeReference!;
    const command: IntakeIdentityConfirmation = {
      version: scope.intakeVersion,
      operationId: 'fictional-after-superseded-confirm',
      scope,
      outcome: 'this_is_me',
      attestation: 'confirmed_displayed_identity_questions',
    };
    await f.request('identity-scope', command);
    const after = await f.review();
    assert.equal(after.confirmationCount, 1);
    assert.equal(after.status, 'prior_confirmation');
    assert.equal(after.blocking, false);
    await f.request('identity-scope', command);
    assert.equal((await f.review()).confirmationCount, 1);
    assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, hydrationBaseline);
  },
);

// Real native preparation and HTTP disconnect; no fabricated policy or timer threshold.
