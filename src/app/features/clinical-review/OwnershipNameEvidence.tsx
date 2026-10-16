import { useEffect, useState } from 'react';
import { api } from '../../data/api';
import type {
  OwnershipNameEvidenceReference,
  OwnershipNameEvidencePage,
  OwnershipNameHeader,
  OwnershipNameSupportHeader,
  OwnershipPreviewReference,
} from '../../../shared/ownership-name-reference';

export function OwnershipNameEvidence({
  reference,
  disabled,
  onChoice,
  onBusy,
}: {
  reference: OwnershipNameEvidenceReference;
  disabled: boolean;
  onChoice: (preview: OwnershipPreviewReference) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [effects, setEffects] = useState<OwnershipNameEvidencePage<OwnershipNameHeader> | null>(
    null,
  );
  const [effectCursor, setEffectCursor] = useState('');
  const [selected, setSelected] = useState<OwnershipNameHeader | null>(null);
  const [supports, setSupports] =
    useState<OwnershipNameEvidencePage<OwnershipNameSupportHeader> | null>(null);
  const [supportCursor, setSupportCursor] = useState(0);
  const [support, setSupport] = useState<OwnershipNameSupportHeader | null>(null);
  const [targets, setTargets] = useState<OwnershipNameEvidencePage<{
    ordinal: number;
    recordId: string;
  }> | null>(null);
  const [targetCursor, setTargetCursor] = useState(-1);
  const [error, setError] = useState('');
  useEffect(() => {
    setEffectCursor('');
    setSelected(null);
    setSupport(null);
  }, [reference.token]);
  useEffect(() => {
    let active = true;
    setEffects(null);
    setSelected(null);
    setSupport(null);
    setError('');
    api<OwnershipNameEvidencePage<OwnershipNameHeader>>(
      reference.url + '?after=' + encodeURIComponent(effectCursor),
    )
      .then(({ data }) => {
        if (active) setEffects(data);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'Evidence could not be read');
      });
    return () => {
      active = false;
    };
  }, [reference.url, reference.decisionDigest, effectCursor]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setSupports(null);
    setSupport(null);
    setError('');
    api<OwnershipNameEvidencePage<OwnershipNameSupportHeader>>(
      reference.url + '?effect=' + encodeURIComponent(selected.key) + '&after=' + supportCursor,
    )
      .then(({ data }) => {
        if (active) setSupports(data);
      })
      .catch((e) => {
        if (active)
          setError(e instanceof Error ? e.message : 'Supporting evidence could not be read');
      });
    return () => {
      active = false;
    };
  }, [reference.url, selected, supportCursor]);
  useEffect(() => {
    if (!selected || !support) return;
    let active = true;
    setTargets(null);
    setError('');
    api<OwnershipNameEvidencePage<{ ordinal: number; recordId: string }>>(
      reference.url +
        '?effect=' +
        encodeURIComponent(selected.key) +
        '&support=' +
        support.ordinal +
        '&after=' +
        targetCursor,
    )
      .then(({ data }) => {
        if (active) setTargets(data);
      })
      .catch((e) => {
        if (active)
          setError(e instanceof Error ? e.message : 'Assigned target evidence could not be read');
      });
    return () => {
      active = false;
    };
  }, [reference.url, selected, support, targetCursor]);
  async function choose(effect: OwnershipNameHeader, outcome: OwnershipNameHeader['decision']) {
    onBusy(true);
    setError('');
    try {
      const { data } = await api<OwnershipPreviewReference>(reference.url, {
        method: 'POST',
        body: JSON.stringify({ key: effect.key, outcome }),
      });
      onChoice(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The choice could not be saved');
    } finally {
      onBusy(false);
    }
  }
  return (
    <section aria-label="Remembered name evidence">
      <p>
        {reference.total} remembered name associations, supported by {reference.supportTotal}{' '}
        confirmations and {reference.targetTotal} assigned targets. The correction is bound to the
        complete evidence.
      </p>
      {error && <p role="alert">{error}</p>}
      {!effects ? (
        <p>Loading name associations…</p>
      ) : (
        effects.items.map((effect) => (
          <div key={effect.key}>
            <label>
              {effect.name}
              {effect.unknownSupport
                ? ' (some historical support is unknown)'
                : effect.independentSupport
                  ? ' (independent support remains)'
                  : ' (all supporting assignments move)'}
              <select
                disabled={disabled}
                value={effect.decision}
                onChange={(event) =>
                  void choose(effect, event.target.value as OwnershipNameHeader['decision'])
                }
              >
                <option value="old">Keep for the former person</option>
                <option value="destination">Use for the destination person</option>
                <option value="both">Use for both people</option>
                <option value="unresolved">Ask each time for later reports</option>
              </select>
            </label>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setSelected(effect);
                setSupportCursor(0);
              }}
            >
              View {effect.supportTotal} supporting confirmations
            </button>
          </div>
        ))
      )}
      {effectCursor && (
        <button type="button" disabled={disabled} onClick={() => setEffectCursor('')}>
          First name associations
        </button>
      )}
      {effects && !effects.complete && (
        <button type="button" disabled={disabled} onClick={() => setEffectCursor(effects.after!)}>
          Next name associations
        </button>
      )}
      {selected && (
        <section aria-label="Supporting confirmations">
          <p>
            {selected.name}: {selected.supportTotal} supporting confirmations.
          </p>
          {supports?.items.map((item) => (
            <div key={item.ordinal}>
              <p>
                {item.operationId} — {item.intakeId}, report {item.groupId}; {item.targetTotal}{' '}
                assigned targets.{' '}
                {item.moves
                  ? 'Every assignment moves.'
                  : item.affected
                    ? 'Some assignments move.'
                    : 'These assignments remain independent.'}
              </p>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setSupport(item);
                  setTargetCursor(-1);
                }}
              >
                View assigned targets
              </button>
            </div>
          ))}
          {supportCursor > 0 && (
            <button type="button" disabled={disabled} onClick={() => setSupportCursor(0)}>
              First confirmations
            </button>
          )}
          {supports && !supports.complete && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => setSupportCursor(Number(supports.after))}
            >
              Next confirmations
            </button>
          )}
        </section>
      )}
      {support && (
        <section aria-label="Assigned targets">
          <p>
            {support.operationId}: {support.targetTotal} assigned targets.
          </p>
          <ul>
            {targets?.items.map((item) => (
              <li key={item.ordinal}>{item.recordId}</li>
            ))}
          </ul>
          {targetCursor >= 0 && (
            <button type="button" disabled={disabled} onClick={() => setTargetCursor(-1)}>
              First targets
            </button>
          )}
          {targets && !targets.complete && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => setTargetCursor(Number(targets.after))}
            >
              Next targets
            </button>
          )}
        </section>
      )}
    </section>
  );
}
