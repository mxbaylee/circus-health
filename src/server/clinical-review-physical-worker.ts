import { Worker } from 'node:worker_threads';
import { isAbsolute } from 'node:path';

export type ClinicalPhysicalItem =
  | { kind: 'identity'; path: string; expectedIdentity: string }
  | {
      kind: 'marker';
      path: string;
      expected: { sha256: string; bytes?: number } | 'absent';
    }
  | { kind: 'directory'; path: string; expectedIdentity: string | 'absent' };

const PAGE_ITEMS = 64;
const PAGE_BYTES = 512 * 1024;
const FIELD_BYTES = 4096;

function invalid(): Error {
  return Error('Retained physical evidence changed');
}

export class ClinicalPhysicalEvidenceChanged extends Error {
  constructor() {
    super('Retained physical evidence changed');
  }
}

function boundedField(value: string): boolean {
  return Buffer.byteLength(value) <= FIELD_BYTES;
}

export function clinicalPhysicalVerificationPages(
  items: readonly ClinicalPhysicalItem[],
): ClinicalPhysicalItem[][] {
  if (items.length < 1 || items.length > PAGE_ITEMS) throw invalid();
  const pages: ClinicalPhysicalItem[][] = [];
  let page: ClinicalPhysicalItem[] = [];
  let bytes = 2;
  for (const item of items) {
    if (!isAbsolute(item.path) || !boundedField(item.path)) throw invalid();
    let retained: ClinicalPhysicalItem;
    if (item.kind === 'identity') {
      if (!boundedField(item.expectedIdentity)) throw invalid();
      retained = { kind: item.kind, path: item.path, expectedIdentity: item.expectedIdentity };
    } else if (item.kind === 'marker') {
      if (
        item.expected !== 'absent' &&
        (!/^[0-9a-f]{64}$/.test(item.expected.sha256) ||
          (item.expected.bytes !== undefined &&
            (!Number.isSafeInteger(item.expected.bytes) ||
              item.expected.bytes < 0 ||
              item.expected.bytes > 4096)))
      )
        throw invalid();
      retained = {
        kind: item.kind,
        path: item.path,
        expected: item.expected === 'absent' ? 'absent' : { ...item.expected },
      };
    } else if (item.kind === 'directory') {
      if (!boundedField(item.expectedIdentity)) throw invalid();
      retained = { kind: item.kind, path: item.path, expectedIdentity: item.expectedIdentity };
    } else throw invalid();
    const itemBytes = Buffer.byteLength(JSON.stringify(retained));
    if (itemBytes + 2 > PAGE_BYTES) throw invalid();
    if (bytes + itemBytes + (page.length ? 1 : 0) > PAGE_BYTES) {
      pages.push(page);
      page = [];
      bytes = 2;
    }
    bytes += itemBytes + (page.length ? 1 : 0);
    page.push(retained);
  }
  pages.push(page);
  return pages;
}

export async function openClinicalPhysicalVerifier(signal?: AbortSignal): Promise<{
  verifyPage(items: readonly ClinicalPhysicalItem[]): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}> {
  signal?.throwIfAborted();
  const worker = new Worker(
    new URL('./clinical-review-physical-worker-thread.ts', import.meta.url),
  );
  let ready = false;
  let ended = false;
  let closing = false;
  let nextId = 1;
  let failed = false;
  let failure: unknown;
  let pending:
    | { id: number; count?: number; close?: true; resolve(): void; reject(error: unknown): void }
    | undefined;
  let readyResolve!: () => void;
  let readyReject!: (error: unknown) => void;
  const started = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let exitResolve!: (code: number) => void;
  const exit = new Promise<number>((resolve) => {
    exitResolve = resolve;
  });
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    failure = error;
    if (!ready) readyReject(error);
    pending?.reject(error);
    pending = undefined;
    if (ready) void worker.terminate();
  };
  const onAbort = () => fail(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  signal?.addEventListener('abort', onAbort, { once: true });
  worker.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return fail(invalid());
    const received = message as {
      ready?: boolean;
      id?: number;
      count?: number;
      closed?: boolean;
      failure?: boolean;
      sourceChanged?: boolean;
    };
    if (!ready) {
      if (received.ready !== true) return fail(invalid());
      ready = true;
      if (failed) {
        void worker.terminate();
        return;
      }
      readyResolve();
      return;
    }
    const current = pending;
    if (!current || received.id !== current.id) return fail(invalid());
    if (
      !current.close &&
      received.sourceChanged === true &&
      received.count === undefined &&
      received.closed === undefined &&
      received.failure === undefined
    )
      return fail(new ClinicalPhysicalEvidenceChanged());
    if (
      received.failure ||
      (current.close ? received.closed !== true : received.count !== current.count)
    )
      return fail(invalid());
    pending = undefined;
    current.resolve();
  });
  worker.on('error', () => fail(invalid()));
  worker.on('exit', (code) => {
    ended = true;
    exitResolve(code);
    if (!closing || pending) fail(invalid());
    signal?.removeEventListener('abort', onAbort);
  });
  try {
    await started;
  } catch (error) {
    await exit;
    throw error;
  }
  const request = (items: readonly ClinicalPhysicalItem[]): Promise<void> => {
    if (failed || ended || pending || closing) throw failed ? failure : invalid();
    const id = nextId++;
    return new Promise<void>((resolve, reject) => {
      pending = { id, count: items.length, resolve, reject };
      worker.postMessage({ type: 'page', id, items });
    });
  };
  return {
    async verifyPage(items) {
      for (const page of clinicalPhysicalVerificationPages(items)) await request(page);
    },
    async close() {
      if (failed) throw failure;
      if (closing || ended || pending) throw invalid();
      const id = nextId++;
      closing = true;
      await new Promise<void>((resolve, reject) => {
        pending = { id, close: true, resolve, reject };
        worker.postMessage({ type: 'close', id });
      });
      if ((await exit) !== 0 || failed) throw failed ? failure : invalid();
    },
    async abort() {
      if (!ended) {
        fail(invalid());
        await exit;
      }
    },
  };
}
