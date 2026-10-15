import { currentClinicalOperation, runExclusiveClinicalOperation } from './clinical-operation.ts';
import { createClinicalReviewArtifactProof } from './clinical-review-artifact-proof.ts';
import { collectionClinicalProjectionContext } from './intake-review-collection-session.ts';
import type { Database } from './database.ts';
import { HttpError } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import type { IntakeReportQueueView } from '../shared/intake.ts';
import type {
  IntakeReportSourceReviewV2,
  IntakeReportSourceScopeFragment,
  IntakeReportSourceReviewTargetV2,
} from '../shared/intake-report-source-review.ts';
import { prepareNativeReportSourceReviewScope } from './intake-report-source-review-scope.ts';
import {
  resolveNativeReportSource,
  selectNativeReportSourceLocator,
} from './intake-report-source-resolution.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { hashSourceScalar } from './intake-report-source-resolution-index.ts';

export interface NativeReportSourceReviewPageInput {
  groupId: string;
  view: IntakeReportQueueView;
  cursor?: string;
  sourceCursor?: string;
  evidenceCursor?: string;
  limit?: number;
}
const cursor = (token: string, section: string, offset: number) =>
  Buffer.from(JSON.stringify([token, section, offset])).toString('base64url');
function start(raw: string | undefined, token: string, section: string) {
  if (!raw) return 0;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(409, 'REPORT_SOURCE_SCOPE', 'Reload this report source review');
  }
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value[0] !== token ||
    value[1] !== section ||
    !Number.isSafeInteger(value[2]) ||
    value[2] < 0
  )
    throw new HttpError(409, 'REPORT_SOURCE_SCOPE', 'Reload this report source review');
  return value[2] as number;
}
export async function readNativeReportSourceReview(
  db: Database,
  root: string,
  profileId: string,
  source: IntakeEnvelopeSource,
  input: NativeReportSourceReviewPageInput,
): Promise<IntakeReportSourceReviewV2> {
  return runExclusiveClinicalOperation(
    db,
    async () => {
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new HttpError(
          400,
          'REPORT_SOURCE_WINDOW',
          'Choose a source review window from 1 to 100',
        );
      const scope = await prepareNativeReportSourceReviewScope(db, source, {
          profileId,
          groupId: input.groupId,
          view: input.view,
        }),
        scratch = disposableSqlite('circus-source-coverage-');
      let cached:
        | Awaited<
            ReturnType<
              typeof import('./intake-review-collection-host.ts').prepareCollectionClinicalReviewAsync
            >
          >
        | undefined;
      try {
        const artifacts = createClinicalReviewArtifactProof(scratch.db, 'clinical_artifacts');
        const pagePin = JSON.stringify([
          scope.scopeToken,
          intakeSourceVersion(db, source.id).logicalBinding,
        ]);
        const targetStart = start(input.cursor, pagePin, 'targets'),
          sourceStart = start(input.sourceCursor, pagePin, 'sources'),
          evidenceStart = start(input.evidenceCursor, pagePin, 'evidence');
        scratch.db.exec(
          'CREATE TABLE sources(label TEXT PRIMARY KEY,count INTEGER NOT NULL) WITHOUT ROWID',
        );
        const targets: IntakeReportSourceReviewTargetV2[] = [],
          sourceEvidence: IntakeReportSourceReviewV2['sourceEvidence']['items'] = [];
        const {
          prepareCollectionClinicalReviewAsync,
          prepareCollectionClinicalReviewDependencies,
        } = await import('./intake-review-collection-host.ts');
        let covered = 0,
          index = 0,
          targetBytes = 0,
          targetFull = false,
          cachedProposal: string | null | undefined;
        const reference = (
          section: 'target' | 'sourceEvidence',
          ordinal: number,
        ): IntakeReportSourceScopeFragment => ({
          format: 'health-intake-report-source-scope-fragment-v1',
          intakeId: source.id,
          groupId: scope.groupId,
          view: scope.view,
          scopeToken: scope.scopeToken,
          section,
          ordinal,
        });
        for (const entry of scope.entries()) {
          const selected = resolveNativeReportSource(db, source, {
              candidateId: entry.candidateId,
              candidateVersionId: entry.candidateVersionId,
              references: () => [
                {
                  groupId: entry.sourceRef.groupId,
                  groupVersionId: entry.sourceRef.groupVersionId,
                },
              ],
              occurrence: {
                proposalId: entry.proposalId,
                recordId: entry.recordId,
                batchId: entry.batchId,
                locator: selectNativeReportSourceLocator(db, source, entry.occurrenceAddress),
              },
            }),
            effectiveSource = selected?.confirmation.source || null;
          if (effectiveSource) {
            covered++;
            scratch.db
              .prepare(
                'INSERT INTO sources VALUES(?,1) ON CONFLICT(label) DO UPDATE SET count=count+1',
              )
              .run(effectiveSource);
          }
          if (index++ < targetStart || targets.length >= limit || targetFull) continue;
          if (!cached || cachedProposal !== entry.proposalId) {
            if (cached?.status === 'ready') cached.session.close();
            await prepareCollectionClinicalReviewDependencies(
              db,
              root,
              profileId,
              source.id,
              entry.proposalId,
              { assertRunning: scope.assertCurrent },
            );
            cached = await prepareCollectionClinicalReviewAsync(
              db,
              root,
              profileId,
              source.id,
              entry.proposalId,
              { assertRunning: scope.assertCurrent },
            );
            cachedProposal = entry.proposalId;
          }
          let detail: IntakeReportSourceReviewTargetV2['detail'] = {
            state: 'referenced',
            proposalId: entry.proposalId,
            recordId: entry.recordId,
            candidateId: entry.candidateId,
            candidateVersionId: entry.candidateVersionId,
          };
          if (cached.status === 'ready') {
            artifacts.retain(
              collectionClinicalProjectionContext(cached.session).verifiedArtifacts(),
            );
            const record = cached.session.record(
              entry.recordId,
              entry.candidateId,
              entry.candidateVersionId,
            );
            if (!record)
              throw new HttpError(
                409,
                'REPORT_SOURCE_SCOPE',
                'An affected report record changed; reload its source review',
              );
            const header = {
              state: 'available' as const,
              title: record.title,
              date: record.date,
              kind: record.kind,
            };
            if (Buffer.byteLength(JSON.stringify(header)) <= 16384) detail = header;
          }
          const target = {
            candidateId: entry.candidateId,
            candidateVersionId: entry.candidateVersionId,
            proposalId: entry.proposalId,
            recordId: entry.recordId,
            sourceRef: entry.sourceRef,
            effectiveSource,
            detail,
            evidence: reference('target', entry.ordinal),
          };
          const bytes = Buffer.byteLength(JSON.stringify(target));
          if (targets.length && targetBytes + bytes > 256 * 1024) {
            targetFull = true;
            continue;
          }
          targetBytes += bytes;
          targets.push(target);
        }
        const sourceCount = Number(
            scratch.db.prepare('SELECT count(*) AS n FROM sources').get()!.n,
          ),
          bySource = [
            ...scratch.db
              .prepare('SELECT label,count FROM sources ORDER BY label LIMIT ? OFFSET ?')
              .iterate(limit, sourceStart),
          ].map((row) => ({ source: String(row.label), count: Number(row.count) }));
        let evidenceIndex = 0;
        for (const pieces of scope.sourceEvidence()) {
          const ordinal = evidenceIndex++;
          if (ordinal < evidenceStart || sourceEvidence.length >= limit) continue;
          let preview = '',
            units = 0;
          hashSourceScalar(db, pieces, [], (unit) => {
            units++;
            if (preview.length < 240) preview += unit;
          });
          if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
          sourceEvidence.push({
            preview,
            truncated: units > preview.length,
            evidence: reference('sourceEvidence', ordinal),
          });
        }
        const total = scope.entryCount;
        return await artifacts.withVerifiedTerminal(
          { assertCurrent: () => scope.assertCurrent() },
          () => ({
            format: 'health-intake-report-source-review-v2',
            profileId,
            intakeId: source.id,
            intakeVersion: intakeSourceVersion(db, source.id).version,
            groupId: scope.groupId,
            groupVersionId: scope.groupVersionId,
            view: scope.view,
            scopeToken: scope.scopeToken,
            targets: {
              items: targets,
              total,
              nextCursor:
                targetStart + targets.length < total
                  ? cursor(pagePin, 'targets', targetStart + targets.length)
                  : null,
            },
            coverage: {
              total,
              covered,
              uncovered: total - covered,
              status: !total
                ? 'empty'
                : !covered
                  ? 'uncovered'
                  : covered < total
                    ? 'partial'
                    : sourceCount === 1
                      ? 'single'
                      : 'mixed',
              sourceCount,
              bySource: {
                items: bySource,
                total: sourceCount,
                nextCursor:
                  sourceStart + bySource.length < sourceCount
                    ? cursor(pagePin, 'sources', sourceStart + bySource.length)
                    : null,
              },
            },
            sourceEvidence: {
              items: sourceEvidence,
              total: scope.sourceEvidenceCount,
              nextCursor:
                evidenceStart + sourceEvidence.length < scope.sourceEvidenceCount
                  ? cursor(pagePin, 'evidence', evidenceStart + sourceEvidence.length)
                  : null,
            },
            conflictingSourceEvidence: scope.sourceEvidenceCount > 1,
          }),
        );
      } finally {
        if (cached?.status === 'ready') cached.session.close();
        scope.close();
        scratch.close();
      }
    },
    { operation: currentClinicalOperation(db) },
  );
}
/** Exact JSON fragment of a selected occurrence entry or source-evidence label. */
export async function readNativeReportSourceScopeFragment(
  db: Database,
  profileId: string,
  source: IntakeEnvelopeSource,
  input: IntakeReportSourceScopeFragment & { offset: number; limit?: number },
) {
  return runExclusiveClinicalOperation(
    db,
    async () => {
      const limit = input.limit ?? 32768;
      if (
        input.format !== 'health-intake-report-source-scope-fragment-v1' ||
        input.intakeId !== source.id ||
        !Number.isSafeInteger(input.ordinal) ||
        input.ordinal < 0 ||
        !Number.isSafeInteger(input.offset) ||
        input.offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 4 ||
        limit > 32768 ||
        !['target', 'sourceEvidence'].includes(input.section)
      )
        throw new HttpError(400, 'REPORT_SOURCE_FRAGMENT', 'Choose a valid report source fragment');
      const scope = await prepareNativeReportSourceReviewScope(db, source, {
        profileId,
        groupId: input.groupId,
        view: input.view,
      });
      try {
        if (scope.scopeToken !== input.scopeToken)
          throw new HttpError(409, 'REPORT_SOURCE_SCOPE', 'Reload this report source review');
        let selected: Iterable<string> | undefined;
        if (input.section === 'target') {
          for (const entry of scope.entries())
            if (entry.ordinal === input.ordinal) {
              selected = scope.entryPieces(entry);
              break;
            }
        } else {
          let ordinal = 0;
          for (const pieces of scope.sourceEvidence())
            if (ordinal++ === input.ordinal) {
              selected = pieces;
              break;
            }
        }
        if (!selected)
          throw new HttpError(
            404,
            'REPORT_SOURCE_FRAGMENT',
            'Report source evidence was not found',
          );
        function* utf8() {
          let carry = '';
          for (const text of selected!) {
            let value = carry + text;
            carry = '';
            if (/[\uD800-\uDBFF]$/.test(value)) {
              carry = value.at(-1)!;
              value = value.slice(0, -1);
            }
            if (value) yield Buffer.from(value);
          }
          if (carry) yield Buffer.from(carry);
        }
        let total = 0,
          size = 0,
          selectedComplete = false;
        const chunks: Buffer[] = [];
        for (const chunk of utf8()) {
          const from = Math.max(0, input.offset - total);
          if (from < chunk.length && size < limit && !selectedComplete) {
            if (from > 0 && (chunk[from]! & 0xc0) === 0x80)
              throw new HttpError(
                400,
                'REPORT_SOURCE_FRAGMENT',
                'Fragment offset must start at a text boundary',
              );
            let to = Math.min(chunk.length, from + limit - size);
            while (to > from && to < chunk.length && (chunk[to]! & 0xc0) === 0x80) to--;
            if (to > from) {
              chunks.push(chunk.subarray(from, to));
              size += to - from;
            }
            if (to < chunk.length) selectedComplete = true;
          }
          total += chunk.length;
        }
        if (input.offset > total)
          throw new HttpError(
            400,
            'REPORT_SOURCE_FRAGMENT',
            'Fragment offset exceeds this evidence',
          );
        scope.assertCurrent();
        const { offset: _offset, limit: _limit, ...reference } = input;
        return {
          format: 'health-intake-report-source-scope-fragment-result-v1' as const,
          reference,
          offset: input.offset,
          text: Buffer.concat(chunks, size).toString('utf8'),
          totalBytes: total,
          nextOffset: input.offset + size < total ? input.offset + size : null,
          complete: input.offset + size === total,
        };
      } finally {
        scope.close();
      }
    },
    { operation: currentClinicalOperation(db) },
  );
}
