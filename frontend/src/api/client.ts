/**
 * SOC-Lite · Cliente HTTP Axios.
 * - Adjunta el Bearer token en cada petición.
 * - Refresco automático en 401 con cola de reintentos y una única llamada de refresh.
 * - Cierre de sesión cuando el refresh falla (evento desacoplado que escucha AuthContext).
 * - Notificaciones de error por toast mediante eventos de ventana (sin acoplar React).
 */
import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import type { ApiError, Paginated } from '@/types/common';
import type { RefreshResponse, TokenResponse, User } from '@/types/auth';
import { getErrorMessage, normalizeError } from '@/utils/errors';

/* ------------------------------------------------------------------ */
/* Configuración del cliente                                          */
/* ------------------------------------------------------------------ */

export const AUTH_STORAGE_KEY = 'soclite.auth';
export const SESSION_EXPIRED_EVENT = 'soclite:session-expired';
export const TOAST_EVENT = 'soclite:toast';

/** Flag propio para no reintentar dos veces la misma petición. */
declare module 'axios' {
  export interface AxiosRequestConfig {
    /** Evita el toast automático de error (lo gestiona la pantalla). */
    skipErrorToast?: boolean;
    /** Marca interna de reintento tras refrescar el token. */
    _retried?: boolean;
    /** Permite peticiones sin cabecera Authorization. */
    skipAuth?: boolean;
  }
}

const RAW_BASE_URL = import.meta.env.VITE_API_URL as string | undefined;
export const API_BASE_URL = RAW_BASE_URL && RAW_BASE_URL.length > 0 ? RAW_BASE_URL : '/api/v1';
const API_TIMEOUT_MS = Number(import.meta.env.VITE_API_TIMEOUT_MS ?? 30000);
const REFRESH_SKEW_SECONDS = Number(import.meta.env.VITE_REFRESH_SKEW_SECONDS ?? 60);
const REFRESH_PATH = '/auth/refresh';

/** Cliente principal (con interceptores). */
export const apiClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: Number.isFinite(API_TIMEOUT_MS) ? API_TIMEOUT_MS : 30000,
  headers: { 'Content-Type': 'application/json' },
});

/** Cliente "desnudo" para login/refresh: evita recursión de interceptores. */
const bareClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: Number.isFinite(API_TIMEOUT_MS) ? API_TIMEOUT_MS : 30000,
  headers: { 'Content-Type': 'application/json' },
});

/* ------------------------------------------------------------------ */
/* Persistencia de sesión                                             */
/* ------------------------------------------------------------------ */

export interface StoredAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: User;
}

const isBrowser = (): boolean => typeof window !== 'undefined' && typeof localStorage !== 'undefined';

/**
 * Lee la sesión persistida.
 * En la STORAGE KEY solo se guardan tokens y perfil: nunca datos sensibles de negocio.
 */
export function readStoredAuth(): StoredAuth | null {
  if (!isBrowser()) return null;
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAuth>;
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0,
      user: parsed.user as User,
    };
  } catch {
    return null;
  }
}

export function writeStoredAuth(value: StoredAuth): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* almacenamiento no disponible (modo privado): la sesión queda solo en memoria */
  }
}

export function clearStoredAuth(): void {
  if (!isBrowser()) return;
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    /* noop */
  }
}

/** Memoria: permite operar aunque localStorage esté bloqueado. */
let memoryAuth: StoredAuth | null = null;

export function getAuth(): StoredAuth | null {
  if (memoryAuth) return memoryAuth;
  memoryAuth = readStoredAuth();
  return memoryAuth;
}

export function setTokens(tokens: {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
}): void {
  const current = getAuth();
  const expiresAt =
    tokens.expiresAt ??
    Date.now() + Math.max(0, (tokens.accessToken ? 1800 : 0)) * 1000;
  const next: StoredAuth = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || current?.refreshToken || '',
    expiresAt,
    user: current?.user ?? ({} as User),
  };
  memoryAuth = next;
  writeStoredAuth(next);
}

export function setSession(auth: StoredAuth): void {
  memoryAuth = auth;
  writeStoredAuth(auth);
}

export function clearTokens(): void {
  memoryAuth = null;
  clearStoredAuth();
}

export function getAccessToken(): string | null {
  return getAuth()?.accessToken ?? null;
}

export function getRefreshToken(): string | null {
  return getAuth()?.refreshToken ?? null;
}

export function getStoredUser(): User | null {
  return getAuth()?.user ?? null;
}

export function setStoredUser(user: User): void {
  const current = getAuth();
  if (!current) return;
  setSession({ ...current, user });
}

/* ------------------------------------------------------------------ */
/* Toasts desacoplados (CustomEvent escuchado por <ToastProvider>)    */
/* ------------------------------------------------------------------ */

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface ToastPayload {
  type: ToastKind;
  message: string;
  description?: string;
}

export function toast(type: ToastKind, message: string, description?: string): void {
  if (!isBrowser()) return;
  window.dispatchEvent(new CustomEvent<ToastPayload>(TOAST_EVENT, { detail: { type, message, description } }));
}

/* ------------------------------------------------------------------ */
/* Sesión expirada (CustomEvent escuchado por AuthContext)            */
/* ------------------------------------------------------------------ */

export function onSessionExpired(handler: () => void): () => void {
  if (!isBrowser()) return () => undefined;
  const listener = (): void => handler();
  window.addEventListener(SESSION_EXPIRED_EVENT, listener);
  return () => window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
}

export function emitSessionExpired(): void {
  if (!isBrowser()) return;
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

/* ------------------------------------------------------------------ */
/* Parámetros de query                                                */
/* ------------------------------------------------------------------ */

/** Valores admitidos en un querystring (los `undefined`/`null` se descartan). */
export type ParamValue = string | number | boolean | Date | null | undefined | Array<string | number>;

/** Elimina `undefined`, `null` y cadenas vacías; serializa fechas y arrays. */
export function buildParams(params?: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!params) return out;
  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined || raw === null || raw === '') continue;
    if (raw instanceof Date) {
      out[key] = raw.toISOString();
      continue;
    }
    if (Array.isArray(raw)) {
      if (raw.length === 0) continue;
      out[key] = raw.join(',');
      continue;
    }
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = raw;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Refresco con cola de reintentos                                    */
/* ------------------------------------------------------------------ */

interface QueueItem {
  resolve: (token: string) => void;
  reject: (error: unknown) => void;
}

let isRefreshing = false;
let failedQueue: QueueItem[] = [];

function flushQueue(error: unknown, token: string | null): void {
  for (const item of failedQueue) {
    if (error || !token) item.reject(error);
    else item.resolve(token);
  }
  failedQueue = [];
}

/** ¿La sesión sigue vigente con margen de seguridad? */
function needsProactiveRefresh(expiresAt: number): boolean {
  if (!expiresAt) return false;
  return Date.now() + REFRESH_SKEW_SECONDS * 1000 >= expiresAt;
}

/**
 * Ejecuta POST /auth/refresh una única vez y comparte el resultado con todos los
 * llamantes en espera (cola). Devuelve el nuevo access token.
 */
async function requestRefresh(): Promise<string> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) throw new Error('No hay refresh token disponible');

  const response = await bareClient.post<RefreshResponse>(REFRESH_PATH, { refresh_token: refreshToken });
  const data = response.data;
  if (!data?.access_token) throw new Error('Respuesta de refresh sin access_token');

  const expiresAt = Date.now() + (data.expires_in ?? 1800) * 1000;
  setTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt,
  });
  return data.access_token;
}

async function enqueueRefresh(): Promise<string> {
  if (isRefreshing) {
    return new Promise<string>((resolve, reject) => {
      failedQueue.push({ resolve, reject });
    });
  }
  isRefreshing = true;
  try {
    const token = await requestRefresh();
    flushQueue(null, token);
    return token;
  } catch (error) {
    flushQueue(error, null);
    throw error;
  } finally {
    isRefreshing = false;
  }
}

/** Cierra la sesión local y avisa a la aplicación para redirigir a /login. */
function forceLogout(): void {
  clearTokens();
  emitSessionExpired();
}

/* ------------------------------------------------------------------ */
/* Interceptores                                                      */
/* ------------------------------------------------------------------ */

const AUTH_FREE_PATHS = ['/auth/login', '/auth/refresh', '/auth/logout'];

function isAuthFreePath(url?: string): boolean {
  if (!url) return false;
  return AUTH_FREE_PATHS.some((path) => url.includes(path));
}

apiClient.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  const headers = config.headers;
  if (!headers['X-Request-Id']) {
    const requestId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    headers['X-Request-Id'] = requestId;
  }

  if (!config.skipAuth) {
    let token = getAccessToken();
    const auth = getAuth();
    // Refresco proactivo: evita el 401 cuando el token está por expirar.
    if (token && auth && auth.refreshToken && needsProactiveRefresh(auth.expiresAt) && !isAuthFreePath(config.url)) {
      try {
        token = await enqueueRefresh();
      } catch {
        /* el 401 del reintento gestionará el cierre de sesión */
      }
    }
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

apiClient.interceptors.response.use(
  (response: AxiosResponse) => response,
  async (error: AxiosError) => {
    const config = error.config as InternalAxiosRequestConfig | undefined;
    const status = error.response?.status;

    // Blobs: se propaga el error para que la pantalla muestre su propio mensaje.
    if (config?.responseType === 'blob') return Promise.reject(error);

    if (status === 401 && config && !config._retried && !isAuthFreePath(config.url)) {
      config._retried = true;
      try {
        const token = await enqueueRefresh();
        config.headers = config.headers ?? {};
        config.headers.Authorization = `Bearer ${token}`;
        return await apiClient.request(config);
      } catch (refreshError) {
        forceLogout();
        const payload: ApiError = {
          detail: 'Tu sesión expiró. Inicia sesión nuevamente.',
          code: 'SESSION_EXPIRED',
        };
        if (!config.skipErrorToast) toast('error', payload.detail);
        return Promise.reject(refreshError instanceof Error ? refreshError : error);
      }
    }

    if (status === 401 && config && !isAuthFreePath(config.url)) {
      // Reintento ya consumido y sigue sin autorización: sesión inválida.
      forceLogout();
    }

    if (config && !config.skipErrorToast) {
      toast('error', getErrorMessage(error));
    }

    // Se adjunta el error normalizado para consumidores que lo prefieran.
    (error as AxiosError & { normalized?: ApiError }).normalized = normalizeError(error);
    return Promise.reject(error);
  },
);

/* ------------------------------------------------------------------ */
/* Helpers tipados                                                    */
/* ------------------------------------------------------------------ */

export const http = {
  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const { data } = await apiClient.get<T>(url, config);
    return data;
  },
  async post<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const { data } = await apiClient.post<T>(url, body, config);
    return data;
  },
  async put<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const { data } = await apiClient.put<T>(url, body, config);
    return data;
  },
  async patch<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const { data } = await apiClient.patch<T>(url, body, config);
    return data;
  },
  async del<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const { data } = await apiClient.delete<T>(url, config);
    return data;
  },
  async getPage<T>(url: string, config?: AxiosRequestConfig): Promise<Paginated<T>> {
    const { data } = await apiClient.get<Paginated<T>>(url, config);
    return data;
  },
};

/** Extrae el nombre de fichero de `content-disposition` (incluye `filename*`). */
export function parseFilename(disposition?: string | null, fallback = 'descarga'): string {
  if (!disposition) return fallback;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].replace(/"/g, ''));
    } catch {
      return utf8[1];
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  if (plain?.[1]) return plain[1].trim();
  return fallback;
}

export interface DownloadedFile {
  blob: Blob;
  filename: string;
}

/** Descarga binaria (PDF/DOCX/XLSX/CSV) preservando el nombre sugerido por el backend. */
export async function downloadBlob(
  url: string,
  params?: Record<string, unknown>,
  fallbackFilename = 'soc-lite-reporte',
): Promise<DownloadedFile> {
  const response = await apiClient.get<Blob>(url, {
    params: buildParams(params),
    responseType: 'blob',
    skipErrorToast: true,
  });
  const disposition = response.headers['content-disposition'] as string | undefined;
  return {
    blob: response.data,
    filename: parseFilename(disposition, fallbackFilename),
  };
}

/** POST que devuelve un fichero binario (por si el backend lo expone así). */
export async function downloadBlobPost(
  url: string,
  body?: unknown,
  fallbackFilename = 'soc-lite-reporte',
): Promise<DownloadedFile> {
  const response = await apiClient.post<Blob>(url, body, {
    responseType: 'blob',
    skipErrorToast: true,
  });
  const disposition = response.headers['content-disposition'] as string | undefined;
  return {
    blob: response.data,
    filename: parseFilename(disposition, fallbackFilename),
  };
}

/** Login sin interceptores (evita bucles de refresh en un 401 de credenciales). */
export async function rawLogin(form: URLSearchParams): Promise<TokenResponse> {
  const { data } = await bareClient.post<TokenResponse>('/auth/login', form, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return data;
}

/** Refresh sin interceptores, usado por el bootstrap de la sesión. */
export async function rawRefresh(refreshToken: string): Promise<RefreshResponse> {
  const { data } = await bareClient.post<RefreshResponse>(REFRESH_PATH, { refresh_token: refreshToken });
  return data;
}

export default apiClient;
