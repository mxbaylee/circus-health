import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reportQueueGuardHeader,
  reportQueueGuardLocation,
} from '../report-queue-guard-diagnostic.ts';

test('report queue guard diagnostic exposes only allowlisted module labels and lines', () => {
  const error = new Error('private patient text');
  error.stack = [
    'Error: private patient text',
    '    at changed (file:///private/private-patient/src/server/intake-report-group-collection.ts:140:18)',
    '    at read (file:///private/private-patient/src/server/intake-queue-page-collection.ts:2418:5)',
    '    at ignored (file:///private/private-patient/src/server/private-record.ts:92:1)',
    '    at current (file:///private/private-patient/src/server/intake-queue-native.ts:187:4)',
  ].join('\n');
  const location = reportQueueGuardLocation(error);
  assert.equal(location, 'group:140>page:2418>native:187');
  assert.equal(reportQueueGuardHeader(location!), location);
  assert.equal(location?.includes('private'), false);
  assert.equal(location?.includes('patient'), false);
});

test('report queue guard diagnostic refuses malformed or private header values', () => {
  for (const value of [
    '/private/path/group:140',
    'group:140\npatient text',
    'group:0',
    'group:123456',
    'group:140>secret:1',
    'group:140>page:2>queue:3>native:4',
  ])
    assert.equal(reportQueueGuardHeader(value), undefined);
  assert.equal(reportQueueGuardHeader(null), undefined);
  const error = new Error('private');
  error.stack = 'Error: private\n at private (/private/path/src/server/private-record.ts:42:1)';
  assert.equal(reportQueueGuardLocation(error), undefined);
  assert.equal(reportQueueGuardLocation({ stack: error.stack }), undefined);
  const throwing = new Error('private');
  Object.defineProperty(throwing, 'stack', {
    get() {
      throw Error('private stack formatter');
    },
  });
  assert.equal(reportQueueGuardLocation(throwing), undefined);
  const oversized = new Error('private');
  oversized.stack = 'Error: private\n' + 'private'.repeat(2000) + '\n' + error.stack;
  assert.equal(reportQueueGuardLocation(oversized), undefined);
});
