# NewsLiquid Signal Source SDK

This repository lets external systems push `NewsItem` signals to a NewsLiquid signal source.

The repository contains:

- `typescript/`: Node.js 18+ SDK using the native `fetch` API
- `python/`: Python 3.10+ SDK using only the standard library
- `cli/`: Rust command-line tool for pushing signals

Localized documentation is available in [Chinese](docs/README.zh-CN.md), [Japanese](docs/README.ja-JP.md), and [Korean](docs/README.ko-KR.md).

## Create a signal source

Sign in to NewsLiquid and open the [Strategy page](https://app.newsliquid.com/strategy):

1. Open the **My Signal Sources** tab and click **Create Signal Source**.
2. Enter the signal source name, description, and official website.
3. Choose whether the signal source is public. A public signal source must pass review before other users can subscribe to it.
4. Save the signal source, then open its details to view the `App ID` and `App Secret`.
5. Configure these credentials as environment variables for the program that sends events.

Only `text` and `ts` are required in a pushed event. `id`, `description`, `score`, `signal`, `coins`, `source`, and `link` are optional. When `id` is omitted, the backend generates one.

Only the signal source owner can view its `App ID` and `App Secret`. Keep the secret out of source control, logs, browser code, and client-side applications.

## Push protocol

```text
POST https://news-api.newsliquid.com/api/v2/signal-sources/push/{appId}/events
X-Signal-Timestamp: Unix timestamp in seconds
X-Signal-Nonce: unique random value for each request
X-Signal-Signature: lowercase hex HMAC-SHA256(appSecret, timestamp + "\n" + nonce + "\n" + raw JSON bytes)
```

The request body must be a `NewsItem` JSON object. `text` and an RFC3339 `ts` are required. `id` is optional; when omitted, the backend generates a UUID:

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

`id` must be stable within one signal source and is limited to 256 bytes. Reuse the same `id` when retrying a network failure. Each request gets a new nonce, timestamp, and signature. The strategy event key is derived from the signal source and `id`; the request is normalized in memory and is not written to the News table. The request body is limited to 2 MiB, and the timestamp may differ from server time by approximately five minutes.

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

Build the SDK with:

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

## Rust CLI

The CLI reads one `NewsItem` JSON object from standard input or from a file passed with `--file`. Credentials and the optional service URL are read from environment variables:

```bash
export SIGNAL_SOURCE_APP_ID="..."
export SIGNAL_SOURCE_APP_SECRET="..."

printf '%s' '{"id":"provider-001","text":"BTC momentum signal","ts":"2026-09-29T08:30:00Z"}' \
  | cargo run --manifest-path cli/Cargo.toml --release
```

To send a file:

```bash
SIGNAL_SOURCE_APP_ID="..." \
SIGNAL_SOURCE_APP_SECRET="..." \
cargo run --manifest-path cli/Cargo.toml --release -- --file signal.json
```

The default service URL is `https://news-api.newsliquid.com`. Set `SIGNAL_SOURCE_BASE_URL` when testing against another environment. GitHub Actions builds the Linux x86_64 CLI and uploads it as a workflow artifact.
