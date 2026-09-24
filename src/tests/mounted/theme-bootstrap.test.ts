import html from '../../index.html?raw';
import { expect, it } from 'vitest';

const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

it('defines the theme favicon before the no-flash bootstrap runs', () => {
  expect(html.indexOf('id="app-favicon"')).toBeGreaterThan(-1);
  expect(html.indexOf('id="app-favicon"')).toBeLessThan(html.indexOf('<script>'));
});

it.each([
  ['light', true, 'light'],
  ['dark', false, 'dark'],
  ['system', true, 'dark'],
  [null, false, 'light'],
  ['invalid', true, 'dark'],
])('applies %s with device dark=%s before React mounts', (preference, dark, expected) => {
  if (preference) localStorage.setItem('circus-health-theme', preference);
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  document.head.appendChild(meta);
  const favicon = document.createElement('link');
  favicon.id = 'app-favicon';
  document.head.appendChild(favicon);
  try {
    new Function('matchMedia', 'localStorage', 'document', script!)(
      () => ({ matches: dark }),
      localStorage,
      document,
    );
    expect(document.documentElement.dataset.theme).toBe(expected);
    expect(document.documentElement.style.colorScheme).toBe(expected);
    expect(meta.content).toBe(expected === 'dark' ? '#191722' : '#fff8fb');
    expect(favicon.getAttribute('href')).toBe(`/favicon-${expected}.svg`);
  } finally {
    meta.remove();
    favicon.remove();
  }
});

it('uses device appearance before React mounts when storage is blocked', () => {
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  document.head.appendChild(meta);
  const favicon = document.createElement('link');
  favicon.id = 'app-favicon';
  document.head.appendChild(favicon);
  try {
    new Function('matchMedia', 'localStorage', 'document', script!)(
      () => ({ matches: false }),
      {
        getItem() {
          throw new Error('Storage blocked');
        },
      },
      document,
    );
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(favicon.getAttribute('href')).toBe('/favicon-light.svg');
  } finally {
    meta.remove();
    favicon.remove();
  }
});
