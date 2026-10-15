/** Real catalog/tree and contributor durability, explicitly synthetic desired
 * identity rows. These cases do not claim native policy/model reachability. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import type { IntakeIdentityScopeReference } from '../../shared/intake-identity.ts';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability, rebuildProfile } from '../portable.ts';
import { createBackup } from '../recovery.ts';
import { uploadIntake, updateIntakeMetadataRead } from '../intake.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import {
  createReportSnapshotCatalog,
  type ReportSnapshotCatalog,
} from '../intake-report-snapshot-catalog.ts';
import {
  createIdentitySnapshotDelta,
  identitySnapshotDeltaCertificate,
  type IdentitySnapshotDelta,
} from '../intake-identity-snapshot-delta.ts';
import {
  currentIdentityScopeAlias,
  exactIdentityScopeAlias,
  identityCompleteSnapshotId,
  identityEvidenceAliasId,
  identityScopeAliasMatches,
  publishIdentityScopeAlias,
  type IdentityScopeAlias,
} from '../intake-identity-snapshot-alias.ts';
import { identityScopeCommitmentsWork } from '../intake-identity-commitment.ts';
import { retainIdentityWarningContent } from '../intake-identity-warnings-snapshot.ts';
import {
  IDENTITY_SNAPSHOT_FORMAT,
  identitySnapshotScopeMatches,
  openIdentityScopeSnapshot,
} from '../intake-identity-snapshot.ts';
import { schemaOrdinal } from '../intake-envelope-schema.ts';
import { canonicalLiteral } from '../intake-format.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function run<T>(work: Generator<void, T, void>) {
  let step = work.next(),
    steps = 0;
  while (!step.done) {
    if (++steps % 16 === 0) await setImmediate();
    step = work.next();
  }
  return step.value;
}

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-identity-alias-')),
    profileId = 'fictional-alias-owner',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId),
    recovered: DatabaseSync[] = [];
  t.after(() => {
    for (const connection of recovered) if (connection.isOpen) connection.close();
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  attachPersonalDurability(db, { root, profileId });
  const original = uploadIntake(db, root, profileId, {
    filename: 'fictional-alias.txt',
    bytes: Buffer.from('Fictional synthetic identity owner\nPatient: Fictional Fern Valley'),
    newProviderName: 'Invented Alias Clinic',
  });
  await buildIntakeCollectionEnvelope(db, { id: original.id });
  const sourceHash = selectedEnvelopeStore(db, { id: original.id }).source.sha256;
  assert.ok(sourceHash);
  assert.match(sourceHash, /^[a-f0-9]{64}$/);
  const boundary = {
    profileId,
    intakeId: original.id,
    groupId: 'fictional-synthetic-group',
    sourceHash,
  };
  return { root, profileId, db, original, boundary, recovered };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const catalogFor = (f: Fixture, area: 'logical' | 'builds' = 'builds') =>
  createReportSnapshotCatalog(f.db, { id: f.original.id }, { catalogArea: area });
async function acceptCatalog(f: Fixture, catalog: ReportSnapshotCatalog) {
  await runExclusiveClinicalOperation(f.db, async () => {
    const changes = await catalog.finalChanges(),
      collections = selectedEnvelopeStore(f.db, { id: f.original.id }).collections;
    assert.ok(changes.length);
    const operationId = randomUUID();
    const prepared = collections.prepare(collections.openView(), {
      operationId,
      requestDigest: sha(operationId),
      domainVersion: intakeSourceVersion(f.db, f.original.id).rawVersion,
      changes,
    });
    if (changes.some((change) => change.area === 'logical'))
      transaction(f.db, () => collections.stage(prepared));
    else collections.commitMaintenance(prepared);
  });
}

function desired(
  f: Fixture,
  input: {
    questions: number;
    changed?: number;
    target?: boolean;
    warningBirthDate?: string;
    choices?: string[];
    intakeVersion?: number;
  },
) {
  const target = {
      candidateId: 'fictional-candidate',
      candidateVersionId: 'fictional-candidate-version',
      proposalId: null,
      recordId: 'fictional-record',
      title: 'Fictional target',
      issueId: 'fictional-issue',
      issueIds: ['fictional-issue'],
    },
    targets = input.target === false ? [] : [target],
    questions = Array.from({ length: input.questions }, (_, n) => ({
      prompt: n === input.changed ? 'Fictional changed scalar ' + n : 'Fictional question ' + n,
      textAnchor: 'Fictional anchor ' + n,
    })),
    warnings = [
      {
        kind: 'model_birth_date_mismatch' as const,
        modelBirthDate: '1990-01-01',
        savedBirthDate: input.warningBirthDate ?? '1991-01-01',
        personName: 'Fictional Fern Valley',
      },
    ],
    header = {
      ...f.boundary,
      intakeVersion: input.intakeVersion ?? intakeSourceVersion(f.db, f.original.id).rawVersion,
      selfVersion: 0,
      groupVersionId: 'fictional-synthetic-group-version',
      memberId: null,
      original: { filename: 'fictional-alias.txt', contentUrl: '/api/fictional-original', page: 1 },
      report: { locator: 'page 1 report', text: 'Fictional synthetic report' },
      subject: { locator: 'page 1 patient', text: 'Patient: Fictional Fern Valley' },
      verificationMode: 'literal_text_match' as const,
      ...(input.choices ? { birthDateReview: { choices: input.choices } } : {}),
    },
    sections = {
      membership: [canonicalLiteral([])],
      targets: [canonicalLiteral(targets)],
      assignmentTargets: [canonicalLiteral([])],
      ...(questions.length ? { questions: [canonicalLiteral(questions)] } : {}),
    },
    commitments = identityScopeCommitmentsWork({
      header,
      sections,
      sourceHash: f.boundary.sourceHash,
      warnings: [canonicalLiteral(warnings)],
    });
  let step = commitments.next();
  while (!step.done) step = commitments.next();
  const hashes = step.value,
    scope: IntakeIdentityScopeReference = {
      ...header,
      format: 'health-intake-identity-scope-v2',
      scopeToken: hashes.scopeToken,
      collection: {
        snapshotId: 'identity:' + hashes.scopeToken,
        membership: 0,
        targets: targets.length,
        assignmentTargets: 0,
        questions: questions.length,
        competingSubjects: 0,
      },
    };
  return { scope, targets, questions, warnings, ...hashes };
}
type Desired = ReturnType<typeof desired>;

async function emit(delta: IdentitySnapshotDelta, data: Desired) {
  await delta.put('$format', IDENTITY_SNAPSHOT_FORMAT);
  await delta.putText('$scope', () => [JSON.stringify(data.scope)]);
  await delta.put('$warningCount', String(data.warnings.length));
  for (let n = 0; n < data.targets.length; n++) {
    const target = data.targets[n]!,
      key = 'targets:' + schemaOrdinal(n),
      { issueIds, ...header } = target;
    await delta.put(key, canonicalLiteral(target));
    await delta.put(
      'targetHeader:' + key,
      JSON.stringify({
        ...header,
        hasIssueIds: true,
        issueCount: issueIds.length,
        hasIssueLookup: true,
      }),
    );
    for (let ordinal = 0; ordinal < issueIds.length; ordinal++) {
      await delta.put(
        'targetIssue:' + key + ':' + schemaOrdinal(ordinal),
        JSON.stringify(issueIds[ordinal]),
      );
      await delta.put('targetLookup:' + key + ':' + sha(issueIds[ordinal]!), '1');
    }
  }
  for (let n = 0; n < data.questions.length; n++) {
    const text = canonicalLiteral(data.questions[n]);
    await delta.put('questions:' + schemaOrdinal(n), text);
    await delta.put('questionHash:' + schemaOrdinal(n), sha(text));
  }
  for (let n = 0; n < data.warnings.length; n++)
    await delta.put('warnings:' + schemaOrdinal(n), canonicalLiteral(data.warnings[n]));
}

async function publish(
  f: Fixture,
  catalog: ReportSnapshotCatalog,
  data: Desired,
  prior?: IdentityScopeAlias,
) {
  const warningContent = await retainIdentityWarningContent({
      db: f.db,
      catalog,
      digest: data.warningsSha256,
      count: data.warnings.length,
      priorContent: prior?.warningContent,
      rows: data.warnings.map((value) => ({ chunks: () => [canonicalLiteral(value)] })),
      run,
    }),
    writer = prior ? await catalog.forkReference(prior.snapshot) : await catalog.fork(),
    delta = createIdentitySnapshotDelta({ db: f.db, writer }),
    before = { ...intakeWorkCounters(f.db).warm };
  try {
    await emit(delta, data);
    await delta.finishCleanup();
    const after = intakeWorkCounters(f.db).warm,
      work = {
        questions: data.questions.length,
        desiredRows:
          after.identitySnapshotDeltaDesiredRows - before.identitySnapshotDeltaDesiredRows,
        changedRows:
          after.identitySnapshotDeltaChangedRows - before.identitySnapshotDeltaChangedRows,
        deletedRows:
          after.identitySnapshotDeltaDeletedRows - before.identitySnapshotDeltaDeletedRows,
        checkpointChanges:
          after.reportSnapshotCheckpointChanges - before.reportSnapshotCheckpointChanges,
        treeNodesWritten: after.collectionNodesWritten - before.collectionNodesWritten,
        treeBytesWritten: after.collectionWrittenBytes - before.collectionWrittenBytes,
      };
    await catalog.publish(
      identityCompleteSnapshotId(data.evidenceCommitment.sha256, data.scopeToken),
      writer,
    );
    const snapshot = catalog.open(
      identityCompleteSnapshotId(data.evidenceCommitment.sha256, data.scopeToken),
    )!;
    await delta.certify(snapshot);
    assert.ok(identitySnapshotDeltaCertificate(snapshot));
    const alias = await publishIdentityScopeAlias({
      db: f.db,
      catalog,
      snapshot,
      warningContent,
      scope: data.scope,
      proof: data.evidenceCommitment,
      originalSourceHash: f.boundary.sourceHash,
      warningsSha256: data.warningsSha256,
      warningCount: data.warnings.length,
      run,
    });
    if (!catalog.open(data.scope.collection.snapshotId))
      await catalog.publish(
        data.scope.collection.snapshotId,
        await catalog.forkReference(snapshot),
      );
    await catalog.bindCurrentIdentityScope(f.boundary.groupId, alias.reader);
    return { alias, work };
  } finally {
    delta.close();
  }
}

// Primary/derived scope bytes are produced here, not by identity policy. Work
// assertions count accepted changed KVs; physical contributor IO is not inferred.
test(
  'real catalog synthetic scalar and tail edits publish only changed keys at small and large scope sizes',
  { timeout: 120000 },
  async (t) => {
    const observations = [];
    for (const size of [8, 192]) {
      const f = await fixture(t);
      let catalog = catalogFor(f);
      const initial = desired(f, { questions: size });
      await publish(f, catalog, initial);
      await acceptCatalog(f, catalog);
      catalog = catalogFor(f);
      const prior = currentIdentityScopeAlias(catalog, f.boundary)!;
      const scalar = desired(f, { questions: size, changed: Math.floor(size / 2) }),
        edited = await publish(f, catalog, scalar, prior);
      assert.equal(edited.work.changedRows, 3); // $scope, primary question, its derived hash.
      assert.equal(edited.work.deletedRows, 0);
      assert.equal(edited.work.checkpointChanges, 3);
      assert.equal(
        prior.snapshot.get('questions:' + schemaOrdinal(Math.floor(size / 2))),
        canonicalLiteral(initial.questions[Math.floor(size / 2)]),
      );
      await acceptCatalog(f, catalog);
      catalog = catalogFor(f);
      const changedPrior = currentIdentityScopeAlias(catalog, f.boundary)!,
        removed = desired(f, { questions: size - 1, changed: Math.floor(size / 2), target: false }),
        shortened = await publish(f, catalog, removed, changedPrior);
      assert.equal(shortened.work.changedRows, 1); // The small version-bound display header.
      assert.equal(shortened.work.deletedRows, 6); // question/hash tail + all four target/derived cells.
      assert.equal(shortened.work.checkpointChanges, 7);
      assert.equal(
        shortened.alias.snapshot.get('questionHash:' + schemaOrdinal(size - 1)),
        undefined,
      );
      assert.equal(
        shortened.alias.snapshot.get(
          'targetLookup:targets:' + schemaOrdinal(0) + ':' + sha('fictional-issue'),
        ),
        undefined,
      );
      assert.equal(
        changedPrior.snapshot.get(
          'targetLookup:targets:' + schemaOrdinal(0) + ':' + sha('fictional-issue'),
        ),
        '1',
      );
      observations.push({ size, scalar: edited.work, removal: shortened.work });
      await acceptCatalog(f, catalog);
    }
    t.diagnostic(
      JSON.stringify({
        syntheticOwnerChangedRowConstructionWork: observations,
        interval:
          'after main fork through desired puts and cleanup; excludes warning owner, fork, certification, alias and catalog publication',
      }),
    );
  },
);

test(
  'real catalog alias certificates require immutable exact namespaces and reject missing or extra derived keys',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      catalog = catalogFor(f),
      data = desired(f, { questions: 4 }),
      valid = await publish(f, catalog, data),
      writer = await catalog.forkReference(valid.alias.snapshot),
      delta = createIdentitySnapshotDelta({ db: f.db, writer });
    try {
      await emit(delta, data);
      await delta.finishCleanup();
      await delta.certify(writer);
      assert.throws(() => identitySnapshotDeltaCertificate(writer), /Mutable identity snapshot/);
      for (const kind of ['missing', 'extra', 'same-count-swap']) {
        const malformed = await catalog.forkReference(valid.alias.snapshot),
          expected = 'targetLookup:targets:' + schemaOrdinal(0) + ':' + sha('fictional-issue');
        if (kind !== 'extra') await malformed.delete(expected);
        if (kind !== 'missing')
          await malformed.put(
            'targetLookup:targets:' + schemaOrdinal(0) + ':' + sha('fictional-unexpected'),
            '1',
          );
        const id = 'fictional-malformed-' + kind;
        await catalog.publish(id, malformed);
        const retained = catalog.open(id)!;
        await assert.rejects(delta.certify(retained), /namespace|Unexpected|missing|changed/);
        assert.throws(() => identitySnapshotDeltaCertificate(retained), /not certified/);
        const before = intakeWorkCounters(f.db).warm.identitySnapshotAliasesWritten;
        await assert.rejects(
          publishIdentityScopeAlias({
            db: f.db,
            catalog,
            snapshot: retained,
            warningContent: valid.alias.warningContent,
            scope: data.scope,
            proof: data.evidenceCommitment,
            originalSourceHash: f.boundary.sourceHash,
            warningsSha256: data.warningsSha256,
            warningCount: 1,
            run,
          }),
          /not certified/,
        );
        assert.equal(intakeWorkCounters(f.db).warm.identitySnapshotAliasesWritten, before);
      }
      const selected = exactIdentityScopeAlias(catalog, f.boundary, data.evidenceCommitment)!;
      assert.ok(identitySnapshotScopeMatches(selected.snapshot, data.scope));
      assert.equal(selected.proof.sha256, data.evidenceCommitment.sha256);
    } finally {
      delta.close();
    }
  },
);

// Deliberate owner-tree corruption bypasses the immutable catalog API only in
// this fixture. It is neither supported publication nor physical disk damage.
async function corruptAliasMapping(f: Fixture, id: string, fromKey?: string) {
  await runExclusiveClinicalOperation(f.db, async () => {
    const collections = selectedEnvelopeStore(f.db, { id: f.original.id }).collections,
      operationId = randomUUID(),
      auxiliary = 'fictional.alias.corruption.' + operationId;
    if (fromKey) {
      const value = collections.getCollectionReference(
        collections.openView(),
        'builds',
        'report.snapshots',
        fromKey,
      );
      assert.ok(value);
      collections.commitMaintenance(
        collections.prepare(collections.openView(), {
          operationId,
          requestDigest: sha(operationId),
          domainVersion: intakeSourceVersion(f.db, f.original.id).rawVersion,
          changes: [
            { area: 'builds', collection: auxiliary, op: 'adoptReferenced', value },
            {
              area: 'builds',
              collection: 'report.snapshots',
              op: 'putCollection',
              key: id,
              fromArea: 'builds',
              fromCollection: auxiliary,
            },
          ],
        }),
      );
    } else
      collections.commitMaintenance(
        collections.prepare(collections.openView(), {
          operationId,
          requestDigest: sha(operationId),
          domainVersion: intakeSourceVersion(f.db, f.original.id).rawVersion,
          changes: [{ area: 'builds', collection: 'report.snapshots', op: 'delete', key: id }],
        }),
      );
  });
}

test(
  'present real catalog locators with missing named alias or missing children refuse instead of becoming a cache miss',
  { timeout: 30000 },
  async (t) => {
    for (const missing of ['named-alias', 'snapshot-child', 'warning-child']) {
      const f = await fixture(t),
        data = desired(f, { questions: 1 });
      let catalog = catalogFor(f);
      await publish(f, catalog, data);
      await acceptCatalog(f, catalog);
      catalog = catalogFor(f);
      const control = currentIdentityScopeAlias(catalog, f.boundary)!;
      assert.ok(control);
      assert.equal(control.proof.sha256, data.evidenceCommitment.sha256);
      identityScopeAliasMatches(control, data.scope, f.boundary.sourceHash, data.warningsSha256, 1);
      assert.ok(identitySnapshotScopeMatches(control.snapshot, data.scope));
      const id = identityEvidenceAliasId(data.evidenceCommitment.sha256),
        metadata = new Map<string, string>(),
        locatorId = 'identity-current:' + sha(f.boundary.groupId),
        locatorBefore = catalog.open(locatorId)!;
      for (const key of [
        '$format',
        '$aliasId',
        '$profileId',
        '$intakeId',
        '$groupId',
        '$sourceHash',
        '$originalSourceHash',
        '$proofFormat',
        '$proofSha256',
        '$warningsSha256',
        '$warningCount',
        '$scopeToken',
        '$intakeVersion',
        '$collectionCounts',
        '$namespaceSha256',
        '$namespaceCount',
      ]) {
        const value = control.reader.get(key);
        assert.equal(typeof value, 'string');
        metadata.set(key, value as string);
      }
      if (missing === 'named-alias') await corruptAliasMapping(f, id);
      else {
        const omitted = missing === 'snapshot-child' ? '$snapshot' : '$warningContent',
          wrapper = await catalog.forkReference(control.reader),
          fromKey = 'fictional-corrupted-' + missing;
        await wrapper.delete(omitted);
        for (const [key, value] of metadata) assert.equal(wrapper.get(key), value);
        assert.equal(wrapper.reference(omitted), undefined);
        const retainedChild = omitted === '$snapshot' ? '$warningContent' : '$snapshot';
        assert.equal(
          wrapper.reference(retainedChild)!.get('$format'),
          control.reader.reference(retainedChild)!.get('$format'),
        );
        await catalog.publish(fromKey, wrapper);
        await acceptCatalog(f, catalog);
        await corruptAliasMapping(f, id, fromKey);
      }
      const reopened = catalogFor(f),
        retainedLocator = reopened.open(locatorId)!;
      // The locator metadata stayed present and still names the original alias.
      assert.equal(retainedLocator.get('$aliasId'), id);
      assert.equal(retainedLocator.get('$groupId'), f.boundary.groupId);
      if (missing === 'named-alias')
        assert.equal(reopened.identityScopeReuseReader(id, 'builds'), undefined);
      else {
        const damaged = reopened.identityScopeReuseReader(id, 'builds')!.reader,
          omitted = missing === 'snapshot-child' ? '$snapshot' : '$warningContent';
        for (const [key, value] of metadata) assert.equal(damaged.get(key), value);
        assert.equal(damaged.reference(omitted), undefined);
        assert.ok(damaged.reference(omitted === '$snapshot' ? '$warningContent' : '$snapshot'));
      }
      void locatorBefore;
      assert.throws(
        () => currentIdentityScopeAlias(reopened, f.boundary),
        /Invalid retained complete identity scope alias/,
      );
    }
  },
);

test(
  'real catalog permits only reserved same-source logical to build alias reuse and rejects accepted catalog/source drift',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      build = catalogFor(f),
      data = desired(f, { questions: 2 });
    await publish(f, build, data);
    await acceptCatalog(f, build);
    const logical = catalogFor(f, 'logical'),
      id = identityEvidenceAliasId(data.evidenceCommitment.sha256);
    assert.equal(
      logical.open(data.scope.collection.snapshotId),
      undefined,
      'historical receipt snapshot reads do not borrow the optimization bridge',
    );
    const borrowed = logical.identityScopeReuseReader(id)!;
    assert.equal(borrowed.area, 'builds');
    await assert.rejects(
      logical.bindCurrentIdentityScope(
        f.boundary.groupId,
        currentIdentityScopeAlias(logical, f.boundary)!.reader,
      ),
      /Identity locators require/,
    );
    assert.equal(
      currentIdentityScopeAlias(logical, f.boundary)!.proof.sha256,
      data.evidenceCommitment.sha256,
    );
    assert.equal(logical.identityScopeReuseReader(id, 'logical'), undefined);
    assert.throws(
      () => logical.identityScopeReuseReader(data.scope.collection.snapshotId),
      /Invalid identity scope reuse selector/,
    );
    assert.throws(
      () => catalogFor(f).identityScopeReuseReader(id, 'logical'),
      /Foreign identity scope reuse area/,
    );
    const foreign = createReportSnapshotCatalog(
      f.db,
      { id: f.original.id },
      { catalog: 'review.snapshots' },
    );
    assert.throws(
      () => foreign.identityScopeReuseReader(id),
      /Invalid identity scope reuse selector/,
    );
    assert.throws(
      () =>
        currentIdentityScopeAlias(logical, {
          ...f.boundary,
          sourceHash: sha('fictional-other-source'),
        }),
      /Invalid retained/,
    );
    // The borrowed optimization must yield a receipt reader accepted through
    // an ordinary logical catalog publication, not only a selector lookup.
    const logicalWriter = await logical.forkReference(borrowed.reader.reference('$snapshot')!);
    await logical.publish(data.scope.collection.snapshotId, logicalWriter);
    await acceptCatalog(f, logical);
    const acceptedLogical = catalogFor(f, 'logical');
    assert.ok(
      identitySnapshotScopeMatches(
        openIdentityScopeSnapshot(acceptedLogical, data.scope),
        data.scope,
      ),
    );
    const driftLogical = catalogFor(f, 'logical');
    const driftBorrowed = driftLogical.identityScopeReuseReader(id)!;
    const next = catalogFor(f),
      auxiliary = await next.fork();
    await auxiliary.put('$format', 'fictional-accepted-catalog-progress');
    await next.publish('fictional-catalog-progress', auxiliary);
    await acceptCatalog(f, next);
    assert.throws(() => driftLogical.assertCurrent(), /Stale report snapshot/);
    assert.throws(() => driftBorrowed.reader.get('$format'), /Stale report snapshot/);
    const beforeSourceChange = catalogFor(f);
    await updateIntakeMetadataRead(f.db, f.root, f.profileId, f.original.id, {
      version: intakeSourceVersion(f.db, f.original.id).rawVersion,
      operationId: 'fictional-alias-metadata-progress',
      metadata: { topics: ['Independently fictional source change'] },
    });
    assert.throws(() => beforeSourceChange.assertCurrent(), /Stale report snapshot|Stale|source/);
  },
);

test(
  'synthetic supported wide scope and same-token warning aliases retain old main evidence through contributor recovery',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t),
      choices = Array.from({ length: 24000 }, (_, n) =>
        new Date(Date.UTC(1800, 0, n + 1)).toISOString().slice(0, 10),
      );
    let catalog = catalogFor(f);
    const data = desired(f, { questions: 2, choices });
    assert.ok(Buffer.byteLength(JSON.stringify(data.scope)) > 256 * 1024);
    const initial = await publish(f, catalog, data);
    assert.ok(identitySnapshotScopeMatches(initial.alias.snapshot, data.scope));
    await acceptCatalog(f, catalog);
    catalog = catalogFor(f);
    const prior = currentIdentityScopeAlias(catalog, f.boundary)!,
      warningChanged = desired(f, { questions: 2, choices, warningBirthDate: '1992-01-01' });
    assert.equal(warningChanged.scopeToken, data.scopeToken);
    assert.notEqual(warningChanged.evidenceCommitment.sha256, data.evidenceCommitment.sha256);
    const edited = await publish(f, catalog, warningChanged, prior);
    assert.equal(edited.work.changedRows, 1);
    assert.equal(edited.work.deletedRows, 0);
    assert.equal(edited.work.checkpointChanges, 1);
    const historical = openIdentityScopeSnapshot(catalog, data.scope);
    assert.equal(
      [...historical.chunks('warnings:' + schemaOrdinal(0))].join(''),
      canonicalLiteral(data.warnings[0]),
    );
    assert.equal(
      [...edited.alias.snapshot.chunks('warnings:' + schemaOrdinal(0))].join(''),
      canonicalLiteral(warningChanged.warnings[0]),
    );
    const versionOnly = desired(f, {
      questions: 2,
      choices,
      warningBirthDate: '1992-01-01',
      intakeVersion: data.scope.intakeVersion + 1,
    });
    assert.deepEqual(versionOnly.evidenceCommitment, warningChanged.evidenceCommitment);
    identityScopeAliasMatches(
      edited.alias,
      versionOnly.scope,
      f.boundary.sourceHash,
      versionOnly.warningsSha256,
      1,
    );
    await acceptCatalog(f, catalog);
    const smallFixture = {
        ...f,
        boundary: { ...f.boundary, groupId: 'fictional-rebuilt-small-group' },
      },
      smallData = desired(smallFixture, { questions: 2 });
    const beforeBackupCatalog = catalogFor(f);
    await publish(smallFixture, beforeBackupCatalog, smallData);
    await acceptCatalog(f, beforeBackupCatalog);
    const backup = await createBackup(f.db, f.root, f.profileId),
      target = join(f.root, 'recovered'),
      rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
      recovered = openDatabase(rebuilt.database, f.profileId);
    f.recovered.push(recovered);
    attachPersonalDurability(recovered, {
      root: target,
      profileId: f.profileId,
      initialize: false,
    });
    // New database connection and rebuilt cache retain the accepted contributor authority.
    const restoredCatalog = createReportSnapshotCatalog(
        recovered,
        { id: f.original.id },
        { catalogArea: 'builds' },
      ),
      restored = currentIdentityScopeAlias(restoredCatalog, f.boundary)!;
    assert.equal(restored.proof.sha256, warningChanged.evidenceCommitment.sha256);
    assert.ok(identitySnapshotScopeMatches(restored.snapshot, warningChanged.scope));
    identityScopeAliasMatches(
      restored,
      versionOnly.scope,
      f.boundary.sourceHash,
      versionOnly.warningsSha256,
      1,
    );
    assert.equal(
      [
        ...openIdentityScopeSnapshot(restoredCatalog, data.scope).chunks(
          'warnings:' + schemaOrdinal(0),
        ),
      ].join(''),
      canonicalLiteral(data.warnings[0]),
    );
    const recoveredFixture = { ...smallFixture, db: recovered, root: target },
      recoveredPrior = currentIdentityScopeAlias(restoredCatalog, recoveredFixture.boundary)!,
      recoveredEdit = desired(recoveredFixture, { questions: 2, changed: 0 }),
      recoveredPublication = await publish(
        recoveredFixture,
        restoredCatalog,
        recoveredEdit,
        recoveredPrior,
      );
    assert.equal(recoveredPublication.work.changedRows, 3);
    assert.equal(recoveredPublication.work.deletedRows, 0);
    assert.equal(recoveredPublication.work.checkpointChanges, 3);
    await acceptCatalog(recoveredFixture, restoredCatalog);
    const finalCatalog = catalogFor(recoveredFixture);
    assert.equal(
      currentIdentityScopeAlias(finalCatalog, recoveredFixture.boundary)!.proof.sha256,
      recoveredEdit.evidenceCommitment.sha256,
    );
    assert.equal(
      currentIdentityScopeAlias(finalCatalog, f.boundary)!.proof.sha256,
      warningChanged.evidenceCommitment.sha256,
    );
    t.diagnostic(
      JSON.stringify({
        syntheticWideScope: {
          bytes: Buffer.byteLength(JSON.stringify(data.scope)),
          choices: choices.length,
          policyReachability: 'unproven',
          publicationEvidence:
            'this synthetic fixture verifies retained scope and warning content through recovery; byte-leaf locality is measured separately',
          recoveredChangedRowConstructionWork: recoveredPublication.work,
          recovery: 'contributor backup and rebuilt cache',
        },
      }),
    );
  },
);
