import { attachPersonalDurability } from '../portable.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { createApp } from '../index.ts';
import { createVaultApp } from '../vault-app.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import { readQualificationReview } from '../../scripts/qualification-intake-read.ts';
import type { IntakeClinicalRecordRead } from '../../shared/intake-clinical-review.ts';
import type { Intake, IntakeReviewDraftUpdate } from '../../shared/intake.ts';

/* Correction -> reload -> reopen by link, through the real HTTP routes, on a
 * fictional PDF source. The reload is the browser's: the feed, the source
 * attention queue, the intake, its identity review, its source issues, the
 * selected review record and the original content are requested together, so
 * GET-path maintenance publications from one request land inside another
 * request's accepted-source proof interval. Every read must answer 200 and
 * show the saved correction. Vault reloads must not pay accepted-proof retries
 * or cold replays (both counted, not timed); contributor reads may retry a
 * complete proof before consumption, under the existing refusal policy. */
const ROUNDS = 3;
const origin = 'http://127.0.0.1:5173';

type Send = (
  path: string,
  body?: string | Blob,
  headers?: Record<string, string>,
) => Promise<Response>;
type Work = ReturnType<typeof createRecordVersionWorkCounters>;

function syntheticPdf(lines: string[]) {
  const escaped = (text: string) =>
    text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = lines
    .map((line, index) => `BT /F1 12 Tf 72 ${720 - index * 20} Td (${escaped(line)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([new Uint8Array(Buffer.from(pdf))], { type: 'application/pdf' });
}

/** Every request handled by this server counts into `work`. */
async function listen(server: Server, work: Work) {
  await withRecordVersionWork(
    work,
    () => new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready)),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function contributor(t: TestContext, work: Work) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-correction-reload-'));
  const profileId = 'cookie-dough';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  const app = createApp({
    root,
    databases: new Map([[profileId, db]]),
    assistantOptions: { availability: () => ({ available: false }) },
  });
  const url = await listen(app.server, work);
  t.after(() => {
    app.close(); // closes the profile database it was given
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const send: Send = (path, body, headers = {}) =>
    fetch(url + path, {
      ...(body === undefined ? {} : { method: 'POST', body }),
      headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    });
  return { send, prefix: `/api/profiles/${profileId}` };
}

async function vault(t: TestContext, work: Work) {
  const base = mkdtempSync(join(tmpdir(), 'fictional-correction-reload-vault-'));
  const dataDirectory = join(base, 'data');
  mkdirSync(dataDirectory);
  const app = createVaultApp({
    dataDirectory,
    runtimeDirectory: join(base, 'runtime'),
    assistantOptions: { availability: async () => ({ available: false }) },
  });
  const url = await listen(app.server, work);
  t.after(() => {
    app.close();
    rmSync(base, { recursive: true, force: true });
  });
  let cookie = '';
  const send: Send = async (path, body, headers = {}) => {
    const response = await fetch(url + path, {
      ...(body === undefined ? {} : { method: 'POST', body }),
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...headers,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    return response;
  };
  const setup = await send(
    '/api/profile-setups',
    JSON.stringify({
      fullName: 'Fictional Cookie Doe',
      birthDate: '1986-02-14',
      name: 'Fictional Cookie Doe',
      placebo: false,
    }),
  );
  assert.equal(setup.status, 201);
  const kit = (await setup.json()) as { data: { setupId: string; recoveryKit: unknown } };
  const verified = await send(
    `/api/profile-setups/${kit.data.setupId}/verify`,
    JSON.stringify({ acknowledged: true, recovery: kit.data.recoveryKit }),
  );
  assert.equal(verified.status, 201);
  const profileId = ((await verified.json()) as { data: { id: string } }).data.id;
  return { send, prefix: `/api/profiles/${profileId}` };
}

const report = {
  key: 'cookie-report',
  title: 'Fictional Cookie Doe laboratory results',
  anchor: { locator: 'page 1', text: 'Fictional Cookie Doe laboratory report' },
  subject: { locator: 'page 1', text: 'Fictional Cookie Doe' },
};
const proposalLines = [
  {
    format: 'health-record-v1',
    id: 'cookie-context',
    kind: 'context',
    contextId: 'cookie-context',
    payload: {
      contextId: 'cookie-context',
      branding: 'Meadowglass Laboratory',
      text: 'Fictional Cookie Doe laboratory report\nFictional Cookie Doe\nMeadowglass Laboratory',
    },
    report,
    provenance: {
      capturedVia: 'Fictional server test',
      sourceSystem: null,
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator: 'page 1',
    },
    coverage: { status: 'partial', notes: [] },
  },
  {
    format: 'health-record-v1',
    id: 'cookie-result',
    contextId: 'cookie-context',
    kind: 'record',
    subject: 'self',
    payload: 'Fictional Cookie Doe. Potassium 4.1 mmol/L. 2032-03-04.',
    clinical: {
      kind: 'observation',
      documentTitle: 'Potassium',
      subject: 'self',
      testLabel: 'Potassium',
      valueText: '',
      unit: 'mmol/L',
      status: 'final',
      date: '2032-03-04',
      reviewIssues: [
        {
          id: 'cookie-value',
          kind: 'uncertain_reading',
          field: 'valueText',
          prompt: 'Check the potassium value in the original.',
        },
      ],
    },
    provenance: {
      capturedVia: 'Fictional server test',
      sourceSystem: null,
      sourceRecordId: 'cookie-result',
      evidenceClass: 'transcription',
      locator: 'page 1 Potassium result cell',
    },
    report,
    coverage: {
      status: 'complete_response',
      notes: ['Controlled fictional server fixture; no extraction accuracy claim.'],
    },
  },
];

const delta = (work: Work, before: Work['operation']) => {
  const after = work.operation;
  return {
    proofRetries: after.acceptedSourceProofRetries - before.acceptedSourceProofRetries,
    coldReplays: after.vaultBackingColdReplays - before.vaultBackingColdReplays,
    coldDecoded: after.vaultBackingColdDecodedVersions - before.vaultBackingColdDecodedVersions,
  };
};

for (const backend of ['contributor', 'vault'] as const)
  test(
    `saved correction survives concurrent reload and reopen by link: ${backend}`,
    // Real durable HTTP fixtures; a hang guard, not a measurement.
    { timeout: 300000 },
    async (t) => {
      const work = createRecordVersionWorkCounters();
      const { send, prefix } =
        backend === 'vault' ? await vault(t, work) : await contributor(t, work);
      const intakes = prefix + '/intakes';
      async function json<T>(path: string, body?: unknown) {
        const response = await send(path, body === undefined ? undefined : JSON.stringify(body));
        const text = await response.text();
        assert.equal(response.status, 200, `${path}: ${text}`);
        return JSON.parse(text) as { data: T };
      }
      const uploaded = await send(
        intakes,
        syntheticPdf([
          'Fictional Cookie Doe laboratory report',
          'Meadowglass Laboratory',
          'Patient: Fictional Cookie Doe',
          'Potassium 4.1 mmol/L 2032-03-04',
          'Synthetic test data',
        ]),
        { 'Content-Type': 'application/pdf', 'X-Filename': 'fictional-cookie-lab.pdf' },
      );
      const uploadText = await uploaded.text();
      assert.equal(uploaded.status, 201, uploadText);
      const intakeId = (JSON.parse(uploadText) as { data: Intake }).data.id;
      const path = `${intakes}/${encodeURIComponent(intakeId)}`;
      for (const batch of (
        await json<{ id: string; items: { intakeId: string }[] }[]>(prefix + '/intake-batches')
      ).data)
        if (batch.items.some((item) => item.intakeId === intakeId))
          await json(`${prefix}/intake-batches/${batch.id}/stop`, {});
      const stopped = (await json<Intake>(path)).data;
      await json(path + '/proposals', {
        version: stopped.version,
        summary: 'Fictional controlled correction fixture',
        jsonlText: proposalLines.map((line) => JSON.stringify(line)).join('\n'),
      });
      const feedQuery = new URLSearchParams({ view: 'all', limit: '40', bytes: '65536', intakeId });
      const feed = (
        await json<{ records: { intakeId: string; groupId: string; proposalId: string | null }[] }>(
          `${intakes}/import-feed?${feedQuery}`,
        )
      ).data;
      const row = feed.records.find((item) => item.intakeId === intakeId);
      assert.ok(row, 'the fictional record is in the feed');
      const before = await readQualificationReview(
        async <T>(page: string) => (await json<T>(page)).data,
        path +
          '/review' +
          (row.proposalId ? `?proposalId=${encodeURIComponent(row.proposalId)}` : ''),
      );
      const record = before.records.find((item) => item.mapping.testLabel === 'Potassium');
      assert.ok(record);
      assert.equal(record.mapping.valueText, '');
      const draft: IntakeReviewDraftUpdate = {
        operationId: randomUUID(),
        version: before.version,
        proposalId: before.proposalId,
        recordId: record.id,
        candidateVersionId: record.candidateVersionId!,
        mapping: { ...record.mapping, valueText: '4.1' },
        disposition: 'pending',
        resolutions: [],
        answers: {},
      };
      await json(path + '/review-draft', draft);
      const recordQuery = new URLSearchParams({ recordId: record.id, bytes: '65536' });
      if (before.proposalId) recordQuery.set('proposalId', before.proposalId);
      recordQuery.set('candidateVersionId', record.candidateVersionId!);
      feedQuery.set('groupId', row.groupId);
      feedQuery.set('recordId', record.id);
      const reload = [
        `${intakes}/import-feed?${feedQuery}`,
        `${intakes}/source-attention?offset=0`,
        path,
        `${path}/identity-review?groupId=${encodeURIComponent(row.groupId)}`,
        `${path}/source-issues?limit=1&readerOffset=0&readerLimit=20`,
        `${path}/review-record?${recordQuery}`,
        `${prefix}/sources/${encodeURIComponent(intakeId)}/content`,
      ];
      // Warm once so the counted rounds measure steady reloads, not first use.
      for (const page of reload) {
        let response: Response;
        try {
          response = await send(page);
        } catch (error) {
          throw new Error(`warm request failed: ${page}`, { cause: error });
        }
        let text: string;
        try {
          text = await response.text();
        } catch (error) {
          throw new Error(`warm body failed: ${page}, status ${response.status}`, { cause: error });
        }
        assert.equal(response.status, 200, `${page}: ${text.slice(0, 400)}`);
      }
      const counted = structuredClone(work.operation);
      let reads = 0,
        cursorRereads = 0;
      for (let round = 0; round < ROUNDS; round++) {
        const responses = await Promise.all(
          reload.map(async (page) => {
            let response: Response;
            try {
              response = await send(page);
            } catch (error) {
              throw new Error(`round ${round} request failed: ${page}`, { cause: error });
            }
            let text: string;
            try {
              text = await response.text();
            } catch (error) {
              throw new Error(`round ${round} body failed: ${page}, status ${response.status}`, {
                cause: error,
              });
            }
            // The client re-reads a collection cursor refusal exactly once
            // (readReportDetailAfterQueueCursor); every other refusal stands.
            if (response.status === 409 && JSON.parse(text).error?.code === 'REPORT_QUEUE_CURSOR') {
              cursorRereads++;
              response = await send(page);
              text = await response.text();
            }
            return { page, status: response.status, text };
          }),
        );
        for (const { page, status, text } of responses) {
          reads++;
          assert.equal(status, 200, `round ${round} ${page}: ${text.slice(0, 400)}`);
        }
        const reopened = (
          JSON.parse(responses.find(({ page }) => page.includes('/review-record?'))!.text) as {
            data: IntakeClinicalRecordRead;
          }
        ).data;
        assert.equal(reopened.format, 'health-intake-clinical-record-v2');
        assert.equal(reopened.record.kind, 'record');
        if (reopened.record.kind === 'record')
          assert.equal(reopened.record.record.mapping.valueText, '4.1', 'saved correction');
      }
      assert.equal(reads, ROUNDS * reload.length, 'every reload read was answered');
      const spent = delta(work, counted);
      t.diagnostic(`${backend} steady reload work: ${JSON.stringify({ ...spent, cursorRereads })}`);
      // Contributor proofs advance incrementally and may repeat under explained
      // concurrent writes. The vault reload must stay as cheap as its readers
      // were before routing: no accepted-proof retries and no cold replays.
      if (backend === 'vault')
        assert.deepEqual(
          spent,
          { proofRetries: 0, coldReplays: 0, coldDecoded: 0 },
          'steady vault reloads neither retry accepted proofs nor replay vault history cold',
        );
    },
  );
