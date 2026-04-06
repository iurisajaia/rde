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
      // Browser uses /rde-ui/api → Express API on port 20000 (strip /rde-ui prefix)
      '/rde-ui/api': {
        target: 'http://127.0.0.1:20000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/rde-ui/, ''),
        ws: true,
      },
    },
  },
});

