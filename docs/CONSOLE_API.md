# Direct console workflows

HiveXUI uses the same bearer-authorized product API as native clients. Browser
contracts are owned by HiveMem and exported in `docs/openapi.json`; no dashboard
cookie or administrator credential proxy is required.

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
`POST /v1/actor-credentials/{operationId}` accepts a reviewed explicit enroll, rotate
or disable policy, requiring `admin:agents` and current workspace/scope authority.
The SHA-256 operation ID binds an exact owner and request policy. The mutation and
AES-GCM encrypted recovery receipt enter the same durable snapshot before success.
An identical retry returns the original credential for at most fifteen minutes;
it does not create another account or rotate its generation. Credentials retain
their original absolute deadline across rotation. Rotation/disable invalidates
older credential generations and recovery receipts.

`DELETE /v1/actor-credentials/{operationId}/receipt` acknowledges the caller-owned
receipt. An expired or acknowledged receipt cannot be replayed: reconcile the
original outcome rather than creating replacement work. Secret-bearing responses
use `Cache-Control: no-store`. Product backup and restore preserve encrypted
receipts and signing state; operator evidence remains outside Git.
