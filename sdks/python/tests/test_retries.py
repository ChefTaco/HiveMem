from __future__ import annotations

import asyncio
import time

import httpx
import pytest

from hivemem_sdk import AsyncHiveMemClient, HiveMemClient
from hivemem_sdk.errors import HiveMemHTTPError


def _client(handler, **kwargs) -> HiveMemClient:
    kwargs.setdefault("retry_base_delay", 0.001)
    return HiveMemClient(base_url="https://hivemem.example", token="scoped-token", transport=httpx.MockTransport(handler), **kwargs)


def test_post_is_retried_with_one_idempotency_key() -> None:
    keys: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        keys.append(request.headers.get("idempotency-key"))
        if len(keys) == 1:
            return httpx.Response(503, json={"detail": "Memory persistence unavailable; write outcome is indeterminate"})
        return httpx.Response(201, json={"id": "m1"})

    with _client(handler) as client:
        assert client.create_memory(content="hello", type="semantic", scope="private")["id"] == "m1"
        assert len(keys) == 2 and keys[0] and keys[1] == keys[0]
        client.create_memory(content="again", type="semantic", scope="private")
        assert keys[2] != keys[0]


def test_caller_key_is_kept() -> None:
    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("idempotency-key"))
        return httpx.Response(201, json={"id": "m1"})

    with _client(handler) as client:
        client.request("POST", "/v1/memories", json={"content": "hello"}, headers={"Idempotency-Key": "caller-key"})
    assert seen == ["caller-key"]


def test_post_without_key_is_not_retried() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(502, text="Bad gateway")

    with _client(handler, idempotency_keys=False) as client:
        with pytest.raises(HiveMemHTTPError) as failure:
            client.create_memory(content="hello")
    assert failure.value.status_code == 502
    assert len(calls) == 1
    assert "idempotency-key" not in calls[0].headers


def test_get_backs_off_and_501_is_not_retried() -> None:
    times: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        times.append(time.monotonic())
        return httpx.Response(503, json={"detail": "busy"}) if len(times) < 3 else httpx.Response(200, json={"status": "ok"})

    with _client(handler, retry_base_delay=0.04) as client:
        assert client.health() == {"status": "ok"}
    assert len(times) == 3
    assert times[1] - times[0] >= 0.018
    assert times[2] - times[1] >= 0.038

    unsupported: list[httpx.Request] = []

    def not_implemented(request: httpx.Request) -> httpx.Response:
        unsupported.append(request)
        return httpx.Response(501, json={"detail": "unavailable"})

    with _client(not_implemented) as client:
        with pytest.raises(HiveMemHTTPError):
            client.health()
    assert len(unsupported) == 1


def test_retry_after_is_capped() -> None:
    times: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        times.append(time.monotonic())
        return httpx.Response(503, headers={"retry-after": "120"}) if len(times) == 1 else httpx.Response(200, json={})

    with _client(handler, retry_max_delay=0.05) as client:
        client.health()
    assert 0.045 <= times[1] - times[0] < 1


def test_async_client_follows_the_same_policy() -> None:
    keys: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        keys.append(request.headers.get("idempotency-key"))
        return httpx.Response(503) if len(keys) == 1 else httpx.Response(201, json={"id": "m1"})

    async def run() -> None:
        client = AsyncHiveMemClient(base_url="https://hivemem.example", token="t", transport=httpx.MockTransport(handler), retry_base_delay=0.001)
        try:
            assert (await client.create_memory(content="hello"))["id"] == "m1"
        finally:
            await client.close()

    asyncio.run(run())
    assert len(keys) == 2 and keys[0] and keys[0] == keys[1]
