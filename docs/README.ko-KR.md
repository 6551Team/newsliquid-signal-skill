# NewsLiquid 시그널 소스 SDK

이 저장소는 App ID/App Secret을 사용해 `NewsItem`을 전송하고 자신의 NewsLiquid 시그널 소스를 수정할 수 있도록 합니다.

저장소 구성:

- `typescript/`: 네이티브 `fetch`를 사용하는 Node.js 18+ SDK
- `python/`: 표준 라이브러리만 사용하는 Python 3.10+ SDK
- `cli/`: 시그널 전송 및 소스 수정용 Rust 명령줄 도구

영문 문서는 [README.md](../README.md)에서 확인할 수 있습니다.

## 시그널 소스 만들기

NewsLiquid에 로그인한 뒤 [전략 페이지](https://app.newsliquid.com/strategy)를 엽니다.

1. “내 시그널 소스” 탭을 열고 “시그널 소스 만들기”를 클릭합니다.
2. 시그널 소스 이름, 설명, 공식 웹사이트를 입력합니다.
3. 공개 여부를 선택합니다. 무료 또는 자동 승인 조건에 맞는 요금은 자동 승인되며, 설정된 한도를 초과하는 공개 요금은 심사가 필요할 수 있습니다.
4. 저장한 뒤 상세 화면에서 `App ID`와 `App Secret`을 확인합니다.
5. 전송 프로그램의 환경 변수에 인증 정보를 설정합니다.

`App ID`와 `App Secret`은 시그널 소스 생성자만 확인할 수 있습니다. Secret을 소스 저장소, 로그, 브라우저 코드 또는 클라이언트 애플리케이션에 저장하지 마세요.

## 푸시 프로토콜

```text
POST https://news-api.newsliquid.com/api/v2/signal-sources/push/{appId}/events
X-Signal-Timestamp: Unix 초 단위 타임스탬프
X-Signal-Nonce: 요청마다 고유한 임의의 값
X-Signal-Signature: 소문자 hex HMAC-SHA256(appSecret, timestamp + "\n" + nonce + "\n" + 원본 JSON 바이트)
```

요청 본문은 `NewsItem` JSON 객체여야 하며 `text`와 RFC3339 형식의 `ts`만 필요합니다. `id`는 선택 사항이며 생략하면 백엔드가 UUID를 생성합니다.

```json
{
  "id": "provider-event-001",
  "text": "BTC breaks above resistance",
  "description": "Optional details",
  "link": "https://example.com/event/001",
  "source": "provider-name",
  "coins": [{"symbol": "BTC", "market_type": "cex"}],
  "tags": ["breakout"],
  "score": 85,
  "signal": "long",
  "ts": "2026-09-29T08:30:00Z"
}
```

같은 시그널 소스 안에서 `id`는 안정적으로 유지해야 하며 최대 256바이트입니다. 네트워크 오류를 재시도할 때는 같은 `id`를 사용하세요. 요청마다 새로운 nonce, 타임스탬프, 서명이 생성됩니다. 전략 이벤트 키는 시그널 소스와 `id`로 만들며 요청은 메모리에서만 정규화되고 News 테이블에는 저장되지 않습니다. 요청 본문은 최대 2MiB이고 타임스탬프 차이는 약 5분 이내여야 합니다.

## 구독 필터（meta）

신호 소스에 열거형, 숫자, 불리언, 텍스트 필터를 정의할 수 있습니다. 생성자는 필드와 열거형 선택지만 정의하고, 구독자가 숫자 비교（`gt`/`gte`/`lt`/`lte`/`eq`）나 텍스트 비교（`contains`/`eq`）를 설정합니다. 텍스트는 대소문자를 구분하지 않고 문자열 포함 또는 일치 여부로 비교합니다.

```json
{"text":"Large buy detected","ts":"2026-10-10T08:00:00Z","meta":{"chain":"solana","amount":2500,"buy":true}}
```

meta 키는 소스의 필드 정의와 일치해야 합니다. 열거형은 단일 문자열, 숫자는 JSON 숫자, 불리언은 true/false, 텍스트는 문자열로 전송합니다. 설정한 필드가 누락된 신호는 일치하지 않으며, 설정하지 않은 필드는 제한하지 않습니다. Node、Python、Rust CLI 모두 서명 본문에 meta를 포함합니다. 필터 변경으로 구독 요금이 중복 청구되지 않습니다.

## 시그널 소스 수정

동일한 인증 정보로 해당 소스만 수정합니다. 사용자 JWT나 소스 ID는 필요하지 않습니다.

```text
POST https://news-api.newsliquid.com/api/v2/signal-sources/apps/{appId}
```

헤더는 전송과 동일하지만 수정 요청의 서명 메시지는 다음과 같습니다.

```text
timestamp + "\n" + nonce + "\n" + "signal-source:update\n" + 원본 JSON 바이트
```

SDK와 CLI가 작업 표시자를 자동으로 추가합니다. 시간 허용 범위는 전후 5분, 본문 제한은 2 MiB입니다. 수정 시 데이터베이스의 최신 Secret을 확인하므로 재발급 후 클라이언트를 즉시 갱신하세요.

수정할 필드만 전송하며 생략한 필드는 유지됩니다. 예를 들어 다음을 `source.json`으로 저장합니다.

```json
{"description":"Filters for breakout signals","website":"https://example.com"}
```

| 필드 | 값 |
| --- | --- |
| `name`, `description`, `website` | 문자열. 설명과 웹사이트는 빈 문자열로 삭제 가능 |
| `visibility` | `private` / `public` |
| `monetizationType` | `free` / `paid` |
| `quotaAmount` | 숫자 또는 십진수 문자열. 무료로 변경할 때 `0`도 전송 |
| `billingPeriod` | `one_time` / `monthly` |
| `metaSchema` | 전체 `{key,label,type,options?}` 정의 배열. `enum`, `number`, `boolean`, `text` 지원 |

이름, 설명, 웹사이트와 유효한 필드 변경은 즉시 적용되며 변경 이력을 기록합니다. 기존 key를 유지하면서 필드 추가, 타입이나 표시 이름 수정, 열거 옵션 추가·삭제·변경이 가능합니다. 타입을 변경할 때는 새 타입에 맞는 비교 연산자와 옵션을 사용하세요. 비어 있지 않고 중복되지 않는 열거 옵션을 최소 하나 남겨야 합니다. 타입 변경 후 호환되지 않는 기존 전략 필터는 더 이상 일치하지 않으므로 다시 설정해야 합니다. 삭제된 열거 선택 항목은 더 이상 일치하지 않으며 남은 항목은 계속 작동합니다. 새 신호 전송이나 전략 설정 저장 시 현재 정의를 사용하세요. 공개 요금은 기존 심사 규칙을 따르며 무료, 동일 청구 주기 내 요금 인하, 설정 한도 이하의 요금은 자동 적용됩니다. 심사 대기 상태도 저장에 성공하면 HTTP `200`을 반환하므로 `reviewStatus`, 현재 요금, `pendingMonetizationType` / `pendingQuotaAmount` / `pendingBillingPeriod`를 확인하세요. 소유자가 비활성화한 소스는 수정할 수 있지만 삭제되거나 관리자가 중지한 소스는 수정할 수 없습니다.

## Node.js / TypeScript SDK

```ts
import { SignalSourceClient } from "@newsliquid/signal-source";

const client = new SignalSourceClient({
  appId: process.env.SIGNAL_SOURCE_APP_ID!,
  appSecret: process.env.SIGNAL_SOURCE_APP_SECRET!,
});

const result = await client.push({
  id: `provider-${Date.now()}`,
  text: "BTC momentum signal",
  source: "my-provider",
  signal: "long",
  score: 85,
  ts: new Date().toISOString(),
});
console.log(result);
```

동일한 클라이언트로 수정합니다.

```ts
const source = await client.update({ description: "Updated description", website: "https://example.com" });
console.log(source);
```

빌드:

```bash
cd typescript
npm install
npm run build
```

## Python SDK

```python
from newsliquid_signal_source import SignalSourceClient
import os

client = SignalSourceClient(
    app_id=os.environ["SIGNAL_SOURCE_APP_ID"],
    app_secret=os.environ["SIGNAL_SOURCE_APP_SECRET"],
)
print(client.push({
    "id": "provider-001",
    "text": "BTC momentum signal",
    "source": "my-provider",
    "signal": "long",
    "ts": "2026-09-29T08:30:00Z",
}))
```

Python도 수정된 소스를 반환합니다.

```python
print(client.update({"description": "Updated description", "website": "https://example.com"}))
```

## Rust CLI

CLI는 표준 입력에서 하나의 `NewsItem` JSON을 읽으며 `--file`로 파일을 지정할 수도 있습니다. 인증 정보와 선택적인 서비스 URL은 환경 변수에서 읽습니다.

```bash
export SIGNAL_SOURCE_APP_ID="..."
export SIGNAL_SOURCE_APP_SECRET="..."

printf '%s' '{"id":"provider-001","text":"BTC momentum signal","ts":"2026-09-29T08:30:00Z"}' \
  | cargo run --manifest-path cli/Cargo.toml --release
```

파일 전송:

```bash
SIGNAL_SOURCE_APP_ID="..." \
SIGNAL_SOURCE_APP_SECRET="..." \
cargo run --manifest-path cli/Cargo.toml --release -- --file signal.json
```

수정 시 `update` 명령을 사용합니다. 설정 JSON은 파일이나 표준 입력으로 전달할 수 있습니다.

```bash
newsliquid-signal-cli update --file source.json
# 소스에서 실행:
cargo run --manifest-path cli/Cargo.toml --release -- update --file source.json
```

명령을 생략하면 기존처럼 전송하며 `push`도 명시적으로 사용할 수 있습니다.

기본 서비스 URL은 `https://news-api.newsliquid.com`입니다. 다른 환경을 테스트하려면 `SIGNAL_SOURCE_BASE_URL`을 설정하세요. GitHub Actions는 Linux x86_64 CLI를 빌드하고 workflow artifact로 업로드합니다.
푸시 데이터에서 필수 필드는 `text`와 `ts`뿐입니다. `id`, `description`, `score`, `signal`, `coins`, `source`, `link`는 선택 사항이며 `id`를 생략하면 백엔드가 UUID를 생성합니다.
