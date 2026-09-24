import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

export function noteUrl(value: string) {
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value)) return undefined;
  if (/^#\//.test(value)) value = value.slice(1);
  if (
    /^\/(?:\?|$|tests(?:\?|$)|medications(?:\?|$)|procedures(?:\?|$)|notes(?:\?|$)|people(?:\?|$)|sources(?:\?|$))/.test(
      value,
    )
  )
    return `#${value}`;
  try {
    const url = new URL(value);
    if (['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password)
      return value;
  } catch {
    /* Preserve unsafe URLs in the source, not as active links. */
  }
  return undefined;
}
export const richExtensions = () => [
  StarterKit.configure({
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    underline: false,
    trailingNode: false,
    link: {
      openOnClick: false,
      autolink: false,
      linkOnPaste: false,
      isAllowedUri: (value) => Boolean(noteUrl(value)),
    },
  }),
];
const manager = new MarkdownManager({ extensions: richExtensions() });
const parser = unified().use(remarkParse).use(remarkGfm);
const supported = new Set([
  'root',
  'paragraph',
  'text',
  'heading',
  'strong',
  'emphasis',
  'link',
  'list',
  'listItem',
  'blockquote',
  'break',
  'thematicBreak',
  'inlineCode',
  'code',
]);
type Tree = {
  type: string;
  children?: Tree[];
  value?: string;
  url?: string;
  [key: string]: unknown;
};
function semantics(tree: Tree): unknown {
  const { position: _position, spread: _spread, ...node } = tree;
  // CommonMark soft line endings render as spaces. Hard breaks have their own node.
  if (node.type === 'text') node.value = node.value?.replace(/\r?\n/g, ' ');
  if (node.type === 'code') {
    node.lang ||= null;
    node.meta ||= null;
  }
  if (node.children) node.children = node.children.map(semantics) as Tree[];
  return node;
}
function hasUnsupported(tree: Tree): boolean {
  return (
    !supported.has(tree.type) ||
    (tree.type === 'link' && !noteUrl(tree.url || '')) ||
    (tree.type === 'listItem' && tree.checked != null) ||
    Boolean(tree.children?.some(hasUnsupported))
  );
}
export function inspectMarkdown(value: string) {
  try {
    const tree = parser.parse(value) as Tree;
    if (hasUnsupported(tree)) return { supported: false as const };
    const doc = manager.parse(value),
      serialized = manager.serialize(doc);
    // Whitelist plus independent CommonMark tree comparison prevents the rich
    // editor from silently dropping information it cannot represent.
    if (
      JSON.stringify(semantics(tree)) !==
      JSON.stringify(semantics(parser.parse(serialized) as Tree))
    )
      return { supported: false as const };
    return { supported: true as const, doc };
  } catch {
    return { supported: false as const };
  }
}
export function literalToMarkdown(value: string) {
  // Protect literal entity spellings and indentation before Markdown parsing.
  // Escaped punctuation alone is insufficient: &lt; would decode and four
  // leading spaces would become an indented code block.
  return value
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/&/g, '&amp;')
        .replace(/[\\`*{}\[\]()#+.!_<>~|=\-]/g, '\\$&')
        .replace(/^[ \t]+|[ \t]+$/g, (spaces) =>
          [...spaces].map((char) => (char === '\t' ? '&#9;' : '&#32;')).join(''),
        ),
    )
    .join('  \n');
}
