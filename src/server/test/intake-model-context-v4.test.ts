import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction, clinicalReviewRevision } from '../database.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import {
  createIntakeStateStorage,
  clearIntakeStateCache,
  type IntakeCollectionChange,
} from '../intake-state-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { buildModelIntakeSectionIndexes } from '../intake-model-section-build.ts';
import { openCollectionModelIntakeBackend } from '../intake-model-collection-backend.ts';
import {
  modelIntakeContextV2,
  type ModelIntakeContextRequestV2,
} from '../intake-model-context-v4.ts';
import {
  modelIntakeContext,
  modelIntakeEvidenceContext,
  type ModelIntakeSection,
} from '../intake-model-context.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { prepareCollectionModelDerived } from '../intake-model-section-update.ts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

test('external policy fragments retain exact source and mapping pins without record authority', async (t) => {
  const f = await fixture(t);
  const value = JSON.stringify({ rule: 'Fictional rule '.repeat(1700) }),
    root = digest(value);
  const backend = openCollectionModelIntakeBackend(f.db, f.source, {
    mappingVersion: 'external-mapping',
    sectionProvider(section) {
      if (section !== 'mapping_rules') return undefined;
      return {
        section: () => ({ state: 'complete' as const, root, count: 1 }),
        sectionPage: () => ({
          root,
          entries: [
            {
              tag: 'mapping_rule',
              records: [],
              externalValue: { key: '0', bytes: Buffer.byteLength(value), root },
            },
          ],
          complete: true,
          after: null,
        }),
        externalFragment(_section, key, options) {
          assert.equal(key, '0');
          const start = Number(options.after ?? 0),
            text = value.slice(start, start + options.bytes);
          return {
            root,
            jsonText: text,
            totalBytes: Buffer.byteLength(value),
            complete: start + text.length === value.length,
            after: start + text.length === value.length ? null : String(start + text.length),
          };
        },
      };
    },
  });
  const first = modelIntakeContextV2(backend, {
    format: 'health-intake-model-context-request-v2',
    section: 'mapping_rules',
    freshStart: true,
  });
  const items = first.items as Array<{ valueFragment: { cursor: string } }>;
  let cursor: string | null = items[0]!.valueFragment.cursor,
    assembled = '';
  while (cursor) {
    const page = modelIntakeContextV2(backend, {
      format: 'health-intake-model-context-request-v2',
      section: 'mapping_rules',
      cursor,
      version: backend.pins.version,
      mappingVersion: backend.pins.mappingVersion,
    });
    assembled += page.jsonText;
    cursor = page.nextCursor as string | null;
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 16000);
  }
  assert.equal(assembled, value);
  assert.throws(
    () =>
      modelIntakeContextV2(backend, {
        format: 'health-intake-model-context-request-v2',
        section: 'mapping_rules',
        cursor: items[0]!.valueFragment.cursor,
        version: backend.pins.version,
        mappingVersion: 'stale',
      }),
    /changed/,
  );
});
async function fixture(t: test.TestContext, giantName?: string, workflowExtras?: object) {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-model-v4-'));
  const identity = {
    profileId: 'fictional-model',
    intakeId: 'fictional-intake',
    sourceHash: 'd'.repeat(64),
  };
  const source = { id: identity.intakeId, kind: 'intake_original', sha256: identity.sourceHash };
  const db = openDatabase(join(directory, 'cache.sqlite'), identity.profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const large = '🌿'.repeat(4000);
  const input = {
    intake: {
      version: 5,
      originalName: 'fictional.zip',
      proposals: [],
      workflow: {
        format: 'health-intake-workflow-v1',
        plans: [],
        questions: [],
        decisions: [],
        candidates: [],
        operations: Array.from({ length: 17 }, (_, index) => ({
          id: `operation-${index}`,
          at: '2026-01-01',
          fingerprint: index === 16 ? large : `fingerprint-${index}`,
        })),
      },
    },
  };
  Object.assign(input.intake.workflow, workflowExtras);
  if (giantName) Reflect.set(input.intake.workflow.operations[0]!, giantName, 42);
  const initial = prepareInitialIntakeEnvelope(giantName ? JSON.stringify(input) : input);
  const storage = createIntakeStateStorage(db, identity);
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(source.id, 'fictional.zip', source.sha256, 0, source.kind, initial.detailsJson);
    storage.stage(initial.state, randomUUID());
  });
  await buildIntakeCollectionEnvelope(db, source);
  const collections = storage.collections;
  function commit(changes: IntakeCollectionChange[]) {
    const operationId = randomUUID();
    const prepared = collections.prepare(collections.openView(), {
      operationId,
      requestDigest: digest(operationId),
      domainVersion: 5,
      changes,
    });
    collections.commitMaintenance(prepared);
  }
  const publish = () =>
    buildModelIntakeSectionIndexes(db, source, { mappingVersion: 'mapping-v1' });
  const backend = () =>
    openCollectionModelIntakeBackend(db, source, { mappingVersion: 'mapping-v1' });
  const read = (section: ModelIntakeSection, cursor?: string, mappingVersion = 'mapping-v1') => {
    const request: ModelIntakeContextRequestV2 = cursor
      ? {
          format: 'health-intake-model-context-request-v2',
          section,
          cursor,
          version: 5,
          mappingVersion,
        }
      : { format: 'health-intake-model-context-request-v2', section, freshStart: true };
    const result = modelIntakeContextV2(backend(), request);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 40 * 1024);
    return result as Record<string, unknown>;
  };
  return { db, source, large, commit, publish, backend, read };
}

test('warm ordered model maps insert earlier-parent versions and answers without rebuilding history', async (t) => {
  const f = await fixture(t, undefined, {
    candidates: [
      { id: 'first', versions: [{ id: 'v0', occurrences: [] }] },
      {
        id: 'later',
        versions: Array.from({ length: 17 }, (_, i) => ({ id: 'later-' + i, occurrences: [] })),
      },
    ],
    questions: [{ id: 'q', answers: [{ id: 'a0', text: 'retained' }] }],
  });
  await f.publish();
  const old = f.read('candidates');
  const view = openIntakeCollectionEnvelope(f.db, f.source),
    flow = view.child(view.child(view.root(), 'intake')!, 'workflow')!,
    candidate = view.find('candidate', flow, 'first')!,
    question = view.find('question', flow, 'q')!;
  const operationId = randomUUID();
  const counters = { ...intakeWorkCounters(f.db).warm };
  const result = await prepareIntakeEnvelopeMutation(f.db, f.source, {
    reader: view,
    operationId,
    requestDigest: digest(operationId),
    domainVersion: 6,
    changes: [
      {
        op: 'append',
        record: candidate,
        field: 'versions',
        jsonText: JSON.stringify({ id: 'v1', occurrences: [{ id: 'o1' }] }),
      },
      {
        op: 'append',
        record: question,
        field: 'answers',
        jsonText: JSON.stringify({ id: 'a1', text: 'new' }),
      },
    ],
    prepareDerived(derived) {
      const c = derived.reader.resolve(view.address(candidate));
      const v = derived.reader.find('version', c, 'v1')!;
      return prepareCollectionModelDerived(f.db, f.source, {
        ...derived,
        mappingVersion: 'mapping-v1',
        affected: {
          candidateChanges: [
            {
              candidateId: 'first',
              candidateVersionId: 'v1',
              candidateAddress: derived.reader.address(c),
              versionAddress: derived.reader.address(v),
              kind: 'append',
            },
          ],
          questionAddresses: [view.address(question)],
          reportGroupAddresses: [],
          proposalIds: [],
        },
      });
    },
  });
  assert.equal(f.backend().section('candidates').state, 'complete');
  assert.equal(f.read('candidates').logicalTotal, 18);
  transaction(f.db, () =>
    selectedEnvelopeStore(f.db, f.source).collections.stage(result.prepared!),
  );
  clearIntakeStateCache(f.db);
  const backend = f.backend();
  const ids: unknown[] = [];
  let after: string | undefined;
  do {
    const page = backend.sectionPage('candidates', { after, items: 8, bytes: 12000 });
    const selected = openIntakeCollectionEnvelope(f.db, f.source);
    for (const entry of page.entries) {
      const record = selected.resolve(backend.address(entry.records[1]!));
      const id = selected.field(record, 'id', { bytes: 256 });
      assert.equal(id.kind, 'value');
      if (id.kind === 'value') ids.push(id.value);
    }
    if (page.complete) break;
    after = page.after!;
  } while (true);
  assert.deepEqual(ids, ['v0', 'v1', ...Array.from({ length: 17 }, (_, i) => 'later-' + i)]);
  assert.deepEqual(backend.section('question_answers').state, 'complete');
  assert.equal(f.read('question_answers').logicalTotal, 2);
  assert.equal(f.read('occurrences').logicalTotal, 1);
  assert.throws(
    () =>
      modelIntakeContextV2(backend, {
        format: 'health-intake-model-context-request-v2',
        section: 'candidates',
        cursor: old.nextCursor as string,
        version: 5,
        mappingVersion: 'mapping-v1',
      }),
    /changed/,
  );
  assert.equal((await f.publish()).reused, true);
  for (const name of ['materializationReads', 'sourceDTOHydrations', 'envelopeHydrations'] as const)
    assert.equal(intakeWorkCounters(f.db).warm[name], counters[name]);
});

test('real selected v4 model sections stay pending until complete and page exact ordered scope without materialization', async (t) => {
  const f = await fixture(t);
  const absent = f.read('operations');
  assert.equal(absent.state, 'pending');
  assert.equal(absent.logicalTotal, null);
  assert.equal(absent.complete, false);
  await f.publish();
  clearIntakeStateCache(f.db);
  const before = intakeWorkCounters(f.db).warm.materializationReads;
  let result = f.read('operations'),
    count = 0,
    lastRecord = '';
  while (true) {
    assert.equal(result.logicalTotal, 17);
    for (const item of result.items as { records: { cursor: string }[] }[]) {
      count++;
      lastRecord = item.records[0]!.cursor;
    }
    if (result.complete) break;
    result = f.read('operations', result.nextCursor as string);
  }
  assert.equal(count, 17);
  let record = f.read('operations', lastRecord);
  const fields: { name: string; cursor?: string; value?: unknown }[] = [];
  while (true) {
    fields.push(...(record.fields as typeof fields));
    if (record.complete) break;
    record = f.read('operations', record.nextCursor as string);
  }
  assert.equal(fields.find((field) => field.name === 'id')?.value, 'operation-16');
  let cursor = fields.find((field) => field.name === 'fingerprint')!.cursor!,
    text = '';
  while (cursor) {
    const fragment = f.read('operations', cursor);
    text += fragment.jsonText;
    cursor = fragment.nextCursor as string;
  }
  assert.equal(JSON.parse(text), f.large);
  assert.equal(intakeWorkCounters(f.db).warm.materializationReads, before);
});

test('model cursors survive auxiliary churn and reject changed pins, cross sections and legacy offsets', async (t) => {
  const f = await fixture(t);
  await f.publish();
  const first = f.read('operations'),
    cursor = first.nextCursor as string;
  f.commit([
    {
      area: 'builds',
      collection: 'fictional.progress',
      op: 'put',
      key: 'checkpoint',
      value: 'next',
    },
  ]);
  assert.equal(f.read('operations', cursor).state, 'ready');
  assert.throws(() => f.read('operations', cursor, 'mapping-v2'), /model context changed/);
  assert.throws(() => f.read('questions', cursor), /model context changed/);
  assert.throws(
    () =>
      modelIntakeContextV2(f.backend(), {
        format: 'health-intake-model-context-request-v2',
        section: 'operations',
        freshStart: true,
        offset: 1,
      } as unknown as ModelIntakeContextRequestV2),
    /legacy offsets/,
  );
  assert.throws(
    () =>
      modelIntakeContextV2(f.backend(), {
        format: 'health-intake-model-context-request-v2',
        section: 'operations',
        freshStart: true,
        version: 5,
      } as unknown as ModelIntakeContextRequestV2),
    /no cursor or version pins/,
  );
  assert.equal(f.read('mapping_rules').state, 'pending');
  const selected = {
    format: 'health-intake-selected-model-source-v2' as const,
    db: f.db,
    source: f.source,
    options: { mappingVersion: 'mapping-v1' },
  };
  const explicit = modelIntakeContext(selected, {
    format: 'health-intake-model-context-request-v2',
    section: 'operations',
    freshStart: true,
  });
  assert.equal(explicit.format, 'health-intake-model-context-v2');
  const evidence = modelIntakeEvidenceContext(selected);
  assert.equal(evidence.currentUnits.state, 'pending');
  assert.equal(evidence.currentUnits.complete, false);
  assert.equal(
    evidence.sections.find((section) => section.section === 'operations')?.state,
    'complete',
  );
});

test('interrupted selected model builds remain pending, preserve clinical revision and reuse completed roots', async (t) => {
  const f = await fixture(t),
    revision = clinicalReviewRevision(f.db);
  await assert.rejects(
    buildModelIntakeSectionIndexes(f.db, f.source, {
      mappingVersion: 'mapping-v1',
      onCheckpoint() {
        throw Error('fictional interruption');
      },
    }),
    /fictional interruption/,
  );
  clearIntakeStateCache(f.db);
  assert.equal(f.read('operations').state, 'pending');
  assert.equal(clinicalReviewRevision(f.db), revision);
  const completed = await f.publish();
  assert.equal(completed.reused, false);
  assert.equal(f.read('operations').logicalTotal, 17);
  assert.equal(clinicalReviewRevision(f.db), revision);
  assert.equal((await f.publish()).reused, true);
});

test('model field-name fragments retain giant unknown names with explicit addressed cursor grammar', async (t) => {
  const name = 'fictional-🌿'.repeat(25000),
    f = await fixture(t, name);
  await f.publish();
  const section = f.read('operations'),
    recordCursor = (section.items as { records: { cursor: string }[] }[])[0]!.records[0]!.cursor;
  let page = f.read('operations', recordCursor),
    target:
      | {
          name: null;
          key: string;
          keyFormat: string;
          value: unknown;
          nameFragment: { bytes: number; cursor: string };
        }
      | undefined;
  do {
    for (const field of page.fields as unknown[])
      if ((field as { name: unknown }).name === null) target = field as typeof target;
    if (page.complete) break;
    page = f.read('operations', page.nextCursor as string);
  } while (true);
  assert.ok(target);
  assert.equal(target.keyFormat, 'field');
  assert.equal(target.value, 42);
  assert.ok(target.key.length < 200);
  assert.ok(target.nameFragment.bytes > 256 * 1024);
  const before = intakeWorkCounters(f.db).warm.envelopeHydrations;
  let text = '',
    cursor = target.nameFragment.cursor,
    pages = 0;
  do {
    assert.ok(cursor.length < 8192);
    const fragment = f.read('operations', cursor);
    assert.ok(Buffer.byteLength(fragment.jsonText as string) <= 4096);
    text += fragment.jsonText;
    pages++;
    if (fragment.complete) break;
    assert.notEqual(fragment.nextCursor, cursor);
    cursor = fragment.nextCursor as string;
  } while (true);
  assert.ok(pages > 64);
  assert.equal(JSON.parse(text), name);
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before);
  const altered = JSON.parse(
    Buffer.from(target.nameFragment.cursor, 'base64url').toString(),
  ) as Record<string, unknown>;
  delete altered.fieldFormat;
  assert.throws(
    () => f.read('operations', Buffer.from(JSON.stringify(altered)).toString('base64url')),
    /missing|changed/,
  );
});
