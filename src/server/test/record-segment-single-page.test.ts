import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  iterateRecordCommitSegments,
  type RecordCommitV2,
  type RecordObjectReference,
  type RecordStorage,
} from '../record-versions.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';

function fixture() {
  const objects = new Map<string, Buffer>(),
    reads: string[] = [],
    operationId = randomUUID(),
    profileId = 'fictional-segment-order';
  const storage: RecordStorage = {
    read(name) {
      reads.push(name);
      const bytes = objects.get(name);
      return bytes ? Buffer.from(bytes) : null;
    },
    writeImmutable() {
      throw Error('Segment ordering must not write recovery evidence');
    },
    publishHead() {
      throw Error('Segment ordering must not publish recovery evidence');
    },
  };
  const store = (value: unknown): RecordObjectReference => {
    const bytes = Buffer.from(JSON.stringify(value) + '\n'),
      name = 'objects/' + randomUUID();
    objects.set(name, bytes);
    return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const references = (count: number) =>
    Array.from({ length: count }, (_, ordinal) => store({ fictionalSegment: ordinal }));
  const page = (
    segments: RecordObjectReference[],
    firstSegment = 0,
    previous: RecordObjectReference | null = null,
  ) => ({
    format: 'health-record-segment-page-v1',
    profileId,
    schemaVersion: 1,
    sequence: 7,
    operationId,
    previous,
    firstSegment,
    segments,
  });
  const commit = (head: RecordObjectReference, count: number): RecordCommitV2 => ({
    format: 'health-record-versions-v2',
    profileId,
    schemaVersion: 1,
    sequence: 7,
    revision: 7,
    previous: null,
    operationId,
    fingerprint: null,
    result: null,
    recordedAt: '2026-01-01T00:00:00Z',
    records: count,
    segments: { format: 'health-record-segment-index-v1', head, count },
  });
  return { storage, reads, store, references, page, commit };
}

test('complete single manifest pages preserve authenticated order and avoid ordering scratch', () => {
  for (const count of [1, 2, 64]) {
    const f = fixture(),
      refs = f.references(count),
      head = f.store(f.page(refs)),
      work = createRecordVersionWorkCounters();
    const actual = withRecordVersionWork(work, () => [
      ...iterateRecordCommitSegments(f.storage, f.commit(head, count)),
    ]);
    assert.deepEqual(actual, refs);
    assert.deepEqual(f.reads, [head.name]);
    assert.equal(work.operation.segmentOrderingScratchOpened, 0);
    assert.equal(work.operation.segmentIndexPagesRead, 1);
    assert.equal(work.operation.segmentReferencesSpooled, count);
    assert.equal(work.operation.segmentReferencesReplayed, count);
    assert.equal(work.operation.maxSegmentReferencesBuffered, count);
    assert.equal(work.operation.objectReadCalls, 1);
    assert.equal(work.operation.objectReadBytes, head.bytes);
    assert.equal(work.operation.hashCalls, 1);
    assert.equal(work.operation.hashedBytes, head.bytes);
  }
});

test('multi-page manifests retain disk ordering and exact complete forward membership', () => {
  const f = fixture(),
    refs = f.references(65),
    first = f.store(f.page(refs.slice(0, 64))),
    head = f.store(f.page(refs.slice(64), 64, first)),
    work = createRecordVersionWorkCounters();
  const actual = withRecordVersionWork(work, () => [
    ...iterateRecordCommitSegments(f.storage, f.commit(head, refs.length)),
  ]);
  assert.deepEqual(actual, refs);
  assert.deepEqual(f.reads, [head.name, first.name]);
  assert.equal(work.operation.segmentOrderingScratchOpened, 1);
  assert.equal(work.operation.segmentIndexPagesRead, 2);
  assert.equal(work.operation.segmentReferencesSpooled, 65);
  assert.equal(work.operation.segmentReferencesReplayed, 65);
  assert.equal(work.operation.maxSegmentReferencesBuffered, 64);
  assert.equal(work.operation.objectReadCalls, 2);
  assert.equal(work.operation.hashedBytes, head.bytes + first.bytes);
});

test('single-page binding and late-reference failures refuse before the first yield', () => {
  const changes: Array<(page: ReturnType<ReturnType<typeof fixture>['page']>) => void> = [
    (page) => {
      page.format = 'unsupported-segment-page';
    },
    (page) => {
      page.profileId = 'another-fictional-profile';
    },
    (page) => {
      page.schemaVersion++;
    },
    (page) => {
      page.sequence++;
    },
    (page) => {
      page.operationId = randomUUID();
    },
    (page) => {
      page.firstSegment = 1;
    },
    (page) => {
      page.previous = page.segments[0]!;
    },
    (page) => {
      page.segments.pop();
    },
    (page) => {
      page.segments.push(page.segments[0]!);
    },
    (page) => {
      page.segments[63]!.sha256 = 'not-a-digest';
    },
    (page) => {
      page.segments[63]!.bytes = 0;
    },
    (page) => {
      page.segments[63]!.name = 'outside-objects';
    },
    (page) => {
      Object.assign(page, { unexpected: 'fictional' });
    },
  ];
  for (const change of changes) {
    const f = fixture(),
      page = f.page(f.references(64));
    change(page);
    const head = f.store(page),
      work = createRecordVersionWorkCounters();
    withRecordVersionWork(work, () => {
      const iterator = iterateRecordCommitSegments(f.storage, f.commit(head, 64));
      try {
        assert.throws(() => iterator.next(), /segment page|segment reference/);
      } finally {
        iterator.return(undefined);
      }
    });
    assert.equal(work.operation.segmentReferencesReplayed, 0);
    assert.equal(work.operation.segmentOrderingScratchOpened, 0);
  }
});

test('multi-page late invalid membership refuses before any forward reference escapes', () => {
  const f = fixture(),
    refs = f.references(65);
  refs[63]!.sha256 = 'not-a-digest';
  const first = f.store(f.page(refs.slice(0, 64))),
    head = f.store(f.page(refs.slice(64), 64, first)),
    work = createRecordVersionWorkCounters();
  withRecordVersionWork(work, () => {
    const iterator = iterateRecordCommitSegments(f.storage, f.commit(head, refs.length));
    try {
      assert.throws(() => iterator.next(), /segment reference/);
    } finally {
      iterator.return(undefined);
    }
  });
  assert.equal(work.operation.segmentOrderingScratchOpened, 1);
  assert.equal(work.operation.segmentReferencesReplayed, 0);
});

test('oversized page claims refuse before reading bytes and object hashes remain mandatory', () => {
  const f = fixture(),
    head = f.store(f.page(f.references(1)));
  assert.throws(
    () => [...iterateRecordCommitSegments(f.storage, f.commit({ ...head, bytes: 32769 }, 1))],
    /segment page reference/,
  );
  assert.deepEqual(f.reads, []);
  assert.throws(
    () => [
      ...iterateRecordCommitSegments(f.storage, f.commit({ ...head, sha256: '0'.repeat(64) }, 1)),
    ],
    /corrupt committed object/,
  );
});
