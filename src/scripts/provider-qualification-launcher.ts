/** Qualification-only child launcher: keep the normal npm/Compose/LiteLLM path
 * and its preflight, image build, signal handling and cleanup. */
import { constants } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cancelled, Docker, main, outsideGit, ROOT } from '../../deploy/run.ts';

export function appendQualificationComposeOverride(args: string[], override: string) {
  if (args[0] !== 'compose') return args;
  const index = args.indexOf('-f');
  if (index < 0 || args[index + 1] !== join(ROOT, 'compose.yaml'))
    throw Error('Qualification requires the supported Compose file.');
  return [...args.slice(0, index + 2), '-f', override, ...args.slice(index + 2)];
}
export async function runQualificationLauncher(
  env: NodeJS.ProcessEnv,
  createDocker = () => new Docker(env.CRS_DOCKER || 'docker'),
) {
  const override = env.CRS_QUALIFICATION_REQUEST_OVERRIDE;
  if (!override || !isAbsolute(override))
    throw Error('Qualification request override is required.');
  outsideGit(override);
  return main('run', env, () => {
    const docker = createDocker();
    const run = docker.run.bind(docker);
    docker.run = (args, options) =>
      run(appendQualificationComposeOverride(args, override), options);
    return docker;
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await runQualificationLauncher({ ...process.env }).catch((error: unknown) => {
    if (error instanceof Cancelled) process.exitCode = 128 + constants.signals[error.signal];
    else {
      // Never disclose operator configuration or provider content.
      process.stderr.write('Qualification launcher failed; inspect the protected attempt.\n');
      process.exitCode = 1;
    }
  });
