import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: '/rde-ui/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/rde-api': {
        target: 'http://127.0.0.1:20000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/rde-api/, '/api'),
        ws: true,
      },
      // Legacy path (still proxied by server.js for old nginx)
      '/rde-ui/api': {
        target: 'http://127.0.0.1:20000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/rde-ui/, ''),
        ws: true,
      },
    },
  },
});

