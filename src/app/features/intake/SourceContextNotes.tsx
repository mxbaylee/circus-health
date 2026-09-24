import type { IntakeSourceContext } from '../../../shared/intake';

/** Retained source context is evidence to inspect, never a clinical decision to save. */
export function SourceContextNotes({ items }: { items: IntakeSourceContext[] }) {
  return (
    <div className="intake-source-context">
      {items.map((item, index) => (
        <details key={item.id}>
          <summary>
            {item.title}
            {items.length > 1 ? ` ${index + 1}` : ''}
          </summary>
          {item.notes.length > 0 && (
            <ul>
              {item.notes.map((note, noteIndex) => (
                <li key={noteIndex}>{note}</li>
              ))}
            </ul>
          )}
          <pre tabIndex={0} aria-label={`Retained ${item.title.toLowerCase()} ${index + 1}`}>
            {item.text}
          </pre>
          {item.evidence.map((evidence, evidenceIndex) => (
            <p className="helper-text" key={evidenceIndex}>
              {evidence.contentUrl ? (
                <a href={evidence.contentUrl} target="_blank" rel="noreferrer">
                  {evidence.label}
                </a>
              ) : (
                evidence.label
              )}
              {evidence.locator && <> · {evidence.locator}</>}
            </p>
          ))}
        </details>
      ))}
    </div>
  );
}
