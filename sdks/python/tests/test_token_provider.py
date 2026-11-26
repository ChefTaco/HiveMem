from __future__ import annotations

import asyncio

import httpx
import pytest

from hivemem_sdk import AsyncHiveMemClient, HiveMemClient
from hivemem_sdk.errors import HiveMemHTTPError


class Provider:
    """A token source like an Oathweave client-credentials provider: cached until forced."""

    def __init__(self) -> None:
        self.calls: list[bool] = []
        self.issued = 0

    def __call__(self, force_refresh: bool) -> str:
        self.calls.append(force_refresh)
        if force_refresh or not self.issued:
            self.issued += 1
        return f"service-token-{self.issued}"


def test_token_provider_supplies_the_bearer_and_a_401_reauthenticates_once() -> None:
    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("authorization"))
        if request.headers.get("authorization") == "Bearer service-token-1":
            return httpx.Response(401, json={"detail": "Invalid service identity token"})
        return httpx.Response(201, json={"id": "m1"})

    provider = Provider()
    with HiveMemClient(base_url="https://hivemem.example", token_provider=provider, transport=httpx.MockTransport(handler)) as client:
        assert client.create_memory(content="hello", type="semantic", scope="private")["id"] == "m1"
    assert seen == ["Bearer service-token-1", "Bearer service-token-2"]
    assert provider.calls == [False, True]


def test_a_second_401_is_raised_instead_of_looping() -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(401, json={"detail": "Invalid service identity token"})

    with HiveMemClient(base_url="https://hivemem.example", token_provider=Provider(), transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(HiveMemHTTPError) as failure:
            client.health()
    assert failure.value.status_code == 401
    assert calls == 2


def test_a_provider_without_a_fresh_token_leaves_the_401() -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(401, json={"detail": "expired"})

    with HiveMemClient(base_url="https://hivemem.example", token="static", token_provider=lambda force: None, transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(HiveMemHTTPError):
            client.health()
    assert calls == 1


def test_reauthentication_does_not_spend_a_5xx_retry() -> None:
    statuses = iter([401, 503, 200])

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(next(statuses), json={"status": "ok"})

    with HiveMemClient(base_url="https://hivemem.example", token_provider=Provider(), max_retries=1, retry_base_delay=0.001, transport=httpx.MockTransport(handler)) as client:
        assert client.health() == {"status": "ok"}


def test_export_audit_pages_with_after_and_limit() -> None:
    queries: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        queries.append(request.url.query.decode("ascii"))
        return httpx.Response(200, json={"data": [], "nextCursor": None})

    with HiveMemClient(base_url="https://hivemem.example", token="admin", transport=httpx.MockTransport(handler)) as client:
        assert client.export_audit() == {"data": [], "nextCursor": None}
        client.export_audit(after="cursor-1", limit=50)
    assert queries == ["", "after=cursor-1&limit=50"]


def test_async_client_has_the_same_token_provider_and_audit_export() -> None:
    seen: list[tuple[str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.path, request.headers.get("authorization")))
        if request.headers.get("authorization") == "Bearer service-token-1":
            return httpx.Response(401, json={"detail": "expired"})
        return httpx.Response(200, json={"data": [], "nextCursor": None})

    async def run() -> None:
        async with AsyncHiveMemClient(base_url="https://hivemem.example", token_provider=Provider(), transport=httpx.MockTransport(handler)) as client:
            assert (await client.export_audit(limit=10))["nextCursor"] is None

    asyncio.run(run())
    assert seen == [("/v1/audit/export", "Bearer service-token-1"), ("/v1/audit/export", "Bearer service-token-2")]
