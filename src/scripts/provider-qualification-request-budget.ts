import { stripTypeScriptTypes } from 'node:module';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { outsideGit } from '../../deploy/run.ts';
import {
  qualificationPrivateTraceCompose,
  type QualificationPrivateTrace,
} from './provider-qualification-private-trace.ts';

export const qualificationRequestLimit = 16;
export interface QualificationRequestBudget {
  limit: 16;
  admitted: number;
  denied: number;
  runtimeClaimed: boolean;
  stopReason:
    | null
    | 'completion_request_cap_reached'
    | 'unexpected_request_route'
    | 'worker_network_request_refused'
    | 'runtime_restart_refused'
    | 'receipt_integrity_failure';
  scope: string;
}
const scope =
  'Durably reserved application-to-LiteLLM completion HTTP attempts, including fictional capability probes, coordinator work, failed attempts and retries. No refill/restart or automatic rerun. This caps requests, not tokens, provider billing or cost; the supported proxy disables router retries and fallbacks.';
/** The filenames are the reservations, including any crash-interrupted receipt.
 * Never infer spare budget from an HTTP outcome or an incomplete receipt body. */
export function readQualificationRequestBudget(receipts: string): QualificationRequestBudget {
  const names = readdirSync(receipts);
  const limitDenied = names.filter((name) => /^denied-limit-\d+\.json$/u.test(name)).length;
  const routeDenied = names.filter((name) => /^denied-route-\d+\.json$/u.test(name)).length;
  const workerDenied = names.filter((name) => /^denied-worker-\d+-\d+\.json$/u.test(name)).length;
  const restartDenied = names.includes('blocked-restart.json');
  return {
    limit: qualificationRequestLimit,
    admitted: names.filter((name) => /^admitted-\d+\.json$/u.test(name)).length,
    denied: limitDenied + routeDenied + workerDenied,
    runtimeClaimed: names.includes('runtime.claim'),
    stopReason: names.includes('blocked-integrity.json')
      ? 'receipt_integrity_failure'
      : restartDenied
        ? 'runtime_restart_refused'
        : workerDenied
          ? 'worker_network_request_refused'
          : routeDenied
            ? 'unexpected_request_route'
            : limitDenied
              ? 'completion_request_cap_reached'
              : null,
    scope,
  };
}
/** A cap denial must remain inconclusive even if the narrow UI oracle happened
 * to finish concurrently. Apply on every saved report and again after cleanup. */
export function retainQualificationRequestBudget(
  report: {
    requestBudget: QualificationRequestBudget | null;
    passed: boolean;
    failure: string | null;
  },
  snapshot: QualificationRequestBudget,
) {
  report.requestBudget = snapshot;
  if (snapshot.stopReason) {
    report.passed = false;
    report.failure = `Qualification inconclusive: ${snapshot.stopReason}; the request budget cannot refill or rerun automatically.`;
  }
}
function durableFile(path: string, body: string) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** One owner-only, external directory per deliberate attempt. Only the actual
 * health runtime gets --import; no NODE_OPTIONS or product policy changes. */
export function prepareQualificationRequestBudget(
  attempt: string,
  privateTrace?: QualificationPrivateTrace,
) {
  outsideGit(attempt);
  const control = join(attempt, 'request-budget');
  const receipts = join(control, 'receipts');
  mkdirSync(control, { mode: 0o700 });
  mkdirSync(receipts, { mode: 0o700 });
  chmodSync(control, 0o700);
  chmodSync(receipts, 0o700);
  const preloader = join(control, 'cap.mjs');
  durableFile(
    preloader,
    stripTypeScriptTypes(
      readFileSync(
        new URL('./provider-qualification-request-budget-preload.ts', import.meta.url),
        'utf8',
      ),
    ),
  );
  const override = join(control, 'compose.json');
  // Compose interpolates values even in JSON. Preserve literal host path dollars.
  const source = (path: string) => path.replace(/\$/gu, () => '$$');
  const trace = privateTrace ? qualificationPrivateTraceCompose(privateTrace) : null;
  durableFile(
    override,
    JSON.stringify(
      {
        services: {
          health: {
            command: ['node', '--import', '/qualification/cap.mjs', 'src/server/runtime.ts'],
            environment: {
              CRS_QUALIFICATION_REQUEST_RECEIPTS: '/qualification/receipts',
              ...trace?.environment,
            },
            volumes: [
              {
                type: 'bind',
                source: source(preloader),
                target: '/qualification/cap.mjs',
                read_only: true,
                bind: { create_host_path: false },
              },
              {
                type: 'bind',
                source: source(receipts),
                target: '/qualification/receipts',
                bind: { create_host_path: false },
              },
              ...(trace?.volumes ?? []),
            ],
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
  for (const directory of [control, attempt]) {
    const fd = openSync(directory, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  return { control, receipts, preloader, override };
}
/** Observation is independent of HTTP/model errors: the bridge intentionally
 * sanitizes transport errors. A denied request aborts the parent and stack once. */
export function observeQualificationRequestBudget(
  receipts: string,
  stopped: (snapshot: QualificationRequestBudget | null) => void,
  intervalMs = 100,
) {
  let signalled = false;
  const timer = setInterval(() => {
    if (signalled) return;
    let snapshot: QualificationRequestBudget | null;
    try {
      snapshot = readQualificationRequestBudget(receipts);
    } catch {
      snapshot = null;
    }
    if (!snapshot || snapshot.stopReason) {
      signalled = true;
      stopped(snapshot);
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
