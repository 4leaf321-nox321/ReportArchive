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
- **CSP `sandbox` 응답 헤더**(서빙 응답에 `Content-Security-Policy: sandbox
  allow-scripts`): iframe 의 sandbox 속성은 iframe 안에서만 유효해서, **새 탭으로
  열기**(§8.1)처럼 `/api/embed/…` 를 **최상위 탭**으로 열면 격리가 풀린다 —
  같은 origin(같은 IP/포트)에서 실행돼 임베드 JS 가 앱 localStorage 의 access
  token 을 읽을 수 있음(이 앱은 토큰을 localStorage+Bearer 로 보관 → 협업 환경에서
  토큰 탈취 벡터). CSP `sandbox` 는 **최상위 문서에도** sandbox 플래그를 적용해
  opaque origin 으로 만든다 → 단일 origin 에서도 새 탭이 안전. iframe 경로도 한
  겹 더 단단해짐(defense-in-depth). `allow-same-origin` 은 **절대 넣지 않는다**.

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
  // 신규(번들) — 표시 모드/높이 포함
  {
    "bundle_id": "…",
    "entry_path": "index.html",
    "caption": "…",
    "display": "card",      // "inline" | "card" (기본 card, §8.1)
    "height_px": 600,       // inline 높이(integer px, 60~4000; 미설정 시 반응형 70vh)
    "title": "…",           // card 모드 표지 제목(없으면 caption/entry_path)
    "description": "…",     // card 모드 부가 설명(선택)
    "cover_file_id": "…"    // card 모드 표지 썸네일(/api/files id, 선택)
  }
  // 레거시(단일 파일) — 그대로 유지
  { "file_id": "…", "filename": "report.html", "caption": "…" }
  ```
  렌더러는 `bundle_id` 있으면 번들 모드, 아니면 기존 srcdoc 모드.
  `display`·`height_px`·표지 필드는 모두 Optional — 없으면 기본값 적용.

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

## 8.1 표시 모드 / 진입점 — 위젯을 "관문(gateway)"으로

### 배경 — 카테고리 불일치
사용자가 올리는 HTML 은 두 성격이 섞임: ① **전시물(figure)** — 호스트 보고서를
보조하는 자료(박스 안 인라인이 적합), ② **독립 문서(standalone)** — 그 자체로
완결된 보고서(풀뷰포트·반응형·자체 스크롤 전제). ②를 작은 위젯 박스에 욱여넣으면
스크롤-안의-스크롤·잘린 레이아웃·이중 크롬으로 어색해진다. → 위젯을 박스에 다 보여주려
하지 말고 **미리보기 + 진입점**으로 재정의한다.

### 구성 요소 (세 가지 모두 구현)
1. **전체화면 확대** — 위젯에 "전체화면" 버튼 → **앱 레벨 CSS 오버레이**
   (`position:fixed; inset:0; z-index:…`)로 iframe 을 뷰포트 전체에 띄움. 브라우저
   Fullscreen API 가 아니라 일반 오버레이이므로 `sandbox` 제약·권한 문제 없음.
   `sandbox="allow-scripts"`(null origin) **그대로 유지** → 격리 안 깨짐. ESC/배경
   클릭으로 닫기. 완결 보고서를 "원래 크기"로 보는 탈출구.
2. **새 탭으로 열기** — 번들은 이미 `/api/embed/{id}/{entry}` 자기 URL 보유(§6).
   완결 문서의 본성에 가장 맞는 형태(자기 URL 에서 살게 둠). capability id 가 URL 에
   포함되어 그대로 동작. `target="_blank" rel="noopener noreferrer"`.
   **단일 파일도 1-파일 번들로 업로드**하므로(아래) 모든 임베드가 새 탭 가능 —
   단일/폴더 구분 없이 일관된 UX. (이미 저장된 레거시 `file_id` srcdoc 블록만
   새 탭 불가; 새로 올리면 전부 번들.)
   ⚠️ **보안**: 최상위 탭은 iframe sandbox 가 안 걸리므로 그냥 열면 앱 origin 에서
   실행돼 토큰 탈취 위험 → 서빙 응답의 **CSP `sandbox` 헤더**(§4.1)로 opaque origin
   강제해야 안전. 이 헤더가 이 기능의 **전제**.

> **단일 .html 도 번들로 통일**(§8.1 결정): 단일 파일 업로드를 `srcdoc` 대신
> 1-파일 번들(`createEmbedBundle([{file, path:파일명}], 파일명)`)로 만든다. 이유 —
> 안전한 새 탭/전체화면의 유일한 길은 **CSP sandbox 가 걸린 embed 서빙 URL** 뿐.
> `/api/files` 다운로드 URL 은 Bearer 인증이라 새 탭 네비게이션에 토큰이 안 실리고
> CSP sandbox 도 없어 부적합. srcdoc/blob/data: 도 최상위에선 앱 origin 이라 토큰
> 노출. → 모든 임베드를 번들로 모으면 URL·격리·새 탭이 일관됨. 레거시 file_id
> srcdoc 렌더 경로는 기존 보고서 하위호환용으로만 남긴다.
3. **표시 모드(`display`)** —
   - `inline`: 박스 안 iframe(전시물 의도). 풀-width + 사용자 지정 `height_px`
     (integer px; **미설정 시 반응형 70vh**). cross-origin iframe 은 내부 높이를
     postMessage 로 못 받음(임의 HTML, 협조 불가) → 자동맞춤 비현실적이라
     **고정 높이 + 전체화면 탈출구**가 정답.
   - `card`: **표지(제목·설명·썸네일) + "열기" 버튼**만. iframe 은 접혀 있다가 클릭
     시 전체화면(1) 또는 새 탭(2)으로. 독립 문서 의도.
   - **번들 업로드 기본값 = `card`** (완결 보고서 흐름: 카드 → 전체화면). `inline`은
     명시 선택 시.

### 멘탈 모델
"작게 미리보고, 제대로 보려면 펼친다." 인라인을 버리는 게 아니라 진입점을 더해
완결 보고서의 본성을 존중하면서 위젯 컨텍스트도 유지한다. 전체화면·새 탭 버튼은
`display` 와 무관하게 **항상 노출**.

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

### Phase 1.5 — 표시 모드 / 진입점 (§8.1, 세 가지 모두) ✅ 구현
- [x] 렌더: 전체화면 확대(`createPortal` 앱 레벨 오버레이 `position:fixed`, sandbox
      유지, ESC·닫기 버튼) + 새 탭 열기(`embedBundleUrl`, `target=_blank rel=noopener
      noreferrer`). 두 버튼은 `display` 무관 항상 노출(`HtmlEmbedView` 툴바).
- [x] **단일 .html 도 1-파일 번들로 통일**(`handleSingleFiles` → `createEmbedBundle`)
      → 모든 신규 임베드가 새 탭 가능. 드롭존에 단일 html 떨구면 staging 없이 바로
      번들 생성.
- [x] **레거시 자동 마이그레이션**: 기존 file_id srcdoc 블록을 **편집 모드로 열면**
      이미 가져오는 바이트를 1-파일 번들로 재업로드 → bundle_id 부여(`HtmlEmbedEditor`
      useEffect, `migratedRef` 가드로 블록당 1회). readOnly(열람)는 건드리지 않으므로
      **편집 전까지는 옛 블록이 srcdoc·새 탭 불가** 상태로 렌더 하위호환 유지.
      ⚠️ StrictMode(dev) 대비: cleanup 에서 작업을 cancel 하지 않는다 — cancel 하면
      1차(취소) 마운트가 patch 를 건너뛰고 2차는 ref 가드에 막혀 "전환 중…"에서
      영영 멈춘다. ref 가드만으로 1회 실행 보장 + patch 는 끝까지 수행. 실패 시
      console.error + 토스트로 노출(조용한 삼킴 금지).
- [x] **보안 전제**: 서빙 응답에 `Content-Security-Policy: sandbox allow-scripts`
      추가(`embed/routes.py`) → 새 탭(최상위 문서)도 opaque origin 강제, 앱
      localStorage 토큰 탈취 차단(§4.1).
- [x] 렌더: `display="card"`(표지 아이콘/썸네일 + 제목·설명 + 열기 버튼, iframe 은
      전체화면/새 탭에서만 로드 = 지연) / `display="inline"`(풀-width iframe +
      `height_px`, 미설정 시 70vh) 분기. 기본 = card(`display!=="inline"`).
- [x] content 스키마(`_html_embed_content` — **검증은 이 함수**가 함): `display`
      (enum card/inline)·`title`·`description`·`cover_file_id` 추가, `height_px`
      (60~4000)는 기존 필드 재사용. 전부 Optional·`additionalProperties:false`.
- [x] 편집 UX: 업로드 후 편집 컨트롤(`HtmlEmbedDisplayControls`)에서 카드/인라인
      토글·표지(제목/설명/이미지)·높이(px) 조정. 빈 값은 patch 에서 키 제거 → 기본값.

### Phase 2 — 운영·강화 (선택)
- [ ] 청크/재개 업로드(대용량 안정), 진행률.
- [ ] 서명 토큰 접근(capability 강화, 만료).
- [ ] HTML 내보내기 시 번들 인라인(오프라인 자기완결) — 가능 범위에서.
- [ ] 도메인 전환 시 embed 전용 서브도메인 격리.

## 12. 파일별 변경 (Phase 1)

- backend: `app/modules/embed/`(신규: routes·service·models·schemas) 또는
  기존 files 모듈 확장, `app/modules/__init__.py` 라우터 등록, 저장 디렉터리 설정.
- frontend: `modules/templates/widgets/HtmlEmbed.jsx`(렌더 분기 + 업로드 UX +
  §8.1 전체화면 오버레이·새 탭·card/inline 분기), `shared/api/`(신규 `embed.js`:
  createBundle/bundleUrl), 위젯 content 스키마.
- backend widgets: `app/widgets/registry.py` `_html_embed_content` 에
  `bundle_id`·`entry_path` 추가(Optional, 레거시 file_id 와 공존). Phase 1.5 에서
  `display`·`title`·`description`·`cover_file_id` 추가 + `height_px` 재사용(전부
  Optional). 검증 스키마는 `content_schema` 딕셔너리가 아니라 이 함수임에 주의.
- backend embed: `app/modules/embed/routes.py` 서빙 응답에 CSP `sandbox` 헤더(§4.1).

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
