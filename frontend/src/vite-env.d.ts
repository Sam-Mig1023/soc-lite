/// <reference types="vite/client" />

/**
 * SOC-Lite · Tipado de las variables de entorno de Vite.
 * Solo las variables con prefijo `VITE_` llegan al cliente.
 */
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_API_TIMEOUT_MS?: string;
  readonly VITE_ENABLE_DEVTOOLS?: string;
  readonly VITE_APP_NAME?: string;
  readonly VITE_REFRESH_SKEW_SECONDS?: string;
  readonly MODE: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
