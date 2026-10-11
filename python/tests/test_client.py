import hashlib
import hmac
import json
import unittest
from io import BytesIO

from newsliquid_signal_source import SignalSourceClient, SignalSourceError


class FakeResponse:
    status = 202

    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def read(self):
        return self.body

    def getcode(self):
        return self.status


class ClientTests(unittest.TestCase):
    def test_signs_exact_body_and_returns_data(self):
        requests = []

        def opener(request, timeout):
            requests.append((request, timeout))
            return FakeResponse(b'{"success":true,"data":{"dbNewsId":"42:x","queued":true}}')

        client = SignalSourceClient(
            "app-12345678", "secret", base_url="https://example.test/", clock=lambda: 1720000000, nonce_factory=lambda: "nonce-1", urlopen_fn=opener
        )
        result = client.push({"id": "x", "text": "中文", "ts": "2026-09-29T08:30:00Z", "meta": {"chain": "solana", "amount": 2500, "buy": False}})
        self.assertTrue(result["queued"])
        self.assertEqual(result["dbNewsId"], "42:x")
        request, timeout = requests[0]
        body = request.data
        expected = hmac.new(b"secret", b"1720000000\nnonce-1\n" + body, hashlib.sha256).hexdigest()
        self.assertEqual(request.get_header("X-signal-signature"), expected)
        self.assertEqual(json.loads(body)["text"], "中文")
        self.assertEqual(json.loads(body)["meta"], {"chain": "solana", "amount": 2500, "buy": False})
        self.assertEqual(timeout, 15.0)

    def test_validation(self):
        client = SignalSourceClient("app", "secret", urlopen_fn=lambda *_: None)
        with self.assertRaises(ValueError):
            client.push({"id": "x", "text": "", "ts": "now"})
        with self.assertRaises(ValueError):
            client.push({"text": "ok", "ts": "now", "meta": []})

    def test_update_uses_operation_signature_and_returns_source(self):
        def opener(request, timeout):
            self.assertEqual(request.full_url, "https://example.test/api/v2/signal-sources/apps/app-12345678")
            self.assertEqual(request.get_method(), "POST")
            self.assertEqual(request.data, b'{"description":"Updated"}')
            self.assertEqual(request.get_header("X-signal-signature"), "7d331450e2b0a2ceac8835426e67ec3dbf01a9b46d7dfdce686deaf6f03af590")
            self.assertEqual(request.get_header("X-signal-timestamp"), "1720000000")
            self.assertEqual(request.get_header("X-signal-nonce"), "nonce-1")
            return FakeResponse(b'{"success":true,"data":{"id":8,"description":"Updated"}}')

        client = SignalSourceClient(
            "app-12345678", "secret", base_url="https://example.test/", clock=lambda: 1720000000, nonce_factory=lambda: "nonce-1", urlopen_fn=opener
        )
        self.assertEqual(client.update({"description": "Updated"}), {"id": 8, "description": "Updated"})

    def test_update_preserves_zero_prices_and_meta_schema(self):
        config = {"description": "描述", "monetizationType": "paid", "quotaAmount": 0, "billingPeriod": "monthly",
                  "metaSchema": [{"key": "chain", "label": "链", "type": "enum", "options": ["solana"]}, {"key": "volume", "label": "持仓", "type": "number"}]}

        def opener(request, timeout):
            self.assertEqual(json.loads(request.data), config)
            expected = hmac.new(b"secret", b"1720000000\nnonce-1\nsignal-source:update\n" + request.data, hashlib.sha256).hexdigest()
            self.assertEqual(request.get_header("X-signal-signature"), expected)
            return FakeResponse(b'{"success":true,"data":{"id":8}}')

        client = SignalSourceClient("app-12345678", "secret", clock=lambda: 1720000000, nonce_factory=lambda: "nonce-1", urlopen_fn=opener)
        self.assertEqual(client.update(config)["id"], 8)

    def test_update_validation(self):
        client = SignalSourceClient("app", "secret", urlopen_fn=lambda *_: self.fail("must not send"))
        for config in (None, [], "name"):
            with self.assertRaises(ValueError):
                client.update(config)

    def test_http_error_is_safe(self):
        def opener(*_, **__):
            from urllib.error import HTTPError
            raise HTTPError("https://example.test", 401, "no", {}, BytesIO(b'{"message":"bad signature"}'))

        client = SignalSourceClient("app", "secret", urlopen_fn=opener)
        for operation, payload in ((client.push, {"id": "x", "text": "ok", "ts": "now"}), (client.update, {"description": "Updated"})):
            with self.assertRaises(SignalSourceError) as caught:
                operation(payload)
            self.assertEqual(caught.exception.status, 401)
            self.assertNotIn("secret", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
