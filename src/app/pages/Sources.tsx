import { OwnershipSelectionControl } from '../features/clinical-review/OwnershipSelectionControl';
import { ImportSourceTextBrowser } from '../features/import/ImportSourceTextBrowser';
import { ClinicalOwner } from '../components/ClinicalOwner';
import {
  ClinicalRedirect,
  isReclassifiedRecord,
  currentClinicalRecord,
} from '../components/ClinicalRedirect';
import type { ReclassifiedRecord } from '../../shared/api';
import { CollectionTabs, CollectionToolbar } from '../components/CollectionLayout';
import { ContextHelp } from '../components/ContextHelp';
import {
  SOURCE_SNAPSHOT_EXPLANATION,
  sourceFileAttribution,
  sourceFileCoverageStatus,
  sourceFileStatus,
  sourceRecordStatus,
} from '../data/sourceStatus';
import { DetailHeader, EntryActions } from '../components/DetailHeader';
import { ArchiveControl } from '../components/ArchiveControl';
import { CollectionFilters, visibilityFilter } from '../components/CollectionFilters';
import { useAssistantSelection } from '../features/assistant/pageContext';
import { RelatedNotes } from '../components/RelatedNotes';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { FileText, Files, List, ChevronRight, ArrowLeft } from 'lucide-react';
import type { SourceFile, SourceRecord, SourceRecordReference } from '../../shared/api';
import { queryString, useResource } from '../data/api';
import { formatBytes, formatDate } from '../data/format';
import { Pagination, ResourceState } from '../components/ResourceState';
import { SourceDialog, SourcePreview, SourceRecordView } from '../components/SourceDialog';
import { AttachmentPanel } from '../features/notes/AttachmentPanel';
import '../clinical.css';

type Document = {
  personId?: string;
  archived?: boolean;
  id: string;
  title: string;
  date: string | null;
  sourceRecordId: string;
  text: string | null;
  extra: unknown;
};
export function Sources() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const recordOffset = Math.max(0, Number(params.get('recordOffset')) || 0);
  const browsingRecords = params.get('view') === 'records';
  const browsingDocuments = params.get('view') === 'documents';
  const documents = useResource<Document[]>(
    browsingDocuments
      ? `/documents?${queryString({ personId: params.get('personId') || 'patient', q, visibility: params.get('visibility') || 'visible', limit: 30, offset })}`
      : null,
  );
  const importing = params.get('view') === 'import' || params.has('intake');
  const selectedRecord = params.get('record');
  const selectedDocument = params.get('document');
  const change = (changes: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes))
      value ? next.set(key, value) : next.delete(key);
    setParams(next, { replace });
  };
  const files = useResource<SourceFile[]>(
    !browsingRecords && !browsingDocuments && !importing
      ? `/sources?${queryString({ q, visibility: params.get('visibility') || 'visible', limit: 30, offset })}`
      : null,
  );
  const allRecords = useResource<SourceRecord[]>(
    browsingRecords && !importing
      ? `/source-records?${queryString({ q, visibility: params.get('visibility') || 'visible', limit: 30, offset })}`
      : null,
  );
  const selectedFile =
    params.get('file') ??
    (!browsingRecords && !browsingDocuments && !selectedRecord && !selectedDocument
      ? files.data?.[0]?.id
      : undefined);
  const file = useResource<SourceFile>(
    !importing && selectedFile ? `/sources/${encodeURIComponent(selectedFile)}` : null,
  );
  const records = useResource<SourceRecord[]>(
    !importing && selectedFile
      ? `/source-records?${queryString({ visibility: 'all', originalSourceFileId: selectedFile, limit: 30, offset: recordOffset })}`
      : null,
  );
  const record = useResource<SourceRecordReference>(
    !importing && selectedRecord
      ? `/source-records/${encodeURIComponent(selectedRecord)}?fileView=reference`
      : null,
  );
  const document = useResource<Document | ReclassifiedRecord>(
    !importing && selectedDocument ? `/documents/${encodeURIComponent(selectedDocument)}` : null,
  );
  const currentDocument = currentClinicalRecord(document.data);
  useAssistantSelection(
    importing
      ? undefined
      : selectedDocument
        ? { collection: 'documents', id: selectedDocument }
        : selectedRecord
          ? { collection: 'records', id: selectedRecord }
          : selectedFile
            ? { collection: 'sources', id: selectedFile }
            : undefined,
    importing
      ? 'Import sources'
      : selectedDocument
        ? currentDocument?.title
        : selectedRecord
          ? record.data?.label || 'Source record'
          : file.data?.path.split('/').pop(),
  );
  const openRecord = (id: string) => change({ record: id, file: null, document: null });
  const openFile = (id: string) =>
    change({ file: id, record: null, document: null, recordOffset: null });
  const changeTab = (toRecords: boolean) =>
    change({
      view: toRecords ? 'records' : null,
      offset: null,
      recordOffset: null,
      file: null,
      record: null,
      document: null,
    });
  const showDocuments = () =>
    change({
      view: 'documents',
      file: null,
      record: null,
      document: null,
      offset: null,
      recordOffset: null,
    });
  const tabKeys = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const current = browsingDocuments ? 2 : browsingRecords ? 1 : 0;
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? 2
            : (current + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
      if (index === 2) showDocuments();
      else changeTab(index === 1);
      window.document
        .getElementById(['source-files-tab', 'source-records-tab', 'source-documents-tab'][index])
        ?.focus();
    }
  };
  if (importing) {
    const importParams = new URLSearchParams(params);
    importParams.delete('view');
    importParams.delete('return');
    return <Navigate replace to={`/import${importParams.size ? `?${importParams}` : ''}`} />;
  }
  return (
    <div
      className={`page clinical-page sources-page ${params.has('file') || selectedRecord || selectedDocument ? 'clinical-mobile-detail' : ''}`}
    >
      <div className="page-heading">
        <div>
          <p className="eyebrow">CANONICAL EVIDENCE</p>
          <h1>Sources</h1>
          <p className="page-subtitle">
            Your original files and historical evidence snapshots. Current review work stays in
            Import.
          </p>
          <ContextHelp label="Files, evidence and health records">
            <p>
              Files are the originals you uploaded. Evidence is the text or data kept from those
              files. Reviewing and saving a proposed result adds it to the relevant profile page,
              such as Test results or Prescriptions.
            </p>
            <p>
              {SOURCE_SNAPSHOT_EXPLANATION} Open Import to see current questions, review decisions,
              and reading progress.
            </p>
            <p>
              A record source identifies the source recorded for that retained occurrence. File
              acquisition source identifies where the original or extraction file came from; it is
              not the upload date or time. A reviewed source label remains separate from both.
            </p>
            <p>
              A source record date is an optional summary. If it is not shown, dates may still be
              present in the retained evidence or saved health record.
            </p>
          </ContextHelp>
        </div>
        <Link className="button primary" to="/import">
          Import sources
        </Link>
      </div>
      <CollectionTabs role="tablist" label="Source browsing">
        <button
          role="tab"
          id="source-files-tab"
          aria-controls="sources-panel"
          aria-selected={!browsingRecords && !browsingDocuments}
          tabIndex={browsingRecords || browsingDocuments ? -1 : 0}
          className={!browsingRecords && !browsingDocuments ? 'selected' : ''}
          onClick={() => changeTab(false)}
          onKeyDown={tabKeys}
        >
          <Files size={17} aria-hidden="true" />
          Files
        </button>
        <button
          role="tab"
          id="source-records-tab"
          aria-controls="sources-panel"
          aria-selected={browsingRecords}
          tabIndex={browsingRecords ? 0 : -1}
          className={browsingRecords ? 'selected' : ''}
          onClick={() => changeTab(true)}
          onKeyDown={tabKeys}
        >
          <List size={17} aria-hidden="true" />
          Records
        </button>
        <button
          role="tab"
          id="source-documents-tab"
          aria-controls="sources-panel"
          aria-selected={browsingDocuments}
          tabIndex={browsingDocuments ? 0 : -1}
          className={browsingDocuments ? 'selected' : ''}
          onClick={showDocuments}
          onKeyDown={tabKeys}
        >
          <FileText size={17} />
          Documents
        </button>
      </CollectionTabs>
      <CollectionToolbar>
        <CollectionFilters
          search={q}
          searchLabel={
            browsingDocuments ? 'documents' : browsingRecords ? 'retained records' : 'source files'
          }
          onSearch={(q) =>
            change({ q, offset: null, file: null, record: null, document: null }, true)
          }
          definitions={[visibilityFilter(params.get('visibility') || 'visible')]}
          onApply={(key, value) => change({ [key]: value, offset: null, recordOffset: null })}
        />
      </CollectionToolbar>
      <div
        id="sources-panel"
        role="tabpanel"
        aria-labelledby={
          browsingDocuments
            ? 'source-documents-tab'
            : browsingRecords
              ? 'source-records-tab'
              : 'source-files-tab'
        }
        className="clinical-workspace sources-workspace"
      >
        <section className="panel clinical-list">
          {browsingDocuments ? (
            <>
              <OwnershipSelectionControl
                records={(documents.data || []).map((r) => ({
                  kind: 'document',
                  recordId: r.id,
                  title: r.title,
                }))}
                onApplied={() => {
                  documents.reload();
                  document.reload();
                }}
              />
              <ResourceState resource={documents} empty="No accepted documents match this search.">
                {(rows) => (
                  <>
                    {rows.map((item) => (
                      <button
                        key={item.id}
                        className={`result-row ${selectedDocument === item.id ? 'is-selected' : ''}`}
                        onClick={() => change({ document: item.id, file: null, record: null })}
                      >
                        <FileText size={20} />
                        <span className="row-copy">
                          <strong>{item.title}</strong>
                          {item.date && <span>{formatDate(item.date)}</span>}
                        </span>
                        <ChevronRight size={18} />
                      </button>
                    ))}
                    <Pagination
                      offset={offset}
                      limit={30}
                      count={rows.length}
                      total={
                        typeof documents.meta?.total === 'number' ? documents.meta.total : undefined
                      }
                      onChange={(value) => change({ offset: String(value), document: null })}
                    />
                  </>
                )}
              </ResourceState>
            </>
          ) : browsingRecords ? (
            <ResourceState
              resource={allRecords}
              empty="No retained source records match this search."
            >
              {(rows) => (
                <>
                  {rows.map((item) => (
                    <button
                      className={`result-row ${selectedRecord === item.id ? 'is-selected' : ''}`}
                      key={item.id}
                      onClick={() => openRecord(item.id)}
                    >
                      <span className="row-copy">
                        <strong>{item.label ?? item.sourceKey ?? item.id}</strong>
                        {item.archived && <span className="soft-badge">Inactive</span>}
                        <span>
                          {item.kind} · {sourceRecordStatus(item.extractionStatus)}
                        </span>
                        <span>Record source: {item.provider ?? 'Not recorded'}</span>
                        {item.date ? (
                          <span>Source record date: {formatDate(item.date)}</span>
                        ) : (
                          <span className="muted">No source-record date summary</span>
                        )}
                      </span>
                      <ChevronRight size={18} />
                    </button>
                  ))}
                  <Pagination
                    offset={offset}
                    limit={30}
                    count={rows.length}
                    total={
                      typeof allRecords.meta?.total === 'number' ? allRecords.meta.total : undefined
                    }
                    onChange={(offset) => change({ offset: String(offset) })}
                  />
                </>
              )}
            </ResourceState>
          ) : (
            <ResourceState resource={files} empty="No source files match this search.">
              {(rows) => (
                <>
                  {rows.map((item) => (
                    <button
                      className={`result-row ${selectedFile === item.id ? 'is-selected' : ''}`}
                      key={item.id}
                      onClick={() => openFile(item.id)}
                    >
                      <FileText size={20} />
                      <span className="row-copy">
                        <strong>{item.path.split('/').pop()}</strong>
                        {item.archived && <span className="soft-badge">Inactive</span>}
                        <span>
                          File acquisition source: {sourceFileAttribution(item).acquisition}
                        </span>
                        {sourceFileAttribution(item).reviewedSource && (
                          <span>
                            Reviewed source label: {sourceFileAttribution(item).reviewedSource}
                          </span>
                        )}
                        <span>
                          {formatBytes(item.bytes)} · {sourceFileStatus(item.coverageStatus)}
                        </span>
                      </span>
                      <ChevronRight size={18} />
                    </button>
                  ))}
                  <Pagination
                    offset={offset}
                    limit={30}
                    count={rows.length}
                    total={typeof files.meta?.total === 'number' ? files.meta.total : undefined}
                    onChange={(offset) => change({ offset: String(offset), file: null })}
                  />
                </>
              )}
            </ResourceState>
          )}
        </section>
        <section className="panel clinical-detail source-detail">
          <button
            className="mobile-back text-link"
            onClick={() => change({ file: null, record: null, document: null })}
          >
            <ArrowLeft size={18} />
            Back to sources
          </button>
          {selectedDocument ? (
            <ResourceState resource={document}>
              {(item) =>
                isReclassifiedRecord(item) ? (
                  <ClinicalRedirect record={item} />
                ) : (
                  <>
                    <ClinicalOwner personId={item.personId} />
                    <DetailHeader
                      eyebrow="DOCUMENT"
                      title={item.title}
                      badges={item.archived && <span className="soft-badge">Inactive</span>}
                      metadata={<span>{formatDate(item.date)}</span>}
                      actions={
                        <EntryActions>
                          <ArchiveControl
                            showHistory
                            targetType="document"
                            targetId={item.id}
                            onChanged={document.reload}
                          />
                        </EntryActions>
                      }
                    />
                    <SourceDialog sourceRecordId={item.sourceRecordId} />
                    {item.text ? (
                      <pre className="raw-content document-text">{item.text}</pre>
                    ) : (
                      <p className="resource-state">
                        This document has no structured text extraction. Open its original source.
                      </p>
                    )}
                    <details>
                      <summary>Additional retained fields</summary>
                      <pre className="raw-content">{JSON.stringify(item.extra, null, 2)}</pre>
                    </details>
                    <AttachmentPanel ownerType="document" ownerId={item.id} readOnly />
                    <RelatedNotes targetType="document" targetId={item.id} />
                  </>
                )
              }
            </ResourceState>
          ) : selectedRecord ? (
            <ResourceState resource={record}>
              {(item) => (
                <>
                  <DetailHeader
                    eyebrow="RETAINED RECORD"
                    title={item.label ?? 'Source record'}
                    badges={item.archived && <span className="soft-badge">Inactive</span>}
                    metadata={
                      <>
                        <span>{item.kind}</span>
                        {item.date && <span>Source record date: {formatDate(item.date)}</span>}
                      </>
                    }
                    actions={
                      <EntryActions>
                        <ArchiveControl
                          showHistory
                          targetType="source"
                          targetId={item.id}
                          onChanged={() => {
                            change({ record: item.id }, true);
                            record.reload();
                            allRecords.reload();
                          }}
                        />
                      </EntryActions>
                    }
                  />
                  <SourceRecordView record={item} />
                  {item.file && (
                    <button className="button secondary" onClick={() => openFile(item.file!.id)}>
                      Browse this source file
                    </button>
                  )}
                </>
              )}
            </ResourceState>
          ) : selectedFile ? (
            <ResourceState resource={file}>
              {(item) => (
                <>
                  <DetailHeader
                    eyebrow="ORIGINAL FILE"
                    title={item.path.split('/').pop()}
                    badges={item.archived && <span className="soft-badge">Inactive</span>}
                    metadata={
                      <>
                        <span>
                          File acquisition source: {sourceFileAttribution(item).acquisition}
                        </span>
                        <span>
                          {formatBytes(item.bytes)} · {item.mimeType}
                        </span>
                      </>
                    }
                    actions={
                      <EntryActions>
                        <ArchiveControl
                          showHistory
                          targetType="source_file"
                          targetId={item.id}
                          onChanged={() => {
                            change({ file: item.id }, true);
                            file.reload();
                            files.reload();
                          }}
                        />
                      </EntryActions>
                    }
                  />
                  <dl className="source-fields">
                    <div>
                      <dt>File acquisition source</dt>
                      <dd>{sourceFileAttribution(item).acquisition}</dd>
                    </div>
                    {sourceFileAttribution(item).reviewedSource && (
                      <div>
                        <dt>Reviewed source label</dt>
                        <dd>{sourceFileAttribution(item).reviewedSource}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Path</dt>
                      <dd>{item.path}</dd>
                    </div>
                    <div>
                      <dt>Retained artifact</dt>
                      <dd>{sourceFileStatus(item.coverageStatus)}</dd>
                    </div>
                    <div>
                      <dt>Type</dt>
                      <dd>{item.mimeType}</dd>
                    </div>
                    <div>
                      <dt>SHA-256</dt>
                      <dd className="integrity-hash">{item.sha256}</dd>
                    </div>
                  </dl>
                  <SourcePreview file={item} />
                  <ImportSourceTextBrowser intakeId={item.id} onChanged={files.reload} />
                  <details className="retained-details">
                    <summary>Historical extraction details</summary>
                    <dl className="source-fields">
                      <div>
                        <dt>Historical coverage snapshot</dt>
                        <dd>{sourceFileCoverageStatus(item.coverageStatus)}</dd>
                      </div>
                    </dl>
                    <p className="helper-text">
                      {SOURCE_SNAPSHOT_EXPLANATION}{' '}
                      <Link className="text-link" to="/import">
                        Open current Import review
                      </Link>
                      .
                    </p>
                    <h3>File metadata and coverage notes</h3>
                    <pre className="raw-content">{JSON.stringify(item.details, null, 2)}</pre>
                  </details>
                  <h3 className="source-records-heading">Records retained from this file</h3>
                  <ResourceState
                    resource={records}
                    empty="No retained records are linked to this original file. The original remains available above."
                  >
                    {(rows) => (
                      <>
                        {rows.map((item) => (
                          <button
                            className="result-row"
                            key={item.id}
                            onClick={() => openRecord(item.id)}
                          >
                            <span className="row-copy">
                              <strong>{item.label ?? item.sourceKey ?? item.id}</strong>
                              {item.archived && <span className="soft-badge">Inactive</span>}
                              <span>
                                {item.kind} · {sourceRecordStatus(item.extractionStatus)}
                              </span>
                              <span>Record source: {item.provider ?? 'Not recorded'}</span>
                            </span>
                            <ChevronRight size={18} />
                          </button>
                        ))}
                        <Pagination
                          offset={recordOffset}
                          limit={30}
                          count={rows.length}
                          total={
                            typeof records.meta?.total === 'number' ? records.meta.total : undefined
                          }
                          onChange={(offset) => change({ recordOffset: String(offset) })}
                        />
                      </>
                    )}
                  </ResourceState>
                </>
              )}
            </ResourceState>
          ) : (
            <p className="resource-state">
              Select a file or record to inspect its original content.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
