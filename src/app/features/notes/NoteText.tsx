import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { Markdown } from '@tiptap/markdown';
import ReactMarkdown from 'react-markdown';
import { Link } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import type { NoteTextFormat } from '../../../shared/api';
import { inspectMarkdown, literalToMarkdown, noteUrl, richExtensions } from './markdown-model';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import './note-text.css';

type Props = {
  label: string;
  value: string;
  format?: NoteTextFormat;
  onChange?: (value: string, format: NoteTextFormat) => void;
  readOnly?: boolean;
  disabled?: boolean;
  placeholder?: string;
};
export function NoteText({
  label,
  value,
  format = 'markdown-v1',
  onChange,
  readOnly = false,
  disabled = false,
  placeholder,
}: Props) {
  const [mode, setMode] = useState<'formatted' | 'source'>('formatted');
  const id = useId();
  const inspected = useMemo(
    () => (format === 'markdown-v1' ? inspectMarkdown(value) : null),
    [format, value],
  );
  const editable = !readOnly && Boolean(onChange);
  return (
    <section className="note-text-field" aria-label={label}>
      <div className="note-text-heading">
        <span id={`${id}-label`}>{label}</span>
        <div className="note-text-tabs" role="tablist" aria-label={`${label} presentation`}>
          {(['formatted', 'source'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`${id}-${tab}`}
              aria-controls={`${id}-panel`}
              aria-selected={mode === tab}
              tabIndex={mode === tab ? 0 : -1}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next =
                  event.key === 'Home'
                    ? 'formatted'
                    : event.key === 'End'
                      ? 'source'
                      : mode === 'formatted'
                        ? 'source'
                        : 'formatted';
                setMode(next);
                document.getElementById(`${id}-${next}`)?.focus();
              }}
              onClick={() => setMode(tab)}
            >
              {tab === 'formatted' ? 'Formatted' : 'Markdown'}
            </button>
          ))}
        </div>
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${mode}`}>
        {format === 'plain-v1' && (
          <p className="helper-text">
            Saved as literal text.
            {editable && (
              <>
                {' '}
                <button
                  type="button"
                  className="text-link"
                  disabled={disabled}
                  onClick={() => onChange?.(literalToMarkdown(value), 'markdown-v1')}
                >
                  Enable formatting
                </button>{' '}
                — keeps the current words and saves an editable Markdown version. The previous text
                stays in saved history.
              </>
            )}
          </p>
        )}
        {mode === 'source' || (editable && format === 'plain-v1') ? (
          <textarea
            aria-label={mode === 'source' ? `${label} Markdown` : label}
            className={`note-text-source ${mode === 'source' ? 'source-mode' : ''}`}
            value={value}
            readOnly={!editable}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(event) => onChange?.(event.target.value, format)}
          />
        ) : editable && inspected?.supported ? (
          <RichText
            label={label}
            value={value}
            doc={inspected.doc}
            disabled={disabled}
            onChange={(next) => onChange?.(next, 'markdown-v1')}
          />
        ) : (
          <>
            {editable && format === 'markdown-v1' && (
              <p className="note-text-warning">
                This content includes formatting that the visual editor cannot safely round-trip.
                Its source is preserved; use Markdown to edit it.
              </p>
            )}
            <NoteTextPreview value={value} format={format} />
          </>
        )}
      </div>
    </section>
  );
}
export function NoteTextPreview({
  value,
  format = 'plain-v1',
}: {
  value: string;
  format?: NoteTextFormat;
}) {
  return format === 'plain-v1' ? (
    <div className="note-reading note-text-preview">{value || 'No content.'}</div>
  ) : (
    <div className="note-text-preview note-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) => (key === 'href' ? noteUrl(url) || '' : '')}
        components={{
          a: ({ href, children }) =>
            href?.startsWith('#/') ? (
              <Link to={href.slice(1)}>{children}</Link>
            ) : href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => (
            <span className="note-image-reference">
              [Image reference{alt ? `: ${alt}` : ''}; open its attachment separately]
            </span>
          ),
          table: ({ children }) => (
            <div className="note-table-scroll">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {value || 'No content.'}
      </ReactMarkdown>
    </div>
  );
}
function RichText({
  label,
  value,
  doc,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  doc: NonNullable<ReturnType<typeof inspectMarkdown>['doc']>;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const callback = useRef(onChange);
  callback.current = onChange;
  const lastValue = useRef(value);
  const [linkOpen, setLinkOpen] = useState(false),
    [link, setLink] = useState(''),
    [linkError, setLinkError] = useState('');
  const [, refresh] = useState(0);
  const editor = useEditor({
    extensions: [...richExtensions(), Markdown],
    content: doc,
    editable: !disabled,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': label,
        'aria-multiline': 'true',
        class: 'note-rich-body note-markdown',
      },
      // Pasting never imports executable HTML, remote images, or silently
      // discarded unsupported nodes. Rich formatting can be added with controls.
      handlePaste(view, event) {
        const text = event.clipboardData?.getData('text/plain');
        if (text == null) return true;
        event.preventDefault();
        const nodes = text
          .split(/\r?\n/)
          .map((line) =>
            view.state.schema.nodes.paragraph.create(
              null,
              line ? view.state.schema.text(line) : null,
            ),
          );
        const content = view.state.schema.nodes.doc.create(null, nodes);
        const slice = content.slice(0, content.content.size);
        view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
        return true;
      },
      handleDrop: () => true,
    },
    onUpdate({ editor, transaction }) {
      if (!transaction.docChanged) return;
      const next = editor.getMarkdown();
      if (next === lastValue.current) return;
      lastValue.current = next;
      callback.current(next);
    },
    onSelectionUpdate() {
      refresh((count) => count + 1);
    },
  });
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);
  useEffect(() => {
    if (!editor || value === lastValue.current) return;
    lastValue.current = value;
    editor.commands.setContent(doc, { emitUpdate: false });
  }, [editor, value, doc]);
  if (!editor) return <LoadingIndicator label="Opening editor…" layout="panel" />;
  const action = (title: string, run: () => void, active = false) => (
    <button
      type="button"
      aria-label={title}
      title={title}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={run}
    >
      {title}
    </button>
  );
  return (
    <div className="note-rich-editor">
      <div className="note-rich-toolbar" role="toolbar" aria-label={`${label} formatting`}>
        {action(
          'Paragraph',
          () => {
            editor.chain().focus().setParagraph().run();
          },
          editor.isActive('paragraph'),
        )}
        {([1, 2, 3] as const).map((level) => (
          <span key={level}>
            {action(
              `H${level}`,
              () => {
                editor.chain().focus().toggleHeading({ level }).run();
              },
              editor.isActive('heading', { level }),
            )}
          </span>
        ))}
        {action(
          'Bold',
          () => {
            editor.chain().focus().toggleBold().run();
          },
          editor.isActive('bold'),
        )}
        {action(
          'Italic',
          () => {
            editor.chain().focus().toggleItalic().run();
          },
          editor.isActive('italic'),
        )}
        {action(
          'Bullets',
          () => {
            editor.chain().focus().toggleBulletList().run();
          },
          editor.isActive('bulletList'),
        )}
        {action(
          'Numbered list',
          () => {
            editor.chain().focus().toggleOrderedList().run();
          },
          editor.isActive('orderedList'),
        )}
        {action(
          'Quote',
          () => {
            editor.chain().focus().toggleBlockquote().run();
          },
          editor.isActive('blockquote'),
        )}
        {action(
          'Link',
          () => {
            setLink(editor.getAttributes('link').href || '');
            setLinkError('');
            setLinkOpen(true);
          },
          editor.isActive('link'),
        )}
        {action('Undo', () => {
          editor.chain().focus().undo().run();
        })}
        {action('Redo', () => {
          editor.chain().focus().redo().run();
        })}
      </div>
      {linkOpen && (
        <div className="note-link-edit">
          <label>
            Link address
            <input
              autoFocus
              value={link}
              disabled={disabled}
              onChange={(event) => setLink(event.target.value)}
              placeholder="https://… or /notes?id=…"
            />
          </label>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (!noteUrl(link.trim())) {
                setLinkError('Use a web, email, or app page address.');
                return;
              }
              editor.chain().focus().extendMarkRange('link').setLink({ href: link.trim() }).run();
              setLinkOpen(false);
            }}
          >
            Apply link
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              editor.chain().focus().extendMarkRange('link').unsetLink().run();
              setLinkOpen(false);
            }}
          >
            Remove link
          </button>
          <button type="button" onClick={() => setLinkOpen(false)}>
            Cancel
          </button>
          {linkError && <p role="alert">{linkError}</p>}
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
