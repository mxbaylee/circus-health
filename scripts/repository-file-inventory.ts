#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const outputArgument = outputIndex < 0 ? undefined : args[outputIndex + 1];
if (outputIndex >= 0 && (!outputArgument || outputArgument.startsWith('--')))
  throw new Error('--output requires a file path.');
if (
  args.some(
    (arg, index) =>
      !['--check', '--output'].includes(arg) && !(outputIndex >= 0 && index === outputIndex + 1),
  )
)
  throw new Error('Usage: repository-file-inventory.ts [--check] [--output path]');
const outputPath = outputArgument ? resolve(outputArgument) : undefined;
const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: repository,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)
  .sort((a, b) => a.localeCompare(b));

const categories = {
  'repository-control': 'Repository control and contributor configuration',
  'ci-automation': 'GitHub Actions automation',
  deployment: 'Deployment and operator launch files',
  documentation: 'Maintained product and engineering documentation',
  'work-tracking': 'Plans and work tracking',
  'audit-inventory': 'Inspected interface inventories',
  'historical-design': 'Historical proposals and rationale',
  'validation-record': 'Dated validation evidence',
  'design-reference': 'Design sources and reference assets',
  skill: 'Agent-facing skills and schemas',
  'frontend-runtime': 'Browser application runtime',
  'frontend-style': 'Browser styles and visual assets',
  'shared-contract': 'Cross-runtime contracts and resources',
  'server-runtime': 'Node server runtime',
  'runtime-instruction': 'Model/runtime instruction text',
  migration: 'SQLite migrations',
  'server-test': 'Server tests and fixtures',
  'browser-test': 'Encrypted browser journeys',
  'mounted-test': 'Mounted React tests and setup',
  'state-test': 'Pure/state tests',
  'build-tooling': 'Frontend build and contributor tooling',
  dependency: 'Node dependency manifests',
  'static-asset': 'Packaged static assets',
  inventory: 'Repository inventory tooling and generated output',
};

type Category = keyof typeof categories;
interface Classification {
  category: Category;
  role: string;
  purpose: string;
}
const exact: Record<string, Classification> = {
  'THIRD-PARTY-NOTICES.md': {
    category: 'documentation',
    role: 'dependency and artwork attribution',
    purpose: 'Preserves upstream attribution and distinguishes project and container licensing.',
  },
  'src/server/passkey-provider-names.json': {
    category: 'server-runtime',
    role: 'bundled lookup data',
    purpose: 'Pinned AAGUID-to-provider display names; no icons or runtime network lookup.',
  },
  '.github/workflows/code-checks.yml': {
    category: 'ci-automation',
    role: 'CI workflow',
    purpose:
      'Shallow current-tree checkout for formatting, types, build, deployment, and application tests.',
  },
  'docs/README.md': {
    category: 'documentation',
    role: 'documentation index',
    purpose: 'Indexes maintained product, operator and contributor references.',
  },
  'docs/todo/readme.md': {
    category: 'work-tracking',
    role: 'canonical work list',
    purpose: 'Tracks approved requirements, delivered work, and outstanding release checks.',
  },
  'docs/features/filter-inventory.md': {
    category: 'audit-inventory',
    role: 'maintained interface inventory',
    purpose: 'Accounts for routed collection filters and their current interaction contracts.',
  },
  'scripts/repository-file-inventory.ts': {
    category: 'inventory',
    role: 'inventory tool',
    purpose: 'Classifies every tracked file; optionally writes or checks an external inventory.',
  },
  'src/app/pages/Overview.tsx': {
    category: 'frontend-runtime',
    role: 'unrouted page',
    purpose: 'Retained overview implementation with no current route-tree import.',
  },
  'src/app/data/sample.ts': {
    category: 'frontend-runtime',
    role: 'unused sample data',
    purpose: 'Retained sample-data helper with no current application consumer.',
  },
  'src/server/query-worker.ts': {
    category: 'server-runtime',
    role: 'test-consumed worker',
    purpose: 'Bounded SQL worker used by server tests rather than the routed runtime.',
  },
  'src/server/test/native-provider-workflow.integration.test.ts': {
    category: 'server-test',
    role: 'obsolete opt-in integration test',
    purpose:
      'Retains an older native-provider workflow gated by `CRS_AI_NATIVE_WORKFLOW_TEST=1` that conflicts with current LiteLLM-only config.',
  },
  'src/server/test/archive-rebuild.integration.test.ts': {
    category: 'server-test',
    role: 'ordinary server integration test',
    purpose: 'Always-run source-only rebuild integration coverage using temporary fictional data.',
  },
  'src/server/test/launch.integration.test.ts': {
    category: 'server-test',
    role: 'opt-in Docker integration test',
    purpose: 'Runs the full launcher workflow only when `CRS_LAUNCH_TEST=1`.',
  },
  'src/server/test/model-providers.integration.test.ts': {
    category: 'server-test',
    role: 'opt-in live-provider test',
    purpose: 'Checks a configured live model only when `CRS_AI_LIVE_TEST=1`.',
  },
  'src/server/test/proxy-model-bridge.integration.test.ts': {
    category: 'server-test',
    role: 'opt-in Docker integration test',
    purpose: 'Checks the LiteLLM container bridge only when `CRS_LITELLM_INTEGRATION_TEST=1`.',
  },
  'src/server/assistant-instructions.md': {
    category: 'runtime-instruction',
    role: 'model instruction',
    purpose: 'Active assistant system instructions loaded by the server.',
  },
  'src/server/clinical-instructions.ts': {
    category: 'runtime-instruction',
    role: 'model instruction builder',
    purpose: 'Builds active clinical extraction and classification instructions.',
  },
  'src/app/data/clinical.ts': {
    category: 'shared-contract',
    role: 'cross-runtime helper',
    purpose: 'Clinical display transforms imported by both browser code and server exports.',
  },
  'src/app/data/format.ts': {
    category: 'shared-contract',
    role: 'cross-runtime helper',
    purpose: 'Formatting helpers imported by both browser code and server exports.',
  },
  'src/shared/person-icon-catalog.json': {
    category: 'shared-contract',
    role: 'runtime resource',
    purpose: 'Person-icon catalog with identifiers, categories, and provenance metadata.',
  },
  'src/public/favicon.svg': {
    category: 'static-asset',
    role: 'packaged browser asset',
    purpose: 'Circus Health favicon copied into the built client.',
  },
};

function words(path: string): string {
  const filename = path.split('/').at(-1) ?? path;
  const name = (filename.startsWith('.') ? filename.slice(1) : filename)
    .replace(/\.(integration\.)?test\.[^.]+$/, '')
    .replace(/\.[^.]+$/, '');
  return name.replaceAll('-', ' ').replaceAll('_', ' ');
}

function classify(path: string): Classification {
  if (exact[path]) return exact[path];
  if (path.startsWith('.husky/'))
    return {
      category: 'repository-control',
      role: 'versioned Husky hook',
      purpose: 'Runs the shared Gitmoji commitlint configuration for local commits.',
    };
  if (path.startsWith('.github/'))
    return {
      category: 'ci-automation',
      role: path.startsWith('.github/workflows/') ? 'CI workflow' : 'automation configuration',
      purpose: `${words(path)} GitHub automation configuration.`,
    };
  if (path === '.dockerignore' || path === '.gitattributes' || path === '.gitignore')
    return {
      category: 'repository-control',
      role: 'repository configuration',
      purpose: `Controls ${words(path)} behavior for the repository.`,
    };
  if (path === '.prettierignore' || path === '.prettierrc.json')
    return {
      category: 'repository-control',
      role: 'format configuration',
      purpose: 'Defines repository formatting scope or rules.',
    };
  if (
    ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE', 'prompt.txt'].includes(
      path,
    )
  )
    return {
      category: 'documentation',
      role: 'entry-point reference',
      purpose: 'Repository overview and supported startup entry point.',
    };
  if (path === 'src/README.md')
    return {
      category: 'documentation',
      role: 'implementation reference',
      purpose: 'Frontend/server workspace entry points, commands, and architecture map.',
    };
  if (['Dockerfile', 'compose.yaml'].includes(path))
    return {
      category: 'deployment',
      role: 'deployment entry point',
      purpose: `${words(path)} for the supported container launch path.`,
    };
  if (path.startsWith('deploy/'))
    return {
      category: 'deployment',
      role:
        path.includes('test_') || path.endsWith('.test.ts')
          ? 'deployment test'
          : path.endsWith('.yaml')
            ? 'operator example'
            : 'deployment runtime',
      purpose: `${words(path)} for launcher or LiteLLM deployment behavior.`,
    };
  if (path.startsWith('docs/todo/'))
    return {
      category: 'work-tracking',
      role: 'concise TODO',
      purpose:
        'Tracks open work with stable CRS identifiers, without implementation specifications.',
    };
  if (path.startsWith('docs/experiments/'))
    return {
      category: 'validation-record',
      role: 'historical experiment material',
      purpose: 'Retains research reports and study plans pending a separate retention review.',
    };
  if (path.startsWith('docs/validation/'))
    return {
      category: 'validation-record',
      role: 'validation evidence',
      purpose: `${words(path)} validation record or captured result.`,
    };
  if (path.startsWith('docs/design/'))
    return {
      category: 'design-reference',
      role: /\.(png|jpg|jpeg)$/.test(path)
        ? 'binary reference asset'
        : path.endsWith('.json')
          ? 'design metadata'
          : 'design reference',
      purpose: `${words(path)} design source, metadata, or provenance.`,
    };
  if (path.startsWith('docs/'))
    return {
      category: 'documentation',
      role: 'maintained reference',
      purpose: `${words(path)} product or engineering reference.`,
    };
  if (path.startsWith('skills/'))
    return {
      category: 'skill',
      role: path.endsWith('SKILL.md')
        ? 'skill instruction'
        : path.endsWith('.json')
          ? 'skill schema'
          : 'skill support file',
      purpose: `${words(path)} support for the repository-owned agent workflow.`,
    };
  if (path === 'package.json' || path === 'package-lock.json')
    return {
      category: 'dependency',
      role: 'Node manifest',
      purpose: path.endsWith('lock.json')
        ? 'Pinned Node dependency graph.'
        : 'Node scripts, package metadata, and direct dependencies.',
    };
  if (
    [
      'src/.gitignore',
      '.nvmrc',
      'tsconfig.json',
      'tsconfig.server.json',
      'tsconfig.tests.json',
      'tsconfig.tools.json',
      'vite.config.ts',
      'vite.passkey-checker.config.ts',
      'commitlint.config.ts',
      'vitest.config.ts',
    ].includes(path)
  )
    return {
      category: 'build-tooling',
      role: 'build configuration',
      purpose: `${words(path)} configuration for the frontend workspace.`,
    };
  if (path === 'src/index.html' || path === 'src/app/main.tsx')
    return {
      category: 'frontend-runtime',
      role: 'browser entry point',
      purpose: `${words(path)} browser bootstrap entry point.`,
    };
  if (path.startsWith('src/assets/'))
    return {
      category: 'design-reference',
      role: 'editable asset source',
      purpose: `${words(path)} source for generated runtime assets.`,
    };
  if (path.startsWith('src/public/'))
    return {
      category: 'static-asset',
      role: 'packaged browser asset',
      purpose: `${words(path)} copied into the built client.`,
    };
  if (path.startsWith('src/scripts/'))
    return {
      category: 'build-tooling',
      role: 'contributor tool',
      purpose: `${words(path)} build or verification utility.`,
    };
  if (path.startsWith('src/shared/'))
    return {
      category: 'shared-contract',
      role: path.endsWith('.json') ? 'runtime resource' : 'shared module',
      purpose: `${words(path)} contract or pure helper shared across application layers.`,
    };
  if (path.startsWith('src/app/') && /\.(css|svg)$/.test(path))
    return {
      category: 'frontend-style',
      role: path.endsWith('.svg') ? 'browser vector asset' : 'browser stylesheet',
      purpose: `${words(path)} visual styling or artwork.`,
    };
  if (path.startsWith('src/app/') && /\.test\.ts$/.test(path))
    return {
      category: 'state-test',
      role: 'colocated state test',
      purpose: `${words(path)} state or pure-helper coverage.`,
    };
  if (path.startsWith('src/app/') && path.endsWith('.md'))
    return {
      category: 'documentation',
      role: 'colocated feature reference',
      purpose: `${words(path)} feature contract and maintenance reference.`,
    };
  if (path.startsWith('src/app/'))
    return {
      category: 'frontend-runtime',
      role: path.endsWith('.d.ts') ? 'type declaration' : 'browser module',
      purpose: `${words(path)} frontend implementation.`,
    };
  if (path.startsWith('src/server/migrations/'))
    return {
      category: 'migration',
      role: 'ordered schema migration',
      purpose: `${words(path)} SQLite schema transition.`,
    };
  if (path.startsWith('src/server/test/'))
    return {
      category: 'server-test',
      role:
        path.includes('/helpers/') || path.includes('fixture')
          ? 'server fixture'
          : path.includes('.integration.')
            ? 'opt-in integration test'
            : 'server test',
      purpose: `${words(path)} server coverage or fixture.`,
    };
  if (path.startsWith('src/server/') && path.endsWith('.md'))
    return {
      category: 'documentation',
      role: 'server reference',
      purpose: `${words(path)} server contract or implementation reference.`,
    };
  if (path.startsWith('src/server/'))
    return {
      category: 'server-runtime',
      role: 'server module',
      purpose: `${words(path)} server implementation.`,
    };
  if (path.startsWith('src/tests/browser/'))
    return {
      category: 'browser-test',
      role: 'encrypted browser test',
      purpose: `${words(path)} end-to-end browser coverage with fictional data.`,
    };
  if (path.startsWith('src/tests/mounted/'))
    return {
      category: 'mounted-test',
      role: path.endsWith('README.md')
        ? 'test reference'
        : path.endsWith('setup.ts')
          ? 'test setup'
          : 'mounted UI test',
      purpose: `${words(path)} mounted-interface coverage or support.`,
    };
  if (path.startsWith('src/tests/'))
    return {
      category: 'state-test',
      role: 'state/unit test',
      purpose: `${words(path)} pure transformation or render-state coverage.`,
    };
  throw new Error(`Unclassified tracked path: ${path}`);
}

const rows = tracked.map((path) => ({ path, ...classify(path) }));
const rowPaths = rows.map((row) => row.path);
const duplicates = rowPaths.filter((path, index) => rowPaths.indexOf(path) !== index);
const missing = tracked.filter((path) => !rowPaths.includes(path));
const extra = rowPaths.filter((path) => !tracked.includes(path));
const unclassified = rows.filter((row) => !row.category || !categories[row.category]);
if (duplicates.length || missing.length || extra.length || unclassified.length)
  throw new Error('Inventory contains duplicate, missing, extra, or unclassified paths.');

const counts: Record<string, number> = Object.fromEntries(
  Object.keys(categories).map((category) => [category, 0]),
);
for (const row of rows) counts[row.category] += 1;
const lines = [
  '# Repository file inventory',
  '',
  '<!-- Generated by scripts/repository-file-inventory.ts. Do not edit by hand. -->',
  '',
  `This appendix accounts for all **${tracked.length}** paths returned by \`git ls-files -z\`. Each path appears exactly once. Categories describe ownership; the role and purpose columns distinguish runtime, build, test, documentation, configuration, resource, and historical-evidence files.`,
  '',
  'Generate with `node scripts/repository-file-inventory.ts --output /outside/repo/inventory.md`. Use `--check` alone to validate tracked-path classification, or combine both flags to check a saved inventory.',
  '',
  '## Category totals',
  '',
  '| Category | Files |',
  '| --- | ---: |',
  ...Object.entries(categories).map(([key, label]) => `| ${label} | ${counts[key]} |`),
  `| **Total** | **${tracked.length}** |`,
  '',
  '## Tracked paths',
  '',
  '| Path | Category | Role | Purpose |',
  '| --- | --- | --- | --- |',
  ...rows.map(
    (row) => `| \`${row.path}\` | ${categories[row.category]} | ${row.role} | ${row.purpose} |`,
  ),
  '',
].join('\n');

if (args.includes('--check')) {
  if (outputPath && readFileSync(outputPath, 'utf8') !== lines) {
    console.error('Saved inventory is stale; regenerate it.');
    process.exitCode = 1;
  } else console.log(`tracked=${tracked.length} classified=${rows.length} missing=0 duplicates=0`);
} else if (outputPath) {
  writeFileSync(outputPath, lines);
  console.log(`tracked=${tracked.length} classified=${rows.length} missing=0 duplicates=0`);
} else process.stdout.write(lines);
