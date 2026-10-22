/**
 * SOC-Lite · Barra de filtros reutilizable.
 * `FilterBar` dispone los controles en una rejilla responsive y ofrece un botón de
 * limpieza; `FilterField` es el contenedor con etiqueta de cada control.
 */
import type { ReactNode } from 'react';
import { Filter, RotateCcw, Search } from 'lucide-react';
import { cx } from '@/utils/format';

export interface FilterFieldProps {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

/** Campo de filtro con etiqueta asociada. */
export function FilterField({ label, htmlFor, children, className }: FilterFieldProps): JSX.Element {
  return (
    <div className={cx('flex flex-col', className)}>
      <label className="soc-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

export interface FilterBarProps {
  children: ReactNode;
  /** Callback de limpieza; si se omite, no se muestra el botón. */
  onReset?: () => void;
  /** Número de filtros activos, mostrado como contador. */
  activeCount?: number;
  /** Contenido extra a la derecha (p. ej. botón de exportar). */
  actions?: ReactNode;
  /** Buscador integrado. */
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  className?: string;
  /** Número de columnas en pantallas grandes. */
  columns?: 2 | 3 | 4 | 5;
}

const COLUMN_CLASSES: Record<NonNullable<FilterBarProps['columns']>, string> = {
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-2 lg:grid-cols-3',
  4: 'sm:grid-cols-2 lg:grid-cols-4',
  5: 'sm:grid-cols-2 lg:grid-cols-5',
};

/**
 * Contenedor de filtros de listado. Los controles hijos suelen ser
 * `<FilterField>` con `<select>`, `<input>` o `<DateRangePicker>`.
 */
export function FilterBar({
  children,
  onReset,
  activeCount = 0,
  actions,
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Buscar…',
  className,
  columns = 4,
}: FilterBarProps): JSX.Element {
  return (
    <section className={cx('soc-panel relative z-20 mb-4 p-4', className)} aria-label="Filtros de búsqueda">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
          <Filter size={14} aria-hidden="true" className="text-cyan-400" />
          Filtros
          {activeCount > 0 ? (
            <span className="rounded-full border border-cyan-800 bg-cyan-950/60 px-1.5 py-0.5 text-[10px] text-cyan-300">
              {activeCount} activo{activeCount === 1 ? '' : 's'}
            </span>
          ) : null}
        </h2>
        <div className="flex items-center gap-2">
          {actions}
          {onReset ? (
            <button type="button" className="soc-btn-ghost px-2 py-1 text-xs" onClick={onReset}>
              <RotateCcw size={13} aria-hidden="true" />
              Limpiar
            </button>
          ) : null}
        </div>
      </div>

      <div className={cx('grid grid-cols-1 gap-3', COLUMN_CLASSES[columns])}>
        {onSearchChange ? (
          <FilterField label="Búsqueda" htmlFor="filter-search">
            <div className="relative">
              <Search
                size={15}
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
              />
              <input
                id="filter-search"
                type="search"
                className="soc-input pl-9"
                value={searchValue ?? ''}
                placeholder={searchPlaceholder}
                onChange={(event) => onSearchChange(event.target.value)}
                aria-label={searchPlaceholder}
              />
            </div>
          </FilterField>
        ) : null}
        {children}
      </div>
    </section>
  );
}

export default FilterBar;
