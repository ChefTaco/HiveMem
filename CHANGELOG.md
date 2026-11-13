# Changelog

## [1.7.0] - 2026-11-13

### Security

- `PUT /v1/memories/{id}` now requires workspace write access where the memory lives and, when
  `workspace_id` changes, in the destination workspace. Before, an agent could move its own
  memory into a workspace it could not write to (or out of the workspaces its token is bound
  to), and a member demoted to viewer could still edit content. Sessions and webhooks already
  applied this rule.
- Only an administrator can create the `default` workspace record. Without a record the default
  workspace is open to every agent; before, any agent holding `workspaces:write` could create
  the record, become its owner and close the workspace to everyone else. An existing `default`
  record is unaffected. `*` is refused as a workspace ID.
- `GET /v1/agents/{id}/profile` for another agent now summarises only the memories the caller
  can read. Before, its counts and top tags included that agent's private memories and closed
  workspaces. The agent itself and administrators still see the full profile.
- `GET /dashboard/api/memory-options` lists agents and tags only from workspaces the caller can
  read.

### Fixed

- A private memory written by an agent whose ID contains a character Qdrant refuses in a
  collection name (`:` for example, which `issue-token --subject` and service links allow; also
  `" * / < > ? \ |`) no longer stops the server. Before, the checkpoint could never complete:
  every later request from every agent answered 503, and the server refused to start again
  until `pending-write.json` was removed by hand. Such agents now use an encoded collection
  name, `enc-<slug>-<hash>_private_<type>`; a pending checkpoint left by an earlier release is
  replayed under the new name on the next start, so nothing has to be cleaned up. Collections of
  all other agents keep their exact names. Agent IDs longer than 178 bytes, whose collections
  could be created but not snapshotted, also move to an encoded name at the next checkpoint.
- `POST /v1/chat` and `POST /v1/sessions/{id}/chat` now wait for the response checkpoint. A
  persistence failure while the answer was being sent was an unhandled rejection, which stops
  the server process; it is now a 503 for that request.
- `POST /v1/memories/batch` validates every item and its workspace before storing any, so a
  rejected batch no longer leaves its first items behind to be duplicated by the retry.
- A request path with malformed percent-encoding answers 400 instead of 500, and an undecodable
  dashboard cookie is treated as no credential (401).
- TypeScript SDK: a 5xx response that is retried has its body cancelled, releasing the
  connection instead of holding it until garbage collection.

## [1.6.0] - 2026-11-12

### Added

- `GET /v1/audit/export`: the suite audit export. Stored audit records (mutations, tombstones,
  conflict resolutions, retention, renewals and agent credential operations) as HiveAuditRecord
  v1, oldest first, keyset-paged on `(created_at, id)` with an opaque `after` cursor and `limit`
  1-200 (default 100). Every page with records carries its last record's cursor; `nextCursor`
  is `null` only on an empty page. Empty `target` and `subject` are omitted. Audit records are
  now timestamped strictly increasingly so a cursor never skips a record written in the same
  millisecond. Allowed for administrators and for Oathweave service tokens with the
  `hivemem:audit:read` permission (service link scope `audit:read`; native-issuer tokens through the link's issuer, as for other
  service routes); others get 403, and a
  request without a token 401. `details` is an allowlist of redacted scalars and never holds
  memory content, bodies or secrets. `HiveAuditRecordSchema` is exported and the record is in
  the OpenAPI document. `GET /v1/admin/audit` is unchanged.
- Audit records now note the actor type (`service`, `user` or `agent`) and, for Oathweave
  callers, the issuer and service client.
- TypeScript SDK: `exportAudit({ after, limit })` with `HiveAuditRecord` and `HiveAuditPage`
  types.

## [1.5.0] - 2026-11-12

### Changed

- Verify Oathweave browser tokens with the shared `@hivemagnus/hive-common` verifier, keeping
  HiveMem's rules: no clock tolerance, an online session check on every request, a required
  `roles` array and `clientId` claim, the `hivemem` audience and explicit account links.
  Service-account tokens use a second shared verifier (`@hivemagnus/hive-common` 0.3.0) on the
  same JWKS cache, with service links' native issuers as `nativeIssuers` and https issuers as
  `issuer`. A service link issuer that is neither a lowercase native identifier nor an https
  URL is now refused at startup. The shared Oathweave conformance vectors, including the
  native-issuer vectors, run in the test suite.
- Mutation audit receipts record the request's `x-request-id` (or `x-hive-request-id`), or a
  generated ID when the caller sent none.

### Added

- `GET /health/live` and `GET /health/ready` in the suite format, with `store` and `worker`
  checks. Every existing `/v1/health*` path is unchanged.
- Every response carries `x-request-id`, echoing a valid inbound `x-request-id`,
  `x-hive-request-id` or `x-correlation-id`, and server error logs name it. W3C `traceparent`
  is read for the request context.
- `GET /v1/memories/browse` accepts an `agent_id` query parameter and `POST /v1/memories/search`
  an optional `agent_id` body field, returning only the caller's readable memories written by
  that agent. `GET /v1/stats` accepts `agent_id` to scope every count to that agent's records;
  only that agent or an administrator may use it.
  The value must match `^[a-z0-9_-]{2,32}$` (otherwise `422`); without it, responses are
  unchanged.

## [1.4.2] - 2026-11-11

- Refuse native deployments and service restarts on Node.js below the package security minimum before changing remote state.
- Require patched Node.js 24.22.3 or 26.13.1, and refresh build and runtime image pins for upstream TLS and HTTP/2 security fixes.

## [1.4.1] - 2026-11-10

### Security

- Run containers on a pinned, maintained Node 26 runtime with patched system libraries.
- Use SQLite 3.54.1 for the packaged recovery engine and verify committed WAL snapshots, permissions and overwrite refusal.

## 1.4.0 - 2026-11-08

### Added

- Actor credential renewal. `POST /v1/actor-credentials/{operationId}` accepts a `renew`
  action that issues an existing, active agent a fresh credential with a new deadline (at
  most 720 hours ahead) without adding any permission: the scopes must already be held by
  its workspace membership and its last credential. The previous credential keeps working
  for `grace_seconds` (default one hour, at most one day), then stops. Until now a
  credential kept its first deadline across every rotation, so an agent lost memory after
  30 days unless it was enrolled again. Capabilities report
  `actor_credential_renewal: renew-grace-v1`.
- `/v1/admin/audit` lists every enroll, rotate, renew and disable as
  `actor-credential.<action>`.

### Security

- `/v1/auth/refresh` and `/v1/auth/renew` keep the credential generation of the token or
  grant presented, so a credential that a renewal is phasing out cannot mint a current one.

## 1.3.2 - 2026-11-06

### Added

- Linked Oathweave service identities. `HIVEMEM_OATHWEAVE_SERVICES_JSON` links an
  Oathweave machine client (issuer and client ID) to a local principal with a scope
  ceiling. HiveMem accepts that client's client credentials tokens when they are signed
  by the configured JWKS, carry the `hivemem` audience, have no user session and live at
  most fifteen minutes. Their `hivemem:` permissions become scopes, limited by the link.
  Another product can then call HiveMem with credentials it renews itself instead of a
  long-lived admin token.

### Fixed

- The container image now sets `HIVEMEM_TS_CORE_HOST=0.0.0.0`, the variable the server reads,
  instead of the unused `HIVEMEM_HOST`. A standalone container listened on `127.0.0.1` only, so a
  published port did not answer unless `HIVEMEM_TS_CORE_HOST` was passed. An explicit
  `HIVEMEM_TS_CORE_HOST` still wins; the suite already sets it.

### Security

- A service principal cannot exchange its token for a HiveMem bearer token at
  `/v1/auth/refresh`, unlinked clients and issuers are refused, and disabling the linked
  local agent contains the service at once.

## 1.3.1 - 2026-11-05

### Security

- Remove npm, npx, corepack and yarn and the apt package tooling (apt,
  libapt-pkg6.0) from the runtime image; the service never invokes a package
  manager at runtime. This drops the bundled npm's brace-expansion 5.0.9
  (CVE-2026-102276, CVE-2026-102278) and undici 6.28.0 (CVE-2026-19534,
  CVE-2026-109383, CVE-2026-109869, CVE-2026-87018) and apt 2.6.1
  (CVE-2026-109518). dpkg and its package database remain so scanners can still
  inventory OS packages. The image has no HIGH or CRITICAL finding with an
  available fix (Trivy 0.70.0).
- HIGH and CRITICAL findings in Debian 12 base packages that have no fix yet:
  zlib1g CVE-2023-45853 (critical) and CVE-2026-76844; util-linux and its
  libraries CVE-2026-53613, CVE-2026-53615 and CVE-2026-78410; ncurses
  CVE-2025-69720; libsystemd0 and libudev1 CVE-2026-16742; gzip CVE-2026-41992;
  libacl1 CVE-2026-54369; perl-base CVE-2026-9538.

## 1.3.0 - 2026-11-05

- Export immutable, attributed browser contracts for memory CRUD/search, native
  offset pagination, queue/worker state, statistics, agents and session results.
  Preserve native and historical text in read contracts, and verify schemas
  against actual store outputs without changing native APIs.

- Verify managed webhook delivery with a disposable native API/worker, real
  Qdrant, a scoped identity and a certificate-verified HMAC receiver, including
  durable history after restart and truthful failed/disabled outcomes.

- Correct the owned memory contract to advertise the existing browse endpoint and
  PUT updates; remove the unsupported collection GET and PATCH declarations.

- Allow the native Hermes plugin to use an explicit canonical HTTPS ingress
  prefix while preserving origin-only endpoints and strict redirect/TLS checks.

- Recheck each session memory source against current workspace access after a
  session moves, so later membership revocation removes that source from history.

- Add product-owned actor credential operations with encrypted, expiring receipts,
  exact owner/policy-bound replay, preserved credential deadlines and generation
  containment. Enrollment requires current workspace authority and explicit scopes.

- Expose scoped conflict review and consolidation history on the direct product API,
  with owned session/webhook/graph browser contracts. Reserve session IDs, enforce
  current workspace permissions on session and webhook mutations/history, and require
  job ownership/workspace authorization for queue retry and cancellation.

- Authorize read-only conflict detection with memory read permission, preserving
  workspace access checks and avoiding false mutation audit receipts.
- Reserve archived workspace IDs, require ownership for restoration or owner grants,
  and preserve token workspace restrictions for administrator listings. Add an owned
  browser profile/workspace API contract without changing native authentication.

- Add protected first-start memory identity enrollment with durable completion,
  stable IDs, explicit existing-store refusal and rehearsal containment.

### Ecosystem extraction

- Export the Hermes memory provider as an allowlisted, attributed plugin artifact
  from an explicit reviewed revision, with archive and runtime checksums.

Rehearsal startup disables background workers and retains interrupted queue claims without recovery or dispatch.

Independent product snapshot, container build and direct Oathweave authorization with explicit product-account links. Existing machine protocols remain available. Suite lifecycle and migration acceptance remain pending.

All notable changes to this project will be documented in this file.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [1.0.0]

Initial public release.

- Strict TypeScript HiveMem core backed by Qdrant: episodic, semantic, and procedural memories with provenance, valid-time history, deduplication, and workspace/agent scope isolation.
- Lexical, semantic (optional shadow index), and hybrid search with a structured filter DSL, explainability, and MMR diversity controls.
- Source-cited chat and token-budgeted context packages, sessions, episodes, peer cards, and conclusions.
- Durable reasoning queue (summaries, consolidation, dream, forgetting review) with idempotent operation receipts.
- Bounded HS256 JWT auth, scoped agent tokens, renewal grants, and persistent `jti` revocation.
- HMAC-signed webhooks with SSRF-safe destination policy, metrics, audit log, and an operator dashboard.
- TypeScript (`@hivemagnus/hivemem-sdk`) and Python SDKs, and a Hermes Agent memory-provider plugin.
- `@hivemagnus/hivemem-server` on npm, with a `hivemem-server` command (`start`, `check`, `env-schema`, `issue-token`, `--env-file`). It defaults to Qdrant persistence and refuses to start when Qdrant is unreachable (`HIVEMEM_TS_PERSISTENCE=memory` opts in to volatile storage). Without `HIVEMEM_STORAGE_PATH`, local state goes to `${HIVE_HOME:-~/.hive}/memory`.

Container listeners bind to the container network while native loopback defaults remain available.

Browser account links require an existing active local identity and a reviewed credential-generation pin. Native rotation invalidates stale links without creating replacement identities or changing native credentials.
