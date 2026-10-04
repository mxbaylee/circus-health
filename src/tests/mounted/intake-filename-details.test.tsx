import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, it, expect, vi } from 'vitest';
import { IntakeFilenameDetails } from '../../app/features/intake/IntakeFilenameDetails';
import { intakeFilenameDisplay, type IntakeFilenameReference } from '../../shared/intake-summary';
import { isRetainOnlyIntake } from '../../shared/intake-source-policy';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
const profile = { id: 'fictional-filename', name: 'Fictional Reader', placebo: true };
const reference: IntakeFilenameReference = {
  format: 'health-intake-filename-reference-v1',
  intakeId: 'fictional-source',
  field: 'originalName',
  pins: { sourceHash: 'c'.repeat(64), logicalRoot: 'd'.repeat(64), domainVersion: 3, version: 3 },
  scalarHash: 'e'.repeat(64),
  bytes: 60000,
};
beforeEach(() => {
  replaceProfiles([profile]);
  selectProfile(profile);
});
it('keeps one selected filename fragment and uses explicit preview and checked eligibility', async () => {
  const source = {
    filenamePreview: 'fictional-prefix',
    filenameTruncated: true as const,
    filenameReference: reference,
    retainOnly: true,
    packageSource: false,
    mimeType: 'text/plain',
  };
  expect(intakeFilenameDisplay(source)).toBe('fictional-prefix… (shortened)');
  expect(isRetainOnlyIntake(source)).toBe(true);
  const fetch = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
    const input = JSON.parse(String(options?.body));
    expect(input.reference).toEqual(reference);
    expect(input.limit).toBe(32768);
    const next = input.cursor === 'fictional-next';
    return new Response(
      JSON.stringify({
        data: {
          format: 'health-intake-filename-fragment-v1',
          reference,
          encoding: 'json-string',
          text: next ? 'fictional-last.mp3"' : '"fictional-first',
          complete: next,
          nextCursor: next ? null : 'fictional-next',
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetch);
  render(<IntakeFilenameDetails reference={reference} />);
  const details = screen.getByText('Full retained filename').parentElement!;
  details.setAttribute('open', '');
  fireEvent(details, new Event('toggle'));
  await screen.findByText('"fictional-first');
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('fictional-last.mp3"');
  expect(screen.queryByText('"fictional-first')).toBeNull();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'First' }));
  await screen.findByText('"fictional-first');
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
});
