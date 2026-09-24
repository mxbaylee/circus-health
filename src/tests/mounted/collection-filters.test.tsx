import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it } from 'vitest';
import {
  CollectionFilters,
  dateRangeFilter,
  selectFilter,
  visibilityFilter,
} from '../../app/components/CollectionFilters';

function Harness() {
  const [values, setValues] = useState({ visibility: 'visible', provider: '' });
  return (
    <>
      <CollectionFilters
        search=""
        onSearch={() => {}}
        searchLabel="fictional records"
        definitions={[
          visibilityFilter(values.visibility),
          selectFilter({
            key: 'provider',
            label: 'Provider',
            value: values.provider,
            options: [{ value: 'provider-1', label: 'Fictional Clinic' }],
          }),
        ]}
        onApply={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
      />
      <output aria-label="Values">{JSON.stringify(values)}</output>
    </>
  );
}

it('uses saved pills and one explicit draft for simple collection fields', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Edit Active' }));
  expect(screen.getByRole('button', { name: 'Save filter' })).toBeDisabled();
  await user.click(screen.getByRole('switch', { name: 'Active' }));
  expect(screen.getByLabelText('Values')).toHaveTextContent('visible');
  await user.click(screen.getByRole('button', { name: 'Save filter' }));
  expect(screen.getByText('Inactive', { selector: '.people-filter-pill > span' })).toBeVisible();
  expect(screen.getByRole('region', { name: 'Filter conditions' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Add filter' }));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), 'provider-1');
  expect(screen.getByLabelText('Values')).not.toHaveTextContent('provider-1');
  await user.click(screen.getByRole('button', { name: 'Save filter' }));
  expect(screen.getByText('Provider is Fictional Clinic')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Delete Inactive' }));
  expect(screen.getByLabelText('Values')).toHaveTextContent('"visibility":"all"');
  await user.click(screen.getByRole('button', { name: 'Add filter' }));
  expect(screen.getByRole('switch', { name: 'Active' })).toBeChecked();
  await user.click(screen.getByRole('button', { name: 'Save filter' }));
  expect(screen.getByLabelText('Values')).toHaveTextContent('"visibility":"visible"');
});

it('locks an existing simple filter field while new drafts can choose another field', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Edit Active' }));
  expect(screen.getByRole('combobox', { name: 'Filter field' })).toHaveTextContent('Active status');
  expect(screen.getByRole('combobox', { name: 'Filter field' })).not.toHaveTextContent('Provider');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(screen.getByRole('button', { name: 'Add filter' }));
  expect(screen.getByRole('combobox', { name: 'Filter field' })).toHaveTextContent('Provider');
});

it('retains unsupported URL values until the user explicitly replaces or deletes them', async () => {
  const user = userEvent.setup();
  const values: { key: string; value: string }[] = [];
  render(
    <CollectionFilters
      search=""
      onSearch={() => {}}
      searchLabel="fictional records"
      definitions={[
        visibilityFilter('unexpected'),
        selectFilter({
          key: 'provider',
          label: 'Provider',
          value: 'retired-provider',
          options: [{ value: 'provider-1', label: 'Fictional Clinic' }],
        }),
        dateRangeFilter('2025-02-30', ''),
      ]}
      onApply={(key, value) => values.push({ key, value })}
    />,
  );
  expect(screen.getByText('Active status has unsupported value unexpected')).toBeVisible();
  expect(screen.getByText('Provider has unsupported value retired-provider')).toBeVisible();
  expect(screen.getByText('Listed date has unsupported value 2025-02-30|')).toBeVisible();
  await user.click(
    screen.getByRole('button', { name: 'Edit Provider has unsupported value retired-provider' }),
  );
  expect(screen.getByRole('option', { name: 'Unsupported: retired-provider' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save filter' })).toBeDisabled();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), 'provider-1');
  await user.click(screen.getByRole('button', { name: 'Save filter' }));
  expect(values).toEqual([{ key: 'provider', value: 'provider-1' }]);
});
