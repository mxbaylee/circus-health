import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { IntakeMetadataEditor } from '../../app/features/intake/ReviewWorkspace';
import type { Intake } from '../../shared/intake';

const intake = {
  id: 'fictional-intake',
  providerId: 'upload',
  provider: 'Manual upload',
  acquisition: { providerId: 'upload', provider: 'Encrypted browser upload' },
  metadata: {
    source: 'My earlier label',
    careArea: null,
    documentType: null,
    topics: ['Existing topic'],
  },
  filename: 'fictional-report.txt',
} as Intake;

it('offers evidence suggestions for explicit selection without changing acquisition details', async () => {
  const onSave = vi.fn(async () => true);
  const user = userEvent.setup();
  const view = render(
    <IntakeMetadataEditor
      intake={intake}
      options={[]}
      suggestions={{
        source: ['Fictional Harbor Clinic'],
        careArea: ['Vision'],
        documentType: ['Prescription'],
        topics: ['Eyewear'],
      }}
      busy={false}
      onSave={onSave}
    />,
  );

  expect(screen.getByText(/Uploaded from: Encrypted browser upload/)).toBeVisible();
  expect(screen.getByText('My earlier label')).toBeVisible();
  expect(onSave).not.toHaveBeenCalled();

  await user.click(
    screen.getByRole('button', { name: 'Replace source with Fictional Harbor Clinic' }),
  );
  expect(onSave).toHaveBeenLastCalledWith({
    source: 'Fictional Harbor Clinic',
    careArea: null,
    documentType: null,
    topics: ['Existing topic'],
  });
  view.rerender(
    <IntakeMetadataEditor
      intake={{
        ...intake,
        metadata: { ...intake.metadata!, source: 'Fictional Harbor Clinic' },
      }}
      options={[]}
      suggestions={{
        source: ['Fictional Harbor Clinic'],
        careArea: ['Vision'],
        documentType: ['Prescription'],
        topics: ['Eyewear'],
      }}
      busy={false}
      onSave={onSave}
    />,
  );
  expect(screen.getByText('Fictional Harbor Clinic')).toBeVisible();
  expect(screen.getByText(/Uploaded from: Encrypted browser upload/)).toBeVisible();

  await user.click(screen.getByRole('button', { name: 'Use suggested topic: Eyewear' }));
  expect(onSave).toHaveBeenLastCalledWith({
    source: 'Fictional Harbor Clinic',
    careArea: null,
    documentType: null,
    topics: ['Existing topic', 'Eyewear'],
  });
});
