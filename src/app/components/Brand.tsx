import { BrandMark } from './BrandMark.generated';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`brand ${compact ? 'compact' : ''}`}
      title="Your circus, your monkeys, all under one tent."
    >
      <BrandMark
        className="brand-mark"
        aria-label="Your circus, your monkeys, all under one tent."
      />
      <span>Circus Health</span>
    </div>
  );
}

export function HarlequinAccent() {
  return <div className="harlequin-accent" aria-hidden="true" />;
}
