import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../../data/api';
import type { OwnershipPreview } from '../../../shared/record-ownership';
import type {
  OwnershipReportEvidenceReference,
  OwnershipReportPage,
  OwnershipReportItemReference,
  OwnershipReportPreviewRecord,
} from '../../../shared/ownership-report-reference';

export function OwnershipReportEvidence({
  reference,
  disabled,
  renderRecord,
  renderRelationship,
}: {
  reference: OwnershipReportEvidenceReference;
  disabled: boolean;
  renderRecord: (record: OwnershipReportPreviewRecord) => ReactNode;
  renderRelationship: (relationship: OwnershipPreview['relationships'][number]) => ReactNode;
}) {
  const [section, setSection] = useState<'records' | 'pending' | 'relationships' | 'holds'>(
      'records',
    ),
    [after, setAfter] = useState('-1'),
    [page, setPage] = useState<OwnershipReportPage | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setPage(null);
    setError('');
    api<OwnershipReportPage>(
      `${reference.url}?section=${section}&after=${encodeURIComponent(after)}&limit=16&bytes=65536`,
    )
      .then(({ data }) => active && setPage(data))
      .catch(
        (error) =>
          active &&
          setError(error instanceof Error ? error.message : 'Report evidence could not be read'),
      );
    return () => {
      active = false;
    };
  }, [reference.url, reference.digest, section, after]);
  return (
    <section aria-label="Complete report evidence">
      <p>
        This correction includes {reference.recordTotal} saved records and {reference.pendingTotal}{' '}
        pending records. Evidence is shown one page at a time.
      </p>
      <label>
        Report evidence{' '}
        <select
          disabled={disabled}
          value={section}
          onChange={(event) => {
            setAfter('-1');
            setSection(event.target.value as typeof section);
          }}
        >
          <option value="records">Saved records ({reference.recordTotal})</option>
          <option value="pending">Pending members ({reference.pendingTotal})</option>
          <option value="relationships">Relationships ({reference.relationshipTotal})</option>
          <option value="holds">
            Report defaults requiring review ({reference.reportHoldTotal})
          </option>
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      {!page && !error && <p>Loading report evidence…</p>}
      {page && (
        <>
          <p>
            {page.items.length} shown of {page.total}
          </p>
          {page.items.map((item, index) => {
            if ('type' in item && item.type === 'reference')
              return <ReportFragment key={item.ordinal} reference={item} disabled={disabled} />;
            if ('defaultOperationId' in item)
              return (
                <p key={item.defaultOperationId}>
                  Report {item.groupId}: the earlier person default will require renewed identity
                  review. Other saved records retain their current owners.
                </p>
              );
            if ('mapping' in item)
              return <div key={item.kind + item.recordId}>{renderRecord(item)}</div>;
            if ('decisionId' in item)
              return <div key={item.decisionId}>{renderRelationship(item)}</div>;
            return (
              <p key={index}>
                Pending source: {'recordId' in item ? item.recordId : ''}. It remains pending after
                the person correction.
              </p>
            );
          })}
          <button
            type="button"
            disabled={disabled || after === '-1'}
            onClick={() => setAfter('-1')}
          >
            First report page
          </button>
          {!page.complete && (
            <button
              type="button"
              disabled={disabled || !page.after}
              onClick={() => setAfter(page.after!)}
            >
              Next report page
            </button>
          )}
        </>
      )}
    </section>
  );
}
function ReportFragment({
  reference,
  disabled,
}: {
  reference: OwnershipReportItemReference;
  disabled: boolean;
}) {
  const decoder = useRef(new TextDecoder());
  const [text, setText] = useState('');
  const [offset, setOffset] = useState(0),
    [chunk, setChunk] = useState<{
      encoding: 'base64';
      data: string;
      complete: boolean;
      nextOffset: number;
    } | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    if (offset === 0) decoder.current = new TextDecoder();
    setChunk(null);
    setText('');
    setError('');
    api<NonNullable<typeof chunk>>(
      `${reference.url}?section=${reference.section}&ordinal=${reference.ordinal}&offset=${offset}&bytes=32768`,
    )
      .then(({ data }) => {
        if (active) {
          setText(
            decoder.current.decode(
              Uint8Array.from(atob(data.data), (character) => character.charCodeAt(0)),
              { stream: !data.complete },
            ),
          );
          setChunk(data);
        }
      })
      .catch(
        (error) =>
          active &&
          setError(error instanceof Error ? error.message : 'Report detail could not be read'),
      );
    return () => {
      active = false;
    };
  }, [reference.url, reference.ordinal, reference.section, offset]);
  return (
    <section>
      <p>Complete retained detail ({reference.bytes} bytes), shown in fragments.</p>
      {error && <p role="alert">{error}</p>}
      <pre>{text}</pre>
      <button type="button" disabled={disabled || offset === 0} onClick={() => setOffset(0)}>
        First detail fragment
      </button>
      {chunk && !chunk.complete && (
        <button type="button" disabled={disabled} onClick={() => setOffset(chunk.nextOffset)}>
          Next detail fragment
        </button>
      )}
    </section>
  );
}
