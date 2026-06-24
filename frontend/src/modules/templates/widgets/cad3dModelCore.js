// cad_3d 모델 코어 — 순수(비-React) 모델 처리 함수.
//
// Cad3d.jsx(라이브 위젯)와 reports/cad3d/viewerRuntime.entry.js(저장 HTML 의
// 오프라인 뷰어)가 **둘 다** 이 모듈을 import 한다. 파트 식별(findParts) / STL
// 연결성분 분할(maybeSplitConnectedComponents) 결과가 양쪽에서 100% 동일해야
// content.hidden_parts / wireframe_parts 의 part id 가 export 뷰어에서도 그대로
// 매칭되기 때문이다. 여기 있는 함수는 모두 THREE / 로더를 인자로 받는 순수
// 함수이며 React·DOM 에 의존하지 않는다(런타임 번들에 React 가 섞이지 않도록).
//
// ⚠ 수정 시: 두 소비처(위젯/뷰어)의 동작이 갈라지지 않게 항상 이 한 곳만 고친다.

/** Extract a "parts" list (toggleable hide/show units) from the imported
 *  model. CAD-tool GLB exports vary wildly in hierarchy — some flatten
 *  every component to the top level, others nest several wrapper groups,
 *  others bury the named meshes a few levels deep. We try two strategies
 *  and pick whichever gives a useful list:
 *
 *  1. **Wrapper-strip**: walk past single-child Groups, take the first
 *     multi-child level. Works for `Scene → Assembly → [Part1..]`.
 *  2. **Traversal fallback**: collect every *named* renderable node
 *     in the tree, suppressing children whose named ancestor is
 *     already in the list. Works for deeply nested assemblies where
 *     the meaningful parts live at varying depths.
 *
 *  Returns `[]` only when neither strategy finds 2+ pieces — typical for
 *  single-mesh STL/OBJ exports, where the toggle button stays hidden.
 *
 *  IDs are stable across re-exports of the same model (use the node
 *  `name`); when names collide we suffix `#<index>` so the persisted
 *  `hidden_parts` list can still distinguish them. */
export function findParts(rootObj) {
  if (!rootObj) return []

  // Strategy 1: strip wrappers.
  let node = rootObj
  while (node?.children?.length === 1) {
    node = node.children[0]
  }
  const directKids = (node?.children ?? []).filter(hasRenderableDescendant)
  if (directKids.length >= 2) return toPartList(directKids)

  // Strategy 2: traverse and collect named renderables. Suppress nodes
  // whose ancestor is already collected so we don't double-count
  // (e.g. "Part" + "Part > Mesh001" both showing up).
  const collected = []
  const collectedSet = new Set()
  rootObj.traverse?.((n) => {
    if (!n.name) return
    if (!hasRenderableDescendant(n)) return
    let ancestor = n.parent
    while (ancestor) {
      if (collectedSet.has(ancestor)) return
      ancestor = ancestor.parent
    }
    collected.push(n)
    collectedSet.add(n)
  })
  if (collected.length >= 2) return toPartList(collected)

  return []
}

export function toPartList(nodes) {
  // Name collision guard — if the model has multiple `Mesh001`s
  // (Blender's default export, for one), give each a `#<idx>` suffix
  // so toggling one doesn't toggle them all.
  const counts = {}
  for (const n of nodes) {
    const k = n.name || ''
    counts[k] = (counts[k] || 0) + 1
  }
  return nodes.map((n, i) => {
    const displayName = n.name || `Part ${i + 1}`
    let id
    if (!n.name) id = `_unnamed_${i}`
    else if (counts[n.name] > 1) id = `${n.name}#${i}`
    else id = n.name
    return { id, name: displayName, node: n }
  })
}

export function hasRenderableDescendant(obj) {
  let found = false
  obj.traverse?.((n) => {
    if (n.isMesh || n.isLine || n.isLineSegments || n.isPoints) found = true
  })
  return found
}

/** Resolve a fresh camera position for a named preset, sized off the
 *  model's bounding box so it always lands "inside the room". */
export function applyViewPreset(name, { camera, controls, center, size, THREE }) {
  const radius = Math.max(size.x, size.y, size.z, 1) * 1.5
  // Camera FOV is fixed at 45° in the renderer init; back off enough
  // that the whole box fits inside the frustum with a small margin.
  const dist = radius / Math.tan((45 / 2) * (Math.PI / 180)) * 1.1
  controls.target.copy(center)
  switch (name) {
    case 'front':
      camera.position.set(center.x, center.y, center.z + dist)
      break
    case 'top':
      camera.position.set(center.x, center.y + dist, center.z + 0.001)
      break
    case 'side':
      camera.position.set(center.x + dist, center.y, center.z)
      break
    case 'fit':
    case 'iso':
    default: {
      const d = dist / Math.sqrt(3)
      camera.position.set(center.x + d, center.y + d, center.z + d)
      break
    }
  }
  camera.up.set(0, 1, 0)
  camera.lookAt(center)
  camera.zoom = 1
  camera.updateProjectionMatrix()
  // Suppress unused warning — `THREE` is part of the destructured args
  // for symmetry with sites that need extra math types.
  void THREE
}

/** STL is a flat triangle soup — no node hierarchy, no per-part names.
 *  But when an STL is exported from a multi-body assembly, the bodies
 *  are usually still **spatially disconnected** (no shared vertices),
 *  so we can recover them via connected-component analysis on the
 *  triangle adjacency graph. Returns a `Group` of per-component
 *  Meshes when 2..200 components are found; otherwise leaves the
 *  original mesh alone (single body, or too many micro-fragments to
 *  be useful).
 *
 *  Only called for STL — GLB has its own hierarchy, OBJ's loader
 *  already builds per-group Meshes, so connected-component splitting
 *  would either duplicate that work or fight it.
 */
export async function maybeSplitConnectedComponents(obj, ext, stack) {
  if (ext !== '.stl') return obj
  if (!obj.isMesh) return obj
  const { THREE, BufferGeometryUtils } = stack

  // Safety cap — connected-component split on a multi-million-tri STL
  // can stall the main thread for several seconds. Below the cap we
  // do it sync (<1s for typical assemblies).
  const triCountRaw = (obj.geometry.getAttribute('position')?.count ?? 0) / 3
  if (triCountRaw > 500_000) {
    console.warn('[Cad3d] STL too large for auto-split:', triCountRaw, 'tris')
    return obj
  }

  // STL stores each triangle's vertices independently, AND each
  // triangle carries its own flat-shaded normal. mergeVertices treats
  // vertices as "different" when ANY attribute (including normal)
  // differs — so two triangles meeting at an edge keep distinct
  // copies of the shared position because the per-face normals are
  // different. The fix: copy positions only into a fresh geometry
  // and let three.js recompute smooth vertex normals after the
  // merge. This recovers the actual mesh topology.
  let indexed
  try {
    const positionOnly = new THREE.BufferGeometry()
    positionOnly.setAttribute('position', obj.geometry.getAttribute('position'))
    // 1e-4 is generous enough to absorb f32 round-trip noise from
    // different STL writers without merging actually distinct bodies.
    indexed = BufferGeometryUtils.mergeVertices(positionOnly, 1e-4)
    indexed.computeVertexNormals()
  } catch (err) {
    console.warn('[Cad3d] mergeVertices failed, keeping single mesh:', err)
    return obj
  }
  const components = findConnectedComponentsTris(indexed)
  if (components.length < 2 || components.length > 200) {
    indexed.dispose()
    return obj
  }

  // Build a Group with one Mesh per component, sharing the original
  // material. Sort components by triangle count desc so the largest
  // body becomes "Part 1" — usually the part the user thinks of first.
  components.sort((a, b) => b.length - a.length)
  const group = new THREE.Group()
  group.name = obj.name || 'STL Model'
  for (let i = 0; i < components.length; i += 1) {
    const subGeom = buildSubGeometryFromTris(indexed, components[i], THREE)
    const mesh = new THREE.Mesh(subGeom, obj.material)
    mesh.name = `Part ${i + 1}`
    group.add(mesh)
  }
  // Free the merged + original — the new sub-geometries own their own
  // attribute buffers and don't reference back.
  indexed.dispose()
  obj.geometry.dispose()
  return group
}

/** Union-Find over the triangle adjacency graph. Two triangles are
 *  connected iff they share at least one vertex index (after vertex
 *  merging). Returns an array of arrays of triangle indices, one per
 *  connected component. */
export function findConnectedComponentsTris(geom) {
  const indexAttr = geom.getIndex()
  if (!indexAttr) return []
  const indices = indexAttr.array
  const triCount = indices.length / 3
  if (triCount === 0) return []

  // Bucket triangles by vertex index — every (vIdx → [t1, t2, ...]).
  const vertexToTris = new Map()
  for (let t = 0; t < triCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const v = indices[t * 3 + k]
      let list = vertexToTris.get(v)
      if (!list) {
        list = []
        vertexToTris.set(v, list)
      }
      list.push(t)
    }
  }

  // Union triangles that share a vertex. Path compression keeps the
  // amortized cost near O(1) per find().
  const parent = new Int32Array(triCount)
  for (let i = 0; i < triCount; i += 1) parent[i] = i
  function find(x) {
    let root = x
    while (parent[root] !== root) root = parent[root]
    while (parent[x] !== root) {
      const next = parent[x]
      parent[x] = root
      x = next
    }
    return root
  }
  for (const tris of vertexToTris.values()) {
    if (tris.length < 2) continue
    const ra = find(tris[0])
    for (let i = 1; i < tris.length; i += 1) {
      const rb = find(tris[i])
      if (ra !== rb) parent[rb] = ra
    }
  }

  // Group by component root.
  const compMap = new Map()
  for (let t = 0; t < triCount; t += 1) {
    const r = find(t)
    let list = compMap.get(r)
    if (!list) {
      list = []
      compMap.set(r, list)
    }
    list.push(t)
  }
  return Array.from(compMap.values())
}

/** Build a fresh BufferGeometry containing only the triangles whose
 *  indices appear in `triIndices`, copying position + normal data
 *  from the merged source. Non-indexed (flat) layout is fine here —
 *  the merge already collapsed shared vertices, and re-indexing per
 *  component would just add work for no perceptible win at the sizes
 *  we cap at. */
export function buildSubGeometryFromTris(srcGeom, triIndices, THREE) {
  const srcIdx = srcGeom.getIndex().array
  const posAttr = srcGeom.getAttribute('position')
  const normAttr = srcGeom.getAttribute('normal')
  const tc = triIndices.length
  const positions = new Float32Array(tc * 9)
  const normals = normAttr ? new Float32Array(tc * 9) : null
  for (let ti = 0; ti < tc; ti += 1) {
    const t = triIndices[ti]
    for (let k = 0; k < 3; k += 1) {
      const vIdx = srcIdx[t * 3 + k]
      const off = ti * 9 + k * 3
      positions[off + 0] = posAttr.getX(vIdx)
      positions[off + 1] = posAttr.getY(vIdx)
      positions[off + 2] = posAttr.getZ(vIdx)
      if (normals) {
        normals[off + 0] = normAttr.getX(vIdx)
        normals[off + 1] = normAttr.getY(vIdx)
        normals[off + 2] = normAttr.getZ(vIdx)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (normals) {
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  } else {
    g.computeVertexNormals()
  }
  return g
}

/** Pick a loader based on the filename extension and return the loaded
 *  Object3D. STL produces a buffer geometry → wrap in a Mesh with a
 *  default material. */
export async function loadModelFromBlob(blob, ext, { THREE, GLTFLoader, STLLoader, OBJLoader }) {
  const buf = await blob.arrayBuffer()
  if (ext === '.glb' || ext === '.gltf') {
    const loader = new GLTFLoader()
    const gltf = await loader.parseAsync(buf, '')
    return gltf.scene ?? gltf.scenes?.[0]
  }
  if (ext === '.stl') {
    const loader = new STLLoader()
    const geom = loader.parse(buf)
    geom.computeVertexNormals()
    // DoubleSide — STL files (especially when exported from
    // open-source CAD tools) frequently have inconsistent triangle
    // winding, which makes some faces invisible from one side under
    // default front-face culling. Drawing both sides costs a bit of
    // fill rate but is robust for arbitrary STL input.
    const mat = new THREE.MeshStandardMaterial({
      color: 0xb0bec5,
      metalness: 0.05,
      roughness: 0.65,
      side: THREE.DoubleSide,
    })
    return new THREE.Mesh(geom, mat)
  }
  if (ext === '.obj') {
    const loader = new OBJLoader()
    const text = new TextDecoder('utf-8').decode(buf)
    return loader.parse(text)
  }
  throw new Error(`지원하지 않는 형식: ${ext}`)
}
