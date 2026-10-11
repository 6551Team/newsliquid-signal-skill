# NewsLiquid Signal Source SDK

This repository lets external systems push `NewsItem` signals and edit their NewsLiquid signal source using App ID/App Secret credentials.

The repository contains:

- `typescript/`: Node.js 18+ SDK using the native `fetch` API
- `python/`: Python 3.10+ SDK using only the standard library
- `cli/`: Rust command-line tool for pushing signals and editing a source

Localized documentation is available in [Chinese](docs/README.zh-CN.md), [Japanese](docs/README.ja-JP.md), and [Korean](docs/README.ko-KR.md).

## Create a signal source

Sign in to NewsLiquid and open the [Strategy page](https://app.newsliquid.com/strategy):

1. Open the **My Signal Sources** tab and click **Create Signal Source**.
2. Enter the signal source name, description, and official website.
3. Choose whether the signal source is public. Free public sources and eligible prices are approved automatically; prices above the configured threshold may require review before other users can subscribe.
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

## Subscription filters (`meta`)

When creating or editing a signal source, define optional filter fields. Supported types are enum, number, boolean, and text. Source creators define fields and enum options; subscribers choose numeric comparisons (`gt`, `gte`, `lt`, `lte`, or `eq`) and text comparisons (`contains` or `eq`). Text matching is case-insensitive and literal. NewsLiquid matches each pushed signal against those settings.

Include the actual field values in the optional `meta` object:

```json
{"text":"Large buy detected","ts":"2026-10-10T08:00:00Z","meta":{"chain":"solana","amount":2500,"buy":true}}
```

Field names must match the source's definitions. Enum values are single strings, numbers are JSON numbers, booleans are `true`/`false`, and text values are strings. A signal missing a field selected by a subscriber will not match that filter. Unconfigured filters impose no restriction. Node.js, Python, and the Rust CLI all send `meta` in the signed request body. Adding or editing strategy filters does not create another subscription charge.

## Edit a signal source

Use the same credentials to edit the source they belong to. No user JWT or source ID is needed:

```text
POST https://news-api.newsliquid.com/api/v2/signal-sources/apps/{appId}
```

Use the same timestamp, nonce, and signature headers as pushing, but sign this message:

```text
timestamp + "\n" + nonce + "\n" + "signal-source:update\n" + raw JSON bytes
```

The operation marker separates editing from pushing. All clients below add it automatically. The timestamp window and 2 MiB body limit are unchanged. Editing checks the current database secret, so a rotated secret must be updated in your client immediately.

Send only fields you want to change; omitted fields remain unchanged. For example, save this as `source.json`:

```json
{"description":"Breakout signals with configurable filters","website":"https://example.com"}
```

| Field | Value |
| --- | --- |
| `name`, `description`, `website` | Strings; an empty description or website clears it |
| `visibility` | `private` or `public` |
| `monetizationType` | `free` or `paid` |
| `quotaAmount` | Number or decimal string; use `0` when switching to free |
| `billingPeriod` | `one_time` or `monthly` |
| `metaSchema` | Complete array of `{key, label, type, options?}` definitions; supported types are `enum`, `number`, `boolean`, and `text` |

Names, descriptions, websites, and valid schema changes apply immediately and record a change history. Schema updates must retain existing keys; you may add fields, change types or labels, or add, remove, and rename enum options. When changing a type, use operators and options valid for the new type. Keep at least one nonempty, unique enum option. Incompatible existing strategy filters stop matching after a type change and must be reconfigured. Removed enum selections no longer match; retained selections continue to work. New pushes and saved strategy parameters must use the current schema. Public pricing follows the existing review rules: free pricing, decreases within the same billing period, and prices within the configured threshold apply automatically. For pending prices, HTTP `200` means the edit was saved, not that the new price is already effective; check `reviewStatus`, the effective pricing fields, and `pendingMonetizationType`/`pendingQuotaAmount`/`pendingBillingPeriod` in the returned source. Disabled sources may be edited; deleted or administrator-suspended sources cannot.

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

To edit with the same client:

```ts
const source = await client.update({
  description: "Updated signal source description",
  website: "https://example.com",
});
console.log(source);
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

Python editing uses the same client and returns the updated source:

```python
print(client.update({"description": "Updated signal source description", "website": "https://example.com"}))
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

To edit, pass the `update` command and a configuration JSON file (or send it on stdin):

```bash
newsliquid-signal-cli update --file source.json
# When building from source:
cargo run --manifest-path cli/Cargo.toml --release -- update --file source.json
```

Omitting the command still pushes a signal; `push` is also accepted explicitly.

The default service URL is `https://news-api.newsliquid.com`. Set `SIGNAL_SOURCE_BASE_URL` when testing against another environment. GitHub Actions builds the Linux x86_64 CLI and uploads it as a workflow artifact.
