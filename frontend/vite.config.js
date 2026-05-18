import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

/**
 * Vite config.
 *
 * - In dev, /api is proxied to the FastAPI backend (default :3000) so the
 *   frontend can call relative URLs like fetch('/api/reports') without CORS.
 * - In prod, the build output goes to dist/. The frontend can either be
 *   hosted as static assets (e.g. behind nginx) or copied to the backend
 *   and served via SERVE_FRONTEND_DIST.
 *
 * Override the proxy target with VITE_API_PROXY_TARGET in .env.development.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:3000'

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    server: {
      port: Number(env.VITE_DEV_PORT) || 5173,
      host: true,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          timeout: 600000,
          proxyTimeout: 600000,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
      // Emit clean asset paths so the build can be served from a subpath
      // when needed (nginx, backend SPA fallback, etc.).
      assetsDir: 'assets',
    },
  }
})
