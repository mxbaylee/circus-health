import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { LoadingIndicator } from '../../app/components/LoadingIndicator';

it.each([
  ['inline', 'medium'],
  ['control', 'small'],
  ['panel', 'medium'],
  ['centered', 'large'],
] as const)('renders the %s layout with a stable %s cartwheel footprint', (layout, size) => {
  render(<LoadingIndicator label={`Fictional ${layout} work…`} layout={layout} />);

  const status = screen.getByRole('status');
  expect(status).toHaveClass(`loading-indicator-${layout}`);
  expect(status).toHaveAttribute('data-size', size);
  expect(status).not.toHaveAttribute('aria-busy');
  expect(status).toHaveAttribute('aria-live', 'polite');
  expect(status).toHaveTextContent(`Fictional ${layout} work…`);

  const sprite = status.querySelector('svg')!;
  expect(sprite).toHaveAttribute('aria-hidden', 'true');
  expect(sprite).toHaveAttribute('focusable', 'false');
  expect(sprite.querySelectorAll('[data-pose]')).toHaveLength(9);
});

it('lets an existing live region own the announcement without hiding the visible status', () => {
  render(
    <div role="status" aria-live="polite">
      <LoadingIndicator label="Fictional nested work…" announce={false} />
    </div>,
  );

  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(
    screen.getByText('Fictional nested work…').closest('.loading-indicator'),
  ).not.toHaveAttribute('role');
});

it('holds the ready drawing still when reduced motion is requested', () => {
  const css = readFileSync(
    resolve(process.cwd(), 'src/app/features/assistant/moxie-activity-alternative.css'),
    'utf8',
  );

  expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  expect(css).toMatch(
    /\.moxie-jester-alternative-frame\s*{[\s\S]*?animation: none;[\s\S]*?visibility: hidden;/,
  );
  expect(css).toMatch(
    /\.moxie-jester-alternative-frame\[data-pose='ready'\]\s*{\s*visibility: visible;/,
  );
});
