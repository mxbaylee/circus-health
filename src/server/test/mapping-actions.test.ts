import { attachPersonalDurability } from '../portable.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { HttpError, openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake, reviewIntake, importIntake } from '../intake.ts';
import { activeMappingRules, previewMappingChange } from '../clinical-import.ts';
import {
  applyMappingChange as applyMappingChangeRaw,
  mappingAssistantExtensions,
} from '../mapping-actions.ts';
import { rebuildProfile } from '../portable.ts';
import { createNote } from '../notes.ts';

const clinical = {
  kind: 'procedure',
  subject: 'self',
  procedureLabel: 'Example imaging',
  procedureCategory: 'imaging',
  date: '2024-07-10',
};
const envelope = {
  format: 'health-record-v1',
  id: 'procedure-one',
  kind: 'record',
  payload: { verbatim: 'Original report remains unchanged', decimal: 1.0 },
  clinical,
  provenance: {
    capturedVia: 'Patient export',
    sourceSystem: 'Synthetic Hospital',
    sourceRecordId: 'procedure-one',
    evidenceClass: 'provider_export',
    locator: 'page 1 row procedure-one',
  },
  coverage: { status: 'complete_response', notes: [] },
};
type MappingRule = Parameters<typeof previewMappingChange>[2];
interface MappingResult extends Record<string, unknown> {
  changed: number;
  sourceUnchanged: boolean;
  ruleId: string;
  durability: { pending: boolean };
}
interface ProcedureRow {
  id: string;
  source_record_id: string;
  label: string;
  category: string;
  extra_json: string;
}
interface SourceRow {
  id: string;
  raw_json: string;
}
const applyMappingChange = (...args: Parameters<typeof applyMappingChangeRaw>): MappingResult =>
  applyMappingChangeRaw(...args) as MappingResult;

const rule: MappingRule = {
  match: { kind: 'procedure', label: 'Example imaging' },
  set: { procedureLabel: 'Reviewed imaging', procedureCategory: 'pathology' },
};

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-mapping-action-')),
    profileId = 'orchid';
  const paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId);
  attachPersonalDurability(db, { root, profileId: profileId });
  const raw = JSON.stringify(envelope);
  const intake = uploadIntake(db, root, profileId, {
    filename: 'procedure.jsonl',
    newProviderName: 'Example clinic',
    bytes: Buffer.from(raw),
  });
  const review = reviewIntake(db, root, profileId, intake.id);
  importIntake(db, root, profileId, intake.id, {
    version: intake.version,
    reviewToken: review.reviewToken,
    decisions: review.records.map((record) => ({
      recordId: record.id,
      action: 'accept',
      mapping: {},
    })),
  });
  const procedure = db.prepare('SELECT * FROM procedures').get() as ProcedureRow | undefined;
  assert.ok(procedure);
  const source = db
    .prepare('SELECT * FROM source_records WHERE id=?')
    .get(procedure.source_record_id) as SourceRow | undefined;
  assert.ok(source);
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, paths, db, intake, procedure, source, raw };
}

test('mapping apply rejects stale previews and exact token/version mismatches before any change', (t) => {
  const f = fixture(t),
    preview = previewMappingChange(f.db, f.intake.providerId, rule);
  assert.equal(preview.count, 1);
  assert.equal(preview.examples[0].before, 'Example imaging');
  assert.equal(
    f.db.prepare('SELECT label FROM procedures').get()!.label,
    'Example imaging',
    'preview is read-only',
  );
  createNote(f.db, { title: 'Unrelated personal edit' });
  assert.throws(
    () =>
      applyMappingChange(f.db, f.root, f.profileId, {
        providerId: f.intake.providerId,
        rule,
        previewToken: preview.token,
        version: preview.version,
        operationId: 'stale-preview',
      }),
    (error: unknown) => error instanceof HttpError && error.code === 'MAPPING_REVIEW_CHANGED',
  );
  assert.equal(f.db.prepare('SELECT label FROM procedures').get()!.label, 'Example imaging');
  const current = previewMappingChange(f.db, f.intake.providerId, rule);
  assert.throws(
    () =>
      applyMappingChange(f.db, f.root, f.profileId, {
        providerId: f.intake.providerId,
        rule,
        previewToken: 'wrong',
        version: current.version,
        operationId: 'wrong-token',
      }),
    (error: unknown) => error instanceof HttpError && error.code === 'MAPPING_REVIEW_CHANGED',
  );
  assert.throws(
    () =>
      applyMappingChange(f.db, f.root, f.profileId, {
        providerId: f.intake.providerId,
        rule,
        previewToken: current.token,
        version: current.version - 1,
        operationId: 'wrong-version',
      }),
    (error: unknown) => error instanceof HttpError && error.code === 'MAPPING_REVIEW_CHANGED',
  );
  assert.throws(
    () =>
      applyMappingChange(f.db, f.root, 'cookie-dough', {
        providerId: f.intake.providerId,
        rule,
        previewToken: current.token,
        version: current.version,
        operationId: 'wrong-owner',
      }),
    (error: unknown) => error instanceof HttpError && error.code === 'PROFILE_BOUNDARY',
  );
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM manual_batches WHERE title='Import mapping decision'")
      .get()!.n,
    0,
  );
});

test('a newer exact-match rule replaces the prior rule and makes a repeated source assertion a duplicate', (t) => {
  const f = fixture(t);
  const firstRule = {
    match: rule.match,
    set: { procedureLabel: 'First reviewed label' },
  };
  let preview = previewMappingChange(f.db, f.intake.providerId, firstRule);
  applyMappingChange(f.db, f.root, f.profileId, {
    providerId: f.intake.providerId,
    rule: firstRule,
    previewToken: preview.token,
    version: preview.version,
    operationId: 'first-rule',
  });

  const finalRule = {
    match: rule.match,
    set: {
      procedureLabel: 'Final reviewed label',
      procedureCategory: 'laboratory',
    },
  };
  preview = previewMappingChange(f.db, f.intake.providerId, finalRule);
  applyMappingChange(f.db, f.root, f.profileId, {
    providerId: f.intake.providerId,
    rule: finalRule,
    previewToken: preview.token,
    version: preview.version,
    operationId: 'replacement-rule',
  });
  const active = activeMappingRules(f.db, f.intake.providerId);
  assert.equal(active.length, 1);
  assert.deepEqual(active[0].set, finalRule.set);

  const repeated = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'same-source-new-delivery.jsonl',
    providerId: f.intake.providerId,
    bytes: Buffer.from(f.raw),
  });
  const review = reviewIntake(f.db, f.root, f.profileId, repeated.id);
  assert.equal(review.summary.duplicates, 1);
  assert.equal(review.records[0].classification, 'duplicate');
  assert.equal(review.records[0].mapping.procedureLabel, 'Final reviewed label');
  assert.deepEqual(
    JSON.parse(
      String(
        f.db.prepare('SELECT raw_json FROM source_records WHERE id=?').get(f.source.id)!.raw_json,
      ),
    ),
    envelope,
  );
});

test('accepted mapping is idempotent, leaves raw evidence byte-for-byte unchanged, and rebuilds deterministically', (t) => {
  const f = fixture(t),
    beforeRaw = f.source.raw_json,
    preview = previewMappingChange(f.db, f.intake.providerId, rule);
  const request = {
    providerId: f.intake.providerId,
    rule,
    previewToken: preview.token,
    version: preview.version,
    operationId: 'stable-operation',
  };
  const first = applyMappingChange(f.db, f.root, f.profileId, request);
  assert.equal(first.changed, 1);
  assert.equal(first.sourceUnchanged, true);
  let procedure = f.db
    .prepare('SELECT * FROM procedures WHERE id=?')
    .get(f.procedure.id) as unknown as ProcedureRow;
  assert.equal(procedure.label, 'Reviewed imaging');
  assert.equal(procedure.category, 'pathology');
  assert.equal(
    f.db.prepare('SELECT raw_json FROM source_records WHERE id=?').get(f.source.id)!.raw_json,
    beforeRaw,
  );
  assert.deepEqual(JSON.parse(beforeRaw), envelope);
  const firstExtra = JSON.parse(procedure.extra_json);
  assert.equal(firstExtra.mappingCorrections.length, 1);
  const batches = f.db.prepare('SELECT count(*) n FROM manual_batches').get()!.n;
  const second = applyMappingChange(f.db, f.root, f.profileId, request);
  assert.deepEqual(
    JSON.parse(JSON.stringify(second)),
    JSON.parse(JSON.stringify(first)),
    'retry returns the same API-visible receipt',
  );
  const conflictingRule = {
    match: rule.match,
    set: { procedureLabel: 'Different replayed request' },
  };
  const conflictingPreview = previewMappingChange(f.db, f.intake.providerId, conflictingRule);
  assert.throws(
    () =>
      applyMappingChange(f.db, f.root, f.profileId, {
        ...request,
        rule: conflictingRule,
        previewToken: conflictingPreview.token,
        version: conflictingPreview.version,
      }),
    (error: unknown) => error instanceof HttpError && error.code === 'OPERATION_CONFLICT',
    'an idempotency key cannot acknowledge a different mapping request',
  );
  procedure = f.db
    .prepare('SELECT * FROM procedures WHERE id=?')
    .get(f.procedure.id) as unknown as ProcedureRow;
  assert.equal(
    JSON.parse(procedure.extra_json).mappingCorrections.length,
    1,
    'retry does not append another correction',
  );
  assert.equal(
    f.db.prepare('SELECT count(*) n FROM manual_batches').get()!.n,
    batches,
    'retry does not add another receipt or rule',
  );
  const rebuilt = rebuildProfile(f.root, f.profileId, resolve(f.root, 'rebuilt'));
  const db = openDatabase(rebuilt.database, f.profileId);
  attachPersonalDurability(db, { root: resolve(f.root, 'rebuilt'), profileId: f.profileId });
  try {
    const restored = db
      .prepare('SELECT * FROM procedures WHERE id=?')
      .get(f.procedure.id) as unknown as ProcedureRow;
    assert.equal(restored.label, procedure.label);
    assert.equal(restored.category, procedure.category);
    assert.deepEqual(
      JSON.parse(restored.extra_json).mappingCorrections,
      JSON.parse(procedure.extra_json).mappingCorrections,
    );
    assert.equal(
      db.prepare('SELECT raw_json FROM source_records WHERE id=?').get(f.source.id)!.raw_json,
      beforeRaw,
    );
    assert.deepEqual(
      previewMappingChange(db, f.intake.providerId, rule).examples,
      previewMappingChange(f.db, f.intake.providerId, rule).examples,
    );
  } finally {
    db.close();
  }
});

test('retrying an applied operation heals a failed durable publication without applying the mapping twice', (t) => {
  const f = fixture(t),
    preview = previewMappingChange(f.db, f.intake.providerId, rule);
  const request = {
    providerId: f.intake.providerId,
    rule,
    previewToken: preview.token,
    version: preview.version,
    operationId: 'publication-retry',
  };
  let publications = 0;
  const first = applyMappingChange(f.db, f.root, f.profileId, request, {
    exportFn() {
      publications++;
      throw new Error('synthetic publication failure');
    },
  });
  assert.equal(first.changed, 1);
  assert.equal(first.durability.pending, true);
  const mirror = resolve(
    f.paths.root,
    'mappings',
    'import-rules',
    first.ruleId.replace(':', '-') + '.json',
  );
  assert.equal(existsSync(mirror), false);

  const retry = applyMappingChange(f.db, f.root, f.profileId, request, {
    exportFn() {
      publications++;
    },
  });
  assert.equal(publications, 2, 'receipt replay retries publication');
  assert.equal(existsSync(mirror), true, 'receipt replay recreates the durable mapping mirror');
  assert.deepEqual(
    JSON.parse(JSON.stringify(retry)),
    JSON.parse(JSON.stringify({ ...first, durability: undefined })),
  );
  assert.equal(
    JSON.parse(
      String(
        f.db.prepare('SELECT extra_json FROM procedures WHERE id=?').get(f.procedure.id)!
          .extra_json,
      ),
    ).mappingCorrections.length,
    1,
  );
});

test('mapping assistant extension returns the explicit-apply and durable reconciliation contract', async (t) => {
  const f = fixture(t),
    extension = mappingAssistantExtensions(),
    chat = { proposals: [] };
  const proposal = (await extension.call(
    'health_mapping_review',
    {
      providerId: f.intake.providerId,
      kind: 'procedure',
      label: 'Example imaging',
      set: rule.set,
      propose: true,
      reason: 'Synthetic review',
    },
    { db: f.db, chat },
  )) as Parameters<NonNullable<typeof extension.apply>>[0];
  assert.equal(chat.proposals[0], proposal);
  assert.equal(proposal.status, 'pending');
  assert.equal(
    typeof extension.reconcile,
    'function',
    'assistant retries and restarts need a durable receipt lookup',
  );
  const result = extension.apply(proposal, {
    db: f.db,
    root: f.root,
    profileId: f.profileId,
  });
  assert.ok(result && 'applied' in result);
  assert.equal(result.applied, true, 'assistant apply extensions acknowledge explicit application');
  assert.ok(
    extension.reconcile(proposal, {
      db: f.db,
      root: f.root,
      profileId: f.profileId,
    }),
    'the durable mapping receipt prevents duplicate apply after restart',
  );
});

test('renamed imported tests keep their chart identity and group later records with the reviewed name', (t) => {
  const f = fixture(t);
  const uploadLab = (id: string, date: string) => {
    const value = {
      ...envelope,
      id,
      clinical: {
        kind: 'observation',
        subject: 'self',
        testLabel: 'Original test name',
        valueText: '7.20',
        date,
        unit: 'mg/dL',
      },
      provenance: {
        ...envelope.provenance,
        sourceRecordId: id,
        locator: 'row ' + id,
      },
    };
    const intake = uploadIntake(f.db, f.root, f.profileId, {
      filename: id + '.jsonl',
      providerId: f.intake.providerId,
      bytes: Buffer.from(JSON.stringify(value)),
    });
    const review = reviewIntake(f.db, f.root, f.profileId, intake.id);
    return importIntake(f.db, f.root, f.profileId, intake.id, {
      version: review.version,
      reviewToken: review.reviewToken,
      decisions: review.records.map((record) => ({
        recordId: record.id,
        action: 'accept',
        mapping: {},
      })),
    });
  };
  uploadLab('lab-one', '2024-07');
  const before = f.db.prepare('SELECT * FROM observations').get() as
    { test_type_id: string } | undefined;
  assert.ok(before);
  const mapping: MappingRule = {
    match: { kind: 'observation', label: 'Original test name' },
    set: { testLabel: 'Reviewed test name' },
  };
  const preview = previewMappingChange(f.db, f.intake.providerId, mapping);
  applyMappingChange(f.db, f.root, f.profileId, {
    providerId: f.intake.providerId,
    rule: mapping,
    previewToken: preview.token,
    version: preview.version,
    operationId: 'rename-test',
  });
  uploadLab('lab-two', '2025-07');
  const rows = f.db.prepare('SELECT * FROM observations').all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.test_type_id === before.test_type_id));
  assert.ok(rows.every((row) => row.label === 'Reviewed test name'));
  assert.equal(
    f.db.prepare('SELECT label FROM test_types WHERE id=?').get(before.test_type_id)!.label,
    'Reviewed test name',
  );
});

test('source-scoped renames cannot rename another provider group while moving several observations', (t) => {
  const f = fixture(t);
  const add = (id: string, providerName: string) => {
    const value = {
      ...envelope,
      id,
      clinical: {
        kind: 'observation',
        subject: 'self',
        testLabel: 'Shared test',
        valueText: id === 'a' ? '7' : '8',
        unit: 'mg/dL',
      },
      provenance: {
        ...envelope.provenance,
        sourceRecordId: id,
        locator: 'row ' + id,
      },
    };
    const intake = uploadIntake(f.db, f.root, f.profileId, {
      filename: id + '.jsonl',
      newProviderName: providerName,
      bytes: Buffer.from(JSON.stringify(value)),
    });
    const r = reviewIntake(f.db, f.root, f.profileId, intake.id);
    importIntake(f.db, f.root, f.profileId, intake.id, {
      version: r.version,
      reviewToken: r.reviewToken,
      decisions: r.records.map((record) => ({
        recordId: record.id,
        action: 'accept',
        mapping: {},
      })),
    });
    return intake;
  };
  const a = add('a', 'First clinic');
  add('b', 'First clinic');
  const other = add('c', 'Second clinic');
  const old = String(
    f.db.prepare('SELECT test_type_id FROM observations WHERE provider_id=?').get(other.providerId)!
      .test_type_id,
  );
  const rule: MappingRule = {
    match: { kind: 'observation', label: 'Shared test' },
    set: { testLabel: 'First clinic label' },
  };
  const p = previewMappingChange(f.db, a.providerId, rule);
  applyMappingChange(f.db, f.root, f.profileId, {
    providerId: a.providerId,
    rule,
    previewToken: p.token,
    version: p.version,
    operationId: 'split-chart',
  });
  assert.equal(
    f.db.prepare('SELECT label FROM test_types WHERE id=?').get(old)!.label,
    'Shared test',
  );
  const rows = f.db.prepare('SELECT * FROM observations WHERE provider_id=?').all(a.providerId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.test_type_id, rows[1]!.test_type_id);
  assert.notEqual(rows[0]!.test_type_id, old);
});
