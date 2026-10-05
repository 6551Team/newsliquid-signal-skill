# NewsLiquid 信号源 SDK

本仓库用于让第三方系统向 NewsLiquid 信号源推送 `NewsItem` 信号。

仓库内容：

- `typescript/`：Node.js 18+ SDK，使用原生 `fetch`
- `python/`：Python 3.10+ SDK，只使用标准库
- `cli/`：用于推送信号的 Rust 命令行工具

根目录英文文档见 [README.md](../README.md)。

## 创建信号源

登录 NewsLiquid，打开[策略页面](https://app.newsliquid.com/strategy)：

1. 打开“我的信号源”标签页，点击“创建信号源”。
2. 填写信号源名称、描述和官网。
3. 选择是否公开。公开信号源需要审核通过后，其他用户才能订阅。
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

默认服务地址为 `https://news-api.newsliquid.com`。测试其他环境时设置 `SIGNAL_SOURCE_BASE_URL`。GitHub Actions 会构建 Linux x86_64 CLI，并将其上传为 workflow artifact。
推送数据只要求 `text` 和 `ts`。`id`、`description`、`score`、`signal`、`coins`、`source` 和 `link` 都是可选字段；未传 `id` 时由后端生成 UUID。
