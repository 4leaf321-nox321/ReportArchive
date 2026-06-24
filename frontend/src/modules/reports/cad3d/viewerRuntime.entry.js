// 오프라인 인터랙티브 3D 뷰어 런타임 — 저장된 HTML 안에서 cad_3d 모델을 다시
// 회전/확대 가능하게 살리는 self-contained 번들의 **소스**.
//
// 왜 별도 번들인가:
//   Plotly 는 단일 UMD 파일(plotly.min.js)이라 ?raw 로 그대로 인라인하면 끝이지만,
//   three.js 는 ESM 모듈 그래프(GLTFLoader 가 ../utils/BufferGeometryUtils.js 등
//   상대 import 를 함)라 data:URL importmap 으로는 못 엮는다. 그래서 esbuild 로
//   three + 로더 + OrbitControls + 모델코어 + 아래 init 을 **하나의 IIFE** 로 미리
//   번들해(viewerRuntime.bundle.js) export 시 <script> 로 통째로 인라인한다.
//
// 빌드: `npm run build:cad3d` (scripts/build-cad3d-runtime.mjs → esbuild).
// three 버전을 올리면 이 번들을 다시 생성해야 한다.
//
// 노출: window.__RA_CAD3D__.initAll(specsById)
//   spec = { dataB64, ext, viewState, hiddenParts, wireframeParts, background }
//   - dataB64        : 모델 파일 바이트의 base64 (GLB/GLTF/STL/OBJ)
//   - ext            : '.glb' | '.gltf' | '.stl' | '.obj'
//   - viewState      : { position:[x,y,z], target:[x,y,z], zoom } | null (저장 카메라)
//   - hiddenParts    : 숨긴 파트 id 목록(content.hidden_parts) — 편집모드 상태 반영
//   - wireframeParts : 와이어프레임 파트 id 목록(content.wireframe_parts)
//   - background     : 배경색(숫자) — 선택
//
// 모델 로딩·파트 식별·STL 분할·카메라 피팅은 Cad3d.jsx 와 **동일한** 순수
// 함수(cad3dModelCore.js)를 공유해, hidden/wireframe 파트 id 가 100% 매칭되고
// 저장본이 화면과 같은 룩으로 보이게 한다. 측정·부품트리 UI 는 제외(회전/확대/팬만).

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {
  loadModelFromBlob,
  maybeSplitConnectedComponents,
  findParts,
  applyViewPreset,
} from '../../templates/widgets/cad3dModelCore'

// Cad3d.jsx 의 라이브 로더가 받는 것과 동일한 의존성 묶음.
const STACK = {
  THREE,
  GLTFLoader,
  STLLoader,
  OBJLoader,
  BufferGeometryUtils,
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

function showError(container, msg) {
  const div = document.createElement('div')
  div.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;' +
    'justify-content:center;font-size:12px;color:#b91c1c;' +
    'background:#f3f4f6;text-align:center;padding:8px'
  div.textContent = msg
  container.appendChild(div)
}

// 저장된 파트 상태 적용. hidden 이 wireframe 보다 우선(라이브 뷰의 resolution 과
// 동일). 라이브는 와이어프레임을 별도 LineSegments 로 그리지만, export 뷰어는
// 데코레이션 없이 메시 머티리얼의 wireframe 플래그로 근사한다(회전/확대가 목적).
function applyPartState(obj, hiddenParts, wireframeParts) {
  const hidden = new Set(Array.isArray(hiddenParts) ? hiddenParts : [])
  const wire = new Set(Array.isArray(wireframeParts) ? wireframeParts : [])
  if (hidden.size === 0 && wire.size === 0) return
  const parts = findParts(obj)
  for (const p of parts) {
    if (hidden.has(p.id)) {
      p.node.visible = false
      continue
    }
    if (wire.has(p.id)) {
      p.node.traverse((n) => {
        if (!n.isMesh) return
        const mats = Array.isArray(n.material) ? n.material : [n.material]
        mats.forEach((m) => {
          if (m) m.wireframe = true
        })
      })
    }
  }
}

async function init(container, spec) {
  const width = container.clientWidth || 640
  const height = container.clientHeight || 420

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(
    spec.background == null ? 0xf3f4f6 : spec.background,
  )
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000)
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(window.devicePixelRatio || 1)
  renderer.setSize(width, height, false)
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%'
  container.appendChild(renderer.domElement)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = false

  // 조명 — Cad3d.jsx 와 동일 레시피(ambient + key + fill).
  scene.add(new THREE.AmbientLight(0xffffff, 0.55))
  const key = new THREE.DirectionalLight(0xffffff, 0.85)
  key.position.set(60, 80, 60)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xffffff, 0.35)
  fill.position.set(-40, 30, -40)
  scene.add(fill)

  const group = new THREE.Group()
  scene.add(group)

  const render = () => renderer.render(scene, camera)
  // enableDamping=false 라 입력이 있을 때만 다시 그리면 충분(연속 RAF 불필요).
  controls.addEventListener('change', render)

  try {
    const buf = base64ToArrayBuffer(spec.dataB64)
    // loadModelFromBlob 는 blob.arrayBuffer() 를 호출하므로 Blob 으로 감싼다.
    let obj = await loadModelFromBlob(new Blob([buf]), spec.ext, STACK)
    obj = await maybeSplitConnectedComponents(obj, spec.ext, STACK)
    applyPartState(obj, spec.hiddenParts, spec.wireframeParts)
    group.add(obj)

    const box = new THREE.Box3().setFromObject(group)
    const size = new THREE.Vector3()
    const center = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(center)

    const vs = spec.viewState
    if (vs && vs.position && vs.target) {
      camera.position.fromArray(vs.position)
      controls.target.fromArray(vs.target)
      camera.zoom = typeof vs.zoom === 'number' && vs.zoom > 0 ? vs.zoom : 1
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld(true)
    } else {
      // 저장된 뷰가 없으면 Cad3d 의 'iso' 프리셋과 동일하게 피팅.
      applyViewPreset('iso', { camera, controls, center, size, THREE })
    }
    controls.update()
    render()
  } catch (err) {
    console.error('[cad3d-export] 모델 로드 실패', err)
    showError(container, '3D 모델을 불러오지 못했습니다')
    return
  }

  // 컨테이너 리사이즈에 카메라/렌더러 동기화.
  const ro = new ResizeObserver(() => {
    const w = container.clientWidth || width
    const h = container.clientHeight || height
    if (!w || !h) return
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h, false)
    render()
  })
  ro.observe(container)
}

// 각 뷰어 컨테이너를 독립 init. 한 개가 실패해도 나머지엔 영향 없음.
function initAll(specsById) {
  const nodes = document.querySelectorAll('[data-cad3d-spec-id]')
  nodes.forEach((el) => {
    const id = el.getAttribute('data-cad3d-spec-id')
    const spec = specsById[id]
    if (!spec) return
    init(el, spec).catch((err) =>
      console.error('[cad3d-export] init 실패', id, err),
    )
  })
}

window.__RA_CAD3D__ = { init, initAll }
