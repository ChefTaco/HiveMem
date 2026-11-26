# Changelog

## [Unreleased]

### Upgrade notes

- The write-recovery journal (`pending-write.json`) has a second format for incremental
  checkpoints, `{"version":2,...}`. This release still replays the original format. A release
  before this one refuses to start on a version 2 journal (it does not guess), so if you
  downgrade, start this release once first so it finishes any interrupted checkpoint. No
  Qdrant data migration is needed: the collections and payloads are unchanged.
- Search, context, chat and conflict-scan requests are limited to 600 per principal per minute
  by default (`429` with `Retry-After`). Raise `HIVEMEM_SEARCH_RATE_LIMIT_PER_MINUTE`, or set
  it to `0`, for a principal that legitimately needs more.

### Added

- `GET /v1/hive/events`, a HiveEvent v1 feed for the suite inbox (administrators): memory
  conflicts, failed webhook deliveries, dead-lettered queue jobs and a stale queue worker, with
  14-day retention. Announce it to HiveXUI with the registry capability
  `{"events.v1":{"path":"/v1/hive/events"}}`.
- Workspace-level webhooks: `all_members: true` (workspace owner or admin) also delivers other
  members' `memory.created` and `session.created` events, only for records the endpoint owner
  could read, and without content for sensitive, restricted or redacted memories.
- Error bodies carry the suite envelope `error: { code, message, requestId }` next to the
  unchanged `detail`, so HiveXUI and Cindertrace get stable codes and a request ID.
- A per-principal token bucket on the routes that scan memory in process: memory search
  (text, hybrid, archive), context, chat (including session chat and context), conflict
  detection and their compatibility dashboard routes.
- Oathweave account links (`HIVEMEM_OATHWEAVE_IDENTITIES_JSON`) accept an optional `scopes`
  ceiling. Oathweave permissions outside it are dropped, so a role that gains
  `hivemem:admin:all` no longer makes a capped user an administrator. Links without `scopes`
  behave as before.
- `HIVEMEM_OATHWEAVE_SESSION_CACHE_MS` (0-5000, default 0) lets an operator reuse a userinfo
  answer for a few seconds. The default still checks the session on every request.

### Changed

- Persistence is incremental. Each checkpoint used to rewrite and fsync a journal of the whole
  dataset (every record plus each memory's 768-float vector, about 15 KB per memory) and
  serialize every payload twice to find changes, so write latency grew with total data. The
  store now tracks which records each write changes and checkpoints only those, journaling the
  delta and the vectors of its memories. The first checkpoint after start, and the first after
  a failed one, still save the whole snapshot, which also cleans up stale duplicate copies.
- The health routes share one readiness run (in progress, or finished within the last second)
  instead of probing Qdrant and scanning the queue on every request.
- Qdrant answers are read with a 256 MiB bound, redirects are refused, and a Qdrant error
  message no longer quotes Qdrant's response body, which can echo payload content into logs.
- HiveMem no longer builds its own JWKS resolver: the shared Oathweave verifier fetches
  `OATHWEAVE_JWKS_URL` with its cache-age, key-rotation cooldown, no-redirect and timeout
  rules. User and service verifiers each keep their own cache of that one endpoint.
- The image's build stage runs Node 26.13.1, the major the runtime ships, instead of Node 24, and
  no longer installs a compiler it never used (installs run with `--ignore-scripts`; the SQLite
  binding is an N-API prebuild).
- `docker/docker-compose.yml` runs the release image built from the checkout (profile `full`)
  in place of the retired 1.x `hivemem-server` package example.

### CI

- Tests run on Node 24.22.3 and 26.13.1, audit production dependencies, and run the Python SDK
  and Hermes plugin suites (including the dual-stack contract against the built server).
- Every third-party GitHub Action in CI and the image release is pinned to a commit SHA.

## [1.10.0] - 2026-11-26

### Upgrade notes

- `/v1/health` now reports `release` as `1.10.0` (the package version) instead of the frozen
  `1.2.2`. Update any monitoring or script that compared that field to `1.2.2`.
- Idempotency records live in the server process and expire after 24 hours; a restart forgets
  them.
- TypeScript SDK 1.3.0 and the Python SDK in this repository send an `Idempotency-Key` on every
  POST and retry a POST after a 5xx. A server older than 1.10.0 ignores the key, so a retried
  POST there can write twice: against older servers pass `idempotencyKeys: false` (TypeScript)
  or `idempotency_keys=False` (Python).

### Added

- Side-effecting `POST` routes accept an `Idempotency-Key` header. A repeated key from the same
  principal replays the first 2xx answer (`Idempotent-Replayed: true`) instead of writing again;
  the answer is recorded before persistence is awaited, so a retry after an indeterminate `503`
  replays once persistence recovers. A different request under the same key is `422`, a
  concurrent one `409`. Records are process-local and expire after 24 hours.

### Fixed

- The TypeScript and Python SDKs no longer retry a POST blindly after a 5xx: they send a
  generated `Idempotency-Key` on every POST and retry only with one, back off exponentially with
  jitter (the TypeScript SDK retried immediately), honour `Retry-After` and do not retry 501.
- `/v1/health` reports `release` as this package's version. It reported `1.2.2` from a Hive 1.2.2
  bundle manifest frozen in `ts-core/package.json`, which also listed retired components; the
  manifest is gone, and `migrate` takes HiveMem's storage-format history from the code, with the
  same schema checksum, so existing installations stay current.

### Documentation

- Corrected the architecture summary (workspace import answers 501; prune is retention prune),
  the README's claim that health needs credentials, and a stale suite pin sentence.

## [1.9.1] - 2026-11-18

### Security

- Moves to `@hivemagnus/hive-common` 0.5.1. Every unauthenticated `GET` and `HEAD` request passes
  its path to the shared health resolver, whose trailing-slash trim took quadratic time on a path
  of many slashes followed by another character (`/health//…//x`), so such a request held the
  event loop for a time that grew with the square of the path length. The trim is now one linear
  pass. A regression test sends such a path with 100,000 slashes.

## [1.9.0] - 2026-11-17

### Added

- `hivemem-server rename-agent --from OLD --to NEW` moves everything an agent ID owns to another
  ID: memories (private ones into the new owner's collections with their vectors), endorsements,
  sessions, episodes, conclusions, queue jobs, webhooks, workspace ownership and membership,
  operation receipts, semantic shadow payloads and the agent record with its credential state.
  The old ID keeps a disabled record, so its remaining tokens are refused. `--dry-run` and
  `--verify` are read-only and work while HiveMem runs; the rename itself needs HiveMem stopped,
  is journaled, idempotent and verified from a fresh read, and refuses a target that already owns
  data unless `--allow-existing-target` is given. An `agent.rename` audit record is exported.
  `npm run test:agent-rename` runs it against a real Qdrant.

### Changed

- `scripts/refresh_admin_token.mjs` mints its admin token for the subject `emberpath` instead of
  the retired `hive-router`. An installation whose data belongs to `hive-router` renames it first.

## [1.8.1] - 2026-11-17

### Fixed

- `scripts/deploy_server.sh` no longer creates a model directory or copies a GGUF embedding
  model to the target. The server loads no model file: embeddings are computed in process, or by
  the optional `HIVEMEM_EMBEDDING_ENDPOINT`. `HIVEMEM_EMBEDDING_MODEL_PATH` and
  `HIVEMEM_EMBEDDING_MODEL_SOURCE` are no longer read by the script.
- `scripts/deploy_server.sh` no longer writes `HIVEMEM_CORS_ORIGINS` into the target env file,
  and `HIVEMEM_DEPLOY_CORS_ORIGINS` is gone. The server never read it. Existing lines in a
  target env file are left alone and stay ignored. `.env.example` drops the variable.
- The `hivemem-server --help` and `issue-token` error examples use `--subject emberpath` (the
  static memory proxy token for Emberpath) instead of the retired Hive Router.
- `HIVEMEM_API.md` documents the health report the server returns. The health endpoints need
  no credentials and return the same report for every caller; the old example showed a GGUF
  model path and fields the server does not send.
## [1.8.0] - 2026-11-16

### Added

- A local installer-only administrator provisioning endpoint creates a distinct memory principal
  and durable receipt through the running writer. Exact retries retain the same identity; existing,
  disabled, rotated or changed principals are never adopted or reset. The endpoint is off unless
  the installation owner configures its independent purpose-scoped secret, accepts only socket
  loopback requests and issues no memory credential. Browser identity links remain separately
  controlled by the installation.

## [1.7.1] - 2026-11-15

### Changed

- The server uses `@hivemagnus/hive-common` 0.5.0 (was 0.3.0). What this changes in HiveMem:
  audit export `details` text is scrubbed with the faster redaction, which also masks URL
  credentials that have only a user or only a password; Oathweave verifier settings are read
  once and checked at startup; health check names are checked at startup. Tokens, routes,
  responses and the error bodies are unchanged.

### Fixed

- Request bodies are read with the shared bounded reader. `HIVEMEM_MAX_BODY_BYTES`, the 413 and
  its message, the empty-body rule (`{}`) and the 400 for invalid JSON are unchanged. The rest of
  an upload over the limit is now discarded for up to 5 s after the 413 instead of the
  connection being reset while the client is still sending, and a client that disconnects
  before its body is complete gets a 400 instead of being logged as an internal error (500).
- The `HIVEMEM_METRICS_TOKEN` comparison and the semantic index's 8 MiB response limit use the
  shared helpers (`timingSafeEqualString()`, `readBodyBounded()`). A semantic dependency
  response whose `content-length` is over the limit is now refused before it is read.

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
