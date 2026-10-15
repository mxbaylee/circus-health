import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { IntakeSummaryV2 } from '../../shared/intake-summary';
import { loadAcceptedRecordsForScope } from '../../app/features/import/SavedRecordDestinations';
import { IntakeMetadataEditor } from '../../app/features/intake/ReviewWorkspace';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
const profile = { id: 'fictional-summary', name: 'Fictional Reader', placebo: true };
const summary = {
  format: 'health-intake-summary-v2',
  id: 'fictional-source',
  version: 3,
  filename: 'fictional.zip',
  provider: 'Fictional Clinic',
  metadataState: 'unloaded',
} as IntakeSummaryV2;
beforeEach(() => {
  replaceProfiles([profile]);
  selectProfile(profile);
});
it('loads exact saved destinations from selected record IDs without inspecting unloaded history', async () => {
  const fetch = vi.fn(
    async (_input: RequestInfo | URL) =>
      new Response(
        JSON.stringify({
          data: {
            format: 'health-intake-accepted-destinations-v1',
            intakeId: summary.id,
            version: 3,
            groupId: 'group',
            proposalId: null,
            records: [
              {
                recordId: 'record',
                entityId: 'retained-document',
                kind: 'document',
                title: 'Fictional report',
                optical: false,
                outcome: 'added',
              },
            ],
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetch);
  const records = await loadAcceptedRecordsForScope(
    summary.id,
    { groupId: 'group', proposalId: null, recordIds: ['record'] },
    summary,
  );
  expect(records[0]?.entityId).toBe('retained-document');
  expect(String(fetch.mock.calls[0]?.[0])).toContain(
    '/accepted-destinations?groupId=group&recordId=record',
  );
});
it('refuses saved links from a changed selected source version', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              format: 'health-intake-accepted-destinations-v1',
              intakeId: summary.id,
              version: 4,
              groupId: 'group',
              proposalId: null,
              records: [],
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    ),
  );
  await expect(
    loadAcceptedRecordsForScope(
      summary.id,
      { groupId: 'group', proposalId: null, recordIds: ['record'] },
      summary,
    ),
  ).rejects.toThrow(/did not match/);
});
it('never replaces unloaded labels with an empty editable form', () => {
  render(
    <IntakeMetadataEditor intake={summary} options={[summary]} busy={false} onSave={vi.fn()} />,
  );
  expect(screen.getByRole('status')).toHaveTextContent('not loaded completely');
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});
