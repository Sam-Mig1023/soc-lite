/**
 * SOC-Lite · DataTable genérica con ordenamiento, paginación server-side,
 * selección múltiple, estados de carga/vacío y accesibilidad de tabla.
 */
import { useMemo, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Inbox } from 'lucide-react';
import { cx } from '@/utils/format';
import { EmptyState, ErrorState, SkeletonTable } from './States';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Celda personalizada. Si se omite, se usa `getValue` o la propiedad homónima. */
  render?: (row: T, index: number) => ReactNode;
  /** Extrae el valor bruto (usado por `sortValue` y por el render por defecto). */
  getValue?: (row: T) => unknown;
  sortable?: boolean;
  /** Identificador del campo enviado al backend en `sort_by` (por defecto `key`). */
  sortKey?: string;
  align?: 'left' | 'center' | 'right';
  width?: string;
  className?: string;
  headerClassName?: string;
  /** Oculta la columna en pantallas pequeñas. */
  hideOnMobile?: boolean;
}

export interface DataTableProps<T> {
  columns: Array<Column<T>>;
  data: T[];
  /** `row.id` o una función que devuelve una clave estable. */
  rowKey?: keyof T | ((row: T) => string | number);
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;

  /** Habilitar selección múltiple con checkbox. */
  selectable?: boolean;
  selectedKeys?: Array<string | number>;
  onSelectionChange?: (keys: Array<string | number>) => void;

  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;

  /** Ordenamiento controlado (server-side). */
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  onSortChange?: (sortBy: string, sortDir: 'asc' | 'desc') => void;

  /** Paginación controlada (server-side). */
  page?: number;
  pageSize?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];

  className?: string;
  /** Altura máxima del contenedor con scroll interno. */
  maxHeight?: string;
  caption?: string;
}

const ALIGN: Record<NonNullable<Column<unknown>['align']>, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

function defaultKey<T>(row: T, rowKey?: keyof T | ((row: T) => string | number)): string | number {
  if (typeof rowKey === 'function') return rowKey(row);
  if (rowKey) {
    const value = row[rowKey];
    if (typeof value === 'string' || typeof value === 'number') return value;
  }
  const candidate = (row as Record<string, unknown>).id;
  if (typeof candidate === 'string' || typeof candidate === 'number') return candidate;
  return JSON.stringify(row);
}

function cellValue<T>(row: T, column: Column<T>): unknown {
  if (column.getValue) return column.getValue(row);
  return (row as Record<string, unknown>)[column.key];
}

function renderValue(value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="text-slate-500">—</span>;
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (typeof value === 'object') return <span className="font-mono text-xs text-slate-400">{JSON.stringify(value)}</span>;
  return String(value);
}

/**
 * Tabla de datos genérica.
 * El ordenamiento y la paginación son CONTROLADOS: la página envía `sort_by`,
 * `sort_dir`, `page` y `page_size` al backend y refleja el envelope `Paginated<T>`.
 */
export function DataTable<T>({
  columns,
  data,
  rowKey,
  loading = false,
  error = null,
  onRetry,
  emptyTitle = 'Sin resultados',
  emptyDescription = 'No hay registros que coincidan con los filtros aplicados.',
  emptyAction,
  selectable = false,
  selectedKeys = [],
  onSelectionChange,
  onRowClick,
  rowClassName,
  sortBy,
  sortDir,
  onSortChange,
  page = 1,
  pageSize = 25,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50, 100],
  className,
  maxHeight,
  caption,
}: DataTableProps<T>): JSX.Element {
  const keys = useMemo(() => data.map((row) => defaultKey(row, rowKey)), [data, rowKey]);

  const allSelected = selectable && keys.length > 0 && keys.every((key) => selectedKeys.includes(key));
  const someSelected = selectable && selectedKeys.length > 0 && !allSelected;

  const toggleAll = (): void => {
    if (!onSelectionChange) return;
    onSelectionChange(allSelected ? [] : keys);
  };

  const toggleRow = (key: string | number): void => {
    if (!onSelectionChange) return;
    onSelectionChange(
      selectedKeys.includes(key) ? selectedKeys.filter((k) => k !== key) : [...selectedKeys, key],
    );
  };

  const handleSort = (column: Column<T>): void => {
    if (!column.sortable || !onSortChange) return;
    const field = column.sortKey ?? column.key;
    const nextDir: 'asc' | 'desc' = sortBy === field && sortDir === 'asc' ? 'desc' : 'asc';
    onSortChange(field, nextDir);
  };

  const totalRows = total ?? data.length;
  const pages = totalRows > 0 ? Math.max(1, Math.ceil(totalRows / pageSize)) : 0;
  const from = totalRows === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalRows);

  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (loading && data.length === 0) return <SkeletonTable rows={8} cols={Math.min(columns.length, 6)} />;

  return (
    <div className={cx('flex flex-col', className)}>
      <div className="soc-scroll-x" style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}>
        <table className="soc-table min-w-full">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead className="sticky top-0 z-10">
            <tr>
              {selectable ? (
                <th scope="col" className="soc-th w-10">
                  <input
                    type="checkbox"
                    className="h-4 w-4 cursor-pointer rounded border-slate-600 bg-slate-800 accent-cyan-500"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected;
                    }}
                    onChange={toggleAll}
                    aria-label="Seleccionar todas las filas"
                  />
                </th>
              ) : null}
              {columns.map((column) => {
                const isActive = sortBy === (column.sortKey ?? column.key);
                const SortIcon = !isActive ? ChevronsUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    style={column.width ? { width: column.width } : undefined}
                    className={cx(
                      'soc-th',
                      ALIGN[column.align ?? 'left'],
                      column.hideOnMobile && 'hidden md:table-cell',
                      column.headerClassName,
                    )}
                    aria-sort={isActive ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    {column.sortable && onSortChange ? (
                      <button
                        type="button"
                        onClick={() => handleSort(column)}
                        className="inline-flex items-center gap-1 text-inherit hover:text-cyan-300"
                        aria-label={`Ordenar por ${typeof column.header === 'string' ? column.header : column.key}`}
                      >
                        {column.header}
                        <SortIcon size={13} aria-hidden="true" className={isActive ? 'text-cyan-400' : 'text-slate-600'} />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className={cx(loading && 'opacity-60')}>
            {data.length === 0 ? (
              <tr>
                <td colSpan={columns.length + (selectable ? 1 : 0)} className="p-0">
                  <EmptyState
                    title={emptyTitle}
                    description={emptyDescription}
                    action={emptyAction}
                    icon={<Inbox size={22} />}
                  />
                </td>
              </tr>
            ) : (
              data.map((row, index) => {
                const key = keys[index];
                const selected = selectedKeys.includes(key);
                return (
                  <tr
                    key={String(key)}
                    className={cx(
                      'transition-colors',
                      selected ? 'bg-cyan-950/30' : 'hover:bg-slate-800/40',
                      onRowClick && 'cursor-pointer',
                      rowClassName?.(row),
                    )}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                  >
                    {selectable ? (
                      <td className="soc-td w-10" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer rounded border-slate-600 bg-slate-800 accent-cyan-500"
                          checked={selected}
                          onChange={() => toggleRow(key)}
                          aria-label={`Seleccionar fila ${String(key)}`}
                        />
                      </td>
                    ) : null}
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={cx('soc-td', ALIGN[column.align ?? 'left'], column.hideOnMobile && 'hidden md:table-cell', column.className)}
                      >
                        {column.render ? column.render(row, index) : renderValue(cellValue(row, column))}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Paginación server-side */}
      {totalRows > 0 && onPageChange ? (
        <nav
          className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 px-3 py-2.5 text-xs text-slate-400"
          aria-label="Paginación de resultados"
        >
          <p>
            Mostrando <span className="font-semibold text-slate-200">{from}</span>–
            <span className="font-semibold text-slate-200">{to}</span> de{' '}
            <span className="font-semibold text-slate-200">{totalRows.toLocaleString('es-CL')}</span> registros
          </p>
          <div className="flex items-center gap-2">
            {onPageSizeChange ? (
              <label className="flex items-center gap-1.5">
                <span className="sr-only sm:not-sr-only">Filas por página</span>
                <select
                  className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
                  value={pageSize}
                  onChange={(event) => onPageSizeChange(Number(event.target.value))}
                  aria-label="Filas por página"
                >
                  {pageSizeOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button
              type="button"
              className="soc-btn-secondary px-2 py-1"
              onClick={() => onPageChange(Math.max(1, page - 1))}
              disabled={page <= 1}
              aria-label="Página anterior"
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
            <span className="font-mono text-slate-300">
              {page} / {pages || 1}
            </span>
            <button
              type="button"
              className="soc-btn-secondary px-2 py-1"
              onClick={() => onPageChange(Math.min(pages || 1, page + 1))}
              disabled={page >= (pages || 1)}
              aria-label="Página siguiente"
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </div>
        </nav>
      ) : null}
    </div>
  );
}

export default DataTable;
