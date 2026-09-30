import { describe, expect, it } from 'vitest';
import type { IntakeReportQueueDetail } from '../../shared/intake';
import {
  reportActivityLabel,
  intakeReadingPauseLabel,
  mergeReportDetailPages,
} from '../../app/features/intake/reviewQueue';

describe('active Import reading and detail helpers', () => {
  it('states incomplete source reading honestly', () => {
    expect(
      reportActivityLabel({
        runningFiles: 0,
        pausedFiles: 0,
        queuedFiles: 0,
        filesAwaitingConversion: 0,
        remainingUnits: 0,
        extractionUnknownFiles: 1,
        extractionComplete: false,
        allCurrentReportsReviewed: true,
      }),
    ).toContain('not yet complete');
  });

  it('reports durable source accounting without claiming clinical extraction completeness', () => {
    const label = reportActivityLabel({
      runningFiles: 0,
      pausedFiles: 0,
      queuedFiles: 0,
      filesAwaitingConversion: 0,
      remainingUnits: 0,
      extractionUnknownFiles: 1,
      extractionComplete: false,
      allCurrentReportsReviewed: true,
      readingAccounting: {
        state: 'accounted',
        sourceCount: 1,
        accountedSources: 1,
        pendingSources: 0,
        unknownSources: 0,
        parentAccountedChildren: 0,
        allSourceOccurrencesAccounted: true,
        clinicalExtraction: 'unknown',
        units: { total: 1, pending: 0, extractedClaims: 1, contextOnly: 0, unreadable: 0 },
        packageOccurrences: {
          total: 0,
          accounted: 0,
          pending: 0,
          unknownRoles: 0,
          duplicateBytes: 0,
        },
        dependencies: { missing: 0, uninspected: 0, ambiguous: 0 },
        hostReading: {
          checkpoints: 1,
          unknownSources: 0,
          pendingWindows: 0,
          dispositionedWindows: 1,
          exhaustedSources: 1,
        },
        pauseReasons: [{ reason: 'reading_exhausted', files: 1 }],
      },
    });
    expect(label).toBe('Reading finished · originals remain available');
    expect(label).not.toMatch(/extraction complete|reading is complete/i);
  });

  it('appends exact paginated detail records without changing active rows', () => {
    const firstDetail = {
      view: 'active',
      group: { groupId: 'selected' },
      blocks: [
        {
          intakeId: 'intake',
          proposalId: 'proposal',
          records: [{ id: 'record-1' }, { id: 'active-record' }],
        },
      ],
      totalRecords: 3,
      nextCursor: 'records-page-2',
    } as unknown as IntakeReportQueueDetail;
    const mergedDetail = mergeReportDetailPages(firstDetail, {
      ...firstDetail,
      blocks: [{ intakeId: 'intake', proposalId: 'proposal', records: [{ id: 'record-3' }] }],
      nextCursor: null,
    } as unknown as IntakeReportQueueDetail);
    expect(mergedDetail.blocks[0].records.map((record) => record.id)).toEqual([
      'record-1',
      'active-record',
      'record-3',
    ]);
  });

  it('describes automatic continuation at historical allowance and slice boundaries', () => {
    expect(intakeReadingPauseLabel('job_limit')).toContain(
      'retrying the current section from its saved checkpoint',
    );
    expect(intakeReadingPauseLabel('time_limit')).toContain('continuing from the saved checkpoint');
  });
});

it('distinguishes local review, automatic provider waits, authentication and unknown outcomes', () => {
  expect(intakeReadingPauseLabel('retain_only')).toBe(
    'Original retained; this format is not interpreted.',
  );
  expect(intakeReadingPauseLabel('waiting_for_local_capacity')).toContain('start automatically');
  expect(intakeReadingPauseLabel('source_changed')).toContain('integrity problem');
  expect(intakeReadingPauseLabel('source_review_required')).toContain(
    'Expand the affected source section',
  );
  expect(intakeReadingPauseLabel('extracting_source_text')).toContain('locally');
  expect(intakeReadingPauseLabel('waiting_for_provider')).toContain('retry automatically');
  expect(intakeReadingPauseLabel('provider_authentication')).toContain(
    'Restore the provider connection',
  );
  expect(intakeReadingPauseLabel('provider_outcome_unknown')).toContain(
    'may use additional provider usage',
  );
  expect(intakeReadingPauseLabel('provider_outcome_unknown')).toContain('unknown usage');
  expect(intakeReadingPauseLabel('provider_retry_limit')).toContain('retry automatically');
  expect(intakeReadingPauseLabel('provider_rejected')).toContain('rejected this request');
});
