import type { OpticalEye, OpticalPrescription, OpticalValue } from '../../shared/vision';
import './optical-prescription.css';

const fields: [keyof OpticalEye, string][] = [
  ['sph', 'SPH'],
  ['cyl', 'CYL'],
  ['axis', 'Axis'],
  ['add', 'ADD'],
  ['prism', 'Prism'],
  ['pd', 'PD'],
  ['baseCurve', 'Base curve'],
  ['diameter', 'Diameter'],
];
function LiteralValue({ value }: { value?: OpticalValue }) {
  return value ? (
    <>
      <span style={{ whiteSpace: 'pre-wrap' }}>{value.valueText || 'Not stated'}</span>{' '}
      <small>{value.unit || 'Unit not stated'}</small>
    </>
  ) : (
    <>Not stated</>
  );
}
export function OpticalPrescriptionPreview({
  prescription,
}: {
  prescription: OpticalPrescription;
}) {
  return (
    <div className="optical-prescription-preview">
      <p>
        {prescription.type === 'spectacle'
          ? 'Spectacle prescription'
          : prescription.type === 'contact_lens'
            ? 'Contact lens prescription'
            : 'Optical prescription · type unknown'}
      </p>
      <dl className="detail-grid">
        {prescription.typeText && (
          <div>
            <dt>Prescription type, as written</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{prescription.typeText}</dd>
          </div>
        )}
        {prescription.statusText && (
          <div>
            <dt>Prescription status, as written</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{prescription.statusText}</dd>
          </div>
        )}
        <div>
          <dt>Prescribed date, as written</dt>
          <dd>{prescription.prescribedDateText || 'Unknown date'}</dd>
        </div>
        <div>
          <dt>Expiration, as written</dt>
          <dd>{prescription.expiresDateText || 'Not stated'}</dd>
        </div>
      </dl>
      {prescription.eyes.map((eye, index) => (
        <section key={index} aria-label={`${eye.side} eye entry ${index + 1}`}>
          <h4>
            {eye.side === 'unknown'
              ? 'Side unknown'
              : eye.side === 'both'
                ? 'Both eyes'
                : `${eye.side === 'right' ? 'Right' : 'Left'} eye`}
            {eye.sideText ? ` · ${eye.sideText}` : ''}
          </h4>
          <dl className="detail-grid">
            {fields
              .filter(([key]) => eye[key] !== undefined)
              .map(([key, label]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>
                    <LiteralValue value={eye[key] as OpticalValue | undefined} />
                  </dd>
                </div>
              ))}
          </dl>
          {eye.notes && <p style={{ whiteSpace: 'pre-wrap' }}>{eye.notes}</p>}
        </section>
      ))}
      {prescription.pd && (
        <p>
          PD (not side specific): <LiteralValue value={prescription.pd} />
        </p>
      )}
      {prescription.notes && <p style={{ whiteSpace: 'pre-wrap' }}>{prescription.notes}</p>}
      <p className="helper-text">Only fields supplied in this prescription are shown.</p>
    </div>
  );
}
