/**
 * SOC-Lite · Menú de exportación por blob (PDF/Word/Excel/CSV).
 * Encapsula el estado `descargando`, el manejo de errores con toast y el guardado local
 * del archivo devuelto por `downloadBlob`.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Download, FileSpreadsheet, FileText, FileType, Loader2 } from 'lucide-react';
import { useToast } from './Toast';
import { getErrorMessage } from '@/utils/errors';
import { cx, saveBlob } from '@/utils/format';
import type { ReportFormat } from '@/types/enums';
import { REPORT_FORMAT_LABELS } from '@/types/enums';
import type { DownloadedFile } from '@/api/client';

export interface ExportOption {
  /** Identificador del formato exportado. */
  format: ReportFormat;
  label?: string;
  description?: string;
  /** Devuelve el archivo a descargar. Puede lanzar para mostrar el error por toast. */
  onExport: () => Promise<DownloadedFile>;
}

export interface ExportMenuProps {
  options: ExportOption[];
  label?: string;
  /** Nombre remoto (contexto de la exportación, mostrado en el encabezado del menú). */
  contextLabel?: string;
  disabled?: boolean;
  /** Motivo mostrado cuando el menú está deshabilitado por falta de permisos. */
  disabledReason?: string;
  className?: string;
  align?: 'left' | 'right';
  trigger?: ReactNode;
}

const FORMAT_ICONS: Record<ReportFormat, ReactNode> = {
  pdf: <FileText size={15} className="text-red-400" aria-hidden="true" />,
  docx: <FileType size={15} className="text-sky-400" aria-hidden="true" />,
  xlsx: <FileSpreadsheet size={15} className="text-emerald-400" aria-hidden="true" />,
  csv: <FileSpreadsheet size={15} className="text-amber-400" aria-hidden="true" />,
};

/** Botón desplegable de exportación. Cierra al hacer clic fuera o con Escape. */
export function ExportMenu({
  options,
  label = 'Exportar',
  contextLabel,
  disabled = false,
  disabledReason,
  className,
  align = 'right',
  trigger,
}: ExportMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ReportFormat | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (!open) return undefined;
    const onClickOutside = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleExport = async (option: ExportOption): Promise<void> => {
    setBusy(option.format);
    try {
      const { blob, filename } = await option.onExport();
      saveBlob(blob, option.label ? `${option.label}.${option.format}` : filename);
      toast.success(`Exportación ${REPORT_FORMAT_LABELS[option.format]} generada`, filename);
      setOpen(false);
    } catch (error) {
      toast.error('No se pudo generar la exportación', getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={containerRef} className={cx('relative', className)}>
      <button
        type="button"
        className="soc-btn-secondary"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={disabled ? disabledReason : undefined}
      >
        {trigger ?? (
          <>
            <Download size={15} aria-hidden="true" />
            {label}
            <ChevronDown size={14} aria-hidden="true" className={cx('transition-transform', open && 'rotate-180')} />
          </>
        )}
      </button>

      {open ? (
        <div
          role="menu"
          aria-label={contextLabel ?? 'Opciones de exportación'}
          className={cx(
            'absolute z-40 mt-2 w-64 animate-fade-in overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-panel',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {contextLabel ? (
            <p className="border-b border-slate-800 px-3 py-2 text-xs uppercase tracking-wider text-slate-500">
              {contextLabel}
            </p>
          ) : null}
          <ul className="py-1">
            {options.map((option) => (
              <li key={option.format}>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-start gap-2.5 px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800/70 disabled:opacity-50"
                  onClick={() => void handleExport(option)}
                  disabled={busy !== null}
                >
                  <span className="mt-0.5">{FORMAT_ICONS[option.format]}</span>
                  <span className="flex-1">
                    <span className="block font-medium">{option.label ?? REPORT_FORMAT_LABELS[option.format]}</span>
                    {option.description ? (
                      <span className="block text-xs text-slate-500">{option.description}</span>
                    ) : null}
                  </span>
                  {busy === option.format ? (
                    <Loader2 size={14} className="mt-0.5 animate-spin text-cyan-400" aria-hidden="true" />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export default ExportMenu;
