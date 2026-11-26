# HiveMem server (`ts-core`)

HiveMem is a self-hosted shared memory server for AI agents. Agents store and recall episodic,
semantic, and procedural memories over a REST API, with workspace and per-agent isolation, HS256
JWT auth, lexical and optional semantic search, citation-backed chat and context packages, a
reasoning queue and webhooks. HiveXUI is its browser UI. Data lives in
[Qdrant](https://qdrant.tech).

This directory is the server. Clients use the REST API directly or the
[`@hivemagnus/hivemem-sdk`](https://www.npmjs.com/package/@hivemagnus/hivemem-sdk) TypeScript SDK.

> **How it is released.** Since 1.3, HiveMem ships only as the container image
> `ghcr.io/cheftaco/hivemem`, normally installed with the rest of the suite by `hive.sh`, the
> [Hive suite controller](https://github.com/ChefTaco/hive#install-the-suite). It is not
> published on npm: `npm install` and `npx` for `@hivemagnus/hivemem-server`, this package's
> name, resolve to 1.2.2, the legacy line from the Hive repository. The
> [repository README](../README.md#install) has a `docker run` example for running the image
> on its own.

## Requirements

For the container image: Docker, and a Qdrant instance the container can reach.

For a source build:

- Node.js 24 (24.22.3 or later) or Node.js 26 (26.13.1 or later)
- Linux or macOS with the `flock` command (part of util-linux on Linux; on macOS install a `flock`
  package, for example with Homebrew). HiveMem uses it to guarantee a single writer per data
  directory. The image includes it.
- A Qdrant instance, by default at `http://127.0.0.1:6333`

Optional either way: an OpenAI-compatible `/v1/embeddings` endpoint for a semantic search index.
Without one, HiveMem uses deterministic lexical retrieval.

## Quick start from source

Start Qdrant (bound to localhost):

```bash
docker run -d --name hive-qdrant -p 127.0.0.1:6333:6333 \
  -v hive-qdrant:/qdrant/storage qdrant/qdrant:v1.18.1
```

Create an env file with a JWT signing secret and keep it private:

```bash
umask 077
printf 'HIVEMEM_JWT_SECRET=%s\n' "$(openssl rand -hex 32)" > hivemem.env
echo 'HIVE_AUTO_MIGRATE=true' >> hivemem.env
```

Build, check the configuration, then start the server. The build bundles the vendored release
tooling, so install from the repository root first (`npm run bootstrap` installs `ts-core`,
`sdks/typescript` and `tooling/release`):

```bash
(cd .. && npm run bootstrap)
npm run build
node dist/src/cli.js check --env-file hivemem.env
node dist/src/cli.js --env-file hivemem.env
curl http://127.0.0.1:18790/v1/health/ready
```

The commands below are written as `hivemem-server`, the package's command name. From a source
build, run `node dist/src/cli.js`; with the container image, pass the command after the image
name.

Agents authenticate with HS256 JWTs signed by `HIVEMEM_JWT_SECRET`. See the
[API reference](../HIVEMEM_API.md) for
token issuance, registration, and every endpoint.

## Commands

| Command | What it does |
| --- | --- |
| `hivemem-server` or `hivemem-server start` | Start the server |
| `hivemem-server check` | Validate the configuration and check that Qdrant is reachable. Prints a report and exits 0 when the server can start, 1 otherwise. It does not start the server or write data. |
| `hivemem-server env-schema` | Print every supported environment variable as JSON (name, default, whether it is required or secret, and a description). |
| `hivemem-server issue-token --subject <id>` | Sign an access token with `HIVEMEM_JWT_SECRET` and print only the token. See [Issuing tokens](#issuing-tokens). |
| `hivemem-server rename-agent --from <id> --to <id>` | Move everything an agent ID owns to another ID. See [Renaming an agent](#renaming-an-agent). |
| `hivemem-server migrate --plan [--json]` / `migrate --backup-dir <dir>` | Inspect, or back up and apply, pending storage migrations. See [Managed upgrades](#managed-upgrades). |
| `hivemem-server upgrade` / `rollback` | Delegate to the owner-run launcher of a legacy managed install |
| `hivemem-server --help` / `--version` | Show usage or the version |

`--env-file <path>` loads a dotenv file before the configuration is read. It works with `start`,
`check`, `issue-token` and `rename-agent`, can be repeated, and never overrides variables that are already set in
the environment.

### Issuing tokens

`issue-token` mints a token locally from the signing secret, so you can create the first admin
token, or a server-side credential for another service, without calling the API:

```bash
# Admin token for Emberpath's memory proxy (HIVE_ROUTER_MEMORY_PROXY_TOKEN)
hivemem-server issue-token --env-file hivemem.env --subject emberpath --role admin

# Agent token with two scopes, valid for 12 hours
hivemem-server issue-token --env-file hivemem.env --subject agent-1 \
  --scope memories:read --scope memories:write --ttl 12h
```

| Option | Default | Notes |
| --- | --- | --- |
| `--subject <id>` | required | The agent or service identity (`sub`). |
| `--role <role>` | `agent` | `agent` or `admin`. |
| `--scope <scopes>` | by role | Repeatable, or space or comma separated. Admin tokens default to `admin:all`; agent tokens default to the standard agent scopes and cannot carry `admin:*` or `*`. |
| `--ttl <duration>` | `30d` | `3600`, `90m`, `12h` or `30d`; between 60 seconds and 30 days, the same cap as `POST /v1/auth/tokens`. |

The token carries the same claims the server issues (`iss`, `aud`, `token_type`, `jti`, `iat`,
`exp`, `sub`, `role`, `scope`) and is checked with the server's own verifier before it is printed.
Only the token goes to stdout; nothing is written to disk. The secret is validated exactly as the
server validates it. Tokens stay valid until they expire, the secret is rotated, or they are
revoked with `POST /v1/auth/revoke`. Issue a new one before the old one expires. A token for an
agent whose credentials were rotated through the API is rejected; use `POST /v1/auth/tokens` for
those agents.

### Renaming an agent

HiveMem keys ownership on the token subject (`sub`), with no admin bypass for writes, so a
service that changes its subject must take its data with it. `rename-agent` does that, for
example when Emberpath's memory principal changes from its former name `hive-router` to
`emberpath`:

```bash
hivemem-server rename-agent --env-file hivemem.env --from hive-router --to emberpath --dry-run
# stop HiveMem, then
hivemem-server rename-agent --env-file hivemem.env --from hive-router --to emberpath
hivemem-server rename-agent --env-file hivemem.env --from hive-router --to emberpath --verify
```

What moves to `--to`: memories (and private memories into its collections, with their stored
vectors), endorsements, sessions, episodes and messages, conclusions, queue jobs, webhooks and
their deliveries, workspace ownership, membership and per-agent overrides, the agent record with
its credential state (generation, renewal grace, deadline, disabled flag), the operation receipts
that bind replays to an owner, and the owner in semantic shadow collections (`hivemem_shadow_*`).
Audit records keep the ID that acted at the time, and an `agent.rename` audit record is added.
The emptied private collections of `--from` are deleted. `--from` keeps a disabled agent record
(`metadata.renamed_to`), so a token still issued to it is refused instead of starting a new,
empty owner: re-issue such tokens, and update links such as `HIVEMEM_OATHWEAVE_SERVICES_JSON`
`localId`, to the new ID.

| Mode | Behaviour | Exit |
| --- | --- | --- |
| `--dry-run` | Read-only plan with counts. Works while HiveMem runs. | 0, or 3 when the target conflicts |
| `--verify` | Read-only. Done when nothing names `--from` any more (or it never existed). Works while HiveMem runs. | 0 done, 2 pending |
| (none) | Takes the writer lock, so HiveMem must be stopped. Finishes an interrupted write first, saves through the journaled Qdrant save, deletes the emptied collections, then verifies from a fresh read. | 0, 1 on failure, 3 when the target conflicts |

A `--to` that already owns data (or is disabled) is refused without a write; add
`--allow-existing-target` to merge both owners. An agent record alone, which any token for the new
ID creates, is not a conflict. The write is journaled (`pending-write.json` in the storage path),
so an interrupted run completes when `rename-agent` or HiveMem next starts, and running the
command again is safe. `--json` prints the report as JSON. Take a backup first.

## Configuration

All configuration comes from environment variables. Only `HIVEMEM_JWT_SECRET` is required.

| Variable | Default | Notes |
| --- | --- | --- |
| `HIVEMEM_JWT_SECRET` | required | Signing secret for agent and admin tokens, at least 32 bytes. Generate one with `openssl rand -hex 32`. Rotating it invalidates every token. |
| `HIVEMEM_RENEWAL_SECRET` | unset | Separate secret that enables `POST /v1/auth/renew` renewal grants. Must differ from `HIVEMEM_JWT_SECRET`. |
| `HIVEMEM_TS_CORE_HOST` | `127.0.0.1` | Listen address. Use `0.0.0.0` only with TLS or behind a trusted proxy. |
| `HIVEMEM_WEB_PORT` | `18790` | Listen port (`HIVEMEM_TS_CORE_PORT` overrides it). |
| `HIVEMEM_STORAGE_PATH` | `${HIVE_HOME:-~/.hive}/memory` | Local state: writer lock, write-recovery journal (`pending-write.json`, present only while a checkpoint is in flight), and token revocation list. Created with mode `0700`. Memories themselves live in Qdrant. |
| `HIVEMEM_TS_PERSISTENCE` | `qdrant` | `qdrant`, or `memory` for a throwaway server whose data is lost when it stops. |
| `HIVEMEM_QDRANT_URL` | `http://127.0.0.1:6333` | Qdrant REST URL. Keep Qdrant on localhost or a private network. |
| `QDRANT_API_KEY` | unset | Sent to Qdrant when set. |
| `HIVEMEM_TLS_CERT_FILE`, `HIVEMEM_TLS_KEY_FILE` | unset | PEM certificate and key. Set both to serve HTTPS; set neither for plain HTTP. |
| `HIVEMEM_METRICS_TOKEN` | unset | Static bearer token (32+ characters) for `GET /metrics`; admin JWTs always work. |
| `HIVEMEM_EMBEDDING_ENDPOINT` | unset | Optional OpenAI-compatible embeddings URL (HTTPS, or HTTP on loopback). Also set `HIVEMEM_EMBEDDING_MODEL`, `HIVEMEM_EMBEDDING_REVISION`, `HIVEMEM_EMBEDDING_DIMENSIONS`, `HIVEMEM_SEMANTIC_COLLECTION` (must start with `hivemem_shadow_`), and `HIVEMEM_EMBEDDING_API_KEY` if the endpoint needs a key. |

Run `hivemem-server env-schema` for the machine-readable list of the settings above. The server
also reads these:

| Variable | Default | Notes |
| --- | --- | --- |
| `HIVEMEM_TS_TLS_CERT_FILE`, `HIVEMEM_TS_TLS_KEY_FILE` | unset | Take precedence over `HIVEMEM_TLS_CERT_FILE` and `HIVEMEM_TLS_KEY_FILE`. |
| `HIVEMEM_QDRANT_HOST`, `HIVEMEM_QDRANT_PORT` (or `QDRANT_URL`, `QDRANT_HOST`, `QDRANT_PORT`) | `127.0.0.1`, `6333` | Used only when `HIVEMEM_QDRANT_URL` is unset. |
| `HIVEMEM_REVOCATION_FILE` | `<HIVEMEM_STORAGE_PATH>/revoked-tokens.json` | Persistent `jti` revocation list. |
| `HIVEMEM_METRICS_ALLOW_LOOPBACK` | `false` | `true` serves `/metrics` to loopback clients without credentials. |
| `HIVEMEM_MAX_BODY_BYTES` | `1048576` | Request body limit (at least 1024). |
| `HIVEMEM_SEARCH_RATE_LIMIT_PER_MINUTE` | `600` | Search, context, chat and conflict-scan requests each principal may make per minute (a token bucket, so up to that many in a burst). `0` turns the limit off. |
| `HIVEMEM_WORKER_ENABLED` | `true` | `false` stops the background queue worker. `HIVE_REHEARSAL=true` stops it too. |
| `HIVEMEM_CONSOLIDATION_INTERVAL_SECONDS` | `300` | How often the worker schedules consolidation; `0` turns scheduling off. |
| `HIVEMEM_WEBHOOK_ALLOWED_PRIVATE_HOSTS` | empty | Comma-separated host names webhooks may reach on a private network. |
| `HIVEMEM_WEBHOOK_CA_FILE` | system CA store | PEM trust anchor for webhook receivers. |
| `HIVEMEM_INITIAL_ACCOUNT_FILE` | unset | First-start identity file for fresh suite installs (see the [repository README](../README.md#fresh-suite-initialization)). |
| `OATHWEAVE_ISSUER`, `OATHWEAVE_JWKS_URL`, `OATHWEAVE_USERINFO_URL`, `HIVEMEM_OATHWEAVE_IDENTITIES_JSON`, `HIVEMEM_OATHWEAVE_SERVICES_JSON` | unset | Suite sign-in and service tokens. See [docs/OATHWEAVE.md](../docs/OATHWEAVE.md). |
| `HIVEMEM_OATHWEAVE_SESSION_CACHE_MS` | `0` | Opt-in userinfo reuse window for browser sessions, at most `5000`. `0` checks the session on every request. |
| `HIVE_ADMIN_PROVISIONING_SECRET` | unset | Enables the installer-only administrator provisioning endpoint. See [docs/OATHWEAVE.md](../docs/OATHWEAVE.md#guided-installation-owned-administrator-setup). |
| `HIVEMEM_DEBUG` | `false` | `true` prints stack traces for unexpected CLI errors. |

### No silent data loss

HiveMem refuses to start when Qdrant is unreachable instead of quietly falling back to memory.
For tests and demos, opt in to a volatile server explicitly:

```bash
HIVEMEM_TS_PERSISTENCE=memory hivemem-server --env-file hivemem.env
```

### HTTPS

For anything beyond localhost, serve HTTPS with your own certificate, for example for
`memory.example.com`:

```bash
HIVEMEM_TS_CORE_HOST=0.0.0.0
HIVEMEM_WEB_PORT=18443
HIVEMEM_TLS_CERT_FILE=/opt/hivemem/certs/server.crt
HIVEMEM_TLS_KEY_FILE=/opt/hivemem/certs/server.key
```

Clients then use `https://memory.example.com:18443`.

## Health endpoints

`GET /v1/health/ready` returns `200` with `"status": "ok"` when storage and the worker are ready,
and `503` otherwise. `GET /v1/health/live` reports process liveness only. Neither needs auth.

## Library use

The package also exports the server pieces for embedding and tests:

```ts
import { createHiveMemServer, InMemoryHiveMemStore, signToken } from "@hivemagnus/hivemem-server";
```

## Links

- [REST API reference](../HIVEMEM_API.md)
- [Architecture](../APP_ARCHITECTURE.md)
- [Source and issues](https://github.com/ChefTaco/HiveMem)

## Development

From a clone of the repository:

```bash
cd ts-core
npm ci
npm run typecheck
npm test        # builds, then runs the node:test suite
```

`HIVEMEM_DUALSTACK_TOKEN=<jwt> npm run test:dual-stack` runs the black-box REST compatibility
harness against a local server.

## License

Apache-2.0

## Managed upgrades

A Hive suite installation upgrades HiveMem with the suite controller (`./hive.sh upgrade`; see
the [Hive README](https://github.com/ChefTaco/hive#upgrading)). The rest of this section is for
installations enrolled with the retired npm `hive` launcher: use `hive upgrade --dry-run`, then
`hive upgrade` for the enrolled release bundle. This server's
`upgrade` and `rollback` commands delegate to the same owner-run launcher. `migrate --plan --json`
is read-only; migration requires a verified backup. Set `HIVE_AUTO_MIGRATE=true` explicitly for
startup migrations outside a managed install. Slow or one-way automatic migrations are refused.
`check --json` reports configuration without initializing state. No upgrade rotates signing keys
or reseeds existing accounts. See [UPGRADING.md](https://github.com/ChefTaco/hive/blob/v1.2.2/UPGRADING.md)
for adoption, compatibility, recovery, update notices and container controls.
