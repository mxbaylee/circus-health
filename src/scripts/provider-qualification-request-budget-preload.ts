/** Qualification-only preloader. Generated as external cap.mjs; never imported by
 * the ordinary runtime, healthcheck or filesystem preflight. No payloads/keys. */
import { closeSync, fsyncSync, lstatSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { isMainThread, threadId } from 'node:worker_threads';

const receipts = process.env.CRS_QUALIFICATION_REQUEST_RECEIPTS;
if (!receipts) throw Error('Qualification request receipts are required.');
const metadata = lstatSync(receipts);
if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0)
  throw Error('Qualification request receipts must be an owner-only directory.');
const proxy = new URL(process.env.CRS_AI_BASE_URL || '');
if (
  !['http:', 'https:'].includes(proxy.protocol) ||
  proxy.pathname !== '/' ||
  proxy.search ||
  proxy.hash
)
  throw Error('Qualification requires an exact proxy origin.');
const directory = openSync(receipts, 'r');
function receipt(name: string, value: unknown) {
  const fd = openSync(join(receipts!, name), 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Reserve durably before any network attempt. A partially written receipt
  // still consumes its slot. The process claim forbids all crash/restart replay.
  fsyncSync(directory);
}
// Node inherits --import in startup workers. Only a new main runtime is a
// restart; workers initialize locally under a separate, fail-closed fetch guard.
if (isMainThread) {
  try {
    receipt('runtime.claim', { schemaVersion: 1, limit: 16 });
  } catch {
    // Restart never refills a budget, even if the prior process made no requests.
    try {
      receipt('blocked-restart.json', { reason: 'runtime_restart_refused' });
    } catch {
      /* Existing marker or unwritable receipts: startup still fails closed. */
    }
    closeSync(directory);
    throw Error('Qualification runtime claim failed; this attempt cannot restart.');
  }
}
let admitted = 0;
let denied = 0;
const proxyHost = proxy.hostname.replace(/^\[|\]$/g, '');
const proxyAddresses = new Set(
  !isMainThread
    ? []
    : isIP(proxyHost)
      ? [proxyHost]
      : (await lookup(proxyHost, { all: true })).map((item) => item.address),
);
function reserve(name: string, value: unknown) {
  try {
    receipt(name, value);
  } catch {
    // A failed durable reservation cannot become an endlessly retried local
    // transport error. End this runtime; its claim prevents all restart spend.
    try {
      receipt('blocked-integrity.json', { reason: 'receipt_integrity_failure' });
    } catch {
      /* The filesystem may no longer accept writes. Never contact upstream. */
    }
    process.stderr.write('Qualification request reservation failed; runtime stopped.\n');
    process.exit(78);
  }
}
const upstreamFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (!isMainThread) {
    // Worker-local counters cannot share the main thread's admission budget.
    // Deny every worker fetch before parsing or forwarding it; thread IDs keep
    // simultaneous worker denial receipts distinct for the parent observer.
    reserve(`denied-worker-${threadId}-${String(++denied).padStart(4, '0')}.json`, {
      reason: 'worker_network_request_refused',
    });
    throw Error('Qualification refused a worker network request.');
  }
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input));
  const method = (init?.method || request?.method || 'GET').toUpperCase();
  const headers = new Headers(init?.headers ?? request?.headers);
  // The normal bridge can pin a checked private IP and retain the configured
  // DNS authority in Host. Accept that exact transport as well as the origin.
  const sameProxy =
    url.protocol === proxy.protocol &&
    url.port === proxy.port &&
    (url.hostname === proxy.hostname ||
      (proxyAddresses.has(url.hostname.replace(/^\[|\]$/g, '')) &&
        headers.get('host') === proxy.host));
  const completion =
    method === 'POST' &&
    sameProxy &&
    url.pathname === '/v1/chat/completions' &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password;
  const modelRoute = /(?:completions|responses|messages)(?:\/|$)/u.test(url.pathname);
  if (!completion && (modelRoute || !['GET', 'HEAD'].includes(method))) {
    reserve(`denied-route-${String(++denied).padStart(4, '0')}.json`, {
      reason: 'unexpected_request_route',
    });
    throw Error('Qualification refused an unexpected outgoing request route.');
  }
  if (!completion) return upstreamFetch(input, init);
  if (admitted >= 16) {
    reserve(`denied-limit-${String(++denied).padStart(4, '0')}.json`, {
      reason: 'completion_request_cap_reached',
    });
    throw Error('Qualification completion request cap reached.');
  }
  reserve(`admitted-${String(++admitted).padStart(4, '0')}.json`, { sequence: admitted });
  // Failed HTTP responses and transport failures consume the same slot. Force
  // redirect:error so an admitted request cannot fan out into hidden redirects.
  return upstreamFetch(input, { ...init, redirect: 'error' });
};
