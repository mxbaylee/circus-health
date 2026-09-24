import type { CSSProperties } from 'react';
import './moxie-activity.css';

// Each frame redraws the limbs, torso and head on a 24px grid. The character
// plants its hands and changes its silhouette; this is not a rotating icon.
const poses = [
  {
    name: 'ready',
    head: [8, 4],
    body: 'M10 12h4v5h-4z',
    arms: ['M10 13H7v3', 'M14 13h3v-2'],
    legs: ['M11 17v4H8', 'M13 17v4h3'],
  },
  {
    name: 'lean',
    head: [6, 6],
    body: 'M9 14h5v3H9z',
    arms: ['M9 15H6v4', 'M13 15h4v3'],
    legs: ['M10 17v4H7', 'M14 17h3v3h2'],
  },
  {
    name: 'handplant',
    head: [5, 11],
    body: 'M9 11h5v5H9z',
    arms: ['M9 15H7v6H5', 'M12 15v6h2'],
    legs: ['M11 11V7H8V5', 'M14 12h4V9h2'],
  },
  {
    name: 'split',
    head: [9, 13],
    inverted: true,
    body: 'M10 10h5v5h-5z',
    arms: ['M10 15H8v6H6', 'M15 15h2v6h2'],
    legs: ['M11 10V7H7V4H5', 'M14 10V7h4V4h2'],
  },
  {
    name: 'turn',
    head: [12, 11],
    inverted: true,
    body: 'M10 11h5v5h-5z',
    arms: ['M11 15v6H9', 'M15 15h3v6h2'],
    legs: ['M11 11H7V8H4', 'M14 11V6h3V3'],
  },
  {
    name: 'land',
    head: [12, 6],
    body: 'M11 14h5v3h-5z',
    arms: ['M11 15H7v2', 'M16 15h3v4'],
    legs: ['M12 17H9v4H7', 'M15 17v4h3'],
  },
  {
    name: 'ta-da',
    head: [9, 4],
    body: 'M11 12h4v5h-4z',
    arms: ['M11 13H8v-3H6', 'M15 13h3v-3h2'],
    legs: ['M12 17v4H9', 'M14 17v4h3'],
  },
];

function JesterHead({ x, y, inverted }: { x: number; y: number; inverted?: boolean }) {
  return (
    <g transform={`translate(${x} ${y})${inverted ? ' rotate(180 3 4)' : ''}`}>
      <path fill="var(--brand-lavender)" d="M0 2V0h2v1h2V0h2v2h1v3H0z" />
      <path fill="var(--brand-pink)" d="M0 2h3v3H0zM-2 0h2v3h-2z" />
      <path fill="var(--brand-blue)" d="M4 2h3v3H4zM7 0h2v3H7z" />
      <path fill="var(--brand-butter)" d="M-2 3h2v2h-2zM7 3h2v2H7zM2-1h2v2H2z" />
      <path fill="var(--brand-highlight)" d="M0 5h7v3H6v1H1V8H0z" />
      <path fill="#35263f" d="M1 5h1v1H1zM5 5h1v1H5zM2 7h3v1H2z" />
      <path fill="var(--brand-pink-fold)" d="M0 6h1v1H0zM6 6h1v1H6z" />
    </g>
  );
}

/** Mount only while work is active. The decorative frames never announce themselves. */
export function MoxieActivity({ label = 'Moxie is working…' }: { label?: string }) {
  return (
    <div className="moxie-activity" role="status" aria-live="polite" aria-atomic="true">
      <svg
        className="moxie-jester"
        viewBox="0 0 24 24"
        width="48"
        height="48"
        aria-hidden="true"
        focusable="false"
        shapeRendering="crispEdges"
      >
        {poses.map((pose, index) => (
          <g
            key={pose.name}
            className="moxie-jester-frame"
            data-pose={pose.name}
            style={{ '--frame': index } as CSSProperties}
          >
            <path d={pose.legs[0]} fill="none" stroke="var(--brand-pink)" strokeWidth="3" />
            <path d={pose.legs[1]} fill="none" stroke="var(--brand-blue)" strokeWidth="3" />
            <path d={pose.arms[0]} fill="none" stroke="var(--brand-lavender)" strokeWidth="2" />
            <path d={pose.arms[1]} fill="none" stroke="var(--brand-butter)" strokeWidth="2" />
            <path d={pose.body} fill="var(--brand-lavender)" />
            <JesterHead x={pose.head[0]} y={pose.head[1]} inverted={pose.inverted} />
          </g>
        ))}
      </svg>
      <span>{label}</span>
    </div>
  );
}
