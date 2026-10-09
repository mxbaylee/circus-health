import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVaultApp } from '../vault-app.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { getRetainedIntakeOriginalReference } from '../intake.ts';
import type { IntakeIdentityReview } from '../../shared/intake-identity.ts';
import type { IntakeBatch } from '../../shared/intake-batch.ts';
import type { HealthRecordEnvelope } from '../../shared/intake.ts';
import {
  qualificationAnswers,
  qualificationBirthDate,
  qualificationPerson,
  qualificationSourceSystem,
  writeProviderQualificationPdf,
} from '../../scripts/provider-qualification-fixture.ts';
import { readPdfIdentityPageText } from '../intake-pdf-session.ts';
import type { IntakeRead } from '../../shared/intake-summary.ts';
import {
  collectQualificationFeed,
  readQualificationReview,
} from '../../scripts/qualification-intake-read.ts';
import { clearCollectionReportQueues } from '../intake-report-group-collection.ts';
import { clearNativeIdentityPreviews } from '../intake-identity-preview-cache.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';

for (const count of [4, 16] as const) {
  test(
    'actual public feed identity policy borrow equals cold reconstruction at ' + count + ' records',
    { timeout: 120_000 },
    async (t) => {
      const requests: { route: string; work: Record<string, number> }[] = [];
      const identityConfirmations: unknown[] = [];
      let clinicalAcceptanceWrites = 0;
      t.after(() =>
        t.diagnostic(
          JSON.stringify({
            count,
            requests,
            identityConfirmations: identityConfirmations.length,
            clinicalAcceptanceWrites,
          }),
        ),
      );

      // Host-created proposals isolate acceptance mechanics. This makes no provider
      // extraction claim; the live harness must independently pass its oracle first.
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'fictional-owner-observation-')));
      const dataDirectory = join(root, 'data');
      mkdirSync(dataDirectory);
      const app = createVaultApp({
        dataDirectory,
        runtimeDirectory: join(root, 'runtime'),
        assistantOptions: { availability: async () => ({ available: false }) },
      });
      t.after(() => {
        app.close();
        rmSync(root, { recursive: true, force: true });
      });
      await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
      const address = app.server.address();
      assert.ok(address && typeof address === 'object');
      const base = `http://127.0.0.1:${address.port}`;
      const origin = 'http://localhost:5173';
      let cookie = '';
      async function request<T>(path: string, input?: unknown, bytes?: Buffer): Promise<T> {
        if (input !== undefined && path.endsWith('/identity-scope'))
          identityConfirmations.push(input);
        if (input !== undefined && path.endsWith('/report-acceptance')) clinicalAcceptanceWrites++;
        const beforeDb = app.manager.opened.values().next().value?.db;
        const beforeWork = beforeDb
          ? structuredClone(intakeWorkCounters(beforeDb).warm)
          : undefined;
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
          signal: AbortSignal.any([t.signal, AbortSignal.timeout(60_000)]),
        });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        const result = (await response.json()) as { data: T; error?: unknown };
        assert.equal(response.ok, true, `${path}: ${JSON.stringify(result.error)}`);
        const afterDb = app.manager.opened.values().next().value?.db;
        const work: Record<string, number> = {};
        if (beforeWork && beforeDb === afterDb && afterDb) {
          const afterWork = intakeWorkCounters(afterDb).warm;
          for (const key of Object.keys(afterWork) as (keyof typeof afterWork)[]) {
            const delta = afterWork[key] - beforeWork[key];
            if (delta) work[key] = delta;
          }
        }
        requests.push({
          route: path.split('?')[0]!.replace(/intake:[a-z0-9]+/g, 'intake:id'),
          work,
        });
        return result.data;
      }
      const setup = await request<{ setupId: string; recoveryKit: unknown }>(
        '/api/profile-setups',
        {
          name: 'Qualification',
          fullName: qualificationPerson,
          birthDate: qualificationBirthDate,
          placebo: false,
        },
      );
      const profile = await request<{ id: string }>(`/api/profile-setups/${setup.setupId}/verify`, {
        recovery: setup.recoveryKit,
        acknowledged: true,
      });
      const prefix = `/api/profiles/${profile.id}`;
      const path = join(root, 'fictional.pdf');
      writeProviderQualificationPdf(path);
      const uploaded = await request<IntakeRead>(
        prefix + '/intakes',
        undefined,
        readFileSync(path),
      );
      // This fixture supplies its own proposals. Revoke automatic processing before
      // inspecting evidence so a background capture cannot change their source pin.
      const batches = await request<IntakeBatch[]>(prefix + '/intake-batches');
      const owned = batches.filter((batch) =>
        batch.items.some((item) => item.intakeId === uploaded.id),
      );
      assert.equal(owned.length, 1);
      const stopped = await request<IntakeBatch>(
        prefix + `/intake-batches/${owned[0]!.id}/stop`,
        {},
      );
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
        const { text } = await readPdfIdentityPageText(
          { ...reference, profileId: profile.id },
          page,
        );
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
      const proposals: HealthRecordEnvelope[] = qualificationAnswers
        .filter(
          (answer) =>
            qualificationAnswers.filter((other) => other.page === answer.page).indexOf(answer) <
            count / 4,
        )
        .map((answer) => ({
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
            anchor: {
              locator: `page ${answer.page}`,
              text: identityByPage.get(answer.page)!.anchor,
            },
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
      const selectedQuestionRecords = review.records.filter((record) =>
        record.mapping.testLabel?.endsWith('R01'),
      );
      assert.equal(
        selectedQuestionRecords.length,
        4,
        'exact macro stimulus selects one R01 record per page',
      );
      for (const record of selectedQuestionRecords) {
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
      assert.equal(
        requests.filter((item) => item.route.endsWith('/questions')).length,
        4,
        'four actual question POST responses completed',
      );
      assert.equal(review.records.length, count);
      const feed = await collectQualificationFeed(request, prefix);
      assert.equal(
        new Set(
          feed.blocks.flatMap((block) => block.records).map((record) => record.candidateVersionId),
        ).size,
        count,
      );
      const first = feed.blocks.flatMap((block) => block.records)[0]!;
      assert.ok(
        Array.isArray(first.reportGroups),
        'fixture requires complete inline group membership',
      );
      assert.equal(first.reportGroups.length, 1);
      const groupIds = [
        ...new Set(
          feed.blocks
            .flatMap((block) => block.records)
            .flatMap((record) => {
              assert.ok(
                Array.isArray(record.reportGroups),
                'every retained record has complete inline groups',
              );
              return record.reportGroups.map((group) => group.groupId);
            }),
        ),
      ];
      assert.equal(groupIds.length, 4);
      const expectedRetainedName = (groupId: string) => {
        const record = feed.blocks
          .flatMap((block) => block.records)
          .find(
            (item) =>
              Array.isArray(item.reportGroups) &&
              item.reportGroups.some((group) => group.groupId === groupId),
          );
        assert.ok(record, 'identity group has a retained seeded record');
        const answer = qualificationAnswers.find(
          (item) => item.fields.testLabel === record.mapping.testLabel,
        );
        assert.ok(answer, 'retained group maps to the independently seeded page');
        const page = identityByPage.get(answer.page);
        assert.ok(page, 'exact extracted page identity was retained before proposal publication');
        return page.fullName;
      };
      const firstIdentity = await request<IntakeIdentityReview>(
        prefix +
          '/intakes/' +
          uploaded.id +
          '/identity-review?groupId=' +
          encodeURIComponent(groupIds[0]!),
      );
      assert.equal(firstIdentity.self.fullName, qualificationPerson);
      assert.equal(firstIdentity.evidencedIdentity.fullName, expectedRetainedName(groupIds[0]!));
      assert.ok(firstIdentity.scope || firstIdentity.scopeReference);
      const firstWork = requests.at(-1)!.work;
      assert.equal(
        firstWork.collectionQueuePolicyBorrowHits,
        1,
        'actual macro order borrowed its exact completed queue policy once',
      );
      assert.equal(
        firstWork.collectionQueuePolicyBorrowMisses,
        1,
        'real grounding invalidated the owner and required independent second construction',
      );
      assert.equal(
        firstWork.identityPreviewFullPreparations,
        2,
        'both existing identity build passes remain',
      );
      const beforeCold = reviewReadStamp(state.db);
      clearCollectionReportQueues(state.db);
      clearNativeIdentityPreviews(state.db);
      assert.equal(
        reviewReadStamp(state.db),
        beforeCold,
        'cold reconstruction clears only disposable owners, not source authority',
      );
      const reconstructed = await request<IntakeIdentityReview>(
        prefix +
          '/intakes/' +
          uploaded.id +
          '/identity-review?groupId=' +
          encodeURIComponent(groupIds[0]!),
      );
      assert.deepEqual(
        reconstructed,
        firstIdentity,
        'complete exact public identity/scopes/targets/tokens equal independent cold policy',
      );
      const coldWork = requests.at(-1)!.work;
      assert.equal(coldWork.collectionQueuePolicyBorrowHits || 0, 0);
      assert.equal(
        coldWork.collectionQueuePolicyBorrowMisses,
        1,
        'the stable first build constructs its policy once after disposable owners clear',
      );
      assert.equal(coldWork.identityPreviewFullPreparations, 1);
      // Reconstructed output is detached from both earlier output and retained queue policy.
      if (firstIdentity.assignedPerson && reconstructed.assignedPerson) {
        assert.notEqual(firstIdentity.assignedPerson, reconstructed.assignedPerson);
        const exactName = reconstructed.assignedPerson.fullName;
        firstIdentity.assignedPerson.fullName = 'Changed only detached first response';
        assert.equal(reconstructed.assignedPerson.fullName, exactName);
      }
      t.diagnostic(
        JSON.stringify({
          count,
          firstWork,
          coldWork,
          comparison: 'same current authority after grounding; not a matched total-cost baseline',
        }),
      );
      assert.equal(identityConfirmations.length, 0);
      assert.equal(clinicalAcceptanceWrites, 0);
    },
  );
}
