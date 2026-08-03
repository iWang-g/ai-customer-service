import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:8001',
        ws: true,
      },
      '/kb-api': {
        target: 'http://127.0.0.1:8010',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/kb-api/, ''),
      },
    },
  },
});
