import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Link2, X, FileJson2, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import type {
  Observation,
  SourceFile,
  SourceRecord,
  SourceRecordReference,
} from '../../shared/api';
import { formatBytes, formatDate, sourceLink } from '../data/format';
import {
  SOURCE_SNAPSHOT_EXPLANATION,
  sourceFileAttribution,
  sourceFileCoverageStatus,
  sourceFileStatus,
  sourceRecordHistoricalStatus,
  sourceRecordStatus,
} from '../data/sourceStatus';
import { useResource } from '../data/api';
import { ResourceState } from './ResourceState';
import { PdfPreview } from './PdfPreview';
import '../clinical.css';

export function SourcePreview({
  file,
  label = 'Open original file',
  initialPage,
  compact = false,
}: {
  file: Pick<SourceFile, 'archived' | 'id' | 'contentUrl' | 'bytes' | 'mimeType' | 'path'>;
  label?: string;
  initialPage?: number;
  compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [file.id, file.contentUrl]);
  const isImage = /^image\/(png|jpeg|webp|gif)$/.test(file.mimeType);
  return (
    <div className="source-preview">
      {file.archived && <span className="soft-badge">Archived file</span>}
      {(!compact || file.mimeType !== 'application/pdf') && (
        <p>
          <a className="text-link" href={file.contentUrl} target="_blank" rel="noreferrer">
            {label} <ExternalLink size={15} />
          </a>{' '}
          <span className="muted">{formatBytes(file.bytes)}</span>
        </p>
      )}
      {isImage && !failed && (
        <a href={file.contentUrl} target="_blank" rel="noreferrer">
          <img
            src={file.contentUrl}
            alt={file.path.split('/').pop() ?? 'Source image'}
            onError={() => setFailed(true)}
          />
        </a>
      )}
      {file.mimeType === 'application/pdf' && (
        <PdfPreview
          compact={compact}
          initialPage={initialPage}
          contentUrl={file.contentUrl}
          filename={file.path.split('/').pop() ?? 'Source PDF'}
        />
      )}
      {failed && (
        <p role="status">The image preview is unavailable. Try opening the original file.</p>
      )}
    </div>
  );
}

export function SourceRecordView({ record }: { record: SourceRecord | SourceRecordReference }) {
  const [expand, setExpand] = useState(false);
  const historicalRecordStatus = sourceRecordHistoricalStatus(record.extractionStatus);
  const originalAttribution = record.originalFile
    ? sourceFileAttribution(record.originalFile)
    : null;
  const extractionFile = record.extractionFile || record.file;
  const extractionAttribution = extractionFile ? sourceFileAttribution(extractionFile) : null;
  const resolved = useResource<{
    resolvedText: string;
    referenceCount: number;
    preservation: string;
  }>(
    expand ? `/source-records/${encodeURIComponent(record.id)}/resolved?fileView=reference` : null,
  );
  return (
    <div className="source-record-view">
      {record.originalFile && (
        <SourcePreview key={record.originalFile.id} file={record.originalFile} />
      )}
      {record.originalMissing && (
        <p role="status">
          The original file could not be located. Retained extraction evidence is available below.
        </p>
      )}
      {record.ancestorFiles
        ?.filter((file) => file.id !== record.originalFile?.id)
        .map((file) => (
          <SourcePreview key={file.id} file={file} label="Open containing original" />
        ))}
      {record.archived && <span className="soft-badge">Archived</span>}
      <dl className="source-fields">
        <div>
          <dt>Source record</dt>
          <dd>{record.id}</dd>
        </div>
        {record.date && (
          <div>
            <dt>Source record date</dt>
            <dd>{formatDate(record.date)}</dd>
          </div>
        )}
        <div>
          <dt>Kind</dt>
          <dd>{record.kind}</dd>
        </div>
        <div>
          <dt>Saved health record link</dt>
          <dd>{sourceRecordStatus(record.extractionStatus)}</dd>
        </div>
        <div>
          <dt>Record source</dt>
          <dd>{record.provider ?? 'Not recorded'}</dd>
        </div>
        {record.sourceKey && (
          <div>
            <dt>Provider key</dt>
            <dd>{record.sourceKey}</dd>
          </div>
        )}
        {record.file && (
          <div>
            <dt>Retained file</dt>
            <dd>
              {record.file.path} · {sourceFileStatus(record.file.coverageStatus)}
            </dd>
          </div>
        )}
        {record.originalFile && (
          <>
            <div>
              <dt>Original file acquisition source</dt>
              <dd>{originalAttribution!.acquisition}</dd>
            </div>
            {originalAttribution!.reviewedSource && (
              <div>
                <dt>Original reviewed source label</dt>
                <dd>{originalAttribution!.reviewedSource}</dd>
              </div>
            )}
          </>
        )}
        {extractionFile && extractionFile.id !== record.originalFile?.id && (
          <div>
            <dt>Extraction file acquisition source</dt>
            <dd>{extractionAttribution!.acquisition}</dd>
          </div>
        )}
        {extractionAttribution?.reviewedSource &&
          extractionFile?.id !== record.originalFile?.id && (
            <div>
              <dt>Extraction reviewed source label</dt>
              <dd>{extractionAttribution.reviewedSource}</dd>
            </div>
          )}
      </dl>
      <p className="helper-text">
        Record source describes this retained occurrence. File acquisition source identifies where
        the file came from; it is not the upload date or time and stays separate from a reviewed
        source label. A source record date is an optional summary; when it is not shown, dates may
        still be present in the retained evidence or saved health record.
      </p>
      <details className="retained-details">
        <summary>Historical extraction details</summary>
        <dl className="source-fields">
          {historicalRecordStatus && (
            <div>
              <dt>Historical record snapshot</dt>
              <dd>{historicalRecordStatus}</dd>
            </div>
          )}
          {record.file && (
            <div>
              <dt>Historical coverage snapshot</dt>
              <dd>{sourceFileCoverageStatus(record.file.coverageStatus)}</dd>
            </div>
          )}
        </dl>
        <p className="helper-text">
          {SOURCE_SNAPSHOT_EXPLANATION}{' '}
          <Link className="text-link" to="/import">
            Open current Import review
          </Link>
          .
        </p>
      </details>
      <h3>Exact location</h3>
      <pre className="raw-content">{JSON.stringify(record.locator, null, 2)}</pre>
      <h3>Retained source payload</h3>
      <pre className="raw-content">
        {record.rawText ??
          (typeof record.raw === 'string' ? record.raw : JSON.stringify(record.raw, null, 2))}
      </pre>
      {/capture|context/i.test(record.kind) && (
        <div className="resolved-source">
          <button
            className="button secondary"
            aria-expanded={expand}
            onClick={() => setExpand(!expand)}
          >
            {expand ? 'Hide expanded source text' : 'Expand referenced source text'}
          </button>
          {expand && (
            <ResourceState resource={resolved}>
              {(data) => (
                <>
                  <p className="helper-text">
                    {data.referenceCount} retained references expanded. This is a reconstructed
                    view; the stored payload above is unchanged.
                  </p>
                  <pre className="raw-content">{data.resolvedText}</pre>
                </>
              )}
            </ResourceState>
          )}
        </div>
      )}
      {!!record.relationships?.length && (
        <>
          <h3>Source relationships</h3>
          <pre className="raw-content">{JSON.stringify(record.relationships, null, 2)}</pre>
        </>
      )}
      {(record.extractionFile || record.file) &&
        (record.extractionFile || record.file)?.id !== record.originalFile?.id && (
          <SourcePreview
            file={(record.extractionFile || record.file)!}
            label={record.extractionFile ? 'Open retained extraction' : 'Open retained source file'}
          />
        )}
    </div>
  );
}

export function SourceDialog({
  result,
  sourceRecordId,
  label = 'View source',
}: {
  result?: Observation;
  sourceRecordId?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = sourceRecordId ?? result?.sourceRecordId;
  const source = useResource<SourceRecordReference>(
    open && id ? `/source-records/${encodeURIComponent(id)}?fileView=reference` : null,
  );
  if (!id) return <span className="muted">Source unavailable</span>;
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="button secondary">
          <Link2 size={18} />
          {label}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="source-dialog live-source-dialog">
          <Dialog.Close asChild>
            <button className="icon-button dialog-close" aria-label="Close source">
              <X size={21} />
            </button>
          </Dialog.Close>
          <FileJson2 className="pink-icon" size={27} />
          <Dialog.Title>Source evidence</Dialog.Title>
          <Dialog.Description>
            The original evidence remains canonical. This historical source snapshot is separate
            from the current Import review; retained source text is shown as recorded.
          </Dialog.Description>
          <ResourceState resource={source}>
            {(record) => <SourceRecordView record={record} />}
          </ResourceState>
          <Link className="text-link" to={sourceLink(id)} onClick={() => setOpen(false)}>
            Open in Sources <ExternalLink size={16} />
          </Link>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
