import test from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { evidenceRelativeFilename } from '../intake-evidence-filename.ts';
import { schemaKey } from '../intake-envelope-schema.ts';

test('streamed evidence paths match POSIX directory and relative normalization', () => {
  const names = [
    '',
    '.',
    '..',
    '/',
    '//',
    'report.html',
    '/report.html',
    'a/report.html',
    'a//report.html',
    'a/./b/../report.html',
    '../a/report.html',
    '../../report.html',
    'a/b/',
    'a/b//',
    '//a//report.html',
    'fictional-\ufeff-🌿/report.html',
    'fictional-\ud800/\udfff/report.html',
  ];
  const paths = [
    '',
    '.',
    '..',
    './',
    '../',
    'notes.txt',
    './notes.txt',
    '../notes.txt',
    '../../notes.txt',
    'a/../../notes.txt',
    'a//b/',
    '🌿/\ufeff.txt',
  ];
  for (const name of names) {
    const exact = evidenceRelativeFilename([JSON.stringify(name)], () => {});
    try {
      for (const path of paths) {
        const expected = posix.normalize(posix.join(posix.dirname(name), path));
        const result = exact.resolve(path);
        assert.equal(result.hash, schemaKey(expected), JSON.stringify({ name, path }));
        assert.equal(
          result.key(['inventory-name-first', 'fictional-index']),
          schemaKey('inventory-name-first', 'fictional-index', expected),
        );
        assert.equal(result.bytes, Buffer.byteLength(expected));
      }
    } finally {
      exact.close();
    }
  }
});

test('giant path segments remain exact without returning a whole name and reject source changes', () => {
  const name = 'fictional-' + 'x'.repeat(17000) + '/report.html';
  let current = true;
  const exact = evidenceRelativeFilename([JSON.stringify(name)], () => {
    if (!current) throw Error('fictional changed source');
  });
  try {
    const result = exact.resolve('notes.txt');
    assert.equal(result.hash, schemaKey(posix.join(posix.dirname(name), 'notes.txt')));
    assert.ok(result.bytes > 16384);
    assert.equal(result.prefix.length, 512);
    assert.equal(result.suffix.length, 512);
    current = false;
    assert.throws(() => exact.resolve('notes.txt'), /changed source/);
  } finally {
    exact.close();
  }
});

test('repeated lone high and low surrogate names retain exact bounded chunks', () => {
  for (const unit of ['\ud800', '\udfff']) {
    const directory = 'fictional-' + unit.repeat(17000),
      name = evidenceRelativeFilename([JSON.stringify(directory + '/report.html')], () => {});
    try {
      const target = name.resolve('notes.txt');
      assert.equal(target.hash, schemaKey(directory + '/notes.txt'));
      assert.notEqual(
        target.hash,
        schemaKey(directory.replace(/[\ud800\udfff]/g, '\ufffd') + '/notes.txt'),
      );
      assert.equal(target.prefix.length, 512);
      assert.equal(target.suffix.length, 512);
    } finally {
      name.close();
    }
  }
});
