import { openSync, closeSync } from 'node:fs';
import { flockExclusiveNonblocking } from '../shared/flock.ts';

// Keep the kernel lease in a supervised child process. Closing stdin or losing
// the parent releases it; killing this holder is observable by the runtime.
const descriptor = openSync(process.argv[2]!, 'a+', 0o600);
try {
  if (!flockExclusiveNonblocking(descriptor)) {
    closeSync(descriptor);
    process.exit(73);
  }
} catch {
  closeSync(descriptor);
  process.exit(1);
}
process.stdout.write('locked\n');
process.stdin.resume();
process.stdin.once('end', () => {
  closeSync(descriptor);
});
