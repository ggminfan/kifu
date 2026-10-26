import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API port follows KIFU_PORT so a second instance can run side by side (KIFU_PORT=7790 pnpm dev).
const apiPort = process.env.KIFU_PORT ?? '7788';

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
