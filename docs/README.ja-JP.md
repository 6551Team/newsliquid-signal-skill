# NewsLiquid シグナルソース SDK

このリポジトリでは、App ID/App Secret を使って `NewsItem` を送信し、自分の NewsLiquid シグナルソースを編集できます。

リポジトリの内容：

- `typescript/`：ネイティブ `fetch` を使用する Node.js 18+ SDK
- `python/`：標準ライブラリだけを使用する Python 3.10+ SDK
- `cli/`：シグナル送信とソース編集用の Rust コマンドラインツール

英語版は [README.md](../README.md) を参照してください。

## シグナルソースを作成する

NewsLiquid にログインし、[ストラテジーページ](https://app.newsliquid.com/strategy)を開きます。

1. 「マイシグナルソース」タブを開き、「シグナルソースを作成」をクリックします。
2. シグナルソース名、説明、公式サイトを入力します。
3. 公開するかどうかを選択します。無料または自動承認条件を満たす料金は自動承認され、設定された上限を超える公開料金は審査が必要になる場合があります。
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

## 購読フィルター（meta）

シグナルソースに列挙型、数値、真偽値、テキストの任意フィルターを定義できます。作成者はフィールドと列挙型の選択肢のみを定義し、購読者が数値の比較（`gt`/`gte`/`lt`/`lte`/`eq`）やテキストの比較（`contains`/`eq`）を設定します。テキストは大文字・小文字を区別せず、文字列の包含または一致で判定します。

```json
{"text":"Large buy detected","ts":"2026-10-10T08:00:00Z","meta":{"chain":"solana","amount":2500,"buy":true}}
```

meta のキーはソースの定義と一致させてください。列挙型は単一文字列、数値は JSON 数値、真偽値は true/false、テキストは文字列を送信します。設定済みのフィールドが欠けているシグナルは一致しません。未設定のフィールドは制限しません。Node、Python、Rust CLI は meta を署名対象の本文に含めます。フィルター変更による購読料金の重複請求はありません。

## シグナルソースを編集する

同じ認証情報で、それに対応するソースを編集します。ユーザー JWT やソース ID は不要です。

```text
POST https://news-api.newsliquid.com/api/v2/signal-sources/apps/{appId}
```

ヘッダーは送信と同じですが、編集時の署名対象は次のとおりです。

```text
timestamp + "\n" + nonce + "\n" + "signal-source:update\n" + 生の JSON バイト列
```

操作マーカーは SDK と CLI が自動追加します。時間差は前後 5 分、本文の上限は 2 MiB です。編集ではデータベースの最新 Secret を確認するため、Secret を再生成したらすぐにクライアントを更新してください。

変更するフィールドだけを送ります。省略したフィールドは変更されません。例えば `source.json` に次を保存します。

```json
{"description":"Filters for breakout signals","website":"https://example.com"}
```

| フィールド | 値 |
| --- | --- |
| `name`、`description`、`website` | 文字列。説明とサイトは空文字列で消去可能 |
| `visibility` | `private` / `public` |
| `monetizationType` | `free` / `paid` |
| `quotaAmount` | 数値または十進文字列。無料に変更する場合は `0` も送信 |
| `billingPeriod` | `one_time` / `monthly` |
| `metaSchema` | `{key,label,type,options?}` の全定義。型は `enum`、`number`、`boolean`、`text` |

名前、説明、サイト、互換性のあるスキーマ変更は即時反映され、履歴に記録されます。既存の key、型、列挙値を残したまま、フィールドや選択肢の追加、ラベル変更が可能です。公開料金は既存の審査ルールを適用し、無料、同じ課金周期内の値下げ、設定上限以下の料金は自動反映されます。審査待ちでも保存成功時は HTTP `200` を返すため、`reviewStatus`、有効な料金、`pendingMonetizationType` / `pendingQuotaAmount` / `pendingBillingPeriod` を確認してください。所有者が無効にしたソースは編集できますが、削除済みまたは管理者が停止したソースは編集できません。

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

同じクライアントで編集できます。

```ts
const source = await client.update({ description: "Updated description", website: "https://example.com" });
console.log(source);
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

Python でも更新後のソースが返されます。

```python
print(client.update({"description": "Updated description", "website": "https://example.com"}))
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

編集時は `update` を指定します。設定 JSON はファイルまたは標準入力から読み込みます。

```bash
newsliquid-signal-cli update --file source.json
# ソースから実行する場合:
cargo run --manifest-path cli/Cargo.toml --release -- update --file source.json
```

コマンドを省略すると従来どおり送信します。`push` の明示指定も可能です。

既定のサービス URL は `https://news-api.newsliquid.com` です。別の環境をテストするときは `SIGNAL_SOURCE_BASE_URL` を設定してください。GitHub Actions は Linux x86_64 CLI をビルドし、workflow artifact としてアップロードします。
プッシュデータで必須なのは `text` と `ts` だけです。`id`、`description`、`score`、`signal`、`coins`、`source`、`link` は任意で、`id` を省略した場合はバックエンドが UUID を生成します。
