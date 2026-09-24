import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { SourceContextNotes } from '../../app/features/intake/SourceContextNotes';
import type { IntakeSourceContext } from '../../shared/intake';

const context: IntakeSourceContext = {
  id: 'fictional-context',
  envelopeId: 'fictional-panel-context',
  kind: 'context',
  title: 'Source context',
  payload: { panel: 'Fictional panel' },
  text: '{"panel":"Fictional panel","literalNumber":0.000000000000000000123}',
  provenance: {
    capturedVia: 'Fictional Clinic',
    sourceSystem: null,
    sourceRecordId: null,
    evidenceClass: 'transcription',
    locator: 'Page 1 heading',
  },
  coverage: { status: 'partial', notes: ['Clipped letterhead'] },
  notes: ['Clipped letterhead'],
  evidence: [{ label: 'Open original', locator: 'Page 1 heading', contentUrl: '/original' }],
};

it('keeps source context inspectable without turning it into a clinical question', async () => {
  const user = userEvent.setup();
  render(<SourceContextNotes items={[context]} />);
  expect(screen.getByText(context.text)).not.toBeVisible();
  await user.click(screen.getByText('Source context', { exact: true }));
  expect(screen.getByText(context.text)).toBeVisible();
  expect(screen.getByText('Clipped letterhead')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Open original' })).toHaveAttribute('href', '/original');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

it('renders retained strings as text and keeps source entries individually collapsible', async () => {
  const user = userEvent.setup();
  render(
    <SourceContextNotes
      items={[context, { ...context, id: 'second', text: '<script>sourceText()</script>' }]}
    />,
  );
  await user.click(screen.getByText('Source context 2'));
  expect(screen.getByText('<script>sourceText()</script>')).toBeVisible();
  expect(screen.getByText(context.text)).not.toBeVisible();
  expect(document.querySelector('script')).toBeNull();
});
