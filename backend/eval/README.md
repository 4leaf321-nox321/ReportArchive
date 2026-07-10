# RAG 검색 평가 (로드맵 7 — 평가 하네스)

검색·답변 튜닝이 실제로 나아졌는지 **측정**하는 골든셋 러너. 임계·설정·로직을
바꾼 뒤 재실행해 점수를 비교한다(감 튜닝 종식).

## 골든셋 만들기

`golden_qa.example.json` 을 `golden_qa.json` 으로 복사하고, **이 배포의 실제
질문**과 **정답 보고서 id** 로 채운다. (report_id 는 배포마다 다르므로 example 의
숫자는 그대로 쓰면 안 된다.) 실제 사용 로그의 질문·클릭을 골든셋으로 승격하면 가장 좋다.

케이스 필드:
- `query`: 질문
- `expect_report_ids`: 근거로 나와야 하는 보고서 id(정답)
- `expect_entities`(선택): 질문이 다뤄야 할 씨앗 객체 값(질문→씨앗 링킹 평가)
- `graph`(선택): 이 케이스만 그래프 모드로

## 실행 (운영에서 — 임베딩/LLM 백엔드 켜진 곳)

```
python scripts/eval_rag.py --user 2 --k 5
python scripts/eval_rag.py --user 2 --k 5 --graph --rerank   # 설정 조합 비교
python scripts/eval_rag.py --user 2 --json before.json       # 튜닝 전 저장
# ... 임계/설정 바꾼 뒤 ...
python scripts/eval_rag.py --user 2 --json after.json        # 튜닝 후 비교
```

- `--user`: 그 사람이 볼 수 있는 보고서 기준(가시성 스코프)으로 평가.
- 지표: `recall@k`(정답 중 top-k 에 든 비율), `precision@k`, `MRR`(첫 정답 역순위),
  `seed_recall`(질문→객체 링킹 적중).

> dev 는 임베딩/LLM 이 mock 이라 검색이 결정적이지 않다 → 숫자는 **운영에서만** 유의미.
> 지표 계산 로직 자체는 tests/test_eval.py 로 검증한다.
