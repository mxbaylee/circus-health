import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MemoryRouter, useNavigate, useSearchParams } from 'react-router-dom';
import { PeopleFilters } from '../../app/features/notes/PeopleFilters';
import { filtersFromRoute, writeFiltersToRoute } from '../../shared/collection-filters';
const options = {
  tags: [
    { value: 'Family', label: 'Family' },
    { value: 'Professional', label: 'Professional' },
  ],
  lifeStatus: [
    { value: 'alive', label: 'Alive' },
    { value: 'deceased', label: 'Deceased' },
  ],
};
function Harness() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  return (
    <>
      <PeopleFilters
        rows={filtersFromRoute(params, 'person')}
        visibility={params.get('visibility') || 'visible'}
        options={options}
        search={params.get('q') || ''}
        onSearch={() => {}}
        onChange={(rows, visibility) => {
          const next = writeFiltersToRoute(params, rows);
          next.set('visibility', visibility);
          setParams(next);
        }}
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
const route = () => screen.getByLabelText('Route').textContent;
describe('People saved filters', () => {
  it('shows default Active, saves only the edited rule, disables unchanged saves, and removes the constraint', async () => {
    const user = userEvent.setup();
    mount('/?offset=40&q=care');
    expect(screen.getByText('Active')).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Visibility' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit Active' }));
    expect(screen.getByRole('combobox', { name: 'Filter field' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Save filter' })).toBeDisabled();
    expect(screen.queryByRole('combobox', { name: 'Filter operator' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    const active = screen.getByRole('switch', { name: 'Active' });
    expect(active).toBeChecked();
    await user.click(active);
    expect(active).not.toBeChecked();
    expect(screen.getByText('Inactive', { selector: '.people-boolean-switch span' })).toBeVisible();
    expect(route()).toBe('offset=40&q=care');
    await user.click(screen.getByRole('button', { name: 'Save filter' }));
    expect(route()).toBe('q=care&visibility=archived');
    expect(screen.getByRole('button', { name: 'Filters, 1 active' })).toHaveFocus();
    expect(screen.getByRole('region', { name: 'Filter conditions' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add filter' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Delete Inactive' }));
    expect(route()).toBe('q=care&visibility=all');
    expect(screen.queryByRole('list', { name: 'Saved filters' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Filter conditions' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.queryByRole('region', { name: 'Filter conditions' })).not.toBeInTheDocument();
  });
  it('keeps exactly one draft, applies human-readable life status independently, and restores Back/Forward', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Filters, 1 active' }));
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    expect(screen.getByRole('button', { name: 'Save filter' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit Active' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add filter' })).toBeDisabled();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter field' }), 'lifeStatus');
    await user.click(screen.getByRole('checkbox', { name: 'Alive' }));
    expect(route()).toBe('');
    await user.click(screen.getByRole('button', { name: 'Save filter' }));
    expect(screen.getByText('Life status includes Alive')).toBeVisible();
    expect(screen.getByText('Active')).toBeVisible();
    const savedRoute = route();
    await user.click(screen.getByRole('button', { name: 'Edit Life status includes Alive' }));
    await user.click(screen.getByRole('checkbox', { name: 'Deceased' }));
    expect(route()).toBe(savedRoute);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Life status includes Alive')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Filter conditions' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add filter' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByText('Life status includes Alive')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Forward' }));
    expect(screen.getByText('Life status includes Alive')).toBeVisible();
  });
  it('keeps drafts visible, supports tag all/unknown, and Escape cancels without changing applied rules', async () => {
    const user = userEvent.setup();
    mount('/?tag=Family&visibility=all');
    await user.click(screen.getByRole('button', { name: 'Edit Tags includes any Family' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter operator' }), 'all');
    await user.click(screen.getByRole('checkbox', { name: 'Professional' }));
    expect(screen.getByRole('button', { name: 'Filters, 1 active' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Professional' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Unknown / untagged' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save filter' }));
    expect(screen.getByText('Tags includes all Family, Professional')).toBeVisible();
    const savedRoute = route();
    await user.click(
      screen.getByRole('button', { name: 'Edit Tags includes all Family, Professional' }),
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter field' }), 'text');
    await user.type(screen.getByRole('textbox', { name: 'Filter text' }), 'temporary');
    await user.keyboard('{Escape}');
    expect(route()).toBe(savedRoute);
    expect(screen.queryByRole('button', { name: 'Save filter' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filters, 1 active' })).toHaveFocus();
    expect(screen.getByRole('region', { name: 'Filter conditions' })).toBeVisible();
  });
  it('cancels stale drafts on navigation and retains missing saved values for deliberate repair', async () => {
    const user = userEvent.setup();
    mount('/?tag=Missing&visibility=all');
    await user.click(screen.getByRole('button', { name: 'Edit Tags includes any Missing' }));
    expect(
      screen.getByRole('checkbox', { name: 'Missing (not in current options)' }),
    ).toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Family' }));
    await user.click(screen.getByRole('button', { name: 'Save filter' }));
    await user.click(
      screen.getByRole('button', { name: 'Edit Tags includes any Missing, Family' }),
    );
    await user.click(screen.getByRole('checkbox', { name: 'Professional' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('button', { name: 'Save filter' })).not.toBeInTheDocument();
    expect(screen.getByText('Tags includes any Missing')).toBeVisible();
  });
  it('prevents converting Active into a thirteenth builder rule', async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: 12 }, () => ({
      field: 'tags',
      operator: 'any',
      values: ['Family'],
    }));
    mount('/?filters=' + encodeURIComponent(JSON.stringify(rows)));
    await user.click(screen.getByRole('button', { name: 'Edit Active' }));
    expect(screen.getByRole('option', { name: 'Tags' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Life status' })).toBeDisabled();
    await user.click(screen.getByRole('switch', { name: 'Active' }));
    await user.click(screen.getByRole('button', { name: 'Save filter' }));
    expect(JSON.parse(new URLSearchParams(route()!).get('filters')!)).toHaveLength(12);
  });
  it('retains unsupported saved rules when saving an unrelated condition', async () => {
    const user = userEvent.setup();
    const bad = { field: 'visibility', operator: 'any', values: ['retained'] };
    mount('/?filters=' + encodeURIComponent(JSON.stringify([bad])));
    await user.click(screen.getByRole('button', { name: 'Edit Active' }));
    await user.click(screen.getByRole('switch', { name: 'Active' }));
    await user.click(screen.getByRole('button', { name: 'Save filter' }));
    expect(JSON.parse(new URLSearchParams(route()!).get('filters')!)).toEqual([bad]);
    await user.click(
      screen.getByRole('button', { name: /Delete Active status Unsupported field/ }),
    );
    expect(new URLSearchParams(route()!).has('filters')).toBe(false);
  });
  it('requires explicit clearing of unreadable filters before another rule can change results', () => {
    render(
      <PeopleFilters
        rows={[]}
        visibility="visible"
        options={options}
        search=""
        onSearch={() => {}}
        onChange={() => {}}
        error="These saved filters could not be read. Clear them to continue."
      />,
    );
    expect(screen.getByRole('button', { name: 'Edit Active' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete Active' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeEnabled();
  });

  it('treats reordered set values as unchanged after toggling a selection back on', async () => {
    const user = userEvent.setup();
    mount(
      '/?filters=' +
        encodeURIComponent(
          JSON.stringify([{ field: 'tags', operator: 'any', values: ['Family', 'Professional'] }]),
        ),
    );
    await user.click(
      screen.getByRole('button', { name: 'Edit Tags includes any Family, Professional' }),
    );
    await user.click(screen.getByRole('checkbox', { name: 'Family' }));
    expect(screen.getByRole('button', { name: 'Save filter' })).toBeEnabled();
    await user.click(screen.getByRole('checkbox', { name: 'Family' }));
    expect(screen.getByRole('button', { name: 'Save filter' })).toBeDisabled();
  });
});
