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
import { envelope } from '../intake-identity-native-fixture.ts';
import { validateJSONL } from '../../intake-format.ts';

/** Real selected collection and physical original, with only queue-relevant fictional fields. */
export async function makeNativeQueueFixture(
  t: TestContext,
  count: number,
  mode:
    | 'distinct'
    | 'shared-member'
    | 'one-group'
    | 'duplicate-fallback'
    | 'people-membership'
    | 'people-duplicate'
    | 'people-conflict'
    | 'people-page'
    | 'people-proposals' = 'distinct',
) {
  if (mode === 'duplicate-fallback' && count !== 4)
    throw Error('Duplicate fallback fixture uses exactly four retained groups');
  if (mode === 'people-page' && count !== 65)
    throw Error('Cooperative People page fixture uses exactly 65 fictional people');
  if (mode === 'people-proposals' && count !== 66)
    throw Error('Cooperative proposal fixture uses exactly 66 fictional people');
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
    const peopleMode = mode.startsWith('people-');
    const originalRecord = envelope('fictional-personless');
    const personText = 'Fictional clinician Mira Finch signed this invented report.';
    if (mode === 'people-duplicate' || mode === 'people-conflict') {
      originalRecord.payload = { literal: personText };
      originalRecord.report = { ...originalRecord.report!, memberId: 'fictional-member' };
      originalRecord.people = [
        {
          id: 'fictional-mira',
          fullName: 'Mira Finch',
          role: 'clinician',
          evidence: [
            {
              textAnchor: personText,
              supports: ['fullName'],
              locator: 'page 1 clinician line',
              memberId: 'fictional-member',
            },
          ],
        },
      ];
    }
    const pageRecord = (line: number, start: number, amount: number, label = 'Mira') => {
      const names = Array.from(
        { length: amount },
        (_, index) => `Fictional ${label} ${start + index}`,
      );
      return {
        ...envelope(`fictional-page-${line}`),
        payload: {
          literal: names
            .map((name) => `${name}, clinician, electronically signed this invented report.`)
            .join('\n'),
        },
        people: names.map((name, index) => ({
          id: `fictional-${label.toLowerCase()}-v2-${start + index}`,
          fullName: name,
          role: 'clinician' as const,
          evidence: [
            {
              textAnchor: `${name}, clinician, electronically signed this invented report.`,
              supports: ['fullName' as const],
              locator: `page ${line} clinician line ${index + 1}`,
            },
          ],
        })),
      };
    };
    const original = Buffer.from(
      mode === 'people-page'
        ? [JSON.stringify(pageRecord(1, 0, 40)), JSON.stringify(pageRecord(2, 40, 25))].join('\n') +
            '\n'
        : peopleMode
          ? JSON.stringify(originalRecord) + '\n'
          : `Independently fictional original for ${count} report groups.\n`,
    );
    if (mode === 'people-page' && !validateJSONL(original).valid)
      throw Error(JSON.stringify(validateJSONL(original).issues));
    const sourceHash = createHash('sha256').update(original).digest('hex');
    const fullPath = join(paths.sources, `${sourceId}.txt`);
    writeFileSync(fullPath, original);
    const proposalIds =
      mode === 'people-proposals' ? [`${sourceId}-proposal-a`, `${sourceId}-proposal-b`] : [];
    const proposalFiles =
      mode === 'people-proposals'
        ? [[pageRecord(1, 0, 33, 'Aster')], [pageRecord(2, 33, 33, 'Cedar')]].map(
            (records, index) => {
              const bytes = Buffer.from(
                records.map((record) => JSON.stringify(record)).join('\n') + '\n',
              );
              const path = join(paths.sources, `${proposalIds[index]}.jsonl`);
              writeFileSync(path, bytes);
              return {
                id: proposalIds[index]!,
                path,
                bytes,
                sha256: createHash('sha256').update(bytes).digest('hex'),
                validation: validateJSONL(bytes),
              };
            },
          )
        : [];
    if (proposalFiles.some((file) => !file.validation.valid))
      throw Error('Fictional proposal sources must validate');
    const candidateCount = mode === 'shared-member' || peopleMode ? 1 : count;
    const groupCount =
      mode === 'one-group' || mode === 'people-page' || mode === 'people-proposals' ? 1 : count;
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
      ...(mode === 'people-duplicate' || mode === 'people-conflict'
        ? {
            memberId:
              mode === 'people-conflict' && index === 3
                ? 'different-fictional-member'
                : 'fictional-member',
          }
        : {}),
      discoveryOrder: index,
      basis: 'report_anchor',
      versions: [
        {
          id: `report-version-${index}`,
          createdAt: '2026-01-01T00:00:00.000Z',
          members: (mode === 'one-group'
            ? candidates
            : [candidates[mode === 'shared-member' || peopleMode ? 0 : index]!]
          ).map((candidate) => ({
            candidateId: candidate.id,
            candidateVersionId: candidate.versions[0]!.id,
            ...(peopleMode
              ? {
                  occurrences:
                    mode === 'people-proposals'
                      ? [
                          { proposalId: proposalIds[0], recordId: `${proposalIds[0]}:line:1` },
                          { proposalId: proposalIds[1], recordId: `${proposalIds[1]}:line:1` },
                        ]
                      : (mode === 'people-page' ? [1, 2] : [1]).map((line) => ({
                          proposalId: null,
                          recordId: `${sourceId}:line:${line}`,
                        })),
                }
              : {}),
          })),
        },
      ],
    }));
    if (mode === 'people-duplicate' || mode === 'people-conflict') {
      reportGroups[1]!.id = reportGroups[0]!.id;
    }
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
        ...(mode === 'people-duplicate' || mode === 'people-conflict' || mode === 'people-page'
          ? { validation: validateJSONL(original) }
          : {}),
        ...(proposalFiles.length
          ? {
              proposals: proposalFiles.map((file) => ({
                id: file.id,
                fileId: file.id,
                summary: 'Independently fictional named People',
                createdAt: '2026-01-01T00:00:00.000Z',
                validation: file.validation,
              })),
            }
          : {}),
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
      for (const file of proposalFiles)
        db.prepare(
          'INSERT INTO source_files(id,provider_id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?,?)',
        ).run(
          file.id,
          'fictional-provider',
          relative(root, file.path),
          file.sha256,
          file.bytes.length,
          'intake_proposal',
          JSON.stringify({ originalSourceFileId: sourceId, validation: file.validation }),
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
      proposalFiles: proposalFiles.map(({ id, path, sha256 }) => ({ id, path, sha256 })),
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
