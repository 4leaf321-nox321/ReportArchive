import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { readFileSync } from 'node:fs'

// 단일 출처(package.json)에서 앱 버전을 읽어 __APP_VERSION__ 으로 주입.
// Header 의 "Report Archive" 옆 버전 표기에 사용.
const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'),
)

// 위젯 작성 상세 룰(AI 프롬프트용)의 **단일 소스** — 백엔드의 authoring_rules.json.
// 빌드 시 읽어 __WIDGET_AUTHORING_RULES__ 로 주입(프런트는 동기 import, 런타임 fetch X).
// MCP(describe_template/describe_widgets)도 같은 파일을 런타임에 읽으므로 출처가 하나다.
const widgetAuthoringRules = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../backend/app/widgets/authoring_rules.json'),
    'utf-8',
  ),
)

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
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __WIDGET_AUTHORING_RULES__: JSON.stringify(widgetAuthoringRules),
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    server: {
      port: Number(env.VITE_DEV_PORT) || 3001,
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
