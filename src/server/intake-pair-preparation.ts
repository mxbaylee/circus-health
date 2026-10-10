/** Preserve fresh pair CAS through certified, domain-invisible preparation only. */
import { createHash } from 'node:crypto';
import { HttpError, observeTransactionOutcome, revision, type Database } from './database.ts';
import { canonicalLiteral } from './intake-format.ts';
import { durableSelectionInputs } from './intake-selection-authority.ts';
import type { IntakePairScope } from '../shared/clinical-review.ts';

export function observeIntakePairPreparation(db: Database) {
  const entryRevision = revision(db),
    dataVersion = Number(db.prepare('PRAGMA data_version').get()!.data_version),
    freshScopes = new Map<object, string>();
  let guardedRevision = entryRevision,
    invalidated = false;
  const changed = () =>
    new HttpError(
      409,
      'DUPLICATE_SCOPE_CHANGED',
      'Reviewed evidence changed. Refresh both exact record versions before continuing.',
    );
  const assertCurrent = () => {
    if (
      invalidated ||
      revision(db) !== guardedRevision ||
      Number(db.prepare('PRAGMA data_version').get()!.data_version) !== dataVersion
    )
      throw changed();
  };
  const dispose = observeTransactionOutcome(db, (outcome) => {
    if (!outcome.committed) return;
    if (
      invalidated ||
      !outcome.succeeded ||
      !outcome.intakeMaintenance ||
      revision(db) !== guardedRevision + 1 ||
      Number(db.prepare('PRAGMA data_version').get()!.data_version) !== dataVersion
    )
      invalidated = true;
    else guardedRevision = revision(db);
  });
  return {
    assertCurrent,
    dispose,
    capture(scope: IntakePairScope | undefined, intakeVersion: number) {
      assertCurrent();
      if (scope?.format !== 'intake-pair-scope-v2') return;
      const { token, ...payload } = scope;
      if (
        scope.requestRevision !== entryRevision ||
        scope.intakeVersion !== intakeVersion ||
        token !== createHash('sha256').update(canonicalLiteral(payload)).digest('hex')
      )
        throw changed();
      freshScopes.set(scope, canonicalLiteral(scope));
    },
    refresh(scope: IntakePairScope | undefined, current: IntakePairScope | undefined) {
      assertCurrent();
      if (scope?.format !== 'intake-pair-scope-v2') return scope;
      if (
        freshScopes.get(scope) !== canonicalLiteral(scope) ||
        current?.format !== 'intake-pair-scope-v2' ||
        current.intakeVersion !== scope.intakeVersion ||
        canonicalLiteral(durableSelectionInputs(scope)) !==
          canonicalLiteral(durableSelectionInputs(current))
      )
        throw changed();
      return current;
    },
  };
}
