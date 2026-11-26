# HiveMem Python SDK

Official source package for Python clients integrating with HiveMem.

## Install from this repository

The Python SDK is not published to PyPI; install it from a checkout of this repository (its
`pyproject.toml` version is not a release number). The TypeScript SDK is the published client.

```bash
pip install -e sdks/python
```

## Quick start

```python
from hivemem_sdk import HiveMemClient

client = HiveMemClient(
    base_url="http://localhost:18790",
    token="<agent-or-admin-jwt>",
    workspace_id="default",
    # Optional private-PKI trust anchor; system trust is used when omitted.
    ca_file="/etc/hivemem/client-ca.pem",
)

memory = client.create_memory(
    content="The user prefers concise implementation notes.",
    type="semantic",
    scope="private",
    tags=["preference"],
)

results = client.search_memories("communication preferences", limit=5, explain=True)
context = client.context(tokens=2000, search_query="current project state")
openai_messages = context.to_openai()
```

Retries: a 5xx answer (not 501) is retried up to `max_retries` times (default 2) with
exponential backoff and jitter (`retry_base_delay`, default 0.2 s; `retry_max_delay`, default
2 s, which also caps a server's `Retry-After`). GET, HEAD, OPTIONS, PUT and DELETE are retried;
a POST only when it carries an `Idempotency-Key`. The client generates one for every POST unless
you pass your own in `headers` or set `idempotency_keys=False` (then POSTs are never retried). A
HiveMem server with idempotency support replays the first result for a repeated key; an older
server ignores the header.

Service identities: pass `token_provider`, a function taking `force_refresh` and returning a
bearer token, instead of a fixed `token`. It is called before every request (with
`force_refresh=False`, so it may return a cached token) and once more with `force_refresh=True`
after a 401, which is then retried once with the fresh token. Use it for a short-lived Oathweave
client-credentials token, which can expire or be revoked between requests:

```python
client = HiveMemClient(base_url="https://hivemem.example.com", token_provider=my_oathweave_tokens)
page = client.export_audit(limit=200)          # needs admin, or hivemem:audit:read
while page["data"]:
    handle(page["data"])
    page = client.export_audit(after=page["nextCursor"], limit=200)
```

Configuration precedence: explicit constructor arguments, then `HIVEMEM_API_URL`, `HIVEMEM_TOKEN`/`HIVEMEM_MCP_TOKEN`, `HIVEMEM_WORKSPACE_ID`, `HIVEMEM_CA_FILE`, then local defaults. Non-loopback endpoints require HTTPS; certificate and hostname verification cannot be disabled, and redirects are never followed with bearer credentials.
