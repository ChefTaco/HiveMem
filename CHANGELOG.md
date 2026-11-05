# Changelog

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

## Unreleased ecosystem extraction

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
