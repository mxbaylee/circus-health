import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { RecordCorrectionDialog } from '../../app/features/clinical-review/RecordCorrectionDialog';
import type {
  RecordCorrectionApplyResult,
  RecordCorrectionPreview,
} from '../../shared/record-correction';
import {
  documentCorrectionTarget,
  medicationCorrectionTarget,
  observationCorrectionTarget,
  procedureCorrectionTarget,
} from '../../app/features/clinical-review/recordCorrectionTargets';

describe('RecordCorrectionDialog', () => {
  it('adapts current individual record DTOs while retaining accepted mapping fields', () => {
    expect(
      observationCorrectionTarget({
        id: 'fictional-result',
        testTypeId: 'fictional-type',
        label: 'Ferritin',
        date: '2026-08-24',
        datePrecision: 'day',
        valueText: '18',
        value: 18,
        comparator: null,
        unit: 'ng/mL',
        reference: '10–120',
        status: 'final',
        providerId: null,
        provider: 'Fictional Harbor Clinic',
        sourceRecordId: 'fictional-source-record',
        reportId: null,
        extra: { import: { acceptedMapping: { code: 'fictional-code', valueText: '17' } } },
      }).mapping,
    ).toMatchObject({
      kind: 'observation',
      testLabel: 'Ferritin',
      valueText: '18',
      unit: 'ng/mL',
      code: 'fictional-code',
    });
    expect(
      medicationCorrectionTarget({
        id: 'fictional-medication',
        label: 'Fictional medicine',
        kind: 'order',
        status: 'active',
        currentStatus: 'unknown',
        currentStatusVersion: 1,
        visibilityVersion: 1,
        currentStatusUpdatedAt: null,
        currentStatusAssertion: null,
        sourceRecordedDate: '2026-08-20',
        doseText: '5 mg',
        route: 'oral',
        frequency: 'daily',
        startAt: null,
        endAt: null,
        provider: null,
        sourceRecordId: 'fictional-medication-source',
        extra: { import: { acceptedMapping: { dateRole: 'recorded' } } },
      }).mapping,
    ).toMatchObject({
      kind: 'medication',
      medicationName: 'Fictional medicine',
      medicationKind: 'order',
      dateRole: 'recorded',
    });
    expect(
      procedureCorrectionTarget({
        id: 'fictional-procedure',
        label: 'Fictional imaging',
        category: 'imaging',
        date: '2026-07-01',
        status: 'completed',
        provider: null,
        sourceRecordId: 'fictional-procedure-source',
        extra: { import: { acceptedMapping: { eventKind: 'performed' } } },
      }).mapping,
    ).toMatchObject({
      kind: 'procedure',
      procedureCategory: 'imaging',
      eventKind: 'performed',
    });
    expect(
      documentCorrectionTarget({
        id: 'fictional-document',
        origin: 'provider',
        title: 'Fictional follow-up',
        typeLabel: 'Consultation',
        date: '2026-06-02',
        eventDate: '2026-06-01',
        recordDate: '2026-06-02',
        dateBasis: 'source',
        sourceId: 'fictional-source',
        sourceLabel: 'Fictional Harbor Clinic',
        sourceStatus: 'signed',
        sourceType: 'note',
        sourceRecordId: 'fictional-document-source',
        content: 'Current fictional text.',
        authors: [],
        classificationBasis: null,
        presentationNote: null,
        evidence: [],
        attachments: [],
        status: 'provider',
        readOnly: true,
        extra: { import: { acceptedMapping: { visitSpecialty: 'Cardiology', text: 'Old' } } },
      }).mapping,
    ).toMatchObject({
      kind: 'document',
      documentTitle: 'Fictional follow-up',
      documentDate: '2026-06-02',
      date: '2026-06-01',
      text: 'Current fictional text.',
      visitSpecialty: 'Cardiology',
    });
  });

  it('reviews both originals and retries apply with the exact preview request and operation ID', async () => {
    const preview: RecordCorrectionPreview = {
      request: {
        kind: 'observation',
        recordId: 'fictional-saved-record',
        set: { valueText: '18' },
        reason: 'The saved original reads 18.',
        supportingEvidence: [
          {
            intakeId: 'fictional-intake',
            proposalId: 'fictional-proposal',
            recordId: 'fictional-incoming-record',
            candidateId: 'fictional-candidate',
            candidateVersionId: 'fictional-candidate-version',
            originalSourceFileId: 'fictional-intake',
          },
        ],
      },
      version: 12,
      previewToken: 'a'.repeat(64),
      before: { kind: 'observation', testLabel: 'Ferritin', valueText: '17', unit: 'ng/mL' },
      after: { kind: 'observation', testLabel: 'Ferritin', valueText: '18', unit: 'ng/mL' },
      evidence: [
        {
          sourceRecordId: 'fictional-saved-source-record',
          sourceFileId: 'fictional-saved-source',
          acquiringSource: 'Fictional Harbor Clinic',
          contentUrl: '/fictional-saved-original',
        },
      ],
      supportingEvidence: [
        {
          ...{
            intakeId: 'fictional-intake',
            proposalId: 'fictional-proposal',
            recordId: 'fictional-incoming-record',
            candidateId: 'fictional-candidate',
            candidateVersionId: 'fictional-candidate-version',
            originalSourceFileId: 'fictional-intake',
          },
          intakeVersion: 4,
          originalSourceHash: 'fictional-original-hash',
          filename: 'fictional-follow-up.pdf',
          contentUrl: '/fictional-incoming-original',
          locator: 'page 3, row 2',
          memberId: null,
          title: 'Incoming fictional ferritin',
        },
      ],
      supportedTargetKinds: ['observation', 'procedure', 'document'],
      editableFields: ['kind', 'testLabel', 'valueText', 'unit'],
      reclassification: false,
      destination: {
        kind: 'observation',
        recordId: 'fictional-saved-record',
        appUrl: '/tests/fictional-saved-record',
        apiUrl: '/api/tests/fictional-saved-record',
      },
      sourceUnchanged: true,
    };
    const applied: RecordCorrectionApplyResult = {
      operationId: 'filled-by-test',
      replayed: true,
      destination: preview.destination,
      sourceUnchanged: true,
      receipt: {
        id: 'fictional-correction-receipt',
        appliedRevision: 13,
        result: {
          kind: 'observation',
          previousKind: 'observation',
          recordId: 'fictional-saved-record',
          exceptionId: 'fictional-exception',
          before: preview.before,
          after: preview.after,
          reason: preview.request.reason,
          supportingEvidence: preview.supportingEvidence,
          sourceUnchanged: true,
        },
      },
    };
    const previewCorrection = vi.fn(async () => preview);
    let applies = 0;
    const applyCorrection = vi.fn(async (request) => {
      if (++applies === 1) throw new Error('Connection interrupted after saving');
      return { ...applied, operationId: request.operationId };
    });
    const onApplied = vi.fn();
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <RecordCorrectionDialog
          open
          onOpenChange={vi.fn()}
          target={{
            kind: 'observation',
            recordId: 'fictional-saved-record',
            title: 'Fictional ferritin result',
            mapping: {
              kind: 'observation',
              testLabel: 'Ferritin',
              valueText: '17',
              unit: 'ng/mL',
            },
          }}
          supporting={{
            reference: preview.request.supportingEvidence![0]!,
            label: 'Incoming fictional ferritin',
            locator: 'page 3, row 2',
            contentUrl: '/fictional-incoming-original',
          }}
          previewCorrection={previewCorrection}
          applyCorrection={applyCorrection}
          onApplied={onApplied}
          returnLabel="Return to comparison"
        />
      </MemoryRouter>,
    );

    const result = screen.getByLabelText('Result');
    await user.clear(result);
    await user.type(result, '18');
    await user.type(
      screen.getByLabelText('Why this saved interpretation is being corrected'),
      'The saved original reads 18.',
    );
    await user.click(screen.getByLabelText(/Use the incoming original as supporting evidence/));
    await user.click(screen.getByRole('button', { name: 'Review before and after' }));
    expect(previewCorrection).toHaveBeenCalledWith(preview.request);

    const diff = await screen.findByRole('region', { name: 'Correction before and after' });
    expect(within(diff).getByText('17')).toBeVisible();
    expect(within(diff).getByText('18')).toBeVisible();
    expect(
      screen
        .getAllByRole('link', { name: 'Open original' })
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/fictional-saved-original', '/fictional-incoming-original']);

    await user.click(screen.getByRole('button', { name: 'Apply reviewed correction' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Connection interrupted after saving',
    );
    await user.click(screen.getByRole('button', { name: 'Retry correction' }));
    expect(await screen.findByRole('region', { name: 'Saved correction' })).toBeVisible();
    expect(applyCorrection).toHaveBeenCalledTimes(2);
    expect(applyCorrection.mock.calls[1]![0]).toEqual(applyCorrection.mock.calls[0]![0]);
    expect(applyCorrection.mock.calls[0]![0]).toMatchObject({
      ...preview.request,
      version: preview.version,
      previewToken: preview.previewToken,
      operationId: expect.any(String),
    });
    expect(onApplied).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Open corrected record and history' })).toHaveAttribute(
      'href',
      '/tests/fictional-saved-record',
    );
    expect(screen.getByRole('button', { name: 'Return to comparison' })).toBeVisible();
  });
});
