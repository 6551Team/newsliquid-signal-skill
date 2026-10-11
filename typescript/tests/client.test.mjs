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
