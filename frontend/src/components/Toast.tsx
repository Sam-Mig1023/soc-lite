/**
 * SOC-Lite · Sistema de notificaciones (toasts).
 * `<ToastProvider>` escucha el evento de ventana `soclite:toast` que emite la capa
 * Axios (`api/client.ts`), por lo que no existe acoplamiento entre la capa de red y React.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { TOAST_EVENT, type ToastKind, type ToastPayload } from '@/api/client';
import { cx } from '@/utils/format';

export interface ToastItem extends ToastPayload {
  id: string;
  createdAt: number;
}

export interface ToastContextValue {
  toasts: ToastItem[];
  notify: (type: ToastKind, message: string, description?: string) => void;
  success: (message: string, description?: string) => void;
  error: (message: string, description?: string) => void;
  info: (message: string, description?: string) => void;
  warning: (message: string, description?: string) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION_MS = 6000;

const VARIANT_STYLES: Record<ToastKind, { container: string; icon: ReactNode }> = {
  success: {
    container: 'border-emerald-800 bg-emerald-950/80 text-emerald-100',
    icon: <CheckCircle2 size={18} className="text-emerald-400" aria-hidden="true" />,
  },
  error: {
    container: 'border-red-800 bg-red-950/80 text-red-100',
    icon: <XCircle size={18} className="text-red-400" aria-hidden="true" />,
  },
  warning: {
    container: 'border-amber-800 bg-amber-950/80 text-amber-100',
    icon: <AlertTriangle size={18} className="text-amber-400" aria-hidden="true" />,
  },
  info: {
    container: 'border-cyan-800 bg-cyan-950/80 text-cyan-100',
    icon: <Info size={18} className="text-cyan-400" aria-hidden="true" />,
  },
};

let toastSequence = 0;

/** Proveedor de toasts: debe envolver la aplicación (una sola instancia). */
export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback(
    (type: ToastKind, message: string, description?: string) => {
      toastSequence += 1;
      const id = `toast-${toastSequence}`;
      setToasts((current) => [...current.slice(-4), { id, type, message, description, createdAt: Date.now() }]);
      window.setTimeout(() => dismiss(id), DEFAULT_DURATION_MS);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toasts,
      notify,
      dismiss,
      clear: () => setToasts([]),
      success: (message, description) => notify('success', message, description),
      error: (message, description) => notify('error', message, description),
      info: (message, description) => notify('info', message, description),
      warning: (message, description) => notify('warning', message, description),
    }),
    [toasts, notify, dismiss],
  );

  // Puente con la capa HTTP: escucha los eventos emitidos por el interceptor de Axios.
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<ToastPayload>).detail;
      if (!detail?.message) return;
      notify(detail.type ?? 'info', detail.message, detail.description);
    };
    window.addEventListener(TOAST_EVENT, handler);
    return () => window.removeEventListener(TOAST_EVENT, handler);
  }, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/** Contenedor accesible de toasts (aria-live). */
export function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}): JSX.Element {
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2"
      role="region"
      aria-label="Notificaciones"
    >
      <div aria-live="polite" aria-atomic="false" className="flex flex-col gap-2">
        {toasts.map((toastItem) => {
          const variant = VARIANT_STYLES[toastItem.type] ?? VARIANT_STYLES.info;
          return (
            <div
              key={toastItem.id}
              role={toastItem.type === 'error' ? 'alert' : 'status'}
              className={cx(
                'pointer-events-auto flex animate-fade-in items-start gap-3 rounded-xl border px-4 py-3 shadow-panel backdrop-blur',
                variant.container,
              )}
            >
              <span className="mt-0.5 shrink-0">{variant.icon}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{toastItem.message}</p>
                {toastItem.description ? (
                  <p className="mt-0.5 break-words text-xs opacity-80">{toastItem.description}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => onDismiss(toastItem.id)}
                className="shrink-0 rounded p-1 text-current/70 transition-colors hover:bg-black/20 hover:text-current"
                aria-label="Cerrar notificación"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Hook de acceso al sistema de notificaciones. */
export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast debe usarse dentro de <ToastProvider>');
  }
  return context;
}

export default ToastProvider;
