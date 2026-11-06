# Changelog

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
