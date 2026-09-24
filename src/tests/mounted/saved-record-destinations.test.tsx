import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Intake, IntakeAcceptedRecord } from '../../shared/intake';
import {
  acceptedRecordDestination,
  acceptedRecordsForScope,
  SavedRecordDestinations,
} from '../../app/features/import/SavedRecordDestinations';

const accepted = (
  recordId: string,
  entityId: string,
  kind: IntakeAcceptedRecord['kind'],
  title: string,
  optical = false,
  groupId = 'fictional-report-a',
): IntakeAcceptedRecord => ({
  recordId,
  entityId,
  kind,
  title,
  optical,
  outcome: 'added',
  identityAttribution: {
    status: 'missing_warning',
    basis: 'reviewed_active_profile_missing_identity',
    groupId,
    groupVersionId: 'fictional-group-version',
  },
});

describe('saved Import destinations', () => {
  it('routes every durable accepted entity to its real profile destination', () => {
    const records = [
      accepted('observation-row', 'observation-entity', 'observation', 'Fictional ferritin'),
      accepted('medication-row', 'medication-entity', 'medication', 'Fictional capsule'),
      accepted('procedure-row', 'procedure-entity', 'procedure', 'Fictional imaging'),
      accepted('document-row', 'document-entity', 'document', 'Fictional provider note'),
      accepted('vision-row', 'vision-entity', 'document', 'Fictional lenses', true),
    ];
    expect(records.map(acceptedRecordDestination)).toEqual([
      {
        label: 'Test result',
        to: '/tests?result=observation-entity&visibility=all',
      },
      {
        label: 'Prescription',
        to: '/medications?id=medication-entity&status=all',
      },
      {
        label: 'Procedure',
        to: '/procedures?id=procedure-entity&category=all&visibility=all',
      },
      { label: 'Provider document', to: '/sources?document=document-entity' },
      {
        label: 'Vision prescription',
        to: '/tests?view=vision&document=vision-entity&visibility=all',
      },
    ]);

    render(
      <MemoryRouter>
        <SavedRecordDestinations records={records} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /Fictional ferritin/ })).toHaveAttribute(
      'href',
      '/tests?result=observation-entity&visibility=all',
    );
    expect(screen.getByRole('link', { name: /Fictional capsule/ })).toHaveAttribute(
      'href',
      '/medications?id=medication-entity&status=all',
    );
    expect(screen.getByRole('link', { name: /Fictional imaging/ })).toHaveAttribute(
      'href',
      '/procedures?id=procedure-entity&category=all&visibility=all',
    );
    expect(screen.getByRole('link', { name: /Fictional provider note/ })).toHaveAttribute(
      'href',
      '/sources?document=document-entity',
    );
    expect(screen.getByRole('link', { name: /Fictional lenses/ })).toHaveAttribute(
      'href',
      '/tests?view=vision&document=vision-entity&visibility=all',
    );
    expect(screen.getByRole('link', { name: 'Activate prescriptions' })).toHaveAttribute(
      'href',
      '/medications?status=inactive&activation=1',
    );
  });

  it('does not leak receipts from a different proposal, report, or record', () => {
    const exact = accepted('shared-row', 'exact-entity', 'observation', 'Fictional exact result');
    const otherReport = accepted(
      'shared-row',
      'other-report-entity',
      'observation',
      'Fictional other report result',
      false,
      'fictional-report-b',
    );
    const otherRecord = accepted(
      'other-row',
      'other-row-entity',
      'procedure',
      'Fictional other row',
    );
    const otherProposal = accepted(
      'shared-row',
      'other-proposal-entity',
      'document',
      'Fictional other proposal',
    );
    const intake = {
      acceptedProposalId: 'proposal-b',
      imported: { clinical: { records: [otherProposal] } },
      importHistory: [
        {
          acceptedProposalId: 'proposal-a',
          clinical: { records: [exact, otherReport, otherRecord] },
        },
        { acceptedProposalId: 'proposal-b', clinical: { records: [otherProposal] } },
      ],
    } as Intake;

    expect(
      acceptedRecordsForScope(intake, {
        groupId: 'fictional-report-a',
        proposalId: 'proposal-a',
        recordIds: ['shared-row'],
      }),
    ).toEqual([exact]);
  });
});
