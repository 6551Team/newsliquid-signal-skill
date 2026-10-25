import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { SignalSourceClient, SignalSourceError } from "../dist/index.js";

function client(fetch) {
  return new SignalSourceClient({
    appId: "app-12345678", appSecret: "secret", baseUrl: "https://example.test/",
    clock: () => 1720000000, nonceFactory: () => "nonce-1", fetch,
  });
}

test("push preserves the existing endpoint, signature and meta", async () => {
  const input = { text: "中文", ts: "2026-10-11T08:00:00Z", meta: { chain: "solana", buy: false } };
  const result = await client(async (url, options) => {
    assert.equal(url, "https://example.test/api/v2/signal-sources/push/app-12345678/events");
    assert.equal(options.method, "POST");
    const expected = createHmac("sha256", "secret").update(`1720000000\nnonce-1\n${options.body}`).digest("hex");
    assert.equal(options.headers["x-signal-signature"], expected);
    assert.deepEqual(JSON.parse(options.body), input);
    return new Response('{"success":true,"data":{"queued":true}}', { status: 202 });
  }).push(input);
  assert.deepEqual(result, { queued: true });
});

test("wallet trades retain structured data and use the event endpoint", async () => {
  const event = { text: "BTC 开多", ts: "2026-10-25T08:00:00Z", walletMonitor: {
    kind: "trade", accountId: "aoying", accountName: "熬鹰", exchange: "binance", sequence: 1,
    trade: { symbol: "BTC", side: "long", action: "open_long", quantity: 2, price: 80000, pnl: 0 },
  } };
  const result = await client(async (url, options) => {
    assert.ok(url.endsWith("/events"));
    assert.deepEqual(JSON.parse(options.body), event);
    assert.equal(options.headers["x-signal-signature"], createHmac("sha256", "secret").update(`1720000000\nnonce-1\n${options.body}`).digest("hex"));
    return new Response('{"data":{"walletMonitor":true,"queued":true}}');
  }).push(event);
  assert.deepEqual(result, { walletMonitor: true, queued: true });
});

test("positions sign their own endpoint for snapshots, clearing, and test mode", async () => {
  const snapshot = { id: "snapshot-1", ts: "2026-10-25T08:00:00Z", accountId: "aoying",
    accountName: "熬鹰", exchange: "binance", sequence: 1,
    positions: [{ symbol: "BTC", side: "long", quantity: 2, entryPrice: 80000, markPrice: 81000, unrealizedPnl: 0 }],
  };
  for (const [input, mode] of [[snapshot, {}], [{ ...snapshot, positions: [] }, {}],
    [snapshot, { test: true }], [{ ...snapshot, test: true }, { test: false }]]) {
    const original = structuredClone(input);
    const expected = mode.test === undefined ? input : { ...input, test: mode.test };
    const response = { positions: true, updated: !expected.test, ...(expected.test ? { test: true } : {}) };
    assert.deepEqual(await client(async (url, options) => {
      assert.equal(url, "https://example.test/api/v2/signal-sources/push/app-12345678/positions");
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), expected);
      assert.equal(options.headers["x-signal-signature"], createHmac("sha256", "secret").update(`1720000000\nnonce-1\n${options.body}`).digest("hex"));
      return Response.json({ data: response });
    }).pushPositions(input, mode), response);
    assert.deepEqual(input, original);
  }
  assert.deepEqual(await client(async () => Response.json({ data: { positions: true, updated: false } })).pushPositions(snapshot),
    { positions: true, updated: false });
  await assert.rejects(client(async () => new Response('{"message":"unavailable"}', { status: 503 })).pushPositions(snapshot),
    (error) => error instanceof SignalSourceError && error.status === 503);
});

test("positions require an explicit full array and account identity before sending", async () => {
  const input = { ts: "2026-10-25T08:00:00Z", accountId: "aoying", accountName: "熬鹰", exchange: "fomo", sequence: 1, positions: [] };
  const instance = client(async () => assert.fail("must not send"));
  for (const patch of [{ positions: undefined }, { positions: null }, { positions: {} }, { accountId: "" }, { sequence: 0 }, { test: "true" }]) {
    await assert.rejects(instance.pushPositions({ ...input, ...patch }));
  }
});

test("update signs its operation and returns source data without requiring news fields", async () => {
  const result = await client(async (url, options) => {
    assert.equal(url, "https://example.test/api/v2/signal-sources/apps/app-12345678");
    assert.equal(options.method, "POST");
    assert.equal(options.body, '{"description":"Updated"}');
    assert.equal(options.headers["x-signal-timestamp"], "1720000000");
    assert.equal(options.headers["x-signal-nonce"], "nonce-1");
    assert.equal(options.headers["x-signal-signature"], "7d331450e2b0a2ceac8835426e67ec3dbf01a9b46d7dfdce686deaf6f03af590");
    return new Response('{"success":true,"data":{"id":8,"description":"Updated"}}');
  }).update({ description: "Updated" });
  assert.deepEqual(result, { id: 8, description: "Updated" });
});

test("test pushes sign the mode without mutating the event and return saved-only results", async () => {
  const input = { text: "test signal", ts: "2026-10-12T08:00:00Z", meta: { chain: "solana" } };
  const instance = client(async (_, options) => {
    assert.deepEqual(JSON.parse(options.body), { ...input, test: true });
    const expected = createHmac("sha256", "secret").update(`1720000000\nnonce-1\n${options.body}`).digest("hex");
    assert.equal(options.headers["x-signal-signature"], expected);
    return new Response('{"data":{"dbNewsId":"8:test-event","test":true,"queued":false}}');
  });
  assert.deepEqual(await instance.push(input, { test: true }), { dbNewsId: "8:test-event", test: true, queued: false });
  assert.equal(input.test, undefined);
});

test("explicit normal mode overrides a test event and invalid modes are not sent", async () => {
  const event = { text: "signal", ts: "2026-10-12T08:00:00Z", test: true };
  await client(async (_, options) => {
    assert.equal(JSON.parse(options.body).test, false);
    return new Response('{"data":{"queued":true}}');
  }).push(event, { test: false });
  assert.equal(event.test, true);
  await assert.rejects(client(async () => assert.fail("must not send")).push(event, { test: "true" }), /test must be a boolean/);
});

test("update preserves zero prices and schema definitions in the signed body", async () => {
  const input = {
    description: "描述", monetizationType: "paid", quotaAmount: 0, billingPeriod: "monthly",
    metaSchema: [{ key: "chain", label: "链", type: "enum", options: ["solana"] }, { key: "volume", label: "持仓", type: "number" }],
  };
  await client(async (_, options) => {
    assert.deepEqual(JSON.parse(options.body), input);
    const expected = createHmac("sha256", "secret").update(`1720000000\nnonce-1\nsignal-source:update\n${options.body}`).digest("hex");
    assert.equal(options.headers["x-signal-signature"], expected);
    return new Response('{"success":true,"data":{"id":8}}');
  }).update(input);
});

test("update surfaces API errors with their status", async () => {
  await assert.rejects(
    client(async () => new Response('{"message":"bad signature"}', { status: 401 })).update({ description: "Updated" }),
    (error) => error instanceof SignalSourceError && error.status === 401 && error.message === "signal update failed (401): bad signature",
  );
});

test("invalid update configuration is rejected before sending", async () => {
  const instance = client(async () => assert.fail("must not send"));
  for (const input of [null, [], "name"]) {
    await assert.rejects(instance.update(input), /source configuration must be an object/);
  }
});
