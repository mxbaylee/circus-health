import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';

const appPaths = new Set([
  '/',
  '/tests',
  '/medications',
  '/procedures',
  '/notes',
  '/people',
  '/sources',
  '/import',
]);
export function assistantLink(value: string): { href: string; external: boolean } | null {
  if (!value || /[\u0000-\u0020\\]/.test(value)) return null;
  const route = value.startsWith('/#/')
    ? value.slice(2)
    : value.startsWith('#/')
      ? value.slice(1)
      : value;
  if (route.startsWith('/') && !route.startsWith('//')) {
    const url = new URL(route, 'https://health.invalid');
    return appPaths.has(url.pathname)
      ? { href: `${url.pathname}${url.search}${url.hash}`, external: false }
      : null;
  }
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? { href: url.href, external: true }
      : null;
  } catch {
    return null;
  }
}

/** Markdown is rendered as React elements; source HTML stays literal and images never auto-load. */
export function AssistantText({
  content,
  onNavigate,
}: {
  content: string;
  onNavigate?: () => void;
}) {
  return (
    <div className="assistant-text">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) => (key === 'href' && assistantLink(url) ? url : '')}
        components={{
          a: ({ href, children }) => {
            const target = assistantLink(href || '');
            return target ? (
              target.external ? (
                <a href={target.href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ) : (
                <Link to={target.href} onClick={onNavigate}>
                  {children}
                </Link>
              )
            ) : (
              <span>{children}</span>
            );
          },
          img: ({ alt }) => (
            <span className="assistant-image-description">
              {alt ? `[Image: ${alt}]` : '[Image]'}
            </span>
          ),
          table: ({ children }) => (
            <div
              className="assistant-table-scroll"
              role="region"
              aria-label="Response table"
              tabIndex={0}
            >
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
