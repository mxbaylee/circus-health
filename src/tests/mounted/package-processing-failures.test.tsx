import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { IntakePackageFailure } from '../../shared/intake';
import { PackageProcessingFailures } from '../../app/features/intake/PackageProcessingFailures';

const failure: IntakePackageFailure = {
  sourceFileId: 'fictional-package',
  sourceHash: 'a'.repeat(64),
  operationKey: 'extract:member:fictional',
  originalFilename: 'fictional-delivery.zip',
  contentUrl: '/api/sources/fictional-package/content',
  memberId: 'member:fictional',
  ordinal: 17,
  filename: 'reports/fictional.pdf',
  locator: 'ZIP member reports/fictional.pdf',
  reasonCode: 'PACKAGE_CRC',
  detail: 'This member could not be read. The original remains retained.',
  status: 'pending',
  scope: 'incomplete',
  retryAction: 'read_member',
};

it('shows durable exact member scope and downloadable original without inventing a page; retries that scope', async () => {
  const retry = vi.fn();
  render(
    <PackageProcessingFailures failures={{ fictional: failure }} busy={false} onRetry={retry} />,
  );
  expect(screen.getByRole('region', { name: 'Unfinished package processing' })).toBeVisible();
  expect(screen.getByText('reports/fictional.pdf')).toBeVisible();
  expect(screen.getByText('ZIP member reports/fictional.pdf')).toBeVisible();
  expect(screen.getByText(/scope is incomplete/)).toBeVisible();
  const original = screen.getByRole('link', { name: 'Open original: fictional-delivery.zip' });
  expect(original).toHaveAttribute('href', failure.contentUrl);
  expect(original.getAttribute('href')).not.toContain('#page=');
  expect(screen.queryByText(/page 1/i)).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry member' }));
  expect(retry).toHaveBeenCalledWith(failure);
});

it('keeps an unknown inventory scope at the retained original and prevents retry while busy', () => {
  const inventory: IntakePackageFailure = {
    sourceFileId: failure.sourceFileId,
    sourceHash: failure.sourceHash,
    operationKey: 'inventory',
    originalFilename: failure.originalFilename,
    contentUrl: failure.contentUrl,
    reasonCode: 'PACKAGE_TRUNCATED',
    detail: 'The inventory could not finish; remaining members are unknown.',
    status: 'pending',
    scope: 'incomplete',
    retryAction: 'inventory',
  };
  render(<PackageProcessingFailures failures={{ inventory }} busy={true} onRetry={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Retry inventory' })).toBeDisabled();
  expect(screen.getByText(/remaining members are unknown/)).toBeVisible();
  expect(screen.queryByText(/Member ordinal/)).not.toBeInTheDocument();
});
