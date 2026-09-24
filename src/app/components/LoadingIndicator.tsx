import { JesterCartwheel } from '../features/assistant/MoxieActivityAlternative';
import './loading-indicator.css';

export type LoadingIndicatorLayout = 'inline' | 'control' | 'panel' | 'centered';
export type LoadingIndicatorSize = 'small' | 'medium' | 'large';

export function LoadingIndicator({
  label,
  layout = 'inline',
  size = layout === 'control' ? 'small' : layout === 'centered' ? 'large' : 'medium',
  announce = true,
  className = '',
}: {
  label: string;
  layout?: LoadingIndicatorLayout;
  size?: LoadingIndicatorSize;
  /** Disable only when an ancestor already owns the live status announcement. */
  announce?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`loading-indicator loading-indicator-${layout}${className ? ` ${className}` : ''}`}
      data-size={size}
      {...(announce ? { role: 'status', 'aria-live': 'polite' as const, 'aria-atomic': true } : {})}
    >
      <JesterCartwheel className="loading-indicator-jester" />
      <span className="loading-indicator-label">{label}</span>
    </span>
  );
}
