import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../app/components/ThemeProvider';
import { ThemeToggle } from '../../app/components/ThemeToggle';
function device(dark: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    matches: dark,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.spyOn(window, 'matchMedia').mockReturnValue(media as unknown as MediaQueryList);
  return {
    change(value: boolean) {
      act(() => {
        media.matches = value;
        listeners.forEach((fn) => fn());
      });
    },
    listeners,
  };
}
describe('appearance preference', () => {
  it('defaults to System and follows live device changes until explicitly overridden', async () => {
    const favicon = document.createElement('link');
    favicon.id = 'app-favicon';
    document.head.appendChild(favicon);
    const os = device(false);
    const view = render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(favicon.getAttribute('href')).toBe('/favicon-light.svg');
    os.change(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(favicon.getAttribute('href')).toBe('/favicon-dark.svg');
    await userEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(localStorage.getItem('circus-health-theme')).toBe('light');
    os.change(false);
    os.change(true);
    expect(document.documentElement.dataset.theme).toBe('light');
    await userEvent.click(screen.getByRole('radio', { name: 'System' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('circus-health-theme')).toBe('system');
    view.unmount();
    favicon.remove();
    expect(os.listeners.size).toBe(0);
  });
  it('preserves a saved selection and responds to another tab changing it', () => {
    device(false);
    localStorage.setItem('circus-health-theme', 'dark');
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
    expect(document.documentElement.dataset.theme).toBe('dark');
    localStorage.setItem('circus-health-theme', 'system');
    fireEvent(window, new StorageEvent('storage', { key: 'circus-health-theme' }));
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    expect(document.documentElement.dataset.theme).toBe('light');
  });
  it('supports keyboard selection using native radio navigation', async () => {
    device(false);
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    await userEvent.tab();
    expect(screen.getByRole('radio', { name: 'System' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
  });
});

it('retains an explicit preference saved before the branding update', () => {
  device(false);
  localStorage.setItem('health-prototype-theme', 'dark');
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
  expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
  expect(localStorage.getItem('circus-health-theme')).toBe('dark');
  expect(localStorage.getItem('health-prototype-theme')).toBeNull();
});
