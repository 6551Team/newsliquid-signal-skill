"""Small standard-library client for NewsLiquid signal source APIs."""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


DEFAULT_BASE_URL = "https://news-api.newsliquid.com"
USER_AGENT = "newsliquid-signal-source-python/0.1.0"


class SignalSourceError(RuntimeError):
    """A signal source request failed or the payload could not be sent."""

    def __init__(self, message: str, status: int | None = None, body: str | None = None):
        super().__init__(message)
        self.status = status
        self.body = body


class SignalSourceClient:
    """Push NewsItems and edit a source using App ID/App Secret authentication.

    ``clock`` and ``nonce_factory`` are injectable to make signing deterministic in
    tests. ``urlopen_fn`` is optional and is useful for applications that provide a
    custom HTTP transport.
    """

    def __init__(
        self,
        app_id: str,
        app_secret: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 15.0,
        clock: Callable[[], float] = time.time,
        nonce_factory: Callable[[], str] = lambda: str(uuid.uuid4()),
        urlopen_fn: Callable[..., Any] = urlopen,
    ) -> None:
        if not app_id or not app_secret:
            raise ValueError("app_id and app_secret are required")
        if not base_url:
            raise ValueError("base_url is required")
        self.app_id = app_id
        self._app_secret = app_secret
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._clock = clock
        self._nonce_factory = nonce_factory
        self._urlopen = urlopen_fn

    def push(self, event: Mapping[str, Any], *, test: bool | None = None) -> dict[str, Any]:
        """Push one event and return the server's ``data`` object.

        The exact compact JSON bytes used for the request are also the bytes used
        in the HMAC message. The event's ``id`` is therefore safe to reuse when a
        caller retries after a network failure.
        Set ``test=True`` to save only in source history, without strategy delivery.
        """
        payload = dict(event)
        if test is not None:
            payload["test"] = test
        self._validate(payload)
        return self._request(f"/api/v2/signal-sources/push/{quote(self.app_id, safe='')}/events", payload, "push")

    def update(self, config: Mapping[str, Any]) -> dict[str, Any]:
        """Edit this credential's source. Omitted fields remain unchanged.

        Supports name, description, website, visibility, monetizationType,
        quotaAmount, billingPeriod, metaSchema, and muteOwnSignals. Existing review and schema
        compatibility rules apply; inspect the returned effective/pending fields.
        """
        if not isinstance(config, Mapping):
            raise ValueError("source configuration must be an object")
        return self._request(f"/api/v2/signal-sources/apps/{quote(self.app_id, safe='')}", dict(config), "update")

    def _request(self, path: str, payload: dict[str, Any], operation: str) -> dict[str, Any]:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        timestamp = str(int(self._clock()))
        nonce = self._nonce_factory()
        if not nonce or len(nonce) > 128:
            raise ValueError("nonce must contain 1 to 128 characters")
        marker = b"signal-source:update\n" if operation == "update" else b""
        message = timestamp.encode("ascii") + b"\n" + nonce.encode("utf-8") + b"\n" + marker + body
        signature = hmac.new(self._app_secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
        url = f"{self.base_url}{path}"
        request = Request(
            url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
                "X-Signal-Timestamp": timestamp,
                "X-Signal-Nonce": nonce,
                "X-Signal-Signature": signature,
            },
        )
        try:
            with self._urlopen(request, timeout=self.timeout) as response:
                raw_response = response.read()
                status = getattr(response, "status", response.getcode())
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise SignalSourceError(_error_message(exc.code, detail, operation), exc.code, detail) from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise SignalSourceError(f"signal {operation} request failed: {exc}") from exc
        return _decode_response(status, raw_response, operation)

    @staticmethod
    def _validate(payload: Mapping[str, Any]) -> None:
        if "test" in payload and not isinstance(payload["test"], bool):
            raise ValueError("test must be a boolean")
        if "meta" in payload and not isinstance(payload["meta"], dict):
            raise ValueError("meta must be an object")
        for field in ("text", "ts"):
            if not isinstance(payload.get(field), str) or not payload[field].strip():
                raise ValueError(f"{field} is required")
        if payload.get("id") is not None and (not isinstance(payload["id"], str) or len(payload["id"]) > 256):
            raise ValueError("id must be at most 256 characters")
        score = payload.get("score")
        if score is not None and (isinstance(score, bool) or not isinstance(score, int) or not 0 <= score <= 100):
            raise ValueError("score must be an integer between 0 and 100")
        tags = payload.get("tags")
        if tags is not None and not isinstance(tags, (dict, list)):
            raise ValueError("tags must be an object or array")


def _decode_response(status: int, raw: bytes, operation: str) -> dict[str, Any]:
    text = raw.decode("utf-8", errors="replace")
    try:
        document = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SignalSourceError(f"signal {operation} returned invalid JSON", status, text) from exc
    if status < 200 or status >= 300:
        raise SignalSourceError(_error_message(status, text, operation), status, text)
    if isinstance(document, dict) and isinstance(document.get("data"), dict):
        return document["data"]
    return document if isinstance(document, dict) else {"value": document}


def _error_message(status: int, body: str, operation: str) -> str:
    try:
        parsed = json.loads(body)
        if isinstance(parsed, dict):
            message = parsed.get("message") or parsed.get("error")
            if message:
                return f"signal {operation} failed ({status}): {message}"
    except json.JSONDecodeError:
        pass
    return f"signal {operation} failed ({status})"
