# HiveMem Architecture

HiveMem is the shared long-term memory service for agents, SDK clients, the Hermes Agent
plugin and the HiveXUI console. It is one strict TypeScript process in [`ts-core/`](ts-core)
(Node.js 24 or 26) that keeps its data in Qdrant. The former Python/FastAPI service has been
removed; Python remains only in the SDK and the Hermes plugin.

Releases ship as the container image `ghcr.io/cheftaco/hivemem`, normally installed and
wired up by the Hive suite controller, `hive.sh`. HiveMem has no dashboard of its own: in the
suite, HiveXUI is its browser console and calls the same REST API as every other client.

## Runtime shape

| Component | Implementation | Notes |
| --- | --- | --- |
| HTTP server | `ts-core/src/server.ts`, `ts-core/src/cli.ts` | One `node:http` or `node:https` listener (`HIVEMEM_WEB_PORT`, default `18790`) serving the REST API, health, `/metrics`, `/v1/capabilities` and the dashboard compatibility routes. HTTPS when `HIVEMEM_TLS_CERT_FILE` and `HIVEMEM_TLS_KEY_FILE` are both set. |
| Domain store | `ts-core/src/store.ts` | In-memory `HiveMemStore` holding memories, sessions, episodes, workspaces, agents, queue jobs, conclusions and webhooks, with the workspace and ownership checks. |
| Persistence | `ts-core/src/persistence.ts` | Qdrant snapshot adapter: hydrates the store on start and flushes changes back. `HIVEMEM_TS_PERSISTENCE=qdrant` is the default, and startup fails when Qdrant is unreachable. `memory` is an explicit volatile mode for tests and demos. |
| Retrieval | `persistence.ts`, `ts-core/src/semantic-index.ts` | Default retrieval is deterministic lexical search over a token-hash embedding (`hivemem-token-hash-v1`, 768 dimensions); no model is loaded. An optional OpenAI-compatible `/v1/embeddings` endpoint (`HIVEMEM_EMBEDDING_*`) maintains a semantic shadow collection (`hivemem_shadow_*`), rebuilt with `ts-core/src/reindex.ts`. |
| Reasoning and queue | `ts-core/src/reasoning.ts`, `ts-core/src/worker-startup.ts` | Summaries, consolidation, dreams, peer cards, conflict scans and message extraction are deterministic local heuristics with no external LLM call. Writes enqueue jobs in a Qdrant-backed queue run by the managed background worker. |
| Webhooks | `ts-core/src/webhook-transport.ts` | HMAC-signed deliveries to HTTPS destinations, with delivery history. |
| Native auth | `ts-core/src/auth.ts`, `ts-core/src/revocation-store.ts` | HS256 JWTs signed with `HIVEMEM_JWT_SECRET`, carrying role and scopes, with persistent `jti` revocation. `issue-token` mints tokens locally. Optional renewal grants use a separate `HIVEMEM_RENEWAL_SECRET`. |
| Suite auth | `ts-core/src/identity.ts`, `ts-core/src/account-links.ts` | Optional RS256 Oathweave tokens for HiveXUI, verified against `OATHWEAVE_ISSUER`, `OATHWEAVE_JWKS_URL` and `OATHWEAVE_USERINFO_URL` and mapped to existing agents only through explicit `HIVEMEM_OATHWEAVE_IDENTITIES_JSON` links. See [docs/OATHWEAVE.md](docs/OATHWEAVE.md). |
| Credential coordination | `ts-core/src/actor-credentials.ts`, `ts-core/src/initial-account.ts` | Idempotent enroll, rotate and disable operations with encrypted recovery receipts, and the protected first-start account file (`HIVEMEM_INITIAL_ACCOUNT_FILE`) used by fresh suite installations. See [docs/CONSOLE_API.md](docs/CONSOLE_API.md). |
| Local state | `ts-core/src/writer-lock.ts`, `ts-core/src/durable-file.ts` | Under `HIVEMEM_STORAGE_PATH` (default `${HIVE_HOME:-~/.hive}/memory`): a `flock` writer lock that allows one writer per data directory, the write-recovery journal and the revocation list. |
| Migrations | `ts-core/src/upgrade.ts`, `ts-core/src/migrations/` | `migrate --plan` is read-only; `migrate` backs up and applies the persisted-format migration. Startup refuses pending migrations unless `HIVE_AUTO_MIGRATE=true`. |
| Hermes plugin | `hermes-plugin/` | Python Hermes Agent memory provider. It talks to HiveMem over REST only. |
| SDKs | `sdks/python`, `sdks/typescript` | REST clients. |

## Container image

The [`Dockerfile`](Dockerfile) builds `ts-core` from this source and produces a
`linux/amd64` and `linux/arm64` image that runs `node dist/src/cli.js` as the unprivileged
`node` user. Its defaults:

- `HIVE_HOME=/data`, so local state lives in `/data/memory` on the `/data` volume;
- port `18790`, exposed as `EXPOSE 18790`;
- `HIVE_AUTO_MIGRATE=false`, `HIVE_AUTO_UPGRADE=false` and `HIVE_UPDATE_CHECK=false`;
- a health check that runs `/app/healthcheck.mjs` against `HIVE_HEALTH_URL`, by default
  `https://localhost:18790/v1/health/ready`. Certificate verification stays on;
  `HIVE_HEALTH_TLS_NAME` and `NODE_EXTRA_CA_CERTS` adapt it to the service certificate;
- no package manager or `apt` in the runtime layer.

The CLI listens on `127.0.0.1` unless `HIVEMEM_TS_CORE_HOST` is set, so a container that
publishes its port sets `HIVEMEM_TS_CORE_HOST=0.0.0.0`. Pushing a `v*` tag runs
`.github/workflows/release-image.yml`, which runs CI, publishes the image under its exact
version with a build provenance attestation, and records the digest in a GitHub release.

## Suite integration

In a Hive suite installation, `hive.sh` installs the image pinned by digest from a signed
release manifest, in both the `core` and `full` profiles:

- HiveMem depends on Oathweave and on its own Qdrant (`hivemem-qdrant`). Qdrant sits on an
  internal `memory-data` network that only HiveMem joins.
- Other products reach HiveMem at its internal HTTPS endpoint on port `18790`.
- Hive Ingress maps the browser API prefix `/api/hivemem` (used by HiveXUI's memory section)
  and the native API prefix `/memory/v1`.
- The controller writes HiveMem's configuration, secrets, Oathweave settings and initial
  account file. HiveXUI signs users in through Oathweave and calls HiveMem directly with a
  token for the `hivemem` audience; no administrator credential is proxied.

HiveMem still runs on its own: a standalone installation needs only the image (or a source
build), a Qdrant it can reach and `HIVEMEM_JWT_SECRET`, and clients then use native tokens.

## Console and the removed dashboard

The standalone HiveMem dashboard has been removed. `GET /dashboard` returns only a
placeholder page. `POST /dashboard/login` and the `/dashboard/api/*` webhook and queue
routes remain as compatibility paths for existing callers. Browser workflows (memories,
sessions, webhooks, the graph, conflicts, consolidation and the queue) are HiveXUI pages over
the bearer-authorized `/v1` API described in [docs/CONSOLE_API.md](docs/CONSOLE_API.md). The
browser contract is exported from [`docs/openapi.json`](docs/openapi.json) by
`npm run export:browser-contract`.

## Data model

Active memories live in Qdrant collections named by scope and type:

- `shared_episodic`, `shared_semantic`, `shared_procedural`
- `<agent>_private_episodic`, `<agent>_private_semantic`, `<agent>_private_procedural`

`<agent>` is the agent ID itself. Qdrant refuses some characters in a collection name
(`" * / : < > ? \ |` and control characters), and a collection snapshot fails for very long
names, so an agent ID that contains one of them, or is longer than 178 bytes, is stored under
`enc-<slug>-<hash>` instead: `<slug>` is the lowercased ID with other characters replaced by
`-` (at most 40 characters) and `<hash>` is the first 32 hex digits of the SHA-256 of the ID.
For example `svc:router` uses `enc-svc-router-15fa9bd708b0846572cb9ee283e0d6c3_private_semantic`.
Every point carries its owner in the `agent_id` payload field, so the name is never decoded.
All names are built in `ts-core/src/collection-names.ts`.

Metadata and operational records live in underscore collections such as `_agents`,
`_sessions`, `_episodes`, `_conclusions`, `_queue`, `_queue_archive`, `_workspaces`,
`_webhooks` and `_webhook_deliveries`. Episode headers and messages share `_episodes`,
distinguished by `record_type`.

Memory records include content, type, scope, agent id, source, confidence, importance, tags,
metadata, sensitivity, retention policy, `workspace_id`, optional `session_id`, validity
timestamps, relationships, provenance, endorsement state and deletion state. On load, the
Qdrant adapter accepts older payloads that lack `id` or `workspace_id`: it gives them stable
synthetic ids from the collection and point id and defaults the workspace to `default`.

Workspace isolation uses the Option A model in
[`docs/decisions/0001-workspace-isolation.md`](docs/decisions/0001-workspace-isolation.md):
collections stay global and each record carries an indexed `workspace_id`. Search and browse
requests can use `workspace_id=*` for all readable workspaces. A token's administrator role
does not bypass an explicit workspace restriction.

## API surface

The TypeScript core implements the REST contract:

- health, readiness, dependency status, stats, metrics, capabilities and embed;
- memory CRUD, batch, browse, search (text, hybrid and, when configured, semantic), and
  related, conflict, diff and graph helpers;
- sessions, episodes, messages, context packing, deterministic chat and SSE chat;
- queue status, retry, cancel, manual runs, archive and consolidation;
- workspaces with members, settings, export, import and prune;
- agents, profile bundles, peer cards, conclusions, representations and graph entities,
  relations and neighborhoods;
- webhook endpoints, test emission and delivery history;
- token mint, refresh, renew and revoke, and actor credential operations;
- the dashboard compatibility routes above.

`GET /v1/capabilities` and `GET /v1/capabilities/operations` report what the running build
implements. [`HIVEMEM_API.md`](HIVEMEM_API.md) is the endpoint reference, and
[`docs/openapi.json`](docs/openapi.json) is the generated OpenAPI document
(`npm run check:openapi` checks it).

## Native systemd deployment

[`scripts/deploy_server.sh`](scripts/deploy_server.sh) and
[`docker/hivemem-ts.service`](docker/hivemem-ts.service) remain for existing native
installations. The script syncs this source to `/opt/hivemem`, installs TLS material and the
environment file, builds `ts-core`, installs the unit as `hivemem.service` with local state in
`/var/opt/hivemem`, restarts it and checks `/v1/health/ready`. New installations use the
container image through the suite.

## Development commands

```bash
npm run bootstrap
npm run typecheck
npm run build
npm test
npm run check:openapi
npm run scan:secrets
npm run check:private
```

`npm --prefix ts-core test` runs the core suite alone. `npm run test:dual-stack` and
`npm run test:hermes-dual-stack` run the REST and Hermes plugin compatibility harnesses.

## File map

```text
ts-core/
  src/cli.ts              CLI: start, check, env-schema, migrate, upgrade, rollback, issue-token
  src/server.ts           REST API, health, metrics and dashboard compatibility routes
  src/store.ts            In-memory domain store and access checks
  src/persistence.ts      Qdrant snapshot load/flush adapter and token-hash embedding
  src/semantic-index.ts   Optional semantic shadow index
  src/reasoning.ts        Deterministic local reasoning
  src/auth.ts             HS256 JWT signing and verification
  src/identity.ts         Oathweave token verification (shared hive-common verifier)
  src/upgrade.ts          Migration planning, backup and managed upgrade delegation
  tests/                  node:test suites
Dockerfile                Release container image
docs/                     OpenAPI, console API, Oathweave and decision records
docker/
  docker-compose.yml      Local development Qdrant (its hivemem service is the 1.x example)
  hivemem-ts.service      Native systemd unit
scripts/                  Deploy, backup, prune, registration and contract export helpers
hermes-plugin/            Python Hermes Agent memory provider
sdks/                     Python and TypeScript REST clients
```
