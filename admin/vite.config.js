import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Local dev: /api is proxied to the Express API so the browser sees one origin (same as the Vercel /api rewrite in production).
// DEV_API_PROXY_TARGET is read here only; it is not exposed to browser code (only VITE_* variables are).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: { port: 5174, strictPort: true, proxy: { '/api': { target: env.DEV_API_PROXY_TARGET || 'http://localhost:5000', changeOrigin: false, xfwd: true } } },
    preview: { port: 4174, proxy: { '/api': { target: env.DEV_API_PROXY_TARGET || 'http://localhost:5000', changeOrigin: false, xfwd: true } } },
    build: { outDir: 'dist', sourcemap: false, target: 'es2020' },
  };
});
