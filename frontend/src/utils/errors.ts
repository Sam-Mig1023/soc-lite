/**
 * SOC-Lite · Normalización de errores de la API.
 * Traduce fallos de Axios/red a mensajes en español listos para toast.
 */
import axios from 'axios';
import type { ApiError } from '@/types/common';

const STATUS_MESSAGES: Record<number, string> = {
  400: 'Solicitud incorrecta. Revisa los datos enviados.',
  401: 'Sesión no válida o expirada. Vuelve a iniciar sesión.',
  403: 'No tienes permisos suficientes para esta acción.',
  404: 'El recurso solicitado no existe.',
  405: 'Método no permitido por el servidor.',
  409: 'Conflicto: el recurso ya existe o fue modificado por otro usuario.',
  413: 'El contenido enviado es demasiado grande.',
  415: 'Formato de contenido no soportado.',
  422: 'Datos inválidos. Verifica los campos del formulario.',
  429: 'Demasiadas solicitudes. Espera unos segundos e inténtalo de nuevo.',
  500: 'Error interno del servidor. El equipo fue notificado.',
  502: 'El servicio no está disponible (bad gateway).',
  503: 'Servicio temporalmente no disponible. Inténtalo más tarde.',
  504: 'El servidor no respondió a tiempo.',
};

/** Extrae un `detail` legible de un payload heterogéneo de FastAPI. */
function extractDetail(payload: unknown): string | undefined {
  if (payload === null || payload === undefined) return undefined;
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object') return undefined;
  const body = payload as Record<string, unknown>;
  if (typeof body.detail === 'string') return body.detail;
  if (Array.isArray(body.detail)) {
    const msgs = body.detail
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const e = item as Record<string, unknown>;
          const loc = Array.isArray(e.loc) ? e.loc.filter((l) => l !== 'body').join('.') : '';
          const msg = typeof e.msg === 'string' ? e.msg : '';
          return loc ? `${loc}: ${msg}` : msg;
        }
        return '';
      })
      .filter(Boolean);
    if (msgs.length > 0) return msgs.join(' · ');
  }
  if (typeof body.message === 'string') return body.message;
  if (typeof body.error === 'string') return body.error;
  return undefined;
}

/** Convierte cualquier error en un `ApiError` estable para la UI. */
export function normalizeError(error: unknown): ApiError {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const payload = error.response?.data as Record<string, unknown> | undefined;
    const detail = extractDetail(payload) ?? STATUS_MESSAGES[status ?? 0] ?? error.message;
    return {
      detail: detail || 'Error inesperado al comunicarse con el servidor.',
      code: typeof payload?.code === 'string' ? payload.code : undefined,
      trace_id: typeof payload?.trace_id === 'string' ? payload.trace_id : undefined,
      status,
    };
  }

  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return { detail: 'La solicitud fue cancelada.' };
    }
    if (error.name === 'TimeoutError' || /timeout/i.test(error.message)) {
      return { detail: 'El servidor tardó demasiado en responder. Inténtalo de nuevo.' };
    }
    return { detail: error.message };
  }

  return { detail: 'Error desconocido. Revisa la consola del navegador.' };
}

/** Mensaje listo para mostrar en un toast o estado de error. */
export function getErrorMessage(error: unknown): string {
  const { detail } = normalizeError(error);
  return detail;
}

/** Código de negocio devuelto por el backend (p. ej. `ALERT_NOT_FOUND`). */
export function getErrorCode(error: unknown): string | undefined {
  return normalizeError(error).code;
}

/** `trace_id` para correlacionar con la bitácora. */
export function getErrorTraceId(error: unknown): string | undefined {
  return normalizeError(error).trace_id;
}

export function isAxiosStatus(error: unknown, status: number): boolean {
  return axios.isAxiosError(error) && error.response?.status === status;
}

export function isUnauthorized(error: unknown): boolean {
  return isAxiosStatus(error, 401);
}

export function isForbidden(error: unknown): boolean {
  return isAxiosStatus(error, 403);
}

export function isNetworkError(error: unknown): boolean {
  return axios.isAxiosError(error) && !error.response;
}

export function isValidationError(error: unknown): boolean {
  return isAxiosStatus(error, 422);
}

/** True si el error representa una cancelación de petición (no debe mostrarse). */
export function isCanceled(error: unknown): boolean {
  return axios.isCancel(error) || (error instanceof Error && error.name === 'AbortError');
}
