import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { TestContext } from 'node:test';
import { openDatabase, transaction } from '../../database.ts';
import { ensureProfileDirectories } from '../../profile-storage.ts';
import { prepareInitialIntakeEnvelope } from '../../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../../intake-state-storage.ts';
import { buildIntakeCollectionEnvelope } from '../../intake-envelope-build.ts';
import { memoryRecordAuthority } from './intake-authority-fixture.ts';

/** Real selected collection and physical original, with only queue-relevant fictional fields. */
export async function makeNativeQueueFixture(
  t: TestContext,
  count: number,
  mode: 'distinct' | 'shared-member' | 'one-group' | 'duplicate-fallback' = 'distinct',
) {
  if (mode === 'duplicate-fallback' && count !== 4)
    throw Error('Duplicate fallback fixture uses exactly four retained groups');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fictional-native-queue-')));
  const profileId = 'fictional-native-queue';
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  const cleanup = () => {
    if (db.isOpen) {
      clearIntakeStateCache(db);
      db.close();
    }
    rmSync(root, { recursive: true, force: true });
  };
  t.after(cleanup);
  try {
    memoryRecordAuthority(db);
    const sourceId = `fictional-intake-${mode}-${count}`;
    const original = Buffer.from(`Independently fictional original for ${count} report groups.\n`);
    const sourceHash = createHash('sha256').update(original).digest('hex');
    const fullPath = join(paths.sources, `${sourceId}.txt`);
    writeFileSync(fullPath, original);
    const candidateCount = mode === 'shared-member' ? 1 : count;
    const groupCount = mode === 'one-group' ? 1 : count;
    const candidates = Array.from({ length: candidateCount }, (_, index) => ({
      id: `candidate-${index}`,
      versions: [
        {
          id: `candidate-version-${index}`,
          status: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
          occurrences: [{ proposalId: null, recordId: `${sourceId}:line:${index + 1}` }],
        },
      ],
    }));
    const reportGroups = Array.from({ length: groupCount }, (_, index) => ({
      id: `report-group-${index}`,
      discoveryOrder: index,
      basis: 'report_anchor',
      versions: [
        {
          id: `report-version-${index}`,
          createdAt: '2026-01-01T00:00:00.000Z',
          members: (mode === 'one-group'
            ? candidates
            : [candidates[mode === 'shared-member' ? 0 : index]!]
          ).map((candidate) => ({
            candidateId: candidate.id,
            candidateVersionId: candidate.versions[0]!.id,
          })),
        },
      ],
    }));
    if (mode === 'duplicate-fallback') {
      reportGroups[0]!.id = 'report-group-duplicate';
      reportGroups[1]!.id = 'report-group-duplicate';
      reportGroups[1]!.versions[0]!.members[0] = {
        candidateId: candidates[0]!.id,
        candidateVersionId: candidates[0]!.versions[0]!.id,
      };
    }
    const initial = prepareInitialIntakeEnvelope({
      intake: {
        version: 1,
        originalName: `${sourceId}.txt`,
        workflow: {
          format: 'health-intake-workflow-v1',
          questions: [],
          plans: [],
          decisions: [],
          candidates,
          reportGroups,
        },
      },
    });
    transaction(db, () => {
      db.prepare('INSERT INTO providers(id,name) VALUES(?,?)').run(
        'fictional-provider',
        'Fictional clinic',
      );
      db.prepare(
        'INSERT INTO source_files(id,provider_id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?,?)',
      ).run(
        sourceId,
        'fictional-provider',
        relative(root, fullPath),
        sourceHash,
        original.length,
        'intake_original',
        initial.detailsJson,
      );
      createIntakeStateStorage(db, { profileId, intakeId: sourceId, sourceHash }).stage(
        initial.state,
        randomUUID(),
      );
    });
    await buildIntakeCollectionEnvelope(db, { id: sourceId, sha256: sourceHash });
    return {
      root,
      profileId,
      db,
      sourceId,
      sourceHash,
      originalPath: fullPath,
      count,
      mode,
      groupCount,
      candidateCount,
      retainedMemberRows: count,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
