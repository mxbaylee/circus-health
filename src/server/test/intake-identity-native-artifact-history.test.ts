import { readIntakeEnvelopeText } from '../intake-authority.ts';
import {
  registerIntakeFile,
  intakeSourceVersion,
  type IntakeDetails,
} from '../intake-state-access.ts';
import {
  intakeCandidateId,
  intakeCandidateVersionIdForRevision,
  workflowHash,
} from '../intake-workflow.ts';
import { canonicalLiteral, validateJSONL, validationSummary } from '../intake-format.ts';
import { createIntakeFileWorkCounters, withIntakeFileWork } from '../intake-file-work.ts';
import { intakeFileIdentity } from '../intake-files.ts';
import { setImmediate } from 'node:timers/promises';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { getNativeIntakeIdentityReview } from '../intake-identity-native.ts';
import { reviewIssueScratchCounts } from '../intake-review-issue-state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync, writeFileSync, lstatSync, renameSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { profileOriginal } from '../profile-storage.ts';
import { intakeTransaction } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { prepareIntakeWorkflowCommand } from '../intake-workflow-command.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { nativeIdentityPreviewCounts } from '../intake-identity-preview-cache.ts';
import type { IntakeIdentityScope } from '../../shared/intake-identity.ts';
import { fixture, envelope } from './intake-identity-native-fixture.ts';

// This fixture converts its small seed, then publishes genuine retained JSONL
// history through one supported native workflow command.
// Its historical member is intentionally not the candidate's latest version:
// identity clinical preparation may skip it, but artifact verification may not.
async function artifactHistoryFixture(t: test.TestContext) {
  const f = await fixture(t, false, 1),
    raw = JSON.parse(readIntakeEnvelopeText(f.db, { id: f.original.id })),
    details = raw.intake as IntakeDetails,
    seedCandidate = details.workflow!.candidates[0]!,
    group = details.workflow!.reportGroups!.find((value) => value.id === f.groupId)!,
    seedGroupVersion = group.versions.at(-1)!,
    seedVersion = seedCandidate.versions.at(-1)!,
    oldRecord = envelope('fictional-history');
  oldRecord.payload = { literal: '11.00' };
  oldRecord.clinical = {
    ...(oldRecord.clinical as Record<string, unknown>),
    valueText: '11.00',
  };
  const latestRecord = structuredClone(oldRecord);
  latestRecord.payload = { literal: '12.00' };
  latestRecord.clinical = {
    ...(latestRecord.clinical as Record<string, unknown>),
    valueText: '12.00',
  };
  const oldVersionId = intakeCandidateVersionIdForRevision({
      value: oldRecord,
    }),
    latestVersionId = intakeCandidateVersionIdForRevision({
      value: latestRecord,
    }),
    originalFile = f.db
      .prepare('SELECT id,sha256,provider_id FROM source_files WHERE id=?')
      .get(f.original.id)!,
    historyCandidateId = intakeCandidateId(
      { id: String(originalFile.id), sha256: String(originalFile.sha256) },
      { value: oldRecord },
    ),
    proposal = details.proposals[0]!,
    firstPath = String(
      f.db.prepare('SELECT path FROM source_files WHERE id=?').get(proposal.id)!.path,
    ),
    proposalDirectory = dirname(profileOriginal(f.root, firstPath, f.profileId)),
    artifacts: { id: string; path: string; bytes: number }[] = [],
    occurrences: typeof seedVersion.occurrences = [];
  let latestOccurrence: (typeof occurrences)[number] | undefined;
  assert.notEqual(oldVersionId, latestVersionId);
  assert.notEqual(historyCandidateId, seedCandidate.id);
  assert.equal(proposal.sourceTextRevisionId ?? null, null);
  assert.equal(proposal.sourceTextDependencyToken ?? null, null);
  assert.equal(seedGroupVersion.members.length, 1);
  await buildIntakeCollectionEnvelope(f.db, { id: f.original.id });
  intakeTransaction(
    f.db,
    () => {
      for (let n = 0; n < 256; n++) {
        const id = 'proposal:fictional-artifact-' + n,
          path = firstPath.slice(0, firstPath.lastIndexOf('/') + 1) + 'artifact-' + n + '.jsonl',
          value = n === 255 ? latestRecord : oldRecord,
          bytes = Buffer.from(
            JSON.stringify(value) +
              '\n' +
              (n === 0 ? (' '.repeat(1024 * 1024) + '\n').repeat(8) : ' '.repeat(1024 + n) + '\n'),
          ),
          validation = validationSummary(validateJSONL(bytes));
        assert.equal(validation.valid, true, JSON.stringify(validation.issues));
        writeFileSync(join(proposalDirectory, 'artifact-' + n + '.jsonl'), bytes);
        registerIntakeFile(f.db, {
          id,
          providerId: String(originalFile.provider_id),
          path,
          bytes,
          kind: 'intake_proposal',
          mimeType: 'application/x-ndjson',
          coverage: 'derived_proposal; unreviewed',
          details: { originalSourceFileId: f.original.id, validation },
        });
        // Preserve every required descriptor and its complete real validation;
        // absent optional model/source-pin fields need no copied null entries.
        details.proposals.push({
          id,
          fileId: id,
          summary: 'Fictional retained history',
          createdAt: proposal.createdAt,
          runId: null,
          validation,
          contentUrl: '/api/sources/' + encodeURIComponent(id) + '/content',
        });
        const occurrence = {
          proposalId: id,
          recordId: id + ':line:1',
          batchId: null,
          locator: value.provenance.locator,
        };
        if (n === 255) latestOccurrence = occurrence;
        else occurrences.push(occurrence);
        artifacts.push({
          id,
          path: profileOriginal(f.root, path, f.profileId),
          bytes: bytes.length,
        });
      }
    },
    {},
  );
  assert.ok(latestOccurrence);
  for (let n = 0; n < 192; n++) occurrences.push({ ...occurrences[0]! });
  const historicalVersion = {
      ...seedVersion,
      id: oldVersionId,
      contentDigest: workflowHash(canonicalLiteral(oldRecord)),
      status: 'superseded' as const,
      occurrences,
    },
    latestVersion = {
      ...seedVersion,
      id: latestVersionId,
      contentDigest: workflowHash(canonicalLiteral(latestRecord)),
      status: 'pending' as const,
      occurrences: [latestOccurrence],
    },
    historyCandidate = {
      id: historyCandidateId,
      envelopeId: oldRecord.id,
      sourceSystem: oldRecord.provenance.sourceSystem,
      sourceRecordId: oldRecord.provenance.sourceRecordId,
      versions: [historicalVersion, latestVersion],
    },
    nextMembers = [
      {
        candidateId: historyCandidateId,
        candidateVersionId: oldVersionId,
        occurrences,
      },
      {
        candidateId: historyCandidateId,
        candidateVersionId: latestVersionId,
        occurrences: [latestOccurrence],
      },
      ...seedGroupVersion.members,
    ],
    contributionId = 'fictional-artifact-history-contribution',
    nextGroupVersion = {
      ...seedGroupVersion,
      contributionId,
      id: 'report-group-version:' + workflowHash([group.id, contributionId, nextMembers]),
      members: nextMembers,
    };
  assert.equal(
    f.db.prepare("SELECT count(*) AS count FROM source_files WHERE kind='intake_proposal'").get()!
      .count,
    257,
  );
  assert.equal(new Set(details.proposals.map((value) => value.id)).size, 257);
  const prepared = await prepareIntakeWorkflowCommand(
    f.db,
    { id: f.original.id },
    {
      version: intakeSourceVersion(f.db, f.original.id).version,
      operationId: 'fictional-artifact-history',
      request: {
        proposalIds: details.proposals.slice(1).map((value) => value.id),
        groupVersionId: nextGroupVersion.id,
      },
      createdAt: '2026-01-01T00:00:00Z',
      changes: function* ({ reader, intake, workflow }) {
        const groupRecord = reader.find('reportGroup', workflow, group.id);
        assert.ok(groupRecord);
        for (const descriptor of details.proposals.slice(1))
          yield {
            op: 'append' as const,
            record: intake,
            field: 'proposals',
            jsonText: JSON.stringify(descriptor),
          };
        yield {
          op: 'append' as const,
          record: workflow,
          field: 'candidates',
          jsonText: JSON.stringify(historyCandidate),
        };
        yield {
          op: 'append' as const,
          record: groupRecord,
          field: 'versions',
          jsonText: JSON.stringify(nextGroupVersion),
        };
      },
    },
  );
  if (prepared.replayed) throw Error('Unexpected artifact fixture replay');
  intakeTransaction(
    f.db,
    () => {
      prepared.assertCurrent();
      return selectedEnvelopeStore(f.db, {
        id: f.original.id,
      }).collections.stage(prepared.prepared);
    },
    { operationId: prepared.publicationId, fingerprint: prepared.fingerprint },
  );
  const cold = await f.review();
  assert.ok(cold.scopeReference);
  const stable = await f.review();
  assert.ok(stable.scopeReference);
  assert.equal(nativeIdentityPreviewCounts(f.db).entries, 1);
  assert.equal(stable.scopeReference.collection.membership, 3);
  const membership = await f.request(
    `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${stable.scopeReference.scopeToken}&section=membership&limit=3`,
  );
  assert.equal(membership.total, 3);
  const members: IntakeIdentityScope['membership'] = [];
  for (const [ordinal, item] of membership.items.entries()) {
    if (item.kind === 'value') members.push(item.value);
    else {
      const chunks: Buffer[] = [];
      let offset = 0,
        fragmentCursor = 'start';
      for (;;) {
        const fragment = await f.request(
          `identity-scope-fragment?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${stable.scopeReference.scopeToken}&section=membership&ordinal=${ordinal}&offset=${offset}&cursor=${encodeURIComponent(fragmentCursor)}`,
        );
        chunks.push(Buffer.from(fragment.data, 'base64'));
        if (fragment.complete) {
          assert.equal(fragment.nextCursor, null);
          break;
        }
        assert.ok(fragment.nextOffset > offset);
        assert.ok(typeof fragment.nextCursor === 'string' && fragment.nextCursor.length > 0);
        fragmentCursor = fragment.nextCursor;
        offset = fragment.nextOffset;
      }
      members.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    }
  }
  assert.equal(members.length, 3);
  assert.equal(members[0]!.candidateVersionId, oldVersionId);
  // Count complete native membership by its public retained occurrence pages;
  // do not infer reachability from the setup's in-memory envelope alone.
  assert.equal(members[0]!.occurrences.length, occurrences.length);
  assert.equal(
    members.reduce((total, member) => total + member.occurrences.length, 0),
    449,
  );
  assert.equal(members[1]!.candidateVersionId, latestVersionId);
  assert.equal(members[2]!.candidateVersionId, seedVersion.id);
  assert.deepEqual(
    new Set(members.flatMap((member) => member.occurrences.map((value) => value.proposalId))),
    new Set(details.proposals.map((value) => value.id)),
  );
  const totalBytes = Number(
    f.db
      .prepare(
        "SELECT sum(bytes) AS bytes FROM source_files WHERE kind IN ('intake_original','intake_proposal')",
      )
      .get()!.bytes,
  );
  return {
    ...f,
    artifacts,
    stable,
    totalBytes,
    duplicateEnd: occurrences.length,
    occurrences: occurrences.length + 2,
  };
}

// Genuine 257-file native publication, public warming, cancellation and replacement phases.
// This is a host hang guard, not an interactive latency or model-time target.
test(
  'native warm identity cooperates across 257 retained proposal artifacts and duplicate occurrences',
  { timeout: 450000 },
  async (t) => {
    const f = await artifactHistoryFixture(t);
    // Node's test runner isolates files in child processes. Observe actual allocations
    // in this fixture's process; sibling files' temporary scopes are not ours.
    const allocatedScopes = new Set<string>(),
      scopePrefixes = ['fictional-identity-scope-', 'fictional-identity-delta-'].map((prefix) =>
        join(tmpdir(), prefix),
      ),
      originalMkdtemp = fs.mkdtempSync;
    const allocationObserver = t.mock.method(fs, 'mkdtempSync', ((
      ...args: Parameters<typeof originalMkdtemp>
    ) => {
      const directory = Reflect.apply(originalMkdtemp, fs, args);
      if (scopePrefixes.some((prefix) => String(args[0]).startsWith(prefix)))
        allocatedScopes.add(String(directory));
      return directory;
    }) as typeof originalMkdtemp);
    syncBuiltinESMExports();
    try {
      const scratch = () =>
          [...allocatedScopes]
            .filter((directory) => {
              try {
                lstatSync(directory);
                return true;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
                throw error;
              }
            })
            .sort(),
        baselineScratch = scratch(),
        before = { ...intakeWorkCounters(f.db).warm },
        fileWork = createIntakeFileWorkCounters();
      let complete = false;
      const warm = withIntakeFileWork(fileWork, () =>
        getNativeIntakeIdentityReview(f.db, f.root, f.profileId, f.original.id, f.groupId),
      );
      void warm.then(
        () => {
          complete = true;
        },
        () => {
          complete = true;
        },
      );
      const waitFor = async (
        ready: () => boolean,
        pending: Promise<unknown>,
        finished: () => boolean,
      ) => {
        while (!ready()) {
          t.signal.throwIfAborted();
          if (finished()) {
            await pending;
            assert.fail('verification completed before the required nested checkpoint');
          }
          await setImmediate();
        }
      };
      try {
        await waitFor(
          () => fileWork.streamHashBytes > 256 * 1024,
          warm,
          () => complete,
        );
        assert.ok(
          fileWork.streamHashBytes < f.artifacts[0]!.bytes,
          'a host turn occurs inside the first retained artifact hash, before its payload completes',
        );
        await waitFor(
          () =>
            intakeWorkCounters(f.db).warm.identityPreviewArtifactOccurrences -
              before.identityPreviewArtifactOccurrences >
            256,
          warm,
          () => complete,
        );
        const notes = await fetch(
          new URL(`/api/profiles/${encodeURIComponent(f.profileId)}/notes`, f.base),
        );
        assert.equal(notes.status, 200);
        assert.ok(Array.isArray((await notes.json()).data));
        assert.equal(
          complete,
          false,
          'same-database HTTP completes during duplicate-skipped verification',
        );
        assert.ok(
          intakeWorkCounters(f.db).warm.identityPreviewArtifactOccurrences -
            before.identityPreviewArtifactOccurrences <
            f.duplicateEnd,
        );
        // HTTP presentation adds the profile prefix; the internal verifier keeps
        // its domain URL. Assert both exact routes and compare every other field.
        const expectedWarm = structuredClone(f.stable);
        assert.ok(expectedWarm.scopeReference);
        assert.equal(
          expectedWarm.scopeReference.original.contentUrl,
          `/api/profiles/${encodeURIComponent(f.profileId)}/sources/${encodeURIComponent(f.original.id)}/content`,
        );
        expectedWarm.scopeReference.original.contentUrl = `/api/sources/${encodeURIComponent(f.original.id)}/content`;
        assert.deepEqual(await warm, expectedWarm);
      } finally {
        await warm.catch(() => undefined);
      }
      const after = intakeWorkCounters(f.db).warm;
      assert.equal(after.identityPreviewFullPreparations, before.identityPreviewFullPreparations);
      assert.equal(
        after.identityPreviewArtifactOccurrences - before.identityPreviewArtifactOccurrences,
        f.occurrences,
      );
      assert.equal(after.identityPreviewArtifactChecks - before.identityPreviewArtifactChecks, 258);
      assert.ok(
        fileWork.streamHashBytes > 0,
        '257 distinct proposals exceed the shared 256-file verification cache',
      );
      assert.equal(fileWork.streamReadBytes, fileWork.streamHashBytes);
      assert.ok(
        fileWork.streamHashBytes <= f.totalBytes,
        'final physical proof never rehashes the already verified payloads',
      );
      assert.deepEqual(scratch(), baselineScratch);
      assert.deepEqual(reviewIssueScratchCounts(f.db), {
        databases: 0,
        scopes: 0,
        rows: 0,
      });
      t.diagnostic(JSON.stringify({ artifacts: 257, occurrences: f.occurrences, fileWork }));

      // Abort the sole HTTP subscriber inside actual verification, then wait for
      // the next owner to prove abandoned scratch and work are completely drained.
      const controller = new AbortController(),
        cancelBefore = { ...intakeWorkCounters(f.db).warm };
      let cancelComplete = false;
      const cancelled = fetch(f.base + 'identity-review?groupId=' + encodeURIComponent(f.groupId), {
        signal: controller.signal,
      });
      void cancelled.then(
        () => {
          cancelComplete = true;
        },
        () => {
          cancelComplete = true;
        },
      );
      const refused = assert.rejects(cancelled, { name: 'AbortError' });
      await waitFor(
        () =>
          intakeWorkCounters(f.db).warm.identityPreviewArtifactOccurrences -
            cancelBefore.identityPreviewArtifactOccurrences >=
          32,
        cancelled,
        () => cancelComplete,
      );
      controller.abort();
      await refused;
      await runExclusiveClinicalOperation(f.db, async () => undefined);
      const stopped = { ...intakeWorkCounters(f.db).warm };
      for (let n = 0; n < 4; n++) await setImmediate();
      assert.equal(
        intakeWorkCounters(f.db).warm.identityPreviewArtifactOccurrences,
        stopped.identityPreviewArtifactOccurrences,
      );
      assert.ok(
        stopped.identityPreviewArtifactOccurrences -
          cancelBefore.identityPreviewArtifactOccurrences <
          f.occurrences,
        'last-subscriber cancellation interrupts unfinished verification',
      );
      assert.equal(
        stopped.identityPreviewFullPreparations,
        cancelBefore.identityPreviewFullPreparations,
      );
      assert.equal(
        stopped.reportSnapshotCheckpointChanges,
        cancelBefore.reportSnapshotCheckpointChanges,
      );
      assert.deepEqual(scratch(), baselineScratch);
      assert.deepEqual(reviewIssueScratchCounts(f.db), {
        databases: 0,
        scopes: 0,
        rows: 0,
      });

      // Replace a verified earlier artifact with identical bytes while later
      // artifacts yield. A forbidden rehash/new baseline would accept its digest;
      // only the original physical identity proves this replacement must refuse.
      assert.equal(nativeIdentityPreviewCounts(f.db).entries, 1);
      const physicalBefore = { ...intakeWorkCounters(f.db).warm },
        stamp = reviewReadStamp(f.db),
        originalBytes = readFileSync(f.artifacts[0]!.path),
        originalIdentity = intakeFileIdentity(f.artifacts[0]!.path),
        displacedPath = f.artifacts[0]!.path + '.before-replacement',
        replacementPath = f.artifacts[0]!.path + '.replacement';
      let displaced = false;
      let physicalComplete = false;
      const changed = f.request(
        'identity-review?groupId=' + encodeURIComponent(f.groupId),
        undefined,
        409,
      );
      void changed.then(
        () => {
          physicalComplete = true;
        },
        () => {
          physicalComplete = true;
        },
      );
      try {
        await waitFor(
          () =>
            intakeWorkCounters(f.db).warm.identityPreviewArtifactChecks -
              physicalBefore.identityPreviewArtifactChecks >=
            32,
          changed,
          () => physicalComplete,
        );
        writeFileSync(replacementPath, originalBytes);
        renameSync(f.artifacts[0]!.path, displacedPath);
        displaced = true;
        renameSync(replacementPath, f.artifacts[0]!.path);
        assert.notEqual(intakeFileIdentity(f.artifacts[0]!.path), originalIdentity);
        assert.deepEqual(readFileSync(f.artifacts[0]!.path), originalBytes);
        assert.equal(reviewReadStamp(f.db), stamp);
        assert.equal((await changed).error.code, 'SOURCE_CHANGED');
        assert.equal(nativeIdentityPreviewCounts(f.db).entries, 0);
        assert.deepEqual(scratch(), baselineScratch);
        assert.deepEqual(reviewIssueScratchCounts(f.db), {
          databases: 0,
          scopes: 0,
          rows: 0,
        });
      } finally {
        await changed.catch(() => undefined);
        if (displaced) renameSync(displacedPath, f.artifacts[0]!.path);
      }
    } finally {
      allocationObserver.mock.restore();
      syncBuiltinESMExports();
    }
  },
);
