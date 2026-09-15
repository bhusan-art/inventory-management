import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(process.cwd(), 'src') },
  },
  server: {
    port: 5173,
    // Dev requests go through the same /api prefix as production, so no code
    // anywhere needs to know which environment it is running in.
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY ?? 'http://backend:5000',
        changeOrigin: true,
      },
    },
  },
});
