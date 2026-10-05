# NewsLiquid シグナルソース SDK

このリポジトリは、外部システムから NewsLiquid のシグナルソースへ `NewsItem` シグナルを送信するためのものです。

リポジトリの内容：

- `typescript/`：ネイティブ `fetch` を使用する Node.js 18+ SDK
- `python/`：標準ライブラリだけを使用する Python 3.10+ SDK
- `cli/`：シグナル送信用の Rust コマンドラインツール

英語版は [README.md](../README.md) を参照してください。

## シグナルソースを作成する

NewsLiquid にログインし、[ストラテジーページ](https://app.newsliquid.com/strategy)を開きます。

1. 「マイシグナルソース」タブを開き、「シグナルソースを作成」をクリックします。
2. シグナルソース名、説明、公式サイトを入力します。
3. 公開するかどうかを選択します。公開シグナルソースは審査に通過してから他のユーザーが購読できます。
4. 保存後、詳細画面で `App ID` と `App Secret` を確認します。
5. 送信プログラムの環境変数に認証情報を設定します。

`App ID` と `App Secret` はシグナルソースの作成者だけが確認できます。Secret をソース管理、ログ、ブラウザーコード、クライアントアプリに保存しないでください。

## プッシュプロトコル

```text
POST https://news-api.newsliquid.com/api/v2/signal-sources/push/{appId}/events
X-Signal-Timestamp: Unix 秒のタイムスタンプ
X-Signal-Nonce: リクエストごとに一意なランダム値
X-Signal-Signature: 小文字 hex HMAC-SHA256(appSecret, timestamp + "\n" + nonce + "\n" + 生の JSON バイト列)
```

リクエスト本文は `NewsItem` JSON オブジェクトで、`text` と RFC3339 形式の `ts` だけが必須です。`id` は任意で、省略するとバックエンドが UUID を生成します。

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

同じシグナルソース内で `id` は安定した値にし、256 バイト以内にしてください。ネットワークエラーを再試行するときは同じ `id` を使います。リクエストごとに新しい nonce、タイムスタンプ、署名が生成されます。戦略イベントキーはシグナルソースと `id` から作られ、リクエストはメモリ上で正規化されるだけで News テーブルには保存されません。本文の上限は 2 MiB、タイムスタンプの差は約 5 分以内です。

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

ビルド：

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

CLI は標準入力、または `--file` で指定したファイルから 1 件の `NewsItem` JSON を読み込みます。認証情報と任意のサービス URL は環境変数から読み取ります。

```bash
export SIGNAL_SOURCE_APP_ID="..."
export SIGNAL_SOURCE_APP_SECRET="..."

printf '%s' '{"id":"provider-001","text":"BTC momentum signal","ts":"2026-09-29T08:30:00Z"}' \
  | cargo run --manifest-path cli/Cargo.toml --release
```

ファイルを送信する場合：

```bash
SIGNAL_SOURCE_APP_ID="..." \
SIGNAL_SOURCE_APP_SECRET="..." \
cargo run --manifest-path cli/Cargo.toml --release -- --file signal.json
```

既定のサービス URL は `https://news-api.newsliquid.com` です。別の環境をテストするときは `SIGNAL_SOURCE_BASE_URL` を設定してください。GitHub Actions は Linux x86_64 CLI をビルドし、workflow artifact としてアップロードします。
プッシュデータで必須なのは `text` と `ts` だけです。`id`、`description`、`score`、`signal`、`coins`、`source`、`link` は任意で、`id` を省略した場合はバックエンドが UUID を生成します。
