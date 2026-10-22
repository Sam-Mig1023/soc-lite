/**
 * SOC-Lite · API de autenticación y sesión (contrato §1).
 *
 * Este módulo NO persiste la sesión: devuelve las respuestas tal cual y es
 * `AuthContext` quien decide qué guardar, para que exista una única fuente de verdad.
 */
import { http, clearTokens, getRefreshToken, type DownloadedFile } from './client';
import type {
  ChangePasswordRequest,
  LoginRequest,
  RefreshResponse,
  TokenResponse,
  User,
  AuthProfile,
} from '@/types/auth';
import { normalizeMe } from '@/types/auth';
import { rawLogin, rawRefresh } from './client';

/** POST /auth/login — form-urlencoded con `username` y `password`. */
export async function login(credentials: LoginRequest): Promise<TokenResponse> {
  const form = new URLSearchParams();
  form.set('username', credentials.username);
  form.set('password', credentials.password);
  return rawLogin(form);
}

/** POST /auth/refresh — rota el refresh token. */
export async function refresh(refreshToken?: string): Promise<RefreshResponse> {
  const token = refreshToken ?? getRefreshToken();
  if (!token) throw new Error('No hay refresh token disponible');
  return rawRefresh(token);
}

/** POST /auth/logout — revoca el refresh token (si el backend lo requiere en el cuerpo). */
export async function logout(): Promise<void> {
  const refreshToken = getRefreshToken();
  try {
    await http.post<void>('/auth/logout', refreshToken ? { refresh_token: refreshToken } : undefined, {
      skipErrorToast: true,
    });
  } finally {
    clearTokens();
  }
}

/** GET /auth/me — perfil, roles y permisos efectivos (acepta envoltorio o perfil plano). */
export async function me(): Promise<AuthProfile> {
  const data = await http.get<unknown>('/auth/me');
  return normalizeMe(data);
}

/** POST /auth/change-password — verificación de la contraseña anterior. */
export async function changePassword(payload: ChangePasswordRequest): Promise<void> {
  await http.post<void>('/auth/change-password', payload, { skipErrorToast: true });
}

/** Export de tipo auxiliar para consumidores que descarguen artefactos de sesión. */
export type { DownloadedFile, User };

export const authApi = { login, refresh, logout, me, changePassword };

export default authApi;
