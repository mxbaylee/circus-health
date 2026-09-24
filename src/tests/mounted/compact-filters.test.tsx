import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MemoryRouter, useNavigate, useSearchParams } from 'react-router-dom';
import { CompactFilters } from '../../app/features/notes/CompactFilters';
import { filtersFromRoute, writeFiltersToRoute } from '../../shared/collection-filters';

const options = {
  source: [
    { value: 'issuer-a', label: 'Issuer A' },
    { value: 'issuer-b', label: 'Issuer B' },
  ],
  type: [
    { value: 'Therapy', label: 'Therapy' },
    { value: 'Primary care', label: 'Primary care' },
  ],
  status: [
    { value: 'draft', label: 'Personal draft' },
    { value: 'provider', label: 'Provider record' },
  ],
};
function Harness() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  return (
    <>
      <CompactFilters
        rows={filtersFromRoute(params, 'historical')}
        visibility={params.get('visibility') || 'visible'}
        onChange={(rows, visibility) => {
          const next = writeFiltersToRoute(params, rows);
          next.set('visibility', visibility);
          next.delete('offset');
          setParams(next);
        }}
        options={options}
        search={params.get('q') || ''}
        onSearch={() => {}}
      />
      <output aria-label="Route">{params.toString()}</output>
      <button onClick={() => navigate(-1)}>Back</button>
      <button onClick={() => navigate(1)}>Forward</button>
    </>
  );
}
const mount = (route = '/') =>
  render(
    <MemoryRouter initialEntries={[route]}>
      <Harness />
    </MemoryRouter>,
  );
const route = () => screen.getByLabelText('Route').textContent || '';

describe('historical saved filters', () => {
  it('keeps a draft separate, explicitly saves it, and leaves the panel open', async () => {
    const user = userEvent.setup();
    mount('/?offset=40');
    expect(screen.getByText('Active')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Filters, 1 active' }));
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    expect(screen.getByRole('button', { name: 'Save filter' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Issuer A' }));
    await user.click(screen.getByRole('checkbox', { name: 'Issuer B' }));
    expect(route()).toContain('offset=40');
    await user.click(screen.getByRole('button', { name: 'Save filter' }));
    expect(route()).not.toContain('offset=');
    expect(screen.getByText('Issuing source / personal includes Issuer A, Issuer B')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Filter conditions' })).toBeVisible();
  });

  it('supports date bounds, cancel, missing values, and Back/Forward', async () => {
    const user = userEvent.setup();
    mount(
      '/?filters=' +
        encodeURIComponent(
          JSON.stringify([{ field: 'type', operator: 'any', values: ['Missing'] }]),
        ) +
        '&visibility=all',
    );
    await user.click(screen.getByRole('button', { name: 'Edit Type includes Missing' }));
    expect(
      screen.getByRole('checkbox', { name: 'Missing (not in current options)' }),
    ).toBeChecked();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter field' }), 'date');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter operator' }), 'between');
    fireEvent.change(screen.getByLabelText('Start date for filter'), {
      target: { value: '2025-01-01' },
    });
    fireEvent.change(screen.getByLabelText('End date for filter'), {
      target: { value: '2025-12-31' },
    });
    expect(route()).toContain('Missing');
    await user.click(screen.getByRole('button', { name: 'Save filter' }));
    expect(screen.getByText(/Listed date between .*2025-01-01, 2025-12-31/)).toBeVisible();
    await user.click(
      screen.getByRole('button', {
        name: /Edit Listed date between .*2025-01-01, 2025-12-31/,
      }),
    );
    fireEvent.change(screen.getByLabelText('Start date for filter'), {
      target: { value: '2025-02-01' },
    });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText(/Listed date between .*2025-01-01, 2025-12-31/)).toBeVisible();
    await user.click(
      screen.getByRole('button', {
        name: /Delete Listed date between .*2025-01-01, 2025-12-31/,
      }),
    );
    expect(route()).not.toContain('filters=');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText(/Listed date between .*2025-01-01, 2025-12-31/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Forward' }));
    expect(screen.queryByText(/Listed date between 2025-01-01/)).not.toBeInTheDocument();
  });
});
