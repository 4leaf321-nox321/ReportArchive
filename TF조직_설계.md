# TF 조직(Task Force) 설계 — 트리 밖 한시 조직의 자료·멤버 관리

> **구현 완료 (2026-06-24, 마이그레이션 `p49_tf_workspaces`).** §2 핵심 결정 전부
> 반영. 백엔드: `WorkspaceKind.tf`/`WorkspaceStatus`, `create_tf_workspace`·
> `user_is_lead`(personal 제외)·`set_workspace_archived`·`member_tf_slugs`,
> `POST /api/workspaces/tf`(require_lead)·`PATCH /{slug}/archive`·`GET /tf/all`,
> `list_all_workspaces` TF 멤버십 스코프, `CurrentUser.read_only`(archived) +
> `require_writer` 가드. 프런트: WorkspaceSelector "내 TF" 섹션(active+보관 토글)·
> TF 개설 다이얼로그(보직장 게이트)·보관/복원 버튼·트리거 (TF) 태그, buildTree/
> orgFallback 가 TF off-tree 제외. **셀렉터 확대 버튼 → 2단 조직 브라우저 모달
> (`WorkspaceBrowserModal`, 좌=공식 조직도 트리 / 우=내 TF, 통합 검색)** — 작은
> 드롭다운으로 부서 찾기 어려운 문제 해소. 테스트 `tests/test_tf_workspaces.py`(8종 통과).
> **멤버 추가는 코드 변경 불필요** — 기존 add_member 가 부서 무관 차출을 이미 지원.
> 미반영(폴리시·폴리시): 개설 허용 정책 플래그(sysadmin)·archived 페이지 배너·
> sysadmin TF 감독 UI 는 §9 후속.

ReportArchive를 "공식 조직도(본부>팀) 기준의 영구 조직만 다루는 도구"에서,
**공식 조직도와 나란히 존재하는 한시적·교차기능(cross-functional) TF 조직의
자료와 멤버를 현업이 직접 운영하는 플랫폼**으로 확장하기 위한 데이터 모델·
거버넌스·네비게이션·가시성·개발 계획.

전제(사용자 확정):
- 공식 조직도는 **지금처럼 sysadmin이 계속 소유**한다. 이 설계는 거기에 손대지 않는다.
- TF는 공식 조직도와 **별도 평면**으로 존재한다(트리에 안 들어감, 상속 없음).
- TF 자료·멤버 운영은 **현업이 self-service**로 한다. sysadmin은 정책·감독만.

---

## 1. 배경 — 왜 공식 조직도 위에 TF를 얹으면 안 되는가

현재 조직 모델(2026-06 코드 확인):

- `Workspace.kind ∈ {org, personal, virtual}`. `org`는 `parent_slug` **트리 + 하향
  상속**이 핵심(본부 매니저 → 산하 팀 자동 매니저). 멤버는 `WorkspaceMember(user_id,
  workspace_slug, role ∈ {manager, user})`.
- 조직 생성은 `POST /api/workspaces` = **`require_system_admin` 전용**.
- 멤버 추가는 `POST /{slug}/members` = `require_admin` + **"자신∪하위 부서로만"** 제약.
- 가시성·편집은 `grants/`(ContentGrant/BoardGrant/FolderGrant/CompositeDefaultGrant)로
  통합. workspace principal grant 도달은 `ancestor_slugs_inclusive` 기반.

TF는 공식 부서와 **본질이 반대**다:

| | 공식 부서(org) | TF |
|---|---|---|
| 구조 | 트리, 영구 | 평면(flat), 한시적 |
| 멤버 | 소속 1곳, 상속됨 | 여러 부서에서 차출(cross-functional) |
| 거버넌스 | sysadmin이 조직도 관리 | 보직장이 self-service 개설 |
| 수명 | 없음(상시) | 종료/해산 있음(archived) |
| 드롭다운 노출 | 전원에게 전 부서 노출 | 멤버에게만 노출 |

→ 그래서 TF를 `org` 트리에 그대로 넣으면 사고가 난다: 상위 보직장이 산하 모든
TF에 자동 매니저로 새거나(상속), `ancestor_slugs_inclusive` 기반 grant 도달이 TF
자료를 엉뚱한 부서로 흘리거나, 드롭다운에 전 사용자의 모든 TF가 노출된다.
**같은 테이블은 재사용하되, 상속·거버넌스·수명·가시성은 분리한다**가 이 설계의 골자.

---

## 2. 핵심 결정 (사용자 확정)

- [x] **TF = `Workspace.kind='tf'`, `parent_slug=NULL`** (공식 트리 밖 별도 평면).
      mount·folder·grant·종합보고를 전부 재사용. 트리 밖이라 ancestor walk가 빈
      결과 → **상속이 자연히 꺼짐**. 공식 `org` 트리는 무변경.
- [x] **멤버십 = 평면 명시 리스트.** `WorkspaceMember` 그대로 쓰되 상속 없음 +
      **부서 무관 차출**(아무 부서 사용자나 email로 추가). 개설자가 매니저.
- [x] **개설 권한 = 보직장(`role=manager`) 이상 self-service.** 아무 부서든 매니저면
      TF 개설 가능, 개설자가 곧 그 TF의 매니저로 멤버 직접 차출. sysadmin은 실행에서
      빠지고 **감독만**(전체 TF 목록, 강제 종료/소유자 재지정, 개설 허용 정책 플래그).
- [x] **접근 = 기존 `WorkspaceSelector` 드롭다운 동일.** 단 picker 안 **"내 TF" 독립
      섹션**(off-tree라 조직 트리에 안 그려짐) + **멤버십 스코프**(내가 멤버인 TF만 노출).
- [x] **수명 = `status ∈ {active, archived}`.** archived 시 **읽기전용 보존**(자료
      이관 없음), picker 기본 숨김 + "보관됨" 토글로 열람.
- [x] **공식 부서 노출 = 기본 TF 멤버 전용, 필요 시 grant로 옵트인.** 개설 시 "주관
      부서" 자동 공유 같은 건 v1 없음. 기존 BoardGrant/ContentGrant/external-view 재사용.

---

## 3. 데이터 모델

### 3.1 Workspace 확장
- `WorkspaceKind` enum에 `tf` 추가.
- TF 행: `kind='tf'`, `parent_slug=NULL`, `personal_owner_user_id=NULL`.
- TF 전용 신규 컬럼:
  - `status` (enum `active|archived`, default `active`) — org/personal/virtual은 항상 `active`.
  - `archived_at` (datetime, nullable), `archived_by_user_id` (FK, nullable).
  - (선택) `created_by_user_id` (FK) — 개설자 추적. org는 sysadmin이라 무의미했지만 TF는 의미.

> off-tree 보장: `parent_slug`를 `_tf` 같은 가상 루트에 매달지 **않는다**. 루트에
> 매달면 그 루트 멤버가 전 TF에 상속될 위험 → 반드시 `NULL`로 두고 내비에서 분리.

### 3.2 멤버십
- `WorkspaceMember(user_id, tf_slug, role)` 그대로. **상속 계산 제외**: 멤버 조회/role
  resolution이 `kind=tf`면 ancestor/descendant walk를 타지 않고 직접 행만 본다.
- 차출 제약 해제: TF 멤버 추가는 "자신∪하위 부서" 스코프 무시, 아무 부서 사용자 허용.

### 3.3 자료(재사용, 신규 없음)
- 보고서: personal → TF로 `ReportMount`(기존과 동일). TF 게시판/폴더 그대로.
- 종합보고: TF home 워크스페이스로 생성 가능, CompositeDefaultGrant도 TF에 적용 가능.
- 공유: ContentGrant/BoardGrant/FolderGrant principal에 TF slug(workspace) 또는 user 그대로.

---

## 4. 거버넌스 — 누가 무엇을

| 행위 | 권한 |
|---|---|
| TF 개설 | **아무 부서든 `role=manager`(보직장) 이상** OR sysadmin |
| TF 멤버 추가/제거/role 변경 | 그 TF의 매니저 OR sysadmin (부서 무관 차출 허용) |
| TF 자료 작성/편집 | 기존 `can_edit` 그대로(TF 멤버십·grant 기반) |
| TF 외부 공유(grant) | 그 TF의 매니저 OR sysadmin (기존 share 권한과 동형) |
| TF 종료(archive)/소유자 재지정 | 그 TF의 매니저 OR sysadmin |
| **개설 허용 정책 on/off** | **sysadmin 전용**(조직 차원: TF 개설을 보직장에게 열지 여부) |
| **전체 TF 목록·강제 종료** | **sysadmin 전용**(난립 사후 정리·감독) |

핵심: 거버넌스(정책 한 줄·감독)는 sysadmin, 실행(개설·차출·운영)은 현업. TF는 잦고
시급한데 sysadmin은 멤버 차출 맥락이 없으므로 매 건 승인은 병목이자 잘못된 altitude.

---

## 5. 네비게이션 / 접근

입구는 기존 `WorkspaceSelector` 드롭다운 동일(`shared/components/WorkspaceSelector.jsx`).
일단 들어가면 게시판·폴더·mount·grant 조작감이 공식 부서와 100% 동일.

picker 변경:
- `조직 트리` / `횡단(virtual)` / `내 공간` 옆에 **"내 TF" 섹션** 추가.
- 조직 트리는 `parent_slug` 계층으로 렌더되는데 TF는 off-tree라 거기 안 그려짐 →
  TF는 평면 리스트로 자기 섹션에 렌더(아이콘 별도, 예: Users/Flag).
- **목록 소스 = 멤버십 스코프**(내가 멤버인 TF만). org는 browse-all이지만 TF는 personal과
  유사한 비대칭.
- archived TF는 기본 숨김 + "보관됨" 토글에서 읽기전용 진입.

API:
- `GET /api/workspaces` 가시성 분기 **세 번째 갈래**: `kind=tf`는 **요청자가 그 TF의
  멤버이거나 sysadmin일 때만** 반환(active는 항상, archived는 toggle/쿼리로).
- (대안) picker용 별도 경량 엔드포인트 `GET /api/workspaces/my-tf`로 분리해도 됨.

---

## 6. 가시성 / 권한 동작 (불변식 점검)

[[project_grant_visibility_model]]의 불변식 위에서:
- **멤버 가시성은 active-workspace 기반** — TF 멤버가 X-Workspace-Slug=TF slug로 진입하면
  그 TF content를 봄. TF는 `parent_slug=NULL`이라 ancestor 도달이 없어 grant가 TF 밖으로
  새지 않음(공식 부서로 누수 0).
- **비멤버(public_viewer)** 는 명시적 공유로만 — TF를 외부에 노출하려면 BoardGrant/
  ContentGrant를 명시. mount가 자동 만드는 부서 content grant는 비멤버 가시성에서 이미 제외.
- **편집 도달** `descendants(X)`: TF는 자식이 없으니 TF 자신만. 상향 워크 금지 그대로.
- archived TF: `can_edit`이 `status=archived`에서 무조건 denied(읽기전용 보존). 댓글·이력·
  링크추가도 `is_public_only_viewer`처럼 곁다리 차단.

---

## 7. 수명주기 (Lifecycle)

- `active` → `archived` (매니저/sysadmin). archived 시:
  - 모든 자료 **읽기전용 보존**(자료 이관 없음 — 사용자 확정).
  - picker 기본 숨김, "보관됨"에서 열람.
  - 편집·댓글·mount 추가·grant 변경 차단.
- 재활성(`archived → active`)은 v1 매니저/sysadmin 허용(되돌릴 수 있게).
- 소유자(매니저) 부재 대비: 매니저 전원 이탈 시 sysadmin이 소유자 재지정.

---

## 8. 구현 변경점 요약 (손대는 곳)

백엔드:
1. `WorkspaceKind`에 `tf`, Workspace에 `status/archived_at/archived_by/created_by` 컬럼 + 마이그레이션.
2. `POST /api/workspaces` — TF 분기에서 `require_system_admin` → **lead-role 게이트**(아무 부서 매니저면 통과), 개설자 자동 매니저 멤버 생성, `parent_slug=NULL` 강제.
3. 멤버 라우트(`members/`) — `kind=tf` 분기에서 **descendant-scope 제약 해제** + email 차출 허용.
4. role/멤버 resolution(`members/services.py`, `shared/auth.py`) — `kind=tf`는 상속 walk 스킵.
5. `list_all_workspaces` 가시성 — `kind=tf`는 멤버/ sysadmin 한정(+archived 토글).
6. archive 엔드포인트 `PATCH /api/workspaces/{slug}/archive` (매니저+sysadmin), `can_edit`/곁다리 가드에 `status` 반영.
7. sysadmin 감독: 전체 TF 목록·강제 종료·개설 정책 플래그.

프런트:
1. `WorkspaceSelector`/`WorkspacePicker`에 "내 TF" 섹션 + archived 토글, 아이콘.
2. TF 개설 UI(보직장에게 노출), 멤버 차출 다이얼로그(부서 무관 사용자 검색).
3. archived 읽기전용 배너(기존 cross-org 배너 재사용).

안 건드리는 것: 공식 `org` 트리(sysadmin 소유), grant/external-view/personal→mount 흐름.

---

## 9. 미결정 / 추후 (v2 후보)

- [ ] TF 개설 시 "주관 부서" 지정 → 그 부서 자동 공유(현재 v1은 수동 grant만).
- [ ] archived TF 자료를 원 부서로 이관(mount 옮기기) 옵션(현재 v1은 보존만).
- [ ] TF 개설 정책을 부서별로 차등(전사 일괄 on/off만 v1).
- [ ] TF 종료 예정일/자동 archive 스케줄(백그라운드 워커 활용 — [[project_background_worker]]).
- [ ] 별도 "TF 개설자" 권한 플래그(보직장과 분리한 PMO 위임 모델).

---

## 10. 테스트 관점

- 상속 격리: 상위 부서 보직장이 무관한 TF에 권한 **없음**(자동 매니저 누수 0).
- grant 누수: TF content가 ancestor 경로로 공식 부서에 **안 샘**(`parent_slug=NULL` 검증).
- 가시성: 비멤버는 TF가 드롭다운/목록에 **안 보임**, 명시 공유 시에만 읽기전용 진입.
- 거버넌스: 보직장 self-service 개설 OK, 일반 user는 개설 **거부**, 정책 off 시 보직장도 거부.
- 차출: 다른 부서 사용자 멤버 추가 OK(descendant 제약 안 걸림).
- lifecycle: archived TF는 편집·댓글·mount **차단**, 읽기 OK, 재활성 OK.

관련: [[project_collab_design_doc]], [[project_cross_org_view_design]],
[[project_grant_visibility_model]], [[project_composite_default_share]]
