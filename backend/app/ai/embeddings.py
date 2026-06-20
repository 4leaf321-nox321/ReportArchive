"""임베딩 클라이언트 — 백엔드 추상화 (ollama | mock).

`embed_texts(texts) -> list[vector]` 한 함수로 통일. 운영은 호스트 Ollama 를
호출하고, 개발/테스트는 mock(텍스트 해시 → 결정적 단위벡터)으로 Ollama 없이
전체 파이프라인(청크→임베딩→저장→하이브리드 검색)을 검증한다. 차원은
settings.embedding_dim 으로 고정되며 report_chunks.embedding 컬럼과 일치해야 한다.

env(.env):
    EMBEDDING_BACKEND = ollama | mock      (기본 mock)
    OLLAMA_BASE_URL    = http://localhost:11434
    EMBEDDING_MODEL    = bge-m3 등
    EMBEDDING_DIM      = 1024
"""
from __future__ import annotations

import hashlib
import struct

import httpx

from app.config import settings


class EmbeddingError(RuntimeError):
    """임베딩 생성 실패(백엔드 오류·차원 불일치 등). 핸들러에서 잡으면 큐가 재시도."""


# --- mock 백엔드 -----------------------------------------------------------
def _mock_vector(text: str, dim: int) -> list[float]:
    """텍스트 해시로부터 결정적 단위벡터 생성. 같은 텍스트 → 같은 벡터.

    의미적 유사도는 보장하지 않는다(플러밍 검증용). 시드를 반복 해싱해 dim 개
    float 를 채우고 L2 정규화한다.
    """
    vals: list[float] = []
    h = hashlib.sha256(text.encode("utf-8")).digest()
    while len(vals) < dim:
        h = hashlib.sha256(h).digest()
        for i in range(0, len(h), 4):
            if len(vals) >= dim:
                break
            (u,) = struct.unpack("<I", h[i : i + 4])
            vals.append((u / 4294967296.0) * 2.0 - 1.0)  # [-1, 1)
    norm = sum(v * v for v in vals) ** 0.5 or 1.0
    return [v / norm for v in vals]


def _embed_mock(texts: list[str], dim: int) -> list[list[float]]:
    return [_mock_vector(t, dim) for t in texts]


# --- ollama 백엔드 ---------------------------------------------------------
def _embed_ollama(texts: list[str], dim: int) -> list[list[float]]:
    """호스트 Ollama 의 임베딩 API 호출. 신형 /api/embed(배치) 우선, 구형
    /api/embeddings(단건) 폴백."""
    base = settings.ollama_base_url.rstrip("/")
    model = settings.embedding_model
    timeout = settings.embedding_timeout_s

    try:
        # 신형: 배치 input → {"embeddings": [[...], ...]}
        resp = httpx.post(
            f"{base}/api/embed",
            json={"model": model, "input": texts},
            timeout=timeout,
        )
        if resp.status_code == 404:
            raise _UseLegacy()
        resp.raise_for_status()
        embs = resp.json().get("embeddings")
        if not embs:
            raise EmbeddingError("ollama /api/embed 가 embeddings 를 반환하지 않음")
    except _UseLegacy:
        embs = []
        for t in texts:
            r = httpx.post(
                f"{base}/api/embeddings",
                json={"model": model, "prompt": t},
                timeout=timeout,
            )
            r.raise_for_status()
            e = r.json().get("embedding")
            if not e:
                raise EmbeddingError("ollama /api/embeddings 가 embedding 을 반환하지 않음")
            embs.append(e)
    except httpx.HTTPError as exc:
        raise EmbeddingError(f"ollama 호출 실패: {exc}") from exc

    for e in embs:
        if len(e) != dim:
            raise EmbeddingError(
                f"임베딩 차원 불일치: 모델 {len(e)} != 설정 EMBEDDING_DIM {dim}. "
                f"config.embedding_dim 과 마이그레이션 벡터 차원을 모델에 맞추세요."
            )
    return embs


class _UseLegacy(Exception):
    pass


# --- 공개 API --------------------------------------------------------------
def embed_texts(texts: list[str]) -> list[list[float]]:
    """텍스트 리스트 → 임베딩 벡터 리스트(입력 순서 보존)."""
    if not texts:
        return []
    dim = settings.embedding_dim
    backend = (settings.embedding_backend or "mock").lower()
    if backend == "mock":
        return _embed_mock(texts, dim)
    if backend == "ollama":
        return _embed_ollama(texts, dim)
    raise EmbeddingError(f"알 수 없는 EMBEDDING_BACKEND: {backend!r} (ollama|mock)")


def embed_one(text: str) -> list[float]:
    """단건 임베딩(검색 질의용)."""
    return embed_texts([text])[0]
