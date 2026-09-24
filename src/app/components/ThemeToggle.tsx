import { Monitor, MoonStar, Sun } from 'lucide-react';
import { useId } from 'react';
import { useTheme } from './ThemeProvider';
import './theme-toggle.css';

const choices = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: MoonStar },
] as const;
export function ThemeToggle() {
  const name = useId();
  const { preference, select } = useTheme();
  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Appearance">
      {choices.map(({ value, label, Icon }) => (
        <label key={value} title={value === 'system' ? 'System: follow device appearance' : label}>
          <input
            type="radio"
            name={name}
            value={value}
            aria-label={label}
            checked={preference === value}
            onChange={() => select(value)}
          />
          <span>
            <Icon size={17} aria-hidden="true" />
          </span>
        </label>
      ))}
    </div>
  );
}
