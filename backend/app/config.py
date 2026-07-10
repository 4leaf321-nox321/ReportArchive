"""
Application configuration.

Uses pydantic-settings to read environment variables and .env values.
Cross-platform: paths are resolved with pathlib so the same code runs
on Windows / Linux / macOS without changes.
"""
from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import List, Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_ROOT.parent


class Settings(BaseSettings):
    """Single source of truth for runtime configuration."""

    model_config = SettingsConfigDict(
        env_file=str(BACKEND_ROOT / ".env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- App ---
    app_env: str = Field(default="development")
    app_name: str = Field(default="ReportArchive")
    app_host: str = Field(default="0.0.0.0")
    app_port: int = Field(default=3000)

    # --- Security ---
    secret_key: str = Field(default="dev-secret-key-change-me")
    jwt_secret_key: str = Field(default="dev-jwt-secret-key-change-me")
    jwt_access_token_expires_hours: int = Field(default=12)
    jwt_refresh_token_expires_days: int = Field(default=30)

    # --- External connectors (외부 시스템 연계) ---
    # 커넥터가 outbound 요청을 보낼 수 있는 호스트 allowlist(쉼표 구분). 비어 있으면
    # 모든 호스트 허용(사내 사설 IP 대상이 정상 용도라 기본은 비어 있음). 운영에서
    # SSRF 를 좁히려면 대상 시스템 호스트만 나열한다. http/https 스킴은 항상 강제.
    connector_allowed_hosts: str = Field(default="")

    # --- Database ---
    database_url: str = Field(
        default="postgresql+psycopg://postgres:postgres@localhost:5432/report_automation"
    )
    test_database_url: Optional[str] = Field(default=None)
    sqlalchemy_echo: bool = Field(default=False)

    # --- CORS ---
    cors_origins: str = Field(
        default="http://localhost:3000,http://localhost:3001"
    )

    # --- Frontend serving (combined deployment) ---
    serve_frontend_dist: str = Field(default="")

    # --- File uploads ---
    upload_dir: str = Field(default="uploads")
    upload_max_bytes: int = Field(default=25 * 1024 * 1024)  # 25 MB
    # CAD models (GLB/STL/STEP/...) routinely exceed the general image
    # limit. The files route detects CAD extensions and applies this
    # cap instead. Phase-1 default of 200 MB matches the realistic
    # ceiling for a mid-size assembly export.
    upload_max_bytes_cad: int = Field(default=200 * 1024 * 1024)
    # Video uploads (mp4 / webm / mov / ...). Bigger than CAD because
    # demo clips + screen captures routinely run into hundreds of MB.
    # Default 1 GB. With streaming writes (routes.upload_file) the
    # server-side memory cost stays bounded regardless of file size —
    # the reverse-proxy `client_max_body_size` is the other knob that
    # needs to match (see 그래프정보.md / deployment docs).
    upload_max_bytes_video: int = Field(default=1024 * 1024 * 1024)

    # --- HTML embed bundles (폴더 임베드) ---
    # 메인 HTML + 서브 파일(json/js/이미지)을 폴더 구조 그대로 올려 sandbox
    # iframe 으로 서빙한다(HTML임베드_번들_설계.md). file 업로드와 별도 저장소.
    embed_bundles_dir: str = Field(default="embed_bundles")
    # 번들 1개 합계 상한(기본 1GB — 영상 등 큰 자산 포함). reverse-proxy 의
    # client_max_body_size 와 맞춰야 함.
    embed_max_bytes: int = Field(default=1024 * 1024 * 1024)
    # 번들 1개 파일 수 상한 — 폴더 통째 업로드 시 폭주 방지.
    embed_max_files: int = Field(default=2000)

    # --- AI / 임베딩 (RAG 발판) ---
    # 임베딩 백엔드: "ollama"(운영 — 호스트 Ollama 호출) | "mock"(개발/테스트 —
    # Ollama 없이 텍스트 해시로 결정적 벡터). 폐쇄망 운영서버엔 Ollama+E5 가 이미
    # 설치돼 있다는 전제. 백엔드 추상화로 같은 코드가 양쪽에서 돈다.
    embedding_backend: str = Field(default="mock")
    ollama_base_url: str = Field(default="http://localhost:11434")
    # Ollama 임베딩 모델 태그(운영 설치본에 맞춰 .env 로 지정). 예: bge-m3,
    # multilingual-e5-large 계열.
    embedding_model: str = Field(default="bge-m3")
    # 벡터 차원 — report_chunks.embedding 컬럼 크기와 *반드시* 일치해야 한다.
    # E5-large/bge-m3 = 1024. 모델 바꾸면 마이그레이션도 같이 바꿔야 함.
    embedding_dim: int = Field(default=1024)
    # 임베딩 호출 타임아웃(초).
    embedding_timeout_s: float = Field(default=30.0)
    # 하이브리드 검색에서 벡터 결과를 받아들일 최소 코사인 유사도(0~1). 약한
    # 매치·mock(미설정 운영)·미임베딩 상태가 키워드 결과를 오염시키지 않도록 한다.
    # 실제 E5/bge-m3 의 "관련 있음"은 보통 0.3+ 라 0.2 면 노이즈만 걸러진다.
    embedding_hybrid_min_score: float = Field(default=0.2)
    # 자동태깅 유사도 추천의 최소 코사인 점수(엔티티 값 ↔ 보고서 청크). 검색용
    # hybrid 임계(0.2)보다는 높고, 짧은 값↔청크라 0.55 면 실제 관련 항목(bge-m3
    # 기준 ~0.43–0.50)도 거의 다 걸러진다 → 0.45 로 둬 의미 있는 후보가 뜨게 한다.
    # 제안은 검토 후 수락(기본 미선택)이라 약간의 노이즈는 안전.
    embedding_suggest_min_score: float = Field(default=0.45)
    # 청크↔객체 L1 링크(임베딩 유사도)의 최소 코사인 점수. suggest(0.45)와 달리
    # 이 링크는 사람 검토 없이 AI 검색 근거로 바로 쓰이므로 더 엄격하게 둔다(정밀
    # 우선). L0(정확 매칭)가 확실한 건 이미 잡으므로 L1 은 "의미 보강"만 하면 된다.
    chunk_link_min_score: float = Field(default=0.5)
    # 청크당 L1 링크 상한(점수 높은 순 top-K). 한 문단이 느슨하게 여러 객체에 붙어
    # 검색을 오염시키지 않게 최악의 경우를 묶는다. L0 링크는 이 상한과 무관(합집합).
    chunk_link_max_per_chunk: int = Field(default=8)
    # 질문→씨앗객체 링킹(GraphRAG 진입점)의 의미검색 최소 코사인. 씨앗은
    # expand_related 로 이웃까지 번지므로 오탐이 증폭된다 → 정밀 우선(0.5).
    # lexical 겹침과 무관하게 전체 엔티티 풀(캐시)과 비교해 의미 씨앗을 찾는다.
    seed_link_min_score: float = Field(default=0.5)
    # RAG Q&A 2차 재랭킹 — 넉넉히 검색한 후보 청크를 생성 LLM 으로 질문 적합도
    # 재채점해 상위만 인용. **기본 OFF**(질문당 LLM 1콜 추가). llm_backend 가 mock
    # 이면 자동 무효. 실패/파싱불가 시 1차 순서 그대로(검색이 죽지 않게).
    rag_rerank_enabled: bool = Field(default=False)
    # 보고서 저장/수정 시 자동으로 embed_report 잡을 적재할지. **기본 OFF** — pgvector
    # 확장·report_chunks·워커가 모두 준비된 환경에서만 켠다(.env 로 true). 안 그러면
    # 임베딩 미배포(p47만 배포 등) 상태에서 실패 잡이 쌓인다.
    embedding_auto_on_save: bool = Field(default=False)

    # --- AI / 생성 LLM (B300 보조 AI — B300_보조AI_설계.md) ---
    # 생성 LLM 백엔드: "openai"(운영 — B300 OpenAI 호환 /v1/chat/completions) |
    # "ollama"(로컬 /api/chat) | "mock"(개발/테스트 — 네트워크 없이 결정적 응답).
    # 임베딩(embedding_*)과는 **별개 자원**(다른 포트·모델·프로세스). 기본 mock 이라
    # .env 로 켜기 전까지 운영 무영향(embedding_backend 와 같은 안전 패턴).
    llm_backend: str = Field(default="mock")
    # openai 백엔드는 base_url 에 **/v1 까지 포함**(예: http://10.198.143.137:10000/v1).
    # ollama 백엔드는 서버 루트(예: http://localhost:11434).
    llm_base_url: str = Field(default="http://localhost:11434")
    # 모델 태그/이름(.env 로 운영 설치본에 맞춤). B300 = GLM-5-2.
    llm_model: str = Field(default="GLM-5-2")
    # OpenAI 호환 서버가 인증을 요구하면 키 지정 → Authorization: Bearer. 비우면 헤더 없음.
    llm_api_key: str = Field(default="")
    # 생성 호출 타임아웃(초). reasoning 모델은 느릴 수 있어 임베딩보다 크게.
    llm_timeout_s: float = Field(default=120.0)
    llm_max_tokens: int = Field(default=1024)
    # GLM reasoning 모델용 chat_template_kwargs.reasoning_effort 기본값(low|medium|high).
    # 빈 값이면 전달하지 않음.
    llm_reasoning_effort: str = Field(default="")
    # 시스템 관리자는 엔티틀먼트(§E) 없이도 B300 기능 사용 가능(테스트·운영 편의). 기본 ON.
    ai_admin_bypass: bool = Field(default=True)
    # 저장 시 자동 요약(B) 전역 스위치 — 임베딩(embedding_auto_on_save)과 독립.
    # 기본 OFF: 켜기 전까지 운영 무영향. 켜져도 작성자 'auto_summary' 엔티틀먼트가
    # 있는 보고서만 실제 요약(핸들러에서 게이트).
    llm_auto_summarize_on_save: bool = Field(default=False)
    # local LLM 보고서 작성(C) 최대 시도 횟수(첫 호출 포함). LLM 이 형식(JSON/위젯)
    # 을 틀리면 에러를 돌려주고 고쳐서 재요청 — 작은 로컬 모델 성공률 보강. 1=재시도
    # 없음. .env(LLM_AUTHOR_MAX_ATTEMPTS)로 조절.
    llm_author_max_attempts: int = Field(default=3, ge=1, le=6)
    # 보고서 작성(C) 전용 토큰 한도 — 보고서 JSON(여러 위젯+긴 본문)은 일반 호출용
    # llm_max_tokens(1024) 로는 쉽게 잘려(finish_reason=length) 미완 JSON → 파싱
    # 실패가 매번 반복된다. 작성은 별도로 크게 잡는다. .env(LLM_AUTHOR_MAX_TOKENS).
    llm_author_max_tokens: int = Field(default=8192, ge=1024)
    # 작성 호출에 JSON 출력 모드 사용(openai=response_format json_object, ollama=
    # format:json). 서버가 거부하면 .env(LLM_AUTHOR_JSON_MODE=false)로 끄고 관대한
    # 파서에 맡긴다. 기본 ON — 형식 일탈을 서버단에서 막는 가장 확실한 수단.
    llm_author_json_mode: bool = Field(default=True)
    # B300 은 폐쇄망 내부 직결 — httpx 가 호스트의 HTTP_PROXY/HTTPS_PROXY env 를 집어
    # 내부 주소까지 프록시로 보내면 404(curl 은 --noproxy 로 우회). 기본 True = 프록시
    # 우회(trust_env=False). 외부 OpenAI 등 프록시 경유가 필요한 환경이면 .env 로 false.
    llm_no_proxy: bool = Field(default=True)

    # --- 이메일 발송 (메일러 — SMTP 클라이언트) ---
    # 플랫폼은 메일 *서버*가 아니라, 기존 SMTP 릴레이에 접속해 나가는 메일만 보낸다.
    # 백엔드: "smtp"(운영 — 실제 발송) | "console"(개발 — 로그만) | "mock"(테스트 —
    # OUTBOX 캡처). 기본 console → **.env 로 켜기 전까지 실제 발송 없음**(llm_backend·
    # embedding_backend 와 같은 안전 패턴). 모든 발송은 send_email 잡으로 큐 경유.
    email_backend: str = Field(default="console")
    # 사내 SMTP 릴레이 주소. 인프라/IT 팀에서 받는다. 비우면 smtp 백엔드라도 발송 불가.
    smtp_host: str = Field(default="")
    smtp_port: int = Field(default=587)
    # TLS 방식: "none"(평문·내부망 릴레이) | "starttls"(587 표준) | "ssl"(465).
    smtp_tls_mode: str = Field(default="starttls")
    # 인증 — 내부 무인증 릴레이면 비워둔다(있으면 LOGIN). 둘 다 있어야 로그인 시도.
    smtp_user: str = Field(default="")
    smtp_password: str = Field(default="")
    smtp_timeout_s: float = Field(default=20.0)
    # 발신 주소 / 회신 주소. 운영에선 사내 정책에 맞는 no-reply 주소로 .env 지정.
    email_from: str = Field(default="ReportArchive <no-reply@reportarchive.local>")
    email_reply_to: str = Field(default="")
    # 메일 본문 링크(비밀번호 재설정 등)의 기준 URL. 비우면 cors_origins 첫 항목 사용.
    app_base_url: str = Field(default="")

    @property
    def email_base_url(self) -> str:
        """메일 링크용 프론트엔드 기준 URL. app_base_url 우선, 없으면 CORS 첫 항목."""
        if self.app_base_url.strip():
            return self.app_base_url.strip().rstrip("/")
        origins = self.cors_origin_list
        return origins[0].rstrip("/") if origins else ""

    @property
    def is_development(self) -> bool:
        return self.app_env.lower() == "development"

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "production"

    @property
    def cors_origin_list(self) -> List[str]:
        if not self.cors_origins.strip():
            return []
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def jwt_access_token_expires(self) -> timedelta:
        return timedelta(hours=self.jwt_access_token_expires_hours)

    @property
    def jwt_refresh_token_expires(self) -> timedelta:
        return timedelta(days=self.jwt_refresh_token_expires_days)

    @property
    def upload_dir_path(self) -> Path:
        """Absolute path to the upload directory; created on first access."""
        candidate = Path(self.upload_dir)
        if not candidate.is_absolute():
            candidate = (BACKEND_ROOT / candidate).resolve()
        candidate.mkdir(parents=True, exist_ok=True)
        return candidate

    @property
    def embed_bundles_dir_path(self) -> Path:
        """Absolute path to the HTML embed bundles directory; created on
        first access. Each bundle lives at {dir}/{bundle_id}/<relpath...>."""
        candidate = Path(self.embed_bundles_dir)
        if not candidate.is_absolute():
            candidate = (BACKEND_ROOT / candidate).resolve()
        candidate.mkdir(parents=True, exist_ok=True)
        return candidate

    @property
    def frontend_dist_path(self) -> Optional[Path]:
        """Resolved absolute path to the frontend dist directory, or None."""
        raw = self.serve_frontend_dist.strip()
        if not raw:
            return None
        candidate = Path(raw)
        if not candidate.is_absolute():
            candidate = (BACKEND_ROOT / candidate).resolve()
        return candidate

    @field_validator("app_env")
    @classmethod
    def _normalize_env(cls, v: str) -> str:
        return v.lower().strip()


settings = Settings()
