# AI / RAG · 백그라운드 워커 — 현황

폐쇄망 local LLM 기반 AI(아카이브 시맨틱 검색 → RAG Q&A → 에이전트)와 그 토대인
백그라운드 워커의 진행 상황 정리. **dev 구현·검증 완료 + 운영 반영 완료(2026-06-21)** —
폐쇄망 운영서버에 pgvector·Ollama(bge-m3)·p47/p48·워커까지 가동.

관련 설계: `백그라운드워커_설계.md` · `부족한부분.md` · `약점보강_로드맵.md`.

---

## 한눈에 보기

| 영역 | 상태 | 비고 |
|---|---|---|
| 백그라운드 워커 레일 (p47) | ✅ dev 완료 | 별도 프로세스, Postgres 큐 |
| 오펀 파일 정리 핸들러 | ✅ dev 완료 | 첫 도메인 핸들러 |
| RAG Phase 1 (시맨틱 검색) | ✅ dev 완료 | pgvector·임베딩·하이브리드 검색·API |
| 운영 배포 | ✅ 완료 (2026-06-21) | pgvector·Ollama(**:11435**)·p48·`.env`·reindex 반영 |
| **Phase 2 (MCP search_reports 하이브리드화)** | ✅ dev 완료 | get_report 변경 불필요. 프론트 검색 UI는 선택 |
| Phase 3 (B300 RAG Q&A) | ✅ 완료 | `POST /api/ai/ask`·`app/ai/qa.py`. 그 위에 지능화 로드맵 1~7(v0.87~v0.102) |
| Phase 4 (에이전트) | ✅ 완료(일부) | 다중홉 에이전트(v0.74)·대화형(v0.112~v0.115)·자동요약/태깅. **잔여: 보고서 비교·작성 보조·FMEA 연관 문서 추천** |

> 테스트 회귀: **218 passed / 7 skipped / 0 failed** (skip 7개는 격리 없는 통합테스트의
> 기존 부채 — 운영 무관, 사유는 코드에 명시).

---

## 1. 백그라운드 워커 (Job Queue) — p47

무거운/지연 가능 작업을 웹 요청에서 떼어내 **별도 워커 프로세스**가 처리.
Redis/Celery 없이 Postgres `jobs` 테이블 + `SELECT … FOR UPDATE SKIP LOCKED`.

**파일**
- `app/jobs/` — `models.py`(Job), `queue.py`(enqueue/claim/mark_done·failed/reap),
  `registry.py`(`@handler` 데코레이터), `runner.py`(스레드풀 워커+reaper+graceful
  shutdown), `routes.py`(`GET /api/jobs/{id}` 폴링), `handlers/`.
- `worker.py` — 워커 진입점(run.py 대칭). `app.all_models` import 후 핸들러 로드.
- `deploy/reportarchive-worker.service.template` — systemd 유닛(MCP 서버와 동일 패턴,
  `apptainer exec … worker.py`). ✅ **deploy.sh `setup_worker` 가 자동 렌더·enable·restart**
  (install/update/reset). 운영 가동 중.
- `deploy/reportarchive-orphan-cleanup.{service,timer}.template` — 야간 스케줄.
  ⚠️ **deploy.sh 미연결(남은 작업)** — 핸들러·템플릿은 있으나 타이머를 렌더/enable 하는
  코드가 없어 운영에서 자동 실행 안 됨. `setup_worker` 패턴 복제 필요(수동 enqueue 로는 가능).
- `scripts/enqueue_job.py` — 범용 적재 CLI(타이머/수동용).

**핸들러 현황**
| type | 용도 | 상태 |
|---|---|---|
| `echo` | 레일 self-test | ✅ |
| `orphan_cleanup` | 미참조 업로드 정리(기존 `files.orphans` 래핑) | ✅ |
| `embed_report` | 보고서 1건 임베딩 | ✅ |
| `reindex_embeddings` | 전량 임베딩 fan-out | ✅ |

**온-세이브 임베딩 트리거**(✅): 보고서 저장/수정(본문 title·content·pages 변경) 시
커밋 후 `embed_report` 잡 자동 적재. `reports/models.py` 의 세션 `after_commit` 이벤트
(search_text 재색인 훅과 같은 단일 chokepoint, 모든 저장 경로 커버). dedup_key 로
빠른 연속 저장 흡수, content_hash 로 변화 없으면 워커가 스킵. `settings.embedding_auto_on_save`
(기본 **OFF** — 임베딩 미배포 환경 보호; dev `.env`=true)로 게이트. **⚠️ 잡 처리는
워커(worker.py)가 떠 있어야 함** — 안 떠 있으면 잡이 pending 으로 쌓였다가 워커 기동 시 처리.

**주의사항**
- uvicorn 멀티워커(4)라 루프를 FastAPI startup에 넣지 말 것(중복 실행) → 반드시 별도 프로세스.
- `Job.created_by`는 ORM FK 안 검(매퍼 독립), DB FK만.
- 워커는 `app/all_models.py`로 전체 모델 import해야 도메인 핸들러 매퍼가 configure됨.
- **p47은 pgvector와 무관 → 단독 배포 가능**.

---

## 2. RAG Phase 1 — 시맨틱/하이브리드 검색 (p48)

보고서를 "의미 벡터"로 바꿔 저장하고, 단어가 안 겹쳐도 뜻이 비슷한 보고서를 찾는다.
키워드(pg_trgm)와 결합한 하이브리드까지. RAG Q&A(Phase 3)의 토대.

**파일**
- 마이그 `migrations/versions/p48_report_chunks.py` — `CREATE EXTENSION vector` +
  `report_chunks`(청크+`embedding vector(1024)`+content_hash) + HNSW(코사인) 인덱스.
- `app/ai/models.py` — `ReportChunk`.
- `app/ai/embeddings.py` — 임베딩 클라이언트, **백엔드 토글 `mock`|`ollama`**.
- `app/ai/search.py` — `semantic_search`(벡터 KNN) + `hybrid_search`(벡터+키워드 RRF).
  권한은 `reports.services.visible_report_ids` 재사용(권한 밖 미노출).
- `app/jobs/handlers/embed_report.py` · `reindex_embeddings.py`.
- `app/widgets/text_extraction.py` — `extract_chunks_for_report` 추가(기존 청킹 재사용).
- API: `app/modules/reports/routes.py` → `GET /api/reports/search/semantic?mode=hybrid|semantic`.

**임베딩 백엔드 토글 (핵심 안전장치)**
- `mock` — 텍스트 해시로 결정적 벡터. Ollama 없이 dev에서 전 파이프라인 테스트. (현재 기본)
- `ollama` — 호스트 Ollama 호출. 운영용. `.env` 한 줄로 전환. **운영 포트=11435**
  (기존 다른 사용자 ollama가 11434 점유 → 충돌 회피로 우리 systemd 인스턴스를 11435 에 별도 기동).
- `content_hash`에 모델 지문 포함 → mock→ollama 전환/모델 교체 시 자동 재임베딩.

**설정(.env)**
| 키 | 기본 | 설명 |
|---|---|---|
| `EMBEDDING_BACKEND` | `mock` | 운영은 `ollama` |
| `OLLAMA_BASE_URL` | `http://localhost:11434` (dev) | **운영=`http://localhost:11435`** (포트 충돌 회피) |
| `EMBEDDING_MODEL` | `bge-m3` | 운영 설치본 태그에 맞춤 |
| `EMBEDDING_DIM` | `1024` | **report_chunks 벡터 차원과 반드시 일치** |

**dev 검증 결과**
- `embed_report`: report 578 → 69청크, unchanged-skip / force-replace 정상.
- `reindex_embeddings`: 30개 fan-out → 워커 처리 → 438청크.
- 검색: 정확매치 1위(score 1.0), 권한 밖 0건, 하이브리드 RRF 융합.
- API E2E: semantic/hybrid 200, 무인증 401.

---

## 3. 운영 배포 — ✅ 완료 (2026-06-21)

> 폐쇄망 운영서버에 반영 완료. 아래는 수행한 절차 기록(재배포·타 서버 참고용).
> pgvector 확장은 운영 DB 포트 **5433**, Ollama 는 **11435**(기존 ollama 11434 충돌 회피).

1. **운영 pgvector 설치** (폐쇄망 → .deb 반입)
   - 인터넷 PC: `apt-get download postgresql-16-pgvector` (버전·arch 운영과 일치)
   - 중간 윈도우 경유 scp → 운영서버 `sudo dpkg -i …deb`
   - **슈퍼유저로 확장 생성**(앱 DB유저 권한 없을 수 있음):
     `sudo -u postgres psql -p 5433 -d report_automation -c 'CREATE EXTENSION IF NOT EXISTS vector'`
2. **p48 포함 릴리스 배포** — pgvector 미설치 상태로 올리면 마이그레이션 실패=배포 중단.
   (p47 워커는 무관하게 먼저 배포 가능.)
3. **`.env`** — `EMBEDDING_BACKEND=ollama` + `EMBEDDING_MODEL`/`EMBEDDING_DIM`을 운영
   Ollama 설치본에 맞춤(태그·차원 확인 필요. 현재 1024 가정).
4. **`reindex_embeddings` 1회 실행** → live 792개 임베딩.
5. worker systemd 유닛 — ✅ `deploy.sh setup_worker` 로 자동 연동·enable(완료).
   orphan-cleanup 타이머 — ⚠️ **아직 deploy.sh 미연결**(남은 작업, §2 핸들러 표 참조).

---

## Phase 2 — MCP 하이브리드화 (완료)

- ✅ `mcp_server/server.py` `search_reports` → `/api/reports/search/semantic?mode=hybrid`
  호출로 변경. MCP로 붙는 외부 AI(Claude/Codex/Gemini)가 키워드+의미 검색 결과를 받음.
- ✅ `get_report` 변경 불필요(상세 반환은 그대로, search 결과의 report_id 사용).
- 안전장치: `embedding_hybrid_min_score`(기본 0.2)로 약한/mock/미임베딩 시맨틱이 키워드
  결과를 오염시키지 않음 → 임베딩 없거나 운영 미설정 상태에서도 키워드로 안전 degrade.
- **검색 + 읽기 가시성 = 사용자 중심·게시누수 제외**(`all_visible_report_ids` =
  `grants.visible_ids_for_user` ∪ 소유). 웹 브라우징 *목록*은 활성 ws 기준이지만,
  MCP/검색·**단일 읽기(can_read_report)**는 활성 ws에 좌우되면 안 됨(MCP가 personal-*
  보내면 부서 콘텐츠 다 놓침). 원칙: **"내 공간 + 내가 올린 것 + 내가 속한 부서 +
  각 부서 공개설정에 내가 포함됐는지"**.
  - **핵심**: 게시(mount) 자동 부서 grant 의 상위→하위 누수 *제외* — dx 부문 게시판에
    *게시만* 된 글은 dx 비멤버인 깊은 하위팀원에게 안 보인다(dx 직접 멤버면 보임).
  - `can_read_report`: 활성-ws can_view 실패 시 이 사용자 중심 집합으로 fallback
    (public_viewer 제외). 하이브리드 키워드 절반도 같은 스코프.
  - 검증: user4(비-dx멤버) → 184 숨김(get_report 403, 검색 제외)·자기부서 15/15·내가
    올린 것 30/30 포함. user1(dx 멤버) → 184 보임(200).
  - ⚠️ 시행착오: 처음 membership_reach 기반으로 넓혔다가 게시누수(184가 하위팀에 노출)로
    되돌리고 visible_ids_for_user 로 정착.
- (선택, 미착수) 프론트 `SearchPage`에 "의미 검색" 토글 — dev(mock)에선 의미검색 효과를
  눈으로 검증 불가(키워드로 보임)라 실 임베딩 가동 후 붙이는 게 검증에 유리.

## 4. 다음 단계

> 갱신 2026-07-17 — Phase 3·4 는 완료됐다. 아래는 **실제 잔여만** 남긴 것.

- ~~**Phase 3** — B300 LLM 연결 → RAG Q&A~~ → **완료**(`/api/ai/ask`, `qa.py`).
  그 위에 지능화 로드맵 1~7 (재랭킹·HyDE·질문분해·별칭확장·집계라우팅·근거검증·다중홉·
  랭킹신호·피드백·평가) 까지 v0.87~v0.102 로 릴리스.
- **Phase 4 잔여** — 자동 요약(`summarize_report`)·다중홉 에이전트·대화형은 완료.
  **아직 없음: 보고서 비교 · 작성 보조 · FMEA 위젯**(FMEA 전용 UI).
  ✅ **관련 보고서 추천(2026-07-18)** — FMEA 킬러 엔진(벡터 유사도)을 범용으로 먼저 구현.
  `GET /api/reports/{id}/related`(semantic_search 재사용·자기제외·가시성) + 보고서 상세
  「관련 보고서」패널. FMEA 위젯이 생기면 같은 엔진을 얹으면 됨.
- ~~(선택) 프론트 검색 UI 시맨틱 토글~~ → **완료**(SearchPage 모드 선택).
- ✅ **운영 활성화(2026-07-18).** 지능화 검색(재랭킹·HyDE·질문분해·별칭확장·집계라우팅·
  근거검증·최신성/권위)을 운영 서버 관리자 → AI설정 → **검색 튜닝** 탭에서 켰다. 이전엔
  코드·배선만 있고 `app_settings` override 0건이라 전부 off 였다(dev 는 여전히 기본 off —
  실 검증은 운영에서). `[일부] AI검색_지능화_로드맵_설계.md` §9 "토글 기본값 결정"은 운영
  체감으로 확정하는 단계. (켠 노브 세부는 운영 `app_settings` 기준.)
- ⚠️ **orphan-cleanup systemd 타이머가 `deploy.sh` 에 미연결** — 핸들러·템플릿은 있으나
  타이머를 렌더/enable 하는 코드가 없어 운영에서 자동 실행 안 됨(`setup_worker` 패턴 복제 필요).

---

## 5. 마이그레이션 체인

`… → p46 → p47(jobs) → p48(report_chunks)`. 단일 head = `p48_report_chunks`.
p47은 pgvector 무관, p48은 pgvector 확장 필요.
