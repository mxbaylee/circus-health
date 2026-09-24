/** Keep an ordinary in-flight save distinct from an uncertain prior operation. */
export function ImportSaveStatus({
  pendingOperation,
  saving,
  checking,
  canRetry,
  onCheck,
  onRetry,
}: {
  pendingOperation: boolean;
  saving: boolean;
  checking: boolean;
  canRetry: boolean;
  onCheck: () => void;
  onRetry: () => void;
}) {
  if (!pendingOperation) return null;
  const working = saving || checking;
  return (
    <div className="import-page-notice" role="status" aria-label="Import save status">
      <span>
        {saving
          ? 'Saving your selected results…'
          : checking
            ? 'Checking whether your results were saved…'
            : 'A save has not been confirmed yet. Check its status before retrying.'}
      </span>
      {!working && (
        <>
          <button className="button secondary" type="button" onClick={onCheck}>
            Check save status
          </button>
          {canRetry && (
            <button className="button secondary" type="button" onClick={onRetry}>
              Retry this save
            </button>
          )}
        </>
      )}
    </div>
  );
}
