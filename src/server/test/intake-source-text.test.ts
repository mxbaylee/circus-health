import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase, transaction, type Database } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  type RecordStorage,
} from '../record-versions.ts';
import {
  getIntakeSourceText,
  listSourceAttention,
  getIntakeSourceIssues,
  getIntakeSourceTextPassage,
  getIntakeSourceTextReviewHistory,
  getIntakeSourceTextAnnotation,
  publishIntakeSourceText,
  reviewIntakeSourceText,
  validateSourceTextEvidence,
} from '../intake-source-text.ts';
import type {
  SourceTextEvidence,
  SourceTextRevision,
  SourceTextReviewRequest,
  IntakeSourceText,
} from '../../shared/intake-source-text.ts';
import { assertCurrentProposalSourceText } from '../intake-source-text-dependencies.ts';

const profileId = 'fictional-source-text';
const intakeId = 'fictional-import';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture(t: TestContext, { attach = true } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'circus-source-text-'));
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  const bytes = Buffer.from(
    'FICTIONAL ONLY\nPage 1: No finding. Decimal 1.00.\nPage 2: Administrative routing retained.',
  );
  const path = resolve(paths.sources, 'fictional.txt');
  writeFileSync(path, bytes);
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run(
    intakeId,
    `${paths.relativeRoot}/sources/fictional.txt`,
    digest(bytes),
    bytes.length,
    'intake_original',
    JSON.stringify({ intake: { version: 1, proposals: [] } }),
  );
  const objects = new Map<string, Buffer>();
  const storage: RecordStorage = {
    read: (name) => (objects.has(name) ? Buffer.from(objects.get(name)!) : null),
    writeImmutable: (name, value) => {
      assert.ok(!objects.has(name));
      objects.set(name, Buffer.from(value));
    },
    publishHead: (value) => objects.set('head', Buffer.from(value)),
  };
  if (attach) attachRecordDurability(db, { profileId, storage });
  const opened: Database[] = [db];
  t.after(() => {
    for (const connection of opened)
      try {
        connection.close();
      } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  function rebuild(name = 'rebuilt.sqlite') {
    const target = resolve(root, name);
    rebuildRecordDatabase(target, { profileId, storage });
    const restored = openDatabase(target, profileId);
    opened.push(restored);
    attachRecordDurability(restored, { profileId, storage });
    return restored;
  }
  return { root, db, path, sourceHash: digest(bytes), storage, objects, rebuild };
}
type Fixture = ReturnType<typeof fixture>;
function evidence(): SourceTextEvidence {
  return {
    adapter: { name: 'fictional-native', version: '1' },
    pages: [
      { page: 1, disposition: 'extracted', inspected: false },
      { page: 2, disposition: 'extracted', inspected: false },
    ],
    spans: [
      {
        id: 'a',
        text: 'No finding.',
        region: { page: 1, box: [0.1, 0.1, 0.5, 0.1] },
        provenance: 'native',
      },
      {
        id: 'b',
        text: 'Decimal 1.00.',
        region: { page: 1, box: [0.1, 0.3, 0.5, 0.1] },
        provenance: 'native',
      },
      {
        id: 'c',
        text: 'Administrative routing retained.',
        region: { page: 2, box: [0.1, 0.1, 0.7, 0.1] },
        provenance: 'native',
      },
    ],
    relations: [
      { id: 'r1', kind: 'precedes', from: 'a', to: 'b', provenance: 'adapter' },
      { id: 'r2', kind: 'header-for', from: 'b', to: 'c', provenance: 'adapter' },
    ],
    issues: [
      {
        id: 'coverage',
        region: { page: 1 },
        kind: 'coverage',
        detail: 'Check the whole original, including unflagged content.',
        status: 'open',
      },
    ],
  };
}
function revision(result: IntakeSourceText): SourceTextRevision {
  assert.ok(result.revision);
  return result.revision;
}
function publish(f: Fixture, ev = evidence(), expectedRevisionId: string | null = null) {
  return revision(
    publishIntakeSourceText(f.db, f.root, profileId, intakeId, {
      operationId: randomUUID(),
      sourceHash: f.sourceHash,
      expectedRevisionId,
      evidence: ev,
    }),
  );
}
function review(
  f: Fixture,
  prior: SourceTextRevision,
  input: Partial<SourceTextReviewRequest> = {},
) {
  return revision(
    reviewIntakeSourceText(
      f.db,
      f.root,
      profileId,
      intakeId,
      {
        operationId: randomUUID(),
        sourceHash: f.sourceHash,
        expectedRevisionId: prior.id,
        scope: { page: 1 },
        action: 'confirm',
        ...input,
      },
      'authenticated-fictional-owner',
    ),
  );
}
const code = (wanted: string) => (e: unknown) =>
  !!e && typeof e === 'object' && 'code' in e && e.code === wanted;

test('legacy imports remain explicitly unavailable; evidence survives SQLite loss without model calls', (t) => {
  const f = fixture(t);
  assert.deepEqual(getIntakeSourceText(f.db, f.root, profileId, intakeId), {
    status: 'unavailable',
    revision: null,
    summary: null,
  });
  const initial = publish(f);
  assert.equal(
    getIntakeSourceText(f.db, f.root, profileId, intakeId).summary?.status,
    'needs-review',
  );
  assert.equal(initial.spans[1].text, 'Decimal 1.00.');
  const rebuilt = f.rebuild();
  assert.deepEqual(getIntakeSourceText(rebuilt, f.root, profileId, intakeId).revision, initial);
  assert.deepEqual(
    readFileSync(f.path),
    Buffer.from(
      'FICTIONAL ONLY\nPage 1: No finding. Decimal 1.00.\nPage 2: Administrative routing retained.',
    ),
  );
});

test('source publication rejects unavailable durability and cannot attest human review', (t) => {
  const f = fixture(t, { attach: false });
  assert.throws(() => publish(f), code('SOURCE_TEXT_DURABILITY'));
  attachRecordDurability(f.db, { profileId, storage: f.storage });
  const ev = evidence();
  ev.pages[0].inspected = true;
  assert.throws(() => publish(f, ev), code('SOURCE_TEXT_INVALID'));
});

test('unchanged pages are reused across immutable extraction checkpoints', (t) => {
  const f = fixture(t),
    initial = publish(f);
  const before = f.db
    .prepare("SELECT key FROM app_meta WHERE key LIKE 'intake_source_text:%:blob:%'")
    .all();
  const ev = evidence();
  ev.spans[0].alternatives = [{ text: 'No finding!', adapter: 'fictional-ocr' }];
  const next = publish(f, ev, initial.id);
  const after = f.db
    .prepare("SELECT key FROM app_meta WHERE key LIKE 'intake_source_text:%:blob:%'")
    .all();
  assert.equal(after.length - before.length, 1, 'only changed page content is newly retained');
  assert.equal(next.parentRevisionId, initial.id);
  assert.deepEqual(
    getIntakeSourceText(f.db, f.root, profileId, intakeId, initial.id).revision,
    initial,
  );
});

test('whole inspected page can correct unflagged text; history and outside page remain unchanged', (t) => {
  const f = fixture(t),
    initial = publish(f);
  const corrected = review(f, initial, {
    action: 'correct',
    spans: initial.spans
      .filter((s) => s.region.page === 1)
      .map((s) => ({ ...s, text: s.id === 'b' ? 'Decimal 1.01.' : s.text })),
    relations: initial.relations,
  });
  assert.equal(corrected.spans.find((s) => s.id === 'b')?.text, 'Decimal 1.01.');
  assert.equal(corrected.spans.find((s) => s.id === 'b')?.provenance, 'human');
  assert.deepEqual(
    corrected.spans.find((s) => s.id === 'c'),
    initial.spans.find((s) => s.id === 'c'),
  );
  assert.equal(corrected.pages[0].inspected, false, 'saving text is not full-page inspection');
  assert.deepEqual(
    getIntakeSourceText(f.db, f.root, profileId, intakeId, initial.id).revision,
    initial,
  );
  const envelope = JSON.parse(
    f.db.prepare('SELECT details_json FROM source_files WHERE id=?').get(intakeId)!
      .details_json as string,
  );
  assert.equal(
    envelope.intake.sourceTextRevisionId,
    corrected.id,
    'clinical invalidation is in the durable edit transaction',
  );
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM observations').get()!.n,
    0,
    'text correction cannot accept clinical records',
  );
  assert.throws(() => publish(f, evidence(), corrected.id), code('SOURCE_TEXT_REVIEW_CONFLICT'));
});

test('idempotency, stale tabs, changed operations and recovery preserve one winning review', (t) => {
  const f = fixture(t),
    initial = publish(f);
  const request: SourceTextReviewRequest = {
    operationId: randomUUID(),
    expectedRevisionId: initial.id,
    sourceHash: f.sourceHash,
    action: 'confirm',
    scope: { page: 1 },
  };
  const one = reviewIntakeSourceText(f.db, f.root, profileId, intakeId, request, 'owner');
  assert.deepEqual(
    reviewIntakeSourceText(f.db, f.root, profileId, intakeId, request, 'owner'),
    one,
  );
  assert.throws(() => review(f, initial), code('SOURCE_TEXT_CONFLICT'));
  assert.throws(
    () =>
      reviewIntakeSourceText(
        f.db,
        f.root,
        profileId,
        intakeId,
        { ...request, scope: { page: 2 } },
        'owner',
      ),
    code('OPERATION_CONFLICT'),
  );
  const restored = f.rebuild();
  assert.deepEqual(
    reviewIntakeSourceText(restored, f.root, profileId, intakeId, request, 'owner'),
    one,
  );
});

test('later, unreadable, not-text and clarification are distinct; no empty queue accuracy claim', (t) => {
  const f = fixture(t),
    initial = publish(f);
  const later = review(f, initial, { action: 'later', reason: 'Need a better scan' });
  assert.equal(later.pages[0].inspected, false);
  const unreadable = review(f, later, { action: 'unreadable', reason: 'Original ink is obscured' });
  assert.equal(unreadable.pages[0].disposition, 'unreadable');
  assert.ok(unreadable.spans.length, 'readable material is not deleted by an unreadable exception');
  const clarified = review(f, unreadable, {
    action: 'clarification',
    clarification: 'I remember a different date.',
  });
  assert.deepEqual(clarified.spans, unreadable.spans);
  assert.equal(clarified.review?.clarification, 'I remember a different date.');
  const notText = review(f, clarified, {
    action: 'not-text',
    scope: { page: 1, box: [0.1, 0.1, 0.5, 0.1] },
    reason: 'This marked region is a printer artifact',
  });
  assert.equal(
    notText.spans.some((s) => s.id === 'a'),
    false,
  );
  assert.equal(
    notText.spans.some((s) => s.id === 'b'),
    true,
  );
  assert.equal(
    notText.relations.some((r) => r.from === 'a'),
    false,
  );
  assert.equal(
    getIntakeSourceText(f.db, f.root, profileId, intakeId).summary?.status,
    'needs-review',
    'uninspected page prevents review completion',
  );
});

test('corrections reject out-of-scope loci, unknown endpoints, duplicate IDs and cyclic order', (t) => {
  const f = fixture(t),
    initial = publish(f);
  assert.throws(
    () => review(f, initial, { action: 'correct', spans: [initial.spans[2]] }),
    code('SOURCE_TEXT_INVALID'),
  );
  assert.throws(
    () => review(f, initial, { action: 'correct', spans: [initial.spans[0], initial.spans[0]] }),
    code('SOURCE_TEXT_INVALID'),
  );
  const bad = evidence();
  bad.relations.push({ id: 'bad', kind: 'precedes', from: 'b', to: 'a', provenance: 'adapter' });
  assert.throws(() => validateSourceTextEvidence(bad), code('SOURCE_TEXT_INVALID'));
  const missing = evidence();
  missing.relations[0].to = 'absent';
  assert.throws(() => validateSourceTextEvidence(missing), code('SOURCE_TEXT_INVALID'));
  const gap = evidence();
  gap.pages[1].page = 3;
  assert.throws(() => validateSourceTextEvidence(gap), code('SOURCE_TEXT_INVALID'));
});

test('bounded literal retrieval preserves full spans, revision and explicit continuation', (t) => {
  const f = fixture(t),
    initial = publish(f);
  const first = getIntakeSourceTextPassage(f.db, f.root, profileId, intakeId, { limit: 1 });
  assert.equal(first.revisionId, initial.id);
  assert.equal(first.nextOffset, 1);
  assert.equal(first.spans[0].text, 'No finding.');
  const rest = getIntakeSourceTextPassage(f.db, f.root, profileId, intakeId, { offset: 1 });
  assert.equal(rest.nextOffset, null);
  assert.equal(rest.spans[0].text, 'Decimal 1.00.');
  const fragment = getIntakeSourceTextPassage(f.db, f.root, profileId, intakeId, {
    maxCharacters: 3,
  });
  assert.equal(fragment.spans[0].text, 'No ');
  assert.deepEqual(fragment.spanFragments[0], { spanId: 'a', start: 0, end: 3, total: 11 });
  assert.equal(fragment.nextOffset, 0);
  assert.equal(fragment.nextCharacter, 3);
  const continuation = getIntakeSourceTextPassage(f.db, f.root, profileId, intakeId, {
    offset: fragment.nextOffset!,
    character: fragment.nextCharacter,
    maxCharacters: 8,
  });
  assert.equal(continuation.spans[0].text, 'finding.');
  assert.equal(continuation.nextOffset, 1);
  assert.equal(continuation.nextCharacter, 0);
});

test('profile, path, hash and source replacement boundaries reject before accepting changes', (t) => {
  const f = fixture(t),
    initial = publish(f);
  assert.throws(
    () => getIntakeSourceText(f.db, f.root, 'other-profile', intakeId),
    code('PROFILE_SCOPE'),
  );
  assert.throws(
    () => getIntakeSourceText(f.db, f.root, profileId, '../escape'),
    code('INTAKE_NOT_FOUND'),
  );
  assert.throws(
    () => review(f, initial, { sourceHash: 'f'.repeat(64) }),
    code('SOURCE_TEXT_CONFLICT'),
  );
  writeFileSync(f.path, 'changed original');
  assert.throws(() => getIntakeSourceText(f.db, f.root, profileId, intakeId));
});

test('original symlink escape is rejected and cached text is not served for a different file', (t) => {
  const f = fixture(t);
  publish(f);
  const elsewhere = resolve(f.root, 'outside.txt');
  writeFileSync(elsewhere, readFileSync(f.path));
  rmSync(f.path);
  symlinkSync(elsewhere, f.path);
  assert.throws(() => getIntakeSourceText(f.db, f.root, profileId, intakeId), /escaped/);
});

test('publication failure before durable head leaves no acknowledged source revision', (t) => {
  const f = fixture(t);
  const before = f.objects.get('head')!;
  f.storage.publishHead = () => {
    throw new Error('fictional storage unavailable');
  };
  assert.throws(() => publish(f), /storage unavailable/);
  assert.deepEqual(f.objects.get('head'), before);
  assert.equal(getIntakeSourceText(f.db, f.root, profileId, intakeId).status, 'unavailable');
});

test('crash after durable head publication but before projection recovers text and clinical invalidation', (t) => {
  const f = fixture(t),
    publishHead = f.storage.publishHead;
  f.storage.publishHead = (value) => {
    publishHead(value);
    throw new Error('fictional crash after publication');
  };
  assert.throws(() => publish(f), /crash after publication/);
  f.storage.publishHead = publishHead;
  const restored = f.rebuild(),
    result = getIntakeSourceText(restored, f.root, profileId, intakeId);
  assert.ok(result.revision);
  assert.equal(result.revision.spans.length, 3);
  const envelope = JSON.parse(
    restored.prepare('SELECT details_json FROM source_files WHERE id=?').get(intakeId)!
      .details_json as string,
  );
  assert.equal(envelope.intake.sourceTextRevisionId, result.revision.id);
});

test('corrupt/missing committed journal objects fail rebuild; altered projection text fails retrieval', (t) => {
  const f = fixture(t);
  publish(f);
  const blob = f.db
    .prepare(
      "SELECT key,value FROM app_meta WHERE key LIKE 'intake_source_text:%:blob:%' AND value LIKE '%No finding.%'",
    )
    .get()!;
  f.db
    .prepare('UPDATE app_meta SET value=? WHERE key=?')
    .run((blob.value as string).replace('No finding.', 'Invented.'), blob.key);
  assert.throws(
    () => getIntakeSourceText(f.db, f.root, profileId, intakeId),
    code('SOURCE_TEXT_INTEGRITY'),
  );
  const head = JSON.parse(f.objects.get('head')!.toString());
  f.objects.delete(head.name);
  assert.throws(() => f.rebuild(), /missing, partial or corrupt/);
});

test('unrelated accepted record remains unchanged by source corrections and replay', (t) => {
  const f = fixture(t);
  transaction(f.db, () =>
    f.db
      .prepare(
        "INSERT INTO reports(id,title) VALUES('accepted-fictional','Accepted historical version')",
      )
      .run(),
  );
  const initial = publish(f);
  review(f, initial, {
    action: 'correct',
    spans: [
      {
        id: 'corrected',
        text: 'A human can still be wrong.',
        region: { page: 1 },
        provenance: 'human',
      },
    ],
  });
  assert.equal(
    f.db.prepare("SELECT title FROM reports WHERE id='accepted-fictional'").get()!.title,
    'Accepted historical version',
  );
  const restored = f.rebuild();
  assert.equal(
    restored.prepare("SELECT title FROM reports WHERE id='accepted-fictional'").get()!.title,
    'Accepted historical version',
  );
});

test('machine continuation on another page preserves all human work across further checkpoints', (t) => {
  const f = fixture(t),
    initial = publish(f);
  const human = review(f, initial, {
    action: 'correct',
    spans: initial.spans.filter((s) => s.region.page === 1),
    relations: initial.relations,
  });
  const ev: SourceTextEvidence = structuredClone(human);
  ev.spans.find((s) => s.id === 'c')!.text =
    'Administrative routing retained. Additional native text.';
  const continued = publish(f, ev, human.id);
  assert.deepEqual(continued.protectedPages, [1]);
  assert.equal(continued.review, null);
  assert.deepEqual(
    continued.spans.filter((s) => s.region.page === 1),
    human.spans.filter((s) => s.region.page === 1),
  );
  const bad = structuredClone(continued);
  bad.spans.find((s) => s.id === 'a')!.text = 'Silently changed';
  assert.throws(() => publish(f, bad, continued.id), code('SOURCE_TEXT_REVIEW_CONFLICT'));
  const followup = structuredClone(continued);
  followup.spans.find((s) => s.id === 'c')!.text += ' More.';
  assert.ok(publish(f, followup, continued.id));
});

test('confirming an unreadable page retains the located exception and clarification history', (t) => {
  const f = fixture(t),
    initial = publish(f),
    unreadable = review(f, initial, { action: 'unreadable', reason: 'Ink lost in original' });
  const clarification = review(f, unreadable, {
    action: 'clarification',
    clarification: 'From memory: fictional date 2020.',
  });
  const confirmed = review(f, clarification);
  assert.equal(confirmed.pages[0].disposition, 'unreadable');
  assert.ok(confirmed.issues.some((i) => i.status === 'unreadable'));
  const passage = getIntakeSourceTextPassage(f.db, f.root, profileId, intakeId);
  assert.ok(
    passage.reviewHistory.some(
      (e) => e.event?.clarification === 'From memory: fictional date 2020.',
    ),
  );
  assert.ok(!passage.spans.some((s) => s.text.includes('From memory')));
  const first = getIntakeSourceTextReviewHistory(f.db, f.root, profileId, intakeId, { limit: 1 });
  assert.equal(first.entries.length, 1);
  assert.equal(first.nextRevisionId, clarification.id);
});

test('relations outside inspected scope cannot be removed by replacement and evidence retrieval bounds diagnostics', (t) => {
  const f = fixture(t),
    ev = evidence();
  ev.spans.push({
    id: 'd',
    text: 'Additional routing.',
    region: { page: 2, box: [0.1, 0.5, 0.5, 0.1] },
    provenance: 'native',
  });
  ev.relations.push({ id: 'outside', kind: 'precedes', from: 'c', to: 'd', provenance: 'adapter' });
  ev.issues = Array.from({ length: 205 }, (_, i) => ({
    id: `issue-${i}`,
    region: { page: 1 },
    kind: 'coverage' as const,
    detail: 'Independent fictional cue',
    status: 'open' as const,
  }));
  const initial = publish(f, ev);
  assert.throws(
    () =>
      review(f, initial, {
        action: 'correct',
        spans: initial.spans.filter((s) => s.region.page === 1),
        relations: initial.relations.filter((r) => r.id !== 'outside'),
      }),
    code('SOURCE_TEXT_INVALID'),
  );
  const passage = getIntakeSourceTextPassage(f.db, f.root, profileId, intakeId);
  assert.equal(passage.issues.length, 200);
  assert.equal(passage.issuesTruncated, true);
  assert.ok(passage.relations.some((r) => r.id === 'outside'));
});

test('serialized passages remain bounded and every long literal, alternative and clarification is retrievable', (t) => {
  const f = fixture(t),
    ev = evidence();
  const long = 'Fictional🙂\u0001'.repeat(5000),
    alternative = 'Alternative龍'.repeat(10000),
    detail = 'Issue detail龍'.repeat(5000),
    clarification = 'External memory龍'.repeat(4000);
  ev.spans[0].text = long;
  ev.spans[0].alternatives = [{ text: alternative, adapter: 'fictional-rereader' }];
  ev.issues[0].detail = detail;
  const initial = publish(f, ev),
    current = review(f, initial, { action: 'clarification', clarification });
  let offset = 0,
    character = 0,
    joined = '',
    loops = 0;
  while (true) {
    const p = getIntakeSourceTextPassage(f.db, f.root, profileId, intakeId, {
      revisionId: current.id,
      page: 1,
      offset,
      character,
      limit: 1,
      maxCharacters: 64000,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 60000);
    if (p.spans[0]?.id !== 'a') break;
    joined += p.spans[0].text;
    assert.equal(p.spans[0].alternatives, undefined);
    assert.equal(p.alternativeCounts.a, 1);
    assert.ok(p.issues[0].detailTruncated);
    assert.ok(p.reviewHistory[0].truncatedFields?.includes('clarification'));
    if (p.nextOffset === null) break;
    offset = p.nextOffset;
    character = p.nextCharacter;
    assert.ok(++loops < 30);
  }
  assert.equal(joined, long);
  for (const annotation of [
    { kind: 'alternative' as const, id: 'a', index: 0, text: alternative },
    { kind: 'issue' as const, id: 'coverage', text: detail },
    {
      kind: 'review' as const,
      id: current.id,
      field: 'clarification' as const,
      text: clarification,
    },
  ]) {
    let cursor = 0,
      result = '';
    do {
      const p = getIntakeSourceTextAnnotation(f.db, f.root, profileId, intakeId, {
        revisionId: current.id,
        ...annotation,
        offset: cursor,
        maxCharacters: 12000,
      });
      assert.ok(Buffer.byteLength(JSON.stringify(p)) < 24000);
      result += p.text;
      if (p.nextOffset === null) break;
      assert.ok(p.nextOffset > cursor);
      cursor = p.nextOffset;
    } while (true);
    assert.equal(result, annotation.text);
  }
});

test('member correction atomically invalidates ancestor proposals without impersonating ancestor text', (t) => {
  const f = fixture(t),
    parent = 'fictional-parent';
  const bytes = Buffer.from('Fictional retained parent dependency');
  const parentPath = `data/profiles/${profileId}/sources/parent.fixture`;
  writeFileSync(resolve(f.root, parentPath), bytes);
  transaction(f.db, () => {
    f.db
      .prepare(
        'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
      )
      .run(
        parent,
        parentPath,
        digest(bytes),
        bytes.length,
        'intake_original',
        JSON.stringify({ intake: { version: 1, proposals: [] } }),
      );
    f.db
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run(
        JSON.stringify({ intake: { version: 1, proposals: [], parentSourceFileId: parent } }),
        intakeId,
      );
  });
  const initial = publish(f);
  const metadata = (db = f.db) =>
    JSON.parse(
      db.prepare('SELECT details_json FROM source_files WHERE id=?').get(parent)!
        .details_json as string,
    ).intake;
  const before = metadata();
  assert.equal(before.sourceTextRevisionId, undefined);
  assert.equal(before.version, 2);
  assert.ok(before.sourceTextDependencyToken);
  transaction(f.db, () => {
    const saved = metadata();
    saved.proposals = [
      {
        id: 'parent-proposal',
        sourceTextRevisionId: null,
        sourceTextDependencyToken: saved.sourceTextDependencyToken,
      },
    ];
    f.db
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run(JSON.stringify({ intake: saved }), parent);
  });
  assert.doesNotThrow(() => assertCurrentProposalSourceText(metadata(), 'parent-proposal'));
  const changed = review(f, initial, {
    action: 'correct',
    spans: [
      { id: 'new', text: 'Fictional child correction', region: { page: 1 }, provenance: 'human' },
    ],
  });
  const after = metadata();
  assert.notEqual(after.sourceTextDependencyToken, before.sourceTextDependencyToken);
  assert.equal(after.sourceTextRevisionId, undefined);
  assert.equal(after.sourceTextRequiresInterpretation, true);
  assert.throws(
    () => assertCurrentProposalSourceText(after, 'parent-proposal'),
    code('SOURCE_TEXT_CHANGED'),
  );
  const restored = f.rebuild();
  assert.deepEqual(metadata(restored), after);
  assert.equal(getIntakeSourceText(restored, f.root, profileId, intakeId).revision?.id, changed.id);
});

test('saving one correction leaves unrelated uncertainty and unreadability open until explicit inspection', (t) => {
  const f = fixture(t),
    ev = evidence();
  ev.pages[0].disposition = 'partial';
  ev.issues.push(
    {
      id: 'p1-pending',
      region: { page: 1 },
      kind: 'coverage',
      detail: 'Extraction pending',
      status: 'open',
    },
    {
      id: 'unreadable-region',
      region: { page: 1, box: [0.1, 0.8, 0.5, 0.1] },
      kind: 'unreadable',
      detail: 'Illegible source region',
      status: 'unreadable',
    },
    {
      id: 'other-warning',
      region: { page: 1, box: [0.1, 0.6, 0.5, 0.1] },
      kind: 'disagreement',
      detail: 'Readers disagree',
      status: 'open',
    },
  );
  const initial = publish(f, { ...ev, issues: ev.issues.map((i) => ({ ...i, status: 'open' })) });
  const corrected = review(f, initial, {
    action: 'correct',
    spans: initial.spans
      .filter((s) => s.region.page === 1)
      .map((s) => ({ ...s, text: s.id === 'b' ? 'Wrong human transcription' : s.text })),
  });
  assert.equal(corrected.pages[0].inspected, false);
  assert.equal(corrected.issues.find((i) => i.id === 'other-warning')?.status, 'open');
  assert.equal(corrected.issues.find((i) => i.id === 'unreadable-region')?.status, 'open');
  assert.equal(
    corrected.issues.find((i) => i.id === 'p1-pending')?.status,
    'corrected',
    'manual replacement releases machine pending bookkeeping, not review',
  );
  assert.ok(corrected.issues.some((i) => i.id === 'human-inspection-p1' && i.status === 'open'));
  const confirmed = review(f, corrected);
  assert.equal(confirmed.pages[0].inspected, true);
  assert.equal(confirmed.issues.find((i) => i.id === 'other-warning')?.status, 'confirmed');
  assert.equal(
    confirmed.issues.find((i) => i.id === 'unreadable-region')?.status,
    'open',
    'confirm cannot silently erase genuine unreadability',
  );
});

test('explicit issue confirmation resolves transcribed unreadability without bypassing unsupported limits', (t) => {
  const f = fixture(t),
    ev = evidence();
  ev.issues.push({
    id: 'unsupported-page',
    region: { page: 2 },
    kind: 'unsupported',
    detail: 'Unsupported retained format',
    status: 'open',
  });
  const initial = publish(f, ev);
  const unreadable = review(f, initial, {
    action: 'unreadable',
    reason: 'Illegible label',
    scope: { page: 1, box: [0.1, 0.7, 0.7, 0.1] },
  });
  const issue = unreadable.issues.find((i) => i.kind === 'unreadable')!;
  assert.throws(
    () => review(f, unreadable, { resolveIssueIds: [issue.id] }),
    code('SOURCE_TEXT_INVALID'),
  );
  const corrected = review(f, unreadable, {
    action: 'correct',
    spans: [
      ...unreadable.spans.filter((s) => s.region.page === 1),
      {
        id: 'transcribed',
        text: 'Fictional now-readable label.',
        region: { page: 1, box: [0.1, 0.7, 0.7, 0.1] },
        provenance: 'human',
      },
    ],
  });
  const generic = review(f, corrected);
  assert.equal(generic.issues.find((i) => i.id === issue.id)?.status, 'unreadable');
  const explicit = review(f, generic, { resolveIssueIds: [issue.id] });
  assert.equal(explicit.issues.find((i) => i.id === issue.id)?.status, 'confirmed');
  assert.deepEqual(explicit.review?.resolvedIssueIds, [issue.id]);
  assert.throws(
    () => review(f, explicit, { resolveIssueIds: ['missing'] }),
    code('SOURCE_TEXT_INVALID'),
  );
  assert.throws(
    () => review(f, explicit, { action: 'later', reason: 'Later', resolveIssueIds: [issue.id] }),
    code('SOURCE_TEXT_INVALID'),
  );
  assert.throws(
    () => review(f, explicit, { scope: { page: 2 }, resolveIssueIds: ['unsupported-page'] }),
    code('SOURCE_TEXT_INVALID'),
  );
});

test('large source issue list is paginated, revision pinned and durable without page text', (t) => {
  const f = fixture(t);
  const pages = Array.from({ length: 800 }, (_, i) => ({
    page: i + 1,
    disposition: 'partial' as const,
    inspected: false,
  }));
  const value: SourceTextEvidence = {
    adapter: { name: 'fictional-reader', version: '1' },
    pages,
    spans: pages.map((p) => ({
      id: `s${p.page}`,
      text: 'Fictional retained wording '.repeat(100),
      region: { page: p.page },
      provenance: 'native',
    })),
    relations: [],
    issues: pages.map((p) => ({
      id: `i${p.page}`,
      region: { page: p.page },
      kind: 'coverage',
      status: 'open',
      detail: 'Not independently inspected.',
    })),
  };
  value.issues.push({
    id: 'detected',
    region: { page: 800, box: [0.1, 0.1, 0.2, 0.2] },
    kind: 'confidence',
    status: 'open',
    detail: 'Fictional uncertain word. '.repeat(100),
  });
  value.issues.push({
    id: 'failed',
    region: { page: 799 },
    kind: 'unreadable',
    status: 'open',
    detail: 'Local reader failed.',
  });
  const saved = publishIntakeSourceText(f.db, f.root, profileId, intakeId, {
    operationId: randomUUID(),
    expectedRevisionId: null,
    sourceHash: f.sourceHash,
    evidence: value,
  });
  const first = getIntakeSourceIssues(f.db, f.root, profileId, intakeId, { limit: 2 });
  assert.deepEqual(first.summary, {
    pages: 800,
    inspectedPages: 0,
    totalIssues: 802,
    coverageIssues: 800,
    specificIssues: 2,
    exceptions: 1,
  });
  assert.deepEqual(
    first.issues.map((i) => i.id),
    ['failed', 'detected'],
  );
  assert.equal(first.issues[1].precision, 'region');
  assert.equal(first.issues[1].detail.length, 1200);
  assert.equal(first.issues[1].detailTruncated, true);
  assert.equal(first.nextOffset, 2);
  assert.equal(JSON.stringify(first).includes('Fictional retained wording'), false);
  assert.throws(() => getIntakeSourceIssues(f.db, f.root, profileId, intakeId, { offset: 2 }), {
    code: 'SOURCE_TEXT_CHANGED',
  });
  assert.throws(() => getIntakeSourceIssues(f.db, f.root, profileId, intakeId, { limit: 51 }), {
    code: 'SOURCE_TEXT_INVALID',
  });
  const next = getIntakeSourceIssues(f.db, f.root, profileId, intakeId, {
    offset: 2,
    limit: 50,
    revisionId: first.revisionId!,
  });
  assert.equal(next.issues.length, 50);
  assert.equal(next.issues[0].category, 'not-inspected');
  assert.deepEqual(
    getIntakeSourceIssues(f.rebuild(), f.root, profileId, intakeId, { limit: 2 }),
    first,
  );
  reviewIntakeSourceText(
    f.db,
    f.root,
    profileId,
    intakeId,
    {
      operationId: randomUUID(),
      expectedRevisionId: saved.revision!.id,
      sourceHash: f.sourceHash,
      action: 'confirm',
      scope: { page: 1 },
    },
    'fictional-owner',
  );
  assert.throws(
    () =>
      getIntakeSourceIssues(f.db, f.root, profileId, intakeId, {
        offset: 2,
        revisionId: first.revisionId!,
      }),
    { code: 'SOURCE_TEXT_CHANGED' },
  );
  assert.equal(
    getIntakeSourceIssues(f.db, f.root, profileId, intakeId).summary!.coverageIssues,
    799,
  );
});

test('pre-index revisions expose bounded issue pages without rewriting retained evidence on GET', (t) => {
  const f = fixture(t);
  const saved = publishIntakeSourceText(f.db, f.root, profileId, intakeId, {
    operationId: randomUUID(),
    expectedRevisionId: null,
    sourceHash: f.sourceHash,
    evidence: evidence(),
  });
  const revisionKey = `intake_source_text:v1:${intakeId}:revision:${saved.revision!.id}`;
  const envelope = JSON.parse(
    String(f.db.prepare('SELECT value FROM app_meta WHERE key=?').get(revisionKey)!.value),
  );
  // Recreate the former persisted format exactly: page blobs and relations, no issue index.
  delete envelope.value.issueIndex;
  envelope.sha256 = digest(Buffer.from(JSON.stringify(envelope.value)));
  f.db
    .prepare('UPDATE app_meta SET value=? WHERE key=?')
    .run(JSON.stringify(envelope), revisionKey);
  const before = f.db.prepare('SELECT key,value FROM app_meta ORDER BY key').all();
  const result = getIntakeSourceIssues(f.db, f.root, profileId, intakeId, { limit: 1 });
  assert.equal(result.summary!.pages, 2);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].category, 'not-inspected');
  assert.equal(JSON.stringify(result).includes('Decimal 1.00'), false);
  assert.deepEqual(f.db.prepare('SELECT key,value FROM app_meta ORDER BY key').all(), before);
});

test('unchanged text approval preserves clinical pins and receipts through rebuild; correction still invalidates', async (t) => {
  const f = fixture(t),
    initial = publish(f);
  const metadata = () =>
    JSON.parse(
      String(
        f.db.prepare('SELECT details_json FROM source_files WHERE id=?').get(intakeId)!
          .details_json,
      ),
    ).intake;
  const before = metadata();
  const proposal = {
    id: 'existing-proposal',
    sourceTextRevisionId: before.sourceTextRevisionId,
    sourceTextDependencyToken: before.sourceTextDependencyToken,
  };
  const confirmed = review(f, initial);
  assert.notEqual(confirmed.id, initial.id);
  assert.deepEqual(
    metadata(),
    before,
    'confirmation must not increment intake version or replace dependency pins',
  );
  assert.doesNotThrow(() =>
    assertCurrentProposalSourceText({ ...metadata(), proposals: [proposal] }, proposal.id),
  );
  const { intakeSourceTextInterpretationRevisionId } = await import('../intake-source-text.ts');
  assert.equal(intakeSourceTextInterpretationRevisionId(f.db, profileId, intakeId), initial.id);
  const restored = f.rebuild();
  assert.equal(
    getIntakeSourceText(restored, f.root, profileId, intakeId).revision!.id,
    confirmed.id,
  );
  assert.equal(intakeSourceTextInterpretationRevisionId(restored, profileId, intakeId), initial.id);
  const corrected = review(f, confirmed, {
    action: 'correct',
    spans: [
      {
        id: 'cookie-fixed',
        text: 'Cookie Doe amended text',
        region: { page: 1 },
        provenance: 'human',
      },
    ],
  });
  assert.equal(intakeSourceTextInterpretationRevisionId(f.db, profileId, intakeId), corrected.id);
  assert.throws(
    () => assertCurrentProposalSourceText({ ...metadata(), proposals: [proposal] }, proposal.id),
    code('SOURCE_TEXT_CHANGED'),
  );
});

test('attention queue counts sections rather than flags and removes completed originals', async (t) => {
  const f = fixture(t);
  const { listSourceAttention } = await import('../intake-source-text.ts');
  assert.equal(listSourceAttention(f.db, profileId).sections, 0);
  const ev = evidence();
  ev.issues = [
    {
      id: 'cookie-a',
      region: { page: 1 },
      kind: 'confidence',
      detail: 'Fictional flag one',
      status: 'open',
    },
    {
      id: 'cookie-b',
      region: { page: 1 },
      kind: 'confidence',
      detail: 'Fictional flag two',
      status: 'open',
    },
    {
      id: 'cookie-c',
      region: { page: 2 },
      kind: 'coverage',
      detail: 'Fictional page check',
      status: 'open',
    },
  ];
  const initial = publish(f, ev);
  assert.deepEqual(listSourceAttention(f.db, profileId), {
    sections: 2,
    total: 1,
    items: [{ intakeId, sections: 2 }],
    offset: 0,
    nextOffset: null,
  });
  const one = review(f, initial);
  assert.equal(listSourceAttention(f.db, profileId).sections, 1);
  review(f, one, { scope: { page: 2 } });
  assert.deepEqual(listSourceAttention(f.db, profileId).items, []);
  assert.equal(listSourceAttention(f.rebuild(), profileId).sections, 0);
  assert.throws(() => listSourceAttention(f.db, 'another-profile'), code('PROFILE_SCOPE'));
});

test('attention totals include later files while pages omit completed files', (t) => {
  const f = fixture(t);
  const ev = evidence();
  ev.issues = [
    {
      id: 'cookie-check',
      region: { page: 1 },
      kind: 'confidence',
      detail: 'Fictional OCR check',
      status: 'open',
    },
  ];
  publish(f, ev);
  for (let i = 0; i < 30; i++) {
    const id = 'cookie-extra-' + i;
    writeFileSync(
      resolve(ensureProfileDirectories(f.root, profileId).sources, id + '.txt'),
      readFileSync(f.path),
    );
    transaction(f.db, () =>
      f.db
        .prepare(
          "INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) SELECT ?,replace(path,'fictional.txt',?),sha256,bytes,kind,? FROM source_files WHERE id=?",
        )
        .run(id, id + '.txt', JSON.stringify({ intake: { version: 1, proposals: [] } }), intakeId),
    );
    publishIntakeSourceText(f.db, f.root, profileId, id, {
      operationId: randomUUID(),
      sourceHash: f.sourceHash,
      expectedRevisionId: null,
      evidence: ev,
    });
  }
  const first = listSourceAttention(f.db, profileId);
  assert.equal(first.sections, 31);
  assert.equal(first.total, 31);
  assert.equal(first.items.length, 30);
  assert.equal(first.nextOffset, 30);
  const last = listSourceAttention(f.db, profileId, 30);
  assert.equal(last.sections, 31);
  assert.equal(last.items.length, 1);
  assert.equal(last.nextOffset, null);
});
