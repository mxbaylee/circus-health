/** Child-only integration fixture. It uses the real encrypted HTTP app and the
 * same environment-created diagnostic sink as the runtime, never a paid route. */
import { createVaultApp } from '../server/vault-app.ts';
import { importDiagnostics } from '../server/import-diagnostics.ts';

const dataDirectory = process.env.CRS_DATA_DIR;
const runtimeDirectory = process.env.CRS_RUNTIME_DIR;
if (!dataDirectory || !runtimeDirectory || !process.send)
  throw Error('The fictional HTTP trace fixture requires isolated directories and IPC.');
const proxy = new URL(process.env.CRS_AI_BASE_URL || '');
if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1')
  throw Error('The fictional HTTP trace fixture permits only a loopback upstream.');
const app = createVaultApp({ dataDirectory, runtimeDirectory, diagnostics: importDiagnostics });
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  try {
    app.close();
  } finally {
    importDiagnostics.close();
    if (process.connected) process.disconnect();
  }
}
process.on('message', (message) => {
  if (message === 'stop') close();
});
process.once('disconnect', close);
process.once('SIGTERM', close);
app.server.listen(0, '127.0.0.1', () => {
  const address = app.server.address();
  if (!address || typeof address !== 'object') throw Error('Fictional HTTP fixture did not bind.');
  process.send!({ type: 'ready', port: address.port });
});
