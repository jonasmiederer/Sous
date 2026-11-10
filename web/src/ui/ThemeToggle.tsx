import { Monitor, Moon, Sun } from 'lucide-react';
import { IconButton } from './IconButton';
import { nextThemePreference, useThemePreference, type ThemePreference } from './theme';

const ICONS = { system: Monitor, light: Sun, dark: Moon } as const;
const NAMES: Record<ThemePreference, string> = { system: 'device setting', light: 'light', dark: 'dark' };

/** Cycles the color theme: device setting → light → dark. Stored in `sous.theme.v1`. */
export function ThemeToggle({ className }: { className?: string }) {
  const [preference, setPreference] = useThemePreference();
  const next = nextThemePreference(preference);
  const Icon = ICONS[preference];
  return (
    <IconButton
      label={`Theme: ${NAMES[preference]}. Switch to ${NAMES[next]}`}
      icon={<Icon />}
      onClick={() => setPreference(next)}
      className={className}
    />
  );
}
