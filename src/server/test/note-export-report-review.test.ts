import { writeIntakeFixtureEnvelope } from './helpers/intake-authority-fixture.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { attachPersonalDurability } from '../portable.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { getNote } from '../notes.ts';
import { uploadIntake, reviewIntake, importIntake } from '../intake.ts';
import { exportSnapshot, exportHtml, exportEvidence } from '../note-exports.ts';
import type { HealthRecordEnvelope, IntakeWorkflow } from '../../shared/intake.ts';
import { packetReportReview } from '../packet-report-review.ts';

// Independent clinical saves must not make a partial panel look complete to
// its receiving clinician; see docs/import/review-reliability.md.
test('provider PDF source and evidence count saved report items, then refresh after the rest are accepted', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-panel-packet-'));
  const profileId = 'fictional-panel';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId: profileId });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const envelopes: HealthRecordEnvelope[] = Array.from({ length: 3 }, (_, index) => ({
    format: 'health-record-v1',
    id: `fictional-panel-${index}`,
    kind: 'record',
    payload: { literal: `Fictional result ${index}` },
    provenance: {
      sourceSystem: 'Fictional Lab',
      sourceRecordId: `fictional-panel-${index}`,
      capturedVia: null,
      evidenceClass: 'provider_export',
      locator: `Fictional panel row ${index}`,
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: {
      kind: 'observation',
      subject: 'self',
      testLabel: `Fictional test ${index}`,
      valueText: String(10 + index),
      unit: 'mg',
      date: '2026-03-01',
    },
    report: {
      key: 'fictional-panel',
      title: 'Fictional panel',
      anchor: { locator: 'heading', text: 'Fictional panel' },
      subject: null,
    },
  }));
  envelopes.push({
    ...envelopes[0]!,
    id: 'unrelated-report',
    provenance: { ...envelopes[0]!.provenance, sourceRecordId: 'unrelated-report' },
    report: {
      key: 'unrelated',
      title: 'Unrelated private report',
      anchor: { locator: 'another heading', text: 'Unrelated private report' },
      subject: null,
    },
  });
  const item = uploadIntake(db, root, profileId, {
    filename: 'fictional-panel.jsonl',
    bytes: Buffer.from(envelopes.map((entry) => JSON.stringify(entry)).join('\n')),
    newProviderName: 'Fictional Lab',
  });
  const save = (indexes: number[]) => {
    const review = reviewIntake(db, root, profileId, item.id);
    importIntake(db, root, profileId, item.id, {
      version: review.version,
      reviewToken: review.reviewToken,
      decisions: indexes.map((index) => ({
        recordId: review.records[index]!.id,
        action: 'accept' as const,
        mapping: {},
      })),
    });
  };
  save([0, 1]);
  const self = getNote(db, 'person-note:self');
  const input = { type: 'note', id: self.id, noteVersion: self.version, mode: 'provider' };
  const partial = exportSnapshot(db, input);
  const evidence = exportEvidence(partial);
  assert.ok(Array.isArray(evidence.reportReview));
  assert.equal(evidence.reportReview.length, 1);
  assert.deepEqual(
    evidence.reportReview.map((report) => ({
      title: report.title,
      saved: report.savedCount,
      total: report.totalCount,
    })),
    [{ title: 'Fictional panel', saved: 2, total: 3 }],
  );
  assert.match(exportHtml(partial), /2 of 3 current report items reviewed and saved/);
  const first = db.prepare('SELECT id FROM observations ORDER BY id LIMIT 1').get();
  assert.ok(first);
  const brief = exportSnapshot(db, {
    type: 'note',
    id: self.id,
    noteVersion: self.version,
    mode: 'brief',
    selected: [`observation:${first.id}`],
  });
  assert.match(exportHtml(brief), /2 of 3 current report items reviewed and saved/);
  save([2]);
  const complete = exportSnapshot(db, input);
  const completeEvidence = exportEvidence(complete);
  assert.ok(Array.isArray(completeEvidence.reportReview));
  assert.equal(completeEvidence.reportReview[0].savedCount, 3);
  assert.equal(completeEvidence.reportReview[0].totalCount, 3);
  assert.notEqual(complete.fingerprint, partial.fingerprint);
  assert.doesNotMatch(exportHtml(complete), /2 of 3 current report items reviewed and saved/);
  assert.doesNotMatch(JSON.stringify(completeEvidence.reportReview), /Unrelated private report/);

  // Synthetic retained workflow history pins the counting rule independently
  // of ingestion: old accepted versions and repeated occurrences do not inflate
  // current counts, and source-context / named-person rows are not clinical items.
  const details = JSON.parse(String(readIntakeEnvelopeText(db, { id: item.id })));
  const workflow = details.intake.workflow as IntakeWorkflow;
  const group = workflow.reportGroups!.find((entry) => entry.report?.key === 'fictional-panel')!;
  const members = group.versions.at(-1)!.members;
  const candidate = workflow.candidates.find((entry) => entry.id === members[0]!.candidateId)!;
  const pending = {
    ...candidate.versions.at(-1)!,
    id: 'current-revision',
    status: 'pending' as const,
  };
  candidate.versions.push(pending);
  members.push({ ...members[0]!, candidateVersionId: pending.id });
  members.push(structuredClone(members[1]!));
  for (const flag of ['sourceContext', 'peopleOnly'] as const) {
    const copy = structuredClone(candidate);
    copy.id = flag;
    copy.versions = [{ ...pending, id: flag, [flag]: true }];
    workflow.candidates.push(copy);
    members.push({ candidateId: flag, candidateVersionId: flag, occurrences: [] });
  }
  writeIntakeFixtureEnvelope(db, item.id, details);
  const included = complete.records.flatMap((record) =>
    record.citations.map((citation) => citation.id),
  );
  const counts = packetReportReview(db, [...included, ...included]);
  assert.equal(counts.length, 1);
  assert.equal(counts[0]!.savedCount, 2);
  assert.equal(counts[0]!.totalCount, 3);
  assert.deepEqual(packetReportReview(db, []), []);
});
