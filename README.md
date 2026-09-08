# Fullmoon Economy API

풀문(Fullmoon) 네트워크 경제 서버의 **PostgreSQL 원장을 읽는** HTTP API예요. 다른
디스코드 봇과 대시보드가 잔액·거래·랭킹·집계를 조회할 수 있어요.

**읽기 전용이에요.** 2026-07-12부로 `/v1/grant`, `/v1/revoke`, `/v1/transfer`,
설정 쓰기(`PUT`/`DELETE /v1/config/:key`)가 전부 제거됐어요. 돈을 움직이는 주체는
코인브릿지 봇과 마크 플러그인 둘뿐이에요.

```
 코인브릿지 봇 ──직접 SQL──┐
 MC plugin      ──직접 SQL──┤→  PostgreSQL (단일 진실 원천)
                            │   accounts / balances / transactions
 외부 봇·대시보드 ── HTTP(GET) ──→ economy-api ──읽기만──┘
```

## 왜 읽기 전용인가요?

이 서비스는 nginx를 통해 `https://api.fullmoon.ink/economy/`로 **인터넷에
공개돼 있어요**. 쓰기 엔드포인트가 살아 있던 동안은 베어러 키 하나가 곧 조폐권
이었어요 — 키가 새면 원장이 샜겠죠. 경제의 주인이 한 명인 이상 그 위험을 감수할
이유가 없어요. 지금은 키가 새도 새는 건 읽기뿐이에요.

프로세스 안에도 쓰기 경로가 남아 있지 않아요: `wallet.js`를 import하지 않고,
GET이 아닌 요청은 인증·본문 파싱 이전에 **405**로 끊겨요.

```
$ curl -X POST https://api.fullmoon.ink/economy/v1/grant
405 {"ok":false,"error":"economy-api is read-only — grant/revoke/transfer and
     config writes were removed on 2026-07-12", ...}
```

## 실행

```bash
cp .env.example .env   # DATABASE_URL, ECONOMY_API_CLIENTS를 채워요
npm install
npm start              # 기본 127.0.0.1:8790이에요
```

systemd 유닛과 nginx 설정은 운영 인프라에서 관리해요. 이 레포는 서비스 소스와
테스트를 담아요.

### 외부 노출

서버는 `127.0.0.1`에만 바인딩해요. 공개 접근은 nginx가 TLS를 끊고 `/economy`
경로로 리버스 프록시하는 경로 **하나뿐**이에요:

| | |
|---|---|
| 공개 base URL | `https://api.fullmoon.ink/economy` |
| 내부 | `http://127.0.0.1:8790` |
| nginx | `location /economy/` (운영 인프라에서 관리) |

`proxy_pass`의 끝 슬래시가 `/economy` 프리픽스를 벗겨내므로
`/economy/v1/overview` → `/v1/overview`로 도달해요.

nginx의 IP당 10 req/s(burst 40) 제한은 **앱 리미터가 못 막는 구간**을 막아요 —
앱 리미터는 클라이언트 이름으로 세기 때문에 인증에 실패한 요청은 아예 세지
않거든요.

## 인증

`Authorization: Bearer <key>` 형식이에요. 클라이언트 정의는 `ECONOMY_API_CLIENTS`(JSON):

```json
[{ "name": "lisybot", "key": "<32+자 랜덤>" }]
```

스코프는 없어요 — 인증된 클라이언트는 모든 읽기 엔드포인트를 쓸 수 있어요. 키가
주는 권한은 "잔액을 볼 수 있다" 하나뿐이거든요. 예전 레지스트리의 `scopes`/
`source` 필드는 **무시하고 경고만** 남겨요(부팅은 돼요).

레이트리밋: 클라이언트당 기본 60req/10s (env로 조정해요).

## 엔드포인트

전부 `GET`이에요. 다른 메서드는 경로와 무관하게 405 (`Allow: GET`)가 돌아와요.

### `GET /v1/health` — 무인증
`{ ok, service, readOnly: true }`

### `GET /v1/accounts/:discordId`
`{ ok, discordId, balance, linked, mcUsername }` · 계정이 없으면 404예요

### `GET /v1/accounts/:discordId/transactions?limit=10` (limit ≤ 50)

### `GET /v1/accounts/by-mc/:username`
런처·게임 클라이언트용이에요 — Discord id 대신 **MC 사용자명**으로 읽어요. 연동된
계정(가장 최근 연동) 하나를 돌려줘요.

```json
{ "ok": true,
  "wallet": { "currency": "원", "balance": 1234, "updatedAt": "..." },
  "transactions": [{ "delta": 5, "reason": "economy.playtime", "label": "플레이타임", "balanceAfter": 1234, "at": "..." }] }
```

`label`은 원장 vocabulary가 붙여주는 한글 표시명이에요(`src/vocabulary/txLabel.js`
— 운영 봇과 동기화된 사본이에요). 연동 계정이 없으면 404가 돌아와요.

### `GET /v1/leaderboard?limit=10` (limit ≤ 50)

### `GET /v1/config`
공유 밸런스 파라미터(`economy_config`) 전체예요.
`{ ok, config: [{ key, value, description, updatedBy, updatedAt }] }`

봇들은 하드코딩/env 대신 이 값을 참조해서 자기 UI 숫자를 맞춰요. 잘 알려진 키:

| key | 의미 |
|---|---|
| `reward.multiplier` | 전 봇 공통 활동 보상 배수예요 |
| `faucet.daily_cap` | 공유 파우셋 캡이에요 — wallet 캡 게이트가 직접 이 값을 읽어요 |
| `daily.amount` / `daily.streak_bonus` / `daily.streak_max_days` | /출석 파라미터예요 |

값을 **바꾸는** 건 운영자가 코인브릿지 봇 쪽에서 해요. 읽는 쪽은 30초 캐시를
권장해요.

### `GET /v1/overview`
대시보드 헤드라인이에요. 봇의 `/경제현황`과 **동일한 분류 SQL**(공유 상수
`TX_FILTERS`)을 사용하므로 수치가 어긋날 수 없어요.
```json
{ "ok": true, "totalSupply": 5000, "accounts": 42,
  "today": { "mint": 300, "burn": -120, "casinoNet": -45, "auctionNet": -8, "dropNet": 0, "shopNet": -60, "transferTax": 5, "net": 67 },
  "bySource": [{ "source": "plugin:survival", "faucet": 200, "sink": 0, "net": 200 }] }
```

### `GET /v1/stats/daily?days=14` (days ≤ 90)
일별 시계열이에요: `{ date, mint, burn, casinoNet, auctionNet, dropNet, shopNet, net, activeAccounts }[]` — 그래프용이에요.

### `GET /v1/transactions/recent?limit=20` (limit ≤ 100)
전역 거래 피드(계정 정보 조인)예요 — 라이브 피드/감사 뷰용이에요. 폴링 권장 주기는
5초 이상이에요.

### `GET /v1/casino/today`
`casino_ledger` 오늘 스냅샷이에요: 게임별 `{ game, wagered, paidOut, netBurn }`.

## 클라이언트 구현 메모 (다른 봇 개발자에게)

- 잔액을 로컬에 캐시하지 마세요. 표시 직전에 읽어 주세요 — 그 값을 바꾸는 건
  여러분 프로세스가 아니므로, 캐시는 반드시 틀려져요.
- 자기 경제 DB/화폐를 새로 만들지 마세요 — 그 순간 단일 진실 원천이 깨져요.
- 재화를 지급해야 하는 기획이 있으면 API를 뚫으려 하지 말고 운영자에게 말해
  주세요. 지급 경로는 봇/플러그인 안에 있어요.

```js
// 예: 다른 봇에서 잔액 표시
const res = await fetch(`https://api.fullmoon.ink/economy/v1/accounts/${userId}`, {
  headers: { authorization: `Bearer ${KEY}` },
});
const body = await res.json();
reply(body.ok ? `잔액 ${body.balance}` : '아직 지갑이 없어요');
```

[fullmoon-sdk](https://github.com/Fullmoon-OSS/fullmoon-sdk)의 `economyClient.js`가
이걸 감싼 공식 클라이언트예요(의존성 없음).

## 동기화 메모 (운영자용)

`src/vocabulary/`는 운영 모노레포의 `coin-bridge-bot` 소스에서 **동기화한 사본**
이에요. 정식 출처는 그쪽이고, 이 레포는 외부 공개용 홈이에요. vocabulary를 바꿀
때는 봇 쪽에서 고치고 이곳으로 byte-for-byte 복사해 주세요(파일 상단의 SYNCED
COPY 헤더를 참고하세요).

## 테스트

```bash
npm test   # DB 불필요 — fake pool로 HTTP 전면 검증해요 (405 벽 포함)
```

## 기계 가독 명세

[`openapi.yaml`](./openapi.yaml)(OpenAPI 3.1) — 모든 엔드포인트·응답 형태·에러
의미의 기계 판독용 계약이에요. LLM 에이전트나 코드 생성 도구, Swagger UI가 이걸
읽으면 됩니다. 사람용 상세 설명은 위 README가 담당해요.
