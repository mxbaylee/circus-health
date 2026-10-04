import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export function assertCheckerModule(id: string, repository: string): void {
  if (id.startsWith('\0')) return;
  const path = relative(repository, id.split('?')[0]!).replaceAll('\\', '/');
  if (
    path.startsWith('src/app/passkey-checker/') ||
    path === 'src/app/components/passkey-prf.ts' ||
    path === 'src/app/tokens.css' ||
    /^src\/app\/assets\/harlequin-(?:dark|light)\.svg$/.test(path) ||
    /^node_modules\/(react|react-dom|scheduler)\//.test(path)
  )
    return;
  throw new Error(`Checker includes an unexpected module: ${path}`);
}

export function validateCheckerFiles(directory: string, expectedRevision?: string): string[] {
  const files: string[] = [];
  const visit = (path: string) => {
    for (const name of readdirSync(join(directory, path))) {
      const child = path ? `${path}/${name}` : name;
      const stat = lstatSync(join(directory, child));
      if (stat.isSymbolicLink()) throw new Error('Checker publication refuses symlinks.');
      if (stat.isDirectory()) {
        if (child !== 'assets') throw new Error('Unexpected checker directory.');
        visit(child);
      } else {
        if (
          !stat.isFile() ||
          !/^(?:index\.html|build-info\.json|assets\/[A-Za-z0-9_-]+\.(?:js|css))$/.test(child)
        ) {
          throw new Error('Unexpected checker publication file.');
        }
        files.push(child);
      }
    }
  };
  visit('');
  if (
    !files.includes('index.html') ||
    !files.includes('build-info.json') ||
    !files.some((file) => file.endsWith('.js'))
  ) {
    throw new Error('Incomplete checker build.');
  }
  const build: unknown = JSON.parse(readFileSync(join(directory, 'build-info.json'), 'utf8'));
  if (!build || typeof build !== 'object') throw new Error('Invalid checker provenance.');
  const info = build as Record<string, unknown>;
  if (
    Object.keys(info).sort().join(',') !== 'revision,version,worktree' ||
    info.version !== '3' ||
    !(
      info.revision === 'unknown' ||
      (typeof info.revision === 'string' && /^[a-f0-9]{40}$/.test(info.revision))
    ) ||
    !['clean', 'dirty', 'unknown'].includes(String(info.worktree))
  )
    throw new Error('Invalid checker provenance.');
  if (expectedRevision && (info.revision !== expectedRevision || info.worktree !== 'clean')) {
    throw new Error('Publication requires the exact clean reviewed revision.');
  }
  const html = readFileSync(join(directory, 'index.html'), 'utf8');
  if (
    !html.includes("connect-src 'none'") ||
    !html.includes("script-src 'self'") ||
    !html.includes("style-src 'self'")
  ) {
    throw new Error('Missing checker content security policy.');
  }
  return files.sort();
}
