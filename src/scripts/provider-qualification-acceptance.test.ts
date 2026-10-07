import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVaultApp } from '../server/vault-app.ts';
import { createImportDiagnostics } from '../server/import-diagnostics.ts';
import { getRetainedIntakeOriginalReference } from '../server/intake.ts';
import type { IntakeIdentityReview } from '../shared/intake-identity.ts';
import type { IntakeBatch } from '../shared/intake-batch.ts';
import type { HealthRecordEnvelope } from '../shared/intake.ts';
import {
  qualificationAnswers,
  qualificationBirthDate,
  qualificationPerson,
  qualificationSourceSystem,
  gradeProviderQualification,
  writeProviderQualificationPdf,
} from './provider-qualification-fixture.ts';
import { readPdfIdentityPageText } from '../server/intake-pdf-session.ts';
import type { IntakeRead } from '../shared/intake-summary.ts';
import { collectQualificationFeed, readQualificationReview } from './qualification-intake-read.ts';
import { performQualificationAcceptance } from './provider-qualification-acceptance.ts';

test(
  'qualification acceptance uses real profile HTTP receipts and survives removal of only its encrypted cache',
  { timeout: 1200_000 },
  async (t) => {
    // Host-created proposals isolate acceptance mechanics. This makes no provider
    // extraction claim; the live harness must independently pass its oracle first.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fictional-qualification-recovery-')));
    const dataDirectory = join(root, 'data');
    mkdirSync(dataDirectory);
    const startedAt = performance.now();
    const diagnostics = createImportDiagnostics({
      enabled: process.env.CRS_IMPORT_DIAGNOSTICS === 'true',
    });
    // Observe only fixed stage names/numeric timing before normal lifecycle
    // filtering; a locked profile deliberately has no attached diagnostic store.
    const recordDiagnostic = diagnostics.record;
    diagnostics.record = (event, fields, context) => {
      if (typeof fields?.phase === 'string' && fields.phase.startsWith('profile_'))
        console.info(
          JSON.stringify({
            fixture: 'fictional qualification recovery stage',
            event,
            phase: fields.phase,
            durationMs: fields.durationMs ?? null,
            elapsedMs: performance.now() - startedAt,
          }),
        );
      recordDiagnostic(event, fields, context);
    };
    const app = createVaultApp({
      dataDirectory,
      diagnostics,
      runtimeDirectory: join(root, 'runtime'),
      assistantOptions: { availability: async () => ({ available: false }) },
    });
    t.after(() => {
      app.close();
      diagnostics.close();
      rmSync(root, { recursive: true, force: true });
    });
    await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const origin = 'http://localhost:5173';
    let cookie = '';
    const identityConfirmations: unknown[] = [];
    let clinicalAcceptanceWrites = 0;
    let requestsStarted = 0,
      requestsFinished = 0;
    let activeRequest: { sequence: number; operation: string } | undefined;
    let requestStartedAt = 0;
    const progress = () =>
      console.info(
        JSON.stringify({
          fixture: 'fictional qualification acceptance',
          requestsStarted,
          requestsFinished,
          elapsedMs: performance.now() - startedAt,
          activeRequest: activeRequest
            ? { ...activeRequest, elapsedMs: performance.now() - requestStartedAt }
            : null,
          identityConfirmations: identityConfirmations.length,
          clinicalAcceptanceWrites,
        }),
      );
    const progressTimer = setInterval(progress, 30_000);
    progressTimer.unref();
    t.signal.addEventListener('abort', progress, { once: true });
    t.after(() => {
      clearInterval(progressTimer);
      t.signal.removeEventListener('abort', progress);
      progress();
    });
    async function request<T>(path: string, input?: unknown, bytes?: Buffer): Promise<T> {
      if (input !== undefined && path.endsWith('/identity-scope'))
        identityConfirmations.push(input);
      if (input !== undefined && path.endsWith('/report-acceptance')) clinicalAcceptanceWrites++;
      const operation =
        [
          'identity-review',
          'identity-scope-page',
          'identity-scope',
          'report-acceptance',
          'report-queue',
          'review',
          'questions',
          'proposals',
          'intake-batches',
          'stop',
          'profile-setups',
          'verify',
          'intakes',
          'lock',
          'unlock',
          'recover',
        ].find((label) => path.split('?')[0]!.endsWith('/' + label)) ?? 'other';
      activeRequest = { sequence: ++requestsStarted, operation };
      requestStartedAt = performance.now();
      const cpuStarted = process.cpuUsage();
      if (operation === 'unlock') progress();
      try {
        const response = await fetch(base + path, {
          method: input !== undefined || bytes ? 'POST' : 'GET',
          headers: {
            Origin: origin,
            Cookie: cookie,
            'Content-Type': bytes ? 'application/pdf' : 'application/json',
            ...(bytes ? { 'X-Filename': 'fictional-quick-qualification.pdf' } : {}),
          },
          ...(bytes
            ? { body: Uint8Array.from(bytes).buffer }
            : input !== undefined
              ? { body: JSON.stringify(input) }
              : {}),
          signal: AbortSignal.any([t.signal, AbortSignal.timeout(360_000)]),
        });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        const result = (await response.json()) as { data: T; error?: unknown };
        assert.equal(response.ok, true, `${path}: ${JSON.stringify(result.error)}`);
        return result.data;
      } finally {
        if (operation === 'unlock' || operation === 'lock' || operation === 'report-acceptance') {
          const cpu = process.cpuUsage(cpuStarted);
          console.info(
            JSON.stringify({
              fixture: 'fictional qualification request finished',
              ...activeRequest,
              elapsedMs: performance.now() - requestStartedAt,
              processCpuMs: (cpu.user + cpu.system) / 1000,
            }),
          );
        }
        requestsFinished++;
        activeRequest = undefined;
      }
    }
    const setup = await request<{ setupId: string; recoveryKit: unknown }>('/api/profile-setups', {
      name: 'Qualification',
      fullName: qualificationPerson,
      birthDate: qualificationBirthDate,
      placebo: false,
    });
    const profile = await request<{ id: string }>(`/api/profile-setups/${setup.setupId}/verify`, {
      recovery: setup.recoveryKit,
      acknowledged: true,
    });
    const prefix = `/api/profiles/${profile.id}`;
    const path = join(root, 'fictional.pdf');
    const fixture = writeProviderQualificationPdf(path);
    const uploaded = await request<IntakeRead>(prefix + '/intakes', undefined, readFileSync(path));
    // This fixture supplies its own proposals. Revoke automatic processing before
    // inspecting evidence so a background capture cannot change their source pin.
    const batches = await request<IntakeBatch[]>(prefix + '/intake-batches');
    const owned = batches.filter((batch) =>
      batch.items.some((item) => item.intakeId === uploaded.id),
    );
    assert.equal(owned.length, 1);
    const stopped = await request<IntakeBatch>(prefix + `/intake-batches/${owned[0]!.id}/stop`, {});
    assert.equal(stopped.status, 'stopped');
    const state = app.manager.opened.get(profile.id)!;
    const identityByPage = new Map<
      number,
      { anchor: string; subject: string; textAnchor: string; fullName: string }
    >();
    const reference = getRetainedIntakeOriginalReference(
      state.db,
      state.root,
      profile.id,
      uploaded.id,
    );
    for (const page of [1, 2, 3, 4]) {
      const { text } = await readPdfIdentityPageText({ ...reference, profileId: profile.id }, page);
      const lines = text.split('\n');
      const anchor =
        lines.find((line) => line.includes('FICTIONAL'))?.trim() ??
        'FICTIONAL CLINICAL QUALIFICATION REPORT';
      const subjectLine =
        lines.find((line) => line.includes('Patient:'))?.trim() ??
        `Patient: ${qualificationPerson}.`;
      const birth =
        lines.find((line) => line.includes('DOB:'))?.trim() ??
        `Patient DOB: ${qualificationBirthDate}.`;
      const patientField = /Patient:\s*(.*?)\./.exec(subjectLine)!;
      const fullName = patientField[1]!;
      // This independently generated proposal selects the literal patient field,
      // not the surrounding page counter/sentence as a supposed personal name.
      const subject = patientField[0].slice(0, -1);
      assert.ok(subjectLine.includes(subject));
      identityByPage.set(page, {
        anchor,
        subject,
        textAnchor: `${subjectLine}\n${birth}`,
        fullName,
      });
    }
    const proposals: HealthRecordEnvelope[] = qualificationAnswers.map((answer) => ({
      format: 'health-record-v1',
      id: answer.marker,
      kind: 'record',
      payload: {
        person: qualificationPerson,
        birthDate: qualificationBirthDate,
        originalPage: answer.page,
        identity: identityByPage.get(answer.page)!.textAnchor,
        report: identityByPage.get(answer.page)!.anchor,
        ...answer.fields,
      },
      provenance: {
        capturedVia: 'Independent host fixture',
        sourceSystem: qualificationSourceSystem,
        sourceRecordId: null,
        evidenceClass: 'transcription',
        locator: `page ${answer.page}, row ${answer.marker}`,
      },
      coverage: { status: 'partial', notes: ['One fictional observation'] },
      clinical: { kind: 'observation', ...answer.fields, subject: 'unknown' },
      reviewIssues: [
        {
          kind: 'identity',
          field: 'subject',
          prompt: 'Does this fictional report belong to you?',
          textAnchor: identityByPage.get(answer.page)!.textAnchor,
          selfSuggestion: {
            fullName: identityByPage.get(answer.page)!.fullName,
            birthDate: qualificationBirthDate,
          },
        },
      ],
      report: {
        key: `fictional-report-page-${answer.page}`,
        title: 'FICTIONAL CLINICAL QUALIFICATION REPORT',
        anchor: { locator: `page ${answer.page}`, text: identityByPage.get(answer.page)!.anchor },
        subject: {
          locator: `page ${answer.page}`,
          text: identityByPage.get(answer.page)!.subject,
        },
      },
    }));
    await request<IntakeRead>(prefix + '/intakes/' + uploaded.id + '/proposals', {
      version: (await request<IntakeRead>(prefix + '/intakes/' + uploaded.id)).version,
      jsonlText: proposals.map((item) => JSON.stringify(item)).join('\n'),
      summary: 'Independently fictional test proposals',
    });
    const proposedFeed = await collectQualificationFeed(request, prefix);
    const proposalIds = new Set(proposedFeed.blocks.map((block) => block.proposalId));
    assert.equal(proposalIds.size, 1);
    const proposalId = [...proposalIds][0];
    assert.ok(proposalId);
    const review = await readQualificationReview(
      request,
      prefix + '/intakes/' + uploaded.id + '/review?proposalId=' + encodeURIComponent(proposalId),
    );
    for (const record of review.records.filter((record) =>
      record.mapping.testLabel?.endsWith('R01'),
    )) {
      await request(prefix + '/intakes/' + uploaded.id + '/questions', {
        version: (await request<IntakeRead>(prefix + '/intakes/' + uploaded.id)).version,
        key: 'fictional-identity-' + record.id,
        prompt: 'Confirm the fictional patient printed on this page belongs to you.',
        candidateId: record.candidateId,
        candidateVersionId: record.candidateVersionId,
        field: 'subject',
        locator: record.evidence[0]!.locator,
      });
    }
    const collectFeed = (prefix: string) => collectQualificationFeed(request, prefix);
    async function originalHash(prefix: string, originalId: string) {
      const response = await fetch(
        base + prefix + `/sources/${encodeURIComponent(originalId)}/content`,
        { headers: { Origin: origin, Cookie: cookie }, signal: t.signal },
      );
      assert.equal(response.ok, true);
      return createHash('sha256')
        .update(Buffer.from(await response.arrayBuffer()))
        .digest('hex');
    }
    const options = {
      prefix,
      profileId: profile.id,
      recovery: setup.recoveryKit,
      originalId: uploaded.id,
      scenario: 'quick' as const,
      ownedProfiles: new Set([profile.id]),
      dataDirectory,
      expectedRecords: 64,
      expectedSha256: fixture.sha256,
      request,
      collectFeed,
      originalHash,
    };
    await assert.rejects(
      performQualificationAcceptance({ ...options, ownedProfiles: new Set() }),
      /freshly created qualification profile/,
    );
    const pending = await collectFeed(prefix);
    assert.ok(
      proposals.every((record) => (record.clinical as { subject: string }).subject === 'unknown'),
    );

    assert.equal(
      gradeProviderQualification(
        pending.blocks.flatMap((block) => block.records),
        uploaded.id,
        'quick',
        'extracted',
      ).passed,
      true,
    );

    await assert.rejects(
      performQualificationAcceptance({ ...options, originalHash: async () => 'changed-original' }),
      /unchanged independently generated original/,
    );
    for (const mutate of [
      (review: IntakeIdentityReview) => {
        review.evidencedIdentity.fullName = 'Different Fictional Person';
      },
      (review: IntakeIdentityReview) => {
        review.evidencedIdentity.birthDate = '1990-01-01';
      },
      (review: IntakeIdentityReview) => {
        review.self.fullName = 'Different Selected Person';
      },
      (review: IntakeIdentityReview) => {
        const scope = review.scope || review.scopeReference;
        assert.ok(scope);
        scope.sourceHash = 'different-original';
      },
    ]) {
      await assert.rejects(
        performQualificationAcceptance({
          ...options,
          request: async <T>(path: string, input?: unknown): Promise<T> => {
            const result = await request<T>(path, input);
            if (path.includes('/identity-review?')) {
              assert.ok(
                (result as IntakeIdentityReview).scope ||
                  (result as IntakeIdentityReview).scopeReference,
              );
              mutate(result as IntakeIdentityReview);
            }
            return result;
          },
        }),
        /exact fictional patient and original/,
      );
    }
    await assert.rejects(
      performQualificationAcceptance({
        ...options,
        request: async <T>(path: string, input?: unknown): Promise<T> => {
          const result = await request<T>(path, input);
          if (
            path.includes('/identity-scope-page?') &&
            new URLSearchParams(path.split('?')[1]).get('section') === 'targets'
          ) {
            const page = result as import('../shared/intake-identity.ts').IntakeIdentityScopePage;
            const first = page.items[0];
            assert.equal(first?.kind, 'value');
            if (first?.kind === 'value') {
              assert.ok(
                first.value &&
                  typeof first.value === 'object' &&
                  'candidateVersionId' in first.value,
              );
              first.value.candidateVersionId = 'different-version';
            }
          }
          return result;
        },
      }),
      /exact fictional patient and original/,
    );
    await assert.rejects(
      performQualificationAcceptance({
        ...options,
        collectFeed: async (prefix) => {
          const feed = structuredClone(await collectFeed(prefix));
          for (const record of feed.blocks.flatMap((block) => block.records)) {
            record.mapping.subject = 'unknown';
            record.issues = [];
          }
          return feed;
        },
      }),
      /host-evidenced Self or an explicit scoped identity review/,
    );
    await assert.rejects(
      performQualificationAcceptance({
        ...options,
        collectFeed: async (prefix) => {
          const feed = structuredClone(await collectFeed(prefix));
          feed.blocks[0]!.records[0]!.issues!.push({
            id: 'unresolved-value',
            kind: 'uncertain_reading',
            field: 'valueText',
            prompt: 'Unresolved literal value',
            blocking: true,
            status: 'unresolved',
            locator: 'page 1',
            questionId: null,
          });
          return feed;
        },
      }),
      /unresolved clinical questions/,
    );
    assert.equal(identityConfirmations.length, 0);
    assert.equal(clinicalAcceptanceWrites, 0);
    const result = await performQualificationAcceptance(options);
    assert.ok(
      identityConfirmations.length > 0,
      'unknown subjects require real scoped confirmation before acceptance',
    );
    assert.ok(clinicalAcceptanceWrites > 0);
    assert.equal(result.acceptedGrade.stage, 'accepted');
    assert.equal(result.passed, true);
    assert.equal(result.selectedRecords, 64);
    assert.equal(result.acceptedGrade.exactRecords, 64);
    assert.equal(app.manager.opened.get(profile.id)!.metrics.cacheHit, false);
    assert.equal(result.receiptReplayed, true);
    assert.equal(result.originalUnchanged, true);
  },
);
