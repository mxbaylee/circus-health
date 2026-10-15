import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOLDOUT_TRACE_LIMIT,
  holdoutPeopleGate,
  holdoutTrace,
  type HoldoutPeopleGate,
  type HoldoutStage,
} from './holdout-trace.ts';

test('fictional holdout stages require the fixture gate, stay bounded and reject private text', () => {
  const host = globalThis as typeof globalThis & {
    __CRS_HOLDOUT_TRACE__?: { enabled: boolean; stages: string[] };
  };
  const previous = host.__CRS_HOLDOUT_TRACE__;
  try {
    delete host.__CRS_HOLDOUT_TRACE__;
    holdoutTrace('people.read.headers');
    host.__CRS_HOLDOUT_TRACE__ = { enabled: false, stages: [] };
    holdoutTrace('people.read.headers');
    assert.deepEqual(host.__CRS_HOLDOUT_TRACE__.stages, []);

    host.__CRS_HOLDOUT_TRACE__.enabled = true;
    for (let index = 0; index < HOLDOUT_TRACE_LIMIT + 20; index++)
      holdoutTrace(index % 2 ? 'people.read.headers' : 'people.read.body');
    holdoutTrace('fictional private name' as HoldoutStage);
    assert.equal(host.__CRS_HOLDOUT_TRACE__.stages.length, HOLDOUT_TRACE_LIMIT);
    assert.ok(
      host.__CRS_HOLDOUT_TRACE__.stages.every(
        (stage) => stage === 'people.read.headers' || stage === 'people.read.body',
      ),
    );
  } finally {
    if (previous) host.__CRS_HOLDOUT_TRACE__ = previous;
    else delete host.__CRS_HOLDOUT_TRACE__;
  }
});

test('fictional People gate is default-off and retains only latest fixed booleans', () => {
  const host = globalThis as typeof globalThis & {
    __CRS_HOLDOUT_TRACE__?: {
      enabled: boolean;
      stages: string[];
      peopleGate?: HoldoutPeopleGate;
    };
  };
  const previous = host.__CRS_HOLDOUT_TRACE__;
  const gate: HoldoutPeopleGate = {
    busy: false,
    saving: false,
    acceptanceBusy: false,
    acceptanceRecovering: false,
    acceptanceReceiptPending: false,
    bulkBusy: false,
    bulkPending: false,
    repairPending: false,
    sourcePending: false,
    pendingSources: true,
    lastBeforeCloseAllowed: null,
    pageLoading: false,
    pageRefreshing: false,
    pageError: false,
    firstPageRefreshing: false,
    firstPageError: false,
    initialPageChanged: false,
    peopleLoading: false,
    peopleRefreshing: false,
    peopleError: false,
  };
  try {
    delete host.__CRS_HOLDOUT_TRACE__;
    holdoutPeopleGate(gate);
    host.__CRS_HOLDOUT_TRACE__ = { enabled: false, stages: [] };
    holdoutPeopleGate(gate);
    assert.equal(host.__CRS_HOLDOUT_TRACE__.peopleGate, undefined);

    host.__CRS_HOLDOUT_TRACE__.enabled = true;
    holdoutPeopleGate({ ...gate, privateText: 'fictional name' } as HoldoutPeopleGate);
    assert.deepEqual(host.__CRS_HOLDOUT_TRACE__.peopleGate, gate);
    assert.equal(
      Object.keys(host.__CRS_HOLDOUT_TRACE__.peopleGate!).length,
      Object.keys(gate).length,
    );

    const next = { ...gate, pendingSources: false, lastBeforeCloseAllowed: false };
    holdoutPeopleGate(next);
    assert.deepEqual(host.__CRS_HOLDOUT_TRACE__.peopleGate, next);
  } finally {
    if (previous) host.__CRS_HOLDOUT_TRACE__ = previous;
    else delete host.__CRS_HOLDOUT_TRACE__;
  }
});
