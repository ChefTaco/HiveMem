# Changelog

All notable changes to `@hivemagnus/hivemem-sdk`.

## [1.2.1] - 2026-11-13

### Fixed

- A 5xx response that is retried has its body cancelled, releasing the connection instead of
  holding it until garbage collection.

## [1.2.0] - 2026-11-12

### Added

- `exportAudit({ after, limit })` reads one page of `GET /v1/audit/export` and returns a
  `HiveAuditPage` of `HiveAuditRecord` v1 records. New `HiveAuditRecord` and `HiveAuditPage`
  types.

## [1.1.1] - 2026-11-12

### Fixed

- An error response whose body is not JSON, such as a proxy's HTML 502, is reported with its
  status and text. The body was read twice, and the second read failed with "Body is unusable".
  An empty error body is reported as "HiveMem answered HTTP <status>".

## [1.1.0] - 2026-11-12

### Added

- `createWorkspace(workspaceId, options)` calls `POST /v1/workspaces` and returns the
  `WorkspaceRecord`. It is idempotent: an existing workspace the caller can read is returned
  unchanged. New `WorkspaceRecord`, `WorkspaceMember`, `WorkspacePolicy` and
  `WorkspaceCreateOptions` types.
- `tokenProvider` option for short-lived credentials such as Oathweave service tokens. It is
  called before each request and, after a 401, called again with `forceRefresh: true` and the
  request retried once. A static `token` keeps working unchanged.
- `headers` option: extra headers on every request, static or from a function called per
  request, for example to propagate `x-request-id` and `traceparent`. They cannot replace
  `Accept`, `Content-Type` or `Authorization`.

### Security

- Every request is sent with `redirect: "error"`, so a redirect can no longer carry the bearer
  token to another origin.

## [1.0.3]

- Earlier releases are described in the HiveMem repository changelog.
