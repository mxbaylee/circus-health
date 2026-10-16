import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortableOriginalInventory } from '../portable-original-inventory.ts';
import type { PortableProjectionCell } from '../portable-projection-row.ts';

const source = (path: string, sha256: string, bytes: number): PortableProjectionCell[] => [
  { name: 'id', kind: 'text', pieces: () => ['fictional-source'] },
  { name: 'path', kind: 'text', pieces: () => [path] },
  { name: 'sha256', kind: 'text', pieces: () => [sha256] },
  { name: 'bytes', kind: 'number', value: bytes },
];
const asset = (path: string, sha256: string, bytes: number): PortableProjectionCell[] => [
  { name: 'stored_path', kind: 'text', pieces: () => [path] },
  { name: 'sha256', kind: 'text', pieces: () => [sha256] },
  { name: 'bytes', kind: 'number', value: bytes },
];

test('selected original inventory deduplicates only exact path metadata', () => {
  const inventory = createPortableOriginalInventory(() => {});
  const sha256 = 'a'.repeat(64);
  try {
    inventory.add('source_files', source('profiles/fictional/sources/a.pdf', sha256, 17));
    inventory.add('assets', asset('profiles/fictional/sources/a.pdf', sha256, 17));
    inventory.add('assets', asset('profiles/fictional/attachments/b.png', 'b'.repeat(64), 29));
    assert.equal(inventory.count(), 2);
    assert.deepEqual(
      [...inventory.originals()],
      [
        { path: 'profiles/fictional/attachments/b.png', sha256: 'b'.repeat(64), bytes: 29 },
        { path: 'profiles/fictional/sources/a.pdf', sha256, bytes: 17 },
      ],
    );
  } finally {
    inventory.close();
  }
});

test('conflicting selected path and early-abandoned traversal refuse reuse', () => {
  const conflict = createPortableOriginalInventory(() => {});
  try {
    conflict.add('source_files', source('fictional/a', 'a'.repeat(64), 17));
    assert.throws(
      () => conflict.add('assets', asset('fictional/a', 'b'.repeat(64), 17)),
      /Conflicting original metadata/,
    );
    assert.throws(() => conflict.count(), /unavailable/);
  } finally {
    conflict.close();
  }

  const abandoned = createPortableOriginalInventory(() => {});
  try {
    abandoned.add('source_files', source('fictional/a', 'a'.repeat(64), 17));
    for (const row of abandoned.originals()) {
      assert.equal(row.path, 'fictional/a');
      break;
    }
    assert.throws(() => abandoned.count(), /unavailable/);
  } finally {
    abandoned.close();
  }
});

test('unaddressable original metadata refuses before building an unbounded scalar', () => {
  const longPath = createPortableOriginalInventory(() => {});
  try {
    assert.throws(
      () =>
        longPath.add(
          'source_files',
          source(`profiles/fictional/sources/${'a'.repeat(4096)}`, 'a'.repeat(64), 17),
        ),
      /Invalid portable original metadata/,
    );
    assert.throws(() => longPath.count(), /unavailable/);
  } finally {
    longPath.close();
  }

  const longSha = createPortableOriginalInventory(() => {});
  try {
    assert.throws(
      () => longSha.add('source_files', source('fictional/a', 'a'.repeat(65), 17)),
      /Invalid portable original metadata/,
    );
    assert.throws(() => longSha.count(), /unavailable/);
  } finally {
    longSha.close();
  }
});
