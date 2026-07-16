"""커넥터 스키마 — 데이터소스 등록/응답 + config(커넥션 + 스트림들).

한 시스템(커넥션: base_url·인증)을 한 번 등록하고, 그 아래 여러 스트림(엔드포인트→축
매핑)을 둔다. "지금 동기화" 한 번에 모든 스트림이 순서대로 실행돼 여러 축을 채운다.

시크릿(connection.auth.token/password)은 응답에서 마스킹(has_secret 플래그)하고, 갱신 시
빈 값이면 기존 시크릿을 보존한다. 구(舊) 플랫 config(소스=축 1개)는 서비스에서 새 구조로
자동 정규화(하위호환).
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


class AuthConfig(BaseModel):
    """외부 API 인증. token/password 는 시크릿(응답 시 마스킹)."""
    type: Literal["none", "bearer", "api_key", "basic"] = "none"
    token: str = ""                 # bearer/api_key 시크릿
    header: str = "X-API-Key"       # api_key 를 실을 헤더 이름
    username: str = ""              # basic
    password: str = ""              # basic 시크릿


class RelationMapItem(BaseModel):
    """관계 매핑 — 레코드의 한 필드(path)를 대상 축 객체와의 관계로 잇는다.
    imported 객체=src, 그 필드 값으로 target_type 축에서 찾은 객체=dst."""
    relation: str          # 관계 slug (relation_types)
    target_type: str       # 대상 축 slug
    path: str              # 레코드 내 필드 경로(점 표기, 예 supplier.code)
    match_key: Literal["value", "code"] = "value"  # 대상 찾는 기준(이름/코드)


class ConnectionConfig(BaseModel):
    """시스템 접속 — 여러 스트림이 공유. base_url·인증·공통 헤더."""
    base_url: str = ""
    auth: AuthConfig = Field(default_factory=AuthConfig)
    headers: dict[str, str] = {}


class StreamConfig(BaseModel):
    """엔드포인트 1개 → 온톨로지 축 1개 매핑. 커넥션 아래 여러 개를 둔다."""
    label: str = ""                                # 표시용(선택)
    endpoint_path: str = ""
    http_method: Literal["GET", "POST"] = "GET"
    query: dict[str, str] = {}
    records_path: str = ""                         # 응답 내 레코드 배열 위치(점 표기)
    target_type_id: int = 0                        # 대상 축
    match_key: Literal["value", "code"] = "value"  # v1 은 value(이름) 매칭만 실사용
    value_path: str = ""                           # 레코드 내 값(이름) 경로
    code_path: str = ""                            # (v1.1) 코드 매칭용
    property_map: dict[str, str] = {}              # 속성 slug → 필드 경로
    relation_map: list[RelationMapItem] = []
    # 페이지네이션 (v3) — 응답이 여러 페이지로 나뉠 때. none=단일 요청.
    #   next_url(v3.1): 응답의 next_url_path 가 가리키는 "완전한 다음 URL"을 따라간다
    #   (OData @odata.nextLink·GitHub next 등). 파라미터 조립 대신 그 URL 을 그대로 요청.
    page_style: Literal["none", "offset", "page", "cursor", "next_url"] = "none"
    page_size: int = 100
    page_param: str = "offset"                     # offset 오프셋 / page 페이지번호 파라미터명
    size_param: str = "limit"                      # 페이지 크기 파라미터명
    cursor_path: str = ""                          # cursor: 응답 내 다음 커서 위치(점표기)
    cursor_param: str = "cursor"                   # cursor: 커서를 실어보낼 파라미터명
    next_url_path: str = ""                        # next_url: 응답 내 다음 URL 위치(예 @odata.nextLink)
    #   skip_on_error(자동 스킵): offset 페이지네이션에서 어떤 페이지가 서버 오류로
    #   중간에 실패하면(부분 데이터+오류), 받은 만큼은 취하고 실패한 레코드 1건을
    #   건너뛰어 계속 가져온다. 특정 레코드가 서버 직렬화를 깨뜨릴 때 그 하나만
    #   희생하고 나머지를 살린다(건너뛴 수는 로그로 남김). offset 스타일에서만 동작.
    skip_on_error: bool = False
    # 증분(watermark) (v3) — 마지막 동기화 이후 바뀐 것만.
    incremental: bool = False
    watermark_field: str = ""                      # 레코드의 변경 기준 필드(예: updatedAt)
    watermark_param: str = ""                      # since 를 실어보낼 파라미터명(예: updated_since / $filter)
    #   watermark_template(v3.1): 값에 식이 필요한 API(OData 등)용. {since}·{field} 치환.
    #   예: "$filter" 파라미터에 "Modified gt {since}". 비면 값=since 그대로.
    watermark_template: str = ""


class SourceConfig(BaseModel):
    """데이터소스 config — 커넥션 1개 + 스트림 여러 개."""
    connection: ConnectionConfig = Field(default_factory=ConnectionConfig)
    streams: list[StreamConfig] = []


class DataSourceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kind: Literal["rest_json"] = "rest_json"
    enabled: bool = True
    config: SourceConfig
    schedule_kind: Literal["manual", "interval"] = "manual"
    interval_minutes: Optional[int] = Field(default=None, ge=1)


class DataSourceUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    enabled: Optional[bool] = None
    config: Optional[SourceConfig] = None
    schedule_kind: Optional[Literal["manual", "interval"]] = None
    interval_minutes: Optional[int] = Field(default=None, ge=1)


class DataSourceRead(BaseModel):
    id: int
    name: str
    kind: str
    enabled: bool
    config: SourceConfig
    has_secret: bool
    schedule_kind: str
    interval_minutes: Optional[int]
    next_run_at: Optional[datetime]
    last_run_at: Optional[datetime]
    last_status: Optional[str]
    created_at: datetime
    updated_at: datetime


class DataSourceListResponse(BaseModel):
    items: list[DataSourceRead]


class SyncRunRead(BaseModel):
    id: int
    source_id: int
    status: str
    triggered_by: str
    summary: Optional[dict]
    error: Optional[str]
    started_at: datetime
    finished_at: Optional[datetime]


class SyncRunListResponse(BaseModel):
    items: list[SyncRunRead]


class ProbeRequest(BaseModel):
    """저장 전 매핑 UI 용 — 커넥션 + 스트림 1개로 실제 응답을 받아 레코드 샘플(필드명
    확인용)을 돌려준다. 쓰기 없음.

    source_id: 이미 저장된 소스를 편집 중일 때 그 id. 커넥션 시크릿(토큰/비번)은
    응답에서 마스킹돼 프론트에 없으므로, 비어 있으면 서버가 이 id 로 저장된 시크릿을
    채워 프로브한다(재입력 불필요). 사용자가 새 값을 입력했으면 그 값이 우선."""
    connection: ConnectionConfig
    stream: StreamConfig
    source_id: Optional[int] = None


class SuggestMappingRequest(BaseModel):
    """AI 자동 매핑 — 조회한 샘플 + 대상 축으로 매핑 초안을 제안받는다.

    samples/fields 는 probe 응답을 그대로 넘기면 된다. 1건만 보내면 그 레코드에서
    null 인 navigation($expand 된 product 등)을 AI 가 아예 못 본다.
    """
    target_type_id: int
    sample: dict = {}                  # 구버전 호환(1건). samples 가 있으면 무시.
    samples: list[dict] = []           # probe 의 sample (5건)
    fields: list[str] = []             # probe 가 전체 스캔해 모은 경로 목록
