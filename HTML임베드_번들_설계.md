# HTML 임베드 — 폴더 번들 지원 설계

## 1. 목적 / 배경

업무 보고서를 HTML 로 작성하는 사용자가, **메인 HTML + 서브 파일(json·js·css·이미지
등)이 폴더 구조로 얽힌 묶음**을 그대로 보고서에 임베드해 보게 한다.

- 지금은 `.html` **단일 파일**만 임베드 가능(`html_embed` 위젯, `srcdoc`).
- 사용자는 **zip 으로 묶기 싫어함** → 폴더를 *구조 그대로* 올리는 UX 필요.
- 사내 IP 접근 환경(도메인 없음). 나중에 사내 도메인으로 갈아탈 수 있음 → **호스트에
  안 묶이는 설계**가 전제.

## 2. 현재 동작과 한계

현재 `frontend/src/modules/templates/widgets/HtmlEmbed.jsx`:
```jsx
<iframe srcDoc={html} sandbox="allow-scripts" ... />
```
- 단일 파일 바이트를 텍스트로 읽어 `srcdoc` 인라인 → **null origin** 격리.
- 한계: 메인 HTML 이 서브를 **상대경로**로 찾으면(`fetch('data.json')`,
  `<script src>`, `<img>`) 전부 깨진다. 서브 파일이 같은 URL 경로에 co-locate
  되지 않고, srcdoc 은 기준 URL 이 없기 때문.

## 3. 핵심 결정 (사용자 확인)

- [x] 임베드 HTML 은 **브라우저 저장소(localStorage 등) 미사용** → null origin
      **격리 유지**(보안의 핵심). 같은 IP 에서 서빙해도 안전.
- [x] 서브 참조는 **태그 참조 + 런타임 fetch 둘 다** 되게 → 서빙에 CORS 포함.
- [x] 메인(엔트리) HTML 은 **업로드 시 사용자가 직접 지정**.
- [x] 용량 상한은 **넉넉하게**(영상 등 포함) + 설정값으로 조절.
- [x] 번들 접근은 **추측 불가능한 번들 id = capability** 기반(아래 §4). 세션 쿠키
      인증에 의존하지 않음 — 그래야 격리된 iframe 의 fetch 가 동작. id 는 기존
      file_id 처럼 불투명 난수. (서명 토큰 강화는 Phase 2 후보)

## 4. 보안 모델 — 격리 + capability

두 축으로 안전을 만든다. **호스트(IP/도메인)에 의존하지 않는다.**

### 4.1 실행 격리 — sandbox(null origin) 유지
```jsx
<iframe src={`/api/embed/${bundleId}/${entryPath}`} sandbox="allow-scripts" />
```
- `allow-same-origin` **없음** → iframe 은 opaque(null) origin. 임베드 JS 는
  **앱 쿠키·로그인·DOM·localStorage 에 접근 불가**(같은 IP/포트라도).
- 서브 리소스 `<script src>`·`<img>`·`<link>` 는 opaque origin 에서도 로드됨(SOP
  대상 아님).
- 런타임 `fetch('data.json')` 는 opaque→서빙 origin 의 cross-origin 요청 →
  서버가 **`Access-Control-Allow-Origin: *`** 를 주면 통과(비자격 요청).

### 4.2 접근 통제 — capability(불투명 id)
- 격리된 iframe 의 fetch 는 **쿠키를 안 싣는다**(opaque origin, ACAO `*` 는
  credentials 불가). 따라서 번들 서빙 엔드포인트를 **세션 인증으로 막을 수 없다**.
- 대신 **추측 불가능한 번들 id**(난수 ≥ 128bit)를 capability 로 삼는다 —
  URL 을 아는 사람만 접근. 그 URL 은 **인증된 보고서 페이지**가 렌더 시 주입하므로,
  실질적으로 보고서 열람권자에게만 노출된다.
- 트레이드오프: id 를 아는 사람은 인증 없이 그 번들 파일을 받을 수 있음(= 불투명
  공유 링크 모델). 사내 자산이고 id 가 난수라 통상 수용 가능. **더 엄격히 가려면**
  서명 토큰(짧은 만료) 방식으로 강화 가능(§13 열린 결정).

### 4.3 경로 안전
- `relpath` 는 `..`·절대경로·심볼릭 escape 차단. 번들 디렉터리 안으로 정규화 후
  벗어나면 404.
- 응답에 `X-Content-Type-Options: nosniff`, 확장자 기반 정확한 `Content-Type`.

## 5. 데이터 모델 / 저장

- 디스크: `storage/embed/{bundle_id}/<relpath>` 로 폴더 구조 그대로 저장.
- 메타: 테이블 `html_embed_bundle`(id, owner_user_id, entry_path, file_count,
  total_bytes, created_at) + 디렉터리 내 `__manifest__.json`(relpath→size·mime).
- 보고서 블록 `html_embed` content 확장(레거시 단일 파일과 공존):
  ```jsonc
  // 신규(번들)
  { "bundle_id": "…", "entry_path": "index.html", "caption": "…" }
  // 레거시(단일 파일) — 그대로 유지
  { "file_id": "…", "filename": "report.html", "caption": "…" }
  ```
  렌더러는 `bundle_id` 있으면 번들 모드, 아니면 기존 srcdoc 모드.

## 6. API

```
POST   /api/embed                      # 번들 생성(멀티파트: 파일들 + manifest + entry_path)
       → { bundle_id, entry_path, file_count, total_bytes }
GET    /api/embed/{bundle_id}/{relpath:path}   # 번들 파일 서빙
       - ACAO: *  /  nosniff  /  확장자 MIME
       - 인증 없음(capability = bundle_id), 경로 정규화 가드
DELETE /api/embed/{bundle_id}          # 정리(소유자/관리자)
```
- 동적 path 충돌 주의: `/{bundle_id}/{relpath}` 라우트는 고정 라우트 뒤에 등록.

## 7. 프런트 — 업로드 UX (zip 불필요)

- 폴더 선택: `<input type="file" webkitdirectory>` + **폴더 드래그&드롭**
  (`DataTransferItem.webkitGetAsEntry()` 재귀 순회). 각 파일의
  `webkitRelativePath` 로 구조 보존.
- 공통 최상위 폴더 한 겹은 자동 strip(엔트리가 `myreport/index.html` 대신
  `index.html` 이 되게). 모든 파일이 같은 루트일 때만.
- 파일 트리 표시 → 사용자가 **엔트리 HTML 클릭 지정**(결정 §3).
- 업로드: 멀티파트로 한 번에. 큰 용량은 v1 단순 멀티파트(상한 내), 청크/재개는
  Phase 2.
- 상한: 설정값(env). 기본 제안 — 총 **1GB**, 파일 수 **2000**, 단일 파일 **500MB**.
  초과 시 업로드 거부 + 안내.

## 8. 프런트 — 렌더 (HtmlEmbed.jsx)

- content 에 `bundle_id` 있으면:
  ```jsx
  <iframe
    src={`/api/embed/${bundleId}/${entryPath}`}   // 상대/같은 origin — 호스트 무관
    sandbox="allow-scripts"
    ... />
  ```
- 없으면 기존 단일 파일 srcdoc 경로 유지(하위호환).
- iframe `src` 는 **상대경로**로 조립(절대 IP 하드코딩 금지 — §10).

## 9. 내보내기(export)

- **DOCX**: 기존처럼 시각 스냅샷(PNG). 변화 없음.
- **HTML 내보내기**: 번들 iframe 은 `src="/api/embed/…"` 를 유지 → 내보낸 문서를
  **온라인(서버 접근 가능) 상태**에서 열면 동작. 완전 오프라인 자기완결 번들
  내보내기(모든 서브 인라인)는 별도 난제 → Phase 2/보류로 명시(침묵 금지).

## 10. 미래 도메인 전환 — 3원칙 (설계에 못 박음)

IP→사내 도메인 전환이 **코드/데이터 변경 0** 이 되게:
1. iframe `src` 는 **상대경로/같은 origin** — IP 하드코딩 금지.
2. 보고서 JSON 엔 **bundle_id 만** 저장 — 절대 URL 저장 금지(렌더 시 조립).
3. CORS 는 **`*`(또는 요청 origin 반사)** — 특정 IP 화이트리스트 금지.
→ 전환은 배포 설정 변경뿐. 도메인 생기면 `embed.사내도메인` 서브도메인으로 격리
  한 겹 추가도 *선택적 업그레이드*로 가능(현 설계 위에 얹기).

## 11. 단계 계획

### Phase 1 — 번들 임베드 MVP ✅ 구현
- [x] 백엔드: `POST /api/embed`(멀티파트, 파일별 상대경로 = multipart filename),
      `GET /api/embed/{id}/{path}`(ACAO `*`·nosniff·CORP·경로 정규화 가드·MIME
      오버라이드), `DELETE /api/embed/{id}`. 디스크 `embed_bundles/{id}/<relpath>`,
      메타 테이블 `html_embed_bundles`(마이그레이션 p15). 서빙은 무인증(capability).
- [x] 프런트 업로드: 폴더 드래그&드롭(`webkitGetAsEntry` 재귀) + `webkitdirectory`
      input + 공통 루트 strip + 파일 목록 + 엔트리(메인 HTML) 사용자 지정 staging.
- [x] 프런트 렌더: `bundle_id` 분기 → `src` iframe(`sandbox="allow-scripts"`,
      상대 URL). 단일 파일(srcdoc) 레거시 경로 공존, 상호 배타 patch.
- [x] 용량 상한 설정값(`embed_max_bytes` 1GB / `embed_max_files` 2000) + 초과
      413, 경로 traversal 가드(raw·encoded `..` → 404 검증).
- [x] `html_embed` content 스키마에 `bundle_id`·`entry_path` 추가(레거시 file_id
      공존). registry.py.

> 검증(API): index.html·sub/data.json 서빙 200 + 올바른 MIME + ACAO `*`(fetch
> 동작) + nosniff, `../`·`%2e%2e` traversal 404. 브라우저 폴더 업로드 UX 는
> 사용자 확인 대기.

### Phase 2 — 운영·강화 (선택)
- [ ] 청크/재개 업로드(대용량 안정), 진행률.
- [ ] 서명 토큰 접근(capability 강화, 만료).
- [ ] HTML 내보내기 시 번들 인라인(오프라인 자기완결) — 가능 범위에서.
- [ ] 도메인 전환 시 embed 전용 서브도메인 격리.

## 12. 파일별 변경 (Phase 1)

- backend: `app/modules/embed/`(신규: routes·service·models·schemas) 또는
  기존 files 모듈 확장, `app/modules/__init__.py` 라우터 등록, 저장 디렉터리 설정.
- frontend: `modules/templates/widgets/HtmlEmbed.jsx`(렌더 분기 + 업로드 UX),
  `shared/api/`(신규 `embed.js`: createBundle/bundleUrl), 위젯 content 스키마.
- backend widgets: `app/widgets/registry.py` html_embed content 스키마에
  `bundle_id`·`entry_path` 추가(Optional, 레거시 file_id 와 공존).

## 13. 리스크 / 열린 결정

- **capability vs 인증** (열린 결정): 권장은 불투명 id capability(§4.2). 더 엄격히
  필요하면 서명 토큰. → 진행 전 확인.
- **대용량 업로드**: 1GB 급 멀티파트는 브라우저·프록시 타임아웃 위험 → Phase 2
  청크. v1 은 상한을 현실적으로(예: 총 1GB) 두고 안내.
- **임의 사용자 JS 서빙**: sandbox(null origin)로 실행 격리가 보안의 축. 절대
  `allow-same-origin` 을 켜지 말 것(켜면 capability 모델·격리가 무너짐).
- **저장공간**: 번들이 쌓이면 디스크 증가 → 보고서 삭제 시 번들 GC, 미사용 번들
  정리 정책(Phase 2).
- **MIME 오류**: 확장자 매핑 누락 시 JS 가 text/plain 으로 안 돌 수 있음 → 매핑
  테이블 점검(.mjs·.wasm·.json·.svg 등).
