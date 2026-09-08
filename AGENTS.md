# AGENTS.md — 이 레포에서 일하는 에이전트용 (짧은 불변식)

- **읽기 전용은 설계 불변식이다.** 비-GET은 인증·본문 파싱 이전에 405
  (`Allow: GET`). `wallet.js`나 원장 쓰기 경로를 import하지 않는다. 쓰기
  엔드포인트 재도입 제안은 거절 대상(HANDOFF 관련 논의 없이는).
- `src/vocabulary/`(economy-breakdown.js, txLabel.js)는 운영 모노레포
  coin-bridge-bot의 **동기화 사본**이다. 정의 변경은 봇 쪽에서 먼저 하고
  byte-for-byte 복사 — 사본 독자 수정 금지(헤더의 SYNCED COPY 참고).
- 테스트는 무DB로 유지한다(fake pool). `npm test` = node --test.
- 인증 키·DSN·시크릿을 커밋하지 않는다. `.env.example`만 플레이스홀더.
- `openapi.yaml`과 `README.md`의 엔드포인트·응답 형태는 `src/server.js`와
  일치해야 한다. 서버를 바꾸면 둘 다 갱신.
- 에러 모델: 401/429/5xx는 인증 후, 404는 비즈니스 결과, 비-GET 405는 인증
  이전. 이 순서를 바꾸면 클라이언트 계약이 깨진다.
- 이 레포의 README 산문은 친절한 해요체(별도 지시 없으면 무조건). 표·코드·
  openapi.yaml은 예외.
- 커밋: Conventional Commits. 브랜치: `<type>/<slug>`.
