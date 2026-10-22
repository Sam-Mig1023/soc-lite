/**
 * SOC-Lite · Modal accesible (role=dialog, cierre con Escape, focus trap básico)
 * y ConfirmDialog construido sobre él.
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, ShieldQuestion, X } from 'lucide-react';
import { cx } from '@/utils/format';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: ModalSize;
  /** Impide cerrar con clic en el fondo o con Escape (acciones críticas). */
  preventClose?: boolean;
  className?: string;
}

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
  full: 'max-w-[95vw]',
};

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Diálogo modal con portal, bloqueo de scroll y gestión de foco. */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  preventClose = false,
  className,
}: ModalProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    if (!preventClose) onClose();
  }, [onClose, preventClose]);

  // Escape + focus trap
  useEffect(() => {
    if (!open) return undefined;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const nodes = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.offsetParent !== null,
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open, close]);

  // Foco inicial en el primer elemento interactivo
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      const node = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      node?.focus();
    }, 30);
    return () => clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div
        className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm"
        onClick={close}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cx(
          'relative z-10 my-4 w-full animate-fade-in rounded-xl border border-slate-800 bg-slate-900 shadow-panel',
          SIZE_CLASSES[size],
          className,
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-800 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">{title}</h2>
            {description ? <p className="mt-1 text-sm text-slate-400">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={close}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 disabled:opacity-40"
            aria-label="Cerrar diálogo"
            disabled={preventClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>

        {footer ? (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-800 px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* ConfirmDialog                                                       */
/* ------------------------------------------------------------------ */

export type ConfirmTone = 'danger' | 'warning' | 'info' | 'success';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Detalle adicional (p. ej. advertencia legal o lista de elementos afectados). */
  details?: ReactNode;
}

const TONE_ICON: Record<ConfirmTone, ReactNode> = {
  danger: <AlertTriangle size={20} className="text-red-400" aria-hidden="true" />,
  warning: <AlertTriangle size={20} className="text-amber-400" aria-hidden="true" />,
  info: <Info size={20} className="text-cyan-400" aria-hidden="true" />,
  success: <CheckCircle2 size={20} className="text-emerald-400" aria-hidden="true" />,
};

const TONE_BUTTON: Record<ConfirmTone, string> = {
  danger: 'soc-btn-danger',
  warning: 'soc-btn bg-amber-500 text-slate-950 hover:bg-amber-400',
  info: 'soc-btn-primary',
  success: 'soc-btn bg-emerald-500 text-slate-950 hover:bg-emerald-400',
};

/** Confirmación modal para acciones destructivas o irreversibles. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  tone = 'warning',
  loading = false,
  onConfirm,
  onCancel,
  details,
}: ConfirmDialogProps): JSX.Element {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      size="sm"
      preventClose={loading}
      title={
        <span className="flex items-center gap-2">
          {TONE_ICON[tone]}
          {title}
        </span>
      }
      footer={
        <>
          <button type="button" className="soc-btn-secondary" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </button>
          <button type="button" className={TONE_BUTTON[tone]} onClick={onConfirm} disabled={loading}>
            {loading ? 'Procesando…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-300">
        <div>{message}</div>
        {details ? <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs">{details}</div> : null}
      </div>
    </Modal>
  );
}

/** Diálogo de decisión de tres vías (p. ej. triaje: TP / FP / cancelar). */
export interface DecisionDialogProps extends Omit<ConfirmDialogProps, 'tone'> {
  secondaryLabel?: string;
  secondaryTone?: ConfirmTone;
  onSecondary?: () => void;
  icon?: ReactNode;
}

export function DecisionDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancelar',
  secondaryLabel,
  secondaryTone = 'success',
  onConfirm,
  onSecondary,
  onCancel,
  loading = false,
  details,
  icon,
}: DecisionDialogProps): JSX.Element {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      size="sm"
      preventClose={loading}
      title={
        <span className="flex items-center gap-2">
          {icon ?? <ShieldQuestion size={20} className="text-cyan-400" aria-hidden="true" />}
          {title}
        </span>
      }
      footer={
        <>
          <button type="button" className="soc-btn-secondary" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </button>
          {secondaryLabel && onSecondary ? (
            <button type="button" className={TONE_BUTTON[secondaryTone]} onClick={onSecondary} disabled={loading}>
              {secondaryLabel}
            </button>
          ) : null}
          <button type="button" className="soc-btn-primary" onClick={onConfirm} disabled={loading}>
            {loading ? 'Procesando…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-300">
        <div>{message}</div>
        {details ? <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs">{details}</div> : null}
      </div>
    </Modal>
  );
}

export default Modal;
