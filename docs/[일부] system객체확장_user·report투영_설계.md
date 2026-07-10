# system 객체 확장 — user·report 온톨로지 투영 설계 (A0.3 후속)

> 상태: **스텝1(파생 투영, p71) + 스텝2 일부(led_by, p72) 구현됨** (2026-07-10) · 스텝2 잔여
> (supersedes/cites 보고서간)·스텝3(자동 채우기) 미구현. A0.3 잔여 = dept까지만 투영된 것을
> **user·report** 로 확장.
>
> **스텝2(수동 관계) — led_by 구현:** 마이그 p72 `led_by`(과제→user) 시드. add_object_link+
> resolve_object(user) 재사용(엔티티 src→user system dst). 프론트 RelationsDialog: 도착축이
> user 면 **사용자 검색 Combobox**(searchUsers, 이름·이메일)로 담당 PL 지정 → object_link.
> 테스트 test_led_by_object_link(생성·조회·축제약). **supersedes/cites(report↔report)는 report
> 측 UI + system-src 링크 라우트가 필요해 후속.**
>
> **스텝1 구현물:** user/report system 축 + 파생 관계 시드(p71). `resolve_object(db,type,id,actor=)`
> — user(라벨=이름, email 비노출)·**report(가시성 게이트: actor 없음/권한 밖 → None)**.
> `derived_links_for(db,actor,type,id)` — report(작성자·편집자·게시부서·다룬 객체) / user(소속부서·
> 작성 보고서 역방향, 가시성 교집합), 상한 50. `GET /api/objects/{t}/{id}[/links]` 가 actor 전달 +
> `derived` 병합. 프론트 ObjectRefProfilePage: user 렌더(파생 관계 칩)·report→상세 리다이렉트.
> 테스트 test_system_objects(가시성 게이트·파생·라우트). **저장 0 — 기존 데이터 이관/백필 없음.**
> 관련: `[일부] 온톨로지_A0.3_설계.md`, `[일부] 엔티티그래프_온톨로지_설계.md`,
> `[완료] 온톨로지 에이전트_tool-calling_설계.md`, `[완료] MCP온톨로지조사_설계.md`,
> `[[project_grant_visibility_model]]`.

---

## 0. 한 줄 요약
사용자·보고서를 **1급 온톨로지 객체**(kind_class='system')로 투영해, *"이 보고서 작성자가
관여한 과제"*, *"이 PL이 담당한 부품의 시험 보고서"*, *"이 보고서를 대체한 최신본"* 같은
**사람·문서를 낀 다단계 traversal**을 열어준다. dept 투영(A0.3 스텝2)과 **같은 패턴**이며,
**핵심은 저장이 아니라 투영** — 연결의 대부분은 이미 FK로 존재한다.

## 1. 핵심 통찰 — 투영 우선(projection-first), 저장 최소

user/report 를 잇는 링크의 **대부분은 이미 관계형 컬럼으로 존재**한다. 새 테이블에
다시 적재하지 말고 **리졸버가 온플라이로 파생**한다(FK가 진실의 원천, 중복·동기화 0).

**이미 있는 FK (→ 파생 엣지로 투영):**
- `reports.owner_user_id` — 작성자(소유자)
- `reports.last_edited_by_user_id` / `updated_by_user_id` — 편집자
- `reports.workspace_slug` (+ 게시 `mounts`) — 소속/게시 부서
- `report_entities`(M:N) — 보고서가 **다룬 객체**(기존 태깅, 이미 프로필에 표시)
- `users.home_workspace_slug` + `workspace_members` — 사용자 소속 부서(+role)

**데이터에 없는 새 의미 (→ 수동 `object_links`):**
- `led_by` (과제 → user, PL) · `supersedes`/`cites` (report → report)

⇒ 스텝 분할이 자연스럽다: **스텝1 = 파생 투영(저장 0, 즉시 가치)**, **스텝2 = 수동 관계(object_links 재사용)**.

## 2. 객체 모델 — 새 system 축 2개 + 관계 카탈로그

### 2.1 system 축 (dept와 동일 패턴, 값 행 없음 — ObjectRef가 원 테이블 투영)
| slug | label | 원 테이블 | id | url | label 필드 | 비고 |
|---|---|---|---|---|---|---|
| `user` | 사용자 | `users` | 정수 | `/objects/user/{id}` | `name` | **email 비노출**(라벨=이름만) |
| `report` | 보고서 | `reports` | 정수 | `/reports/{id}` | `title` | **가시성 게이팅 필수** |

> person(미가입 자유기재 PL)은 A0.3에서 보류 결정 — 본 설계는 **가입 사용자(`users` 행)만** 대상.
> 그래서 "person 도메인 객체화 부담" 이슈를 우회한다.

### 2.2 관계 카탈로그
**파생(자동 투영 — relation_types 등록만, 엣지 저장 안 함):**
| slug | 의미 | 방향(src→dst) | 근거 FK |
|---|---|---|---|
| `authored_by` | 작성 | report → user | `reports.owner_user_id` |
| `edited_by` | 편집 | report → user | `reports.last_edited_by_user_id`·`updated_by_user_id` |
| `documents` | 다룸 | report → entity | `report_entities` (기존) |
| `published_in` | 게시/소속 부서 | report → dept | `reports.workspace_slug` (+mounts) |
| `member_of` | 소속 | user → dept | `users.home_workspace_slug`·`workspace_members` |

**수동(`object_links`·기존 테이블 재사용):**
| slug | 의미 | 방향 | 비고 |
|---|---|---|---|
| `led_by` | 담당(PL) | project → user | 과제 PL — 데이터에 없어 수동 |
| `supersedes` | 대체/후속 | report → report | 이미 시드된 슬러그 재사용(모델↔모델 → report↔report 축 확장) |
| `cites` | 인용 | report → report | 신규 |

## 3. resolve_object 확장 (dept 분기 옆에 user·report)

현재 `resolve_object(db, type, id)` 는 dept만 처리하고 user/report는 `None`
(`services.py:1511` "후속 스텝에서"). 여기에 두 분기를 추가한다.

```
if kind_class == system:
    if type == "dept":   … (기존)
    if type == "user":
        u = db.get(User, int(id))               # 없으면 None
        return {type:"user", id, kind:"system", label:u.name,
                url:f"/objects/user/{id}", icon:…, deleted:not u.is_active}
    if type == "report":
        # ★ 가시성: 요청자가 볼 수 있는 보고서만 해석(권한 밖은 없는 것처럼 None)
        if int(id) not in all_visible_report_ids(db, actor.user.id): return None
        r = db.get(Report, int(id))
        return {type:"report", id, kind:"system", label:r.title,
                url:f"/reports/{id}", icon:…, deleted:r.is_deleted}
```

**설계 결정 ★ — resolve_object 에 `actor` 주입.** report 해석은 요청자별 가시성이
필요하므로 `resolve_object(db, type, id, actor=None)` 로 시그니처를 넓힌다(dept/user/
entity 는 actor 무시). 호출부(agent `get_object`, 프로필 라우트, 그래프 augment)는 이미
actor 를 들고 있다. actor=None 이면 report 는 보수적으로 None(유출 방지).

## 4. 파생 엣지 리졸버 (새 개념 — 저장 없이 관계를 계산)

`object_links`/`entity_relations` 를 읽는 기존 관계 요약에 더해, **FK 파생 엣지**를
얹는 리졸버를 만든다. 두 방향 모두 지원(정·역).

```
derived_links_for(db, actor, ref) -> [{relation, direction, object}]
  report:  authored_by→user(owner) · edited_by→user · published_in→dept
           · documents→entity[]  (report_entities, 상한)
  user:    member_of→dept[]       (home + memberships)
           역방향: authored/edited ← report[]   (owner_user_id=uid, 가시성 게이팅·상한)
           역방향: led_by ← project[]           (object_links dst=user)
  entity:  역방향 documents ← report[]  (기존 _related_reports 재사용)
```

- 결과는 **상한(top-N)** 으로 잘라 토큰/그래프 폭주 방지(agent_tools `_RELATIONS_LIMIT`
  패턴 재사용). report 는 항상 **가시성 교집합**(`all_visible_report_ids`).
- 저장 0 → 데이터 이관·백필·정합성 문제 없음. FK가 바뀌면 즉시 반영.

## 5. 소비처 통합 (dept가 이미 뚫어둔 레일에 얹기)

1. **에이전트 `get_object`** (`agent_tools.py`) — 현재 `kind_class == system` 이면
   기본 정보만 반환(관계·보고서 없음). **user/report 분기 추가**해 §4 파생 엣지 + 수동
   링크를 관계로 채운다 → 보고서·사용자가 **경유(hop) 노드**가 된다. (report 근거는 그
   보고서 자신을 citation 에 추가.)
2. **관계도(subgraph)** — `_augment_graph_object_links` 옆에 **user 노드 투영**(sparse·
   고가치). report 노드는 A0.3 판단대로 **기본 off**(ReportGraphPage·"관련 보고서"와
   중복) — 필요 시 토글로만.
3. **프로필** — `ObjectProfilePage`(이미 `/objects/:type/:id` 범용) 가 user 를 렌더:
   헤더(이름) + 「작성한 보고서」「담당 과제(led_by)」「소속 부서」. report 는 기존
   보고서 상세로 이동(별도 프로필 불필요).
4. **MCP** — 별도 작업 없음: `[완료] MCP온톨로지조사_설계.md` 의 `get_object`/`get_subgraph`
   가 확장된 resolve/파생 리졸버를 그대로 태운다(외부 AI도 사람/문서 traversal 획득).

## 6. 가시성 · 프라이버시 · 거버넌스

- **report**: 항상 `all_visible_report_ids(actor)` 교집합. 권한 밖은 **resolve 단계에서
  None**(존재 자체 비노출). 그래프·프로필·에이전트·MCP 전 경로 동일.
- **user**: 라벨=**이름만**(email·역할·연락처 비노출). 사내에서 이름은 이미 보고서 작성자로
  노출되는 수준 → 신규 유출 없음. 역방향 "작성 보고서"도 가시성 게이팅되므로 남의 안 보이는
  보고서는 안 샘.
- **탈퇴/비활성 user**: `deleted:true` 로 표시하되 과거 근거는 유지(감사).

## 7. 손대는 곳 (구현 체크리스트)

**백엔드**
- [ ] 마이그 `pNN` — `entity_types` 에 `user`·`report` system 축 시드(값 행 없음) +
      relation_types 시드(`authored_by`·`edited_by`·`documents`·`published_in`·
      `member_of`·`led_by`·`cites`; `supersedes` 축 확장). 축 제약(src/dst) 등록.
- [ ] `services.resolve_object(…, actor=None)` — user/report 분기(+report 가시성).
- [ ] `services.derived_links_for(db, actor, ref)` — §4 파생 엣지(정·역, 상한).
- [ ] `list_object_links_for_ref` 와 파생 엣지 **머지**(수동+파생 한 뷰).
- [ ] `GET /api/objects/{type}/{id}` · `/links` 가 user/report 처리(기존 라우트 확장).
- [ ] `agent_tools._exec_get_object` system 분기 확장(report/user 관계·근거).
- [ ] 테스트: resolve(가시성·비활성) · 파생 엣지 정역 · 에이전트 traversal · 유출 회귀.

**프론트**
- [ ] `ObjectProfilePage` user 렌더(작성 보고서·담당 과제·소속). report→보고서 상세 리다이렉트.
- [ ] 관계도 user 노드(아이콘/색). report 노드 토글(기본 off).
- [ ] 과제 프로필에 `led_by`(PL) 지정 UI(사용자 검색 드롭다운 → object_link).

## 8. 단계 분할

- **스텝1 — 파생 투영(저장 0)**: user/report 축 + resolve_object + `derived_links_for` +
  에이전트/프로필/그래프 소비. **여기까지가 90% 가치**(작성자·소속·다룬 객체·역방향).
- **스텝2 — 수동 관계**: `led_by`(PL 지정 UI) + `supersedes`/`cites`(보고서 간) object_links.
- **스텝3(선택) — 자동 채우기**: PPT 표지/문서에서 PL 추출→`led_by` 제안
  (`[[project_document_import]]` 연계, A0.3 §5.4 (C) 흡수).

## 9. 열린 결정 (리뷰)
1. **user url/프로필** — (a) `/objects/user/{id}` 전용 프로필(권장·일관) vs (b) 비이동 칩.
2. **edited_by 범위** — 편집자 전부 vs 최종 편집자만(그래프 폭주 방지 → 최종만 권장).
3. **report 그래프 노드** — 기본 off 확정? (A0.3 판단 유지 권장, 토글만 제공).
4. **supersedes 재사용 vs report 전용 슬러그** — 축만 확장(권장) vs `report_supersedes` 신설.
5. **led_by 소스** — 순수 수동 vs owner_user_id 를 임시 PL 로 볼지(오해 소지 → 수동 권장).

## 10. 비목표 / 잔여
- person(미가입 자유기재) 도메인 객체화 — 계속 보류.
- user 상세 프로필의 활동 통계·타임라인 — 후속(본 설계는 관계 traversal까지).
- AGE 전환(D-3)과 무관 — 파생 리졸버는 RDB CTE/조인, AGE 전환 시 내부만 교체.
