import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.API_URL ?? 'http://127.0.0.1:3001';

/**
 * The dashboard proxies `/api` to the control plane so the session cookie is
 * first-party in development, exactly as it is in production.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.DASHBOARD_PORT ?? 3000),
    strictPort: true,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: false,
        ws: false,
      },
    },
  },
  preview: {
    port: Number(process.env.DASHBOARD_PORT ?? 3000),
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
