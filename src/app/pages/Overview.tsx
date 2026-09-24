import { useAssistantSelection } from '../features/assistant/pageContext';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight,
  ArrowRight,
  FlaskConical,
  Layers3,
  Link2,
  Pin,
  FileText,
} from 'lucide-react';
import type { Overview as OverviewData } from '../../shared/api';
import { useResource } from '../data/api';
import { useProfile } from '../data/profile';
import { resultValue, resultUnit } from '../data/clinical';
import { formatDate, resultLink, testLink } from '../data/format';
import { ResourceState } from '../components/ResourceState';
import { MeasurementCharts } from '../components/MeasurementCharts';
import '../clinical.css';

export function Overview() {
  const resource = useResource<OverviewData>('/overview');
  const profile = useProfile();
  const featured =
    resource.data?.recentResults.find((result) => result.value !== null && !result.comparator) ??
    resource.data?.recentResults[0];
  useAssistantSelection(
    featured ? { collection: 'results', id: featured.id } : undefined,
    featured ? `Overview · ${featured.label}` : 'Overview',
  );
  return (
    <div className="page overview-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            {profile?.placebo ? 'FICTIONAL PLACEBO ARCHIVE' : 'YOUR ARCHIVE'}
          </p>
          <h1>
            Overview
            <span className="heading-star" aria-hidden="true">
              ✦
            </span>
          </h1>
          <p className="page-subtitle">
            {profile?.name
              ? `${profile.name}’s records, together in one place.`
              : 'Your records, together in one place.'}
          </p>
        </div>
        <Link to="/tests" className="button primary">
          Explore test results
          <ArrowUpRight size={18} />
        </Link>
      </div>
      <ResourceState resource={resource}>
        {(data) => {
          const recent = data.recentResults;
          const featured =
            recent.find((result) => result.value !== null && !result.comparator) ?? recent[0];
          return (
            <>
              <section className="overview-stats" aria-label="Archive at a glance">
                <Link className="stat-card" to="/tests">
                  <span className="stat-icon pink">
                    <FlaskConical size={21} />
                  </span>
                  <div>
                    <span>Structured results</span>
                    <strong>
                      {data.counts.observations.toLocaleString()}
                      <small>records</small>
                    </strong>
                  </div>
                  <ArrowUpRight size={18} className="stat-arrow" />
                </Link>
                <Link className="stat-card" to="/tests?view=by-test">
                  <span className="stat-icon blue">
                    <Layers3 size={21} />
                  </span>
                  <div>
                    <span>Measurements</span>
                    <strong>
                      {data.counts.testTypes.toLocaleString()}
                      <small>types</small>
                    </strong>
                  </div>
                  <ArrowUpRight size={18} className="stat-arrow" />
                </Link>
                <Link className="stat-card" to="/sources">
                  <span className="stat-icon lavender">
                    <Link2 size={21} />
                  </span>
                  <div>
                    <span>Original sources</span>
                    <strong>
                      {data.counts.sourceFiles.toLocaleString()}
                      <small>files</small>
                    </strong>
                  </div>
                  <ArrowUpRight size={18} className="stat-arrow" />
                </Link>
              </section>
              <div className="overview-grid">
                <section className="panel overview-trend">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">OVER TIME</p>
                      <h2>{featured?.label ?? 'Measurement history'}</h2>
                    </div>
                    {featured && (
                      <Link
                        className="icon-link"
                        to={testLink(featured.testTypeId)}
                        aria-label={`Explore ${featured.label} history`}
                      >
                        <ArrowUpRight size={21} />
                      </Link>
                    )}
                  </div>
                  {featured ? (
                    <>
                      <div className="trend-summary">
                        <span className="display-value result-text-value">
                          {resultValue(featured)} <small>{resultUnit(featured)}</small>
                        </span>
                        <span className="muted">{formatDate(featured.date)}</span>
                      </div>
                      <MeasurementCharts ids={[featured.testTypeId]} selectedId={featured.id} />
                      <Link className="text-link" to={testLink(featured.testTypeId)}>
                        Explore this history
                        <ArrowRight size={17} />
                      </Link>
                    </>
                  ) : (
                    <p className="resource-state">
                      No structured measurements are available yet. Original records can still be
                      explored in Sources.
                    </p>
                  )}
                </section>
                <section className="panel recent-panel">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">LATEST RECORDED DATES</p>
                      <h2>Recent results</h2>
                    </div>
                  </div>
                  <div className="recent-results">
                    {recent.length ? (
                      recent.slice(0, 5).map((result) => (
                        <Link className="recent-result" key={result.id} to={resultLink(result.id)}>
                          <span className="result-glyph">
                            <FlaskConical size={18} strokeWidth={1.5} />
                          </span>
                          <div>
                            <strong>{result.label}</strong>
                            <span>
                              {formatDate(result.date)} · {result.provider ?? 'Provider unknown'}
                            </span>
                          </div>
                          <span className="recent-value result-text-value">
                            {resultValue(result)}
                            <small>{resultUnit(result)}</small>
                          </span>
                        </Link>
                      ))
                    ) : (
                      <p className="resource-state">No structured results yet.</p>
                    )}
                  </div>
                  <Link className="text-link" to="/tests">
                    All test results
                    <ArrowRight size={17} />
                  </Link>
                </section>
                <section className="panel personal-panel">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">KEEP CLOSE</p>
                      <h2>Pinned notes</h2>
                    </div>
                    <Pin size={21} className="pink-icon" />
                  </div>
                  {data.pinnedNotes.length ? (
                    data.pinnedNotes.map((note) => (
                      <Link
                        className="context-item pinned-note"
                        key={note.id}
                        to={`/notes?kind=${note.kind}&id=${encodeURIComponent(note.id)}`}
                      >
                        <span className="stat-icon pink">
                          <FileText size={19} />
                        </span>
                        <div>
                          <h3>{note.title}</h3>
                          <p>
                            {note.kind === 'historical'
                              ? `${note.typeLabel ?? 'Historical note'} · ${note.status}`
                              : note.kind === 'person'
                                ? 'Person'
                                : 'Editable note'}
                          </p>
                        </div>
                        <ArrowUpRight size={17} />
                      </Link>
                    ))
                  ) : (
                    <p className="resource-state">Pin a note to keep it on your overview.</p>
                  )}
                  <Link className="text-link" to="/notes">
                    Open notes
                    <ArrowRight size={17} />
                  </Link>
                </section>
                <section className="panel archive-note">
                  <p className="eyebrow">SOURCE COVERAGE</p>
                  <h2>What is in the archive</h2>
                  <p>
                    {data.counts.sourceRecords.toLocaleString()} retained source records. Structured
                    extraction and source preservation are tracked separately.
                  </p>
                  <dl className="coverage-list">
                    {Object.entries(data.coverage).map(([status, count]) => (
                      <div key={status}>
                        <dt>{status.replaceAll('_', ' ')}</dt>
                        <dd>{count.toLocaleString()}</dd>
                      </div>
                    ))}
                  </dl>
                  <Link className="text-link" to="/sources">
                    Inspect sources and coverage
                    <ArrowRight size={17} />
                  </Link>
                </section>
              </div>
              <p className="coverage-caption">
                Database revision {String(resource.meta?.revision ?? 'unknown')}.{' '}
                {profile?.placebo
                  ? 'Every record in this profile is fictional.'
                  : 'The raw archive remains canonical; counts of structured results do not measure completeness of your medical chart.'}
              </p>
            </>
          );
        }}
      </ResourceState>
    </div>
  );
}
