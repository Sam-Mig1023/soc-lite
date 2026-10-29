import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/context/ThemeContext';

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className = '' }: ThemeToggleProps): JSX.Element {
  const { theme, toggleTheme } = useTheme();
  const nextTheme = theme === 'dark' ? 'claro' : 'oscuro';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={`inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800/70 px-2.5 py-2 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700 hover:text-slate-100 ${className}`}
      aria-label={`Cambiar a modo ${nextTheme}`}
      title={`Cambiar a modo ${nextTheme}`}
    >
      {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
      <span className="hidden sm:inline">{theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}</span>
    </button>
  );
}
