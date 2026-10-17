/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000';

// The dev server proxies the API so the SPA, OAuth callbacks and session cookies are all
// same-origin (http://localhost:5173). In production put both behind one reverse proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false, xfwd: true },
      '/admin': { target: API_TARGET, changeOrigin: false, xfwd: true },
    },
  },
  build: { sourcemap: true },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
