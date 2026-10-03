import { createRoot } from 'react-dom/client';
import App from './App';
import { BUILD_INFO } from './build';
import { createCheckerController } from './controller';
import '../tokens.css';
import './checker.css';

const root = createRoot(document.getElementById('root')!);
root.render(
  <main className="checker">
    <h1>Check your passkeys</h1>
    <p role="status">Opening browser-local progress…</p>
  </main>,
);
void createCheckerController({ build: BUILD_INFO })
  .then((controller) => {
    root.render(<App controller={controller} />);
  })
  .catch(() => {
    root.render(
      <main className="checker">
        <h1>Check your passkeys</h1>
        <p role="alert">
          The checker could not start in this browser. No passkey operation was started.
        </p>
        <p>
          Reload to try again. Your existing browser-local progress has not been deliberately
          cleared.
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload checker
        </button>
      </main>,
    );
  });
