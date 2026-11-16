# AGENTS.md - HiveMem

HiveMem is the long-term memory server of the Hive:Magnus suite: a strict TypeScript REST service
(`ts-core/`) backed by Qdrant, with workspaces, sessions, a knowledge graph, a reasoning queue,
webhooks and per-account permissions, plus Python and TypeScript SDKs and a Hermes Agent plugin.
It runs on its own or inside a Hive suite installation and ships as the container image
`ghcr.io/cheftaco/hivemem`. This public Apache-2.0 product was extracted from Hive: preserve
LICENSE, NOTICE, provenance.json and the immutable database migration history.

## Privacy

Never commit secrets, private infrastructure, databases, runtime state, local notes or real user
data, in code, tests, docs or commit messages. Use `example.com` hosts and placeholder accounts.
Read `AGENTS.local.md` when present; never copy it into tracked content. Install the hooks
(`npm run hooks:install`, which `npm run bootstrap` also does) and never bypass them; they run
`scripts/check-private-data.sh`, `scripts/scan-secrets.sh` and Gitleaks (see CONTRIBUTING.md).

## No UI here

HiveXUI is the suite UI. HiveMem has no dashboard: `GET /dashboard` is a placeholder, and
`POST /dashboard/login` and `/dashboard/api/*` stay only as compatibility routes. Do not add UI
pages. Browser clients use the public contract in `docs/openapi.json`, never backend code.

## Layout

| Path | What it holds |
| --- | --- |
| `ts-core/` | The server (`@hivemagnus/hivemem-server`, CLI `hivemem-server`): `src/` and node:test suites in `tests/`. `src/release/` is generated at build (gitignored). |
| `sdks/typescript/` | `@hivemagnus/hivemem-sdk`, published to npm from `sdk-vX.Y.Z` tags (see its RELEASING.md) |
| `sdks/python/` | Python REST client (`hivemem_sdk`) |
| `hermes-plugin/` | Python Hermes Agent memory provider, its deploy script and pytest suite |
| `tooling/release/` | Vendored managed-upgrade and recovery engine, bundled into `ts-core` at build |
| `scripts/` | OpenAPI and browser-contract exporters, Hermes plugin build, deploy/backup/prune helpers, privacy and secret scans |
| `docker/` | Local development Qdrant compose file and the native systemd unit |
| `docs/` | `openapi.json` (checked by CI), UI workflows (`CONSOLE_API.md`), Oathweave, decisions |

[APP_ARCHITECTURE.md](APP_ARCHITECTURE.md) maps the `ts-core/src` modules;
[HIVEMEM_API.md](HIVEMEM_API.md) is the endpoint reference; [ts-core/README.md](ts-core/README.md)
lists the CLI commands and environment variables (`hivemem-server env-schema` prints them).

## Build and checks

Node.js 24.22.3+ or 26.13.1+. Set up with `npm run bootstrap` (installs `ts-core`,
`sdks/typescript` and `tooling/release`, then the hooks). CI runs, and you should run before a PR:

```bash
npm run typecheck
npm run build
npm test              # ts-core tests, SDK tests, script tests
npm run check:openapi # docs/openapi.json matches the server
npm run scan:secrets
npm run check:private
```

After a route or schema change, run `npm run generate:openapi` and commit the snapshot.
`npm --prefix ts-core test` runs only the server suite. Optional harnesses:
`npm run test:dual-stack`, `npm run test:hermes-dual-stack` (needs a `.venv` with pytest),
`pytest hermes-plugin/tests`, and the Docker-based `npm run test:webhook-worker` (see README).

## Conventions

- Strict TypeScript and runtime validation at API boundaries. Security behaviour needs a
  regression test.
- Unsupported operations return 501 and are listed in `GET /v1/capabilities/operations`; never
  fake success. Keep that matrix, HIVEMEM_API.md and the OpenAPI snapshot in step.
- Keep compatibility paths (the `/dashboard/*` routes, legacy token shapes) unless a change says
  why they go. Storage migrations in `ts-core/src/migrations/` are append-only.
- Conventional Commits. Release the server by pushing a `vX.Y.Z` tag:
  `.github/workflows/release-image.yml` builds the amd64 and arm64 image and records its digest in
  the GitHub release. The server is not published to npm; `@hivemagnus/hivemem-server` on npm is
  the legacy 1.2.2 line.

## Gotchas

- Building `ts-core` needs `tooling/release` installed; run `npm run bootstrap` first.
- The server reads only the environment and `--env-file`; it does not load `./.env` itself.
- Default retrieval is a deterministic token-hash embedding; no model is loaded. Semantic search
  needs the `HIVEMEM_EMBEDDING_*` settings.
- The CLI listens on `127.0.0.1` unless `HIVEMEM_TS_CORE_HOST` is set (the image sets `0.0.0.0`).
