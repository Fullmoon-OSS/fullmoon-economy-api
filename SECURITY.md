# Security Policy (보안 정책)

풀문 생태계에 취약점을 발견하셨나요? 공개 Issue에 올리지 말고
풀문 네트워크 디스코드 운영진에게 직접 알려주세요.

- 최대한 빨리 확인하고 수정해요.
- 수정 전에는 세부사항을 비공개로 유지해요.

## 지원 범위

- fullmoon-economy-api (읽기 전용 경제 API)
- fullmoon-sdk (공식 클라이언트)
- fullmoon-modules (이 카탈로그 사이트)

## 알려진 설계 상태

- 이 사이트는 정적이고 데이터는 레지스트리 JSON 하나예요. 렌더러는 모든
  문자열을 escape하고 https 링크만 허용해요.
- 경제 API는 읽기 전용이라 유출 가능한 쓰기 권한이 없어요 (키 = 읽기).

자세한 정책: [fullmoon-docs/docs/policies.md](https://github.com/Fullmoon-OSS/fullmoon-docs/blob/main/docs/policies.md)
