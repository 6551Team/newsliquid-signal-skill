# NewsLiquid 信号源 SDK

本仓库支持第三方系统使用 App ID/App Secret 推送信号及完整持仓，并编辑自己的 NewsLiquid 信号源。

仓库内容：

- `typescript/`：Node.js 18+ SDK，使用原生 `fetch`
- `python/`：Python 3.10+ SDK，只使用标准库
- `cli/`：用于推送信号、持仓和编辑信号源的 Rust 命令行工具

根目录英文文档见 [README.md](../README.md)。

## 创建信号源

登录 NewsLiquid，打开[策略页面](https://app.newsliquid.com/strategy)：

1. 打开“我的信号源”标签页，点击“创建信号源”。
2. 填写信号源名称、描述和官网。
3. 选择是否公开。免费或额度符合免审核条件的公开信号源自动通过，超过系统阈值的收费配置可能需要审核。
4. 保存信号源，然后在详情中查看 `App ID` 和 `App Secret`。
5. 将凭证配置到发送信号的程序环境变量中。

只有信号源创建者可以查看对应的 `App ID` 和 `App Secret`。不要把 Secret 提交到代码仓库、写入日志，或放在浏览器和客户端代码中。

## 推送协议

```text
POST https://news-api.newsliquid.com/api/v2/signal-sources/push/{appId}/events
X-Signal-Timestamp：Unix 秒时间戳
X-Signal-Nonce：每次请求唯一的随机值
X-Signal-Signature：小写十六进制 HMAC-SHA256(appSecret, timestamp + "\n" + nonce + "\n" + 原始 JSON 字节)
```

请求体必须是 `NewsItem` JSON 对象，只需包含 `text` 和 RFC3339 格式的 `ts`；`id` 可选，省略时后端生成 UUID：

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

同一个信号源内，`id` 应保持稳定，最长 256 字节。网络错误重试时复用同一个 `id`；每次请求都会生成新的 nonce、时间戳和签名。策略事件键由信号源和 `id` 组成；请求只在内存中标准化，不写入 News 表。请求体上限为 2 MiB，时间戳与服务端的偏差应控制在约 5 分钟内。

## 测试推送

测试推送沿用同一接口、签名及格式和 meta 校验，只保存到所有者可查询的信号源推送记录，不分发给任何策略或订阅者。响应包含 `test: true`、`queued: false`，记录包含 `payload.test: true`，页面显示“测试推送”。省略选项或传 `false` 则正常分发。

```ts
await client.push({ text: "Test signal", ts: new Date().toISOString() }, { test: true });
```

```python
client.push({"text": "Test signal", "ts": "2026-10-12T08:00:00Z"}, test=True)
```

```bash
newsliquid-signal-cli push --test --file signal.json
```

直接调用 HTTP 时，在签名的 JSON 请求体中加入 `"test":true`。这是单次请求的布尔选项，CLI 的 `--test` 只支持推送。测试和正式消息请使用不同 ID，或省略 ID 由后端生成 UUID。使用测试模式前先升级后端。

“我的信号源”卡片上的“接收自己的信号”开关与测试模式独立。Node.js 使用 `client.update({ muteOwnSignals: true })`，Python 使用 `client.update({"muteOwnSignals": True})`，仅停止创建者自己的策略接收正常推送，订阅者继续接收；传 `false` 可恢复。默认 `false`，不改变公开状态或已有记录。

## 钱包持仓（0.2.0）

交易通知通过 `push()` 和 `/events` 发送普通信号源事件。账户持仓通过下面的独立方法更新。

完整持仓使用独立接口，凭证和签名与事件推送相同，不加编辑操作标记：

```text
POST https://news-api.newsliquid.com/api/v2/signal-sources/push/{appId}/positions
```

```ts
const snapshot = {
  id: "snapshot-124", ts: new Date().toISOString(),
  accountId: "aoying", accountName: "熬鹰", exchange: "binance", sequence: 124,
  positions: [{ symbol: "BTC", side: "long" as const, quantity: 2, entryPrice: 80000, markPrice: 81000 }],
};
await client.pushPositions(snapshot);
await client.pushPositions(snapshot, { test: true }); // 仅校验，不保存。
```

```python
from datetime import datetime, timezone

snapshot = {
    "ts": datetime.now(timezone.utc).isoformat(), "accountId": "aoying", "accountName": "熬鹰",
    "exchange": "binance", "sequence": 124,
    "positions": [{"symbol": "BTC", "side": "long", "quantity": 2, "entryPrice": 80000, "markPrice": 81000}],
}
client.push_positions(snapshot)
client.push_positions(snapshot, test=True)
```

CLI 将同一持仓对象保存为 `positions.json` 后推送：

```bash
newsliquid-signal-cli positions --file positions.json
newsliquid-signal-cli positions --test --file positions.json
```

账户按 `(信号源, exchange, accountId)` 区分，因此币安与 FOMO 独立保存。每次发送账户的完整持仓，`positions: []` 表示清仓，缺失或 null 会被拒绝。持仓直接发到 `/positions`，不需要 `text` 或 `meta`。`sequence` 为正的安全整数；最多 100 条仓位，同币种同方向不能重复，数量、开仓价、标记价必须为正数。可选字段为 `unrealizedPnl`、`realizedPnl`、`margin`、`liquidationPrice`、`leverage`、`marginMode`（`cross`/`isolated`）；未知数值省略。`id`、`link` 可选。SDK 检查基本请求格式，仓位细节由后端统一校验。

响应为 `{ positions: true, updated: true }`。重复、乱序或超过 24 小时的历史快照返回 `updated: false`，属于成功接收，无需重试。网络失败重试时保留原 `ts`、`sequence`。较新的 `(ts, sequence)` 更新持仓并重新计时 24 小时；持仓用于钱包监控展示，不写事件历史、不触发交易策略。前端通过 WSS 刷新，60 秒轮询兜底。`test: true` 返回 `{ positions: true, updated: false, test: true }`，不保存持仓或测试历史。使用前需先部署支持 `/positions` 的后端。

## 订阅过滤参数（meta）

创建或编辑信号源时可定义枚举、数字、布尔和文本过滤字段。创建者只配置字段和枚举选项；订阅者在策略中选择数字的 `gt`/`gte`/`lt`/`lte`/`eq` 或文本的 `contains`/`eq` 比较方式。文本不区分大小写，按字面包含或相等匹配。平台收到推送后按策略过滤。

推送时在可选的 `meta` 对象中携带实际值：

```json
{"text":"检测到大额买入","ts":"2026-10-10T08:00:00Z","meta":{"chain":"solana","amount":2500,"buy":true}}
```

字段名与信号源定义的 key 对应。枚举推送一个字符串，数字推送 JSON 数字，布尔推送 true/false，文本推送字符串。用户配置过的字段在推送中缺失时不匹配，未配置的字段不限。Node、Python、Rust CLI 均将 meta 原样放入签名请求体。修改策略过滤参数不重复扣订阅额度。

## 编辑信号源

使用同一组凭证编辑它对应的信号源，无需用户 JWT 或信号源 ID：

```text
POST https://news-api.newsliquid.com/api/v2/signal-sources/apps/{appId}
```

请求头与推送相同，编辑接口的签名内容为：

```text
timestamp + "\n" + nonce + "\n" + "signal-source:update\n" + 原始 JSON 字节
```

操作标记用于区分编辑和推送，SDK 与 CLI 自动添加。时间窗仍为前后五分钟，请求体上限为 2 MiB。编辑直接校验数据库中的最新 Secret，重新生成凭证后须立即更新客户端。

只传需要修改的字段，省略的字段保持不变。例如将以下内容保存为 `source.json`：

```json
{"description":"支持过滤参数的突破信号","website":"https://example.com"}
```

| 字段 | 取值 |
| --- | --- |
| `name`、`description`、`website` | 字符串；描述、官网传空字符串可清空 |
| `visibility` | `private` / `public` |
| `muteOwnSignals` | 布尔值，默认 `false`；`true` 仅停止创建者自己的策略接收 |
| `monetizationType` | `free` / `paid` |
| `quotaAmount` | 数字或十进制字符串；转免费时同时传 `0` |
| `billingPeriod` | `one_time` / `monthly` |
| `metaSchema` | 完整的 `{key,label,type,options?}` 字段数组；类型支持 `enum`、`number`、`boolean`、`text` |

名称、描述、官网及有效的字段定义修改立即生效并记录变更。提交 `metaSchema` 时保留原有 key，可增加字段、修改类型、名称或增删、修改枚举选项。切换类型时，比较方式和选项须符合新类型；枚举至少保留一个非空且不重复的选项。类型变更后不兼容的旧策略过滤条件不再命中，需重新配置。旧策略选中的已删除枚举项不再命中，保留项继续有效；新推送和保存的策略参数须符合当前定义。公开收费沿用现有审核规则：免费、同一周期内降价及不超过系统阈值时自动生效。需要审核的价格保存成功也返回 HTTP `200`，应查看响应中的 `reviewStatus`、当前价格和 `pendingMonetizationType` / `pendingQuotaAmount` / `pendingBillingPeriod`，以确认实际生效配置。用户禁用的信号源可编辑，已删除或管理员暂停的不可编辑。

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

使用同一客户端编辑：

```ts
const source = await client.update({ description: "更新后的信号源描述", website: "https://example.com" });
console.log(source);
```

构建 SDK：

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

Python 编辑同样返回更新后的信号源：

```python
print(client.update({"description": "更新后的信号源描述", "website": "https://example.com"}))
```

## Rust CLI

CLI 从标准输入读取一个 `NewsItem` JSON，也可以使用 `--file` 从文件读取。凭证和可选的服务地址从环境变量读取：

```bash
export SIGNAL_SOURCE_APP_ID="..."
export SIGNAL_SOURCE_APP_SECRET="..."

printf '%s' '{"id":"provider-001","text":"BTC momentum signal","ts":"2026-09-29T08:30:00Z"}' \
  | cargo run --manifest-path cli/Cargo.toml --release
```

发送文件：

```bash
SIGNAL_SOURCE_APP_ID="..." \
SIGNAL_SOURCE_APP_SECRET="..." \
cargo run --manifest-path cli/Cargo.toml --release -- --file signal.json
```

编辑时指定 `update`，配置 JSON 可以来自文件或标准输入：

```bash
newsliquid-signal-cli update --file source.json
# 从源码运行：
cargo run --manifest-path cli/Cargo.toml --release -- update --file source.json
```

不传子命令保持原有推送行为，也可以显式使用 `push`。

默认服务地址为 `https://news-api.newsliquid.com`。测试其他环境时设置 `SIGNAL_SOURCE_BASE_URL`。GitHub Actions 会构建 Linux x86_64 CLI，并将其上传为 workflow artifact。
推送数据只要求 `text` 和 `ts`。`id`、`description`、`score`、`signal`、`coins`、`source` 和 `link` 都是可选字段；未传 `id` 时由后端生成 UUID。
