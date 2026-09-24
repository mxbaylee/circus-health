/** Generate brand assets with the pinned container toolchain. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, Docker } from './run.ts';

export function imageTag(): string {
  const digest = createHash('sha256');
  for (const path of [
    'Dockerfile',
    '.prettierrc.json',
    'package-lock.json',
    'src/scripts/generate-brand-assets.ts',
    'src/scripts/brand-raster.ts',
  ])
    digest.update(readFileSync(join(ROOT, path)));
  return `circus-health-brand-tools:${digest.digest('hex').slice(0, 12)}`;
}
export function dockerCommands(check = false): string[][] {
  const tag = imageTag();
  const run = [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,mode=1777',
    '--user',
    `${process.getuid!()}:${process.getgid!()}`,
    '--volume',
    `${ROOT}/src/assets:/app/src/assets:ro`,
    '--volume',
    `${ROOT}/src/app/tokens.css:/app/src/app/tokens.css:ro`,
    '--volume',
    `${ROOT}/src/app/components:/app/src/app/components:rw`,
    '--volume',
    `${ROOT}/src/public:/app/src/public:rw`,
    tag,
  ];
  if (check) run.push('--check');
  return [['build', '--target', 'brand-tools', '--tag', tag, ROOT], run];
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.some((arg) => arg !== '--check')) throw new Error('Usage: npm run icons -- [--check]');
  const docker = new Docker();
  try {
    for (const command of dockerCommands(args.includes('--check'))) await docker.run(command);
  } finally {
    docker.dispose();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(
      `Circus Health icons: ${error instanceof Error ? error.message : 'generation failed'}`,
    );
    process.exitCode = 1;
  });
