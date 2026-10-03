import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../database.ts';
import { ensureProfileDirectories } from '../../profile-storage.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  type RecordStorage,
  type AttachRecordDurabilityOptions,
} from '../../record-versions.ts';
import * as intake from '../../intake.ts';
import { intakeSourceRoute } from '../../intake-source-routes.ts';
import { getIntakeSourceText, getIntakeSourceTextPassage } from '../../intake-source-text.ts';
import {
  acceptIntakeReportSelection,
  getIntakeReportAcceptance,
} from '../../intake-report-acceptance.ts';
import { fictionalModel } from '../fictional-model.ts';
import type { HealthRecordEnvelope } from '../../../shared/intake.ts';
import { intakeWorkCounters } from '../../intake-work-accounting.ts';

export const CLINICAL_LITERALS = ['< 0.030', '+004.500', '7.20', '−0.125'] as const;
const literalFor = (index: number) =>
  CLINICAL_LITERALS[index % 100 === 0 ? index / 100 : index % 4]!;
export function fictionalEnvelope(index: number): HealthRecordEnvelope {
  return {
    format: 'health-record-v1',
    id: `juniper-measure-${index}`,
    kind: 'record',
    payload: {
      literal: literalFor(index),
      administrative: 'Invented specimen courier log. '.repeat(20),
    },
    provenance: {
      capturedVia: 'Fictional courier',
      sourceSystem: 'Invented Juniper Lab',
      sourceRecordId: `specimen-${index}`,
      evidenceClass: 'provider_export',
      locator: `supplied text specimen ${index}`,
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: {
      kind: 'observation',
      subject: 'self',
      testLabel: `Invented serum measure ${index}`,
      valueText: literalFor(index),
      unit: 'mg/L',
      date: '2025-04',
    },
  };
}

export async function createMutationFixture(
  t: TestContext,
  options: {
    storageFactory?: (root: string, profileId: string) => RecordStorage;
    verifyReferencesFactory?: (
      root: string,
      profileId: string,
    ) => AttachRecordDurabilityOptions['verifyReferences'];
    fileWorkSnapshot?: () => Record<string, number>;
  } = {},
) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-intake-mutations-'));
  const profileId = 'fictional-juniper';
  const databasePath = ensureProfileDirectories(root, profileId).database;
  let db = openDatabase(databasePath, profileId),
    closed = false;
  const objects = new Map<string, Buffer>();
  const backend = options.storageFactory?.(root, profileId);
  const verifyReferences = options.verifyReferencesFactory?.(root, profileId);
  const io = {
    reads: 0,
    missingReads: 0,
    readBytes: 0,
    immutableReads: 0,
    immutableReadBytes: 0,
    headReads: 0,
    headReadBytes: 0,
    immutableWrites: 0,
    immutableWriteBytes: 0,
    headWrites: 0,
    headWriteBytes: 0,
    copiedBytes: 0,
  };
  const storage: RecordStorage = {
    read(name) {
      io.reads++;
      const value = backend ? backend.read(name) : objects.get(name);
      if (!value) {
        io.missingReads++;
        return null;
      }
      io.readBytes += value.length;
      io.copiedBytes += value.length;
      if (name === 'head') {
        io.headReads++;
        io.headReadBytes += value.length;
      } else {
        io.immutableReads++;
        io.immutableReadBytes += value.length;
      }
      return Buffer.from(value);
    },
    writeImmutable(name, bytes) {
      assert.equal(objects.has(name), false);
      backend?.writeImmutable(name, bytes);
      objects.set(name, Buffer.from(bytes));
      io.immutableWrites++;
      io.immutableWriteBytes += bytes.length;
      io.copiedBytes += bytes.length;
    },
    publishHead(bytes) {
      backend?.publishHead(bytes);
      objects.set('head', Buffer.from(bytes));
      io.headWrites++;
      io.headWriteBytes += bytes.length;
      io.copiedBytes += bytes.length;
    },
  };
  attachRecordDurability(db, { profileId, storage, verifyReferences });
  const phases: Record<string, unknown> = {
    attachment: {
      io: { ...io },
      host: intakeWorkCounters(db),
      fileWork: options.fileWorkSnapshot?.(),
    },
  };
  const bytes = Buffer.from(
    'Invented Juniper Lab courier manifest. Fictional measurements, April 2025.\n' +
      Array.from(
        { length: 301 },
        (_, index) =>
          `Specimen ${index}; Invented serum measure ${index}; ${literalFor(index)} mg/L; date 2025-04. Invented specimen courier log.`,
      ).join('\n'),
  );
  const uploaded = intake.uploadIntake(db, root, profileId, {
    filename: 'invented-juniper.txt',
    bytes,
    newProviderName: 'Invented receiving clinic',
  });
  const original = {
    id: uploaded.id,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  phases.registration = {
    io: { ...io },
    host: intakeWorkCounters(db),
    fileWork: options.fileWorkSnapshot?.(),
  };
  await intakeSourceRoute({
    db,
    root,
    profileId,
    id: original.id,
    action: 'source-extract',
    input: { operationId: 'source-capture', expectedRevisionId: null },
    params: new URLSearchParams(),
  });
  const sourceText = getIntakeSourceText(db, root, profileId, original.id);
  assert.equal(sourceText.status, 'available');
  phases.sourceCapture = {
    io: { ...io },
    host: intakeWorkCounters(db),
    fileWork: options.fileWorkSnapshot?.(),
  };
  const planned = await intake.createIntakePlan(db, root, profileId, original.id, {
    version: intake.getIntake(db, root, profileId, original.id).version,
  });
  const plan = planned.workflow!.plans[0]!;
  const unit = plan.units[0]!;
  const read = intake.readIntakeUnit(db, root, profileId, original.id, unit.id);
  assert.ok(read);
  phases.planAndRead = {
    io: { ...io },
    host: intakeWorkCounters(db),
    fileWork: options.fileWorkSnapshot?.(),
  };
  const proposals = new Map<number, string>();
  const proposalBytes = new Map<string, Buffer>();
  const operationIds: string[] = [];
  const fixture = {
    root,
    profileId,
    databasePath,
    original,
    storage,
    objects,
    io,
    proposals,
    proposalBytes,
    operationIds,
    phases,
    get db() {
      return db;
    },
    physicalEvidenceInventory() {
      const rows = db.prepare('SELECT kind,path,bytes FROM source_files ORDER BY path').all();
      const byKind = new Map<string, { files: number; bytes: number }>();
      for (const row of rows) {
        const bytes = statSync(join(root, String(row.path))).size;
        assert.equal(
          bytes,
          Number(row.bytes),
          'physical source inventory agrees with retained source identity',
        );
        const item = byKind.get(String(row.kind)) ?? { files: 0, bytes: 0 };
        item.files++;
        item.bytes += bytes;
        byKind.set(String(row.kind), item);
      }
      return {
        files: rows.length,
        bytes: [...byKind.values()].reduce((sum, item) => sum + item.bytes, 0),
        byKind: Object.fromEntries(byKind),
      };
    },
    async prepare(index: number) {
      const revision = getIntakeSourceText(db, root, profileId, original.id).revision!;
      const marker = `Specimen ${index};`;
      const offset = revision.spans.findIndex((span) => span.text.includes(marker));
      assert.ok(offset >= 0, 'fictional assertion has retained durable source text');
      const character = revision.spans[offset]!.text.indexOf(marker);
      const passage = getIntakeSourceTextPassage(db, root, profileId, original.id, {
        revisionId: revision.id,
        offset,
        character,
        maxCharacters: 1000,
        limit: 1,
      });
      assert.ok(passage.spans[0]!.text.includes(`${literalFor(index)} mg/L`));
      const current = intake.getIntake(db, root, profileId, original.id);
      const next = intake.submitIntakeBatch(db, root, profileId, original.id, {
        version: current.version,
        planId: plan.id,
        operationId: `batch-${index}`,
        jsonlText: JSON.stringify(fictionalEnvelope(index)),
        summary: `Reviewed fictional specimen ${index}`,
        coverage: [
          { unitId: unit.id, kind: 'extracted', notes: `Retained source specimen ${index}` },
        ],
      });
      const proposalId = next.proposals.at(-1)!.id;
      proposals.set(index, proposalId);
      proposalBytes.set(proposalId, Buffer.from(JSON.stringify(fictionalEnvelope(index))));
      const review = intake.reviewIntake(db, root, profileId, original.id, proposalId);
      const record = review.records[0]!;
      const identity = record.issues?.find((issue) => issue.kind === 'identity');
      intake.saveIntakeReviewDraft(db, root, profileId, original.id, {
        version: next.version,
        operationId: `draft-${index}`,
        proposalId,
        recordId: record.id,
        candidateVersionId: record.candidateVersionId!,
        mapping: { unit: 'mg/L' },
        resolutions: identity
          ? [{ issueId: identity.id, outcome: 'this_is_me', mapping: { subject: 'self' } }]
          : [],
      });
      return { proposalId, recordId: record.id };
    },
    acceptanceRequest(index: number, operationId: string) {
      const proposalId = proposals.get(index)!;
      const review = intake.reviewIntake(db, root, profileId, original.id, proposalId);
      return {
        operationId,
        blocks: [
          {
            intakeId: original.id,
            proposalId,
            intakeVersion: review.version,
            reviewToken: review.reviewToken,
            selections: review.records.map((record) => ({
              recordId: record.id,
              candidateId: record.candidateId!,
              candidateVersionId: record.candidateVersionId!,
              selectionReviewToken: record.selectionReviewToken,
              mapping: record.mapping,
            })),
          },
        ],
      };
    },
    accept(index: number, operationId: string) {
      const result = acceptIntakeReportSelection(
        db,
        root,
        profileId,
        fixture.acceptanceRequest(index, operationId),
      );
      if (!operationIds.includes(operationId)) operationIds.push(operationId);
      return result;
    },
    snapshot() {
      return {
        intake: intake.getIntake(db, root, profileId, original.id),
        receipts: operationIds.map((id) => getIntakeReportAcceptance(db, root, profileId, id)),
        clinical: db
          .prepare(
            'SELECT value_text,unit,effective_at,date_precision,label FROM observations ORDER BY label',
          )
          .all(),
      };
    },
    close() {
      if (!closed) {
        db.close();
        closed = true;
      }
    },
    reopen() {
      fixture.close();
      db = openDatabase(databasePath, profileId);
      closed = false;
      attachRecordDurability(db, { profileId, storage, verifyReferences });
      return db;
    },
    rebuild() {
      fixture.close();
      rmSync(databasePath, { force: true });
      rmSync(databasePath + '-wal', { force: true });
      rmSync(databasePath + '-shm', { force: true });
      rebuildRecordDatabase(databasePath, { profileId, storage, verifyReferences });
      db = openDatabase(databasePath, profileId);
      closed = false;
      attachRecordDurability(db, { profileId, storage, verifyReferences });
      return db;
    },
  };
  t.after(() => {
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  });
  return fixture;
}
