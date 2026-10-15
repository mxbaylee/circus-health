import { describe, expect, it } from 'vitest';
import { ApiError } from '../../app/data/api';
import { readReportDetailAfterQueueCursor } from '../../app/features/import/collection-display-model';

const cursor = () => new ApiError('Refresh this report queue', 'REPORT_QUEUE_CURSOR', 409);

describe('report header queue cursor recovery', () => {
  it('opens one fresh GET after an exact queue cursor refusal', async () => {
    const controller = new AbortController();
    let calls = 0;
    const value = await readReportDetailAfterQueueCursor(async () => {
      if (++calls === 1) throw cursor();
      return { intakeId: 'fictional-intake', groupId: 'fictional-group' };
    }, controller.signal);
    expect(value).toEqual({ intakeId: 'fictional-intake', groupId: 'fictional-group' });
    expect(calls).toBe(2);
  });

  it('surfaces a persistent cursor refusal after one new GET', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      readReportDetailAfterQueueCursor(async () => {
        calls++;
        throw cursor();
      }, controller.signal),
    ).rejects.toMatchObject({ status: 409, code: 'REPORT_QUEUE_CURSOR' });
    expect(calls).toBe(2);
  });

  it('never retries unrelated refusals or other 409 codes', async () => {
    const controller = new AbortController();
    for (const error of [
      new ApiError('Wrong source', 'PROFILE_MISMATCH', 409),
      new ApiError('Locked', 'PROFILE_LOCKED', 423),
      new Error('Transport failed'),
    ]) {
      let calls = 0;
      await expect(
        readReportDetailAfterQueueCursor(async () => {
          calls++;
          throw error;
        }, controller.signal),
      ).rejects.toBe(error);
      expect(calls).toBe(1);
    }
  });

  it('cannot start or publish an aborted or stale retry result', async () => {
    const before = new AbortController();
    before.abort(new Error('fictional navigation ended'));
    let calls = 0;
    await expect(
      readReportDetailAfterQueueCursor(async () => {
        calls++;
        return 'stale';
      }, before.signal),
    ).rejects.toThrow('fictional navigation ended');
    expect(calls).toBe(0);

    const during = new AbortController();
    await expect(
      readReportDetailAfterQueueCursor(async () => {
        calls++;
        during.abort(new Error('fictional profile changed'));
        throw cursor();
      }, during.signal),
    ).rejects.toThrow('fictional profile changed');
    expect(calls).toBe(1);

    const after = new AbortController();
    await expect(
      readReportDetailAfterQueueCursor(async () => {
        calls++;
        if (calls === 2) throw cursor();
        after.abort(new Error('fictional selection changed'));
        return 'stale';
      }, after.signal),
    ).rejects.toThrow('fictional selection changed');
    expect(calls).toBe(3);
  });
});
