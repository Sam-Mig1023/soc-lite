import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * SOC-Lite · Configuración de Vite.
 * El proxy `/api` → `http://localhost:8000` permite consumir el backend sin CORS
 * cuando `VITE_API_URL` se deja vacío (fallback relativo `/api/v1`).
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  preview: {
    port: 4173,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            if (id.includes('recharts') || id.includes('d3-') || id.includes('victory')) return 'charts';
            if (id.includes('@tanstack')) return 'query';
            if (id.includes('react-router') || id.includes('react-dom') || id.includes('/react/')) return 'vendor';
            if (id.includes('lucide-react')) return 'icons';
            return 'vendor';
          }
          return undefined;
        },
      },
    },
  },
});
