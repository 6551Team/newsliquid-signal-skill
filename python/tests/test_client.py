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
        result = client.push({"id": "x", "text": "中文", "ts": "2026-09-29T08:30:00Z"})
        self.assertTrue(result["queued"])
        self.assertEqual(result["dbNewsId"], "42:x")
        request, timeout = requests[0]
        body = request.data
        expected = hmac.new(b"secret", b"1720000000\nnonce-1\n" + body, hashlib.sha256).hexdigest()
        self.assertEqual(request.get_header("X-signal-signature"), expected)
        self.assertEqual(json.loads(body)["text"], "中文")
        self.assertEqual(timeout, 15.0)

    def test_validation(self):
        client = SignalSourceClient("app", "secret", urlopen_fn=lambda *_: None)
        with self.assertRaises(ValueError):
            client.push({"id": "x", "text": "", "ts": "now"})

    def test_http_error_is_safe(self):
        def opener(*_, **__):
            from urllib.error import HTTPError
            raise HTTPError("https://example.test", 401, "no", {}, BytesIO(b'{"message":"bad signature"}'))

        client = SignalSourceClient("app", "secret", urlopen_fn=opener)
        with self.assertRaises(SignalSourceError) as caught:
            client.push({"id": "x", "text": "ok", "ts": "now"})
        self.assertEqual(caught.exception.status, 401)
        self.assertNotIn("secret", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
