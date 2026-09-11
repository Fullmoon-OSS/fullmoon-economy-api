# Security Policy (보안 정책)

풀문 생태계에 취약점을 발견하셨나요? 공개 Issue에 올리지 말고
풀문 네트워크 디스코드 운영진에게 직접 알려주세요.

- 최대한 빨리 확인하고 수정해요.
- 수정 전에는 세부사항을 비공개로 유지해요.

## 지원 범위

- fullmoon-economy-api (읽기 전용 경제 API)
- fullmoon-sdk (공식 클라이언트)
- fullmoon-economy-api (이 저장소 — 읽기 전용 API 서버예요)

## 알려진 설계 상태

- 이 서버는 SELECT만 실행해요. 비-GET 요청은 인증 전에 405로 끊기고, 원장을
  쓰는 경로가 코드에 없어요.
- 경제 API는 읽기 전용이라 유출 가능한 쓰기 권한이 없어요 (키 = 읽기).

자세한 정책: [fullmoon-docs/docs/policies.md](https://github.com/fullmoon-network/fullmoon-docs/blob/main/docs/policies.md)
