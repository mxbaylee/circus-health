import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { openIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import { openSelectedReportSourceAuthority } from '../intake-report-source-authority.ts';
import { intakeReportSourceReference, intakeReportSourceScope } from '../intake-report-source.ts';
import { canonicalLiteral } from '../intake-format.ts';
import type { IntakeReportGroup } from '../../shared/intake.ts';

test('selected historical source fingerprints preserve giant unknown context and exact old truthiness', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-source-authority-')),
    db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const identity = {
    profileId: 'fictional',
    intakeId: 'fictional-original',
    sourceHash: 'c'.repeat(64),
  };
  const contexts = [
    null,
    {
      status: 'linked',
      contextId: 'context',
      sourceSuggestion: { value: 'Fictional source', unknown: '🌼'.repeat(25000) },
      unknown: { evidence: '🌿'.repeat(30000) },
    },
    { status: 'ambiguous', contextId: 'other', sourceSuggestion: null },
    false,
    '',
    0,
  ];
  const group = {
    id: 'group',
    basis: 'report_anchor',
    sourceFileId: identity.intakeId,
    sourceHash: identity.sourceHash,
    sourceSystem: null,
    memberId: null,
    report: {
      anchor: { text: '🌺'.repeat(20000), unknown: 'retained' },
      subject: { unknown: 'evidence' },
    },
    versions: contexts.map((context, index) => ({
      id: 'version-' + index,
      contributionId: 'contribution-' + index,
      createdAt: '2026-01-01',
      context,
      members: [],
      contextState: index === 2 ? 'mixed' : 'uniform',
    })),
  } as unknown as IntakeReportGroup;
  const initial = prepareInitialIntakeEnvelope({
    intake: {
      version: 1,
      workflow: {
        format: 'health-intake-workflow-v1',
        candidates: [],
        questions: [],
        plans: [],
        reportGroups: [group],
      },
    },
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(
      identity.intakeId,
      'fictional.pdf',
      identity.sourceHash,
      0,
      'intake_original',
      initial.detailsJson,
    );
    createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
  });
  const source = { id: identity.intakeId, sha256: identity.sourceHash };
  await buildIntakeCollectionEnvelope(db, source);
  const view = openIntakeCollectionEnvelope(db, source),
    workflow = view.child(view.child(view.root(), 'intake')!, 'workflow')!,
    record = view.childAt(workflow, 'reportGroups', 0)!;
  const authority = await openSelectedReportSourceAuthority(db, view, record);
  for (let index = 0; index < group.versions.length; index++) {
    const version = await authority.version(view.childAt(record, 'versions', index)!);
    try {
      assert.deepEqual(
        version.reference(),
        intakeReportSourceReference(group, group.versions[index]!),
      );
      for (const basis of [undefined, 'manual_report_label', 'explicit_current_members'] as const)
        assert.deepEqual(
          version.scope(basis),
          intakeReportSourceScope(group, group.versions[index]!, basis),
        );
      assert.equal(
        [...version.canonicalContext()].join(''),
        canonicalLiteral(group.versions[index]!.context || null),
      );
      if (index === 1)
        assert.equal([...version.suggestion()!].join(''), JSON.stringify('Fictional source'));
    } finally {
      version.close();
    }
    assert.throws(() => version.reference(), /closed/);
  }
});
