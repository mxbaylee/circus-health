import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { observeIntakeVersion, intakeVersionConflictFacts } from '../import-version-diagnostics.ts';
import {
  createImportDiagnostics,
  beginImportPhase,
  diagnosticFailureFields,
} from '../import-diagnostics.ts';
import { withDiagnosticContext } from '../import-diagnostic-error.ts';
import { HttpError } from '../database.ts';
import { ModelToolValidationError } from '../model-tool-validation.ts';

test('version observations distinguish identity from later proposal changes, remain private and reject rolled-back state', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const first = { version: 2, workflow: { identityConfirmations: [] }, proposals: [] };
    const identity = {
      ...first,
      version: 3,
      workflow: { identityConfirmations: [{ name: 'PRIVATE_FICTIONAL_NAME' }] },
    };
    const proposal = { ...identity, version: 4, proposals: [{ text: 'PRIVATE_FICTIONAL_TEXT' }] };
    observeIntakeVersion(db, 'PRIVATE_SOURCE_ID', first, identity, JSON.stringify(identity));
    observeIntakeVersion(db, 'PRIVATE_SOURCE_ID', identity, proposal, JSON.stringify(proposal));
    const facts = intakeVersionConflictFacts(
      db,
      'PRIVATE_SOURCE_ID',
      2,
      4,
      JSON.stringify(proposal),
    );
    assert.equal(facts.identityChanges, 1);
    assert.equal(facts.proposalChanges, 1);
    assert.equal(facts.lastChangeCategory, 'proposal');
    assert.equal(facts.versionHistoryComplete, true);
    assert.equal(facts.expectedVersion, 2);
    assert.equal(facts.currentVersion, 4);
    const wrapped = new ModelToolValidationError(
      'VERSION_CONFLICT',
      'PRIVATE_MESSAGE',
      withDiagnosticContext(new HttpError(409, 'VERSION_CONFLICT', 'PRIVATE_MESSAGE'), facts),
    );
    assert.equal(diagnosticFailureFields(wrapped).identityChanges, 1);
    assert.doesNotMatch(JSON.stringify(diagnosticFailureFields(wrapped)), /PRIVATE/);
    assert.equal(
      intakeVersionConflictFacts(db, 'PRIVATE_SOURCE_ID', 2, 3, JSON.stringify(identity))
        .versionHistoryComplete,
      false,
      'rolled back later write cannot be asserted as committed history',
    );
    assert.equal(
      intakeVersionConflictFacts(db, 'PRIVATE_SOURCE_ID', 1, 4, JSON.stringify(proposal))
        .versionHistoryComplete,
      false,
      'missing earlier history stays unknown',
    );
    assert.equal(
      intakeVersionConflictFacts(db, 'missing', 2, 4, JSON.stringify(proposal)).lastChangeCategory,
      'unknown',
    );
    const unseen = { ...identity, workflow: { identityConfirmations: [], questions: ['PRIVATE'] } };
    const next = { ...unseen, version: 4, proposals: ['PRIVATE'] };
    observeIntakeVersion(db, 'PRIVATE_SOURCE_ID', unseen, next, JSON.stringify(next));
    const broken = intakeVersionConflictFacts(db, 'PRIVATE_SOURCE_ID', 2, 4, JSON.stringify(next));
    assert.equal(broken.versionHistoryComplete, false);
    assert.equal(
      broken.identityChanges,
      0,
      'rolled-back identity cannot reappear through an unobserved replacement',
    );
    assert.equal(broken.observedVersionChanges, 1);
  } finally {
    db.close();
  }
});

test('failure and recovery sequence survives unrelated detail eviction and summary reload with explicit truncation', () => {
  let bytes: Uint8Array | null = null;
  const store = {
    read: () => bytes,
    write: (value: Uint8Array) => {
      bytes = value;
    },
  };
  const d = createImportDiagnostics({ enabled: false });
  d.attachSummaryStore('fictional', store);
  const context = { profileId: 'fictional', operationId: 'fictional-operation' };
  beginImportPhase('model_tool', { toolName: 'health_intake_batch' }, context, d).fail(
    withDiagnosticContext(new HttpError(409, 'VERSION_CONFLICT', 'PRIVATE'), {
      expectedVersion: 2,
      currentVersion: 3,
      lastChangeCategory: 'identity_confirmation',
    }),
  );
  d.record('import.progress', { recoveryAction: 'refresh_context', recoveryAttempt: 1 }, context);
  d.record(
    'import.progress',
    { recoveryAction: 'context_read', contextSection: 'question_answers', windowOrdinal: 1 },
    context,
  );
  d.record(
    'import.progress',
    { recoveryAction: 'source_read', page: 3, windowOrdinal: 2, repeatedWindowCount: 2 },
    context,
  );
  for (let i = 0; i < 300; i++) d.record('import.progress', { readWindows: i }, context);
  let timeline = d.exportSnapshot('fictional').recentPerformance!.operations[0]!;
  assert.equal(timeline.recoverySequence?.length, 4);
  assert.equal(timeline.recoverySequence![0]!.fields.lastChangeCategory, 'identity_confirmation');
  assert.equal(timeline.recoverySequence![2]!.fields.contextSection, 'question_answers');
  assert.ok(timeline.droppedEvents > 0);
  for (let i = 0; i < 50; i++)
    d.record(
      'import.progress',
      { recoveryAction: 'source_read', windowOrdinal: 2, repeatedWindowCount: i },
      context,
    );
  d.flushSummaries('fictional');
  d.close();
  const restored = createImportDiagnostics({ enabled: false });
  restored.attachSummaryStore('fictional', store);
  timeline = restored.exportSnapshot('fictional').recentPerformance!.operations[0]!;
  assert.equal(timeline.recoverySequence?.length, 48);
  assert.equal(timeline.recoverySequenceDropped, 6);
  assert.equal(timeline.firstFailure?.fields.expectedVersion, 2);
  assert.doesNotMatch(JSON.stringify(timeline), /PRIVATE/);
  restored.close();
});
