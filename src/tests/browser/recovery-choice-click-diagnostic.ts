import type { Page, Request } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';

type ProfileRequest = {
  route: 'profiles' | 'setup-verify';
  method: string;
  startedAt: number;
  status?: number;
  durationMs?: number;
  failed?: boolean;
};

export function observeRecoveryChoiceClick(page: Page) {
  const requests: ProfileRequest[] = [];
  const tracked = new WeakMap<Request, ProfileRequest>();
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    const route =
      path === '/api/profiles'
        ? 'profiles'
        : /^\/api\/profile-setups\/[^/]+\/verify$/.test(path)
          ? 'setup-verify'
          : undefined;
    if (!route) return;
    const entry: ProfileRequest = { route, method: request.method(), startedAt: Date.now() };
    requests.push(entry);
    if (requests.length > 12) requests.shift();
    tracked.set(request, entry);
  });
  page.on('response', (response) => {
    const entry = tracked.get(response.request());
    if (!entry) return;
    entry.status = response.status();
    entry.durationMs = Date.now() - entry.startedAt;
  });
  page.on('requestfailed', (request) => {
    const entry = tracked.get(request);
    if (!entry) return;
    entry.failed = true;
    entry.durationMs = Date.now() - entry.startedAt;
  });

  return async (buttonName: 'Add passkey' | 'Skip') => {
    const recentRequests = requests.map(
      ({ route, method, status, durationMs, failed, startedAt }) => ({
        route,
        method,
        status: status ?? null,
        outcome: failed ? 'failed' : status === undefined ? 'pending' : 'response',
        durationMs: durationMs ?? Date.now() - startedAt,
      }),
    );
    const state = await Promise.race([
      page
        .evaluate(async (expectedButton) => {
          const sample = () => {
            const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
            const findDialog = (title: string) =>
              dialogs.find((candidate) => {
                const titleId = candidate.getAttribute('aria-labelledby');
                return titleId && document.getElementById(titleId)?.textContent === title;
              });
            const dialog = findDialog('Recovery unlocked');
            const verification = findDialog('Open profile');
            const button = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
              (candidate) => candidate.textContent?.trim() === expectedButton,
            );
            const verifyButton = [
              ...(verification?.querySelectorAll<HTMLButtonElement>('button') ?? []),
            ].find((candidate) => candidate.textContent?.trim() === 'Open profile');
            const style = button ? getComputedStyle(button) : null;
            const rect = button?.getBoundingClientRect();
            const verifyStyle = verifyButton ? getComputedStyle(verifyButton) : null;
            const verifyRect = verifyButton?.getBoundingClientRect();
            return {
              dialogCount: Math.min(dialogs.length, 8),
              visibilityState: document.visibilityState,
              hasFocus: document.hasFocus(),
              verificationDialogPresent: Boolean(verification),
              verificationButtonPresent: Boolean(verifyButton),
              verificationButtonDisabled: verifyButton?.disabled ?? null,
              verificationButtonVisibility: verifyStyle?.visibility ?? null,
              verificationButtonBounds: verifyRect
                ? {
                    x: verifyRect.x,
                    y: verifyRect.y,
                    width: verifyRect.width,
                    height: verifyRect.height,
                  }
                : null,
              dialogPresent: Boolean(dialog),
              buttonPresent: Boolean(button),
              connected: button?.isConnected ?? null,
              disabled: button?.disabled ?? null,
              ariaDisabled: button?.getAttribute('aria-disabled') ?? null,
              display: style?.display ?? null,
              visibility: style?.visibility ?? null,
              opacity: style?.opacity ?? null,
              bounds: rect
                ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                : null,
            };
          };
          let frameTicks = 0;
          let frameId = 0;
          const tick = () => {
            frameTicks++;
            frameId = requestAnimationFrame(tick);
          };
          frameId = requestAnimationFrame(tick);
          const first = sample();
          try {
            await new Promise((done) => setTimeout(done, 80));
            return { first, second: sample(), frameTicks };
          } finally {
            cancelAnimationFrame(frameId);
          }
        }, buttonName)
        .catch(() => 'unavailable:renderer-evaluation-failed'),
      delay(700).then(() => 'unavailable:renderer-timeout'),
    ]);
    return { state, requests: recentRequests };
  };
}
