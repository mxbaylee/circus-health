import './moxie-activity-alternative.css';

// A 32 × 32 pixel drawing. Uppercase colors are the lit fabric; lowercase
// colors are its folds. Dots are transparent, including around the bells.
const colors = {
  P: 'var(--brand-pink)',
  p: 'var(--brand-pink-fold)',
  B: 'var(--brand-blue)',
  b: 'var(--brand-blue-fold)',
  L: 'var(--brand-lavender)',
  l: 'var(--brand-lavender-fold)',
  Y: 'var(--brand-butter)',
  y: 'var(--brand-butter-fold)',
  F: 'var(--brand-highlight)',
  Q: 'var(--brand-pink-fold)',
  K: '#35263f',
} as const;
type Color = keyof typeof colors;
type Patch = readonly [color: Color, path: string];

const smilingHead = [
  '...bbb.....ppp.....',
  '..bBBBb...pPPPp...',
  '.bBBBBBb.pPPPPPp..',
  '.bBBb.BBLPPp.PPp..',
  '.bB...BLLLLb..Pp..',
  '.YY...LFLFLFL.YY..',
  '.yy...bBBBBb..yy..',
  '.....bBFFBFFBb....',
  '.....bFKFFKFBb....',
  '.....bFQFFQFBb....',
  '......bFKKFb......',
  '.......bFFb.......',
  '.......LFFL.......',
] as const;

// Only the head changes orientation here. Every body below is separately
// drawn: bent knees, planted hands, the open split, transfer and landing.
// Keeping those drawings on the grid avoids a standing sprite spinning.
function headPixels(turn: 0 | 1 | 2 | 3) {
  let pixels: string[] = [...smilingHead];
  for (let i = 0; i < turn; i++) {
    pixels = Array.from({ length: pixels[0].length }, (_, x) =>
      pixels
        .map((row) => row[x])
        .reverse()
        .join(''),
    );
  }
  return pixels;
}
const heads = [headPixels(0), headPixels(1), headPixels(2), headPixels(3)];

type Pose = {
  name: string;
  head: readonly [x: number, y: number, turn: 0 | 1 | 2 | 3];
  patches: readonly Patch[];
};

const ready: readonly Patch[] = [
  ['L', 'M10 15h10v2h2v3h-3v-2h-8v2H8v-3h2z'],
  ['F', 'M7 19h3v3H7zM20 19h3v3h-3z'],
  ['P', 'M12 17h4v7h-1v4h-4v-4h1z'],
  ['p', 'M14 22h2v3h-1v3h-1zM9 29h6v1H8v-2h1z'],
  ['B', 'M16 17h4v7h1v4h-4v-4h-1z'],
  ['b', 'M19 22h1v2h1v4h-1zM17 29h6v-1h1v2h-7z'],
  ['P', 'M10 27h5v2H8v-1h2z'],
  ['B', 'M17 27h5v1h2v1h-7z'],
  ['L', 'M11 25h4v1h-4zM17 25h4v1h-4zM12 22h8v1h-8z'],
  ['Y', 'M15 18h2v1h1v1h-1v1h-2v-1h-1v-1h1z'],
  ['F', 'M10 15h2v1h2v1h2v-1h2v-1h2v1h-1v1h-2v1h-2v-1h-2v-1h-3z'],
];

const poses: readonly Pose[] = [
  { name: 'ready', head: [7, 2, 0], patches: ready },
  {
    name: 'windup',
    head: [6, 4, 0],
    patches: [
      ['L', 'M10 17h9v2h3v2h2v2h-3v-2h-3v-1h-7v2H8v-3h2z'],
      ['F', 'M6 21h4v2H6zM23 22h3v3h-3z'],
      ['P', 'M11 19h4v5h-4v3H8v-4h3zM7 28h5v2H5v-1h2z'],
      ['p', 'M9 24h2v3H9zM5 29h7v1H5z'],
      ['B', 'M15 19h4v4h3v4h-4v-3h-3zM18 27h4v1h3v2h-7z'],
      ['b', 'M21 23h1v4h-1zM18 29h7v1h-7z'],
      ['L', 'M8 26h4v1H8zM18 26h4v1h-4zM11 22h8v1h-8z'],
      ['Y', 'M14 19h2v1h1v1h-3z'],
      ['F', 'M9 17h3v1h2v1h2v-1h3v1h-2v1h-3v-1h-3v-1H9z'],
    ],
  },
  {
    name: 'reach',
    head: [4, 9, 3],
    patches: [
      ['B', 'M14 19h5v3h4v4h-3v-2h-3v-2h-3zM23 26h3v2h3v2h-6z'],
      ['b', 'M19 22h1v1h3v3h-1v-2h-3zM23 29h6v1h-6z'],
      ['P', 'M13 17h3v5h-2v5h-4v-4h1v-4h2zM9 27h5v2H7v-1h2z'],
      ['p', 'M12 23h2v4h-2zM7 29h7v1H7z'],
      ['L', 'M13 15h4v2h-3v6h-3v-3h1v-3h1zM15 15h4v-2h2v-3h2v5h-3v3h-4z'],
      ['F', 'M10 23h3v4h-1v3H8v-2h2zM21 7h3v4h-3z'],
      ['l', 'M8 29h4v1H8z'],
      ['L', 'M10 26h4v1h-4zM23 26h3v1h-3zM13 21h5v1h-5z'],
      ['Y', 'M15 17h2v1h1v1h-3z'],
      ['F', 'M13 14h2v2h2v1h-2v1h-2v-1h-1v-2h1z'],
    ],
  },
  {
    name: 'kick',
    head: [1, 16, 2],
    patches: [
      ['P', 'M12 15h4v-4h-1V7h-4v5h1zM9 4h5v3h-4V6H8V3h1z'],
      ['p', 'M14 7h1v4h1v4h-1v-3h-1zM8 3h1v3H8z'],
      ['B', 'M16 14h3v-3h4V8h4v4h-3v2h-4v4h-4zM26 7h3v3h1v2h-3V9h-1z'],
      ['b', 'M22 11h2v2h-4v1h-1v-2h3zM29 10h1v2h-1z'],
      ['L', 'M12 14h7v5h-2v2h-2v5h-3v-7h-2v5H8v4H5v-5h2v-4h2v-3h3z'],
      ['P', 'M12 14h4v5h-4z'],
      ['B', 'M16 14h3v5h-3z'],
      ['F', 'M4 28h5v2H4zM12 26h3v2h2v2h-5z'],
      ['l', 'M4 29h5v1H4zM12 29h5v1h-5z'],
      ['Y', 'M14 15h2v1h1v1h-2v1h-1z'],
      ['L', 'M10 7h5v1h-5zM26 7h1v4h-1z'],
      ['F', 'M10 18h3v1h2v1h-2v1h-2v-1h-1z'],
    ],
  },
  {
    name: 'split',
    head: [7, 17, 2],
    patches: [
      ['P', 'M13 15h4v-4h-3V8h-3V5H7v4h3v3h3zM5 2h4v3H6V4H4V1h1z'],
      ['p', 'M10 6h1v2h3v3h3v4h-1v-3h-3V9h-3zM4 1h1v3H4z'],
      ['B', 'M17 15h3v-3h3V9h3V5h-4v3h-3v3h-2zM24 2h4V1h1v3h-2v1h-3z'],
      ['b', 'M25 5h1v4h-3v3h-3v3h-1v-4h3V8h3zM28 1h1v3h-1z'],
      ['L', 'M12 15h9v4h2v4h2v5h-3v-4h-2v-4h-8v4h-2v4H7v-5h2v-4h3z'],
      ['P', 'M13 14h4v5h-4z'],
      ['B', 'M17 14h3v5h-3z'],
      ['Y', 'M16 15h2v1h1v1h-1v1h-2v-1h-1v-1h1z'],
      ['F', 'M5 28h5v2H5zM22 28h5v2h-5zM12 19h2v1h2v1h2v-1h2v-1h1v1h-2v2h-4v-1h-3z'],
      ['l', 'M5 29h5v1H5zM22 29h5v1h-5z'],
      ['L', 'M7 5h4v1H7zM22 5h4v1h-4z'],
    ],
  },
  {
    name: 'transfer',
    head: [13, 16, 2],
    patches: [
      ['P', 'M14 15h4v-4h-3V8h-4V6H7v4h3v2h4zM4 5h4v3H6v2H4z'],
      ['p', 'M7 9h3v2h4v4h-1v-3H9v-2H7zM4 8h1v2H4z'],
      ['B', 'M18 15h4v-5h1V6h-4v5h-1zM19 3h5V2h2v2h-2v2h-5z'],
      ['b', 'M22 6h1v4h-1v5h-1v-5h1zM25 2h1v2h-1z'],
      ['L', 'M15 14h8v4h2v4h2v6h-3v-5h-2v-4h-4v5h-3v3h-3v-5h3z'],
      ['P', 'M15 14h4v5h-4z'],
      ['B', 'M19 14h4v5h-4z'],
      ['Y', 'M18 15h2v1h1v1h-1v1h-2z'],
      ['F', 'M11 27h4v3H9v-2h2zM24 28h5v2h-5zM18 19h5v1h-1v1h-3v-1h-1z'],
      ['l', 'M9 29h6v1H9zM24 29h5v1h-5z'],
      ['L', 'M7 6h1v4H7zM19 6h4v1h-4z'],
    ],
  },
  {
    name: 'landing',
    head: [15, 9, 1],
    patches: [
      ['P', 'M12 17h6v5h-4v3h-4v-4h2zM7 24h4v3H8v2H6v-4h1z'],
      ['p', 'M11 22h3v3h-1v-2h-2zM6 27h1v2H6z'],
      ['B', 'M18 17h3v5h2v5h-4v-4h-1zM19 27h5v1h3v2h-8z'],
      ['b', 'M22 22h1v5h-1zM19 29h8v1h-8z'],
      ['L', 'M17 15h5v5h2v5h-3v-5h-4zM13 14h4v4h-4v-3h-3v-3H8V9h3v3h2z'],
      ['F', 'M7 7h3v3H7zM22 25h3v3h2v2h-5z'],
      ['l', 'M22 29h5v1h-5z'],
      ['Y', 'M16 18h2v1h1v1h-3z'],
      ['L', 'M8 24h3v1H8zM19 26h4v1h-4zM15 21h6v1h-6z'],
      ['F', 'M17 14h2v2h2v2h-2v-1h-2v-1h-1v-1h1z'],
    ],
  },
  {
    name: 'rebound',
    head: [9, 5, 0],
    patches: [
      ['L', 'M12 18h10v2h2v3h-3v-2h-8v2h-3v-3h2z'],
      ['F', 'M8 22h4v3H8zM23 22h3v3h-3z'],
      ['P', 'M14 20h3v4h-4v4H9v-5h5zM8 28h5v2H6v-1h2z'],
      ['p', 'M12 24h1v4h-1zM6 29h7v1H6z'],
      ['B', 'M17 20h4v3h4v5h-4v-4h-4zM21 28h5v1h2v1h-7z'],
      ['b', 'M24 23h1v5h-1zM21 29h7v1h-7z'],
      ['L', 'M9 27h4v1H9zM21 27h4v1h-4zM14 23h7v1h-7z'],
      ['Y', 'M16 20h2v2h-2z'],
      ['F', 'M12 18h3v1h2v1h2v-1h3v1h-2v1h-3v-1h-3v-1h-2z'],
    ],
  },
  {
    name: 'ta-da',
    head: [7, 2, 0],
    patches: [
      ...ready.slice(2),
      ['L', 'M10 15h2v3H9v-2H6v-3H4v-3h3v3h3zM19 15h3v-2h3v-3h3v3h-2v3h-4v2h-3z'],
      ['F', 'M3 8h1V6h1v2h1V7h1v4H4V9H3zM25 7h1v1h1V6h1v2h1v2h-1v1h-3z'],
      ['L', 'M4 11h3v1H4zM25 11h3v1h-3z'],
    ],
  },
];

// Compile same-color horizontal pixel runs once, instead of a DOM node per
// pixel or a runtime canvas. These SVG paths inherit the application's palette.
function drawHead(pixels: readonly string[], x: number, y: number): Patch[] {
  const paths = new Map<Color, string>();
  pixels.forEach((row, dy) => {
    for (let start = 0; start < row.length;) {
      const color = row[start];
      let end = start + 1;
      while (row[end] === color) end++;
      if (color !== '.') {
        const key = color as Color;
        paths.set(
          key,
          `${paths.get(key) ?? ''}M${x + start} ${y + dy}h${end - start}v1h-${end - start}z`,
        );
      }
      start = end;
    }
  });
  return [...paths];
}
const frames = poses.map((pose) => ({
  ...pose,
  drawing: [...pose.patches, ...drawHead(heads[pose.head[2]], pose.head[0], pose.head[1])],
}));

export function JesterCartwheel({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`moxie-jester-alternative${className ? ` ${className}` : ''}`}
      viewBox="0 0 32 32"
      width="48"
      height="48"
      aria-hidden="true"
      focusable="false"
      shapeRendering="crispEdges"
    >
      {frames.map((pose) => (
        <g className="moxie-jester-alternative-frame" key={pose.name} data-pose={pose.name}>
          {pose.drawing.map(([color, path], index) => (
            <path key={index} fill={colors[color]} d={path} />
          ))}
        </g>
      ))}
    </svg>
  );
}

/** Experimental Version B. Mount only for active work, as with MoxieActivity. */
export function MoxieActivityAlternative({ label = 'Moxie is working…' }: { label?: string }) {
  return (
    <div className="moxie-activity-alternative" role="status" aria-live="polite" aria-atomic="true">
      <JesterCartwheel />
      <span>{label}</span>
    </div>
  );
}
