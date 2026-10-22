/**
 * SOC-Lite · Selector de rango de fechas con presets y conversión a ISO-8601.
 * Los valores `from`/`to` que expone son cadenas `yyyy-MM-dd` (aptas para <input type="date">)
 * y las utilidades `isoFrom`/`isoTo` los convierten al formato que espera la API.
 */
import { CalendarDays, ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cx, daysAgoIso, toIsoDate } from '@/utils/format';

export interface DateRangeValue {
  from: string;
  to: string;
}

export interface DateRangePickerProps {
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  /** Presets visibles (en días hacia atrás). */
  presets?: number[];
  showPresets?: boolean;
  label?: string;
  className?: string;
  disabled?: boolean;
}

/** Convierte `yyyy-MM-dd` (inicio del día local) al ISO con zona que espera la API. */
export function isoFrom(date?: string): string | undefined {
  if (!date) return undefined;
  const parsed = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** Convierte `yyyy-MM-dd` (fin del día local) al ISO con zona que espera la API. */
export function isoTo(date?: string): string | undefined {
  if (!date) return undefined;
  const parsed = new Date(`${date}T23:59:59`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Selector de rango con dos inputs `date` y botones de preset (24 h, 7 d, 30 d, 90 d).
 * Accesible: cada input tiene etiqueta asociada y el grupo un `role="group"`.
 */
export function DateRangePicker({
  value,
  onChange,
  presets = [1, 7, 30, 90],
  showPresets = true,
  label = 'Rango de fechas',
  className,
  disabled = false,
}: DateRangePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);

  const activePreset = useMemo(() => {
    const today = toIsoDate(new Date());
    const match = presets.find((days) => value.to === today && value.from === daysAgoIso(days));
    return match ?? null;
  }, [presets, value.from, value.to]);

  const applyPreset = (days: number): void => {
    onChange({ from: daysAgoIso(days), to: toIsoDate(new Date()) });
    setOpen(false);
  };

  return (
    <div className={cx('relative', className)} role="group" aria-label={label}>
      <button
        type="button"
        className="soc-btn-secondary w-full justify-between"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
      >
        <span className="flex items-center gap-2 truncate">
          <CalendarDays size={15} aria-hidden="true" className="text-cyan-400" />
          <span className="truncate font-mono text-xs">
            {value.from || 'inicio'} → {value.to || 'hoy'}
          </span>
        </span>
        <ChevronDown size={14} aria-hidden="true" className={cx('transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <div
          className="absolute right-0 z-30 mt-2 w-72 animate-fade-in rounded-xl border border-slate-800 bg-slate-900 p-3 shadow-panel"
          role="dialog"
          aria-label="Seleccionar rango de fechas"
        >
          {showPresets ? (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {presets.map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => applyPreset(days)}
                  className={cx(
                    'rounded-md border px-2 py-1 text-xs transition-colors',
                    activePreset === days
                      ? 'border-cyan-600 bg-cyan-950/60 text-cyan-200'
                      : 'border-slate-700 text-slate-300 hover:border-slate-600 hover:bg-slate-800',
                  )}
                >
                  {days === 1 ? '24 h' : `${days} días`}
                </button>
              ))}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="soc-label" htmlFor="date-range-from">
                Desde
              </label>
              <input
                id="date-range-from"
                type="date"
                className="soc-input"
                value={value.from}
                max={value.to || undefined}
                onChange={(event) => onChange({ ...value, from: event.target.value })}
                disabled={disabled}
              />
            </div>
            <div>
              <label className="soc-label" htmlFor="date-range-to">
                Hasta
              </label>
              <input
                id="date-range-to"
                type="date"
                className="soc-input"
                value={value.to}
                min={value.from || undefined}
                onChange={(event) => onChange({ ...value, to: event.target.value })}
                disabled={disabled}
              />
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-800 pt-3">
            <button
              type="button"
              className="soc-btn-ghost px-2 py-1 text-xs"
              onClick={() => onChange({ from: '', to: '' })}
            >
              Limpiar
            </button>
            <button type="button" className="soc-btn-primary px-3 py-1 text-xs" onClick={() => setOpen(false)}>
              Aplicar
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default DateRangePicker;
