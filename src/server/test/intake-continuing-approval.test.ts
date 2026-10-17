import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { saveMappingRule } from '../clinical-import.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import {
  uploadIntake,
  getIntake,
  proposeConversion,
  reviewIntake,
  saveIntakeReviewDraft,
} from '../intake.ts';
import { publishIntakeSourceText } from '../intake-source-text.ts';
import { planIntakeReportAcceptance } from '../intake-acceptance-plan.ts';
import { acceptIntakeReportSelectionAsync } from '../intake-report-acceptance.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { selectedFixtureReview } from './helpers/selected-intake.ts';
import { getIntakeIdentityScope, confirmIntakeIdentityScope } from '../intake-identity.ts';
import { createNote } from '../notes.ts';
import type { SourceTextEvidence } from '../../shared/intake-source-text.ts';
import type { IntakeReportAcceptanceBlock, IntakeReviewRecord } from '../../shared/intake.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-continuing-approval-')),
    profileId = 'fictional-continuing';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, root, profileId };
}
function clinical(id: string, subject = 'self') {
  return {
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: { literal: '7' },
    provenance: {
      capturedVia: 'Fictional export',
      sourceSystem: 'Fictional clinic',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'page 1 row ' + id,
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: {
      kind: 'observation',
      subject,
      testLabel: id,
      valueText: '7',
      unit: 'mg',
      date: '2026-01-01',
    },
  };
}
function block(
  intakeId: string,
  proposalId: string,
  review: { version: number; reviewToken: string; records: IntakeReviewRecord[] },
): IntakeReportAcceptanceBlock {
  return {
    intakeId,
    proposalId,
    intakeVersion: review.version,
    reviewToken: review.reviewToken,
    selections: review.records.map((r) => ({
      recordId: r.id,
      candidateId: r.candidateId!,
      candidateVersionId: r.candidateVersionId!,
      selectionReviewToken: r.selectionReviewToken,
      mapping: r.mapping,
    })),
  };
}
for (const native of [false, true])
  for (const mutation of ['unrelated', 'source', 'rule'])
    test(`${native ? 'native' : 'legacy'} real clinical approval after ${mutation} continuing publication`, async (t) => {
      const relevant = mutation !== 'unrelated';
      const f = fixture(t),
        id = 'Fictional independent marker';
      const original = uploadIntake(f.db, f.root, f.profileId, {
        filename: 'fictional-two-pages.txt',
        bytes: Buffer.from('Fictional independent marker 7 mg.\nFictional routing page.'),
      });
      const evidence: SourceTextEvidence = {
        adapter: { name: 'fictional-pages', version: '1' },
        pages: [
          { page: 1, disposition: 'extracted', inspected: false },
          { page: 2, disposition: 'partial', inspected: false },
        ],
        spans: [
          {
            id: 'fictional-page-one',
            text: 'Fictional independent marker 7 mg.',
            region: { page: 1 },
            provenance: 'native',
          },
        ],
        relations: [],
        issues: [],
      };
      const source = publishIntakeSourceText(f.db, f.root, f.profileId, original.id, {
        operationId: randomUUID(),
        expectedRevisionId: null,
        sourceHash: original.sha256,
        evidence,
      });
      const proposed = proposeConversion(
        f.db,
        f.root,
        f.profileId,
        original.id,
        {
          version: getIntake(f.db, f.root, f.profileId, original.id).version,
          jsonlText: JSON.stringify(clinical(id)),
          summary: 'Fictional page one only',
        },
        { observedSourcePages: [{ intakeId: original.id, pages: [1] }] },
      );
      const proposalId = proposed.proposals.at(-1)!.id;
      if (native) await buildIntakeCollectionEnvelope(f.db, { id: original.id });
      const read = () =>
        native
          ? selectedFixtureReview(f.db, f.root, f.profileId, original.id, proposalId)
          : Promise.resolve(reviewIntake(f.db, f.root, f.profileId, original.id, proposalId));
      const before = await read(),
        selected = block(original.id, proposalId, before);
      createNote(f.db, { kind: 'note', title: 'Fictional unrelated administrative memo' });
      const unrelated = await read();
      assert.equal(unrelated.reviewToken, before.reviewToken);
      assert.equal(
        unrelated.records[0]!.selectionReviewToken,
        before.records[0]!.selectionReviewToken,
      );
      const next = structuredClone(evidence);
      next.pages[1]!.disposition = 'extracted';
      next.spans.push({
        id: 'fictional-page-two',
        text: 'Fictional unrelated administrative routing.',
        region: { page: 2 },
        provenance: 'native',
      });
      if (mutation === 'source') next.spans[0]!.text = 'Fictional independent marker 9 mg.';
      publishIntakeSourceText(f.db, f.root, f.profileId, original.id, {
        operationId: randomUUID(),
        expectedRevisionId: source.revision!.id,
        sourceHash: original.sha256,
        evidence: next,
      });
      if (mutation === 'rule')
        transaction(f.db, () =>
          saveMappingRule(
            f.db,
            original.providerId,
            {
              match: { kind: 'observation', label: id },
              set: { testLabel: 'Fictional renamed marker' },
            },
            randomUUID(),
          ),
        );
      const after = await read();
      assert.equal(after.sourceTextStale, mutation === 'source');
      if (relevant)
        assert.notEqual(
          after.records[0]!.selectionReviewToken,
          before.records[0]!.selectionReviewToken,
        );
      else {
        assert.equal(
          after.records[0]!.selectionReviewToken,
          before.records[0]!.selectionReviewToken,
        );
        assert.equal(after.reviewToken, before.reviewToken);
      }
      const plan = await planIntakeReportAcceptance(f.db, f.root, f.profileId, {
        blocks: [selected],
      });
      const saved = await acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, {
        mode: 'partial-v1',
        operationId: randomUUID(),
        plan: { id: plan.planId, chunk: 0 },
        blocks: plan.chunks[0]!,
      });
      if (saved.receipt.atomic) throw Error('Expected partial');
      assert.deepEqual(
        saved.receipt.items.map((i) => i.status),
        [relevant ? 'needs_review' : 'saved'],
      );
      assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, relevant ? 0 : 1);
    });

for (const native of [false, true])
  test(`${native ? 'native' : 'legacy'} mixed actual acceptance names the correct alike-named person and retains stale sibling`, async (t) => {
    const f = fixture(t);
    const birthdays = ['1980-01-01', '1950-01-01'];
    const people = birthdays.map((birthDate, i) =>
      createNote(f.db, {
        kind: 'person',
        title: 'Fictional Rowan Meadow',
        person: {
          fullName: 'Fictional Rowan Meadow',
          birthDate,
          relationship: i ? 'Parent' : 'Sibling',
        },
      }),
    );
    const original = uploadIntake(f.db, f.root, f.profileId, {
      filename: 'fictional-family-reports.txt',
      bytes: Buffer.from(
        birthdays
          .map(
            (birthDate, i) =>
              `Fictional report ROWAN-${i}\nPatient: Fictional Rowan Meadow\nDOB: ${birthDate}\nFictional marker ${i} 7 mg.`,
          )
          .join('\n\n'),
      ),
    });
    const rows = birthdays.map((_, i) => ({
      ...clinical(`Fictional marker ${i}`, 'unknown'),
      report: {
        key: `ROWAN-${i}`,
        title: `Fictional report ROWAN-${i}`,
        anchor: { locator: `report ${i} heading`, text: `Fictional report ROWAN-${i}` },
        subject: { locator: `report ${i} patient`, text: 'Patient: Fictional Rowan Meadow' },
      },
    }));
    const proposed = proposeConversion(f.db, f.root, f.profileId, original.id, {
      version: original.version,
      jsonlText: rows.map((row) => JSON.stringify(row)).join('\n'),
      summary: 'Fictional family records',
    });
    const proposalId = proposed.proposals.at(-1)!.id;
    for (const [i, person] of people.entries()) {
      const group = proposed.workflow!.reportGroups!.find(
        (group) => group.report?.key === `ROWAN-${i}`,
      )!;
      assert.ok(group);
      const scope = await getIntakeIdentityScope(f.db, f.root, f.profileId, original.id, group.id);
      await confirmIntakeIdentityScope(f.db, f.root, f.profileId, original.id, {
        version: scope.intakeVersion,
        operationId: `fictional-rowan-${i}`,
        scope,
        outcome: 'this_is_person',
        attestation: 'confirmed_displayed_identity_questions',
        personSelection: { noteId: person.id, expectedVersion: person.version },
      });
    }
    if (native) await buildIntakeCollectionEnvelope(f.db, { id: original.id });
    const reviewed = native
      ? await selectedFixtureReview(f.db, f.root, f.profileId, original.id, proposalId)
      : reviewIntake(f.db, f.root, f.profileId, original.id, proposalId);
    assert.deepEqual(
      reviewed.records.map((r) => r.identityReview?.assignedPerson?.personId),
      people.map((p) => p.personId),
    );
    const selected = block(original.id, proposalId, reviewed),
      selection = selected.selections[1]!;
    const { saveIntakeReviewDraftRead } = await import('../intake.ts');
    await (native ? saveIntakeReviewDraftRead : saveIntakeReviewDraft)(
      f.db,
      f.root,
      f.profileId,
      original.id,
      {
        version: selected.intakeVersion,
        operationId: randomUUID(),
        proposalId,
        recordId: selection.recordId,
        candidateVersionId: selection.candidateVersionId,
        mapping: { ...selection.mapping, valueText: '9' },
      },
    );
    const plan = await planIntakeReportAcceptance(f.db, f.root, f.profileId, {
      blocks: [selected],
    });
    assert.deepEqual(
      plan.chunks[0]!.flatMap((block) => block.selections.map((item) => item.selectionReviewToken)),
      selected.selections.map((item) => item.selectionReviewToken),
      'planning retains both original approval tokens without refreshing the stale sibling',
    );
    const saved = await acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, {
      mode: 'partial-v1',
      operationId: randomUUID(),
      plan: { id: plan.planId, chunk: 0 },
      blocks: plan.chunks[0]!,
    });
    if (saved.receipt.atomic) throw Error('Expected partial');
    assert.deepEqual(
      saved.receipt.items.map((i) => i.status),
      ['saved', 'needs_review'],
      JSON.stringify(saved.receipt.items),
    );
    assert.deepEqual(
      saved.receipt.items.map((i) => i.personId),
      people.map((p) => p.personId),
    );
    assert.deepEqual(
      saved.receipt.items.map((i) => i.selectionReviewToken),
      selected.selections.map((item) => item.selectionReviewToken),
      'the saved result and stale refusal retain the exact originally approved tokens',
    );
    assert.equal(saved.receipt.items[1]!.reasonCode, 'SELECTION_REVIEW_CHANGED');
    assert.deepEqual(
      f.db
        .prepare('SELECT person_id,value_text FROM observations')
        .all()
        .map((r) => [r.person_id, r.value_text]),
      [[people[0]!.personId, '7']],
    );
    assert.equal(
      saved.receipt.items[0]!.receipt!.records[0]!.identityAttribution?.assignedPerson?.personId,
      people[0]!.personId,
    );
  });
