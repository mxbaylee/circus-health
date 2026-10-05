import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

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

function validateSourceMaps(directory: string, files: string[]) {
  for (const file of files.filter((name) => name.endsWith('.js.map'))) {
    const script = file.slice(0, -4);
    if (!files.includes(script)) throw new Error('Orphan checker source map.');
    const map = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    if (
      !map ||
      map.version !== 3 ||
      map.file !== basename(script) ||
      (map.sourceRoot !== undefined && map.sourceRoot !== '') ||
      typeof map.mappings !== 'string' ||
      !Array.isArray(map.sources) ||
      !Array.isArray(map.sourcesContent) ||
      map.sources.length !== map.sourcesContent.length ||
      !map.sourcesContent.every(
        (content: unknown) => content === null || typeof content === 'string',
      )
    )
      throw new Error('Invalid checker source map.');
    for (const source of map.sources) {
      if (typeof source !== 'string' || /^(?:\/|[A-Za-z]+:)/.test(source) || source.includes('\\'))
        throw new Error('Unexpected checker source-map path.');
      // The public source scope is the same as the actual bundle's module scope.
      // Leading parent segments are emitted relative to dist/assets, not user filesystem paths.
      assertCheckerModule(
        join('/checker-source', source.replace(/^(?:\.\.\/)+/, '')),
        '/checker-source',
      );
    }
    const code = readFileSync(join(directory, script), 'utf8');
    if (!code.includes(`//# sourceMappingURL=${basename(file)}`))
      throw new Error('Checker source map is not referenced by its script.');
  }
  for (const script of files.filter((name) => name.endsWith('.js'))) {
    const code = readFileSync(join(directory, script), 'utf8');
    if (code.includes('//# sourceMappingURL=') && !files.includes(`${script}.map`))
      throw new Error('Referenced checker source map is missing.');
  }
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
          !/^(?:index\.html|build-info\.json|assets\/[A-Za-z0-9_-]+\.(?:js|css)|assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.js\.map)$/.test(
            child,
          )
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
  validateSourceMaps(directory, files);
  return files.sort();
}
