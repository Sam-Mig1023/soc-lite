/**
 * SOC-Lite · Utilidades de formato (fechas, duraciones, números, porcentajes).
 * Capa pura: sin React, sin acceso a red.
 */

const LOCALE = 'es-CL';

const toDate = (value?: string | number | Date | null): Date | null => {
  if (value === undefined || value === null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** `31-01-2025 14:22:05` */
export function formatDateTime(value?: string | Date | null): string {
  const d = toDate(value);
  if (!d) return '—';
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

/** `31-01-2025` */
export function formatDate(value?: string | Date | null): string {
  const d = toDate(value);
  if (!d) return '—';
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

/** `14:22:05` */
export function formatTime(value?: string | Date | null): string {
  const d = toDate(value);
  if (!d) return '—';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `31 ene 2025` para ejes de gráficos. */
export function formatShortDate(value?: string | Date | null): string {
  const d = toDate(value);
  if (!d) return '—';
  return d.toLocaleDateString(LOCALE, { day: '2-digit', month: 'short', year: 'numeric' });
}

/** `hace 5 min`, `hace 3 h`, `hace 2 días`. */
export function formatRelative(value?: string | Date | null): string {
  const d = toDate(value);
  if (!d) return '—';
  const diffMs = Date.now() - d.getTime();
  const future = diffMs < 0;
  const sec = Math.abs(Math.round(diffMs / 1000));
  const build = (n: number, unit: string): string => {
    const plural = n === 1 ? '' : unit.endsWith('a') ? 's' : 's';
    return `${n} ${unit}${plural}`;
  };
  let text: string;
  if (sec < 45) text = 'menos de un minuto';
  else if (sec < 3600) text = build(Math.round(sec / 60), 'min');
  else if (sec < 86400) text = build(Math.round(sec / 3600), 'h');
  else if (sec < 2592000) text = build(Math.round(sec / 86400), 'día');
  else text = build(Math.round(sec / 2592000), 'mes');
  if (text === 'menos de un minuto') return future ? 'en un momento' : 'hace un momento';
  return future ? `en ${text}` : `hace ${text}`;
}

/** `2 h 13 min`, `47 s`, `640 ms`. */
export function formatDuration(seconds?: number | null): string {
  if (seconds === undefined || seconds === null || Number.isNaN(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return `${h} h ${pad(m)} min`;
  if (m > 0) return rest > 0 && m < 10 ? `${m} min ${rest} s` : `${m} min`;
  return `${s} s`;
}

/** Milisegundos a texto corto (`6,4 s`). */
export function formatMillis(ms?: number | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} s`;
}

/** Número con separador de miles local. */
export function formatNumber(value?: number | null, decimals = 0): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  return value.toLocaleString(LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Acepta un ratio 0–1 (como `false_positive_rate: 0.734`) o un valor ya en escala 0–100.
 * `0.734` → `73,4 %`; `73.4` → `73,4 %`.
 */
export function formatPercent(value?: number | null, decimals = 1): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  const ratio = Math.abs(value) <= 1 ? value * 100 : value;
  return `${ratio.toLocaleString(LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} %`;
}

/** Convierte un ratio 0–1 a número 0–100 para ejes de Recharts. */
export function toPercentNumber(value?: number | null, decimals = 1): number {
  if (value === undefined || value === null || Number.isNaN(value)) return 0;
  const ratio = Math.abs(value) <= 1 ? value * 100 : value;
  const factor = 10 ** decimals;
  return Math.round(ratio * factor) / factor;
}

export function formatBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toLocaleString(LOCALE, { maximumFractionDigits: 1 })} ${units[i]}`;
}

/** `yyyy-MM-dd` en hora local (para inputs date y query params). */
export function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toIsoDate(d);
}

export function startOfDayIso(date: Date = new Date()): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Inicio del día en formato ISO con zona, apto para `from`. */
export function isoFromLocalDate(value?: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Fin del día en formato ISO con zona, apto para `to`. */
export function isoToLocalDate(value?: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(`${value}T23:59:59`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function truncate(text?: string | null, max = 90): string {
  if (!text) return '—';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function titleCase(text?: string | null): string {
  if (!text) return '—';
  return text
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bDe\b/g, 'de');
}

export function shortIp(ip?: string | null): string {
  if (!ip) return '—';
  return ip.replace(/^::ffff:/, '');
}

/** Interpola el primer carácter hexadecimal de un hash para el badge de trazabilidad. */
export function shortTrace(trace?: string | null, len = 8): string {
  if (!trace) return '—';
  return trace.length <= len ? trace : trace.slice(0, len);
}

/** Etiquetas legibles de las acciones normalizadas de la bitácora. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  LOGIN: 'Inicio de sesión',
  LOGOUT: 'Cierre de sesión',
  LOGIN_FAILED: 'Login fallido',
  CREATE: 'Creación',
  READ: 'Consulta',
  UPDATE: 'Actualización',
  DELETE: 'Eliminación',
  EXPORT: 'Exportación',
  TRIAGE_RUN: 'Triaje ejecutado',
  TRIAGE_FEEDBACK: 'Retroalimentación de triaje',
  ROLE_ASSIGN: 'Asignación de rol',
  CONFIG_CHANGE: 'Cambio de configuración',
};

export function humanizeAction(action?: string | null): string {
  if (!action) return '—';
  return AUDIT_ACTION_LABELS[action] ?? titleCase(action);
}

/** Copia texto al portapapeles con degradación silenciosa. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Descarga un Blob en el navegador respetando el nombre sugerido por el backend. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Debounce sencillo para inputs de búsqueda. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  wait = 350,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** Construye la clase de un badge con clsx-friendly concatenación (sin dependencia de cn). */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
