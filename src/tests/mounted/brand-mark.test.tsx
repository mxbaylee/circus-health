import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BrandMark } from '../../app/components/BrandMark.generated';

const tagline = 'Your circus, your monkeys, all under one tent.';

it('provides an accessible default name and the canonical centered geometry', () => {
  const { container } = render(<BrandMark className="test-mark" />);
  const mark = screen.getByRole('img', { name: tagline });
  expect(mark).toHaveAttribute('viewBox', '-2 0 64 64');
  expect(mark).toHaveClass('test-mark');
  expect(container.querySelectorAll('path')).toHaveLength(10);
});

it('removes image semantics and supplied labels when decorative', () => {
  const { container } = render(<BrandMark decorative aria-label="Ignored label" />);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  expect(container.querySelector('svg')).not.toHaveAttribute('aria-label');
  expect(container.querySelector('title')).toBeNull();
});
