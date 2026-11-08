# Direct console workflows

HiveXUI uses the same bearer-authorized product API as native clients. Browser
contracts are owned by HiveMem and exported in `docs/openapi.json`; no dashboard
cookie or administrator credential proxy is required.

`npm run export:browser-contract -- --revision FULL_REVIEWED_REVISION --output
NEW_DIRECTORY` exports the committed OpenAPI bytes, SHA-256/revision provenance,
license and notice. It never reads a sibling checkout or includes runtime state.
Consumers pin that artifact and regenerate their browser validators with drift
checks. The contract includes memory CRUD/search, statistics, agent summaries,
worker/queue state and non-streamed session context/chat. Native SSE remains
available to independent clients. Browse pagination uses `offset` and `limit`;
`next_cursor` is a returned offset hint, not a separate accepted query parameter.

| Workflow | Direct routes | Permission |
| --- | --- | --- |
| Session lifecycle and current memory history | `/v1/sessions`, `/v1/sessions/{id}`, `/v1/sessions/{id}/memories` | `sessions:read` or `sessions:write` |
| Session context and source-cited chat | `/v1/sessions/{id}/context`, `/v1/sessions/{id}/chat` | `sessions:write`, current source access |
| Webhook endpoints | `/v1/webhooks`, `/v1/webhooks/{id}` | `webhooks:read` or `webhooks:write` |
| Webhook tests and delivery history | `/v1/webhooks/test`, `/v1/webhooks/deliveries`, `/v1/webhooks/deliveries/{id}` | `webhooks:write` to emit, `webhooks:read` for history |
| Graph and source evidence | `/v1/graph/entities`, `/v1/graph/relations`, `/v1/graph/neighborhood`, `/v1/graph/entities/{id}` | `memories:read` |
| Conflict review | `/v1/conflicts`, `/v1/conflicts/{memoryId}/resolve` | `memories:read` or `memories:write` |
| Consolidation status/history | `/v1/consolidation/status`, `/v1/consolidation/logs`, `/v1/consolidation/logs/{id}` | `memories:read` |
| Durable consolidation | `/v1/memories/consolidate`, `/v1/queue/operations/{id}` | `memories:write`, `queue:read` for receipt lookup |
| Queue inspection and administration | `/v1/queue/status`, `/v1/queue/jobs/{id}`, `/run`, `/retry`, `/v1/queue/run-next` | `queue:read`, `admin:queue` for execution/retry/cancellation |

Every receiving route also checks the resource's current workspace and ownership
rules. A token's administrator role does not bypass its explicit workspace restriction.
Session IDs, including archived IDs, cannot be replaced by creation. Session archival
retains underlying memory records. Webhook archival preserves delivery history;
private signing secrets are excluded from endpoint responses. A webhook test queues
all enabled caller-owned endpoints in the requested workspace; actual network delivery
is recorded separately. No test bypasses HTTPS destination policy.

Conflict acknowledgement/dismissal changes its review state and requires a writable
memory plus visibility of all sources. Consolidation remains deterministic local
reasoning with its existing native compatibility behavior. The operation ID protects
retries from duplicate enqueueing; incompatible payload reuse fails. Started work
cannot be cancelled, and unknown outcomes require reconciliation in the owning backend.
Existing dashboard compatibility paths remain until replacement and recovery gates pass.


## Actor credential coordination

Oathweave coordinates identities; HiveMem retains ownership of its native credentials.
`POST /v1/actor-credentials/{operationId}` accepts a reviewed explicit enroll, rotate,
renew or disable policy, requiring `admin:agents` and current workspace/scope authority.
The SHA-256 operation ID binds an exact owner and request policy. The mutation and
AES-GCM encrypted recovery receipt enter the same durable snapshot before success.
An identical retry returns the original credential for at most fifteen minutes;
it does not create another account or rotate its generation. Credentials retain
their original absolute deadline across rotation. Rotation/disable invalidates
older credential generations and recovery receipts at once.

`renew` is the one action that sets a new deadline, again at most 720 hours ahead.
It applies only to an existing, active agent and never adds a permission: the
requested scopes must be held by the agent's workspace membership (when the
workspace has a record) and by its last issued credential, as well as by the
operator. It issues a new credential generation. The previous generations keep
working for `grace_seconds` (default 3600, at most 86400, 0 for none) so the agent
can switch over, then stop; the response's `previous_credential_valid_until` says
when. A token refreshed from a previous credential keeps that generation, so it
stops at the same time. A rotation or disable during the grace period ends it.
Every enroll, rotate, renew and disable is recorded in `/v1/admin/audit` as
`actor-credential.<action>` with the agent, workspace, generation and deadline,
never the token. `GET /v1/capabilities` reports `actor_credential_renewal:
renew-grace-v1` when renewal is available.

`DELETE /v1/actor-credentials/{operationId}/receipt` acknowledges the caller-owned
receipt. An expired or acknowledged receipt cannot be replayed: reconcile the
original outcome rather than creating replacement work. Secret-bearing responses
use `Cache-Control: no-store`. Product backup and restore preserve encrypted
receipts and signing state; operator evidence remains outside Git.
