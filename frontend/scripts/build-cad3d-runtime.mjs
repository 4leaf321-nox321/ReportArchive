// cad_3d 오프라인 뷰어 런타임을 단일 IIFE 로 사전 번들한다.
//
// three.js + 로더들(GLTFLoader 가 상대 import 를 함)을 런타임에 엮을 수 없으므로
// (data:URL importmap 으로는 GLTFLoader 의 ../utils/* 가 안 풀린다) esbuild 로
// 모든 의존을 한 파일에 정적 번들한다. 결과물(viewerRuntime.bundle.js)은 export
// 코드가 ?raw 로 읽어 저장 HTML 에 <script> 로 인라인한다.
//
// 실행: npm run build:cad3d   (three 버전 변경 시 재생성 필요)

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const entry = resolve(here, '../src/modules/reports/cad3d/viewerRuntime.entry.js')
const outfile = resolve(
  here,
  '../src/modules/reports/cad3d/viewerRuntime.bundle.js',
)

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'iife',
  minify: true,
  target: ['es2020'],
  legalComments: 'none',
  banner: {
    js: '/* 생성 파일 — 직접 수정 금지. `npm run build:cad3d` 로 재생성. (three + loaders + viewer) */',
  },
})

console.log('[build:cad3d] wrote', outfile)
