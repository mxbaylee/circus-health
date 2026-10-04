import type {
  IntakePackageInventoryPaged,
  IntakePackageMemberReference,
} from '../../../shared/intake-package-paging';
import { PackageMemberDetails } from './PackageMemberDetails';
import { useEffect, useState } from 'react';
import type {
  IntakePackageFailure,
  IntakePackageInventory,
  IntakePackageMember,
} from '../../../shared/intake';
import {
  isIntakeSummary,
  type IntakeRead,
  type IntakePackageFailurePage,
} from '../../../shared/intake-summary';
import { api, useResource } from '../../data/api';
import { formatBytes } from '../../data/format';
import { ResourceState } from '../../components/ResourceState';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import { PackageProcessingFailures } from './PackageProcessingFailures';

type PackageMember = IntakePackageMember | IntakePackageMemberReference;
const isMemberReference = (member: PackageMember): member is IntakePackageMemberReference =>
  'format' in member && member.format === 'health-intake-package-member-reference-v1';
const memberName = (member: PackageMember) =>
  isMemberReference(member)
    ? member.filenamePreview + (member.filenameTruncated ? '…' : '')
    : member.filename;
type Structure = {
  jsonPointer: string;
  type: string;
  totalChildren: number;
  children: {
    key: string;
    jsonPointer: string | null;
    type: string;
    totalChildren: number | null;
  }[];
  literal: string | null;
  offset: number;
  nextOffset: number | null;
  nextJSONOffset: number | null;
};
type MemberRead = {
  member: PackageMember;
  contentUrl?: string;
  sourceFileId?: string;
  literal?: string;
  structure?: Structure;
  structureIssue?: string;
  note?: string;
  nextAction?: string;
  imageContent?: string;
  original?: {
    text?: string | null;
    nextOffset?: number | null;
    page?: number;
    totalPages?: number;
    nextPage?: number | null;
    note?: string;
  };
  metadata?: {
    member: PackageMember;
    contentUrl?: string;
    original?: MemberRead['original'];
    note?: string;
  };
};

export function PackageInventory({ intake }: { intake: IntakeRead }) {
  const [offset, setOffset] = useState(0);
  const inventory = useResource<IntakePackageInventory | IntakePackageInventoryPaged>(
    `/intakes/${encodeURIComponent(intake.id)}/package?offset=${offset}&limit=50`,
  );
  const [selected, setSelected] = useState<PackageMember | null>(null);
  const [read, setRead] = useState<MemberRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [failureCursor, setFailureCursor] = useState<string | null>(null);
  const paged = isIntakeSummary(intake);
  const failureState = useResource<IntakeRead>(
    paged ? null : `/intakes/${encodeURIComponent(intake.id)}`,
  );
  const failurePage = useResource<IntakePackageFailurePage>(
    paged
      ? `/intakes/${encodeURIComponent(intake.id)}/package-failures?limit=25${failureCursor ? `&cursor=${encodeURIComponent(failureCursor)}` : ''}`
      : null,
  );
  const refreshFailures = () => {
    setFailureCursor(null);
    failureState.reload();
    failurePage.reload();
  };
  useEffect(() => setFailureCursor(null), [intake.id, intake.version]);
  useEffect(() => inventory.reload(), [intake.version]);
  useEffect(() => {
    if (!inventory.loading && !inventory.refreshing) refreshFailures();
  }, [inventory.loading, inventory.refreshing, inventory.data, inventory.error]);
  async function inspect(
    member: PackageMember,
    window: { jsonPointer?: string; jsonOffset?: number; offset?: number; page?: number } = {},
  ) {
    setBusy(true);
    setError('');
    setSelected(member);
    try {
      const result = await api<MemberRead>(
        `/intakes/${encodeURIComponent(intake.id)}/package-member`,
        {
          method: 'POST',
          body: JSON.stringify({ memberId: member.memberId, limit: 50, ...window }),
        },
      );
      setRead(result.data.metadata ? { ...result.data, ...result.data.metadata } : result.data);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'This member could not be inspected.');
    } finally {
      setBusy(false);
      refreshFailures();
    }
  }
  async function retryFailure(failure: IntakePackageFailure) {
    if (failure.retryAction === 'inventory') {
      inventory.reload();
      return;
    }
    if (!failure.memberId) return;
    setSelected(null);
    setRead(null);
    setHistory([]);
    setBusy(true);
    setError('');
    try {
      const result = await api<MemberRead>(
        `/intakes/${encodeURIComponent(intake.id)}/package-member`,
        {
          method: 'POST',
          body: JSON.stringify({
            memberId: failure.memberId,
            limit: 50,
            ...(failure.retryAction === 'read_structure' ? { jsonPointer: '' } : {}),
          }),
        },
      );
      const resultRead = result.data.metadata
        ? { ...result.data, ...result.data.metadata }
        : result.data;
      setSelected(resultRead.member);
      setRead(resultRead);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'This operation could not finish.');
    } finally {
      setBusy(false);
      refreshFailures();
    }
  }
  return (
    <section className="intake-package" aria-label="Package contents">
      <h3>Package contents</h3>
      <a className="text-link" href={intake.contentUrl} target="_blank" rel="noreferrer">
        Open original: {intake.filename}
      </a>
      {failurePage.error && (
        <p role="alert">
          {failurePage.error.message}{' '}
          <button className="text-link" onClick={refreshFailures}>
            Reload processing issues
          </button>
        </p>
      )}
      {paged && !failurePage.data && !failurePage.error && (
        <p role="status">Checking unfinished operations…</p>
      )}
      <PackageProcessingFailures
        failures={
          failureState.data && !isIntakeSummary(failureState.data)
            ? failureState.data.packageFailures
            : !paged
              ? intake.packageFailures
              : undefined
        }
        page={failurePage.data ?? undefined}
        onFirst={failureCursor ? () => setFailureCursor(null) : undefined}
        onNext={() => setFailureCursor(failurePage.data?.nextCursor ?? null)}
        busy={busy || inventory.loading || !!inventory.refreshing}
        onRetry={(failure) => void retryFailure(failure)}
      />
      <ResourceState resource={inventory}>
        {(data) => (
          <>
            <p>
              {data.totalMembers} retained file occurrences · {formatBytes(data.totalExpandedBytes)}{' '}
              expanded · {data.uniqueByteContents} distinct byte contents.
            </p>
            <p className="helper-text">
              An inventory lists what was supplied. Reading a member and reviewing its role do not
              mark extraction complete.
            </p>
            <ul className="intake-package-members">
              {data.members.map((member) => (
                <li key={member.memberId}>
                  <button
                    className="text-link"
                    disabled={busy}
                    onClick={() => {
                      setHistory([]);
                      void inspect(member);
                    }}
                  >
                    {memberName(member) || 'Unnamed member'}
                  </button>
                  {isMemberReference(member) ? (
                    <>
                      <span>
                        {member.filenameTruncated
                          ? 'File name shortened for display'
                          : 'File details available below'}
                      </span>
                      <PackageMemberDetails reference={member.metadata} />
                    </>
                  ) : (
                    <>
                      <span>
                        {formatBytes(member.bytes)} · {member.role?.role || 'Role unknown'} ·{' '}
                        {member.coverage?.kind || member.status || 'Not read'}
                      </span>
                      {member.duplicateOf && (
                        <small>
                          Same bytes as another occurrence; both original locations remain retained.
                        </small>
                      )}
                      {member.role && (
                        <details>
                          <summary>Role and references</summary>
                          <p>{member.role.reason}</p>
                          <p>
                            {member.role.referenceCount} references ·{' '}
                            {member.role.missingReferenceCount} not supplied
                            {!!member.role.ambiguousReferenceCount &&
                              ` · ${member.role.ambiguousReferenceCount} ambiguous`}
                          </p>
                        </details>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
            <div className="intake-actions">
              <button
                className="text-link"
                disabled={!offset || busy}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                Previous members
              </button>
              <span>
                {data.members.length ? offset + 1 : 0}–{offset + data.members.length} of{' '}
                {data.totalMembers}
              </span>
              <button
                className="text-link"
                disabled={data.nextOffset === null || busy}
                onClick={() => setOffset(data.nextOffset!)}
              >
                Next members
              </button>
            </div>
          </>
        )}
      </ResourceState>
      {busy && <LoadingIndicator label="Reading selected member…" layout="panel" />}
      {error && (
        <p role="alert">
          {error}{' '}
          {selected && (
            <button className="text-link" onClick={() => void inspect(selected)}>
              Retry member
            </button>
          )}
        </p>
      )}
      {read && selected?.memberId === read.member.memberId && (
        <section className="intake-member-reading" aria-label="Selected package member">
          <h4>{memberName(read.member)}</h4>
          {isMemberReference(read.member) ? (
            <PackageMemberDetails reference={read.member.metadata} />
          ) : (
            <p className="helper-text">{read.member.locator}</p>
          )}
          {read.contentUrl && (
            <a className="text-link" href={read.contentUrl} target="_blank" rel="noreferrer">
              Open retained member
            </a>
          )}
          {read.structure && (
            <>
              <p>
                {read.structure.jsonPointer || 'Root'} · {read.structure.type}
                {read.structure.totalChildren ? ` · ${read.structure.totalChildren} entries` : ''}
              </p>
              {history.length > 0 && (
                <button
                  className="text-link"
                  disabled={busy}
                  onClick={() => {
                    const previous = history.at(-1)!;
                    setHistory(history.slice(0, -1));
                    void inspect(read.member, { jsonPointer: previous });
                  }}
                >
                  Back to parent section
                </button>
              )}
              <ul>
                {read.structure.children.map((child, index) => (
                  <li key={child.jsonPointer || index}>
                    <button
                      className="text-link"
                      disabled={busy || child.jsonPointer === null}
                      onClick={() => {
                        setHistory([...history, read.structure!.jsonPointer]);
                        void inspect(read.member, { jsonPointer: child.jsonPointer! });
                      }}
                    >
                      {child.key}
                    </button>{' '}
                    · {child.type}
                    {child.totalChildren ? ` · ${child.totalChildren} entries` : ''}
                    {child.jsonPointer === null &&
                      ' · Location too long to inspect here; open retained member.'}
                  </li>
                ))}
              </ul>
              {read.structure.literal !== null && (
                <details open={!read.structure.children.length}>
                  <summary>Literal source text</summary>
                  <pre className="intake-member-literal">{read.structure.literal}</pre>
                </details>
              )}
              {read.structure.nextJSONOffset !== null && (
                <button
                  className="text-link"
                  disabled={busy}
                  onClick={() =>
                    void inspect(read.member, {
                      jsonPointer: read.structure!.jsonPointer,
                      jsonOffset: read.structure!.nextJSONOffset!,
                    })
                  }
                >
                  Next entries
                </button>
              )}
              {read.structure.nextOffset !== null && (
                <button
                  className="text-link"
                  disabled={busy}
                  onClick={() =>
                    void inspect(read.member, {
                      jsonPointer: read.structure!.jsonPointer,
                      offset: read.structure!.nextOffset!,
                    })
                  }
                >
                  Continue literal text
                </button>
              )}
            </>
          )}
          {read.structureIssue && <p>{read.structureIssue}</p>}
          {read.imageContent?.startsWith('data:image/') && (
            <img
              className="intake-member-image"
              src={read.imageContent}
              alt={`${memberName(read.member)}${read.original?.page ? `, page ${read.original.page}` : ''}`}
            />
          )}
          {read.original?.text && <div className="intake-readable-text">{read.original.text}</div>}
          {read.literal === '' && <p>This occurrence is empty.</p>}
          {read.original?.nextOffset != null && (
            <button
              className="text-link"
              disabled={busy}
              onClick={() =>
                void inspect(read.member, {
                  offset: read.original!.nextOffset!,
                  ...(read.original?.page ? { page: read.original.page } : {}),
                })
              }
            >
              Continue member text
            </button>
          )}
          {read.original?.totalPages && (
            <div className="intake-actions">
              <span>
                Page {read.original.page || 1} of {read.original.totalPages}
              </span>
              <button
                className="text-link"
                disabled={busy || (read.original.page || 1) <= 1}
                onClick={() => void inspect(read.member, { page: (read.original!.page || 1) - 1 })}
              >
                Previous page
              </button>
              <button
                className="text-link"
                disabled={busy || read.original.nextPage == null}
                onClick={() => void inspect(read.member, { page: read.original!.nextPage! })}
              >
                Next page
              </button>
            </div>
          )}
          {read.nextAction === 'inventory' && (
            <p>This member is another archive. Its contents have not been expanded.</p>
          )}
          <p className="helper-text">
            {read.note ||
              read.original?.note ||
              'This bounded view does not claim that the member has been fully extracted.'}
          </p>
        </section>
      )}
    </section>
  );
}
