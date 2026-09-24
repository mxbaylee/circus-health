import { useState } from 'react';
import { MemoryRouter, createMemoryRouter, RouterProvider, useBlocker } from 'react-router-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteText, NoteTextPreview } from '../../app/features/notes/NoteText';
import { inspectMarkdown, literalToMarkdown } from '../../app/features/notes/markdown-model';
import type { NoteTextFormat } from '../../shared/api';

function Fixture({
  initial = '# Heading\n\nSome **bold** words.',
  initialFormat = 'markdown-v1' as NoteTextFormat,
  changed = vi.fn(),
}) {
  const [value, setValue] = useState(initial),
    [format, setFormat] = useState(initialFormat);
  return (
    <>
      <NoteText
        label="Content"
        value={value}
        format={format}
        onChange={(next, nextFormat) => {
          setValue(next);
          setFormat(nextFormat);
          changed(next, nextFormat);
        }}
      />
      <output data-testid="saved">{value}</output>
    </>
  );
}
beforeEach(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
describe('formatted note content', () => {
  it('accepts supported structures and refuses unsupported or lossy rich conversions', () => {
    for (const value of [
      '',
      'Hello 🌙',
      '# Heading\n\nSome **bold** and *italic* words.',
      '### Small\n\n- One\n- Two\n\n> Quoted',
      '[Visit](/notes?id=example)',
      '1. One\n2. Two',
    ])
      expect(inspectMarkdown(value).supported, value).toBe(true);
    for (const value of [
      '![Photo](https://example.test/photo.jpg)',
      '<script>alert(1)</script>',
      '| A | B |\n|---|---|\n|1|2|',
      '- [ ] Task',
      '[bad](javascript:alert)',
    ])
      expect(inspectMarkdown(value).supported, value).toBe(false);
  });
  it('switches tabs without rewriting or notifying autosave, including exact source spacing', async () => {
    const changed = vi.fn(),
      user = userEvent.setup(),
      original = '# Heading\n\nSome **bold** words.\n\n';
    render(<Fixture initial={original} changed={changed} />);
    expect(screen.getByRole('textbox', { name: 'Content' })).toHaveAttribute(
      'contenteditable',
      'true',
    );
    await user.click(screen.getByRole('tab', { name: 'Markdown' }));
    expect(screen.getByRole('textbox', { name: 'Content Markdown' })).toHaveValue(original);
    await user.click(screen.getByRole('tab', { name: 'Formatted' }));
    expect(changed).not.toHaveBeenCalled();
  });
  it('renders unmarked personal Markdown as an editable heading and list without rewriting it', async () => {
    const changed = vi.fn(),
      user = userEvent.setup(),
      value = '# My heading\n\n- First item\n- Second item';
    render(<NoteText label="Content" value={value} onChange={changed} />);
    expect(screen.getByRole('heading', { name: 'My heading' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('textbox', { name: 'Content' })).toHaveAttribute(
      'contenteditable',
      'true',
    );
    await user.click(screen.getByRole('tab', { name: 'Markdown' }));
    expect(screen.getByRole('textbox', { name: 'Content Markdown' })).toHaveValue(value);
    await user.click(screen.getByRole('tab', { name: 'Formatted' }));
    expect(changed).not.toHaveBeenCalled();
  });
  it('edits source and rich headings with one canonical body', async () => {
    const user = userEvent.setup();
    render(<Fixture initial="Hello 🌙" />);
    await user.click(screen.getByRole('button', { name: 'H3' }));
    await user.click(screen.getByRole('tab', { name: 'Markdown' }));
    expect(screen.getByRole('textbox', { name: 'Content Markdown' })).toHaveValue('### Hello 🌙');
    fireEvent.change(screen.getByRole('textbox', { name: 'Content Markdown' }), {
      target: { value: '## Updated\n\n**Strong**' },
    });
    await user.click(screen.getByRole('tab', { name: 'Formatted' }));
    expect(screen.getByRole('heading', { name: 'Updated', level: 2 })).toBeInTheDocument();
    expect(screen.getByTestId('saved')).toHaveTextContent('## Updated **Strong**');
  });
  it('converts entity spellings and indented plaintext without changing their visible meaning', () => {
    for (const original of ['Literal &lt;tag&gt;', 'A &copy; B', '    Indented literal']) {
      const { container, unmount } = render(
        <NoteTextPreview value={literalToMarkdown(original)} format="markdown-v1" />,
      );
      expect(container.textContent).toBe(original);
      expect(container.querySelector('pre,code')).toBeNull();
      unmount();
    }
  });
  it('preserves legacy plaintext until explicit reversible conversion', async () => {
    const original = '# Literal *asterisks* <tag>\nNext line',
      changed = vi.fn(),
      user = userEvent.setup();
    render(<Fixture initial={original} initialFormat="plain-v1" changed={changed} />);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Markdown' }));
    expect(changed).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Enable formatting' }));
    expect(changed).toHaveBeenLastCalledWith(literalToMarkdown(original), 'markdown-v1');
    await user.click(screen.getByRole('tab', { name: 'Formatted' }));
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
  it('retains unsupported source and shows safe previews without image fetches or executable markup', async () => {
    const original =
      '![Mole](https://example.test/mole.jpg)\n\n<script>alert(1)</script>\n\n[Bad](javascript:alert)\n\n[Lab](/tests?result=abc)';
    const changed = vi.fn(),
      user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <Fixture initial={original} changed={changed} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/cannot safely round-trip/)).toBeInTheDocument();
    expect(container.querySelector('img,script')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Bad' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Lab' })).toHaveAttribute('href', '/tests?result=abc');
    await user.click(screen.getByRole('tab', { name: 'Markdown' }));
    expect(screen.getByRole('textbox', { name: 'Content Markdown' })).toHaveValue(original);
    expect(changed).not.toHaveBeenCalled();
  });
  it('app links use the router and respect unsaved-navigation blocking', async () => {
    function BlockedPreview() {
      const blocker = useBlocker(true);
      return (
        <>
          <NoteTextPreview value="[Linked note](/notes?id=other)" format="markdown-v1" />
          <p>{blocker.state === 'blocked' ? 'Unsaved navigation blocked' : 'Editing'}</p>
        </>
      );
    }
    const router = createMemoryRouter([{ path: '*', element: <BlockedPreview /> }], {
      initialEntries: ['/notes?id=current'],
    });
    render(<RouterProvider router={router} />);
    await userEvent.setup().click(screen.getByRole('link', { name: 'Linked note' }));
    expect(screen.getByText('Unsaved navigation blocked')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?id=current');
  });
  it('finished and provider views keep both tabs read-only and provider punctuation literal', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <NoteText label="Content" value="# Finished" format="markdown-v1" readOnly />,
    );
    expect(screen.getByRole('heading', { name: 'Finished' })).toBeInTheDocument();
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Markdown' }));
    expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
    rerender(<NoteText label="Content" value="# Provider wording" format="plain-v1" readOnly />);
    await user.click(screen.getByRole('tab', { name: 'Formatted' }));
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByText('# Provider wording')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable formatting' })).not.toBeInTheDocument();
  });
});
